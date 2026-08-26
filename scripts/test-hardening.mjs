import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { beforeEvent, eligibleForPurchaseReminder, eligibleForPurchaseReminderTest, honoluluDate } from '../netlify/functions/_reminder-policy.mjs';
import { verifyStripeSignature } from '../netlify/functions/_stripe-signature.mjs';
import { drinkPackageAddonEligible, drinkPackageAddonFields, drinkPackageConfig, drinkPackageRequested, initialDrinkPackageFields, invalidateDrinkPackage } from '../netlify/functions/_drink-package.mjs';
import { appleWalletConfigured, appleWalletStatus, buildAppleWalletPass } from '../netlify/functions/_apple-wallet.mjs';

const now = new Date('2026-08-24T20:00:00.000Z').getTime();
const redeemed = { status: 'approved', inviteState: 'redeemed', inviteRedeemedAt: new Date(now - 21 * 3600000).toISOString() };
assert.equal(eligibleForPurchaseReminderTest(redeemed, null), true, 'controlled test should allow an approved redeemed unpaid guest immediately');
assert.equal(eligibleForPurchaseReminderTest({ ...redeemed, ticketState: 'paid' }, { status: 'paid' }), false, 'controlled test must reject a paid guest');
assert.equal(eligibleForPurchaseReminder(redeemed, null, now), true, 'eligible redeemed guest should receive a reminder');
assert.equal(eligibleForPurchaseReminder({ ...redeemed, ticketState: 'paid', ticketId: 'NOC-TKT-1' }, { status: 'paid' }, now), false, 'paid guest must not receive a reminder');
assert.equal(eligibleForPurchaseReminder({ ...redeemed, inviteRedeemedAt: new Date(now - 2 * 3600000).toISOString() }, null, now), false, 'recent redemption should wait');
assert.equal(eligibleForPurchaseReminder(redeemed, { status: 'refunded' }, now), false, 'protected financial record must not receive a reminder');
assert.equal(honoluluDate(new Date('2026-08-25T05:00:00.000Z')), '2026-08-24');
assert.equal(beforeEvent(new Date('2026-09-06T20:00:00.000Z').getTime()), true);
assert.equal(beforeEvent(new Date('2026-09-07T02:00:00.000Z').getTime()), false);

process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_hardening';
const body = JSON.stringify({ id: 'evt_test_123', type: 'checkout.session.completed' });
const timestamp = Math.floor(Date.now() / 1000);
const signature = createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest('hex');
assert.equal(verifyStripeSignature(body, `t=${timestamp},v1=${signature}`), true);
assert.equal(verifyStripeSignature(`${body}x`, `t=${timestamp},v1=${signature}`), false);

delete process.env.NOCTURNE_DRINK_PACKAGE_PRICE_CENTS;
delete process.env.NOCTURNE_DRINK_REDEMPTION_WARNING_MINUTES;
delete process.env.NOCTURNE_DRINK_PACKAGE_ENABLED;
assert.deepEqual(drinkPackageConfig(), { enabled: true, priceCents: 5500, credits: 6, premiumUpgradeCents: 500, rapidWarningMinutes: 45 });
assert.equal(drinkPackageRequested('on'), true);
assert.equal(drinkPackageRequested('false'), false);
assert.deepEqual(initialDrinkPackageFields(true), {
  drinkPackagePurchased: true, drinkPackageStatus: 'pending_activation', drinkPackagePriceCents: 5500,
  drinkCreditsPurchased: 6, drinkCreditsRedeemed: 0, drinkCreditsRemaining: 6,
  drinkPackageActivatedAt: null, drinkPackageActivatedBy: null, drinkPackageWristbandHash: null,
  drinkPackageLastRedeemedAt: null, drinkPackageLastRedeemedBy: null
});
assert.equal(invalidateDrinkPackage({ drinkPackagePurchased: true }, 'refunded').drinkPackageStatus, 'refunded');
assert.equal(invalidateDrinkPackage({ drinkPackagePurchased: true }, 'disputed').drinkPackageInvalidationReason, 'disputed');
assert.deepEqual(invalidateDrinkPackage({ drinkPackagePurchased: false }, 'refunded'), {});
const activeTicket = { status: 'paid', ticketId: 'NOC-TKT-ADDON', drinkPackagePurchased: false };
assert.equal(drinkPackageAddonEligible(activeTicket, { ticketState: 'paid' }, 'NOC-TKT-ADDON'), true);
assert.equal(drinkPackageAddonEligible(activeTicket, { ticketState: 'checked_in' }, 'NOC-TKT-ADDON'), true);
assert.equal(drinkPackageAddonEligible({ ...activeTicket, drinkPackagePurchased: true }, { ticketState: 'paid' }, 'NOC-TKT-ADDON'), false);
assert.equal(drinkPackageAddonEligible({ ...activeTicket, status: 'refunded' }, { ticketState: 'refunded' }, 'NOC-TKT-ADDON'), false);
assert.equal(drinkPackageAddonEligible(activeTicket, { ticketState: 'paid' }, 'NOC-TKT-WRONG'), false);
assert.deepEqual(drinkPackageAddonFields({ sessionId: 'cs_test_addon', paymentIntentId: 'pi_test_addon', paidAt: '2026-08-25T12:00:00.000Z', priceCents: 5500 }), {
  ...initialDrinkPackageFields(true, 5500),
  drinkPackagePurchaseType: 'addon', drinkPackageCheckoutStatus: 'paid', drinkPackageCheckoutSessionId: 'cs_test_addon',
  drinkPackagePaymentIntentId: 'pi_test_addon', drinkPackagePaidAt: '2026-08-25T12:00:00.000Z', drinkPackageCheckoutUrl: null,
  drinkPackageCheckoutExpiresAt: null, drinkPackageInvalidatedAt: null, drinkPackageInvalidationReason: null, updatedAt: '2026-08-25T12:00:00.000Z'
});

for (const name of [
  'NOCTURNE_APPLE_PASS_TYPE_ID',
  'NOCTURNE_APPLE_TEAM_ID',
  'NOCTURNE_APPLE_WWDR_CERT_BASE64',
  'NOCTURNE_APPLE_PASS_CERT_BASE64',
  'NOCTURNE_APPLE_PASS_KEY_BASE64',
  'NOCTURNE_VENUE_NAME',
  'NOCTURNE_VENUE_ADDRESS'
]) delete process.env[name];
assert.equal(appleWalletConfigured(), false, 'Wallet CTA must stay hidden without every signing credential and private venue setting');
process.env.NOCTURNE_APPLE_PASS_TYPE_ID = 'pass.com.nocturnefestival.ticket';
process.env.NOCTURNE_APPLE_TEAM_ID = 'TESTTEAM01';
process.env.NOCTURNE_APPLE_WWDR_CERT_BASE64 = Buffer.from('test-wwdr').toString('base64');
process.env.NOCTURNE_APPLE_PASS_CERT_BASE64 = Buffer.from('test-certificate').toString('base64');
process.env.NOCTURNE_APPLE_PASS_KEY_BASE64 = Buffer.from('test-private-key').toString('base64');
process.env.NOCTURNE_VENUE_NAME = 'Private Test Venue';
process.env.NOCTURNE_VENUE_ADDRESS = '123 Test Avenue, Test City, HI 99999';
assert.equal(appleWalletStatus().configured, true, 'Wallet must report ready when every signing credential and private venue setting is present');
const walletPass = buildAppleWalletPass({
  ticketId: 'NOC-TKT-TEST123',
  guestName: 'Controlled Guest',
  ticketName: 'NOCTURNE Festival — General Admission',
  ticketUrl: 'https://nocturnefestival.com/ticket?token=controlled-token',
  drinkPackage: { purchased: true, remaining: 4, purchasedCredits: 6 }
});
assert.equal(walletPass.eventTicket.auxiliaryFields.find((field) => field.key === 'guest').value, 'Controlled Guest');
assert.equal(walletPass.eventTicket.auxiliaryFields.find((field) => field.key === 'location').value, 'Private Test Venue');
assert.equal(walletPass.eventTicket.backFields.find((field) => field.key === 'venue').value, 'Private Test Venue\n123 Test Avenue, Test City, HI 99999');
assert.equal(walletPass.eventTicket.backFields.find((field) => field.key === 'drinkPackage').value, '4 of 6 credits remaining');
assert.equal(walletPass.barcodes[0].message, 'https://nocturnefestival.com/ticket?token=controlled-token');
assert.equal(walletPass.sharingProhibited, true);
assert.equal(walletPass.relevantDate, '2026-09-06T15:00:00-10:00');
assert.deepEqual(walletPass.relevantDates, [{ startDate: '2026-09-06T15:00:00-10:00', endDate: '2026-09-07T03:00:00-10:00' }]);

console.log('NOCTURNE hardening tests passed.');
