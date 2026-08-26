import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const mustContain = (path, values) => {
  const source = read(path);
  for (const value of values) assert.ok(source.includes(value), `${path} must contain: ${value}`);
};

mustContain('site/terms.html', ['FINAL SALE / NON-REFUNDABLE', 'Six-Drink Package', 'Unlimited Drinking Water Package']);
mustContain('netlify/functions/ticket-access.mjs', ['drink_package_policy', 'I understand this drink package is non-refundable']);
mustContain('netlify/functions/create-checkout.mjs', ['drinkPackagePolicyAccepted', 'FINAL SALE / NON-REFUNDABLE']);
mustContain('netlify/functions/ticket-view.mjs', ['name="package_policy"', 'I understand this package is non-refundable']);
mustContain('netlify/functions/create-drink-package-checkout.mjs', ['packagePolicyAccepted', 'FINAL SALE / NON-REFUNDABLE']);
mustContain('site/assets/js/ticket-view.js', ['name="water_policy"', 'I understand this package is non-refundable']);
mustContain('netlify/functions/create-water-package-checkout.mjs', ['packagePolicyAccepted', 'FINAL SALE / NON-REFUNDABLE']);
mustContain('netlify/functions/admin-admission-refund.mjs', ['amount: String(amount)', "'metadata[drinkPackageRefunded]': 'false'", "drinkPackageStatus: 'forfeited'"]);
mustContain('netlify/functions/stripe-webhook.mjs', ['FINAL SALE / NON-REFUNDABLE', 'Your NOCTURNE Drink Package Is Confirmed']);
mustContain('netlify/functions/stripe-webhook-router.mjs', ['Your NOCTURNE Water Package Is Confirmed', 'FINAL SALE / NON-REFUNDABLE']);
mustContain('netlify/functions/ticket-confirmed.mjs', ['FINAL SALE / NON-REFUNDABLE']);
mustContain('netlify/functions/drink-package-confirmed.mjs', ['FINAL SALE / NON-REFUNDABLE']);
mustContain('netlify/functions/water-package-confirmed.mjs', ['FINAL SALE / NON-REFUNDABLE']);

console.log('NOCTURNE package policy regression checks passed.');
