(() => {
  const API = '/api/admin/application-diagnostic';
  const form = document.querySelector('#admin-application-diagnostic-form');
  const email = document.querySelector('#admin-diagnostic-email');
  const phone = document.querySelector('#admin-diagnostic-phone');
  const submit = document.querySelector('#admin-diagnostic-submit');
  const status = document.querySelector('#admin-diagnostic-status');
  const results = document.querySelector('#admin-diagnostic-results');
  if (!form || !email || !phone || !submit || !status || !results) return;

  function setDiagnosticStatus(message, isError = false) {
    status.textContent = message;
    status.classList.toggle('error', isError);
  }

  function formatDateTime(value) {
    if (!value) return 'Unknown submission time';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Unknown submission time' : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  }

  function selectApplicant(id) {
    const application = state.applications.find((item) => item.id === id);
    if (!application) {
      setDiagnosticStatus('The record exists in storage but is not in the loaded list. Refresh the dashboard and run the diagnostic again.', true);
      return;
    }
    state.selectedId = id;
    els.search.value = '';
    els.statusFilter.value = 'all';
    if (els.inviteFilter) els.inviteFilter.value = 'all';
    if (els.ticketFilter) els.ticketFilter.value = 'all';
    renderList();
    renderDetail();
    document.querySelector('.admin-workspace')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderDiagnostic(data) {
    results.replaceChildren();
    const matches = Array.isArray(data.matches) ? data.matches : [];

    const summary = document.createElement('div');
    summary.className = `admin-diagnostic-summary ${data.permanentDuplicateBlocked ? 'blocked' : 'clear'}`;
    const title = document.createElement('strong');
    title.textContent = data.permanentDuplicateBlocked
      ? `Permanent duplicate guard: BLOCKED by ${matches.length} record${matches.length === 1 ? '' : 's'}`
      : 'Permanent duplicate guard: CLEAR';
    const detail = document.createElement('span');
    detail.textContent = data.permanentDuplicateBlocked
      ? `${Number(data.emailMatches || 0)} email match${Number(data.emailMatches || 0) === 1 ? '' : 'es'} · ${Number(data.phoneMatches || 0)} phone match${Number(data.phoneMatches || 0) === 1 ? '' : 'es'}`
      : 'No stored application matches the supplied email or phone.';
    summary.append(title, detail);
    results.append(summary);

    const lock = document.createElement('div');
    lock.className = `admin-diagnostic-summary ${data.emailRateLock?.active ? 'blocked' : 'clear'}`;
    const lockTitle = document.createElement('strong');
    lockTitle.textContent = data.emailRateLock?.active ? 'Temporary email lock: ACTIVE' : 'Temporary email lock: CLEAR';
    const lockDetail = document.createElement('span');
    lockDetail.textContent = data.emailRateLock?.active
      ? `Expires in about ${Math.max(1, Math.ceil(Number(data.emailRateLock.retryAfterSeconds || 0) / 60))} minute(s).`
      : data.checked?.email ? 'No active 30-minute submission lock for this email.' : 'Enter an email to check the 30-minute submission lock.';
    lock.append(lockTitle, lockDetail);
    results.append(lock);

    for (const match of matches) {
      const card = document.createElement('article');
      card.className = 'admin-diagnostic-match';
      const head = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = match.fullName || 'Unnamed applicant';
      const id = document.createElement('code');
      id.textContent = match.id || 'Unknown record ID';
      head.append(name, id);

      const badges = document.createElement('div');
      badges.className = 'admin-diagnostic-badges';
      for (const field of match.matchedBy || []) {
        const badge = document.createElement('span');
        badge.textContent = `${field} match`;
        badges.append(badge);
      }

      const contact = document.createElement('p');
      contact.textContent = [match.email, match.phone, formatDateTime(match.createdAt)].filter(Boolean).join(' · ');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'admin-outline-button';
      button.textContent = 'Open applicant';
      button.addEventListener('click', () => selectApplicant(match.id));
      card.append(head, badges, contact, button);
      results.append(card);
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    results.replaceChildren();
    setDiagnosticStatus('Checking live application records…');
    try {
      const response = await fetch(API, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.value, phone: phone.value })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(data.error || 'The diagnostic could not be completed.'), { status: response.status });
      renderDiagnostic(data);
      setDiagnosticStatus(data.blocked ? 'Blocking identity found.' : 'This identity is clear to submit.');
    } catch (error) {
      if (error.status === 401) setDiagnosticStatus('Your admin session expired. Sign in again.', true);
      else setDiagnosticStatus(error.message || 'The diagnostic could not be completed.', true);
    } finally {
      submit.disabled = false;
    }
  });
})();
