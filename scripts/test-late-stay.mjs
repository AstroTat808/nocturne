import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const has = (source, value, message) => check(source.includes(value), message);

const helper = read('netlify/functions/_late-stay.mjs');
const checkout = read('netlify/functions/create-checkout.mjs');
const addonCheckout = read('netlify/functions/create-late-stay-checkout.mjs');
const ticketApi = read('netlify/functions/ticket-late-stay.mjs');
const ticketJs = read('site/assets/js/ticket-view.js');
const webhook = read('netlify/functions/stripe-webhook.mjs');
const router = read('netlify/functions/stripe-webhook-router.mjs');
const inviteEmail = read('netlify/functions/_invite-reminder-email.mjs');
const purchaseEmail = read('netlify/functions/_purchase-reminder-email.mjs');
const campaign = read('netlify/functions/admin-bulk-drink-package-offer.mjs');
const adminEntitlements = read('netlify/functions/admin-row-entitlements.mjs');
const adminJs = read('site/assets/js/admin-drinks.js');
const refund = read('netlify/functions/admin-admission-refund.mjs');
const netlify = read('netlify.toml');
const envExample = read('.env.example');

has(helper, 'LATE_STAY_PRICE_CENTS = 2000', 'Late-stay default price must remain $20.');
has(helper, 'LATE_STAY_CAPACITY = 30', 'Late-stay default capacity must remain 30.');
has(helper, "LATE_STAY_DEPARTURE = '8:00 AM'", 'Late-stay departure deadline must remain 8:00 AM.');
has(helper, "const CAPACITY_STORE = 'nocturne-late-stay-capacity'", 'Late-stay capacity must use its dedicated Blob store.');
has(helper, '{ onlyIfNew: true }', 'New capacity slot claims must use an atomic onlyIfNew write.');
has(helper, '{ onlyIfMatch: entry.etag }', 'Existing capacity slot updates must use ETag concurrency protection.');
has(helper, "status: 'sold'", 'Paid late-stay reservations must become sold slots.');

has(checkout, "name=\"late_stay\"", 'Initial ticket checkout must expose the late-stay option through ticket-access input.');
has(checkout, "'metadata[lateStay]'", 'Initial Stripe checkout must include late-stay metadata.');
has(checkout, 'lateStay.priceCents', 'Initial checkout total must include the configured late-stay price.');
has(checkout, 'reserveLateStaySlot', 'Initial ticket checkout must reserve capacity before Stripe payment.');
has(addonCheckout, "'metadata[purchaseType]': 'late-stay-addon'", 'Post-ticket Stripe checkout must identify late-stay add-on purchases.');
has(addonCheckout, 'reserveLateStaySlot', 'Post-ticket checkout must reserve late-stay capacity.');
has(addonCheckout, 'releaseLateStayReservation', 'Failed post-ticket checkouts must release their capacity reservation.');

has(webhook, 'fulfillBundledLateStay', 'Bundled ticket payments must finalize late-stay entitlement.');
has(webhook, 'markLateStaySold', 'Bundled payment fulfillment must permanently consume the reserved capacity slot.');
has(router, "purchaseType === 'late-stay-addon'", 'Webhook router must intercept post-ticket late-stay purchases.');
has(router, 'reconcileLateStayCheckout', 'Post-ticket webhook must reconcile the paid late-stay entitlement.');

has(ticketApi, 'lateStayAvailability', 'Digital ticket late-stay API must report live capacity.');
has(ticketJs, 'Late Checkout / Car Camping', 'Digital ticket must display the late-stay add-on.');
has(ticketJs, 'LATE STAY · 8AM', 'Staff ticket view must surface the late-stay entitlement.');

has(inviteEmail, 'Optional Late Checkout / Car Camping · $20', 'Daily invite reminders must mention the late-stay option.');
has(purchaseEmail, 'Optional Late Checkout / Car Camping · $20', 'Daily purchase reminders must mention the late-stay option.');
has(campaign, "CAMPAIGN_VERSION='v4'", 'Ticket-holder add-on campaign version must include late stay.');
has(campaign, 'offerLateStay', 'Ticket-holder add-on campaign must personalize late-stay eligibility.');
has(campaign, 'lateStayRemaining', 'Campaign result must report remaining late-stay capacity.');

has(adminEntitlements, 'lateStayPurchases', 'Admin entitlement endpoint must count late-stay purchases.');
has(adminEntitlements, 'hasLateStay', 'Admin entitlement endpoint must identify active late-stay guests.');
has(adminJs, 'late-stay-stat-purchased', 'Admin package summary must show late-stay sold count.');
has(adminJs, "entitlementBadge('LATE STAY'", 'Admin applicant rows must display a LATE STAY badge.');

has(refund, 'bundledAddOnCents', 'Admission refund calculation must explicitly remove bundled add-ons.');
has(refund, 'lateStayPriceCents', 'Admission refund calculation must account for the bundled late-stay price.');
has(refund, "lateStayStatus: 'forfeited'", 'Admission refunds must forfeit late-stay access without refunding it.');
has(refund, "'metadata[lateStayRefunded]': 'false'", 'Stripe admission refund metadata must explicitly retain late-stay dollars.');

has(netlify, 'from = "/api/ticket/late-stay"', 'Netlify must route late-stay digital ticket status.');
has(netlify, 'from = "/ticket/late-stay/checkout"', 'Netlify must route late-stay checkout.');
has(netlify, 'from = "/ticket/late-stay/confirmed"', 'Netlify must route late-stay confirmation.');
has(envExample, 'NOCTURNE_LATE_STAY_PRICE_CENTS=2000', 'Environment example must document the $20 late-stay price.');
has(envExample, 'NOCTURNE_LATE_STAY_CAPACITY=30', 'Environment example must document 30-person capacity.');

if (failures.length) {
  console.error('Late-stay integration checks failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Late-stay integration checks passed.');
