(() => {
  const API = '/api/admin/launch';
  const section = document.querySelector('#admin-launch-tools');
  if (!section) return;

  const mode = section.querySelector('#launch-stripe-mode');
  const webhook = section.querySelector('#launch-stripe-webhook');
  const price = section.querySelector('#launch-stripe-price');
  const ready = section.querySelector('#launch-stripe-ready');
  const readyDetail = section.querySelector('#launch-stripe-ready-detail');
  const emailDomain = section.querySelector('#launch-email-domain');
  const emailDetail = section.querySelector('#launch-email-domain-detail');
  const reminders = section.querySelector('#launch-reminders');
  const backups = section.querySelector('#launch-backups');
  const secrets = section.querySelector('#launch-secrets');
  const appleWallet = section.querySelector('#launch-apple-wallet');
  const refresh = section.querySelector('#launch-refresh-stripe');
  const clearInvites = section.querySelector('#launch-clear-invites');
  const clearAll = section.querySelector('#launch-clear-all-test-data');
  const status = section.querySelector('#launch-status');

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

  function text(el, value) {
    if (el) el.textContent = value;
  }

  function restrictedSendOnlyKey(email = {}) {
    return /restricted to only send emails/i.test(String(email.error || email.diagnostic || ''));
  }

  async function request(options = {}) {
    const response = await fetch(API, {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {})
      },
      ...options
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  }

  async function loadStripe() {
    refresh.disabled = true;
    text(status, 'Checking Stripe and Resend configuration…');
    try {
      const data = await request();
      const stripe = data.stripe || {};
      const email = data.email || {};
      const operations = data.operations || {};
      const displayedMode = stripe.apiMode || stripe.keyMode || 'unknown';
      const sendOnlyKey = restrictedSendOnlyKey(email);

      text(mode, displayedMode === 'live' ? 'LIVE' : displayedMode === 'test' ? 'TEST' : displayedMode.toUpperCase());
      text(webhook, stripe.webhookEndpointConfigured && stripe.webhookEventsConfigured && stripe.webhookSecretConfigured ? 'Configured' : 'Needs attention');
      text(price, money(stripe.priceCents, stripe.currency));

      if (stripe.readyForLive && stripe.livePaymentVerified) {
        text(ready, 'LIVE VERIFIED');
        const payment = stripe.livePayment || {};
        const packageParts = [];
        if (payment.drinkPackageIncluded) packageParts.push('Six-Drink');
        if (payment.waterPackageIncluded) packageParts.push('Water');
        text(readyDetail, `Successful live payment received · ${money(payment.amountTotal, payment.currency)} · ${dateTime(payment.receivedAt)}${packageParts.length ? ` · ${packageParts.join(' + ')}` : ''}`);
      } else if (stripe.configurationReady) {
        text(ready, 'Ready for final live payment test');
        text(readyDetail, stripe.livePaymentCheckError ? `Payment evidence check error: ${stripe.livePaymentCheckError}` : 'Live Stripe configuration is complete, but no completed paid NOCTURNE admission checkout was found yet.');
      } else {
        text(ready, 'Not live-ready');
        text(readyDetail, 'Stripe live configuration is incomplete.');
      }

      if (email.sendingEnabled) {
        text(emailDomain, 'Verified');
        text(emailDetail, email.diagnostic || 'Resend sending domain is verified.');
      } else if (sendOnlyKey && email.configured) {
        text(emailDomain, 'Send-only key');
        text(emailDetail, `Operational email credentials configured${email.domainName ? ` for ${email.domainName}` : ''}. Domain-management lookup is unavailable because this Resend API key is intentionally restricted to sending only. Resend: ${email.error || 'This API key is restricted to only send emails.'}`);
      } else {
        text(emailDomain, email.configured ? (email.domainStatus || 'Needs attention') : 'Not configured');
        text(emailDetail, email.diagnostic || 'No Resend diagnostic returned.');
      }

      text(reminders, operations.purchaseRemindersEnabled ? 'Enabled' : 'Disabled');
      text(backups, operations.backupsEnabled ? `${operations.backupRetentionDays || 30} days` : 'Disabled');
      text(secrets, operations.dedicatedSecretsReady ? 'Separated' : 'Needs attention');
      text(appleWallet, operations.appleWallet?.configured ? 'Ready' : 'Needs certificate');

      if (stripe.error) text(status, `Stripe check: ${stripe.error}`);
      else if (stripe.readyForLive) text(status, 'LIVE VERIFIED — Stripe configuration is complete and a successful live NOCTURNE admission payment was found.');
      else if (stripe.configurationReady) text(status, 'Live Stripe configuration is complete. Waiting for successful live admission payment evidence.');
      else text(status, 'Stripe is not fully live yet.');
    } catch (error) {
      text(status, error.message || 'Launch readiness could not be checked.');
    } finally {
      refresh.disabled = false;
    }
  }

  async function clearInvitations() {
    const warning = 'This will permanently delete ALL invitation codes and clear invitation lifecycle data from every application. Applications and ticket records will be preserved.\n\nType CLEAR INVITATIONS to continue.';
    const confirm = window.prompt(warning);
    if (confirm === null) return;
    if (confirm !== 'CLEAR INVITATIONS') {
      text(status, 'Invitation cleanup cancelled — confirmation phrase did not match.');
      return;
    }

    clearInvites.disabled = true;
    text(status, 'Clearing invitation records…');
    try {
      const result = await request({
        method: 'POST',
        body: JSON.stringify({ action: 'clear-invitations', confirm })
      });
      text(status, `Invitation cleanup complete: ${result.deletedInviteBlobs || 0} invite records deleted and ${result.reviewsReset || 0} application records reset.`);
    } catch (error) {
      text(status, error.message || 'Invitation cleanup failed.');
    } finally {
      clearInvites.disabled = false;
    }
  }

  async function clearAllTestData() {
    const warning = 'DANGER: This permanently deletes ALL current application, review, invitation, ticket/order, refund, complimentary-ticket, and check-in data stored by NOCTURNE. This is intended only for the final pre-launch reset.\n\nThis does NOT delete transactions already stored in Stripe.\n\nType CLEAR ALL TEST DATA to continue.';
    const confirm = window.prompt(warning);
    if (confirm === null) return;
    if (confirm !== 'CLEAR ALL TEST DATA') {
      text(status, 'Full test-data cleanup cancelled — confirmation phrase did not match.');
      return;
    }

    clearAll.disabled = true;
    clearInvites.disabled = true;
    text(status, 'Deleting all NOCTURNE test data…');
    try {
      const result = await request({
        method: 'POST',
        body: JSON.stringify({ action: 'clear-all-test-data', confirm })
      });
      text(status, `Full cleanup complete: ${result.deletedApplications || 0} applications, ${result.deletedReviews || 0} reviews, ${result.deletedInvites || 0} invitations, and ${result.deletedOrders || 0} ticket/order records deleted.`);
    } catch (error) {
      text(status, error.message || 'Full test-data cleanup failed.');
    } finally {
      clearAll.disabled = false;
      clearInvites.disabled = false;
    }
  }

  refresh?.addEventListener('click', loadStripe);
  clearInvites?.addEventListener('click', clearInvitations);
  clearAll?.addEventListener('click', clearAllTestData);
  window.setTimeout(loadStripe, 700);
})();
