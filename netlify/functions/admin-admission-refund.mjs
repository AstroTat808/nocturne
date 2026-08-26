import { getStore } from '@netlify/blobs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { writeAudit } from './_audit.mjs';
import adminRefundsCore from './admin-refunds-core.mjs';

const APPLICATION_STORE = 'nocturne-applications';
const REVIEW_STORE = 'nocturne-application-reviews';
const ORDER_STORE = 'nocturne-ticket-orders';
const SESSION_COOKIE = 'nocturne_admin';
const REFUND_REASONS = new Map([
  ['guest_request', 'Guest request'],
  ['duplicate_purchase', 'Duplicate purchase'],
  ['event_cancellation', 'Event cancellation'],
  ['event_change', 'Material event change'],
  ['payment_error', 'Payment / checkout error'],
  ['goodwill', 'Administrative goodwill'],
  ['other', 'Other']
]);

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' } });
}

function sessionSecret() {
  return process.env.NOCTURNE_ADMIN_SESSION_SECRET || process.env.NOCTURNE_ADMIN_KEY || '';
}

function safeEqual(a = '', b = '') {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function authenticated(req) {
  const secret = sessionSecret();
  if (!secret) return false;
  const cookies = Object.fromEntries((req.headers.get('cookie') || '').split(';').map((part) => {
    const i = part.indexOf('=');
    if (i < 0) return ['', ''];
    let value = part.slice(i + 1).trim();
    try { value = decodeURIComponent(value); } catch {}
    return [part.slice(0, i).trim(), value];
  }).filter(([key]) => key));
  const token = cookies[SESSION_COOKIE];
  if (!token?.includes('.')) return false;
  const [payload, signature] = token.split('.', 2);
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (!safeEqual(signature, expected)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return parsed.role === 'admin' && Number(parsed.exp) > Math.floor(Date.now() / 1000);
  } catch { return false; }
}

function allowedOrigin(req) {
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

function cleanOperator(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

function validSubmissionId(value) {
  return /^[A-Za-z0-9_-]{6,128}$/.test(String(value || ''));
}

function cleanNotes(value) {
  return String(value || '').trim().replace(/\r\n/g, '\n').slice(0, 1000);
}

function escapeHtml(value = '') {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function refundableAdmissionCents(summary) {
  const ticketAmount = Number(summary?.ticketAmount || 0);
  if (Number.isInteger(ticketAmount) && ticketAmount > 0) return ticketAmount;
  const total = Number(summary?.amountTotal ?? summary?.expectedAmountTotal ?? 0);
  const bundledPackage = summary?.drinkPackagePurchased && summary?.drinkPackagePurchaseType !== 'addon'
    ? Number(summary?.drinkPackagePriceCents || 0)
    : 0;
  const amount = total - bundledPackage;
  return Number.isInteger(amount) && amount > 0 ? amount : 0;
}

async function stripeRefund(paymentIntentId, amount, submissionId, refundReason, refundNotes) {
  const stripeReason = refundReason === 'duplicate_purchase' ? 'duplicate' : 'requested_by_customer';
  const response = await fetch('https://api.stripe.com/v1/refunds', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': `nocturne-admin-admission-refund-${submissionId}`.slice(0, 250)
    },
    body: new URLSearchParams({
      payment_intent: paymentIntentId,
      amount: String(amount),
      reason: stripeReason,
      'metadata[submissionId]': submissionId,
      'metadata[event]': 'NOCTURNE',
      'metadata[refundRole]': 'admission-only',
      'metadata[refundReason]': refundReason,
      'metadata[refundReasonLabel]': REFUND_REASONS.get(refundReason) || refundReason,
      'metadata[refundNotes]': refundNotes.slice(0, 450),
      'metadata[drinkPackageRefunded]': 'false',
      'metadata[source]': 'admin_dashboard'
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `Stripe returned ${response.status}.`);
  if (['failed', 'canceled'].includes(data.status)) throw new Error(`Stripe refund ${data.status}.`);
  return data;
}

async function sendEmail(application, summary, refund, amount, packageForfeited) {
  if (!process.env.RESEND_API_KEY || !process.env.NOCTURNE_EMAIL_FROM || !application?.email) return { status: 'not_configured' };
  const name = application.preferredName || application.fullName || 'Guest';
  const currency = String(refund.currency || summary.currency || 'usd').toUpperCase();
  const formatted = `${currency} ${(amount / 100).toFixed(2)}`;
  const packageCopy = packageForfeited
    ? 'Your drink package was not refunded. All NOCTURNE drink packages, including the Six-Drink Package and Unlimited Drinking Water Package, are FINAL SALE / NON-REFUNDABLE. Because the admission ticket is canceled, any attached package is forfeited and can no longer be redeemed.'
    : 'No drink-package charge was included in this refund.';
  const text = [`${name},`, '', 'Your NOCTURNE admission has been canceled and the refundable admission portion has been submitted to Stripe.', '', `Ticket ID: ${summary.ticketId}`, `Admission refund: ${formatted}`, packageCopy, '', 'Bank posting times vary by payment method.', '', 'NOCTURNE Festival', 'Presented by Wild Ones · Hawai‘i'].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#030303;color:#f7efe3;font-family:Arial,sans-serif"><div style="max-width:640px;margin:0 auto;padding:44px 24px"><div style="border:1px solid rgba(216,154,43,.35);background:#080604;padding:38px 30px"><div style="color:#d89a2b;font-size:11px;letter-spacing:3px;text-transform:uppercase">NOCTURNE · Admission Refund</div><h1 style="font-family:Georgia,serif;font-weight:400;font-size:42px;line-height:1.04;color:#fff3df">Admission refunded.</h1><p style="color:#c8baa4;line-height:1.7">${escapeHtml(name)}, the refundable admission portion of your purchase has been submitted to Stripe.</p><div style="padding:18px;border-left:2px solid #d89a2b;background:#020202;color:#d8c7ac;line-height:1.8"><strong>Ticket ID:</strong> ${escapeHtml(summary.ticketId)}<br><strong>Admission refund:</strong> ${escapeHtml(formatted)}</div><p style="color:#ffca61;line-height:1.7"><strong>Drink-package policy:</strong> ${escapeHtml(packageCopy)}</p><p style="color:#9d907f;line-height:1.7">Bank posting times vary by payment method.</p></div></div></body></html>`;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `admission-refund-${refund.id}`.slice(0, 250) },
    body: JSON.stringify({ from: process.env.NOCTURNE_EMAIL_FROM, to: [application.email], subject: 'Your NOCTURNE Admission Refund', html, text })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return { status: 'failed', error: data.message || `Resend returned ${response.status}.` };
  return { status: 'sent', messageId: data.id || null };
}

export default async (req) => {
  if (req.method === 'GET') return adminRefundsCore(req);
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  if (!authenticated(req)) return json({ error: 'Admin session expired. Sign in again.' }, 401);
  if (!allowedOrigin(req)) return json({ error: 'Request origin was not allowed.' }, 403);
  if (!process.env.STRIPE_SECRET_KEY) return json({ error: 'Stripe refunds are not configured.' }, 503);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid request body.' }, 400); }
  if (String(body?.action || 'admission-only') !== 'admission-only') return json({ error: 'Drink packages are non-refundable. Only admission-only refunds are allowed here.' }, 409);
  const submissionId = String(body?.submissionId || '').trim();
  const confirmTicketId = String(body?.confirmTicketId || '').trim();
  const initiatedBy = cleanOperator(body?.initiatedBy);
  const refundReason = String(body?.refundReason || '').trim();
  const refundNotes = cleanNotes(body?.refundNotes);
  if (!validSubmissionId(submissionId)) return json({ error: 'Invalid submission ID.' }, 400);
  if (!/^[A-Za-z0-9 .,'’_-]{2,80}$/.test(initiatedBy)) return json({ error: 'Enter a valid admin name or initials.' }, 400);
  if (!REFUND_REASONS.has(refundReason)) return json({ error: 'Choose a refund reason.' }, 400);
  if (refundReason === 'other' && refundNotes.length < 3) return json({ error: 'Enter refund notes when the reason is Other.' }, 400);

  const applicationStore = getStore({ name: APPLICATION_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const summaryKey = `submission-${submissionId}`;
  const [application, review, summaryEntry] = await Promise.all([
    applicationStore.get(submissionId, { type: 'json', consistency: 'strong' }),
    reviewStore.get(submissionId, { type: 'json', consistency: 'strong' }),
    orderStore.getWithMetadata(summaryKey, { type: 'json', consistency: 'strong' })
  ]);
  const summary = summaryEntry?.data;
  if (!application || !summary) return json({ error: 'Ticket record not found.' }, 404);
  if (!summary.ticketId || summary.ticketId !== confirmTicketId) return json({ error: 'Ticket confirmation did not match.' }, 400);
  if (summary.status === 'refunded' || summary.stripeRefundId) return json({ ok: true, alreadyRefunded: true, ticketId: summary.ticketId, admissionRefund: { id: summary.stripeRefundId, amount: summary.refundedAmount } });
  if (summary.status !== 'paid') return json({ error: `Admission is ${summary.status || 'not paid'} and cannot be refunded.` }, 409);
  if (!summary.stripePaymentIntentId) return json({ error: 'The admission Stripe payment intent is missing.' }, 409);
  if (summary.ticketSource === 'comp' || /^NOC-TKT-COMP-/.test(summary.ticketId || '')) return json({ error: 'Complimentary admission has no Stripe payment to refund.' }, 409);
  if (summary.checkedInAt || review?.checkedInAt || review?.ticketState === 'checked_in') return json({ error: 'Checked-in admission cannot use the automatic refund action.' }, 409);

  const amount = refundableAdmissionCents(summary);
  if (amount < 50) return json({ error: 'The refundable admission amount could not be calculated safely.' }, 409);
  const packageBundled = Boolean(summary.drinkPackagePurchased && summary.drinkPackagePurchaseType !== 'addon');
  const packageAttached = Boolean(summary.drinkPackagePurchased || summary.waterPackagePurchased);

  let refund;
  try {
    refund = await stripeRefund(summary.stripePaymentIntentId, amount, submissionId, refundReason, refundNotes);
  } catch (error) {
    await writeAudit('refund.admission_failed', { submissionId, ticketId: summary.ticketId, initiatedBy, amount, refundReason, refundNotes, error: String(error?.message || error) }).catch(() => {});
    return json({ error: error.message || 'Admission refund failed.' }, 502);
  }

  const now = new Date().toISOString();
  const history = Array.isArray(summary.refundHistory) ? summary.refundHistory.filter(Boolean) : [];
  history.push({
    id: `refund-${refund.id}`,
    type: 'admission',
    label: 'Admission refund',
    amountCents: amount,
    currency: refund.currency || summary.currency || 'usd',
    stripeRefundId: refund.id,
    paymentIntentId: summary.stripePaymentIntentId,
    date: now,
    status: refund.status || 'submitted',
    initiatedBy,
    source: 'admin_dashboard',
    action: 'admission-only',
    reason: refundReason,
    reasonLabel: REFUND_REASONS.get(refundReason),
    notes: refundNotes
  });
  const packagePatch = packageAttached ? {
    ...(summary.drinkPackagePurchased ? {
      drinkPackageStatus: 'forfeited',
      drinkPackageInvalidatedAt: now,
      drinkPackageInvalidationReason: 'admission_refunded_nonrefundable',
      drinkCreditsRemainingBeforeInvalidation: Number(summary.drinkCreditsRemaining || 0),
      drinkCreditsRemaining: 0
    } : {}),
    ...(summary.waterPackagePurchased ? {
      waterPackageStatus: 'forfeited',
      waterPackageInvalidatedAt: now,
      waterPackageInvalidationReason: 'admission_refunded_nonrefundable'
    } : {})
  } : {};
  const next = { ...summary, ...packagePatch, status: 'refunded', stripeRefundId: refund.id, refundStatus: refund.status || 'submitted', refundedAt: now, refundedAmount: amount, refundInitiatedBy: initiatedBy, refundReason, refundReasonLabel: REFUND_REASONS.get(refundReason), refundNotes, refundHistory: history, updatedAt: now };

  const write = await orderStore.setJSON(summaryKey, next, { onlyIfMatch: summaryEntry.etag });
  if (!write.modified) return json({ error: 'Ticket status changed while the refund was being recorded. Verify Stripe before retrying.' }, 409);
  if (summary.stripeCheckoutSessionId) {
    const order = await orderStore.get(summary.stripeCheckoutSessionId, { type: 'json', consistency: 'strong' });
    if (order) await orderStore.setJSON(summary.stripeCheckoutSessionId, { ...order, ...packagePatch, status: 'refunded', stripeRefundId: refund.id, refundStatus: refund.status || 'submitted', refundedAt: now, refundedAmount: amount, refundInitiatedBy: initiatedBy, refundReason, refundReasonLabel: REFUND_REASONS.get(refundReason), refundNotes, refundHistory: history, updatedAt: now });
  }
  if (review) await reviewStore.setJSON(submissionId, { ...review, ...packagePatch, ticketState: 'refunded', ticketRefundedAt: now, stripeRefundId: refund.id, refundStatus: refund.status || 'submitted', refundInitiatedBy: initiatedBy, refundReason, refundReasonLabel: REFUND_REASONS.get(refundReason), refundNotes, refundHistory: history, updatedAt: now });

  const email = await sendEmail(application, next, refund, amount, packageAttached).catch((error) => ({ status: 'failed', error: String(error?.message || error) }));
  await writeAudit('ticket.admin_admission_partial_refunded', { submissionId, ticketId: summary.ticketId, stripePaymentIntentId: summary.stripePaymentIntentId, stripeRefundId: refund.id, amount, packageBundled, packageAttached, packageRefunded: false, packageForfeited: packageAttached, initiatedBy, refundReason, refundReasonLabel: REFUND_REASONS.get(refundReason), refundNotes, emailStatus: email.status });

  return json({ ok: true, action: 'admission-only', ticketId: summary.ticketId, admissionRefund: { id: refund.id, status: refund.status || 'submitted', amount, currency: refund.currency || summary.currency || 'usd' }, refundReason, refundReasonLabel: REFUND_REASONS.get(refundReason), refundNotes, drinkPackageRefunded: false, drinkPackageForfeited: Boolean(summary.drinkPackagePurchased), waterPackageRefunded: false, waterPackageForfeited: Boolean(summary.waterPackagePurchased), refundEmailStatus: email.status });
};
