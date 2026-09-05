import assert from 'node:assert/strict';
import createCheckout, { appendBundledAddOnLineItems, browserFormPost, checkoutInput } from '../netlify/functions/create-checkout.mjs';
import { browserAddonCheckout, browserAddonFormPost } from '../netlify/functions/_browser-addon-checkout.mjs';

const checkoutUrl = 'https://nocturnefestival.com/ticket-access/checkout';
const browserRequest = (body = '', url = checkoutUrl) => new Request(url, {
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

async function verifyStandaloneAddon({ path, formPolicyField, jsonPolicyField, errorPath }) {
  const token = 'NOC-TEST-TICKET-TOKEN';
  const stripeUrl = `https://checkout.stripe.com/c/pay/test-${jsonPolicyField}`;
  let received = null;
  const legacyHandler = async (req) => {
    assert.equal(req.headers.get('content-type'), 'application/json', `${path} must normalize browser forms to JSON before the existing secure handler.`);
    received = await req.json();
    return Response.json({ ok: true, checkoutUrl: stripeUrl });
  };
  const req = browserRequest(`token=${encodeURIComponent(token)}&${encodeURIComponent(formPolicyField)}=yes`, `https://nocturnefestival.com${path}`);
  assert.equal(browserAddonFormPost(req), true);
  const response = await browserAddonCheckout(req, legacyHandler, { formPolicyField, jsonPolicyField, errorPath });
  assert.deepEqual(received, { token, [jsonPolicyField]: true }, `${path} must preserve the digital-ticket token and policy acknowledgment.`);
  assert.equal(response.status, 303, `${path} browser form must redirect to Stripe Checkout.`);
  assert.equal(response.headers.get('location'), stripeUrl, `${path} must redirect to the Stripe Checkout URL returned by the existing handler.`);
}

await verifyStandaloneAddon({
  path: '/ticket/drinks/checkout',
  formPolicyField: 'package_policy',
  jsonPolicyField: 'packagePolicy',
  errorPath: '/ticket/drinks/confirmed'
});
await verifyStandaloneAddon({
  path: '/ticket/water/checkout',
  formPolicyField: 'water_policy',
  jsonPolicyField: 'waterPolicy',
  errorPath: '/ticket/water/confirmed'
});
await verifyStandaloneAddon({
  path: '/ticket/late-stay/checkout',
  formPolicyField: 'late_stay_policy',
  jsonPolicyField: 'lateStayPolicy',
  errorPath: '/ticket/late-stay/confirmed'
});

console.log('Shared admission checkout and standalone ticket add-on browser-form regression tests passed.');
