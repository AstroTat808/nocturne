(() => {
  const API = '/api/admin/launch';
  const section = document.querySelector('#admin-launch-tools');
  if (!section) return;

  const $ = (selector) => section.querySelector(selector);
  const els = {
    overall: $('#launch-overall'), overallDetail: $('#launch-overall-detail'),
    mode: $('#launch-stripe-mode'), webhook: $('#launch-stripe-webhook'), price: $('#launch-stripe-price'),
    payment: $('#launch-stripe-ready'), paymentDetail: $('#launch-stripe-ready-detail'),
    fulfillment: $('#launch-fulfillment'), fulfillmentDetail: $('#launch-fulfillment-detail'),
    turnstile: $('#launch-turnstile'), venue: $('#launch-venue'), signing: $('#launch-ticket-signing'),
    gate: $('#launch-gate'), bar: $('#launch-bar'), secrets: $('#launch-secrets'),
    email: $('#launch-email-domain'), emailDetail: $('#launch-email-domain-detail'),
    drink: $('#launch-drink-package'), drinkDetail: $('#launch-drink-package-detail'),
    water: $('#launch-water-package'), waterDetail: $('#launch-water-package-detail'),
    inviteReminders: $('#launch-invite-reminders'), purchaseReminders: $('#launch-reminders'),
    backups: $('#launch-backups'), backupDetail: $('#launch-backup-detail'),
    wallet: $('#launch-apple-wallet'), walletDetail: $('#launch-wallet-detail'),
    rehearsalPercent: $('#launch-rehearsal-percent'), rehearsalPassed: $('#launch-rehearsal-passed'),
    rehearsalFailed: $('#launch-rehearsal-failed'), rehearsalPending: $('#launch-rehearsal-pending'),
    refresh: $('#launch-refresh-stripe'), clearInvites: $('#launch-clear-invites'), clearAll: $('#launch-clear-all-test-data'),
    status: $('#launch-status')
  };

  function money(cents, currency) {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: String(currency || 'usd').toUpperCase() }).format(Number(cents || 0) / 100);
    } catch {
      return `${String(currency || 'usd').toUpperCase()} ${(Number(cents || 0) / 100).toFixed(2)}`;
    }
  }

  function dateTime(value) {
    if (!value) return 'unknown time';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }

  function text(el, value) { if (el) el.textContent = value; }
  function yesNo(value, yes = 'READY', no = 'NEEDS ATTENTION') { return value ? yes : no; }

  async function request(options = {}) {
    const response = await fetch(API, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
      ...options
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  }

  function renderStripe(stripe = {}) {
    const displayedMode = stripe.apiMode || stripe.keyMode || 'unknown';
    text(els.mode, displayedMode === 'live' ? 'LIVE' : displayedMode === 'test' ? 'TEST' : displayedMode.toUpperCase());
    text(els.webhook, stripe.webhookEndpointConfigured && stripe.webhookEventsConfigured && stripe.webhookSecretConfigured ? 'CONFIGURED' : 'NEEDS ATTENTION');
    text(els.price, money(stripe.priceCents, stripe.currency));

    if (stripe.livePaymentVerified) {
      const payment = stripe.livePayment || {};
      const packageParts = [];
      if (payment.drinkPackageIncluded) packageParts.push('Six-Drink');
      if (payment.waterPackageIncluded) packageParts.push('Water');
      text(els.payment, 'LIVE VERIFIED');
      text(els.paymentDetail, `Successful payment · ${money(payment.amountTotal, payment.currency)} · ${dateTime(payment.receivedAt)}${packageParts.length ? ` · ${packageParts.join(' + ')}` : ''}`);
    } else {
      text(els.payment, stripe.configurationReady ? 'AWAITING PAYMENT' : 'NOT LIVE-READY');
      text(els.paymentDetail, stripe.livePaymentCheckError || 'No completed paid NOCTURNE admission checkout was found.');
    }

    const fulfillment = stripe.fulfillment || {};
    if (stripe.fulfillmentVerified) {
      text(els.fulfillment, 'VERIFIED');
      text(els.fulfillmentDetail, `Stripe checkout fulfilled as ticket ${fulfillment.ticketId || 'issued'} · ${dateTime(fulfillment.paidAt)} · current state ${String(fulfillment.currentStatus || 'unknown').replaceAll('_', ' ')}`);
    } else {
      text(els.fulfillment, 'NEEDS ATTENTION');
      text(els.fulfillmentDetail, fulfillment.error || 'No matching fulfilled ticket record was found for the live payment.');
    }
  }

  function renderEmail(email = {}) {
    if (email.sendingEnabled) {
      text(els.email, 'VERIFIED');
      text(els.emailDetail, email.diagnostic || 'Resend sending domain is verified.');
    } else if (email.operational && email.restrictedSendOnlyKey) {
      text(els.email, 'SEND-ONLY KEY');
      text(els.emailDetail, `Operational sending credentials configured${email.domainName ? ` for ${email.domainName}` : ''}. Domain-management lookup is intentionally unavailable with this restricted key.`);
    } else {
      text(els.email, email.configured ? 'NEEDS ATTENTION' : 'NOT CONFIGURED');
      text(els.emailDetail, email.diagnostic || email.error || 'No Resend diagnostic returned.');
    }
  }

  function renderOperations(operations = {}, backup = {}) {
    text(els.turnstile, yesNo(operations.turnstile?.ready));
    text(els.venue, yesNo(operations.venue?.ready));
    text(els.signing, yesNo(operations.ticketing?.signingReady));
    text(els.gate, yesNo(operations.ticketing?.gateReady));
    text(els.bar, yesNo(operations.ticketing?.barReady));
    text(els.secrets, operations.dedicatedSecretsReady ? 'SEPARATED' : 'NEEDS ATTENTION');

    const drink = operations.packages?.drink || {};
    text(els.drink, drink.expected ? 'VERIFIED' : 'CHECK CONFIG');
    text(els.drinkDetail, `${drink.enabled ? 'Enabled' : 'Disabled'} · ${money(drink.priceCents, 'usd')} · ${Number(drink.credits || 0)} credits · ${money(drink.premiumUpgradeCents, 'usd')} premium upgrade`);

    const water = operations.packages?.water || {};
    text(els.water, water.expected ? 'VERIFIED' : 'CHECK CONFIG');
    text(els.waterDetail, `${water.enabled ? 'Enabled' : 'Disabled'} · ${money(water.priceCents, 'usd')}`);

    text(els.inviteReminders, operations.inviteRemindersEnabled ? 'ENABLED' : 'DISABLED');
    text(els.purchaseReminders, operations.purchaseRemindersEnabled ? 'ENABLED' : 'DISABLED');

    if (backup.healthy) {
      text(els.backups, 'HEALTHY');
      text(els.backupDetail, `Last successful backup ${dateTime(backup.lastSuccessfulAt)} · ${backup.recordCount ?? 'unknown'} records · ${backup.retentionDays || 30}-day retention`);
    } else {
      text(els.backups, 'NEEDS ATTENTION');
      text(els.backupDetail, backup.error || 'No recent successful backup was found.');
    }

    if (operations.appleWallet?.configured) {
      text(els.wallet, 'READY');
      text(els.walletDetail, 'Apple Wallet signing is configured. Optional feature; not required for core launch readiness.');
    } else {
      text(els.wallet, 'DEFERRED');
      text(els.walletDetail, 'Certificate setup intentionally deferred · optional and not launch-blocking.');
    }
  }

  function renderRehearsal(rehearsal = {}) {
    if (!rehearsal.available) {
      text(els.rehearsalPercent, 'UNAVAILABLE');
      text(els.rehearsalPassed, '—');
      text(els.rehearsalFailed, '—');
      text(els.rehearsalPending, '—');
      return;
    }
    text(els.rehearsalPercent, `${rehearsal.percent || 0}%`);
    text(els.rehearsalPassed, String(rehearsal.passed || 0));
    text(els.rehearsalFailed, String(rehearsal.failed || 0));
    text(els.rehearsalPending, String(rehearsal.pending || 0));
  }

  function renderOverall(overall = {}, rehearsal = {}) {
    const coreReady = Boolean(overall.coreReady);
    const rehearsalReady = Boolean(rehearsal.available && rehearsal.ready);
    if (coreReady && rehearsalReady) {
      text(els.overall, 'LAUNCH READY');
      text(els.overallDetail, 'Core production systems are ready and the rehearsal checklist has no failures or pending items.');
      return;
    }
    if (!coreReady) {
      text(els.overall, 'ACTION REQUIRED');
      const blockers = Array.isArray(overall.blockers) ? overall.blockers : [];
      const rehearsalNote = rehearsal.available && !rehearsal.ready ? ` Rehearsal also has ${rehearsal.failed || 0} failure(s) and ${rehearsal.pending || 0} pending item(s).` : '';
      text(els.overallDetail, `Core blocker${blockers.length === 1 ? '' : 's'}: ${blockers.length ? blockers.join(' · ') : 'unknown'}.${rehearsalNote}`);
      return;
    }
    text(els.overall, 'CORE READY · REHEARSAL INCOMPLETE');
    text(els.overallDetail, rehearsal.available ? `Production systems are ready. Rehearsal has ${rehearsal.failed || 0} failure(s) and ${rehearsal.pending || 0} pending item(s).` : 'Production systems are ready, but rehearsal status could not be loaded.');
  }

  async function loadReadiness() {
    els.refresh.disabled = true;
    text(els.status, 'Checking production readiness…');
    try {
      const data = await request();
      renderStripe(data.stripe || {});
      renderEmail(data.email || {});
      renderOperations(data.operations || {}, data.backup || {});
      renderRehearsal(data.rehearsal || {});
      renderOverall(data.overall || {}, data.rehearsal || {});
      text(els.status, 'Readiness check complete. Apple Wallet is excluded from core launch blockers while certificate setup is deferred.');
    } catch (error) {
      text(els.status, error.message || 'Launch readiness could not be checked.');
      text(els.overall, 'CHECK FAILED');
      text(els.overallDetail, 'The readiness endpoint could not complete. Review the status message below.');
    } finally {
      els.refresh.disabled = false;
    }
  }

  async function clearInvitations() {
    const warning = 'This will permanently delete ALL invitation codes and clear invitation lifecycle data from every application. Applications and ticket records will be preserved.\n\nType CLEAR INVITATIONS to continue.';
    const confirm = window.prompt(warning);
    if (confirm === null) return;
    if (confirm !== 'CLEAR INVITATIONS') { text(els.status, 'Invitation cleanup cancelled — confirmation phrase did not match.'); return; }
    els.clearInvites.disabled = true;
    text(els.status, 'Clearing invitation records…');
    try {
      const result = await request({ method: 'POST', body: JSON.stringify({ action: 'clear-invitations', confirm }) });
      text(els.status, `Invitation cleanup complete: ${result.deletedInviteBlobs || 0} invite records deleted and ${result.reviewsReset || 0} application records reset.`);
    } catch (error) {
      text(els.status, error.message || 'Invitation cleanup failed.');
    } finally { els.clearInvites.disabled = false; }
  }

  async function clearAllTestData() {
    const warning = 'DANGER: This permanently deletes ALL current application, review, invitation, ticket/order, refund, complimentary-ticket, and check-in data stored by NOCTURNE. This is intended only for the final pre-launch reset.\n\nThis does NOT delete transactions already stored in Stripe.\n\nType CLEAR ALL TEST DATA to continue.';
    const confirm = window.prompt(warning);
    if (confirm === null) return;
    if (confirm !== 'CLEAR ALL TEST DATA') { text(els.status, 'Full test-data cleanup cancelled — confirmation phrase did not match.'); return; }
    els.clearAll.disabled = true;
    els.clearInvites.disabled = true;
    text(els.status, 'Deleting all NOCTURNE test data…');
    try {
      const result = await request({ method: 'POST', body: JSON.stringify({ action: 'clear-all-test-data', confirm }) });
      text(els.status, `Full cleanup complete: ${result.deletedApplications || 0} applications, ${result.deletedReviews || 0} reviews, ${result.deletedInvites || 0} invitations, and ${result.deletedOrders || 0} ticket/order records deleted.`);
    } catch (error) {
      text(els.status, error.message || 'Full test-data cleanup failed.');
    } finally {
      els.clearAll.disabled = false;
      els.clearInvites.disabled = false;
    }
  }

  els.refresh?.addEventListener('click', loadReadiness);
  els.clearInvites?.addEventListener('click', clearInvitations);
  els.clearAll?.addEventListener('click', clearAllTestData);
  window.setTimeout(loadReadiness, 500);
})();
