(() => {
  const EMAIL_API = '/api/admin/approval-email';

  async function request(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      },
      ...options
    });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  }

  function modalStatus(message, error = false) {
    const el = document.querySelector('#invite-copy-status');
    if (!el) return;
    el.textContent = message;
    el.classList.toggle('error', Boolean(error));
  }

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('#send-approval-email');
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();

    const code = document.querySelector('#generated-invite-code')?.textContent?.trim() || '';
    const subject = document.querySelector('#approval-email-subject')?.value || 'Your NOCTURNE invitation';
    const note = document.querySelector('#approval-email-note')?.value || '';
    if (!code) return modalStatus('Invitation code is missing.', true);

    button.disabled = true;
    modalStatus('Sending approval email…');
    try {
      const result = await request(EMAIL_API, {
        method: 'POST',
        body: JSON.stringify({ code, subject, note })
      });
      modalStatus(`Approval email sent to ${result.recipient}. The verification link includes their invite code.`);
      document.querySelector('#admin-refresh')?.click();
    } catch (error) {
      modalStatus(error.message || 'Approval email could not be sent.', true);
    } finally {
      button.disabled = false;
    }
  }, true);
})();
