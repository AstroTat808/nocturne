import { getStore } from '@netlify/blobs';
import { randomBytes } from 'node:crypto';
import { makeReentryToken, readTicketAccess } from './_ticket-auth.mjs';
import { writeAudit } from './_audit.mjs';
import { drinkPackageConfig, drinkPackageRequested } from './_drink-package.mjs';
import { waterPackageConfig } from './_water-package.mjs';
import { lateStayConfig, LATE_STAY_POLICY_TEXT, releaseLateStayReservation, reserveLateStaySlot } from './_late-stay.mjs';
import { ticketPricing } from './_ticket-pricing.mjs';

const APPLICATION_STORE = 'nocturne-applications';
const REVIEW_STORE = 'nocturne-application-reviews';
const ORDER_STORE = 'nocturne-ticket-orders';

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' } });
}
function redirect(location) { return new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store' } }); }
export function browserFormPost(req) {
  const contentType = (req.headers.get('content-type') || '').toLowerCase();
  return contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data');
}
function fail(req, message, status) { return browserFormPost(req) ? redirect(`/ticket-access?checkout_error=${encodeURIComponent(message)}`) : json({ error: message }, status); }
function checkoutConfigured() { const price = ticketPricing().priceCents; return Boolean(process.env.STRIPE_SECRET_KEY && Number.isInteger(price) && price >= 50); }
function siteUrl(req) { return (process.env.NOCTURNE_SITE_URL || new URL(req.url).origin).replace(/\/$/, ''); }
function requested(value) { return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase()); }

async function stripeRequest(path, body, idempotencyKey = '') {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) }, body: new URLSearchParams(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `Stripe returned ${response.status}.`);
  return data;
}

function checkoutStillOpen(summary, includeDrinkPackage, includeWaterPackage, includeLateStay, ticketAmount) {
  if (summary?.status !== 'checkout_created' || !summary.checkoutUrl) return false;
  if (Number(summary.ticketAmount || 0) !== Number(ticketAmount || 0)) return false;
  if (Boolean(summary.drinkPackageRequested) !== includeDrinkPackage) return false;
  if (Boolean(summary.waterPackageRequested) !== includeWaterPackage) return false;
  if (Boolean(summary.lateStayRequested) !== includeLateStay) return false;
  const expiresAt = new Date(summary.checkoutExpiresAt || 0).getTime();
  return Number.isFinite(expiresAt) && expiresAt > Date.now() + 60_000;
}

async function claimCheckoutAttempt(store, submissionId, selectionKey) {
  const key = `checkout-attempt-${submissionId}`;
  const entry = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
  const now = Date.now();
  const current = entry?.data || null;
  const startedAt = new Date(current?.startedAt || 0).getTime();
  if (current?.status === 'creating' && Number.isFinite(startedAt) && now - startedAt < 120_000) return null;
  const reuseKey = current?.status !== 'completed' && current?.selectionKey === selectionKey && current?.idempotencyKey;
  const attempt = { submissionId, status: 'creating', idempotencyKey: reuseKey || `nocturne-checkout-${randomBytes(18).toString('hex')}`, selectionKey, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const result = await store.setJSON(key, attempt, entry ? { onlyIfMatch: entry.etag } : { onlyIfNew: true });
  return result.modified ? { key, attempt } : null;
}

function checkoutSelection(source) {
  return {
    drinkPackage: drinkPackageRequested(source.get('drink_package')),
    waterPackage: requested(source.get('water_package')),
    lateStay: requested(source.get('late_stay')),
    packagePolicyAccepted: String(source.get('package_policy') || '').toLowerCase() === 'yes'
  };
}

export async function checkoutInput(req) {
  const contentType = (req.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return checkoutSelection(new URLSearchParams(await req.text()));
  }
  if (contentType.includes('multipart/form-data')) {
    return checkoutSelection(await req.formData());
  }
  if (contentType.includes('application/json')) {
    const data = await req.json();
    return {
      drinkPackage: drinkPackageRequested(data?.drinkPackage),
      waterPackage: requested(data?.waterPackage),
      lateStay: requested(data?.lateStay),
      packagePolicyAccepted: data?.packagePolicy === true || requested(data?.packagePolicy)
    };
  }
  return { drinkPackage: false, waterPackage: false, lateStay: false, packagePolicyAccepted: false };
}

export function appendBundledAddOnLineItems(params, { currency, includeDrinkPackage, includeWaterPackage, includeLateStay, packageConfig, waterConfig, lateStay }) {
  let lineIndex = 1;
  if (includeDrinkPackage) {
    params[`line_items[${lineIndex}][quantity]`] = '1';
    params[`line_items[${lineIndex}][price_data][currency]`] = currency;
    params[`line_items[${lineIndex}][price_data][unit_amount]`] = String(packageConfig.priceCents);
    params[`line_items[${lineIndex}][price_data][product_data][name]`] = 'NOCTURNE Six-Drink Package — NON-REFUNDABLE';
    params[`line_items[${lineIndex}][price_data][product_data][description]`] = 'FINAL SALE / NON-REFUNDABLE. Six prepaid bar credits. Beer or well cocktail per credit; premium cocktails require a $5 upgrade at the bar. 21+ ID required. Unused credits are not refundable, exchangeable, transferable, or redeemable for cash.';
    lineIndex += 1;
  }
  if (includeWaterPackage) {
    params[`line_items[${lineIndex}][quantity]`] = '1';
    params[`line_items[${lineIndex}][price_data][currency]`] = currency;
    params[`line_items[${lineIndex}][price_data][unit_amount]`] = String(waterConfig.priceCents);
    params[`line_items[${lineIndex}][price_data][product_data][name]`] = 'NOCTURNE Unlimited Drinking Water — NON-REFUNDABLE';
    params[`line_items[${lineIndex}][price_data][product_data][description]`] = 'FINAL SALE / NON-REFUNDABLE. Unlimited drinking-water service for the registered ticket holder during festival operating hours. One package per ticket; non-transferable.';
    lineIndex += 1;
  }
  if (includeLateStay) {
    params[`line_items[${lineIndex}][quantity]`] = '1';
    params[`line_items[${lineIndex}][price_data][currency]`] = currency;
    params[`line_items[${lineIndex}][price_data][unit_amount]`] = String(lateStay.priceCents);
    params[`line_items[${lineIndex}][price_data][product_data][name]`] = 'NOCTURNE Late Checkout / Car Camping — NON-REFUNDABLE';
    params[`line_items[${lineIndex}][price_data][product_data][description]`] = `FINAL SALE / NON-REFUNDABLE. ${LATE_STAY_POLICY_TEXT} Stay on the property after the 3:00 AM event end until 8:00 AM. Each person remaining after 3:00 AM needs their own add-on.`;
  }
  return params;
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(req.url).origin) return fail(req, 'Origin not allowed.', 403);
  const access = readTicketAccess(req);
  if (!access) return fail(req, 'Private ticket access has expired. Redeem a new invitation to continue.', 401);
  if (!checkoutConfigured()) return fail(req, 'Ticket checkout is not configured yet.', 503);
  let input;
  try {
    input = await checkoutInput(req);
  } catch (error) {
    console.error('NOCTURNE checkout selection parsing failed:', error);
    return fail(req, 'Checkout selections could not be read. Reload your private ticket page and try again.', 400);
  }
  const packageConfig = drinkPackageConfig();
  const waterConfig = waterPackageConfig();
  const lateStay = lateStayConfig();
  const pricing = ticketPricing();
  const unitAmount = pricing.priceCents;
  const includeDrinkPackage = packageConfig.enabled && input.drinkPackage;
  const includeWaterPackage = waterConfig.enabled && input.waterPackage;
  const includeLateStay = lateStay.enabled && input.lateStay;
  const anyAddOnSelected = includeDrinkPackage || includeWaterPackage || includeLateStay;
  if (anyAddOnSelected && !input.packagePolicyAccepted) return fail(req, 'You must acknowledge that all selected add-ons are FINAL SALE / NON-REFUNDABLE before checkout.', 400);

  const submissionId = access.submissionId;
  const applicationStore = getStore({ name: APPLICATION_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const [application, review] = await Promise.all([applicationStore.get(submissionId, { type: 'json', consistency: 'strong' }), reviewStore.get(submissionId, { type: 'json', consistency: 'strong' })]);
  if (!application || !review || review.status !== 'approved' || review.inviteState !== 'redeemed') return fail(req, 'This invitation is not eligible for ticket checkout.', 403);

  const blockedTicketStates = new Set(['paid', 'checked_in', 'refunded', 'disputed']);
  if (blockedTicketStates.has(String(review.ticketState || '').toLowerCase())) return fail(req, review.ticketState === 'paid' || review.ticketState === 'checked_in' ? 'A ticket has already been issued for this invitation.' : 'This invitation has a protected payment record and cannot start another checkout.', 409);

  const summaryKey = `submission-${submissionId}`;
  const existingEntry = await orderStore.getWithMetadata(summaryKey, { type: 'json', consistency: 'strong' });
  const existing = existingEntry?.data || null;
  if (blockedTicketStates.has(String(existing?.status || '').toLowerCase())) return fail(req, 'This invitation already has a protected ticket or payment record.', 409);
  if (checkoutStillOpen(existing, includeDrinkPackage, includeWaterPackage, includeLateStay, unitAmount)) return browserFormPost(req) ? redirect(existing.checkoutUrl) : json({ ok: true, checkoutUrl: existing.checkoutUrl, reused: true });

  if (includeLateStay && existing?.lateStayReservationId && existing?.lateStaySlot) {
    await releaseLateStayReservation({ slot: existing.lateStaySlot, reservationId: existing.lateStayReservationId, reason: 'ticket_checkout_replaced' }).catch(() => {});
  }

  const selectionKey = ['ticket', `price-${unitAmount}`, includeDrinkPackage ? 'six-drink' : '', includeWaterPackage ? 'water' : '', includeLateStay ? 'late-stay' : ''].filter(Boolean).join('+');
  const claim = await claimCheckoutAttempt(orderStore, submissionId, selectionKey);
  if (!claim) return fail(req, 'Your checkout is already being prepared. Please wait a moment and try again.', 409);

  let lateStayReservation = null;
  let stripeExpiresAt = null;
  if (includeLateStay) {
    stripeExpiresAt = Math.floor(Date.now() / 1000) + 32 * 60;
    lateStayReservation = await reserveLateStaySlot({ submissionId, expiresAt: new Date((stripeExpiresAt + 120) * 1000).toISOString() });
    if (!lateStayReservation) {
      await orderStore.setJSON(claim.key, { ...claim.attempt, status: 'failed', error: 'late_stay_tracking_unavailable', updatedAt: new Date().toISOString() }).catch(() => {});
      return fail(req, 'Late Checkout / Car Camping checkout could not be prepared. Please try again.', 503);
    }
  }

  const currency = String(process.env.NOCTURNE_TICKET_CURRENCY || 'usd').toLowerCase();
  const productName = String(process.env.NOCTURNE_TICKET_NAME || 'NOCTURNE Festival — General Admission').slice(0, 120);
  const baseUrl = siteUrl(req);
  const returnToken = makeReentryToken(submissionId, 7200);
  if (!returnToken) {
    if (lateStayReservation) await releaseLateStayReservation({ slot: lateStayReservation.slot, reservationId: lateStayReservation.reservationId, reason: 'ticket_return_token_failed' }).catch(() => {});
    return fail(req, 'Secure ticket return could not be initialized.', 503);
  }
  const expectedAmountTotal = unitAmount + (includeDrinkPackage ? packageConfig.priceCents : 0) + (includeWaterPackage ? waterConfig.priceCents : 0) + (includeLateStay ? lateStay.priceCents : 0);
  const params = {
    mode: 'payment', success_url: `${baseUrl}/ticket-confirmed?session_id={CHECKOUT_SESSION_ID}&return_token=${encodeURIComponent(returnToken)}`, cancel_url: `${baseUrl}/ticket-access?checkout=cancelled`, client_reference_id: submissionId,
    'metadata[submissionId]': submissionId, 'metadata[event]': 'NOCTURNE',
    'metadata[ticketAmount]': String(unitAmount), 'metadata[ticketPriceTier]': pricing.changed ? '35' : '25', 'metadata[ticketPriceChangeAt]': pricing.changeAt,
    'metadata[packagePolicyAccepted]': anyAddOnSelected ? 'true' : 'false',
    'metadata[drinkPackage]': includeDrinkPackage ? 'six-credit' : 'none', 'metadata[drinkCredits]': includeDrinkPackage ? String(packageConfig.credits) : '0', 'metadata[drinkPackagePolicyAccepted]': includeDrinkPackage ? 'true' : 'false',
    'metadata[waterPackage]': includeWaterPackage ? 'unlimited' : 'none', 'metadata[waterPackagePolicyAccepted]': includeWaterPackage ? 'true' : 'false',
    'metadata[lateStay]': includeLateStay ? 'until-8am' : 'none', 'metadata[lateStayPolicyAccepted]': includeLateStay ? 'true' : 'false',
    'metadata[lateStaySlot]': includeLateStay ? String(lateStayReservation.slot) : '', 'metadata[lateStayReservationId]': includeLateStay ? lateStayReservation.reservationId : '',
    'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': currency, 'line_items[0][price_data][unit_amount]': String(unitAmount), 'line_items[0][price_data][product_data][name]': productName,
    'payment_intent_data[metadata][submissionId]': submissionId, 'payment_intent_data[metadata][event]': 'NOCTURNE', 'payment_intent_data[metadata][ticketAmount]': String(unitAmount), 'payment_intent_data[metadata][ticketPriceTier]': pricing.changed ? '35' : '25',
    'payment_intent_data[metadata][packagePolicyAccepted]': anyAddOnSelected ? 'true' : 'false',
    'payment_intent_data[metadata][drinkPackage]': includeDrinkPackage ? 'six-credit' : 'none', 'payment_intent_data[metadata][drinkPackagePolicyAccepted]': includeDrinkPackage ? 'true' : 'false',
    'payment_intent_data[metadata][waterPackage]': includeWaterPackage ? 'unlimited' : 'none', 'payment_intent_data[metadata][waterPackagePolicyAccepted]': includeWaterPackage ? 'true' : 'false',
    'payment_intent_data[metadata][lateStay]': includeLateStay ? 'until-8am' : 'none', 'payment_intent_data[metadata][lateStaySlot]': includeLateStay ? String(lateStayReservation.slot) : ''
  };
  const secondsUntilPriceChange = Math.floor((pricing.changeAtEpochMs - Date.now()) / 1000);
  if (!pricing.changed && secondsUntilPriceChange >= 30 * 60 && (!stripeExpiresAt || Math.floor(pricing.changeAtEpochMs / 1000) < stripeExpiresAt)) {
    stripeExpiresAt = Math.floor(pricing.changeAtEpochMs / 1000);
  }
  if (stripeExpiresAt) params.expires_at = String(stripeExpiresAt);
  appendBundledAddOnLineItems(params, { currency, includeDrinkPackage, includeWaterPackage, includeLateStay, packageConfig, waterConfig, lateStay });
  if (application.email) params.customer_email = application.email;
  if (process.env.NOCTURNE_TICKET_DESCRIPTION) params['line_items[0][price_data][product_data][description]'] = String(process.env.NOCTURNE_TICKET_DESCRIPTION).slice(0, 500);

  try {
    if (existing?.status === 'checkout_created' && existing.stripeCheckoutSessionId) await stripeRequest(`checkout/sessions/${encodeURIComponent(existing.stripeCheckoutSessionId)}/expire`, {}).catch(() => {});
    const session = await stripeRequest('checkout/sessions', params, claim.attempt.idempotencyKey);
    const createdAt = new Date().toISOString();
    const checkoutExpiresAt = session.expires_at ? new Date(Number(session.expires_at) * 1000).toISOString() : null;
    const record = {
      stripeCheckoutSessionId: session.id, submissionId, status: 'checkout_created', amountTotal: expectedAmountTotal, ticketAmount: unitAmount,
      ticketPriceTier: pricing.changed ? '35' : '25', ticketPriceChangeAt: pricing.changeAt, packagePolicyAccepted: anyAddOnSelected ? true : null,
      drinkPackageRequested: includeDrinkPackage, drinkPackagePolicyAccepted: includeDrinkPackage ? true : null, drinkPackagePriceCents: includeDrinkPackage ? packageConfig.priceCents : 0, drinkCreditsPurchased: includeDrinkPackage ? packageConfig.credits : 0,
      waterPackageRequested: includeWaterPackage, waterPackagePolicyAccepted: includeWaterPackage ? true : null, waterPackagePriceCents: includeWaterPackage ? waterConfig.priceCents : 0,
      lateStayRequested: includeLateStay, lateStayPolicyAccepted: includeLateStay ? true : null, lateStayPriceCents: includeLateStay ? lateStay.priceCents : 0,
      lateStaySlot: includeLateStay ? lateStayReservation.slot : null, lateStayReservationId: includeLateStay ? lateStayReservation.reservationId : null, lateStayDepartureTime: includeLateStay ? lateStay.departureTime : null,
      currency, customerEmail: application.email || null, checkoutUrl: session.url, checkoutExpiresAt, createdAt, updatedAt: createdAt
    };
    await orderStore.setJSON(session.id, record);
    const summaryWrite = await orderStore.setJSON(summaryKey, { ...record, expectedAmountTotal }, existingEntry ? { onlyIfMatch: existingEntry.etag } : { onlyIfNew: true });
    if (!summaryWrite.modified) {
      await stripeRequest(`checkout/sessions/${encodeURIComponent(session.id)}/expire`, {}).catch(() => {});
      if (lateStayReservation) await releaseLateStayReservation({ slot: lateStayReservation.slot, reservationId: lateStayReservation.reservationId, reason: 'ticket_checkout_conflict' }).catch(() => {});
      await orderStore.setJSON(session.id, { ...record, status: 'checkout_conflict', updatedAt: new Date().toISOString() });
      throw new Error('Ticket eligibility changed while checkout was being prepared.');
    }
    await orderStore.setJSON(claim.key, { ...claim.attempt, status: 'completed', stripeCheckoutSessionId: session.id, checkoutExpiresAt, lateStaySlot: lateStayReservation?.slot || null, lateStayReservationId: lateStayReservation?.reservationId || null, updatedAt: createdAt });
    await writeAudit('checkout.created', { submissionId, stripeCheckoutSessionId: session.id, ticketAmount: unitAmount, ticketPriceTier: pricing.changed ? '35' : '25', ticketPriceChangeAt: pricing.changeAt, packagePolicyAccepted: anyAddOnSelected ? true : null, drinkPackageRequested: includeDrinkPackage, drinkPackagePolicyAccepted: includeDrinkPackage ? true : null, waterPackageRequested: includeWaterPackage, waterPackagePolicyAccepted: includeWaterPackage ? true : null, lateStayRequested: includeLateStay, lateStayPolicyAccepted: includeLateStay ? true : null, lateStayFinalSaleNonRefundable: includeLateStay ? true : null, lateStayTrackingSlot: lateStayReservation?.slot || null, lateStayUnlimitedInventory: includeLateStay ? true : null, expectedAmountTotal });
    return browserFormPost(req) ? redirect(session.url) : json({ ok: true, checkoutUrl: session.url, ticketAmount: unitAmount, ticketPriceTier: pricing.changed ? '35' : '25' });
  } catch (error) {
    if (lateStayReservation) await releaseLateStayReservation({ slot: lateStayReservation.slot, reservationId: lateStayReservation.reservationId, reason: 'ticket_checkout_failed' }).catch(() => {});
    await orderStore.setJSON(claim.key, { ...claim.attempt, status: 'failed', error: String(error?.message || error).slice(0, 500), updatedAt: new Date().toISOString() }).catch(() => {});
    await writeAudit('checkout.failed', { submissionId, ticketAmount: unitAmount, error: String(error?.message || error) });
    console.error('NOCTURNE Stripe checkout creation failed:', error);
    return fail(req, 'Ticket checkout could not be started. Please try again.', 502);
  }
};