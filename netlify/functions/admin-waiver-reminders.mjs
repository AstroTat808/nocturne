import { getStore } from '@netlify/blobs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { waiverSigned, WAIVER_VERSION } from './_waiver.mjs';
import { sendWaiverReminder } from './_waiver-reminder-email.mjs';
import { writeAudit } from './_audit.mjs';

const ORDER_STORE = 'nocturne-ticket-orders';
const REVIEW_STORE = 'nocturne-application-reviews';
const APPLICATION_STORE = 'nocturne-applications';
const REMINDER_STORE = 'nocturne-waiver-reminders';
const SESSION_COOKIE = 'nocturne_admin';
const COOLDOWN_MS = 2 * 60 * 60 * 1000;

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' } });
}
function secret() { return process.env.NOCTURNE_ADMIN_SESSION_SECRET || process.env.NOCTURNE_ADMIN_KEY || ''; }
function safeEqual(a = '', b = '') { const l = Buffer.from(String(a)); const r = Buffer.from(String(b)); return l.length === r.length && timingSafeEqual(l, r); }
function sign(value) { return createHmac('sha256', secret()).update(value).digest('base64url'); }
function cookies(req) { return Object.fromEntries((req.headers.get('cookie') || '').split(';').map((part) => { const i = part.indexOf('='); if (i < 0) return ['', '']; let v = part.slice(i + 1).trim(); try { v = decodeURIComponent(v); } catch {} return [part.slice(0, i).trim(), v]; }).filter(([k]) => k)); }
function authenticated(req) { if (!secret()) return false; const token = cookies(req)[SESSION_COOKIE]; if (!token?.includes('.')) return false; const [p, sig] = token.split('.', 2); if (!safeEqual(sig, sign(p))) return false; try { const d = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); return d.role === 'admin' && Number(d.exp) > Math.floor(Date.now() / 1000); } catch { return false; } }
function allowedOrigin(req) { const origin = req.headers.get('origin'); if (!origin) return true; const allowed = new Set(['https://nocturnefestival.com', 'https://www.nocturnefestival.com']); try { allowed.add(new URL(req.url).origin); } catch {} for (const value of [process.env.NOCTURNE_SITE_URL, process.env.URL, process.env.DEPLOY_PRIME_URL]) { try { if (value) allowed.add(new URL(value).origin); } catch {} } return allowed.has(origin); }
function activeTicket(summary = {}, review = {}) { return Boolean(summary.ticketId) && (summary.status === 'paid' || ['paid', 'checked_in'].includes(String(review.ticketState || ''))); }
function validEmail(value = '') { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim()); }

async function candidates() {
  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const applicationStore = getStore({ name: APPLICATION_STORE, consistency: 'strong' });
  const reminderStore = getStore({ name: REMINDER_STORE, consistency: 'strong' });
  const { blobs } = await orderStore.list({ prefix: 'submission-' });
  const rows = [];

  for (const { key } of blobs) {
    const submissionId = key.slice('submission-'.length);
    const [summary, review, application, reminder] = await Promise.all([
      orderStore.get(key, { type: 'json', consistency: 'strong' }),
      reviewStore.get(submissionId, { type: 'json', consistency: 'strong' }),
      applicationStore.get(submissionId, { type: 'json', consistency: 'strong' }),
      reminderStore.get(submissionId, { type: 'json', consistency: 'strong' })
    ]);
    if (!activeTicket(summary, review || {})) continue;
    if (waiverSigned(summary, review || {})) continue;
    rows.push({ submissionId, summary, review: review || {}, application: application || {}, reminder: reminder || null });
  }
  return rows;
}

export default async (req) => {
  if (!authenticated(req)) return json({ error: 'Unauthorized.' }, 401);
  if (req.method === 'GET') {
    const rows = await candidates();
    const now = Date.now();
    const recentlySent = rows.filter(({ reminder }) => reminder?.waiverVersion === WAIVER_VERSION && reminder.lastSentAt && now - new Date(reminder.lastSentAt).getTime() < COOLDOWN_MS).length;
    return json({ ok: true, unsigned: rows.length, eligibleNow: rows.length - recentlySent, recentlySent, cooldownHours: COOLDOWN_MS / 3600000 });
  }
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  if (!allowedOrigin(req)) return json({ error: 'Request origin was not allowed.' }, 403);
  if (!process.env.RESEND_API_KEY || !process.env.NOCTURNE_EMAIL_FROM) return json({ error: 'Email sending is not configured.' }, 503);

  let body = {};
  try { body = await req.json(); } catch {}
  if (String(body.confirm || '') !== 'SEND WAIVER REMINDERS') return json({ error: 'Confirmation phrase did not match.' }, 400);

  const rows = await candidates();
  const reminderStore = getStore({ name: REMINDER_STORE, consistency: 'strong' });
  const now = Date.now();
  const results = { sent: 0, skippedRecent: 0, skippedNoEmail: 0, failed: 0, failures: [] };

  for (const row of rows) {
    const previous = row.reminder;
    if (previous?.waiverVersion === WAIVER_VERSION && previous.lastSentAt && now - new Date(previous.lastSentAt).getTime() < COOLDOWN_MS) {
      results.skippedRecent += 1;
      continue;
    }
    if (!validEmail(row.application.email)) {
      results.skippedNoEmail += 1;
      results.failures.push({ ticketId: row.summary.ticketId, guestName: row.application.preferredName || row.application.fullName || '', reason: 'Missing or invalid email.' });
      continue;
    }
    try {
      const bucket = Math.floor(now / COOLDOWN_MS);
      const sent = await sendWaiverReminder({
        application: row.application,
        submissionId: row.submissionId,
        ticketId: row.summary.ticketId,
        idempotencyKey: `waiver-${WAIVER_VERSION}-${row.submissionId}-${bucket}`
      });
      const sentAt = new Date().toISOString();
      await reminderStore.setJSON(row.submissionId, {
        submissionId: row.submissionId,
        ticketId: row.summary.ticketId,
        waiverVersion: WAIVER_VERSION,
        lastSentAt: sentAt,
        messageId: sent.messageId || null,
        recipient: sent.recipient
      });
      results.sent += 1;
    } catch (error) {
      results.failed += 1;
      results.failures.push({ ticketId: row.summary.ticketId, guestName: row.application.preferredName || row.application.fullName || '', reason: String(error?.message || 'Send failed.').slice(0, 300) });
    }
  }

  await writeAudit('waiver.bulk_reminders_sent', { ...results, failures: results.failures.slice(0, 25), waiverVersion: WAIVER_VERSION });
  return json({ ok: results.failed === 0, waiverVersion: WAIVER_VERSION, unsigned: rows.length, ...results }, results.failed ? 207 : 200);
};

export const config = { path: '/api/admin/waiver-reminders' };
