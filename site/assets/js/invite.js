const form = document.querySelector('#invite-form');
const result = document.querySelector('#invite-result');
const link = document.querySelector('#ticket-link');

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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Invitation could not be verified.');
    result.textContent = 'You’re in. Your private ticket access is ready.';
    link.href = data.ticketUrl;
    link.classList.add('visible');
  } catch (error) {
    result.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});
