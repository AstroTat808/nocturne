export const DEFAULT_TICKET_PRICE_CENTS = 2500;
export const DEFAULT_TICKET_PRICE_AFTER_CENTS = 3500;
export const DEFAULT_TICKET_PRICE_CHANGE_ISO = '2026-09-02T00:00:00-10:00';

function cents(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 50 ? parsed : fallback;
}

function validDate(value, fallback) {
  const parsed = new Date(value || fallback);
  return Number.isNaN(parsed.getTime()) ? new Date(fallback) : parsed;
}

export function ticketPricing(at = new Date()) {
  const beforeCents = cents(process.env.NOCTURNE_TICKET_PRICE_CENTS, DEFAULT_TICKET_PRICE_CENTS);
  const afterCents = cents(process.env.NOCTURNE_TICKET_PRICE_AFTER_CENTS, DEFAULT_TICKET_PRICE_AFTER_CENTS);
  const changeAt = validDate(process.env.NOCTURNE_TICKET_PRICE_CHANGE_ISO, DEFAULT_TICKET_PRICE_CHANGE_ISO);
  const now = at instanceof Date ? at : new Date(at);
  const effectiveAt = Number.isNaN(now.getTime()) ? new Date() : now;
  const changed = effectiveAt.getTime() >= changeAt.getTime();

  return {
    priceCents: changed ? afterCents : beforeCents,
    beforeCents,
    afterCents,
    changed,
    changeAt: changeAt.toISOString(),
    changeAtEpochMs: changeAt.getTime(),
    timezone: 'Pacific/Honolulu'
  };
}

export function ticketPriceLabel(at = new Date()) {
  const pricing = ticketPricing(at);
  const currency = String(process.env.NOCTURNE_TICKET_CURRENCY || 'usd').toUpperCase();
  return `${currency} ${(pricing.priceCents / 100).toFixed(2)}`;
}
