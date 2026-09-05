import { getStore } from '@netlify/blobs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { verifyTicketToken } from './_ticket-token.mjs';
import { writeAudit } from './_audit.mjs';

const ORDER_STORE = 'nocturne-ticket-orders';
const REVIEW_STORE = 'nocturne-application-reviews';
const APPLICATION_STORE = 'nocturne-applications';
const COOKIE = 'nocturne_checkin';
const TTL_SECONDS = 12 * 60 * 60;

function json(data, status = 200, extraHeaders = {}) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders } });
}
function key() { return process.env.NOCTURNE_CHECKIN_KEY || process.env.NOCTURNE_ADMIN_KEY || ''; }
function secret() { return process.env.NOCTURNE_CHECKIN_SESSION_SECRET || process.env.NOCTURNE_ADMIN_SESSION_SECRET || process.env.NOCTURNE_ADMIN_KEY || ''; }
function safeEqual(a = '', b = '') { const left = Buffer.from(String(a)); const right = Buffer.from(String(b)); if (left.length !== right.length) return false; return timingSafeEqual(left, right); }
function sign(payload) { return createHmac('sha256', secret()).update(payload).digest('base64url'); }
function makeSession() { const now = Math.floor(Date.now() / 1000); const payload = Buffer.from(JSON.stringify({ role: 'checkin', iat: now, exp: now + TTL_SECONDS, nonce: randomBytes(10).toString('base64url') })).toString('base64url'); return `${payload}.${sign(payload)}`; }
function parseCookies(req) { const header = req.headers.get('cookie') || ''; return Object.fromEntries(header.split(';').map((part) => { const i = part.indexOf('='); if (i < 0) return ['', '']; let value = part.slice(i + 1).trim(); try { value = decodeURIComponent(value); } catch {} return [part.slice(0, i).trim(), value]; }).filter(([name]) => name)); }
function authenticated(req) { if (!secret()) return false; const token = parseCookies(req)[COOKIE]; if (!token || !token.includes('.')) return false; const [payload, signature] = token.split('.', 2); if (!safeEqual(signature, sign(payload))) return false; try { const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); return data.role === 'checkin' && Number(data.exp) > Math.floor(Date.now() / 1000); } catch { return false; } }
function setCookie(token) { return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${TTL_SECONDS}`; }
function clearCookie() { return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`; }
async function body(req) { try { return await req.json(); } catch { return null; } }
function tokenFromInput(value = '') { const raw = String(value).trim(); if (!raw) return ''; try { const url = new URL(raw); return url.searchParams.get('token') || ''; } catch { return raw; } }
function entitlements(summary = {}) { return { drinkPackage: { purchased: Boolean(summary.drinkPackagePurchased), status: summary.drinkPackageStatus || null, creditsPurchased: Number(summary.drinkCreditsPurchased || 0), creditsRemaining: Number(summary.drinkCreditsRemaining || 0) }, waterPackage: { purchased: Boolean(summary.waterPackagePurchased), status: summary.waterPackageStatus || null }, lateStay: { purchased: Boolean(summary.lateStayPurchased), status: summary.lateStayStatus || null, departureTime: summary.lateStayDepartureTime || null } }; }

async function checkIn(req, input) {
  const token = tokenFromInput(input.token || input.value || '');
  const parsed = verifyTicketToken(token);
  if (!parsed) return json({ ok: false, result: 'invalid', message: 'INVALID TICKET' }, 400);

  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const applicationStore = getStore({ name: APPLICATION_STORE, consistency: 'strong' });
  const summaryKey = `submission-${parsed.submissionId}`;
  const [summaryEntry, review, application] = await Promise.all([
    orderStore.getWithMetadata(summaryKey, { type: 'json', consistency: 'strong' }),
    reviewStore.get(parsed.submissionId, { type: 'json', consistency: 'strong' }),
    applicationStore.get(parsed.submissionId, { type: 'json', consistency: 'strong' })
  ]);
  const summary = summaryEntry?.data;

  if (!summary || summary.status !== 'paid' || summary.ticketId !== parsed.ticketId || !['paid', 'checked_in'].includes(String(review?.ticketState || ''))) {
    return json({ ok: false, result: 'invalid', message: 'INVALID OR INACTIVE TICKET' }, 403);
  }
  const source = summary.ticketSource === 'comp' ? 'comp' : 'paid';
  if (source === 'comp' && Number(summary.amountTotal || 0) !== 0) return json({ ok: false, result: 'invalid', message: 'COMPLIMENTARY TICKET RECORD NEEDS REVIEW' }, 409);
  if (source === 'paid' && summary.paymentStatus && summary.paymentStatus !== 'paid') return json({ ok: false, result: 'invalid', message: 'PAID TICKET RECORD NEEDS REVIEW' }, 409);

  const guestName = application?.preferredName || application?.fullName || 'NOCTURNE Guest';
  if (summary.checkedInAt) {
    return json({ ok: true, result: 'already_used', message: 'ALREADY CHECKED IN', ticketId: parsed.ticketId, guestName, checkedInAt: summary.checkedInAt, ticketSource: source, entitlements: entitlements(summary) });
  }

  const checkedInAt = new Date().toISOString();
  const write = await orderStore.setJSON(summaryKey, { ...summary, status: 'paid', checkedInAt, updatedAt: checkedInAt }, { onlyIfMatch: summaryEntry.etag });
  if (!write.modified) {
    const latest = await orderStore.get(summaryKey, { type: 'json', consistency: 'strong' });
    return json({ ok: true, result: latest?.checkedInAt ? 'already_used' : 'conflict', message: latest?.checkedInAt ? 'ALREADY CHECKED IN' : 'SCAN AGAIN', ticketId: parsed.ticketId, guestName, checkedInAt: latest?.checkedInAt || null, ticketSource: source, entitlements: entitlements(latest || summary) }, latest?.checkedInAt ? 200 : 409);
  }

  try {
    if (summary.stripeCheckoutSessionId) {
      const order = await orderStore.get(summary.stripeCheckoutSessionId, { type: 'json', consistency: 'strong' });
      if (order) await orderStore.setJSON(summary.stripeCheckoutSessionId, { ...order, checkedInAt, updatedAt: checkedInAt });
    }
    if (review) await reviewStore.setJSON(parsed.submissionId, { ...review, ticketState: 'checked_in', checkedInAt, updatedAt: checkedInAt });
  } catch (error) { console.error('NOCTURNE secondary check-in sync failed:', error); }

  await writeAudit('ticket.checked_in', { submissionId: parsed.submissionId, ticketId: parsed.ticketId, guestName, ticketSource: source });
  return json({ ok: true, result: 'valid', message: 'VALID — CHECKED IN', ticketId: parsed.ticketId, guestName, checkedInAt, ticketSource: source, entitlements: entitlements(summary) });
}

export default async (req) => {
  if (req.method !== 'POST' && req.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
  if (req.method === 'GET') return authenticated(req) ? json({ authenticated: true }) : json({ authenticated: false }, 401);
  const input = await body(req); if (!input) return json({ error: 'Invalid request.' }, 400);
  const action = String(input.action || 'check-in');
  if (action === 'login') { if (!key() || !secret()) return json({ error: 'Check-in authentication is not configured.' }, 500); if (!safeEqual(input.password || '', key())) return json({ error: 'Invalid check-in password.' }, 401); return json({ ok: true }, 200, { 'Set-Cookie': setCookie(makeSession()) }); }
  if (action === 'logout') return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
  if (!authenticated(req)) return json({ error: 'Unauthorized.' }, 401);
  return checkIn(req, input);
};
