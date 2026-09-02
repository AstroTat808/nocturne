import { getStore } from '@netlify/blobs';
import { writeAudit } from './_audit.mjs';
import { releaseLateStayReservation } from './_late-stay.mjs';
import { ticketPricing } from './_ticket-pricing.mjs';

const ORDER_STORE = 'nocturne-ticket-orders';
const MARKER_KEY = 'ticket-price-cutover-2026-09-02';

async function expireStripeSession(sessionId) {
  if (!sessionId || !process.env.STRIPE_SECRET_KEY) return false;
  const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}/expire`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams()
  });
  if (response.ok) return true;
  const data = await response.json().catch(() => ({}));
  const message = String(data?.error?.message || '');
  return /already expired|not in an expireable state|complete/i.test(message);
}

export default async () => {
  const pricing = ticketPricing();
  const now = new Date();
  if (!pricing.changed || now.getUTCFullYear() !== 2026 || now.getUTCMonth() !== 8 || now.getUTCDate() !== 2) {
    return Response.json({ ok: true, skipped: true, reason: 'outside_cutover_window', currentPriceCents: pricing.priceCents });
  }

  const store = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const existingMarker = await store.get(MARKER_KEY, { type: 'json', consistency: 'strong' });
  if (existingMarker?.status === 'completed') return Response.json({ ok: true, duplicate: true, ...existingMarker });

  const markerWrite = await store.setJSON(MARKER_KEY, { status: 'running', startedAt: now.toISOString() }, { onlyIfNew: true });
  if (!markerWrite.modified && existingMarker?.status === 'running') return Response.json({ ok: true, duplicate: true, status: 'running' });

  const { blobs } = await store.list();
  let scanned = 0;
  let expired = 0;
  let failed = 0;
  const currentPrice = pricing.priceCents;

  for (const { key } of blobs) {
    if (!key.startsWith('submission-')) continue;
    const entry = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
    const summary = entry?.data || null;
    if (!summary || summary.status !== 'checkout_created' || !summary.stripeCheckoutSessionId) continue;
    const ticketAmount = Number(summary.ticketAmount || 0);
    if (!ticketAmount || ticketAmount >= currentPrice) continue;
    scanned += 1;

    try {
      const stripeExpired = await expireStripeSession(summary.stripeCheckoutSessionId);
      if (!stripeExpired) throw new Error('Stripe checkout session could not be expired.');
      if (summary.lateStaySlot && summary.lateStayReservationId) {
        await releaseLateStayReservation({ slot: summary.lateStaySlot, reservationId: summary.lateStayReservationId, reason: 'ticket_price_cutover' }).catch(() => {});
      }
      const changedAt = new Date().toISOString();
      const write = await store.setJSON(key, {
        ...summary,
        status: 'checkout_expired',
        checkoutExpiredAt: changedAt,
        checkoutUrl: null,
        ticketPriceCutoverExpired: true,
        ticketPriceCutoverFromCents: ticketAmount,
        ticketPriceCutoverToCents: currentPrice,
        updatedAt: changedAt
      }, { onlyIfMatch: entry.etag });
      if (write.modified) expired += 1;
      else failed += 1;
    } catch (error) {
      failed += 1;
      console.error('NOCTURNE ticket-price cutover failed for', key, error);
    }
  }

  const completedAt = new Date().toISOString();
  const result = { status: 'completed', completedAt, currentPriceCents: currentPrice, scanned, expired, failed };
  await store.setJSON(MARKER_KEY, result);
  await writeAudit('ticket_price.cutover', result).catch(() => {});
  return Response.json({ ok: failed === 0, ...result }, { status: failed === 0 ? 200 : 207 });
};

export const config = { schedule: '0 10 2 9 *' };
