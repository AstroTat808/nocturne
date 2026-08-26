export const DRINK_PACKAGE_CREDITS = 6;
export const DRINK_PACKAGE_PRICE_CENTS = 5500;
export const PREMIUM_UPGRADE_CENTS = 500;

export function drinkPackageConfig() {
  const configuredPrice = Number(process.env.NOCTURNE_DRINK_PACKAGE_PRICE_CENTS || DRINK_PACKAGE_PRICE_CENTS);
  return {
    enabled: String(process.env.NOCTURNE_DRINK_PACKAGE_ENABLED || 'true').toLowerCase() !== 'false',
    priceCents: Number.isInteger(configuredPrice) && configuredPrice >= 50 ? configuredPrice : DRINK_PACKAGE_PRICE_CENTS,
    credits: DRINK_PACKAGE_CREDITS,
    premiumUpgradeCents: PREMIUM_UPGRADE_CENTS,
    rapidWarningMinutes: Math.max(1, Math.min(Number(process.env.NOCTURNE_DRINK_REDEMPTION_WARNING_MINUTES || 45), 180))
  };
}

export function drinkPackageRequested(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

export function initialDrinkPackageFields(purchased, priceCents = DRINK_PACKAGE_PRICE_CENTS) {
  return purchased ? {
    drinkPackagePurchased: true,
    drinkPackageStatus: 'pending_activation',
    drinkPackagePriceCents: priceCents,
    drinkCreditsPurchased: DRINK_PACKAGE_CREDITS,
    drinkCreditsRedeemed: 0,
    drinkCreditsRemaining: DRINK_PACKAGE_CREDITS,
    drinkPackageActivatedAt: null,
    drinkPackageActivatedBy: null,
    drinkPackageWristbandHash: null,
    drinkPackageLastRedeemedAt: null,
    drinkPackageLastRedeemedBy: null
  } : {
    drinkPackagePurchased: false,
    drinkPackageStatus: 'none',
    drinkPackagePriceCents: 0,
    drinkCreditsPurchased: 0,
    drinkCreditsRedeemed: 0,
    drinkCreditsRemaining: 0
  };
}

export function drinkPackageAddonEligible(summary, review, ticketId) {
  return Boolean(
    summary
    && review
    && summary.status === 'paid'
    && summary.ticketId === ticketId
    && ['paid', 'checked_in'].includes(review.ticketState)
    && !summary.drinkPackagePurchased
  );
}

export function drinkPackageAddonFields({ sessionId, paymentIntentId = null, paidAt, priceCents = DRINK_PACKAGE_PRICE_CENTS }) {
  return {
    ...initialDrinkPackageFields(true, priceCents),
    drinkPackagePurchaseType: 'addon',
    drinkPackageCheckoutStatus: 'paid',
    drinkPackageCheckoutSessionId: sessionId,
    drinkPackagePaymentIntentId: paymentIntentId,
    drinkPackagePaidAt: paidAt,
    drinkPackageCheckoutUrl: null,
    drinkPackageCheckoutExpiresAt: null,
    drinkPackageInvalidatedAt: null,
    drinkPackageInvalidationReason: null,
    updatedAt: paidAt
  };
}

export function invalidateDrinkPackage(record = {}, reason = 'cancelled') {
  if (!record.drinkPackagePurchased) return {};
  return {
    drinkPackageStatus: reason,
    drinkPackageInvalidatedAt: new Date().toISOString(),
    drinkPackageInvalidationReason: reason
  };
}
