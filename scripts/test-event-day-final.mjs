import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WAIVER_VERSION, WAIVER_TEXT, WAIVER_TEXT_HASH } from '../netlify/functions/_waiver.mjs';
import { trustedWaiverSubmission } from '../netlify/functions/ticket-waiver.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const addons = read('netlify/functions/ticket-addons.mjs');
const addonManager = read('site/assets/js/addon-manager.js');
const wallet = read('netlify/functions/_apple-wallet.mjs');
const ticketWallet = read('netlify/functions/ticket-wallet.mjs');
const ticketView = read('netlify/functions/ticket-view-v2.mjs');
const waiverFn = read('netlify/functions/ticket-waiver.mjs');
const checkin = read('netlify/functions/check-in.mjs');
const checkinUi = read('site/check-in.html');
const checkinJs = read('site/assets/js/check-in.js');
const adminGate = read('site/assets/js/admin-gate.js');
const bar = read('netlify/functions/bar.mjs');
const webhook = read('netlify/functions/stripe-webhook-router-v2.mjs');
const transition = read('netlify/functions/_addon-payment-transition.mjs');
const refund = read('netlify/functions/admin-admission-refund.mjs');

assert.match(WAIVER_VERSION, /^2026-09-05\./, 'Waiver must be explicitly versioned.');
assert.equal(WAIVER_TEXT_HASH.length, 64, 'Waiver text must have a durable SHA-256 hash.');
assert.match(WAIVER_TEXT, /ordinary negligence/i, 'Waiver must state the intended ordinary-negligence release scope.');
assert.match(WAIVER_TEXT, /gross negligence/i, 'Waiver must preserve non-waivable liability language.');
assert.ok(waiverFn.includes('electronic_consent') && waiverFn.includes('risk_ack') && waiverFn.includes('truth_ack'), 'Waiver must require explicit e-sign, risk, and accuracy acknowledgments.');
assert.ok(waiverFn.includes("action:'/ticket/waiver'") || waiverFn.includes('action="/ticket/waiver"'), 'Waiver must post to the ticket-specific waiver endpoint.');
assert.ok(waiverFn.includes("ticket.waiver_signed"), 'Waiver signing must be audited.');

const internalWaiverUrl = 'https://internal-function-host.netlify.app/ticket/waiver';
assert.equal(trustedWaiverSubmission(new Request(internalWaiverUrl, { method: 'POST', headers: { origin: 'https://nocturnefestival.com', 'sec-fetch-site': 'same-origin' } })), true, 'Waiver must trust browser-reported same-origin POSTs even when Netlify rewrites the function URL.');
assert.equal(trustedWaiverSubmission(new Request(internalWaiverUrl, { method: 'POST', headers: { origin: 'https://www.nocturnefestival.com', 'sec-fetch-site': 'same-site' } })), true, 'Waiver must accept same-site submissions from the supported public hostnames.');
assert.equal(trustedWaiverSubmission(new Request(internalWaiverUrl, { method: 'POST', headers: { 'sec-fetch-site': 'none' } })), true, 'Waiver must permit direct/top-level browser submissions when Fetch Metadata reports none.');
assert.equal(trustedWaiverSubmission(new Request(internalWaiverUrl, { method: 'POST', headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } })), false, 'Waiver must reject explicit cross-site submissions.');
assert.equal(trustedWaiverSubmission(new Request(internalWaiverUrl, { method: 'POST', headers: { origin: 'https://nocturnefestival.com' } })), true, 'Waiver must retain exact public-Origin fallback for browsers without Fetch Metadata.');
assert.equal(trustedWaiverSubmission(new Request(internalWaiverUrl, { method: 'POST', headers: { origin: 'https://evil.example' } })), false, 'Waiver fallback must reject an untrusted Origin.');

assert.ok(ticketView.includes('QR LOCKED'), 'Unsigned digital tickets must keep the QR locked.');
assert.ok(ticketView.includes('/ticket/waiver?token='), 'Digital ticket must link to the individual waiver.');
assert.ok(checkin.includes("code: waiverOnly ? 'waiver_required'"), 'Gate must return a dedicated waiver-required rejection.');
assert.ok(checkin.includes("action === 'lookup-guest'"), 'Check-in API must support emergency guest lookup.');
assert.ok(checkinUi.includes('Emergency guest lookup'), 'Gate console must expose emergency name/email lookup.');
assert.ok(checkinJs.includes('WAIVER REQUIRED'), 'Gate UI must clearly display waiver blocks.');
assert.ok(checkinJs.includes('Sign Waiver'), 'Emergency lookup must let staff open the guest waiver.');

assert.ok(addons.includes('MOST POPULAR'), 'Six-Drink package must carry the Most Popular badge.');
assert.ok(addons.includes('STAY UNTIL 10 AM'), 'Late Stay must carry the Stay Until 10 AM badge.');
assert.ok(addons.indexOf('Six-Drink Package') < addons.indexOf('Unlimited Drinking Water'), 'Six-Drink must be merchandised ahead of Water.');
assert.ok(addons.includes('addon-card-featured'), 'Primary add-ons must receive featured visual treatment.');
assert.ok(addonManager.includes('data-addon-total') || addons.includes('data-addon-total'), 'Manage Add-Ons must expose a running total target.');
assert.ok(addonManager.includes('Intl.NumberFormat'), 'Running total must format currency in-browser.');

assert.ok(wallet.includes('Buy / Manage Add-Ons'), 'Apple Wallet back fields must include Manage Add-Ons.');
assert.ok(wallet.includes('Sign Required Waiver'), 'Apple Wallet must surface waiver access when unsigned.');
assert.ok(ticketWallet.includes('manageAddonsUrl'), 'Wallet generation must pass the ticket-specific Manage Add-Ons URL.');
assert.ok(ticketWallet.includes('waiverUrl'), 'Wallet generation must pass the ticket-specific waiver URL.');

assert.ok(adminGate.includes('/api/admin/gate-audit'), 'Admin dashboard panel must run the protected gate audit.');
assert.ok(adminGate.includes('ALL TICKETS READY'), 'Admin gate panel must have an explicit green-ready state.');
assert.ok(adminGate.includes('NEED ATTENTION'), 'Admin gate panel must have an explicit blocked state.');

assert.ok(bar.includes("fetchSite==='same-origin'"), 'Bartender console must accept valid custom-domain same-origin requests behind Netlify rewrites.');
assert.ok(bar.includes("fetchSite==='cross-site'"), 'Bartender console must reject cross-site requests.');
assert.ok(bar.includes('onlyIfMatch'), 'Drink redemptions must retain optimistic concurrency protection.');
assert.ok(bar.includes('premiumUpgradePaid'), 'Premium drinks must still require upgrade confirmation.');

assert.ok(webhook.includes('verifyStripeSignature'), 'Production webhook router must verify Stripe signatures.');
assert.ok(webhook.includes("purchaseType === 'addon-bundle'"), 'Production webhook must handle combined add-on checkout.');
assert.ok(transition.includes("'addon_bundle'"), 'Combined add-on refund/dispute transitions must remain isolated from admission.');
assert.ok(refund.includes("summary.ticketSource === 'comp'"), 'Complimentary admission must never attempt a Stripe admission refund.');
assert.ok(refund.includes("waterPackageStatus: 'forfeited'"), 'Admission refund must invalidate attached Water entitlement.');
assert.ok(refund.includes("lateStayStatus: 'forfeited'"), 'Admission refund must invalidate attached Late Stay entitlement.');
assert.ok(refund.includes("drinkPackageStatus: 'forfeited'"), 'Admission refund must invalidate attached drink entitlement.');

console.log('Event-day add-ons, Wallet, waiver, gate, bar, webhook, refund, and admin regressions passed.');
