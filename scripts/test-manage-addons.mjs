import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { drinkPackageAddonEligible } from '../netlify/functions/_drink-package.mjs';
import { waterPackageAddonEligible } from '../netlify/functions/_water-package.mjs';
import { lateStayAddonEligible, lateStayConfig } from '../netlify/functions/_late-stay.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manager = read('netlify/functions/ticket-addons.mjs');
const managerJs = read('site/assets/js/addon-manager.js');
const checkout = read('netlify/functions/create-addon-checkout.mjs');
const replacement = read('netlify/functions/create-addon-checkout-v2.mjs');
const ticketView = read('netlify/functions/ticket-view-v2.mjs');
const webhook = read('netlify/functions/stripe-webhook-router-v2.mjs');
const transition = read('netlify/functions/_addon-payment-transition.mjs');
const refund = read('netlify/functions/admin-admission-refund.mjs');
const netlify = read('netlify.toml');

for (const name of ['drink_package', 'water_package', 'late_stay']) assert.ok(manager.includes(`'${name}'`), `Manage Add-Ons must include ${name}.`);
assert.ok(manager.includes('name="package_policy"'), 'Manage Add-Ons must include one shared package_policy acknowledgment.');
assert.ok(manager.includes('Checkout Selected Add-Ons →'), 'Manage Add-Ons must provide a single combined checkout action.');
assert.ok(manager.includes('new combined checkout'), 'Open unpaid standalone checkouts must be replaceable by the combined flow.');
assert.ok(manager.includes('data-addon-total'), 'Manage Add-Ons must expose a running total.');
assert.ok(manager.includes('MOST POPULAR'), 'Six-Drink must be prominently merchandised.');
assert.ok(manager.includes('STAY UNTIL 10 AM'), 'Late Stay must be prominently merchandised.');
assert.ok(manager.includes('addon-manager.js?v=20260905b'), 'Manage Add-Ons must cache-bust the responsive manager fix.');
assert.ok(!managerJs.includes('new MutationObserver(sync)'), 'Add-on manager must not observe and rewrite its own disabled state.');
assert.ok(managerJs.includes("addEventListener('change', sync)"), 'Add-on manager must update from user change events.');
assert.ok(managerJs.includes('submit.disabled !== shouldDisable'), 'Submit disabled writes must be idempotent.');

assert.ok(checkout.includes("'metadata[purchaseType]': 'addon-bundle'"), 'Combined checkout must create addon-bundle Stripe sessions.');
assert.ok(checkout.includes('line_items['), 'Combined checkout must build Stripe line items for selected add-ons.');
assert.ok(checkout.includes('amountTotal: total'), 'Combined checkout must persist the combined amount.');
assert.ok(checkout.includes('async function stripeSession'), 'Combined checkout must verify existing Stripe sessions before reuse or replacement.');
assert.ok(checkout.includes('await closePriorBundle(summary)'), 'Combined checkout must safely close a previous bundle before creating another.');
assert.ok(checkout.includes("status: 'checkout_conflict'"), 'A newly-created Stripe session must be invalidated if the ticket summary cannot attach it.');
assert.ok(checkout.includes('await markClaimFailed'), 'Combined checkout failures must release the checkout-attempt claim instead of leaving it stuck.');
assert.ok(checkout.includes("'metadata[lateStay]': includeLate ? 'until-10am'"), 'Combined checkout must encode 10am Late Stay metadata.');
assert.ok(replacement.includes('replaced_by_combined_checkout'), 'Combined flow must safely replace an old unpaid Late Stay checkout.');

assert.ok(ticketView.includes('/ticket/addons?token='), 'Digital ticket must link to Manage Add-Ons.');
assert.ok(!ticketView.includes('/ticket/drinks/checkout'), 'Digital ticket v2 must not scatter drink checkout controls.');
assert.ok(!ticketView.includes('/ticket/water/checkout'), 'Digital ticket v2 must not scatter water checkout controls.');
assert.ok(!ticketView.includes('/ticket/late-stay/checkout'), 'Digital ticket v2 must not scatter Late Stay checkout controls.');
assert.ok(webhook.includes("purchaseType === 'addon-bundle'"), 'Webhook must intercept combined add-on sessions.');
assert.ok(transition.includes("'water_package_addon'"), 'Water add-on payment transitions must not fall through to admission.');
assert.ok(transition.includes("'late_stay_addon'"), 'Late Stay add-on payment transitions must not fall through to admission.');
assert.ok(transition.includes("'addon_bundle'"), 'Combined add-on payment transitions must not alter admission.');
assert.ok(refund.includes("summary.ticketSource === 'comp'"), 'Comp admission must retain its no-Stripe-refund exception.');

const compSummary = { ticketSource: 'comp', status: 'paid', ticketId: 'NOC-TKT-COMP-TEST', drinkPackagePurchased: false, waterPackagePurchased: false, lateStayPurchased: false };
const compReview = { ticketSource: 'comp', ticketState: 'paid' };
assert.equal(drinkPackageAddonEligible(compSummary, compReview, compSummary.ticketId), true, 'Comp tickets must be eligible for drink add-ons.');
assert.equal(waterPackageAddonEligible(compSummary, compReview, compSummary.ticketId), true, 'Comp tickets must be eligible for water add-ons.');
assert.equal(lateStayAddonEligible(compSummary, compReview, compSummary.ticketId), true, 'Comp tickets must be eligible for Late Stay.');
assert.equal(lateStayConfig().departureTime, '10:00 AM', 'Late Stay must depart at 10:00 AM.');

for (const route of ['/ticket/addons', '/ticket/addons/checkout', '/ticket/addons/confirmed']) assert.ok(netlify.includes(`from = "${route}"`), `Netlify must route ${route}.`);
assert.ok(netlify.includes('to = "/.netlify/functions/ticket-view-v2"'), 'Production ticket route must use unified digital ticket.');
assert.ok(netlify.includes('to = "/.netlify/functions/stripe-webhook-router-v2"'), 'Production webhook route must use add-on-aware router.');
console.log('Manage Add-Ons, checkout replacement safety, comp parity, merchandising, running total, and 10am regression checks passed.');
