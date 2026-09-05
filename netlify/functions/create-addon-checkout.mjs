import { getStore } from '@netlify/blobs';
import { randomBytes } from 'node:crypto';
import { verifyTicketToken } from './_ticket-token.mjs';
import { drinkPackageConfig, drinkPackageAddonEligible } from './_drink-package.mjs';
import { waterPackageConfig, waterPackageAddonEligible } from './_water-package.mjs';
import { lateStayAddonEligible, lateStayConfig, LATE_STAY_POLICY_TEXT, releaseLateStayReservation, reserveLateStaySlot } from './_late-stay.mjs';
import { trustedBrowserSubmission } from './_browser-addon-checkout.mjs';
import { writeAudit } from './_audit.mjs';

const APPLICATION_STORE = 'nocturne-applications';
const REVIEW_STORE = 'nocturne-application-reviews';
const ORDER_STORE = 'nocturne-ticket-orders';

function redirect(location) { return new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } }); }
function json(data, status = 200) { return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' } }); }
function accepted(value) { return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase()); }
function siteUrl(req) { return (process.env.NOCTURNE_SITE_URL || new URL(req.url).origin).replace(/\/$/, ''); }
function fail(req, token, message, status) { return browserForm(req) ? redirect(`/ticket/addons?token=${encodeURIComponent(token)}&error=${encodeURIComponent(message)}`) : json({ error: message }, status); }
function browserForm(req) { const type = String(req.headers.get('content-type') || '').toLowerCase(); return type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data'); }
function checkoutOpen(summary) { const expiry = new Date(summary?.addonBundleCheckoutExpiresAt || 0).getTime(); return summary?.addonBundleCheckoutStatus === 'checkout_created' && summary?.addonBundleCheckoutUrl && Number.isFinite(expiry) && expiry > Date.now() + 60_000; }

async function input(req) {
  const type = String(req.headers.get('content-type') || '').toLowerCase();
  let source;
  if (type.includes('application/x-www-form-urlencoded')) source = new URLSearchParams(await req.text());
  else if (type.includes('multipart/form-data')) source = await req.formData();
  else if (type.includes('application/json')) {
    const data = await req.json();
    return { token: String(data?.token || '').trim(), drink: accepted(data?.drinkPackage), water: accepted(data?.waterPackage), late: accepted(data?.lateStay), policy: data?.packagePolicy === true || accepted(data?.packagePolicy) };
  } else return { token: '', drink: false, water: false, late: false, policy: false };
  return { token: String(source.get('token') || '').trim(), drink: accepted(source.get('drink_package')), water: accepted(source.get('water_package')), late: accepted(source.get('late_stay')), policy: accepted(source.get('package_policy')) };
}
async function stripe(path, body, idempotencyKey = '') {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) }, body: new URLSearchParams(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `Stripe returned ${response.status}.`);
  return data;
}
async function stripeSession(sessionId) {
  if (!sessionId) return null;
  const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, { headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `Stripe returned ${response.status}.`);
  return data;
}
async function closePriorBundle(summary) {
  if (summary?.addonBundleCheckoutStatus !== 'checkout_created' || !summary?.addonBundleCheckoutSessionId) return;
  const session = await stripeSession(summary.addonBundleCheckoutSessionId);
  if (session?.payment_status === 'paid' || session?.status === 'complete') throw new Error('Previous add-on checkout may already have completed. Reload your digital ticket before starting another checkout.');
  if (session?.status === 'expired') return;
  if (session?.status !== 'open') throw new Error('Previous add-on checkout status could not be safely replaced. Reload your digital ticket and try again.');
  const expired = await stripe(`checkout/sessions/${encodeURIComponent(summary.addonBundleCheckoutSessionId)}/expire`, {});
  if (expired?.status !== 'expired') throw new Error('Previous add-on checkout could not be closed safely. Reload your digital ticket and try again.');
}
async function claim(store, submissionId, selectionKey) {
  const key = `addon-bundle-checkout-attempt-${submissionId}`;
  const entry = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
  const current = entry?.data || null;
  const started = new Date(current?.startedAt || 0).getTime();
  if (current?.status === 'creating' && Number.isFinite(started) && Date.now() - started < 120_000) return null;
  const reuse = current?.status !== 'completed' && current?.selectionKey === selectionKey && current?.idempotencyKey;
  const attempt = { submissionId, status: 'creating', selectionKey, idempotencyKey: reuse || `nocturne-addon-bundle-${randomBytes(18).toString('hex')}`, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const write = await store.setJSON(key, attempt, entry ? { onlyIfMatch: entry.etag } : { onlyIfNew: true });
  return write.modified ? { key, attempt } : null;
}
async function markClaimFailed(store, checkoutClaim, error) {
  if (!checkoutClaim) return;
  await store.setJSON(checkoutClaim.key, { ...checkoutClaim.attempt, status: 'failed', error: String(error?.message || error || 'checkout_failed').slice(0, 500), updatedAt: new Date().toISOString() }).catch(() => {});
}
function individualPending(summary, prefix) {
  if (summary?.[`${prefix}Purchased`] || summary?.[`${prefix}CheckoutStatus`] !== 'checkout_created') return false;
  const expiry = new Date(summary?.[`${prefix}CheckoutExpiresAt`] || 0).getTime();
  return Boolean(summary?.[`${prefix}CheckoutUrl`] && Number.isFinite(expiry) && expiry > Date.now());
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  if (browserForm(req) && !trustedBrowserSubmission(req)) return redirect('/ticket?addon_error=origin');
  let selection;
  try { selection = await input(req); } catch { return json({ error: 'Checkout selections could not be read.' }, 400); }
  const token = selection.token;
  const parsed = verifyTicketToken(token);
  if (!parsed) return fail(req, token, 'This digital ticket link is invalid.', 400);
  if (!selection.policy) return fail(req, token, 'You must acknowledge that all selected add-ons are FINAL SALE / NON-REFUNDABLE.', 400);
  if (!selection.drink && !selection.water && !selection.late) return fail(req, token, 'Select at least one add-on before checkout.', 400);
  if (!process.env.STRIPE_SECRET_KEY) return fail(req, token, 'Add-on checkout is not available yet.', 503);

  const applicationStore = getStore({ name: APPLICATION_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const key = `submission-${parsed.submissionId}`;
  const [application, review, summaryEntry] = await Promise.all([
    applicationStore.get(parsed.submissionId, { type: 'json', consistency: 'strong' }),
    reviewStore.get(parsed.submissionId, { type: 'json', consistency: 'strong' }),
    orderStore.getWithMetadata(key, { type: 'json', consistency: 'strong' })
  ]);
  const summary = summaryEntry?.data || null;
  if (!application || !summary || summary.status !== 'paid' || summary.ticketId !== parsed.ticketId || !['paid', 'checked_in'].includes(String(review?.ticketState || ''))) return fail(req, token, 'Only an active paid or complimentary ticket can purchase add-ons.', 403);

  const drinkConfig = drinkPackageConfig();
  const waterConfig = waterPackageConfig();
  const lateConfig = lateStayConfig();
  const includeDrink = selection.drink && drinkConfig.enabled && drinkPackageAddonEligible(summary, review, parsed.ticketId);
  const includeWater = selection.water && waterConfig.enabled && waterPackageAddonEligible(summary, review, parsed.ticketId);
  const includeLate = selection.late && lateConfig.enabled && lateStayAddonEligible(summary, review, parsed.ticketId);
  if (selection.drink && !includeDrink) return fail(req, token, 'The Six-Drink Package is already owned, pending, or unavailable for this ticket.', 409);
  if (selection.water && !includeWater) return fail(req, token, 'Unlimited Drinking Water is already owned, pending, or unavailable for this ticket.', 409);
  if (selection.late && !includeLate) return fail(req, token, 'Late Checkout / Car Camping is already owned, pending, or unavailable for this ticket.', 409);
  if ((includeDrink && individualPending(summary, 'drinkPackage')) || (includeWater && individualPending(summary, 'waterPackage')) || (includeLate && individualPending(summary, 'lateStay'))) return fail(req, token, 'One selected add-on already has an open checkout. Resume or let that checkout expire before starting a combined checkout.', 409);

  const selectionKey = [includeDrink ? 'drink' : '', includeWater ? 'water' : '', includeLate ? 'late' : ''].filter(Boolean).join('+');
  if (checkoutOpen(summary) && summary.addonBundleSelectionKey === selectionKey && summary.addonBundleCheckoutSessionId) {
    try {
      const existingSession = await stripeSession(summary.addonBundleCheckoutSessionId);
      if (existingSession?.status === 'open' && existingSession?.payment_status !== 'paid' && existingSession?.url) return browserForm(req) ? redirect(existingSession.url) : json({ ok: true, checkoutUrl: existingSession.url, reused: true });
      if (existingSession?.payment_status === 'paid' || existingSession?.status === 'complete') return fail(req, token, 'Your previous add-on checkout may already be complete. Reload your digital ticket before trying again.', 409);
    } catch (error) {
      console.error('NOCTURNE existing add-on bundle status check failed:', error);
      return fail(req, token, 'Your previous add-on checkout could not be verified safely. Reload your digital ticket and try again.', 503);
    }
  }

  const checkoutClaim = await claim(orderStore, parsed.submissionId, selectionKey);
  if (!checkoutClaim) return fail(req, token, 'Your add-on checkout is already being prepared. Please wait a moment and try again.', 409);

  try {
    await closePriorBundle(summary);
  } catch (error) {
    await markClaimFailed(orderStore, checkoutClaim, error);
    await writeAudit('addon_bundle.checkout_replacement_blocked', { submissionId: parsed.submissionId, ticketId: parsed.ticketId, error: String(error?.message || error) }).catch(() => {});
    return fail(req, token, error?.message || 'Previous add-on checkout could not be safely replaced.', 409);
  }

  let lateTracking = null;
  const stripeExpiresAt = Math.floor(Date.now() / 1000) + 32 * 60;
  if (includeLate) {
    lateTracking = await reserveLateStaySlot({ submissionId: parsed.submissionId, ticketId: parsed.ticketId, expiresAt: new Date((stripeExpiresAt + 120) * 1000).toISOString() });
    if (!lateTracking) {
      const error = new Error('Late Checkout / Car Camping tracking could not be prepared. Please try again.');
      await markClaimFailed(orderStore, checkoutClaim, error);
      await writeAudit('addon_bundle.checkout_failed', { submissionId: parsed.submissionId, ticketId: parsed.ticketId, error: 'late_stay_tracking_unavailable' }).catch(() => {});
      return fail(req, token, error.message, 503);
    }
  }

  const currency = String(process.env.NOCTURNE_TICKET_CURRENCY || 'usd').toLowerCase();
  const params = {
    mode: 'payment', expires_at: String(stripeExpiresAt), success_url: `${siteUrl(req)}/ticket/addons/confirmed?session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${siteUrl(req)}/ticket/addons/confirmed?cancelled=1`, client_reference_id: parsed.submissionId, customer_email: application.email || undefined,
    'metadata[submissionId]': parsed.submissionId, 'metadata[ticketId]': parsed.ticketId, 'metadata[event]': 'NOCTURNE', 'metadata[purchaseType]': 'addon-bundle', 'metadata[packagePolicyAccepted]': 'true',
    'metadata[drinkPackage]': includeDrink ? 'six-credit' : 'none', 'metadata[waterPackage]': includeWater ? 'unlimited' : 'none', 'metadata[lateStay]': includeLate ? 'until-10am' : 'none',
    'metadata[lateStaySlot]': includeLate ? String(lateTracking.slot) : '', 'metadata[lateStayReservationId]': includeLate ? lateTracking.reservationId : '',
    'payment_intent_data[metadata][submissionId]': parsed.submissionId, 'payment_intent_data[metadata][ticketId]': parsed.ticketId, 'payment_intent_data[metadata][event]': 'NOCTURNE', 'payment_intent_data[metadata][purchaseType]': 'addon-bundle'
  };
  if (!params.customer_email) delete params.customer_email;
  let index = 0;
  if (includeDrink) { params[`line_items[${index}][quantity]`] = '1'; params[`line_items[${index}][price_data][currency]`] = currency; params[`line_items[${index}][price_data][unit_amount]`] = String(drinkConfig.priceCents); params[`line_items[${index}][price_data][product_data][name]`] = 'NOCTURNE Six-Drink Package — NON-REFUNDABLE'; params[`line_items[${index}][price_data][product_data][description]`] = 'Six prepaid credits for beer or well cocktails. Premium cocktails require a $5 upgrade. 21+ photo ID required. FINAL SALE / NON-REFUNDABLE.'; index += 1; }
  if (includeWater) { params[`line_items[${index}][quantity]`] = '1'; params[`line_items[${index}][price_data][currency]`] = currency; params[`line_items[${index}][price_data][unit_amount]`] = String(waterConfig.priceCents); params[`line_items[${index}][price_data][product_data][name]`] = 'NOCTURNE Unlimited Drinking Water — NON-REFUNDABLE'; params[`line_items[${index}][price_data][product_data][description]`] = 'Unlimited drinking-water service for the registered ticket holder during festival operating hours. FINAL SALE / NON-REFUNDABLE.'; index += 1; }
  if (includeLate) { params[`line_items[${index}][quantity]`] = '1'; params[`line_items[${index}][price_data][currency]`] = currency; params[`line_items[${index}][price_data][unit_amount]`] = String(lateConfig.priceCents); params[`line_items[${index}][price_data][product_data][name]`] = 'NOCTURNE Late Checkout / Car Camping — NON-REFUNDABLE'; params[`line_items[${index}][price_data][product_data][description]`] = `Stay on the property after the 3:00 AM event end until 10:00 AM. ${LATE_STAY_POLICY_TEXT}`; }
  const total = (includeDrink ? drinkConfig.priceCents : 0) + (includeWater ? waterConfig.priceCents : 0) + (includeLate ? lateConfig.priceCents : 0);

  let createdSessionId = '';
  let createdRecord = null;
  let attached = false;
  try {
    const session = await stripe('checkout/sessions', params, checkoutClaim.attempt.idempotencyKey);
    createdSessionId = String(session.id || '');
    const now = new Date().toISOString();
    const expiresAt = session.expires_at ? new Date(Number(session.expires_at) * 1000).toISOString() : new Date(stripeExpiresAt * 1000).toISOString();
    const record = { purchaseType: 'addon-bundle', submissionId: parsed.submissionId, ticketId: parsed.ticketId, ticketSource: summary.ticketSource || review.ticketSource || null, stripeCheckoutSessionId: session.id, status: 'checkout_created', paymentStatus: session.payment_status || 'unpaid', amountTotal: total, currency, packagePolicyAccepted: true, drinkPackageRequested: includeDrink, drinkPackagePriceCents: includeDrink ? drinkConfig.priceCents : 0, waterPackageRequested: includeWater, waterPackagePriceCents: includeWater ? waterConfig.priceCents : 0, lateStayRequested: includeLate, lateStayPriceCents: includeLate ? lateConfig.priceCents : 0, lateStaySlot: lateTracking?.slot || null, lateStayReservationId: lateTracking?.reservationId || null, lateStayDepartureTime: includeLate ? lateConfig.departureTime : null, checkoutUrl: session.url, checkoutExpiresAt: expiresAt, selectionKey, createdAt: now, updatedAt: now };
    createdRecord = record;
    await orderStore.setJSON(session.id, record);
    const write = await orderStore.setJSON(key, { ...summary, addonBundleCheckoutStatus: 'checkout_created', addonBundleCheckoutSessionId: session.id, addonBundleCheckoutUrl: session.url, addonBundleCheckoutExpiresAt: expiresAt, addonBundleSelectionKey: selectionKey, addonBundleDrinkPackageRequested: includeDrink, addonBundleWaterPackageRequested: includeWater, addonBundleLateStayRequested: includeLate, addonBundleLateStaySlot: lateTracking?.slot || null, addonBundleLateStayReservationId: lateTracking?.reservationId || null, updatedAt: now }, { onlyIfMatch: summaryEntry.etag });
    if (!write.modified) throw new Error('Ticket changed while add-on checkout was being prepared.');
    attached = true;
    await orderStore.setJSON(checkoutClaim.key, { ...checkoutClaim.attempt, status: 'completed', stripeCheckoutSessionId: session.id, checkoutExpiresAt: expiresAt, updatedAt: now });
    await writeAudit('addon_bundle.checkout_created', { submissionId: parsed.submissionId, ticketId: parsed.ticketId, stripeCheckoutSessionId: session.id, drinkPackageRequested: includeDrink, waterPackageRequested: includeWater, lateStayRequested: includeLate, amountTotal: total, ticketSource: summary.ticketSource || review.ticketSource || null });
    return browserForm(req) ? redirect(session.url) : json({ ok: true, checkoutUrl: session.url });
  } catch (error) {
    if (createdSessionId && !attached) {
      await stripe(`checkout/sessions/${encodeURIComponent(createdSessionId)}/expire`, {}).catch(() => {});
      if (createdRecord) await orderStore.setJSON(createdSessionId, { ...createdRecord, status: 'checkout_conflict', checkoutUrl: null, updatedAt: new Date().toISOString() }).catch(() => {});
    }
    if (lateTracking) await releaseLateStayReservation({ slot: lateTracking.slot, reservationId: lateTracking.reservationId, reason: 'addon_bundle_checkout_failed' }).catch(() => {});
    await markClaimFailed(orderStore, checkoutClaim, error);
    await writeAudit('addon_bundle.checkout_failed', { submissionId: parsed.submissionId, ticketId: parsed.ticketId, stripeCheckoutSessionId: createdSessionId || null, error: String(error?.message || error) }).catch(() => {});
    return fail(req, token, 'Add-on checkout could not be started. Please try again.', 502);
  }
};