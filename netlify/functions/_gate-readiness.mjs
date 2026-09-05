import { waiverSigned } from './_waiver.mjs';

export function gateReadiness(summary, review, expectedTicketId = '') {
  const errors = [];
  const warnings = [];
  const ticketId = String(summary?.ticketId || '');
  const source = summary?.ticketSource === 'comp' || /^NOC-TKT-COMP-/.test(ticketId) ? 'comp' : 'paid';

  if (!summary) errors.push('Ticket summary is missing.');
  if (summary && summary.status !== 'paid') errors.push(`Ticket summary status is ${summary.status || 'missing'}, not paid.`);
  if (!ticketId) errors.push('Ticket ID is missing.');
  if (expectedTicketId && ticketId !== expectedTicketId) errors.push('Scanned ticket ID does not match the active ticket record.');
  if (!review) errors.push('Ticket review record is missing.');
  if (review && !['paid', 'checked_in'].includes(String(review.ticketState || ''))) errors.push(`Review ticket state is ${review.ticketState || 'missing'}, not active.`);

  if (summary && review?.ticketId && ticketId && review.ticketId !== ticketId) errors.push('Summary and review ticket IDs do not match.');
  if (summary?.ticketSource && review?.ticketSource && summary.ticketSource !== review.ticketSource) errors.push('Summary and review ticket sources do not match.');
  if (!waiverSigned(summary || {}, review || {})) errors.push('Required participant waiver has not been signed for this ticket.');

  if (source === 'comp') {
    if (Number(summary?.amountTotal || 0) !== 0) errors.push('Complimentary ticket has a non-zero admission amount.');
    if (summary?.stripePaymentIntentId) errors.push('Complimentary admission unexpectedly has a Stripe payment intent.');
  } else if (summary) {
    if (summary.paymentStatus && summary.paymentStatus !== 'paid') errors.push(`Paid ticket payment status is ${summary.paymentStatus}.`);
    if (!summary.paymentStatus) warnings.push('Paid ticket paymentStatus is missing; active summary/review state will still permit gate entry after waiver verification.');
    if (!summary.stripePaymentIntentId) warnings.push('Paid ticket Stripe payment intent is missing from the summary.');
  }

  const summaryChecked = Boolean(summary?.checkedInAt);
  const reviewChecked = Boolean(review?.checkedInAt || review?.ticketState === 'checked_in');
  if (summaryChecked !== reviewChecked) warnings.push('Check-in state differs between summary and review records.');

  return { ready: errors.length === 0, source, ticketId, waiverSigned: waiverSigned(summary || {}, review || {}), errors, warnings };
}
