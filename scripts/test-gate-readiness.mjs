import assert from 'node:assert/strict';
import { gateReadiness } from '../netlify/functions/_gate-readiness.mjs';
import { WAIVER_VERSION, WAIVER_TEXT_HASH } from '../netlify/functions/_waiver.mjs';

const waiver = {
  waiverSignedAt: '2026-09-05T07:30:00.000Z',
  waiverVersion: WAIVER_VERSION,
  waiverTextHash: WAIVER_TEXT_HASH,
  waiverSignerName: 'Test Guest',
  waiverParticipantName: 'Test Guest',
  waiverSignerRole: 'self'
};

const paidSummary = {
  ticketId: 'NOC-TKT-PAID-ABC123', ticketSource: 'stripe', status: 'paid', paymentStatus: 'paid', amountTotal: 3500, stripePaymentIntentId: 'pi_test', ...waiver
};
const paidReview = { ticketId: paidSummary.ticketId, ticketSource: 'stripe', ticketState: 'paid', ...waiver };
assert.equal(gateReadiness(paidSummary, paidReview, paidSummary.ticketId).ready, true, 'Normal paid ticket with current signed waiver must be gate-ready.');

const compSummary = {
  ticketId: 'NOC-TKT-COMP-ABC123', ticketSource: 'comp', status: 'paid', paymentStatus: 'comp', amountTotal: 0, stripePaymentIntentId: null, ...waiver
};
const compReview = { ticketId: compSummary.ticketId, ticketSource: 'comp', ticketState: 'paid', ...waiver };
assert.equal(gateReadiness(compSummary, compReview, compSummary.ticketId).ready, true, 'Complimentary ticket with current signed waiver must be gate-ready without Stripe admission payment.');

const unsignedPaid = { ...paidSummary };
for (const key of ['waiverSignedAt', 'waiverVersion', 'waiverTextHash', 'waiverSignerName', 'waiverParticipantName', 'waiverSignerRole']) delete unsignedPaid[key];
const unsignedReview = { ticketId: paidSummary.ticketId, ticketSource: 'stripe', ticketState: 'paid' };
const unsignedResult = gateReadiness(unsignedPaid, unsignedReview, paidSummary.ticketId);
assert.equal(unsignedResult.ready, false, 'Unsigned ticket must be blocked at the gate.');
assert.ok(unsignedResult.errors.some((value) => /waiver/i.test(value)), 'Unsigned ticket must clearly report the waiver requirement.');

assert.equal(gateReadiness(paidSummary, { ...paidReview, ticketState: 'refunded' }, paidSummary.ticketId).ready, false, 'Refunded review state must block gate entry.');
assert.equal(gateReadiness({ ...paidSummary, status: 'disputed' }, paidReview, paidSummary.ticketId).ready, false, 'Inactive summary must block gate entry.');
assert.equal(gateReadiness({ ...compSummary, amountTotal: 2000 }, compReview, compSummary.ticketId).ready, false, 'Comp ticket with non-zero admission amount must be flagged.');
assert.equal(gateReadiness(paidSummary, paidReview, 'NOC-TKT-OTHER-123456').ready, false, 'Scanned token must match the active ticket ID.');

const alreadyChecked = gateReadiness({ ...paidSummary, checkedInAt: '2026-09-06T20:00:00Z' }, { ...paidReview, ticketState: 'checked_in', checkedInAt: '2026-09-06T20:00:00Z' }, paidSummary.ticketId);
assert.equal(alreadyChecked.ready, true, 'Already-checked-in ticket remains a valid record so scanner can return ALREADY CHECKED IN.');
assert.equal(alreadyChecked.warnings.length, 0);

console.log('Paid/comp gate readiness and mandatory-waiver regression checks passed.');
