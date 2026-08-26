import assert from 'node:assert/strict';
import { waterPackageAddonEligible, waterPackageAddonFields, waterPackageConfig } from '../netlify/functions/_water-package.mjs';

delete process.env.NOCTURNE_WATER_PACKAGE_ENABLED;
delete process.env.NOCTURNE_WATER_PACKAGE_PRICE_CENTS;
assert.deepEqual(waterPackageConfig(), { enabled: true, priceCents: 1500 });
process.env.NOCTURNE_WATER_PACKAGE_PRICE_CENTS = '1800';
assert.equal(waterPackageConfig().priceCents, 1800);
process.env.NOCTURNE_WATER_PACKAGE_ENABLED = 'false';
assert.equal(waterPackageConfig().enabled, false);
delete process.env.NOCTURNE_WATER_PACKAGE_ENABLED;
delete process.env.NOCTURNE_WATER_PACKAGE_PRICE_CENTS;

const summary = { status: 'paid', ticketId: 'NOC-TKT-WATER', waterPackagePurchased: false };
assert.equal(waterPackageAddonEligible(summary, { ticketState: 'paid' }, 'NOC-TKT-WATER'), true);
assert.equal(waterPackageAddonEligible(summary, { ticketState: 'checked_in' }, 'NOC-TKT-WATER'), true);
assert.equal(waterPackageAddonEligible({ ...summary, waterPackagePurchased: true }, { ticketState: 'paid' }, 'NOC-TKT-WATER'), false);
assert.equal(waterPackageAddonEligible({ ...summary, status: 'refunded' }, { ticketState: 'refunded' }, 'NOC-TKT-WATER'), false);
assert.equal(waterPackageAddonEligible(summary, { ticketState: 'paid' }, 'NOC-TKT-WRONG'), false);

assert.deepEqual(waterPackageAddonFields({ sessionId: 'cs_test_water', paymentIntentId: 'pi_test_water', paidAt: '2026-08-25T12:00:00.000Z', priceCents: 1500 }), {
  waterPackagePurchased: true,
  waterPackageStatus: 'active',
  waterPackagePriceCents: 1500,
  waterPackagePurchaseType: 'addon',
  waterPackageCheckoutStatus: 'paid',
  waterPackageCheckoutSessionId: 'cs_test_water',
  waterPackagePaymentIntentId: 'pi_test_water',
  waterPackagePaidAt: '2026-08-25T12:00:00.000Z',
  waterPackageCheckoutUrl: null,
  waterPackageCheckoutExpiresAt: null,
  waterPackageInvalidatedAt: null,
  waterPackageInvalidationReason: null,
  updatedAt: '2026-08-25T12:00:00.000Z'
});

console.log('NOCTURNE water-package tests passed.');
