import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const netlify = read('netlify.toml');
const adminDelete = read('site/assets/js/admin-delete.js');
const deleteServer = read('netlify/functions/admin-delete-application.mjs');
const adminHtml = read('site/admin.html');
const adminCampaign = read('site/assets/js/admin-reminder-test.js');
const publicInjector = read('scripts/inject-public-ticket-pricing.mjs');
const publicPricing = read('site/assets/js/public-ticket-pricing.js');
const admissionWrapper = read('netlify/functions/create-checkout-v2.mjs');
const lateStayWrapper = read('netlify/functions/create-late-stay-checkout-v2.mjs');
const webhookWrapper = read('netlify/functions/stripe-webhook-router-v2.mjs');

assert.ok(netlify.includes('to = "/.netlify/functions/admin-delete-application-v2"'), 'Canonical admin deletion must route through the v2 hardened handler.');
assert.ok(netlify.includes('to = "/.netlify/functions/stripe-webhook-router-v2"'), 'Production Stripe webhook must route through v2.');
assert.ok(netlify.includes('to = "/.netlify/functions/ticket-view-v2"'), 'Production ticket view must route through v2.');

assert.ok(adminDelete.includes("const DELETE_API = '/api/admin/delete-application'"), 'Admin deletion UI must use the canonical protected delete route.');
assert.ok(adminDelete.includes('addonBundleCheckoutSessionId'), 'Admin deletion UI must recognize combined add-on Stripe activity.');
assert.ok(adminDelete.includes('lateStayPaymentIntentId'), 'Admin deletion UI must recognize Late Stay Stripe activity.');
assert.ok(deleteServer.includes('addonBundleCheckoutSessionId'), 'Server-side deletion protection must recognize combined add-on sessions.');
assert.ok(deleteServer.includes('addonBundlePaymentIntentId'), 'Server-side deletion protection must recognize combined add-on payment intents.');
assert.ok(deleteServer.includes('addon-bundle-checkout-attempt-'), 'Force deletion must clear combined add-on checkout-attempt claims.');
assert.ok(deleteServer.includes('addonBundleSelectionKey'), 'Financial tombstones must preserve combined add-on accounting context.');

assert.ok(adminHtml.includes('admin-delete.js?v=20260905a'), 'Admin delete fix must be cache-busted.');
assert.ok(adminHtml.includes('admin-reminder-test.js?v=20260905a'), 'Admin reminder/campaign fix must be cache-busted.');
assert.ok(!adminHtml.includes('limited-capacity add-ons'), 'Admin policy copy must not claim Late Stay is limited-capacity.');
assert.ok(!adminHtml.includes('Bulk reminders remain paused during test mode.'), 'Admin reminder copy must not misstate the event-day reminder policy.');
assert.ok(adminCampaign.includes('unlimited inventory and a 10:00 AM departure deadline'), 'Admin add-on campaign must advertise current Late Stay terms.');
assert.ok(adminCampaign.includes('late stay unlimited'), 'Admin campaign result must report unlimited Late Stay inventory correctly.');

assert.ok(publicInjector.includes('Approved admission is now $35.'), 'Public build must generate current $35 admission copy.');
assert.ok(!publicInjector.includes('Ticket price increases tonight.'), 'Public build must not regenerate expired ticket-price urgency.');
assert.ok(!publicInjector.includes('Limited to the first 30 purchasers.'), 'Public build must not regenerate the retired Late Stay cap.');
assert.ok(publicInjector.includes('until 10:00 AM'), 'Public build must use the current Late Stay departure time.');
assert.ok(publicPricing.includes('normalizeText'), 'Runtime pricing must normalize stale cached copy to the current price.');

for (const [name, source] of [
  ['create-checkout-v2', admissionWrapper],
  ['create-late-stay-checkout-v2', lateStayWrapper],
  ['stripe-webhook-router-v2', webhookWrapper]
]) {
  assert.ok(!source.includes('globalThis.fetch'), `${name} must not depend on an outer global fetch compatibility rewrite.`);
}

console.log('Full-site audit regressions passed: hardened production routes, admin deletion safety, current pricing, 10am Late Stay, and wrapper cleanup.');
