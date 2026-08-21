import { getStore } from '@netlify/blobs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { makeTicketToken } from './_ticket-token.mjs';

const APPLICATION_STORE = 'nocturne-applications';
const REVIEW_STORE = 'nocturne-application-reviews';
const ORDER_STORE = 'nocturne-ticket-orders';
const SESSION_COOKIE = 'nocturne_admin';
const HELP_EMAIL = process.env.NOCTURNE_HELP_EMAIL || 'help@nocturnefestival.com';

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' } });
}

function safeEqual(a = '', b = '') {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function secret() {
  return process.env.NOCTURNE_ADMIN_SESSION_SECRET || process.env.NOCTURNE_ADMIN_KEY || '';
}

function sign(value) {
  return createHmac('sha256', secret()).update(value).digest('base64url');
}

function parseCookies(req) {
  const header = req.headers.get('cookie') || '';
  return Object.fromEntries(header.split(';').map((part) => {
    const i = part.indexOf('=');
    if (i < 0) return ['', ''];
    let value = part.slice(i + 1).trim();
    try { value = decodeURIComponent(value); } catch {}
    return [part.slice(0, i).trim(), value];
  }).filter(([name]) => name));
}

function authenticated(req) {
  if (!secret()) return false;
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token || !token.includes('.')) return false;
  const [payload, signature] = token.split('.', 2);
  if (!safeEqual(signature, sign(payload))) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.role === 'admin' && Number(data.exp) > Math.floor(Date.now() / 1000);
  } catch { return false; }
}

function allowedOrigin(req) {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  const allowed = new Set(['https://nocturnefestival.com', 'https://www.nocturnefestival.com']);
  try { allowed.add(new URL(req.url).origin); } catch {}
  for (const value of [process.env.NOCTURNE_SITE_URL, process.env.URL, process.env.DEPLOY_PRIME_URL]) {
    try { if (value) allowed.add(new URL(value).origin); } catch {}
  }
  return allowed.has(origin);
}

function escapeHtml(value = '') {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function digitalTicketUrl(req, submissionId, ticketId) {
  const token = makeTicketToken(ticketId, submissionId);
  if (!token) return null;
  const site = (process.env.NOCTURNE_SITE_URL || new URL(req.url).origin).replace(/\/$/, '');
  return `${site}/ticket?token=${encodeURIComponent(token)}`;
}

async function sendCompEmail(req, application, ticketId, url) {
  if (!process.env.RESEND_API_KEY || !process.env.NOCTURNE_EMAIL_FROM || !application?.email) {
    return { sent: false, reason: 'Email not configured.' };
  }
  const displayName = application.preferredName || application.fullName || 'Guest';
  const text = [
    `${displayName},`, '', 'A complimentary NOCTURNE ticket has been issued for you.', '',
    `Ticket ID: ${ticketId}`, `Open your digital ticket: ${url}`, '',
    'Keep this ticket private. Present its QR code at event check-in.', '',
    `Need help? ${HELP_EMAIL}`, '', 'NOCTURNE Festival', 'Presented by Wild Ones · Hawai‘i'
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#030303;color:#f7efe3;font-family:Arial,sans-serif"><div style="max-width:640px;margin:0 auto;padding:44px 24px"><div style="border:1px solid rgba(216,154,43,.35);background:#080604;padding:38px 30px"><div style="color:#d89a2b;font-size:11px;letter-spacing:3px;text-transform:uppercase">NOCTURNE · Complimentary Ticket</div><h1 style="font-family:Georgia,serif;font-weight:400;font-size:42px;line-height:1.04;color:#fff3df;margin:16px 0 22px">Your night<br>is on us.</h1><p style="color:#c8baa4;line-height:1.7">${escapeHtml(displayName)}, a complimentary NOCTURNE ticket has been issued for you.</p><div style="margin:28px 0;padding:18px;border-left:2px solid #d89a2b;background:#020202;color:#d8c7ac"><strong>Ticket ID:</strong> ${escapeHtml(ticketId)}<br><strong>Admission:</strong> Complimentary</div><p style="text-align:center;margin:30px 0"><a href="${escapeHtml(url)}" style="display:inline-block;padding:14px 20px;background:#d89a2b;color:#0b0803;text-decoration:none;font-size:12px;letter-spacing:2px;text-transform:uppercase">Open Digital Ticket</a></p><p style="color:#9d907f;line-height:1.7">Keep your digital ticket private. Present its QR code at event check-in.</p><p style="color:#807564;font-size:12px">Need help? <a href="mailto:${escapeHtml(HELP_EMAIL)}" style="color:#ffca61">${escapeHtml(HELP_EMAIL)}</a></p><div style="margin-top:34px;padding-top:20px;border-top:1px solid rgba(216,154,43,.18);color:#74695b;font-size:11px;letter-spacing:1px;text-transform:uppercase">NOCTURNE Festival · Presented by Wild Ones · Hawai‘i</div></div></div></body></html>`;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.NOCTURNE_EMAIL_FROM, to: [application.email], subject: 'Your Complimentary NOCTURNE Ticket', html, text })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `Resend returned ${response.status}.`);
  return { sent: true, messageId: data.id || null };
}

async function issue(req, submissionId) {
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(submissionId)) return json({ error: 'Invalid submission ID.' }, 400);
  const applicationStore = getStore({ name: APPLICATION_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const [application, review, existing] = await Promise.all([
    applicationStore.get(submissionId, { type: 'json', consistency: 'strong' }),
    reviewStore.get(submissionId, { type: 'json', consistency: 'strong' }),
    orderStore.get(`submission-${submissionId}`, { type: 'json', consistency: 'strong' })
  ]);
  if (!application) return json({ error: 'Application not found.' }, 404);
  if (!review || review.status !== 'approved') return json({ error: 'Approve the application before issuing a complimentary ticket.' }, 409);
  if (existing?.status === 'paid' || ['paid', 'checked_in'].includes(review.ticketState)) return json({ error: 'This applicant already has an active ticket.' }, 409);
  if (existing?.status === 'refunded' || review.ticketState === 'refunded') return json({ error: 'This applicant has a refunded ticket record. Review it before issuing a new ticket.' }, 409);

  const issuedAt = new Date().toISOString();
  const ticketId = `NOC-TKT-COMP-${randomBytes(6).toString('hex').toUpperCase()}`;
  const url = digitalTicketUrl(req, submissionId, ticketId);
  if (!url) return json({ error: 'Digital ticket signing is not configured.' }, 503);

  let emailStatus = 'not_sent';
  let emailMessageId = null;
  let emailError = null;
  try {
    const sent = await sendCompEmail(req, application, ticketId, url);
    emailStatus = sent.sent ? 'sent' : 'not_configured';
    emailMessageId = sent.messageId || null;
    emailError = sent.reason || null;
  } catch (error) {
    console.error('NOCTURNE comp ticket email failed:', error);
    emailStatus = 'failed';
    emailError = String(error?.message || error).slice(0, 500);
  }

  const summary = {
    submissionId,
    ticketId,
    ticketSource: 'comp',
    status: 'paid',
    paymentStatus: 'comp',
    amountTotal: 0,
    currency: String(process.env.NOCTURNE_TICKET_CURRENCY || 'usd').toLowerCase(),
    customerEmail: application.email || null,
    customerName: application.fullName || null,
    paidAt: issuedAt,
    compIssuedAt: issuedAt,
    digitalTicketUrl: url,
    checkedInAt: null,
    ticketEmailStatus: emailStatus,
    ticketEmailMessageId: emailMessageId,
    ticketEmailError: emailError,
    updatedAt: issuedAt
  };
  await orderStore.setJSON(`submission-${submissionId}`, summary);
  const updatedReview = {
    ...review,
    ticketState: 'paid',
    ticketSource: 'comp',
    ticketPurchasedAt: issuedAt,
    compIssuedAt: issuedAt,
    ticketId,
    digitalTicketUrl: url,
    stripeCheckoutSessionId: null,
    stripePaymentIntentId: null,
    checkedInAt: null,
    ticketEmailStatus: emailStatus,
    ticketEmailSentAt: emailStatus === 'sent' ? issuedAt : null,
    ticketEmailMessageId: emailMessageId,
    ticketEmailError: emailError,
    updatedAt: issuedAt
  };
  await reviewStore.setJSON(submissionId, updatedReview);
  return json({ ok: true, ticket: summary, review: updatedReview, recipient: application.email || null });
}

async function resend(req, submissionId) {
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(submissionId)) return json({ error: 'Invalid submission ID.' }, 400);
  const applicationStore = getStore({ name: APPLICATION_STORE, consistency: 'strong' });
  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const [application, summary, review] = await Promise.all([
    applicationStore.get(submissionId, { type: 'json', consistency: 'strong' }),
    orderStore.get(`submission-${submissionId}`, { type: 'json', consistency: 'strong' }),
    reviewStore.get(submissionId, { type: 'json', consistency: 'strong' })
  ]);
  if (!application || summary?.ticketSource !== 'comp' || summary.status !== 'paid' || !summary.ticketId) return json({ error: 'No active complimentary ticket was found.' }, 409);
  const url = digitalTicketUrl(req, submissionId, summary.ticketId);
  try {
    const sent = await sendCompEmail(req, application, summary.ticketId, url);
    const now = new Date().toISOString();
    const nextSummary = { ...summary, digitalTicketUrl: url, ticketEmailStatus: sent.sent ? 'sent' : 'not_configured', ticketEmailMessageId: sent.messageId || null, ticketEmailError: sent.reason || null, ticketEmailResentAt: now, updatedAt: now };
    await orderStore.setJSON(`submission-${submissionId}`, nextSummary);
    if (review) await reviewStore.setJSON(submissionId, { ...review, digitalTicketUrl: url, ticketEmailStatus: nextSummary.ticketEmailStatus, ticketEmailSentAt: sent.sent ? now : review.ticketEmailSentAt || null, ticketEmailMessageId: sent.messageId || null, ticketEmailError: sent.reason || null, ticketEmailResentAt: now, updatedAt: now });
    return json({ ok: true, recipient: application.email, ticket: nextSummary });
  } catch (error) {
    console.error('NOCTURNE comp ticket resend failed:', error);
    return json({ error: error.message || 'Complimentary ticket email could not be sent.' }, 502);
  }
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  if (!allowedOrigin(req)) return json({ error: 'Origin not allowed.' }, 403);
  if (!authenticated(req)) return json({ error: 'Unauthorized.' }, 401);
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid request.' }, 400); }
  const submissionId = String(body.submissionId || '').trim();
  const action = String(body.action || 'issue');
  if (action === 'issue') return issue(req, submissionId);
  if (action === 'resend') return resend(req, submissionId);
  return json({ error: 'Unknown action.' }, 400);
};
