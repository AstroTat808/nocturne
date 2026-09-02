import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { ticketPricing } from '../netlify/functions/_ticket-pricing.mjs';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const has = (source, value, message) => check(source.includes(value), message);

const oldEnv = {
  before: process.env.NOCTURNE_TICKET_PRICE_CENTS,
  after: process.env.NOCTURNE_TICKET_PRICE_AFTER_CENTS,
  change: process.env.NOCTURNE_TICKET_PRICE_CHANGE_ISO
};
process.env.NOCTURNE_TICKET_PRICE_CENTS = '2500';
process.env.NOCTURNE_TICKET_PRICE_AFTER_CENTS = '3500';
process.env.NOCTURNE_TICKET_PRICE_CHANGE_ISO = '2026-09-02T00:00:00-10:00';

const before = ticketPricing(new Date('2026-09-01T23:59:59-10:00'));
const at = ticketPricing(new Date('2026-09-02T00:00:00-10:00'));
const after = ticketPricing(new Date('2026-09-02T00:00:01-10:00'));
check(before.priceCents === 2500 && before.changed === false, 'Admission must remain $25 immediately before midnight HST.');
check(at.priceCents === 3500 && at.changed === true, 'Admission must become $35 exactly at midnight HST Sept. 2.');
check(after.priceCents === 3500, 'Admission must remain $35 after the cutoff.');

for (const [key, value] of Object.entries({ NOCTURNE_TICKET_PRICE_CENTS: oldEnv.before, NOCTURNE_TICKET_PRICE_AFTER_CENTS: oldEnv.after, NOCTURNE_TICKET_PRICE_CHANGE_ISO: oldEnv.change })) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}

const checkout = read('netlify/functions/create-checkout.mjs');
const access = read('netlify/functions/ticket-access.mjs');
const reminder = read('netlify/functions/_purchase-reminder-email.mjs');
const cutover = read('netlify/functions/ticket-price-cutover.mjs');
const api = read('netlify/functions/ticket-pricing.mjs');
const netlify = read('netlify.toml');
const env = read('.env.example');
const publicPricing = read('site/assets/js/public-ticket-pricing.js');
const publicInjector = read('scripts/inject-public-ticket-pricing.mjs');
const publicOffersCss = read('site/assets/css/public-offers.css');

has(checkout, "from './_ticket-pricing.mjs'", 'Stripe checkout must use centralized ticket pricing.');
has(checkout, '`price-${unitAmount}`', 'Checkout idempotency must include the current ticket price.');
has(checkout, 'Number(summary.ticketAmount || 0) !== Number(ticketAmount || 0)', 'Old-price open checkout sessions must not be reused after the cutoff.');
has(checkout, "'metadata[ticketAmount]'", 'Stripe checkout must record the admission price in metadata.');
has(checkout, 'pricing.changeAtEpochMs', 'Pre-cutoff Stripe sessions should be bounded by the price-change time when possible.');
has(access, "from './_ticket-pricing.mjs'", 'Private ticket access must display centralized current pricing.');
has(reminder, "from './_ticket-pricing.mjs'", 'Purchase reminder email must display centralized current pricing.');
has(cutover, "schedule: '0 10 2 9 *'", 'Midnight HST cutover cleanup must run at 10:00 UTC on Sept. 2.');
has(cutover, "status !== 'checkout_created'", 'Cutover must only target unpaid open admission checkouts.');
has(cutover, 'ticketAmount >= currentPrice', 'Cutover must preserve current-price and paid records.');
has(api, 'ticketPricing()', 'Public pricing endpoint must expose centralized pricing.');
has(netlify, 'from = "/api/ticket/pricing"', 'Public ticket pricing API route must exist.');
has(env, 'NOCTURNE_TICKET_PRICE_AFTER_CENTS=3500', 'Environment example must document the $35 price.');
has(env, 'NOCTURNE_TICKET_PRICE_CHANGE_ISO=2026-09-02T00:00:00-10:00', 'Environment example must document the midnight HST cutoff.');

has(publicInjector, 'Ticket price increases tonight.', 'Public pages must prominently announce the ticket price increase.');
has(publicInjector, 'The price becomes $35 at midnight.', 'Public price alert must state the $35 midnight price.');
has(publicInjector, 'Six-Drink Package', 'Public add-on section must include the Six-Drink Package.');
has(publicInjector, 'Unlimited Drinking Water', 'Public add-on section must include Unlimited Drinking Water.');
has(publicInjector, 'Late Checkout /', 'Public add-on section must include Late Checkout / Car Camping.');
has(publicInjector, 'Limited to the first 30 purchasers.', 'Public late-stay copy must state the 30-person limit.');
has(publicInjector, 'All add-ons are FINAL SALE / NON-REFUNDABLE.', 'Public add-on section must state the final-sale policy.');
check(!/\bbeer\b|\bcocktails?\b|\bpremium cocktails?\b|\bpaid at the bar\b/i.test(publicInjector), 'Public add-on copy must not mention alcohol or bar-specific redemption.');
has(publicInjector, 'html.replace(/<div class="event-facts"', 'Public add-ons must be injected adjacent to the event facts.');
has(publicInjector, '(eventFacts) => `${eventFacts}${addOns}`', 'Public add-on injection must use a function replacement so $15/$20/$55 remain literal prices.');
check(!publicInjector.includes('`$1${addOns}`'), 'Public add-on injection must never use a replacement string where $15 can be parsed as a capture reference.');
has(publicPricing, 'deadlinePhrases', 'Public runtime pricing must protect historical deadline wording after the cutoff.');
has(publicPricing, "alert.querySelector('strong').textContent = 'Current ticket price'", 'Public price alert must become current-price messaging after the cutoff.');
has(publicOffersCss, '.ticket-price-alert', 'Public price alert must have dedicated styling.');
has(publicOffersCss, '.public-addon-grid', 'Public add-on section must have responsive card styling.');

if (failures.length) {
  console.error('Ticket pricing regression checks failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('Ticket pricing regression checks passed.');
