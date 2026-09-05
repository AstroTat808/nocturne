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
const checkoutWrapper = read('netlify/functions/create-late-stay-checkout-v2.mjs');
const confirmation = read('netlify/functions/late-stay-confirmed.mjs');
const confirmationWrapper = read('netlify/functions/late-stay-confirmed-v2.mjs');
const ticketApi = read('netlify/functions/ticket-late-stay.mjs');
const ticketView = read('netlify/functions/ticket-view-v2.mjs');
const webhook = read('netlify/functions/stripe-webhook.mjs');
const webhookRouter = read('netlify/functions/stripe-webhook-router.mjs');
const webhookV2 = read('netlify/functions/stripe-webhook-router-v2.mjs');
const bundle = read('netlify/functions/_addon-bundle.mjs');
const netlify = read('netlify.toml');
const envExample = read('.env.example');

has(helper, 'LATE_STAY_PRICE_CENTS = 2000', 'Late Stay default price must remain $20.');
has(helper, "LATE_STAY_CAPACITY = null", 'Late Stay must remain unlimited.');
has(helper, 'unlimited: true', 'Late Stay config must report unlimited inventory.');
has(helper, "LATE_STAY_DEPARTURE = '10:00 AM'", 'Late Stay departure must be 10:00 AM.');
has(helper, "LATE_STAY_POLICY_LABEL = 'FINAL SALE / NON-REFUNDABLE'", 'Late Stay must remain final sale/non-refundable.');

has(manager, "name: 'late_stay'", 'Manage Add-Ons must expose Late Stay.');
has(manager, 'STAY UNTIL 10 AM', 'Manage Add-Ons must prominently show the 10:00 AM departure.');
has(manager, 'Select one, two, or all three.', 'Manage Add-Ons must advertise one combined checkout.');
lacks(manager, '30 spots', 'Manage Add-Ons must not mention the former capacity cap.');

has(bundleCheckout, "'metadata[purchaseType]': 'addon-bundle'", 'Combined checkout must identify add-on bundle sessions.');
has(bundleCheckout, "'metadata[lateStay]': includeLate ? 'until-10am'", 'Combined checkout must encode the 10am Late Stay selection.');
has(bundleCheckout, 'Stay on the property after the 3:00 AM event end until 10:00 AM.', 'Combined Stripe line item must show 10:00 AM.');
has(bundleCheckout, 'reserveLateStaySlot', 'Combined checkout must keep internal Late Stay payment tracking.');
has(addonCheckout, 'reserveLateStaySlot', 'Legacy standalone Late Stay checkout must remain available for old links.');
has(addonCheckout, 'resolvePreviousCheckout', 'Standalone Late Stay checkout must verify the previous Stripe session before replacement.');
has(addonCheckout, "'metadata[lateStay]': 'until-10am'", 'Standalone Late Stay checkout must emit 10am metadata.');
has(addonCheckout, 'until 10:00 AM', 'Standalone Late Stay Stripe copy must show 10:00 AM directly.');
has(addonCheckout, "status: 'checkout_conflict'", 'Standalone Late Stay must invalidate a newly-created session if the ticket summary cannot attach it.');
lacks(addonCheckout, 'until 8:00 AM', 'Standalone Late Stay checkout source must not retain 8:00 AM copy.');
lacks(checkoutWrapper, 'globalThis.fetch', 'Late Stay checkout v2 must not depend on a global fetch rewrite.');
lacks(confirmationWrapper, 'rewriteLateStayResponse', 'Late Stay confirmation v2 must not depend on a response rewrite.');
has(confirmation, '10:00 AM', 'Standalone Late Stay confirmation must display 10:00 AM directly.');
lacks(confirmation, '8:00 AM', 'Standalone Late Stay confirmation source must not retain 8:00 AM copy.');

has(ticketApi, 'unlimited: true', 'Ticket Late Stay API must report unlimited inventory.');
has(ticketView, 'Departure by 10:00 AM', 'Digital ticket must show 10:00 AM for purchased Late Stay.');
has(ticketView, 'Buy / Manage Add-Ons →', 'Digital ticket must route add-on purchases through Buy / Manage Add-Ons.');
has(webhookV2, "purchaseType === 'addon-bundle'", 'Webhook v2 must intercept combined add-on purchases.');
lacks(webhookV2, 'globalThis.fetch', 'Webhook v2 must not rely on an outer 8AM-to-10AM response rewrite.');
has(webhook, "['until-8am', 'until-10am']", 'Webhook must preserve legacy until-8am fulfillment while accepting new until-10am metadata.');
has(webhook, 'until 10:00 AM', 'Bundled ticket receipts must use 10:00 AM directly.');
has(webhookRouter, 'Departure deadline: 10:00 AM', 'Standalone Late Stay receipt must use a 10:00 AM deadline.');
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
console.log('Late-stay unlimited 10am, legacy compatibility, and checkout safety checks passed.');
