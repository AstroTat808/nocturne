(() => {
  const form = document.querySelector('#admin-reminder-test-form');
  const email = document.querySelector('#admin-reminder-test-email');
  const submit = document.querySelector('#admin-reminder-test-submit');
  const status = document.querySelector('#admin-reminder-test-status');
  if (!form || !email || !submit || !status) return;

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
})();
