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
const ticketAccess = read('netlify/functions/ticket-access.mjs');
const checkout = read('netlify/functions/create-checkout.mjs');
const addonCheckout = read('netlify/functions/_legacy-create-late-stay-checkout.mjs');
const ticketApi = read('netlify/functions/ticket-late-stay.mjs');
const ticketJs = read('site/assets/js/ticket-view.js');
const webhook = read('netlify/functions/stripe-webhook.mjs');
const router = read('netlify/functions/stripe-webhook-router.mjs');
const lateConfirmed = read('netlify/functions/late-stay-confirmed.mjs');
const ticketConfirmed = read('netlify/functions/ticket-confirmed.mjs');
const refund = read('netlify/functions/admin-admission-refund.mjs');
const deletion = read('netlify/functions/admin-delete-application.mjs');
const netlify = read('netlify.toml');
const envExample = read('.env.example');

has(helper, 'LATE_STAY_PRICE_CENTS = 2000', 'Late-stay default price must remain $20.');
has(helper, "LATE_STAY_CAPACITY = null", 'Late Stay must not have a finite capacity.');
has(helper, 'unlimited: true', 'Late Stay configuration must explicitly report unlimited inventory.');
has(helper, 'soldOut: false', 'Enabled Late Stay inventory must never report sold out.');
has(helper, "LATE_STAY_DEPARTURE = '8:00 AM'", 'Late-stay departure deadline must remain 8:00 AM.');
has(helper, "LATE_STAY_POLICY_LABEL = 'FINAL SALE / NON-REFUNDABLE'", 'Late-stay policy must remain final sale and non-refundable.');
has(helper, 'onlyIfNew: true', 'Unlimited checkout tracking records must retain collision-safe atomic creation.');
has(helper, "status: 'sold'", 'Paid Late Stay tracking records must still finalize after payment.');

has(ticketAccess, 'name="late_stay"', 'Private ticket checkout must expose the Late Stay option.');
has(ticketAccess, 'name="package_policy"', 'Private ticket checkout must include the shared add-on acknowledgment.');
has(ticketAccess, 'ONE PER PERSON', 'Private ticket checkout must explain one Late Stay add-on is required per person.');
lacks(ticketAccess, 'LIMITED CAPACITY', 'Private ticket checkout must not present Late Stay as capacity-limited.');
lacks(ticketAccess, '30 spots', 'Private ticket checkout must not mention a 30-person limit.');

has(checkout, "'metadata[lateStay]'", 'Initial Stripe checkout must include Late Stay metadata.');
has(checkout, 'lateStay.priceCents', 'Initial checkout total must include the configured Late Stay price.');
has(checkout, 'reserveLateStaySlot', 'Initial checkout must create an internal Late Stay tracking reservation for reconciliation.');
has(checkout, 'Late Checkout / Car Camping — NON-REFUNDABLE', 'Bundled Stripe checkout must label Late Stay as non-refundable.');

has(addonCheckout, "'metadata[purchaseType]': 'late-stay-addon'", 'Post-ticket Stripe checkout must identify Late Stay add-on purchases.');
has(addonCheckout, 'reserveLateStaySlot', 'Post-ticket checkout must create an internal Late Stay tracking reservation.');
has(addonCheckout, 'releaseLateStayReservation', 'Failed post-ticket checkouts must release their tracking reservation.');
has(addonCheckout, 'stripeCheckoutSession(summary.lateStayCheckoutSessionId)', 'Existing Late Stay checkout links must be verified against Stripe before reuse.');
has(addonCheckout, "session.status !== 'open'", 'Closed or expired Stripe checkout sessions must not be reused.');

has(webhook, 'fulfillBundledLateStay', 'Bundled ticket payments must finalize Late Stay entitlement.');
has(webhook, 'markLateStaySold', 'Bundled payment fulfillment must finalize its internal tracking record.');
has(router, "purchaseType === 'late-stay-addon'", 'Webhook router must intercept post-ticket Late Stay purchases.');
has(router, 'reconcileLateStayCheckout', 'Post-ticket webhook must reconcile paid Late Stay entitlement.');

has(ticketApi, 'checkoutPending(summary)', 'Digital ticket API must recognize an already-open Late Stay checkout.');
has(ticketApi, 'checkoutUrl:', 'Digital ticket API must return the active Stripe checkout URL so the guest can resume it.');
has(ticketApi, 'unlimited: true', 'Digital ticket API must report unlimited Late Stay availability.');
has(ticketJs, 'Resume Late Stay Checkout', 'Digital ticket must provide a resume action for an open Late Stay checkout.');
has(ticketJs, 'No Late Stay capacity slot is being held or consumed.', 'Pending Late Stay UI must explain that no finite-capacity slot is consumed.');
lacks(ticketJs, 'LIMITED TO 30 GUESTS', 'Digital ticket must not mention the former 30-person limit.');
has(ticketJs, 'LATE STAY · 8AM', 'Staff ticket view must surface the Late Stay entitlement.');

has(lateConfirmed, 'FINAL SALE / NON-REFUNDABLE', 'Standalone Late Stay confirmation must show the non-refundable policy.');
has(ticketConfirmed, 'FINAL SALE / NON-REFUNDABLE', 'Bundled ticket confirmation must show the Late Stay non-refundable policy.');
has(refund, 'lateStayPriceCents', 'Admission refund calculation must account for bundled Late Stay price.');
has(refund, "lateStayStatus: 'forfeited'", 'Admission refunds must forfeit Late Stay access without refunding it.');
has(deletion, 'lateStayPurchased', 'Force-delete accounting tombstones must retain Late Stay purchase history.');

has(netlify, 'from = "/api/ticket/late-stay"', 'Netlify must route Late Stay digital ticket status.');
has(netlify, 'from = "/ticket/late-stay/checkout"', 'Netlify must route Late Stay checkout.');
has(netlify, 'from = "/ticket/late-stay/confirmed"', 'Netlify must route Late Stay confirmation.');
has(envExample, 'NOCTURNE_LATE_STAY_PRICE_CENTS=2000', 'Environment example must document the $20 Late Stay price.');
lacks(envExample, 'NOCTURNE_LATE_STAY_CAPACITY=', 'Environment example must not advertise a finite Late Stay capacity setting.');

if (failures.length) {
  console.error('Late-stay integration checks failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Late-stay unlimited-inventory integration checks passed.');
