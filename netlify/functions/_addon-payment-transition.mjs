import { getStore } from '@netlify/blobs';
import { writeAudit } from './_audit.mjs';

const ORDER_STORE = 'nocturne-ticket-orders';
const REVIEW_STORE = 'nocturne-application-reviews';
const ADDON_ROLES = new Set(['drink_package_addon','water_package_addon','late_stay_addon','addon_bundle']);

function paymentIntentFromEvent(event) {
  const object = event?.data?.object || {};
  if (event?.type === 'refund.updated') return String(object.payment_intent || '');
  if (String(event?.type || '').startsWith('charge.')) return String(object.payment_intent || '');
  return '';
}
function transitionFromEvent(event) {
  const object = event?.data?.object || {};
  if (event.type === 'charge.refunded' && (object.refunded || Number(object.amount_refunded || 0) >= Number(object.amount || 0))) return 'refunded';
  if (event.type === 'refund.updated' && object.status === 'succeeded') return 'refunded';
  if (event.type === 'charge.dispute.created') return 'disputed';
  if (event.type === 'charge.dispute.closed') return object.status === 'won' ? 'dispute_won' : 'disputed';
  return '';
}
function addonPatch(prefix, purchased, state, summary) {
  if (!purchased) return {};
  const statusKey = `${prefix}Status`;
  const checkoutKey = `${prefix}CheckoutStatus`;
  if (state === 'dispute_won') {
    const restored = prefix === 'drinkPackage'
      ? (Number(summary.drinkCreditsRemaining || 0) <= 0 ? 'exhausted' : summary.drinkPackageWristbandHash ? 'active' : 'pending_activation')
      : 'active';
    return { [statusKey]: restored, [checkoutKey]: 'paid', [`${prefix}InvalidatedAt`]: null, [`${prefix}InvalidationReason`]: null, [`${prefix}DisputedAt`]: null };
  }
  const now = new Date().toISOString();
  return { [statusKey]: state, [checkoutKey]: state, [`${prefix}InvalidatedAt`]: now, [`${prefix}InvalidationReason`]: state, ...(state === 'refunded' ? { [`${prefix}RefundedAt`]: now } : { [`${prefix}DisputedAt`]: now }) };
}

export async function handleAddonPaymentTransition(event) {
  const state = transitionFromEvent(event);
  if (!state) return false;
  const paymentIntentId = paymentIntentFromEvent(event);
  if (!paymentIntentId) return false;
  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const alias = await orderStore.get(`payment-intent-${paymentIntentId}`, { type: 'json', consistency: 'strong' });
  if (!alias?.submissionId || !ADDON_ROLES.has(alias.paymentRole)) return false;
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const summaryKey = `submission-${alias.submissionId}`;
  const [entry, checkoutOrder, review] = await Promise.all([
    orderStore.getWithMetadata(summaryKey, { type: 'json', consistency: 'strong' }),
    orderStore.get(alias.stripeCheckoutSessionId, { type: 'json', consistency: 'strong' }),
    reviewStore.get(alias.submissionId, { type: 'json', consistency: 'strong' })
  ]);
  const summary = entry?.data || null;
  if (!summary) return true;
  const role = alias.paymentRole;
  let patch = {};
  if (role === 'drink_package_addon' || role === 'addon_bundle' && checkoutOrder?.drinkPackageRequested) patch = { ...patch, ...addonPatch('drinkPackage', summary.drinkPackagePurchased, state, summary) };
  if (role === 'water_package_addon' || role === 'addon_bundle' && checkoutOrder?.waterPackageRequested) patch = { ...patch, ...addonPatch('waterPackage', summary.waterPackagePurchased, state, summary) };
  if (role === 'late_stay_addon' || role === 'addon_bundle' && checkoutOrder?.lateStayRequested) patch = { ...patch, ...addonPatch('lateStay', summary.lateStayPurchased, state, summary) };
  const now = new Date().toISOString();
  patch.updatedAt = now;
  const write = await orderStore.setJSON(summaryKey, { ...summary, ...patch }, { onlyIfMatch: entry.etag });
  if (!write.modified) throw new Error('Ticket changed during add-on payment transition.');
  if (checkoutOrder) await orderStore.setJSON(alias.stripeCheckoutSessionId, { ...checkoutOrder, status: state === 'dispute_won' ? 'paid' : state, ...patch });
  if (review) await reviewStore.setJSON(alias.submissionId, { ...review, ...patch });
  await writeAudit(`addon.payment_${state}`, { submissionId: alias.submissionId, ticketId: summary.ticketId || null, stripePaymentIntentId: paymentIntentId, paymentRole: role });
  return true;
}
