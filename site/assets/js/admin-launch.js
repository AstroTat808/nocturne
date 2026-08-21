(() => {
  const API = '/api/admin/launch';
  const section = document.querySelector('#admin-launch-tools');
  if (!section) return;

  const mode = section.querySelector('#launch-stripe-mode');
  const webhook = section.querySelector('#launch-stripe-webhook');
  const price = section.querySelector('#launch-stripe-price');
  const ready = section.querySelector('#launch-stripe-ready');
  const refresh = section.querySelector('#launch-refresh-stripe');
  const clear = section.querySelector('#launch-clear-invites');
  const status = section.querySelector('#launch-status');

  function money(cents, currency) {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: String(currency || 'usd').toUpperCase() }).format(Number(cents || 0) / 100);
    } catch {
      return `${String(currency || 'usd').toUpperCase()} ${(Number(cents || 0) / 100).toFixed(2)}`;
    }
  }

  function text(el, value) {
    if (el) el.textContent = value;
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
    text(status, 'Checking Stripe configuration…');
    try {
      const data = await request();
      const stripe = data.stripe || {};
      const displayedMode = stripe.apiMode || stripe.keyMode || 'unknown';
      text(mode, displayedMode === 'live' ? 'LIVE' : displayedMode === 'test' ? 'TEST' : displayedMode.toUpperCase());
      text(webhook, stripe.webhookEndpointConfigured && stripe.webhookEventsConfigured && stripe.webhookSecretConfigured ? 'Configured' : 'Needs attention');
      text(price, money(stripe.priceCents, stripe.currency));
      text(ready, stripe.readyForLive ? 'Ready for final live payment test' : 'Not live-ready');
      text(status, stripe.error ? `Stripe check: ${stripe.error}` : stripe.readyForLive ? 'Live configuration detected. Complete one small real payment before opening sales.' : 'Stripe is not fully live yet.');
    } catch (error) {
      text(status, error.message || 'Stripe configuration could not be checked.');
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

    clear.disabled = true;
    text(status, 'Clearing invitation records…');
    try {
      const result = await request({
        method: 'POST',
        body: JSON.stringify({ action: 'clear-invitations', confirm })
      });
      text(status, `Invitation cleanup complete: ${result.deletedInviteBlobs || 0} invite records deleted and ${result.reviewsReset || 0} application records reset.`);
      document.querySelector('#admin-refresh')?.click();
    } catch (error) {
      text(status, error.message || 'Invitation cleanup failed.');
    } finally {
      clear.disabled = false;
    }
  }

  refresh?.addEventListener('click', loadStripe);
  clear?.addEventListener('click', clearInvitations);

  document.querySelector('#admin-refresh')?.addEventListener('click', () => window.setTimeout(loadStripe, 100));
  window.setTimeout(loadStripe, 700);
})();
