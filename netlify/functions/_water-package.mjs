import { writeAudit } from './_audit.mjs';

export const WATER_PACKAGE_PRICE_CENTS = 1500;

export function waterPackageConfig() {
  const configuredPrice = Number(process.env.NOCTURNE_WATER_PACKAGE_PRICE_CENTS || WATER_PACKAGE_PRICE_CENTS);
  return {
    enabled: String(process.env.NOCTURNE_WATER_PACKAGE_ENABLED || 'true').toLowerCase() !== 'false',
    priceCents: Number.isInteger(configuredPrice) && configuredPrice >= 50 ? configuredPrice : WATER_PACKAGE_PRICE_CENTS
  };
}

export function waterPackageAddonEligible(summary, review, ticketId) {
  return Boolean(
    summary
    && review
    && summary.status === 'paid'
    && summary.ticketId === ticketId
    && ['paid', 'checked_in'].includes(review.ticketState)
    && !summary.waterPackagePurchased
  );
}

export function waterPackageAddonFields({ sessionId, paymentIntentId = null, paidAt, priceCents = WATER_PACKAGE_PRICE_CENTS }) {
  return {
    waterPackagePurchased: true,
    waterPackageStatus: 'active',
    waterPackagePriceCents: priceCents,
    waterPackagePurchaseType: 'addon',
    waterPackageCheckoutStatus: 'paid',
    waterPackageCheckoutSessionId: sessionId,
    waterPackagePaymentIntentId: paymentIntentId,
    waterPackagePaidAt: paidAt,
    waterPackageCheckoutUrl: null,
    waterPackageCheckoutExpiresAt: null,
    waterPackageInvalidatedAt: null,
    waterPackageInvalidationReason: null,
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

export async function reconcileWaterPackageCheckout({ summaryEntry, orderStore, reviewStore }) {
  const summary = summaryEntry?.data || null;
  if (!summary || summary.waterPackagePurchased) return summary;
  if (summary.waterPackageCheckoutStatus !== 'checkout_created' || !summary.waterPackageCheckoutSessionId) return summary;

  const session = await stripeCheckoutSession(summary.waterPackageCheckoutSessionId);
  if (!session || session.payment_status !== 'paid') return summary;
  if (String(session.metadata?.purchaseType || '') !== 'water-package-addon') return summary;
  if (String(session.metadata?.submissionId || '') !== String(summary.submissionId || '')) return summary;
  if (String(session.metadata?.ticketId || '') !== String(summary.ticketId || '')) return summary;

  const expectedPrice = Number(summary.waterPackagePriceCents || waterPackageConfig().priceCents);
  if (Number(session.amount_total || 0) !== expectedPrice) return summary;

  const paidAt = new Date().toISOString();
  const fields = waterPackageAddonFields({
    sessionId: session.id,
    paymentIntentId: session.payment_intent || null,
    paidAt,
    priceCents: expectedPrice
  });
  const next = { ...summary, ...fields };
  const write = await orderStore.setJSON(`submission-${summary.submissionId}`, next, { onlyIfMatch: summaryEntry.etag });
  if (!write.modified) {
    return orderStore.get(`submission-${summary.submissionId}`, { type: 'json', consistency: 'strong' });
  }

  const checkoutOrder = await orderStore.get(session.id, { type: 'json', consistency: 'strong' });
  if (checkoutOrder) {
    await orderStore.setJSON(session.id, {
      ...checkoutOrder,
      status: 'paid',
      paymentStatus: session.payment_status,
      waterPackagePaymentIntentId: session.payment_intent || null,
      paidAt,
      updatedAt: paidAt
    });
  }

  await writeAudit('water_package.paid', { submissionId: summary.submissionId, ticketId: summary.ticketId, stripeCheckoutSessionId: session.id, stripePaymentIntentId: session.payment_intent || null, amountTotal: expectedPrice });

  if (reviewStore) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const reviewEntry = await reviewStore.getWithMetadata(summary.submissionId, { type: 'json', consistency: 'strong' });
      if (!reviewEntry?.data) break;
      const reviewWrite = await reviewStore.setJSON(summary.submissionId, { ...reviewEntry.data, ...fields }, { onlyIfMatch: reviewEntry.etag });
      if (reviewWrite.modified) break;
    }
  }

  return next;
}
