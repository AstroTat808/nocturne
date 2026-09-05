const DAILY_REMINDER_PAUSE_DATES_HST = new Set(['2026-09-05']);

export function honoluluDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Pacific/Honolulu', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function dailyRemindersPaused(date = new Date()) {
  return DAILY_REMINDER_PAUSE_DATES_HST.has(honoluluDate(date));
}

export function eligibleForPurchaseReminderTest(review, summary) {
  if (!review || review.status !== 'approved' || review.inviteState !== 'redeemed') return false;
  const state = String(review.ticketState || 'none').toLowerCase();
  const orderStatus = String(summary?.status || summary?.state || 'none').toLowerCase();
  if (!['none', 'checkout_created', 'checkout_expired'].includes(state)) return false;
  if (!['none', 'checkout_created', 'checkout_expired'].includes(orderStatus)) return false;
  if (review.ticketId || summary?.ticketId || review.stripePaymentIntentId || summary?.stripePaymentIntentId) return false;
  if (review.checkedInAt || summary?.checkedInAt || review.stripeRefundId || summary?.stripeRefundId) return false;
  return true;
}

export function eligibleForPurchaseReminder(review, summary, now = Date.now()) {
  if (!eligibleForPurchaseReminderTest(review, summary)) return false;
  const redeemedAt = new Date(review.inviteRedeemedAt || 0).getTime();
  const minimumHours = Math.max(1, Number(process.env.NOCTURNE_PURCHASE_REMINDER_MIN_HOURS || 20));
  return Number.isFinite(redeemedAt) && redeemedAt > 0 && now - redeemedAt >= minimumHours * 60 * 60 * 1000;
}

export function beforeEvent(now = Date.now()) {
  const cutoff = new Date(process.env.NOCTURNE_EVENT_START_ISO || '2026-09-06T15:00:00-10:00').getTime();
  return !Number.isFinite(cutoff) || now < cutoff;
}
