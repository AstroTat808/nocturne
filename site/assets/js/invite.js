const form = document.querySelector('#invite-form');
const result = document.querySelector('#invite-result');
const link = document.querySelector('#ticket-link');

function showQueryError() {
  const message = new URLSearchParams(window.location.search).get('error');
  if (message && result) result.textContent = message;
}

showQueryError();

form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = form.querySelector('button[type="submit"]');
  const code = new FormData(form).get('code');
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

    result.textContent = data.temporaryAccess
      ? 'Invitation accepted. Opening your private access…'
      : 'You’re in. Your private ticket access is ready.';

    link.href = data.ticketUrl;
    link.classList.add('visible');

    if (data.temporaryAccess) {
      window.setTimeout(() => window.location.assign(data.ticketUrl), 650);
    }
  } catch (error) {
    result.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});
