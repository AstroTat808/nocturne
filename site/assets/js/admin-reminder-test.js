(() => {
  const form = document.querySelector('#admin-reminder-test-form');
  const email = document.querySelector('#admin-reminder-test-email');
  const submit = document.querySelector('#admin-reminder-test-submit');
  const status = document.querySelector('#admin-reminder-test-status');

  if (form && email && submit && status) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const recipient = email.value.trim().toLowerCase();
      if (!recipient) return;
      if (!window.confirm(`Send the real NOCTURNE purchase reminder to exactly ${recipient}? No other applicant will be emailed by this test.`)) return;

      submit.disabled = true;
      status.textContent = `Sending one reminder to ${recipient}…`;
      try {
        const response = await fetch('/api/admin/dashboard', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ action: 'send-purchase-reminder-test', email: recipient })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'The controlled reminder could not be sent.');
        status.textContent = `Sent successfully to ${data.recipient}. No other applicants were emailed.`;
      } catch (error) {
        status.textContent = error.message || 'The controlled reminder could not be sent.';
      } finally {
        submit.disabled = false;
      }
    });
  }

  function injectManualRunPanel() {
    if (document.querySelector('#admin-run-daily-reminders')) return;
    const anchor = document.querySelector('.admin-reminder-test');
    if (!anchor) return;

    const panel = document.createElement('section');
    panel.className = 'admin-reminder-run';
    panel.setAttribute('aria-labelledby', 'admin-reminder-run-title');
    panel.innerHTML = `
      <div>
        <p class="admin-kicker">Reminder operations</p>
        <h2 id="admin-reminder-run-title">Send daily reminders now.</h2>
        <p>Runs both live reminder streams immediately using the same eligibility rules as the automated jobs: approved guests with an unredeemed invitation, and guests who redeemed but have not purchased admission.</p>
        <p class="admin-reminder-run-note">Applicants who already received today's reminder are automatically skipped.</p>
      </div>
      <div class="admin-reminder-run-action">
        <button id="admin-run-daily-reminders" class="btn" type="button">Send Daily Reminders Now →</button>
        <p id="admin-run-daily-reminders-status" class="admin-status" role="status" aria-live="polite"></p>
      </div>`;
    anchor.insertAdjacentElement('afterend', panel);

    const button = panel.querySelector('#admin-run-daily-reminders');
    const runStatus = panel.querySelector('#admin-run-daily-reminders-status');
    button.addEventListener('click', async () => {
      const confirmed = window.confirm('Send today’s NOCTURNE reminder emails now to every currently eligible applicant? Applicants already emailed today will be skipped automatically.');
      if (!confirmed) return;

      button.disabled = true;
      runStatus.classList.remove('error');
      runStatus.textContent = 'Running invitation and ticket-purchase reminders…';
      try {
        const response = await fetch('/api/admin/send-reminders-now', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'run-daily-reminders' })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'The reminder run could not be completed.');

        const invite = data.invite || {};
        const purchase = data.purchase || {};
        const total = data.total || {};
        const parts = [
          `Sent ${Number(total.sent || 0)} total`,
          `${Number(invite.sent || 0)} unredeemed-invite`,
          `${Number(purchase.sent || 0)} redeemed-but-unpaid`,
          `${Number(total.duplicate || 0)} already sent today`,
          `${Number(total.failed || 0)} failed`
        ];
        const unavailable = [];
        if (invite.enabled === false || invite.reason) unavailable.push(`Invite stream: ${invite.reason || 'disabled'}`);
        if (purchase.enabled === false || purchase.reason) unavailable.push(`Purchase stream: ${purchase.reason || 'disabled'}`);
        runStatus.textContent = `${parts.join(' · ')}${unavailable.length ? ` · ${unavailable.join(' · ')}` : ''}`;
        if (Number(total.failed || 0) > 0 || unavailable.length) runStatus.classList.add('error');
      } catch (error) {
        runStatus.textContent = error.message || 'The reminder run could not be completed.';
        runStatus.classList.add('error');
      } finally {
        button.disabled = false;
      }
    });
  }

  function injectBulkDrinkOfferButton() {
    if (document.querySelector('#admin-send-bulk-drink-offer')) return;
    const overview = document.querySelector('.admin-drink-overview');
    if (!overview) return;

    const panel = document.createElement('div');
    panel.className = 'admin-drink-bulk-offer';
    panel.innerHTML = `
      <div>
        <strong>Ticket-holder add-on campaign</strong>
        <p class="admin-muted">Email current paid or checked-in ticket holders about eligible add-ons they do not already have: the $55 Six-Drink Package, $15 Unlimited Drinking Water, and $20 Late Checkout / Car Camping while its 30-person capacity remains available.</p>
      </div>
      <div>
        <button id="admin-send-bulk-drink-offer" class="admin-outline-button" type="button">Email Ticket Add-On Offer →</button>
        <p id="admin-send-bulk-drink-offer-status" class="admin-status" role="status" aria-live="polite"></p>
      </div>`;
    overview.append(panel);

    const button = panel.querySelector('#admin-send-bulk-drink-offer');
    const result = panel.querySelector('#admin-send-bulk-drink-offer-status');
    button.addEventListener('click', async () => {
      if (!window.confirm('Email NOCTURNE ticket holders now about any eligible Six-Drink, Unlimited Water, and Late Checkout / Car Camping add-ons they do not already have? Guests already sent this campaign today will be skipped.')) return;
      button.disabled = true;
      result.classList.remove('error');
      result.textContent = 'Finding eligible ticket holders and sending add-on offers…';
      try {
        const response = await fetch('/api/admin/bulk-drink-package-offer', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'send-bulk-ticket-addon-offer' })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'The ticket add-on campaign could not be completed.');
        const lateCapacity = data.lateStaySoldOut ? 'late stay sold out' : `${Number(data.lateStayRemaining || 0)} late-stay spots remaining`;
        result.textContent = `Sent ${Number(data.sent || 0)} offer${Number(data.sent || 0) === 1 ? '' : 's'} · ${Number(data.multiOffers || 0)} multiple add-ons · ${Number(data.drinkOnly || 0)} drink only · ${Number(data.waterOnly || 0)} water only · ${Number(data.lateStayOnly || 0)} late stay only · ${lateCapacity} · ${Number(data.duplicate || 0)} already sent today · ${Number(data.ineligible || 0)} not eligible · ${Number(data.failed || 0)} failed`;
        if (Number(data.failed || 0) > 0) result.classList.add('error');
      } catch (error) {
        result.textContent = error.message || 'The ticket add-on campaign could not be completed.';
        result.classList.add('error');
      } finally {
        button.disabled = false;
      }
    });
  }

  injectManualRunPanel();
  injectBulkDrinkOfferButton();
  new MutationObserver(() => {
    injectManualRunPanel();
    injectBulkDrinkOfferButton();
  }).observe(document.documentElement, { childList: true, subtree: true });
})();

import('/assets/js/admin-ticket-source-stats.js?v=20260901b').catch((error) => {
  console.warn('NOCTURNE ticket-holder stat enhancement unavailable:', error);
});
