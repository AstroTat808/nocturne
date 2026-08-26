function n(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isComp(summary = {}) {
  return summary.ticketSource === 'comp' || /^NOC-TKT-COMP-/.test(String(summary.ticketId || ''));
}

function admissionAmount(summary = {}) {
  if (isComp(summary)) return 0;
  const ticketAmount = n(summary.ticketAmount);
  if (ticketAmount > 0) return ticketAmount;
  const total = n(summary.amountTotal || summary.expectedAmountTotal);
  const bundledDrink = summary.drinkPackagePurchased && summary.drinkPackagePurchaseType !== 'addon'
    ? n(summary.drinkPackagePriceCents)
    : 0;
  return Math.max(0, total - bundledDrink);
}

function admissionRefundAmount(summary = {}) {
  const history = Array.isArray(summary.refundHistory) ? summary.refundHistory : [];
  const recorded = history
    .filter((item) => item?.type === 'admission')
    .reduce((sum, item) => sum + n(item?.amountCents), 0);
  if (recorded > 0) return recorded;
  return summary.stripeRefundId ? n(summary.refundedAmount) : 0;
}

function labelReason(type = '') {
  return String(type || '')
    .replaceAll('_', ' ')
    .replaceAll('.', ' · ')
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function derivedExceptions(summaries = []) {
  const alerts = [];
  for (const summary of summaries) {
    const ticketId = summary.ticketId || 'Unknown ticket';
    const admissionActive = summary.status === 'paid';
    if (!admissionActive && ['pending_activation', 'active', 'exhausted'].includes(String(summary.drinkPackageStatus || ''))) {
      alerts.push({
        type: 'package_on_inactive_admission',
        severity: 'high',
        occurredAt: summary.updatedAt || summary.refundedAt || summary.paidAt || null,
        ticketId,
        message: 'Drink package remains usable while admission is inactive.'
      });
    }
    if (!admissionActive && summary.waterPackagePurchased && summary.waterPackageStatus === 'active') {
      alerts.push({
        type: 'water_on_inactive_admission',
        severity: 'high',
        occurredAt: summary.updatedAt || summary.refundedAt || summary.paidAt || null,
        ticketId,
        message: 'Unlimited water remains active while admission is inactive.'
      });
    }
    if (n(summary.drinkCreditsRemaining) < 0 || n(summary.drinkCreditsRedeemed) > n(summary.drinkCreditsPurchased)) {
      alerts.push({
        type: 'invalid_drink_balance',
        severity: 'high',
        occurredAt: summary.updatedAt || null,
        ticketId,
        message: 'Drink-credit balance is internally inconsistent.'
      });
    }
    if (summary.status === 'refunded' && summary.checkedInAt) {
      alerts.push({
        type: 'refund_after_checkin',
        severity: 'medium',
        occurredAt: summary.refundedAt || summary.updatedAt || null,
        ticketId,
        message: 'Refunded admission has a recorded event check-in.'
      });
    }
  }
  return alerts;
}

function auditExceptions(audits = []) {
  const interesting = audits.filter((record) => {
    const type = String(record?.type || '').toLowerCase();
    return type.includes('failed') || type.includes('disput') || type.includes('conflict') || type.includes('partial_failure') || type.includes('duplicate_refunded');
  });
  return interesting.slice(0, 30).map((record) => ({
    type: record.type,
    severity: String(record.type || '').includes('failed') || String(record.type || '').includes('disput') ? 'high' : 'medium',
    occurredAt: record.occurredAt || null,
    ticketId: record.ticketId || null,
    submissionId: record.submissionId || null,
    message: record.error || record.message || labelReason(record.type)
  }));
}

export function summarizeOperations({ summaries = [], redemptions = [], audits = [], guestNames = {} } = {}) {
  const validSummaries = summaries.filter(Boolean);
  const bar = {
    sixDrinkPackagesSold: 0,
    waterPackagesSold: 0,
    sixDrinkRevenueCents: 0,
    waterRevenueCents: 0,
    packageRevenueCents: 0,
    premiumUpgradeCents: 0,
    creditsSold: 0,
    creditsRedeemed: 0,
    creditsRemaining: 0,
    averageCreditsUsedPerPackage: 0,
    activeWristbands: 0,
    assignedWristbands: 0,
    drinkCounts: { beer: 0, well: 0, premium: 0, nonalcoholic: 0 },
    bartenders: []
  };

  const gate = {
    ticketsSold: 0,
    compTickets: 0,
    activeAdmissions: 0,
    checkedIn: 0,
    notYetCheckedIn: 0,
    grossAdmissionRevenueCents: 0,
    admissionRefundsCents: 0,
    netAdmissionRevenueCents: 0,
    attendancePercent: 0
  };

  for (const summary of validSummaries) {
    const comp = isComp(summary);
    const issuedAdmission = Boolean(summary.ticketId && ['paid', 'refunded', 'disputed'].includes(String(summary.status || '')));
    if (issuedAdmission) {
      if (comp) gate.compTickets += 1;
      else gate.ticketsSold += 1;
    }

    if (!comp) {
      gate.grossAdmissionRevenueCents += admissionAmount(summary);
      gate.admissionRefundsCents += admissionRefundAmount(summary);
    }

    if (summary.status === 'paid') {
      gate.activeAdmissions += 1;
      if (summary.checkedInAt) gate.checkedIn += 1;
      else gate.notYetCheckedIn += 1;
    }

    if (summary.drinkPackagePurchased) {
      bar.sixDrinkPackagesSold += 1;
      bar.sixDrinkRevenueCents += n(summary.drinkPackagePriceCents);
      bar.creditsSold += n(summary.drinkCreditsPurchased);
      bar.creditsRedeemed += n(summary.drinkCreditsRedeemed);
      bar.creditsRemaining += n(summary.drinkCreditsRemaining);
      bar.premiumUpgradeCents += n(summary.drinkPremiumUpgradeTotalCents);
      bar.drinkCounts.beer += n(summary.drinkBeerRedemptions);
      bar.drinkCounts.well += n(summary.drinkWellRedemptions);
      bar.drinkCounts.premium += n(summary.drinkPremiumRedemptions);
      bar.drinkCounts.nonalcoholic += n(summary.drinkNonalcoholicRedemptions);
      if (summary.drinkPackageStatus === 'active') bar.activeWristbands += 1;
      if (['active', 'exhausted'].includes(String(summary.drinkPackageStatus || '')) || summary.drinkPackageActivatedAt) bar.assignedWristbands += 1;
    }

    if (summary.waterPackagePurchased) {
      bar.waterPackagesSold += 1;
      bar.waterRevenueCents += n(summary.waterPackagePriceCents);
    }
  }

  bar.packageRevenueCents = bar.sixDrinkRevenueCents + bar.waterRevenueCents;
  bar.averageCreditsUsedPerPackage = bar.sixDrinkPackagesSold ? bar.creditsRedeemed / bar.sixDrinkPackagesSold : 0;
  gate.netAdmissionRevenueCents = Math.max(0, gate.grossAdmissionRevenueCents - gate.admissionRefundsCents);
  gate.attendancePercent = gate.activeAdmissions ? (gate.checkedIn / gate.activeAdmissions) * 100 : 0;

  const bartenderMap = new Map();
  for (const redemption of redemptions.filter(Boolean)) {
    const name = String(redemption.staffName || 'Unknown bartender').trim() || 'Unknown bartender';
    const current = bartenderMap.get(name) || { name, redemptions: 0, premiumUpgrades: 0, premiumUpgradeCents: 0, lastActivityAt: null };
    current.redemptions += 1;
    if (redemption.drinkType === 'premium') current.premiumUpgrades += 1;
    current.premiumUpgradeCents += n(redemption.premiumUpgradeCents);
    if (!current.lastActivityAt || new Date(redemption.redeemedAt || 0) > new Date(current.lastActivityAt || 0)) current.lastActivityAt = redemption.redeemedAt || null;
    bartenderMap.set(name, current);
  }
  bar.bartenders = [...bartenderMap.values()].sort((a, b) => b.redemptions - a.redemptions || String(a.name).localeCompare(String(b.name)));

  const recentCheckIns = audits
    .filter((record) => record?.type === 'ticket.checked_in')
    .slice(0, 20)
    .map((record) => ({
      occurredAt: record.occurredAt || null,
      ticketId: record.ticketId || null,
      submissionId: record.submissionId || null,
      guestName: record.guestName || guestNames[record.submissionId] || 'NOCTURNE Guest'
    }));

  const recentRedemptions = [...redemptions]
    .filter(Boolean)
    .sort((a, b) => new Date(b.redeemedAt || 0) - new Date(a.redeemedAt || 0))
    .slice(0, 20)
    .map((record) => ({
      redeemedAt: record.redeemedAt || null,
      ticketId: record.ticketId || null,
      submissionId: record.submissionId || null,
      guestName: guestNames[record.submissionId] || null,
      staffName: record.staffName || 'Unknown bartender',
      drinkType: record.drinkType || 'unknown',
      premiumUpgradeCents: n(record.premiumUpgradeCents),
      creditsRemaining: n(record.creditsRemaining),
      rapidOverride: Boolean(record.rapidOverride)
    }));

  const exceptions = [...derivedExceptions(validSummaries), ...auditExceptions(audits)]
    .sort((a, b) => new Date(b.occurredAt || 0) - new Date(a.occurredAt || 0))
    .slice(0, 30);

  return {
    bar,
    gate,
    live: {
      currentAttendance: gate.checkedIn,
      activeWristbands: bar.activeWristbands,
      assignedWristbands: bar.assignedWristbands,
      activeWaterPackages: validSummaries.filter((summary) => summary.waterPackagePurchased && summary.waterPackageStatus === 'active' && summary.status === 'paid').length,
      recentCheckIns,
      recentRedemptions,
      exceptions
    }
  };
}
