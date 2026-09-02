import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const mustContain = (path, values) => {
  const source = read(path);
  for (const value of values) assert.ok(source.includes(value), `${path} must contain: ${value}`);
};
const mustNotContain = (path, values) => {
  const source = read(path);
  for (const value of values) assert.ok(!source.includes(value), `${path} must not contain: ${value}`);
};

mustContain('site/terms.html', ['FINAL SALE / NON-REFUNDABLE', 'Six-Drink Package', 'Unlimited Drinking Water Package']);
mustContain('netlify/functions/ticket-access.mjs', ['name="package_policy"', 'I understand all selected add-ons are FINAL SALE / NON-REFUNDABLE.', 'Add Unlimited Drinking Water']);
mustNotContain('netlify/functions/ticket-access.mjs', ['name="drink_package_policy"', 'name="water_package_policy"', 'name="late_stay_policy"']);
mustContain('site/assets/js/ticket-package-policy.js', ['drink_package', 'water_package', 'late_stay', 'package_policy', 'anySelected']);
mustContain('netlify/functions/create-checkout.mjs', ['packagePolicyAccepted', 'all selected add-ons are FINAL SALE / NON-REFUNDABLE', "'metadata[packagePolicyAccepted]'", 'NOCTURNE Unlimited Drinking Water — NON-REFUNDABLE']);
mustNotContain('netlify/functions/create-checkout.mjs', ["form.get('drink_package_policy')", "form.get('water_package_policy')", "form.get('late_stay_policy')"]);
mustContain('netlify/functions/ticket-view.mjs', ['name="package_policy"', 'I understand this package is non-refundable']);
mustContain('netlify/functions/create-drink-package-checkout.mjs', ['packagePolicyAccepted', 'FINAL SALE / NON-REFUNDABLE']);
mustContain('site/assets/js/ticket-view.js', ['name="water_policy"', 'I understand this package is non-refundable']);
mustContain('netlify/functions/create-water-package-checkout.mjs', ['packagePolicyAccepted', 'FINAL SALE / NON-REFUNDABLE']);
mustContain('netlify/functions/admin-admission-refund.mjs', ['amount: String(amount)', "'metadata[drinkPackageRefunded]': 'false'", "drinkPackageStatus: 'forfeited'"]);
mustContain('netlify/functions/stripe-webhook.mjs', ['FINAL SALE / NON-REFUNDABLE', 'Your NOCTURNE Drink Package Is Confirmed', 'waterPackagePurchaseType', "purchaseType: 'bundled'"]);
mustContain('netlify/functions/stripe-webhook-router.mjs', ['Your NOCTURNE Water Package Is Confirmed', 'FINAL SALE / NON-REFUNDABLE']);
mustContain('netlify/functions/ticket-confirmed.mjs', ['FINAL SALE / NON-REFUNDABLE', 'Unlimited Drinking Water', 'waterPackagePurchased']);
mustContain('netlify/functions/drink-package-confirmed.mjs', ['FINAL SALE / NON-REFUNDABLE']);
mustContain('netlify/functions/water-package-confirmed.mjs', ['FINAL SALE / NON-REFUNDABLE']);

console.log('NOCTURNE package policy regression checks passed.');
