import { getStore } from '@netlify/blobs';
import stripeWebhookCore from './stripe-webhook-core.mjs';
import { writeAudit } from './_audit.mjs';

const ORDER_STORE = 'nocturne-ticket-orders';
const REVIEW_STORE = 'nocturne-application-reviews';
const POLICY_TEXT = 'FINAL SALE / NON-REFUNDABLE: NOCTURNE drink packages cannot be refunded, exchanged, prorated, transferred, converted to account credit, or redeemed for cash, including unused or unredeemed benefits.';
const POLICY_HTML = `<p style="margin:20px 0;color:#ffca61;font-size:12px;line-height:1.7"><strong>FINAL SALE / NON-REFUNDABLE:</strong> NOCTURNE drink packages cannot be refunded, exchanged, prorated, transferred, converted to account credit, or redeemed for cash, including unused or unredeemed benefits.</p>`;
const WATER_TEXT = 'Water package: Unlimited Drinking Water for the registered ticket holder during festival operating hours.';
const WATER_HTML = '<br><strong>Water package:</strong> Unlimited Drinking Water · registered ticket holder only';

const DUPLICATE_REASONS = new Set(['duplicate', 'existing_active_ticket', 'concurrent_payment', 'existing_drink_package']);
const PAYMENT_ERROR_REASONS = new Set(['amount_mismatch', 'drink_package_amount_mismatch', 'unrecognized_drink_package_checkout']);

function receiptNeedsPolicy(message, bundledWater = false) {
  const subject = String(message?.subject || '');
  const text = String(message?.text || '');
  if (subject === 'Your NOCTURNE Drink Package Is Confirmed') return true;
  if (subject === 'Your NOCTURNE Ticket Is Confirmed' && (/Drink package:/i.test(text) || bundledWater)) return true;
  return false;
}

function addPolicy(message, bundledWater = false) {
  if (!receiptNeedsPolicy(message, bundledWater)) return message;
  let text = String(message.text || '');
  let html = String(message.html || '');
  if (bundledWater && message?.subject === 'Your NOCTURNE Ticket Is Confirmed') {
    if (!text.includes(WATER_TEXT)) text = `${text}\n${WATER_TEXT}`;
    if (!html.includes('Water package:')) html = html.replace('</div>', `${WATER_HTML}</div>`);
  }
  return {
    ...message,
    text: text.includes('FINAL SALE / NON-REFUNDABLE') ? text : `${text}\n\n${POLICY_TEXT}`,
    html: html.includes('FINAL SALE / NON-REFUNDABLE') ? html : html.replace('</div></div></body></html>', `${POLICY_HTML}</div></div></body></html>`)
  };
}

function automaticReason(code = '') {
  const clean = String(code || 'automatic_protection').trim();
  if (DUPLICATE_REASONS.has(clean)) return { reason: 'duplicate_purchase', reasonLabel: 'Duplicate purchase' };
  if (PAYMENT_ERROR_REASONS.has(clean)) return { reason: 'payment_error', reasonLabel: 'Payment / checkout error' };
  return { reason: 'automatic_protection', reasonLabel: 'Automatic payment protection' };
}

async function recordAutomaticRefund(params, refund) {
  const submissionId = String(params.get('metadata[submissionId]') || '').trim();
  const trigger = String(params.get('metadata[automaticReason]') || '').trim();
  if (!submissionId || !trigger || !refund?.id) return;

  const store = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const key = `submission-${submissionId}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const entry = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' }).catch(() => null);
    if (!entry?.data) return;
    const history = Array.isArray(entry.data.refundHistory) ? entry.data.refundHistory.filter(Boolean) : [];
    if (history.some((item) => item?.stripeRefundId === refund.id)) return;
    const mapped = automaticReason(trigger);
    const now = new Date().toISOString();
    history.push({
      id: `refund-${refund.id}`,
      type: 'automatic_refund',
      label: 'Automatic payment refund',
      amountCents: Number(refund.amount || 0),
      currency: refund.currency || entry.data.currency || 'usd',
      stripeRefundId: refund.id,
      paymentIntentId: refund.payment_intent || params.get('payment_intent') || null,
      date: now,
      status: refund.status || 'submitted',
      initiatedBy: 'NOCTURNE system',
      source: 'automatic_payment_protection',
      action: trigger,
      reason: mapped.reason,
      reasonLabel: mapped.reasonLabel,
      notes: `Automatically refunded by payment protection. Trigger: ${trigger.replaceAll('_', ' ')}.`
    });
    const result = await store.setJSON(key, { ...entry.data, refundHistory: history, updatedAt: now }, { onlyIfMatch: entry.etag }).catch(() => null);
    if (result?.modified) return;
  }
}

function bundledWaterEvent(event) {
  const session = event?.data?.object || {};
  return Boolean(
    ['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(String(event?.type || ''))
    && session?.payment_status === 'paid'
    && String(session?.metadata?.purchaseType || '') !== 'water-package-addon'
    && String(session?.metadata?.waterPackage || '') === 'unlimited'
  );
}

async function fulfillBundledWater(event) {
  if (!bundledWaterEvent(event)) return;
  const session = event.data.object;
  const submissionId = String(session.client_reference_id || session.metadata?.submissionId || '').trim();
  if (!submissionId || !session.id) return;
  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const sessionOrder = await orderStore.get(session.id, { type: 'json', consistency: 'strong' });
  if (!sessionOrder || sessionOrder.status !== 'paid' || !sessionOrder.waterPackageRequested) throw new Error('Bundled water checkout record is unavailable after ticket payment.');
  const paidAt = sessionOrder.paidAt || new Date().toISOString();
  const fields = {
    waterPackageRequested: true,
    waterPackagePolicyAccepted: true,
    waterPackagePurchased: true,
    waterPackageStatus: 'active',
    waterPackagePriceCents: Number(sessionOrder.waterPackagePriceCents || 1500),
    waterPackagePurchaseType: 'bundled',
    waterPackageCheckoutStatus: 'paid',
    waterPackageCheckoutSessionId: session.id,
    waterPackagePaymentIntentId: session.payment_intent || sessionOrder.stripePaymentIntentId || null,
    waterPackagePaidAt: paidAt,
    waterPackageCheckoutUrl: null,
    waterPackageCheckoutExpiresAt: null,
    waterPackageInvalidatedAt: null,
    waterPackageInvalidationReason: null
  };

  await orderStore.setJSON(session.id, { ...sessionOrder, ...fields, updatedAt: new Date().toISOString() });
  const summaryKey = `submission-${submissionId}`;
  let summaryUpdated = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const entry = await orderStore.getWithMetadata(summaryKey, { type: 'json', consistency: 'strong' });
    if (!entry?.data || entry.data.stripeCheckoutSessionId !== session.id || entry.data.status !== 'paid') break;
    if (entry.data.waterPackagePurchased) { summaryUpdated = true; break; }
    const write = await orderStore.setJSON(summaryKey, { ...entry.data, ...fields, updatedAt: new Date().toISOString() }, { onlyIfMatch: entry.etag });
    if (write.modified) { summaryUpdated = true; break; }
  }
  if (!summaryUpdated) throw new Error('Bundled water entitlement could not be written to the ticket summary.');

  let reviewUpdated = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const entry = await reviewStore.getWithMetadata(submissionId, { type: 'json', consistency: 'strong' });
    if (!entry?.data) break;
    if (entry.data.waterPackagePurchased && entry.data.waterPackageCheckoutSessionId === session.id) { reviewUpdated = true; break; }
    const write = await reviewStore.setJSON(submissionId, { ...entry.data, ...fields, updatedAt: new Date().toISOString() }, { onlyIfMatch: entry.etag });
    if (write.modified) { reviewUpdated = true; break; }
  }
  if (!reviewUpdated) throw new Error('Bundled water entitlement could not be synchronized to the guest review record.');

  await writeAudit('water_package.paid', { submissionId, ticketId: sessionOrder.ticketId || null, stripeCheckoutSessionId: session.id, stripePaymentIntentId: session.payment_intent || null, amountTotal: Number(sessionOrder.waterPackagePriceCents || 1500), purchaseType: 'bundled' });
}

export default async (req) => {
  let event = null;
  try { event = JSON.parse(await req.clone().text()); } catch {}
  const bundledWater = bundledWaterEvent(event);
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url || '';

    if (url === 'https://api.resend.com/emails' && typeof init?.body === 'string') {
      try {
        const message = JSON.parse(init.body);
        const next = addPolicy(message, bundledWater);
        if (next !== message || next.text !== message.text || next.html !== message.html) init = { ...init, body: JSON.stringify(next) };
      } catch {}
    }

    const isRefund = url === 'https://api.stripe.com/v1/refunds';
    let refundParams = null;
    if (isRefund && init?.body instanceof URLSearchParams && init.body.get('metadata[automaticReason]')) refundParams = new URLSearchParams(init.body);

    const response = await priorFetch(input, init);
    if (refundParams && response.ok) {
      try {
        const refund = await response.clone().json();
        await recordAutomaticRefund(refundParams, refund);
      } catch (error) {
        console.error('NOCTURNE automatic refund history write failed:', error);
      }
    }
    return response;
  };

  try {
    const response = await stripeWebhookCore(req);
    if (response.ok && bundledWater) await fulfillBundledWater(event);
    return response;
  } finally {
    globalThis.fetch = priorFetch;
  }
};
