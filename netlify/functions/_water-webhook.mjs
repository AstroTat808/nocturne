import { getStore } from '@netlify/blobs';
import { reconcileWaterPackageCheckout } from './_water-package.mjs';

const ORDER_STORE = 'nocturne-ticket-orders';
const REVIEW_STORE = 'nocturne-application-reviews';

export async function fulfillStandaloneWater(session) {
  if (!session?.id || session.payment_status !== 'paid') return null;
  const submissionId = String(session.client_reference_id || session.metadata?.submissionId || '').trim();
  const ticketId = String(session.metadata?.ticketId || '').trim();
  if (!submissionId || !ticketId) return null;
  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const key = `submission-${submissionId}`;
  const entry = await orderStore.getWithMetadata(key, { type: 'json', consistency: 'strong' });
  if (!entry?.data || entry.data.ticketId !== ticketId) return null;
  const summary = await reconcileWaterPackageCheckout({ summaryEntry: entry, orderStore, reviewStore });
  if (summary?.waterPackagePurchased && session.payment_intent) {
    await orderStore.setJSON(`payment-intent-${session.payment_intent}`, { submissionId, stripeCheckoutSessionId: session.id, paymentRole: 'water_package_addon', createdAt: new Date().toISOString() });
  }
  return summary;
}
