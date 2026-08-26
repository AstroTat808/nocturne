import { getStore } from '@netlify/blobs';
import stripeWebhookCore from './stripe-webhook-core.mjs';

const ORDER_STORE = 'nocturne-ticket-orders';
const POLICY_TEXT = 'FINAL SALE / NON-REFUNDABLE: NOCTURNE drink packages cannot be refunded, exchanged, prorated, transferred, converted to account credit, or redeemed for cash, including unused or unredeemed benefits.';
const POLICY_HTML = `<p style="margin:20px 0;color:#ffca61;font-size:12px;line-height:1.7"><strong>FINAL SALE / NON-REFUNDABLE:</strong> NOCTURNE drink packages cannot be refunded, exchanged, prorated, transferred, converted to account credit, or redeemed for cash, including unused or unredeemed benefits.</p>`;

const DUPLICATE_REASONS = new Set(['duplicate', 'existing_active_ticket', 'concurrent_payment', 'existing_drink_package']);
const PAYMENT_ERROR_REASONS = new Set(['amount_mismatch', 'drink_package_amount_mismatch', 'unrecognized_drink_package_checkout']);

function receiptNeedsPolicy(message) {
  const subject = String(message?.subject || '');
  const text = String(message?.text || '');
  if (subject === 'Your NOCTURNE Drink Package Is Confirmed') return true;
  if (subject === 'Your NOCTURNE Ticket Is Confirmed' && /Drink package:/i.test(text)) return true;
  return false;
}

function addPolicy(message) {
  if (!receiptNeedsPolicy(message)) return message;
  const text = String(message.text || '');
  const html = String(message.html || '');
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

export default async (req) => {
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url || '';

    if (url === 'https://api.resend.com/emails' && typeof init?.body === 'string') {
      try {
        const message = JSON.parse(init.body);
        const next = addPolicy(message);
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
    return await stripeWebhookCore(req);
  } finally {
    globalThis.fetch = priorFetch;
  }
};
