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
        runStatus.textContent = parts.join(' · ');
        if (Number(total.failed || 0) > 0) runStatus.classList.add('error');
      } catch (error) {
        runStatus.textContent = error.message || 'The reminder run could not be completed.';
        runStatus.classList.add('error');
      } finally {
        button.disabled = false;
      }
    });
  }

  injectManualRunPanel();
  new MutationObserver(injectManualRunPanel).observe(document.documentElement, { childList: true, subtree: true });
})();
