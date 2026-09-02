import { ticketPricing } from './_ticket-pricing.mjs';

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method not allowed.', { status: 405 });
  const pricing = ticketPricing();
  const currency = String(process.env.NOCTURNE_TICKET_CURRENCY || 'usd').toUpperCase();
  return Response.json({
    priceCents: pricing.priceCents,
    beforeCents: pricing.beforeCents,
    afterCents: pricing.afterCents,
    changed: pricing.changed,
    changeAt: pricing.changeAt,
    timezone: pricing.timezone,
    currency,
    displayPrice: `$${(pricing.priceCents / 100).toFixed(0)}`,
    beforeDisplayPrice: `$${(pricing.beforeCents / 100).toFixed(0)}`,
    afterDisplayPrice: `$${(pricing.afterCents / 100).toFixed(0)}`
  }, { headers: { 'Cache-Control': 'no-store, max-age=0' } });
};
