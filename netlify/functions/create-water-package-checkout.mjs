import { getStore } from '@netlify/blobs';
import { randomBytes } from 'node:crypto';
import { verifyTicketToken } from './_ticket-token.mjs';
import { writeAudit } from './_audit.mjs';
import { waterPackageAddonEligible, waterPackageConfig } from './_water-package.mjs';

const APPLICATION_STORE = 'nocturne-applications';
const REVIEW_STORE = 'nocturne-application-reviews';
const ORDER_STORE = 'nocturne-ticket-orders';

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' } });
}

function redirect(location) {
  return new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}

function browserFormPost(req) {
  return (req.headers.get('content-type') || '').toLowerCase().includes('application/x-www-form-urlencoded');
}

function fail(req, message, status) {
  if (browserFormPost(req)) return redirect(`/ticket/water/confirmed?error=${encodeURIComponent(message)}`);
  return json({ error: message }, status);
}

function siteUrl(req) {
  return (process.env.NOCTURNE_SITE_URL || new URL(req.url).origin).replace(/\/$/, '');
}

async function requestInput(req) {
  const type = (req.headers.get('content-type') || '').toLowerCase();
  try {
    if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
      const form = await req.formData();
      return { token: String(form.get('token') || '').trim() };
    }
    if (type.includes('application/json')) {
      const data = await req.json();
      return { token: String(data?.token || '').trim() };
    }
  } catch {}
  return { token: '' };
}

async function stripeRequest(path, body, idempotencyKey = '') {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {})
    },
    body: new URLSearchParams(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `Stripe returned ${response.status}.`);
  return data;
}

function checkoutStillOpen(summary) {
  if (summary?.waterPackageCheckoutStatus !== 'checkout_created' || !summary.waterPackageCheckoutUrl) return false;
  const expiresAt = new Date(summary.waterPackageCheckoutExpiresAt || 0).getTime();
  return Number.isFinite(expiresAt) && expiresAt > Date.now() + 60_000;
}

async function claimAttempt(store, submissionId) {
  const key = `water-package-checkout-attempt-${submissionId}`;
  const entry = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
  const current = entry?.data || null;
  const startedAt = new Date(current?.startedAt || 0).getTime();
  if (current?.status === 'creating' && Number.isFinite(startedAt) && Date.now() - startedAt < 120_000) return null;
  const attempt = {
    submissionId,
    status: 'creating',
    idempotencyKey: current?.status !== 'completed' && current?.idempotencyKey
      ? current.idempotencyKey
      : `nocturne-water-addon-${randomBytes(18).toString('hex')}`,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const write = await store.setJSON(key, attempt, entry ? { onlyIfMatch: entry.etag } : { onlyIfNew: true });
  return write.modified ? { key, attempt } : null;
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(req.url).origin) return fail(req, 'Origin not allowed.', 403);

  const config = waterPackageConfig();
  if (!config.enabled || !process.env.STRIPE_SECRET_KEY) return fail(req, 'Unlimited-water checkout is not available yet.', 503);
  const { token } = await requestInput(req);
  const parsed = verifyTicketToken(token);
  if (!parsed) return fail(req, 'This digital ticket link is invalid.', 400);

  const applicationStore = getStore({ name: APPLICATION_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const summaryKey = `submission-${parsed.submissionId}`;
  const [application, review, summaryEntry] = await Promise.all([
    applicationStore.get(parsed.submissionId, { type: 'json', consistency: 'strong' }),
    reviewStore.get(parsed.submissionId, { type: 'json', consistency: 'strong' }),
    orderStore.getWithMetadata(summaryKey, { type: 'json', consistency: 'strong' })
  ]);
  const summary = summaryEntry?.data || null;

  if (summary?.waterPackagePurchased && summary.ticketId === parsed.ticketId) return fail(req, 'This ticket already includes unlimited drinking water.', 409);
  if (!application || !waterPackageAddonEligible(summary, review, parsed.ticketId)) {
    return fail(req, 'Only an active paid or complimentary ticket can add unlimited drinking water.', 403);
  }
  if (checkoutStillOpen(summary)) {
    if (browserFormPost(req)) return redirect(summary.waterPackageCheckoutUrl);
    return json({ ok: true, checkoutUrl: summary.waterPackageCheckoutUrl, reused: true });
  }

  const claim = await claimAttempt(orderStore, parsed.submissionId);
  if (!claim) return fail(req, 'Your water-package checkout is already being prepared. Please wait a moment and try again.', 409);

  const currency = String(process.env.NOCTURNE_TICKET_CURRENCY || 'usd').toLowerCase();
  const baseUrl = siteUrl(req);
  const params = {
    mode: 'payment',
    success_url: `${baseUrl}/ticket/water/confirmed?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/ticket/water/confirmed?cancelled=1`,
    client_reference_id: parsed.submissionId,
    customer_email: application.email || undefined,
    'metadata[submissionId]': parsed.submissionId,
    'metadata[ticketId]': parsed.ticketId,
    'metadata[event]': 'NOCTURNE',
    'metadata[purchaseType]': 'water-package-addon',
    'payment_intent_data[metadata][submissionId]': parsed.submissionId,
    'payment_intent_data[metadata][ticketId]': parsed.ticketId,
    'payment_intent_data[metadata][event]': 'NOCTURNE',
    'payment_intent_data[metadata][purchaseType]': 'water-package-addon',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': currency,
    'line_items[0][price_data][unit_amount]': String(config.priceCents),
    'line_items[0][price_data][product_data][name]': 'NOCTURNE Unlimited Drinking Water — NON-REFUNDABLE',
    'line_items[0][price_data][product_data][description]': 'FINAL SALE / NON-REFUNDABLE. Unlimited drinking-water service for one registered NOCTURNE guest during festival operating hours. Personal and non-transferable. No refunds, exchanges, prorating, or cash value.'
  };
  if (!params.customer_email) delete params.customer_email;

  try {
    if (summary.waterPackageCheckoutStatus === 'checkout_created' && summary.waterPackageCheckoutSessionId) {
      await stripeRequest(`checkout/sessions/${encodeURIComponent(summary.waterPackageCheckoutSessionId)}/expire`, {}).catch(() => {});
    }
    const session = await stripeRequest('checkout/sessions', params, claim.attempt.idempotencyKey);
    const createdAt = new Date().toISOString();
    const expiresAt = session.expires_at ? new Date(Number(session.expires_at) * 1000).toISOString() : null;
    const sessionRecord = {
      purchaseType: 'water-package-addon',
      stripeCheckoutSessionId: session.id,
      submissionId: parsed.submissionId,
      ticketId: parsed.ticketId,
      ticketSource: summary.ticketSource || review.ticketSource || null,
      status: 'checkout_created',
      paymentStatus: session.payment_status || 'unpaid',
      amountTotal: config.priceCents,
      waterPackagePriceCents: config.priceCents,
      currency,
      customerEmail: application.email || null,
      checkoutUrl: session.url,
      checkoutExpiresAt: expiresAt,
      createdAt,
      updatedAt: createdAt
    };
    await orderStore.setJSON(session.id, sessionRecord);
    const summaryWrite = await orderStore.setJSON(summaryKey, {
      ...summary,
      waterPackageCheckoutStatus: 'checkout_created',
      waterPackageCheckoutSessionId: session.id,
      waterPackageCheckoutUrl: session.url,
      waterPackageCheckoutExpiresAt: expiresAt,
      waterPackagePriceCents: config.priceCents,
      updatedAt: createdAt
    }, { onlyIfMatch: summaryEntry.etag });
    if (!summaryWrite.modified) {
      await stripeRequest(`checkout/sessions/${encodeURIComponent(session.id)}/expire`, {}).catch(() => {});
      await orderStore.setJSON(session.id, { ...sessionRecord, status: 'checkout_conflict', updatedAt: new Date().toISOString() });
      throw new Error('Ticket eligibility changed while checkout was being prepared.');
    }
    await orderStore.setJSON(claim.key, { ...claim.attempt, status: 'completed', stripeCheckoutSessionId: session.id, checkoutExpiresAt: expiresAt, updatedAt: createdAt });
    await writeAudit('water_package.checkout_created', { submissionId: parsed.submissionId, ticketId: parsed.ticketId, stripeCheckoutSessionId: session.id, amountTotal: config.priceCents });
    if (browserFormPost(req)) return redirect(session.url);
    return json({ ok: true, checkoutUrl: session.url });
  } catch (error) {
    await orderStore.setJSON(claim.key, { ...claim.attempt, status: 'failed', error: String(error?.message || error).slice(0, 500), updatedAt: new Date().toISOString() }).catch(() => {});
    await writeAudit('water_package.checkout_failed', { submissionId: parsed.submissionId, ticketId: parsed.ticketId, error: String(error?.message || error) });
    console.error('NOCTURNE water-package checkout creation failed:', error);
    return fail(req, 'Unlimited-water checkout could not be started. Please try again.', 502);
  }
};
