import assert from 'node:assert/strict';
import { summarizeOperations } from '../netlify/functions/_operations-metrics.mjs';

const summaries = [
  {
    submissionId: 'paid1',
    ticketId: 'NOC-TKT-PAID1',
    status: 'paid',
    ticketSource: 'stripe',
    ticketAmount: 2500,
    amountTotal: 8000,
    checkedInAt: '2026-09-06T16:00:00.000Z',
    drinkPackagePurchased: true,
    drinkPackagePurchaseType: 'bundled',
    drinkPackagePriceCents: 5500,
    drinkPackageStatus: 'active',
    drinkPackageActivatedAt: '2026-09-06T16:05:00.000Z',
    drinkCreditsPurchased: 6,
    drinkCreditsRedeemed: 2,
    drinkCreditsRemaining: 4,
    drinkBeerRedemptions: 1,
    drinkWellRedemptions: 0,
    drinkPremiumRedemptions: 1,
    drinkNonalcoholicRedemptions: 0,
    drinkPremiumUpgradeTotalCents: 500,
    waterPackagePurchased: true,
    waterPackageStatus: 'active',
    waterPackagePriceCents: 1500
  },
  {
    submissionId: 'comp1',
    ticketId: 'NOC-TKT-COMP-1',
    status: 'paid',
    ticketSource: 'comp',
    checkedInAt: null
  },
  {
    submissionId: 'refund1',
    ticketId: 'NOC-TKT-REFUND1',
    status: 'refunded',
    ticketSource: 'stripe',
    ticketAmount: 2500,
    amountTotal: 2500,
    stripeRefundId: 're_123',
    refundedAmount: 2500
  }
];

const redemptions = [
  { submissionId: 'paid1', ticketId: 'NOC-TKT-PAID1', staffName: 'Alex', drinkType: 'beer', premiumUpgradeCents: 0, creditsRemaining: 5, redeemedAt: '2026-09-06T16:10:00.000Z' },
  { submissionId: 'paid1', ticketId: 'NOC-TKT-PAID1', staffName: 'Alex', drinkType: 'premium', premiumUpgradeCents: 500, creditsRemaining: 4, redeemedAt: '2026-09-06T17:10:00.000Z' }
];

const audits = [
  { type: 'ticket.checked_in', submissionId: 'paid1', ticketId: 'NOC-TKT-PAID1', guestName: 'Guest One', occurredAt: '2026-09-06T16:00:00.000Z' }
];

const result = summarizeOperations({ summaries, redemptions, audits, guestNames: { paid1: 'Guest One' } });

assert.equal(result.gate.ticketsSold, 2);
assert.equal(result.gate.compTickets, 1);
assert.equal(result.gate.activeAdmissions, 2);
assert.equal(result.gate.checkedIn, 1);
assert.equal(result.gate.notYetCheckedIn, 1);
assert.equal(result.gate.grossAdmissionRevenueCents, 5000);
assert.equal(result.gate.admissionRefundsCents, 2500);
assert.equal(result.gate.netAdmissionRevenueCents, 2500);
assert.equal(result.gate.attendancePercent, 50);

assert.equal(result.bar.sixDrinkPackagesSold, 1);
assert.equal(result.bar.waterPackagesSold, 1);
assert.equal(result.bar.sixDrinkRevenueCents, 5500);
assert.equal(result.bar.waterRevenueCents, 1500);
assert.equal(result.bar.packageRevenueCents, 7000);
assert.equal(result.bar.premiumUpgradeCents, 500);
assert.equal(result.bar.creditsRedeemed, 2);
assert.equal(result.bar.creditsRemaining, 4);
assert.equal(result.bar.averageCreditsUsedPerPackage, 2);
assert.equal(result.bar.activeWristbands, 1);
assert.equal(result.bar.bartenders[0].name, 'Alex');
assert.equal(result.bar.bartenders[0].redemptions, 2);
assert.equal(result.live.currentAttendance, 1);
assert.equal(result.live.activeWaterPackages, 1);
assert.equal(result.live.recentCheckIns[0].guestName, 'Guest One');
assert.equal(result.live.recentRedemptions[0].drinkType, 'premium');

console.log('NOCTURNE live operations metrics tests passed.');
