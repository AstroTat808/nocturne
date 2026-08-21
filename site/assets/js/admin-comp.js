(() => {
  const API = '/api/admin/dashboard';
  const COMP_API = '/api/admin/comp-ticket';
  let applications = [];
  let loading = null;

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

  async function loadApplications(force = false) {
    if (applications.length && !force) return applications;
    if (loading && !force) return loading;
    loading = request(`${API}?action=applications`).then((data) => {
      applications = data.applications || [];
      loading = null;
      return applications;
    }).catch((error) => {
      loading = null;
      throw error;
    });
    return loading;
  }

  function detailValue(label) {
    const cards = Array.from(document.querySelectorAll('#admin-detail .admin-field-card'));
    const card = cards.find((item) => item.querySelector('small')?.textContent?.trim() === label);
    return card?.querySelector('p')?.textContent?.trim() || '';
  }

  function ticketValue(label) {
    const cards = Array.from(document.querySelectorAll('#admin-detail .admin-ticket-card'));
    const card = cards.find((item) => item.querySelector('small')?.textContent?.trim() === label);
    return card?.querySelector('p, a')?.textContent?.trim() || '';
  }

  async function selectedApplication(force = false) {
    const name = document.querySelector('#admin-detail .admin-detail-head h2')?.textContent?.trim() || '';
    const email = detailValue('Email');
    if (!name || !email || email === 'Not provided') return null;
    const list = await loadApplications(force);
    const matches = list.filter((item) => item.fullName === name && item.email === email);
    if (matches.length === 1) return matches[0];

    const ticketId = ticketValue('Ticket ID');
    if (ticketId && ticketId !== '—') {
      const byTicket = matches.find((item) => item.ticket?.ticketId === ticketId);
      if (byTicket) return byTicket;
    }
    return null;
  }

  function status(message, error = false) {
    const el = document.querySelector('#admin-detail .admin-ticket-actions .admin-status');
    if (!el) return;
    el.textContent = message;
    el.classList.toggle('error', Boolean(error));
  }

  function isCompPanel() {
    const ticketId = ticketValue('Ticket ID');
    const paymentIntent = ticketValue('Payment intent');
    return /^NOC-TKT-COMP-/.test(ticketId) && (!paymentIntent || paymentIntent === '—');
  }

  async function issueComp(button) {
    button.disabled = true;
    status('Locating approved application…');
    try {
      const application = await selectedApplication(true);
      if (!application) throw new Error('Could not uniquely identify this application. Refresh the dashboard and try again.');
      if (application.review?.status !== 'approved') throw new Error('Approve this application before issuing a complimentary ticket.');
      if (!window.confirm(`Issue a complimentary NOCTURNE ticket to ${application.fullName}?\n\nNo Stripe payment will be required.`)) return;
      status('Issuing complimentary ticket…');
      const result = await request(COMP_API, {
        method: 'POST',
        body: JSON.stringify({ action: 'issue', submissionId: application.id })
      });
      status(result.recipient ? `Complimentary ticket issued and emailed to ${result.recipient}.` : 'Complimentary ticket issued.');
      applications = [];
      window.setTimeout(() => document.querySelector('#admin-refresh')?.click(), 350);
    } catch (error) {
      status(error.message || 'Complimentary ticket could not be issued.', true);
    } finally {
      button.disabled = false;
    }
  }

  async function resendComp(button) {
    button.disabled = true;
    status('Sending complimentary ticket…');
    try {
      const application = await selectedApplication(true);
      if (!application) throw new Error('Could not uniquely identify this application.');
      const result = await request(COMP_API, {
        method: 'POST',
        body: JSON.stringify({ action: 'resend', submissionId: application.id })
      });
      status(`Complimentary ticket sent to ${result.recipient}.`);
      applications = [];
    } catch (error) {
      status(error.message || 'Complimentary ticket could not be resent.', true);
    } finally {
      button.disabled = false;
    }
  }

  async function enhance() {
    const panel = document.querySelector('#admin-detail .admin-ticket-panel');
    const actions = panel?.querySelector('.admin-ticket-actions');
    if (!panel || !actions) return;

    if (isCompPanel()) {
      const badge = panel.querySelector('.admin-ticket-state');
      if (badge) badge.textContent = badge.textContent.includes('Checked') ? 'Checked in · Comp' : 'Complimentary';
      for (const button of actions.querySelectorAll('button')) {
        if (button.textContent.trim() === 'Refund & cancel ticket') button.remove();
      }
      let note = panel.querySelector('.admin-comp-note');
      if (!note) {
        note = document.createElement('div');
        note.className = 'admin-invite-note admin-comp-note';
        note.textContent = 'Complimentary admission · No Stripe payment required.';
        panel.append(note);
      }
      return;
    }

    if (panel.querySelector('[data-comp-issue]')) return;
    try {
      const application = await selectedApplication();
      if (!application || application.review?.status !== 'approved') return;
      const state = application.ticket?.state || 'none';
      if (!['none', 'checkout_created'].includes(state)) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'admin-outline-button';
      button.dataset.compIssue = 'true';
      button.textContent = 'Issue comp ticket';
      button.addEventListener('click', () => issueComp(button));
      actions.insertBefore(button, actions.querySelector('.admin-status'));
    } catch {}
  }

  document.addEventListener('click', (event) => {
    const button = event.target.closest('#admin-detail .admin-ticket-actions button');
    if (!button || button.textContent.trim() !== 'Resend digital ticket' || !isCompPanel()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    resendComp(button);
  }, true);

  const detail = document.querySelector('#admin-detail');
  if (detail) {
    new MutationObserver(() => queueMicrotask(enhance)).observe(detail, { childList: true, subtree: true });
  }

  document.querySelector('#admin-refresh')?.addEventListener('click', () => { applications = []; });
  window.setTimeout(enhance, 500);
})();
