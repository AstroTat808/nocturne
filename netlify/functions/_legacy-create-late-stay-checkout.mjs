import { getStore } from '@netlify/blobs';
import { randomBytes } from 'node:crypto';
import { verifyTicketToken } from './_ticket-token.mjs';
import { writeAudit } from './_audit.mjs';
import { lateStayAddonEligible, lateStayConfig, LATE_STAY_POLICY_TEXT, reconcileLateStayCheckout, releaseLateStayReservation, reserveLateStaySlot } from './_late-stay.mjs';

const APPLICATION_STORE = 'nocturne-applications';
const REVIEW_STORE = 'nocturne-application-reviews';
const ORDER_STORE = 'nocturne-ticket-orders';

function json(data, status = 200) { return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' } }); }
function redirect(location) { return new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } }); }
function browserFormPost(req) { return (req.headers.get('content-type') || '').toLowerCase().includes('application/x-www-form-urlencoded'); }
function fail(req, message, status) { return browserFormPost(req) ? redirect(`/ticket/late-stay/confirmed?error=${encodeURIComponent(message)}`) : json({ error: message }, status); }
function siteUrl(req) { return (process.env.NOCTURNE_SITE_URL || new URL(req.url).origin).replace(/\/$/, ''); }

async function requestInput(req) {
  const type = (req.headers.get('content-type') || '').toLowerCase();
  try {
    if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
      const form = await req.formData();
      return { token: String(form.get('token') || '').trim(), policyAccepted: String(form.get('late_stay_policy') || '').toLowerCase() === 'yes' };
    }
    if (type.includes('application/json')) {
      const data = await req.json();
      return { token: String(data?.token || '').trim(), policyAccepted: data?.lateStayPolicy === true || String(data?.lateStayPolicy || '').toLowerCase() === 'yes' };
    }
  } catch {}
  return { token: '', policyAccepted: false };
}

async function stripeRequest(path, body, idempotencyKey = '') {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
    body: new URLSearchParams(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `Stripe returned ${response.status}.`);
  return data;
}

async function stripeCheckoutSession(sessionId) {
  if (!sessionId) return null;
  const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return null;
  return data;
}

function checkoutStillOpen(summary) {
  if (summary?.lateStayCheckoutStatus !== 'checkout_created' || !summary.lateStayCheckoutUrl) return false;
  const expiresAt = new Date(summary.lateStayCheckoutExpiresAt || 0).getTime();
  return Number.isFinite(expiresAt) && expiresAt > Date.now() + 60_000;
}

async function reusableExistingCheckout(summary) {
  if (!checkoutStillOpen(summary) || !summary?.lateStayCheckoutSessionId) return null;
  const session = await stripeCheckoutSession(summary.lateStayCheckoutSessionId);
  if (!session || session.status !== 'open' || session.payment_status === 'paid' || !session.url) return null;
  return session;
}

async function claimAttempt(store, submissionId) {
  const key = `late-stay-checkout-attempt-${submissionId}`;
  const entry = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
  const current = entry?.data || null;
  const startedAt = new Date(current?.startedAt || 0).getTime();
  if (current?.status === 'creating' && Number.isFinite(startedAt) && Date.now() - startedAt < 120_000) return null;
  const attempt = { submissionId, status: 'creating', idempotencyKey: current?.status !== 'completed' && current?.idempotencyKey ? current.idempotencyKey : `nocturne-late-stay-${randomBytes(18).toString('hex')}`, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const write = await store.setJSON(key, attempt, entry ? { onlyIfMatch: entry.etag } : { onlyIfNew: true });
  return write.modified ? { key, attempt } : null;
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(req.url).origin) return fail(req, 'Origin not allowed.', 403);
  const config = lateStayConfig();
  if (!config.enabled || !process.env.STRIPE_SECRET_KEY) return fail(req, 'Late Checkout / Car Camping checkout is not available yet.', 503);
  const { token, policyAccepted } = await requestInput(req);
  if (!policyAccepted) return fail(req, 'You must acknowledge that Late Checkout / Car Camping is FINAL SALE / NON-REFUNDABLE before checkout.', 400);
  const parsed = verifyTicketToken(token);
  if (!parsed) return fail(req, 'This digital ticket link is invalid.', 400);

  const applicationStore = getStore({ name: APPLICATION_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const summaryKey = `submission-${parsed.submissionId}`;
  let [application, review, summaryEntry] = await Promise.all([
    applicationStore.get(parsed.submissionId, { type: 'json', consistency: 'strong' }),
    reviewStore.get(parsed.submissionId, { type: 'json', consistency: 'strong' }),
    orderStore.getWithMetadata(summaryKey, { type: 'json', consistency: 'strong' })
  ]);
  let summary = summaryEntry?.data || null;
  if (summary?.lateStayPurchased && summary.ticketId === parsed.ticketId) return fail(req, 'This ticket already includes Late Checkout / Car Camping.', 409);
  if (summary?.lateStayCheckoutStatus === 'checkout_created' && summary?.lateStayCheckoutSessionId) {
    summary = await reconcileLateStayCheckout({ summaryEntry, orderStore, reviewStore }).catch(() => summary);
    if (summary?.lateStayPurchased) return fail(req, 'This ticket already includes Late Checkout / Car Camping.', 409);
    if (summary !== summaryEntry?.data) summaryEntry = await orderStore.getWithMetadata(summaryKey, { type: 'json', consistency: 'strong' });
  }
  if (!application || !lateStayAddonEligible(summary, review, parsed.ticketId)) return fail(req, 'Only an active paid or complimentary ticket can add Late Checkout / Car Camping.', 403);

  if (checkoutStillOpen(summary)) {
    const existingSession = await reusableExistingCheckout(summary);
    if (existingSession) {
      return browserFormPost(req) ? redirect(existingSession.url) : json({ ok: true, checkoutUrl: existingSession.url, reused: true });
    }

    await releaseLateStayReservation({ slot: summary.lateStaySlot, reservationId: summary.lateStayReservationId, reason: 'stale_stripe_checkout' }).catch(() => {});
    const staleAt = new Date().toISOString();
    const staleWrite = await orderStore.setJSON(summaryKey, {
      ...summary,
      lateStayCheckoutStatus: 'expired',
      lateStayCheckoutUrl: null,
      lateStayCheckoutExpiresAt: null,
      lateStaySlot: null,
      lateStayReservationId: null,
      updatedAt: staleAt
    }, { onlyIfMatch: summaryEntry.etag }).catch(() => ({ modified: false }));
    await writeAudit('late_stay.stale_checkout_recovered', {
      submissionId: parsed.submissionId,
      ticketId: parsed.ticketId,
      stripeCheckoutSessionId: summary.lateStayCheckoutSessionId,
      recoveredAt: staleAt,
      localRecordUpdated: Boolean(staleWrite?.modified)
    }).catch(() => {});
    summaryEntry = await orderStore.getWithMetadata(summaryKey, { type: 'json', consistency: 'strong' });
    summary = summaryEntry?.data || summary;
    if (summary?.lateStayPurchased) return fail(req, 'This ticket already includes Late Checkout / Car Camping.', 409);
    if (!lateStayAddonEligible(summary, review, parsed.ticketId)) return fail(req, 'Late Checkout / Car Camping checkout could not be refreshed. Please reload your digital ticket and try again.', 409);
  }

  const claim = await claimAttempt(orderStore, parsed.submissionId);
  if (!claim) return fail(req, 'Your Late Checkout / Car Camping checkout is already being prepared. Please wait a moment and try again.', 409);
  const stripeExpiresAt = Math.floor(Date.now() / 1000) + 32 * 60;
  const reservationExpiresAt = new Date((stripeExpiresAt + 120) * 1000).toISOString();
  const reservation = await reserveLateStaySlot({ submissionId: parsed.submissionId, ticketId: parsed.ticketId, expiresAt: reservationExpiresAt });
  if (!reservation) {
    await orderStore.setJSON(claim.key, { ...claim.attempt, status: 'failed', error: 'late_stay_tracking_unavailable', updatedAt: new Date().toISOString() }).catch(() => {});
    return fail(req, 'Late Checkout / Car Camping checkout could not be prepared. Please try again.', 503);
  }

  const currency = String(process.env.NOCTURNE_TICKET_CURRENCY || 'usd').toLowerCase();
  const baseUrl = siteUrl(req);
  const params = {
    mode: 'payment', expires_at: String(stripeExpiresAt), success_url: `${baseUrl}/ticket/late-stay/confirmed?session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${baseUrl}/ticket/late-stay/confirmed?cancelled=1`, client_reference_id: parsed.submissionId, customer_email: application.email || undefined,
    'metadata[submissionId]': parsed.submissionId, 'metadata[ticketId]': parsed.ticketId, 'metadata[event]': 'NOCTURNE', 'metadata[purchaseType]': 'late-stay-addon', 'metadata[lateStaySlot]': String(reservation.slot), 'metadata[lateStayReservationId]': reservation.reservationId, 'metadata[lateStayPolicyAccepted]': 'true',
    'payment_intent_data[metadata][submissionId]': parsed.submissionId, 'payment_intent_data[metadata][ticketId]': parsed.ticketId, 'payment_intent_data[metadata][event]': 'NOCTURNE', 'payment_intent_data[metadata][purchaseType]': 'late-stay-addon', 'payment_intent_data[metadata][lateStaySlot]': String(reservation.slot),
    'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': currency, 'line_items[0][price_data][unit_amount]': String(config.priceCents), 'line_items[0][price_data][product_data][name]': 'NOCTURNE Late Checkout / Car Camping — NON-REFUNDABLE',
    'line_items[0][price_data][product_data][description]': `FINAL SALE / NON-REFUNDABLE. ${LATE_STAY_POLICY_TEXT} Stay on the property after the 3:00 AM event end until 8:00 AM. Each person remaining after 3:00 AM must have their own add-on.`
  };
  if (!params.customer_email) delete params.customer_email;

  try {
    if (summary?.lateStayCheckoutStatus === 'checkout_created' && summary?.lateStayCheckoutSessionId) await stripeRequest(`checkout/sessions/${encodeURIComponent(summary.lateStayCheckoutSessionId)}/expire`, {}).catch(() => {});
    const session = await stripeRequest('checkout/sessions', params, claim.attempt.idempotencyKey);
    const createdAt = new Date().toISOString();
    const expiresAt = session.expires_at ? new Date(Number(session.expires_at) * 1000).toISOString() : reservationExpiresAt;
    const sessionRecord = { purchaseType: 'late-stay-addon', stripeCheckoutSessionId: session.id, submissionId: parsed.submissionId, ticketId: parsed.ticketId, ticketSource: summary.ticketSource || review.ticketSource || null, status: 'checkout_created', paymentStatus: session.payment_status || 'unpaid', amountTotal: config.priceCents, lateStayPriceCents: config.priceCents, lateStayPolicyAccepted: true, lateStaySlot: reservation.slot, lateStayReservationId: reservation.reservationId, lateStayDepartureTime: config.departureTime, currency, customerEmail: application.email || null, checkoutUrl: session.url, checkoutExpiresAt: expiresAt, createdAt, updatedAt: createdAt };
    await orderStore.setJSON(session.id, sessionRecord);
    const latestEntry = await orderStore.getWithMetadata(summaryKey, { type: 'json', consistency: 'strong' });
    const latest = latestEntry?.data || summary;
    if (!latest || !lateStayAddonEligible(latest, review, parsed.ticketId)) throw new Error('Ticket eligibility changed while checkout was being prepared.');
    const summaryWrite = await orderStore.setJSON(summaryKey, { ...latest, lateStayRequested: true, lateStayCheckoutStatus: 'checkout_created', lateStayCheckoutSessionId: session.id, lateStayCheckoutUrl: session.url, lateStayCheckoutExpiresAt: expiresAt, lateStayPriceCents: config.priceCents, lateStayPolicyAccepted: true, lateStaySlot: reservation.slot, lateStayReservationId: reservation.reservationId, lateStayDepartureTime: config.departureTime, updatedAt: createdAt }, { onlyIfMatch: latestEntry.etag });
    if (!summaryWrite.modified) throw new Error('Ticket eligibility changed while checkout was being prepared.');
    await orderStore.setJSON(claim.key, { ...claim.attempt, status: 'completed', stripeCheckoutSessionId: session.id, lateStaySlot: reservation.slot, lateStayReservationId: reservation.reservationId, checkoutExpiresAt: expiresAt, updatedAt: createdAt });
    await writeAudit('late_stay.checkout_created', { submissionId: parsed.submissionId, ticketId: parsed.ticketId, stripeCheckoutSessionId: session.id, amountTotal: config.priceCents, trackingSlot: reservation.slot, unlimitedInventory: true, finalSaleNonRefundable: true });
    return browserFormPost(req) ? redirect(session.url) : json({ ok: true, checkoutUrl: session.url });
  } catch (error) {
    await releaseLateStayReservation({ slot: reservation.slot, reservationId: reservation.reservationId, reason: 'checkout_creation_failed' }).catch(() => {});
    await orderStore.setJSON(claim.key, { ...claim.attempt, status: 'failed', error: String(error?.message || error).slice(0, 500), updatedAt: new Date().toISOString() }).catch(() => {});
    await writeAudit('late_stay.checkout_failed', { submissionId: parsed.submissionId, ticketId: parsed.ticketId, error: String(error?.message || error) }).catch(() => {});
    console.error('NOCTURNE Late Checkout / Car Camping checkout creation failed:', error);
    return fail(req, 'Late Checkout / Car Camping checkout could not be started. Please try again.', 502);
  }
};
