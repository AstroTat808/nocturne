import { getStore } from '@netlify/blobs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { makeTicketToken } from './_ticket-token.mjs';
import { writeAudit } from './_audit.mjs';
import { drinkPackageConfig } from './_drink-package.mjs';

const APPLICATION_STORE = 'nocturne-applications';
const REVIEW_STORE = 'nocturne-application-reviews';
const ORDER_STORE = 'nocturne-ticket-orders';
const SESSION_COOKIE = 'nocturne_admin';

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' } });
}

function safeEqual(a = '', b = '') {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function sessionSecret() {
  return process.env.NOCTURNE_ADMIN_SESSION_SECRET || process.env.NOCTURNE_ADMIN_KEY || '';
}

function parseCookies(req) {
  const header = req.headers.get('cookie') || '';
  return Object.fromEntries(header.split(';').map((part) => {
    const index = part.indexOf('=');
    if (index < 0) return ['', ''];
    let value = part.slice(index + 1).trim();
    try { value = decodeURIComponent(value); } catch {}
    return [part.slice(0, index).trim(), value];
  }).filter(([name]) => name));
}

function authenticated(req) {
  const secret = sessionSecret();
  if (!secret) return false;
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token || !token.includes('.')) return false;
  const [payload, signature] = token.split('.', 2);
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (!safeEqual(signature, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.role === 'admin' && Number(data.exp) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function allowedPostOrigin(req) {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  const allowed = new Set(['https://nocturnefestival.com', 'https://www.nocturnefestival.com']);
  try { allowed.add(new URL(req.url).origin); } catch {}
  for (const value of [process.env.NOCTURNE_SITE_URL, process.env.URL, process.env.DEPLOY_PRIME_URL]) {
    if (!value) continue;
    try { allowed.add(new URL(value).origin); } catch {}
  }
  return allowed.has(origin);
}

function validSubmissionId(value) {
  return /^[A-Za-z0-9_-]{6,128}$/.test(String(value || ''));
}

function escapeHtml(value = '') {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  if (!authenticated(req)) return json({ error: 'Unauthorized.' }, 401);
  if (!allowedPostOrigin(req)) return json({ error: 'Origin not allowed.' }, 403);
  if (!process.env.RESEND_API_KEY || !process.env.NOCTURNE_EMAIL_FROM) return json({ error: 'Transactional email is not configured.' }, 503);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid request.' }, 400); }
  const submissionId = String(body?.submissionId || '').trim();
  if (!validSubmissionId(submissionId)) return json({ error: 'Invalid submission ID.' }, 400);

  const applicationStore = getStore({ name: APPLICATION_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const [application, review, summary] = await Promise.all([
    applicationStore.get(submissionId, { type: 'json', consistency: 'strong' }),
    reviewStore.get(submissionId, { type: 'json', consistency: 'strong' }),
    orderStore.get(`submission-${submissionId}`, { type: 'json', consistency: 'strong' })
  ]);

  if (!application?.email) return json({ error: 'This guest does not have an email address.' }, 409);
  if (!summary || summary.status !== 'paid' || !summary.ticketId || !['paid', 'checked_in'].includes(String(review?.ticketState || ''))) {
    return json({ error: 'Only guests with an active paid or complimentary digital ticket can receive this offer.' }, 409);
  }
  if (summary.drinkPackagePurchased) return json({ error: 'This ticket already has the six-drink package.' }, 409);

  const config = drinkPackageConfig();
  if (!config.enabled || !process.env.STRIPE_SECRET_KEY) return json({ error: 'Drink-package checkout is not currently available.' }, 503);
  const token = makeTicketToken(summary.ticketId, submissionId);
  if (!token) return json({ error: 'Digital ticket signing is not configured.' }, 503);
  const site = (process.env.NOCTURNE_SITE_URL || new URL(req.url).origin).replace(/\/$/, '');
  const ticketUrl = `${site}/ticket?token=${encodeURIComponent(token)}`;
  const displayName = application.preferredName || application.fullName || 'Guest';
  const currency = String(process.env.NOCTURNE_TICKET_CURRENCY || 'usd').toUpperCase();
  const price = `${currency} ${(config.priceCents / 100).toFixed(2)}`;
  const subject = 'Add a Six-Drink Package to Your NOCTURNE Ticket';
  const text = [
    `${displayName},`, '',
    'Your NOCTURNE digital ticket is active. You can add the optional Six-Drink Package to your existing ticket.', '',
    `Package price: ${price}`,
    'Includes: six prepaid credits for beer or well cocktails. Premium cocktails use one credit plus a $5 upgrade at the bar.',
    'Valid 21+ photo ID is required to activate the package wristband.', '',
    'IMPORTANT — FINAL SALE / NON-REFUNDABLE: All drink-package sales are final. The package cannot be refunded, exchanged, prorated, transferred, or converted to cash, including unused credits.', '',
    `Open your digital ticket to review the policy and add the package: ${ticketUrl}`, '',
    'NOCTURNE Festival', 'Presented by Wild Ones · Hawai‘i'
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#030303;color:#f7efe3;font-family:Arial,sans-serif"><div style="max-width:640px;margin:0 auto;padding:44px 24px"><div style="border:1px solid rgba(216,154,43,.35);background:#080604;padding:38px 30px"><div style="color:#d89a2b;font-size:11px;letter-spacing:3px;text-transform:uppercase">NOCTURNE · Optional Bar Add-On</div><h1 style="font-family:Georgia,serif;font-weight:400;font-size:42px;line-height:1.04;color:#fff3df;margin:16px 0 22px">Add six drinks<br>to your ticket.</h1><p style="color:#c8baa4;line-height:1.7">${escapeHtml(displayName)}, your NOCTURNE digital ticket is active. The optional Six-Drink Package can be added to that ticket now.</p><div style="margin:28px 0;padding:18px;border-left:2px solid #d89a2b;background:#020202;color:#d8c7ac;line-height:1.8"><strong>Package:</strong> Six prepaid drink credits<br><strong>Price:</strong> ${escapeHtml(price)}<br><strong>Beer / well:</strong> One credit<br><strong>Premium:</strong> One credit + $5 at the bar<br><strong>Activation:</strong> Valid 21+ photo ID required</div><p style="color:#ffca61;font-size:13px;line-height:1.7;padding:14px;border:1px solid rgba(255,202,97,.4);background:rgba(255,202,97,.07)"><strong>FINAL SALE / NON-REFUNDABLE:</strong> All drink-package sales are final. The package cannot be refunded, exchanged, prorated, transferred, or converted to cash, including unused credits.</p><p style="text-align:center;margin:30px 0"><a href="${escapeHtml(ticketUrl)}" style="display:inline-block;padding:14px 20px;background:#d89a2b;color:#0b0803;text-decoration:none;font-size:12px;letter-spacing:2px;text-transform:uppercase">Review Policy &amp; Add Package</a></p><div style="margin-top:34px;padding-top:20px;border-top:1px solid rgba(216,154,43,.18);color:#74695b;font-size:11px;letter-spacing:1px;text-transform:uppercase">NOCTURNE Festival · Presented by Wild Ones · Hawai‘i</div></div></div></body></html>`;

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `drink-package-offer-${submissionId}-${randomBytes(10).toString('hex')}`.slice(0, 256)
      },
      body: JSON.stringify({ from: process.env.NOCTURNE_EMAIL_FROM, to: [application.email], subject, html, text })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || `Resend returned ${response.status}.`);
    const sentAt = new Date().toISOString();
    await writeAudit('drink_package.offer_email_sent', { submissionId, ticketId: summary.ticketId, recipient: application.email, messageId: data.id || null });
    return json({ ok: true, recipient: application.email, messageId: data.id || null, sentAt });
  } catch (error) {
    await writeAudit('drink_package.offer_email_failed', { submissionId, ticketId: summary.ticketId, recipient: application.email, error: String(error?.message || error) });
    return json({ error: error.message || 'Drink-package offer email could not be sent.' }, 502);
  }
};
