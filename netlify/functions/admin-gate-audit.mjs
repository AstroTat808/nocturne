import { getStore } from '@netlify/blobs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { verifyTicketToken } from './_ticket-token.mjs';
import { gateReadiness } from './_gate-readiness.mjs';

const ORDER_STORE = 'nocturne-ticket-orders';
const REVIEW_STORE = 'nocturne-application-reviews';
const APPLICATION_STORE = 'nocturne-applications';
const SESSION_COOKIE = 'nocturne_admin';

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' } });
}
function secret() { return process.env.NOCTURNE_ADMIN_SESSION_SECRET || process.env.NOCTURNE_ADMIN_KEY || ''; }
function safeEqual(a = '', b = '') { const l = Buffer.from(String(a)); const r = Buffer.from(String(b)); return l.length === r.length && timingSafeEqual(l, r); }
function sign(v) { return createHmac('sha256', secret()).update(v).digest('base64url'); }
function cookies(req) { return Object.fromEntries((req.headers.get('cookie') || '').split(';').map((part) => { const i = part.indexOf('='); if (i < 0) return ['', '']; let v = part.slice(i + 1).trim(); try { v = decodeURIComponent(v); } catch {} return [part.slice(0, i).trim(), v]; }).filter(([k]) => k)); }
function authenticated(req) { if (!secret()) return false; const token = cookies(req)[SESSION_COOKIE]; if (!token?.includes('.')) return false; const [p, sig] = token.split('.', 2); if (!safeEqual(sig, sign(p))) return false; try { const d = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); return d.role === 'admin' && Number(d.exp) > Math.floor(Date.now() / 1000); } catch { return false; } }
function tokenFromUrl(value = '') { try { return new URL(String(value)).searchParams.get('token') || ''; } catch { return ''; } }

export default async (req) => {
  if (req.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
  if (!authenticated(req)) return json({ error: 'Unauthorized.' }, 401);

  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const applicationStore = getStore({ name: APPLICATION_STORE, consistency: 'strong' });
  const { blobs } = await orderStore.list({ prefix: 'submission-' });
  const ticketRows = [];

  for (const { key } of blobs) {
    const submissionId = key.slice('submission-'.length);
    const [summary, review, application] = await Promise.all([
      orderStore.get(key, { type: 'json', consistency: 'strong' }),
      reviewStore.get(submissionId, { type: 'json', consistency: 'strong' }),
      applicationStore.get(submissionId, { type: 'json', consistency: 'strong' })
    ]);
    if (!summary?.ticketId) continue;
    const activeCandidate = summary.status === 'paid' || ['paid', 'checked_in'].includes(String(review?.ticketState || ''));
    if (!activeCandidate) continue;

    const gate = gateReadiness(summary, review);
    const storedToken = tokenFromUrl(summary.digitalTicketUrl || review?.digitalTicketUrl || '');
    if (!storedToken) gate.errors.push('Stored digital ticket URL is missing a signed token.');
    else {
      const parsed = verifyTicketToken(storedToken);
      if (!parsed) gate.errors.push('Stored digital ticket token does not verify with the current signing secret.');
      else if (parsed.ticketId !== summary.ticketId || parsed.submissionId !== submissionId) gate.errors.push('Stored digital ticket token points to the wrong ticket record.');
    }
    gate.ready = gate.errors.length === 0;
    ticketRows.push({
      submissionId,
      ticketId: summary.ticketId,
      guestName: application?.preferredName || application?.fullName || '',
      email: application?.email || '',
      source: gate.source,
      checkedIn: Boolean(summary.checkedInAt),
      ready: gate.ready,
      errors: gate.errors,
      warnings: gate.warnings
    });
  }

  const byTicketId = new Map();
  for (const row of ticketRows) {
    const list = byTicketId.get(row.ticketId) || [];
    list.push(row);
    byTicketId.set(row.ticketId, list);
  }
  for (const [, rows] of byTicketId) {
    if (rows.length < 2) continue;
    for (const row of rows) { row.errors.push('Duplicate active ticket ID found in more than one submission.'); row.ready = false; }
  }

  const paid = ticketRows.filter((r) => r.source === 'paid');
  const comp = ticketRows.filter((r) => r.source === 'comp');
  const notReady = ticketRows.filter((r) => !r.ready);
  const warnings = ticketRows.filter((r) => r.warnings.length);
  return json({
    ok: true,
    generatedAt: new Date().toISOString(),
    summary: {
      activeTickets: ticketRows.length,
      paidTickets: paid.length,
      compTickets: comp.length,
      readyForGate: ticketRows.length - notReady.length,
      blockedOrBroken: notReady.length,
      withWarnings: warnings.length,
      allReady: notReady.length === 0
    },
    issues: notReady,
    warnings
  });
};
