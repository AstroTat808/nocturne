import { getStore } from '@netlify/blobs';
import { drinkPackageAddonFields } from './_drink-package.mjs';
import { waterPackageAddonFields } from './_water-package.mjs';
import { lateStayFields, markLateStaySold, releaseLateStayReservation } from './_late-stay.mjs';
import { writeAudit } from './_audit.mjs';

const ORDER_STORE = 'nocturne-ticket-orders';
const REVIEW_STORE = 'nocturne-application-reviews';

async function syncReview(reviewStore, submissionId, fields) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const entry = await reviewStore.getWithMetadata(submissionId, { type: 'json', consistency: 'strong' });
    if (!entry?.data) return;
    const write = await reviewStore.setJSON(submissionId, { ...entry.data, ...fields }, { onlyIfMatch: entry.etag });
    if (write.modified) return;
  }
  throw new Error('Guest record changed while add-ons were being finalized.');
}

export async function fulfillAddonBundle(session) {
  if (!session?.id || session.payment_status !== 'paid') return null;
  const submissionId = String(session.client_reference_id || session.metadata?.submissionId || '').trim();
  const ticketId = String(session.metadata?.ticketId || '').trim();
  if (!submissionId || !ticketId) throw new Error('Combined add-on checkout is missing ticket identity.');
  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const [checkoutOrder, summaryEntry, review] = await Promise.all([
    orderStore.get(session.id, { type: 'json', consistency: 'strong' }),
    orderStore.getWithMetadata(`submission-${submissionId}`, { type: 'json', consistency: 'strong' }),
    reviewStore.get(submissionId, { type: 'json', consistency: 'strong' })
  ]);
  const summary = summaryEntry?.data || null;
  if (checkoutOrder?.purchaseType !== 'addon-bundle' || checkoutOrder.ticketId !== ticketId) throw new Error('Combined add-on checkout record was not recognized.');
  if (!summary || summary.status !== 'paid' || summary.ticketId !== ticketId || !['paid', 'checked_in'].includes(String(review?.ticketState || ''))) throw new Error('Admission is not active for this add-on payment.');
  if (Number(session.amount_total || 0) !== Number(checkoutOrder.amountTotal || 0)) throw new Error('Combined add-on checkout amount did not match.');

  const paidAt = new Date().toISOString();
  let fields = {};
  if (checkoutOrder.drinkPackageRequested) {
    if (summary.drinkPackagePurchased && summary.drinkPackageCheckoutSessionId !== session.id) throw new Error('Ticket already has a different Six-Drink Package purchase.');
    fields = { ...fields, ...drinkPackageAddonFields({ sessionId: session.id, paymentIntentId: session.payment_intent || null, paidAt, priceCents: Number(checkoutOrder.drinkPackagePriceCents || 5500) }) };
  }
  if (checkoutOrder.waterPackageRequested) {
    if (summary.waterPackagePurchased && summary.waterPackageCheckoutSessionId !== session.id) throw new Error('Ticket already has a different water-package purchase.');
    fields = { ...fields, ...waterPackageAddonFields({ sessionId: session.id, paymentIntentId: session.payment_intent || null, paidAt, priceCents: Number(checkoutOrder.waterPackagePriceCents || 1500) }) };
  }
  if (checkoutOrder.lateStayRequested) {
    if (summary.lateStayPurchased && summary.lateStayCheckoutSessionId !== session.id) throw new Error('Ticket already has a different Late Stay purchase.');
    const slot = Number(checkoutOrder.lateStaySlot || session.metadata?.lateStaySlot || 0);
    const reservationId = String(checkoutOrder.lateStayReservationId || session.metadata?.lateStayReservationId || '');
    if (!slot || !reservationId) throw new Error('Late Stay tracking information is missing from the combined checkout.');
    const sold = await markLateStaySold({ slot, reservationId, submissionId, ticketId, sessionId: session.id, paidAt });
    if (!sold) throw new Error('Late Stay tracking record could not be finalized.');
    fields = { ...fields, ...lateStayFields({ sessionId: session.id, paymentIntentId: session.payment_intent || null, paidAt, priceCents: Number(checkoutOrder.lateStayPriceCents || 2000), slot, reservationId, purchaseType: 'addon' }) };
  }

  const clear = { addonBundleCheckoutStatus: 'paid', addonBundleCheckoutSessionId: session.id, addonBundleCheckoutUrl: null, addonBundleCheckoutExpiresAt: null, addonBundleSelectionKey: checkoutOrder.selectionKey || null, addonBundlePaymentIntentId: session.payment_intent || null, updatedAt: paidAt };
  const next = { ...summary, ...fields, ...clear };
  const write = await orderStore.setJSON(`submission-${submissionId}`, next, { onlyIfMatch: summaryEntry.etag });
  if (!write.modified) {
    const latest = await orderStore.get(`submission-${submissionId}`, { type: 'json', consistency: 'strong' });
    if (latest?.addonBundleCheckoutSessionId !== session.id || latest?.addonBundleCheckoutStatus !== 'paid') throw new Error('Ticket changed while combined add-ons were being finalized.');
    return latest;
  }
  await orderStore.setJSON(session.id, { ...checkoutOrder, ...fields, status: 'paid', paymentStatus: session.payment_status, stripePaymentIntentId: session.payment_intent || null, paidAt, updatedAt: paidAt });
  if (session.payment_intent) await orderStore.setJSON(`payment-intent-${session.payment_intent}`, { submissionId, stripeCheckoutSessionId: session.id, paymentRole: 'addon_bundle', createdAt: paidAt });
  await syncReview(reviewStore, submissionId, { ...fields, ...clear });
  await writeAudit('addon_bundle.paid', { submissionId, ticketId, stripeCheckoutSessionId: session.id, stripePaymentIntentId: session.payment_intent || null, drinkPackagePurchased: Boolean(checkoutOrder.drinkPackageRequested), waterPackagePurchased: Boolean(checkoutOrder.waterPackageRequested), lateStayPurchased: Boolean(checkoutOrder.lateStayRequested), amountTotal: Number(checkoutOrder.amountTotal || 0) });
  return next;
}

export async function expireAddonBundle(session) {
  const submissionId = String(session?.client_reference_id || session?.metadata?.submissionId || '').trim();
  if (!submissionId || !session?.id) return;
  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const [checkoutOrder, entry] = await Promise.all([
    orderStore.get(session.id, { type: 'json', consistency: 'strong' }),
    orderStore.getWithMetadata(`submission-${submissionId}`, { type: 'json', consistency: 'strong' })
  ]);
  if (checkoutOrder?.purchaseType !== 'addon-bundle') return;
  const now = new Date().toISOString();
  if (checkoutOrder.lateStaySlot && checkoutOrder.lateStayReservationId) await releaseLateStayReservation({ slot: checkoutOrder.lateStaySlot, reservationId: checkoutOrder.lateStayReservationId, reason: 'addon_bundle_checkout_expired' }).catch(() => {});
  await orderStore.setJSON(session.id, { ...checkoutOrder, status: 'checkout_expired', checkoutUrl: null, checkoutExpiredAt: now, updatedAt: now });
  if (entry?.data?.addonBundleCheckoutSessionId === session.id && entry.data.addonBundleCheckoutStatus === 'checkout_created') {
    await orderStore.setJSON(`submission-${submissionId}`, { ...entry.data, addonBundleCheckoutStatus: 'checkout_expired', addonBundleCheckoutUrl: null, addonBundleCheckoutExpiresAt: null, updatedAt: now }, { onlyIfMatch: entry.etag });
  }
  await writeAudit('addon_bundle.checkout_expired', { submissionId, ticketId: checkoutOrder.ticketId || null, stripeCheckoutSessionId: session.id });
}
