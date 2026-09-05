import assert from 'node:assert/strict';
import createCheckout, { appendBundledAddOnLineItems, browserFormPost, checkoutInput } from '../netlify/functions/create-checkout.mjs';

const checkoutUrl = 'https://nocturnefestival.com/ticket-access/checkout';
const browserRequest = (body = '') => new Request(checkoutUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body
});

assert.equal(browserFormPost(browserRequest()), true, 'URL-encoded browser checkout must be recognized as a browser form post.');

const allSelected = await checkoutInput(browserRequest('drink_package=yes&water_package=yes&late_stay=yes&package_policy=yes'));
assert.deepEqual(allSelected, {
  drinkPackage: true,
  waterPackage: true,
  lateStay: true,
  packagePolicyAccepted: true
}, 'Normal browser form submission must preserve all three add-on selections.');

const drinkOnly = await checkoutInput(browserRequest('drink_package=on&package_policy=yes'));
assert.deepEqual(drinkOnly, { drinkPackage: true, waterPackage: false, lateStay: false, packagePolicyAccepted: true });

const waterOnly = await checkoutInput(browserRequest('water_package=1&package_policy=yes'));
assert.deepEqual(waterOnly, { drinkPackage: false, waterPackage: true, lateStay: false, packagePolicyAccepted: true });

const lateStayOnly = await checkoutInput(browserRequest('late_stay=true&package_policy=yes'));
assert.deepEqual(lateStayOnly, { drinkPackage: false, waterPackage: false, lateStay: true, packagePolicyAccepted: true });

const stripeParams = {
  'line_items[0][quantity]': '1',
  'line_items[0][price_data][unit_amount]': '3500',
  'line_items[0][price_data][product_data][name]': 'NOCTURNE Festival — General Admission'
};
appendBundledAddOnLineItems(stripeParams, {
  currency: 'usd',
  includeDrinkPackage: true,
  includeWaterPackage: true,
  includeLateStay: true,
  packageConfig: { priceCents: 5500 },
  waterConfig: { priceCents: 1500 },
  lateStay: { priceCents: 2000 }
});

assert.equal(stripeParams['line_items[1][price_data][unit_amount]'], '5500', 'Six-Drink must reach the Stripe payload at $55.');
assert.match(stripeParams['line_items[1][price_data][product_data][name]'], /Six-Drink Package/);
assert.equal(stripeParams['line_items[2][price_data][unit_amount]'], '1500', 'Unlimited Water must reach the Stripe payload at $15.');
assert.match(stripeParams['line_items[2][price_data][product_data][name]'], /Unlimited Drinking Water/);
assert.equal(stripeParams['line_items[3][price_data][unit_amount]'], '2000', 'Late Checkout / Car Camping must reach the Stripe payload at $20.');
assert.match(stripeParams['line_items[3][price_data][product_data][name]'], /Late Checkout \/ Car Camping/);

const originalFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = async () => {
  networkCalls += 1;
  throw new Error('Private-ticket protection failed: checkout attempted a network call without valid ticket access.');
};
try {
  const denied = await createCheckout(browserRequest('drink_package=yes&water_package=yes&late_stay=yes&package_policy=yes'));
  assert.equal(denied.status, 303, 'Unauthenticated browser checkout must be redirected back to private ticket access.');
  assert.match(denied.headers.get('location') || '', /^\/ticket-access\?checkout_error=/, 'Unauthenticated browser checkout must return a private-access error.');
  assert.equal(networkCalls, 0, 'Unauthenticated checkout must be rejected before any Stripe/network request.');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('Shared checkout browser-form and private-ticket regression tests passed.');
