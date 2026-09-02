import { getStore } from '@netlify/blobs';
import { verifyTicketToken } from './_ticket-token.mjs';
import { lateStayAddonEligible, lateStayAvailability, reconcileLateStayCheckout } from './_late-stay.mjs';

const ORDER_STORE = 'nocturne-ticket-orders';
const REVIEW_STORE = 'nocturne-application-reviews';

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
      'Referrer-Policy': 'no-referrer'
    }
  });
}

export default async (req) => {
  if (req.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
  const token = String(new URL(req.url).searchParams.get('token') || '').trim();
  const parsed = verifyTicketToken(token);
  if (!parsed) return json({ error: 'Invalid digital ticket.' }, 400);

  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const summaryKey = `submission-${parsed.submissionId}`;
  let [summaryEntry, review] = await Promise.all([
    orderStore.getWithMetadata(summaryKey, { type: 'json', consistency: 'strong' }),
    reviewStore.get(parsed.submissionId, { type: 'json', consistency: 'strong' })
  ]);
  let summary = summaryEntry?.data || null;

  if (!summary || summary.status !== 'paid' || summary.ticketId !== parsed.ticketId || !['paid', 'checked_in'].includes(String(review?.ticketState || ''))) {
    return json({ error: 'This ticket is not active.' }, 403);
  }

  if (!summary.lateStayPurchased && summary.lateStayCheckoutStatus === 'checkout_created') {
    summary = await reconcileLateStayCheckout({ summaryEntry, orderStore, reviewStore }).catch(() => summary);
    summaryEntry = await orderStore.getWithMetadata(summaryKey, { type: 'json', consistency: 'strong' });
    review = await reviewStore.get(parsed.submissionId, { type: 'json', consistency: 'strong' });
    summary = summaryEntry?.data || summary;
  }

  const availability = await lateStayAvailability();
  const available = !availability.soldOut && lateStayAddonEligible(summary, review, parsed.ticketId) && Boolean(process.env.STRIPE_SECRET_KEY);

  return json({
    ok: true,
    purchased: Boolean(summary.lateStayPurchased),
    status: summary.lateStayStatus || (summary.lateStayCheckoutStatus === 'checkout_created' ? 'checkout_created' : 'none'),
    paidAt: summary.lateStayPaidAt || null,
    slot: summary.lateStaySlot || null,
    departureTime: summary.lateStayDepartureTime || availability.departureTime,
    priceCents: availability.priceCents,
    price: `$${(availability.priceCents / 100).toFixed(0)}`,
    capacity: availability.capacity,
    sold: availability.sold,
    reserved: availability.reserved,
    remaining: availability.remaining,
    soldOut: availability.soldOut,
    available,
    checkoutPending: summary.lateStayCheckoutStatus === 'checkout_created' && !summary.lateStayPurchased
  });
};
