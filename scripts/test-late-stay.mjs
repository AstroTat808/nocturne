import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const has = (source, value, message) => check(source.includes(value), message);
const lacks = (source, value, message) => check(!source.includes(value), message);

const helper = read('netlify/functions/_late-stay.mjs');
const manager = read('netlify/functions/ticket-addons.mjs');
const bundleCheckout = read('netlify/functions/create-addon-checkout.mjs');
const addonCheckout = read('netlify/functions/_legacy-create-late-stay-checkout.mjs');
const ticketApi = read('netlify/functions/ticket-late-stay.mjs');
const ticketView = read('netlify/functions/ticket-view-v2.mjs');
const webhookV2 = read('netlify/functions/stripe-webhook-router-v2.mjs');
const bundle = read('netlify/functions/_addon-bundle.mjs');
const netlify = read('netlify.toml');
const envExample = read('.env.example');

has(helper, 'LATE_STAY_PRICE_CENTS = 2000', 'Late Stay default price must remain $20.');
has(helper, "LATE_STAY_CAPACITY = null", 'Late Stay must remain unlimited.');
has(helper, 'unlimited: true', 'Late Stay config must report unlimited inventory.');
has(helper, "LATE_STAY_DEPARTURE = '10:00 AM'", 'Late Stay departure must be 10:00 AM.');
has(helper, "LATE_STAY_POLICY_LABEL = 'FINAL SALE / NON-REFUNDABLE'", 'Late Stay must remain final sale/non-refundable.');

has(manager, 'name="late_stay"', 'Manage Add-Ons must expose Late Stay.');
has(manager, 'until 10:00 AM', 'Manage Add-Ons must show the 10:00 AM departure.');
has(manager, 'Select any combination below and pay once through Stripe.', 'Manage Add-Ons must advertise one combined checkout.');
lacks(manager, '30 spots', 'Manage Add-Ons must not mention the former capacity cap.');

has(bundleCheckout, "'metadata[purchaseType]': 'addon-bundle'", 'Combined checkout must identify add-on bundle sessions.');
has(bundleCheckout, "'metadata[lateStay]': includeLate ? 'until-10am'", 'Combined checkout must encode the 10am Late Stay selection.');
has(bundleCheckout, 'Stay on the property after the 3:00 AM event end until 10:00 AM.', 'Combined Stripe line item must show 10:00 AM.');
has(bundleCheckout, 'reserveLateStaySlot', 'Combined checkout must keep internal Late Stay payment tracking.');
has(addonCheckout, 'reserveLateStaySlot', 'Legacy standalone Late Stay checkout must remain available for old links.');

has(ticketApi, 'unlimited: true', 'Ticket Late Stay API must report unlimited inventory.');
has(ticketView, 'Departure by 10:00 AM', 'Digital ticket must show 10:00 AM for purchased Late Stay.');
has(ticketView, 'Manage Add-Ons →', 'Digital ticket must route add-on purchases through Manage Add-Ons.');
has(webhookV2, "purchaseType === 'addon-bundle'", 'Webhook v2 must intercept combined add-on purchases.');
has(bundle, 'markLateStaySold', 'Combined fulfillment must finalize Late Stay tracking.');

has(netlify, 'from = "/ticket/addons"', 'Netlify must route Manage Add-Ons.');
has(netlify, 'from = "/ticket/addons/checkout"', 'Netlify must route combined add-on checkout.');
has(netlify, 'stripe-webhook-router-v2', 'Netlify must route Stripe webhooks through add-on-aware router.');
has(envExample, 'NOCTURNE_LATE_STAY_PRICE_CENTS=2000', 'Environment example must retain the $20 Late Stay price.');
lacks(envExample, 'NOCTURNE_LATE_STAY_CAPACITY=', 'Environment example must not restore a finite Late Stay capacity.');

if (failures.length) {
  console.error('Late-stay integration checks failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('Late-stay unlimited 10am integration checks passed.');
