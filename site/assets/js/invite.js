const form = document.querySelector('#invite-form');
const result = document.querySelector('#invite-result');
const link = document.querySelector('#ticket-link');
const codeInput = form?.querySelector('[name="code"]');

function normalizeCode(value = '') {
  return String(value).trim().toUpperCase().replace(/\s+/g, '');
}

function showQueryState() {
  const params = new URLSearchParams(window.location.search);
  const message = params.get('error');
  const code = normalizeCode(params.get('code') || '');

  if (message && result) result.textContent = message;
  if (codeInput && /^NOC-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)) {
    codeInput.value = code;
    if (result && !message) result.textContent = 'Your invitation code is ready. Verify it below to continue.';
    codeInput.focus();
  }
}

showQueryState();

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = form.querySelector('button[type="submit"]');
  const code = normalizeCode(new FormData(form).get('code'));
  if (codeInput) codeInput.value = code;
  result.textContent = 'Verifying invitation…';
  link.classList.remove('visible');
  link.removeAttribute('href');
  submit.disabled = true;

  try {
    const response = await fetch('/api/redeem-invite', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Nocturne-Ajax': '1'
      },
      credentials: 'same-origin',
      body: JSON.stringify({ code })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Invitation could not be verified.');

    result.textContent = data.builtInCheckout
      ? 'Invitation accepted. Opening your private ticket checkout…'
      : data.temporaryAccess
        ? 'Invitation accepted. Opening your private access…'
        : 'You’re in. Your private ticket access is ready.';

    link.href = data.ticketUrl;
    link.classList.add('visible');

    if (data.temporaryAccess || data.builtInCheckout) {
      window.setTimeout(() => window.location.assign(data.ticketUrl), 650);
    }
  } catch (error) {
    result.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});
