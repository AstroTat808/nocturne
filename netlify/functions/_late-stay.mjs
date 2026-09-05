import { getStore } from '@netlify/blobs';
import { randomBytes } from 'node:crypto';
import { writeAudit } from './_audit.mjs';

export const LATE_STAY_PRICE_CENTS = 2000;
// Kept as a compatibility export for older imports. Late Stay is no longer capacity-limited.
export const LATE_STAY_CAPACITY = null;
export const LATE_STAY_DEPARTURE = '8:00 AM';
export const LATE_STAY_POLICY_LABEL = 'FINAL SALE / NON-REFUNDABLE';
export const LATE_STAY_POLICY_TEXT = 'The Late Checkout / Car Camping add-on cannot be refunded, exchanged, prorated, transferred, converted to account credit, or redeemed for cash.';
export const LATE_STAY_FORFEITURE_TEXT = 'If the associated admission is canceled, refunded, revoked, or otherwise invalidated, the Late Checkout / Car Camping entitlement is forfeited and remains non-refundable.';

// This store now provides durable checkout tracking only. It no longer enforces a finite inventory.
const CAPACITY_STORE = 'nocturne-late-stay-capacity';

export function lateStayConfig() {
  const configuredPrice = Number(process.env.NOCTURNE_LATE_STAY_PRICE_CENTS || LATE_STAY_PRICE_CENTS);
  return {
    enabled: String(process.env.NOCTURNE_LATE_STAY_ENABLED || 'true').toLowerCase() !== 'false',
    priceCents: Number.isInteger(configuredPrice) && configuredPrice >= 50 ? configuredPrice : LATE_STAY_PRICE_CENTS,
    capacity: null,
    unlimited: true,
    departureTime: LATE_STAY_DEPARTURE
  };
}

export function lateStayAddonEligible(summary, review, ticketId) {
  return Boolean(
    summary
    && review
    && summary.status === 'paid'
    && summary.ticketId === ticketId
    && ['paid', 'checked_in'].includes(String(review.ticketState || ''))
    && !summary.lateStayPurchased
  );
}

function capacityStore() {
  return getStore({ name: CAPACITY_STORE, consistency: 'strong' });
}

function slotKey(slot) {
  return `slot-${String(slot).padStart(3, '0')}`;
}

export async function lateStayAvailability() {
  const config = lateStayConfig();
  if (!config.enabled) return { ...config, sold: 0, reserved: 0, remaining: null, soldOut: true };
  return { ...config, sold: null, reserved: null, remaining: null, soldOut: false };
}

export async function reserveLateStaySlot({ submissionId, ticketId = null, reservationId = '', expiresAt }) {
  const config = lateStayConfig();
  if (!config.enabled) return null;
  const store = capacityStore();
  const id = reservationId || `lsr_${randomBytes(18).toString('base64url')}`;
  const expiry = new Date(expiresAt || Date.now() + 31 * 60 * 1000);
  if (Number.isNaN(expiry.getTime()) || expiry.getTime() <= Date.now()) throw new Error('Late-stay reservation expiration is invalid.');

  // Allocate a random tracking slot instead of consuming one of a finite set.
  // Atomic onlyIfNew writes preserve collision safety and existing reconciliation behavior.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const slot = 1_000_000 + randomBytes(4).readUInt32BE(0);
    const key = slotKey(slot);
    const now = new Date().toISOString();
    const record = {
      slot,
      status: 'reserved',
      reservationId: id,
      submissionId,
      ticketId: ticketId || null,
      reservedAt: now,
      expiresAt: expiry.toISOString(),
      updatedAt: now,
      unlimitedInventory: true
    };
    const write = await store.setJSON(key, record, { onlyIfNew: true }).catch(() => null);
    if (write?.modified) return record;
  }
  return null;
}

export async function releaseLateStayReservation({ slot, reservationId, reason = 'released' }) {
  if (!slot || !reservationId) return false;
  const store = capacityStore();
  const key = slotKey(slot);
  const entry = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' }).catch(() => null);
  if (!entry?.data || entry.data.status !== 'reserved' || entry.data.reservationId !== reservationId) return false;
  const now = new Date().toISOString();
  const write = await store.setJSON(key, { ...entry.data, status: 'released', releasedAt: now, releaseReason: reason, updatedAt: now }, { onlyIfMatch: entry.etag }).catch(() => null);
  return Boolean(write?.modified);
}

export async function markLateStaySold({ slot, reservationId, submissionId, ticketId = null, sessionId, paidAt = new Date().toISOString() }) {
  if (!slot || !reservationId || !submissionId || !sessionId) return false;
  const store = capacityStore();
  const key = slotKey(slot);
  const entry = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' }).catch(() => null);
  const current = entry?.data || null;
  if (!current) return false;
  if (current.status === 'sold') return current.reservationId === reservationId && current.stripeCheckoutSessionId === sessionId;
  if (current.status !== 'reserved' || current.reservationId !== reservationId || current.submissionId !== submissionId) return false;
  const sold = {
    ...current,
    status: 'sold',
    ticketId: ticketId || current.ticketId || null,
    stripeCheckoutSessionId: sessionId,
    paidAt,
    soldAt: paidAt,
    expiresAt: null,
    updatedAt: paidAt,
    unlimitedInventory: true
  };
  const write = await store.setJSON(key, sold, { onlyIfMatch: entry.etag }).catch(() => null);
  return Boolean(write?.modified);
}

export function lateStayFields({ sessionId, paymentIntentId = null, paidAt, priceCents = LATE_STAY_PRICE_CENTS, slot, reservationId, purchaseType = 'addon' }) {
  return {
    lateStayRequested: true,
    lateStayPurchased: true,
    lateStayStatus: 'active',
    lateStayPriceCents: Number(priceCents || LATE_STAY_PRICE_CENTS),
    lateStayPurchaseType: purchaseType,
    lateStayCheckoutStatus: 'paid',
    lateStayCheckoutSessionId: sessionId,
    lateStayPaymentIntentId: paymentIntentId,
    lateStayPaidAt: paidAt,
    lateStaySlot: Number(slot || 0) || null,
    lateStayReservationId: reservationId || null,
    lateStayDepartureTime: LATE_STAY_DEPARTURE,
    lateStayCheckoutUrl: null,
    lateStayCheckoutExpiresAt: null,
    lateStayInvalidatedAt: null,
    lateStayInvalidationReason: null,
    updatedAt: paidAt
  };
}

async function stripeCheckoutSession(sessionId) {
  if (!process.env.STRIPE_SECRET_KEY || !sessionId) return null;
  const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return null;
  return data;
}

async function syncReview(reviewStore, submissionId, fields) {
  if (!reviewStore) return;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const entry = await reviewStore.getWithMetadata(submissionId, { type: 'json', consistency: 'strong' });
    if (!entry?.data) return;
    const write = await reviewStore.setJSON(submissionId, { ...entry.data, ...fields }, { onlyIfMatch: entry.etag });
    if (write.modified) return;
  }
  throw new Error('Guest record changed while late-stay access was being finalized.');
}

export async function reconcileLateStayCheckout({ summaryEntry, orderStore, reviewStore }) {
  const summary = summaryEntry?.data || null;
  if (!summary || summary.lateStayPurchased) return summary;
  if (summary.lateStayCheckoutStatus !== 'checkout_created' || !summary.lateStayCheckoutSessionId) return summary;

  const session = await stripeCheckoutSession(summary.lateStayCheckoutSessionId);
  if (!session || session.payment_status !== 'paid') return summary;
  if (String(session.metadata?.purchaseType || '') !== 'late-stay-addon') return summary;
  if (String(session.metadata?.submissionId || '') !== String(summary.submissionId || '')) return summary;
  if (String(session.metadata?.ticketId || '') !== String(summary.ticketId || '')) return summary;

  const expectedPrice = Number(summary.lateStayPriceCents || lateStayConfig().priceCents);
  if (Number(session.amount_total || 0) !== expectedPrice) throw new Error('Late-stay checkout amount did not match the configured price.');
  const slot = Number(session.metadata?.lateStaySlot || summary.lateStaySlot || 0);
  const reservationId = String(session.metadata?.lateStayReservationId || summary.lateStayReservationId || '');
  if (!slot || !reservationId) throw new Error('Late-stay checkout is missing its tracking reservation.');

  const paidAt = new Date().toISOString();
  const sold = await markLateStaySold({ slot, reservationId, submissionId: summary.submissionId, ticketId: summary.ticketId, sessionId: session.id, paidAt });
  if (!sold) throw new Error('Late-stay checkout tracking reservation could not be finalized.');

  const fields = lateStayFields({ sessionId: session.id, paymentIntentId: session.payment_intent || null, paidAt, priceCents: expectedPrice, slot, reservationId, purchaseType: 'addon' });
  const next = { ...summary, ...fields };
  const write = await orderStore.setJSON(`submission-${summary.submissionId}`, next, { onlyIfMatch: summaryEntry.etag });
  if (!write.modified) {
    const latest = await orderStore.get(`submission-${summary.submissionId}`, { type: 'json', consistency: 'strong' });
    if (latest?.lateStayPurchased && latest.lateStayCheckoutSessionId === session.id) return latest;
    throw new Error('Ticket changed while late-stay access was being finalized.');
  }

  const checkoutOrder = await orderStore.get(session.id, { type: 'json', consistency: 'strong' });
  if (checkoutOrder) await orderStore.setJSON(session.id, { ...checkoutOrder, ...fields, status: 'paid', paymentStatus: session.payment_status, paidAt, updatedAt: paidAt });
  if (session.payment_intent) await orderStore.setJSON(`payment-intent-${session.payment_intent}`, { submissionId: summary.submissionId, stripeCheckoutSessionId: session.id, paymentRole: 'late_stay_addon', createdAt: paidAt });
  await syncReview(reviewStore, summary.submissionId, fields);
  await writeAudit('late_stay.paid', { submissionId: summary.submissionId, ticketId: summary.ticketId, stripeCheckoutSessionId: session.id, stripePaymentIntentId: session.payment_intent || null, amountTotal: expectedPrice, slot, purchaseType: 'addon', unlimitedInventory: true });
  return next;
}
