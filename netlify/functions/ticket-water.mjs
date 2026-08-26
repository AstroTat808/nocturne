import { getStore } from '@netlify/blobs';
import { verifyTicketToken } from './_ticket-token.mjs';
import { reconcileWaterPackageCheckout, waterPackageAddonEligible, waterPackageConfig } from './_water-package.mjs';

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

  if (!summary.waterPackagePurchased && summary.waterPackageCheckoutStatus === 'checkout_created') {
    summary = await reconcileWaterPackageCheckout({ summaryEntry, orderStore, reviewStore });
    if (summary?.waterPackagePurchased) {
      summaryEntry = await orderStore.getWithMetadata(summaryKey, { type: 'json', consistency: 'strong' });
      review = await reviewStore.get(parsed.submissionId, { type: 'json', consistency: 'strong' });
      summary = summaryEntry?.data || summary;
    }
  }

  const config = waterPackageConfig();
  const available = config.enabled
    && Boolean(process.env.STRIPE_SECRET_KEY)
    && waterPackageAddonEligible(summary, review, parsed.ticketId);
  const amount = config.priceCents / 100;

  return json({
    ok: true,
    purchased: Boolean(summary.waterPackagePurchased),
    status: summary.waterPackageStatus || (summary.waterPackageCheckoutStatus === 'checkout_created' ? 'checkout_created' : 'none'),
    paidAt: summary.waterPackagePaidAt || null,
    priceCents: config.priceCents,
    price: `$${amount.toFixed(0)}`,
    available,
    checkoutPending: summary.waterPackageCheckoutStatus === 'checkout_created' && !summary.waterPackagePurchased
  });
};
