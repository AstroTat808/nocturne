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

  function cleanValue(value) {
    const text = String(value || '').trim();
    return !text || text === 'Not provided' || text === '—' ? '' : text;
  }

  function sameText(a, b) {
    return cleanValue(a).toLowerCase() === cleanValue(b).toLowerCase();
  }

  function formatDateTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }

  function narrow(candidates, actual, getter) {
    const value = cleanValue(actual);
    if (!value || candidates.length <= 1) return candidates;
    const matches = candidates.filter((item) => sameText(getter(item), value));
    return matches.length ? matches : candidates;
  }

  async function selectedApplication(force = false) {
    const name = cleanValue(document.querySelector('#admin-detail .admin-detail-head h2')?.textContent);
    const email = cleanValue(detailValue('Email'));
    if (!name || !email) return null;

    const list = await loadApplications(force);
    let matches = list.filter((item) => sameText(item.fullName, name) && sameText(item.email, email));
    if (matches.length === 1) return matches[0];
    if (!matches.length) return null;

    matches = narrow(matches, detailValue('Mobile'), (item) => item.phone);
    matches = narrow(matches, detailValue('Location'), (item) => item.location);
    matches = narrow(matches, detailValue('Instagram'), (item) => item.instagram);
    matches = narrow(matches, detailValue('Referral'), (item) => item.referral);
    if (matches.length === 1) return matches[0];

    const submitted = cleanValue(document.querySelector('#admin-detail .admin-detail-head p')?.textContent).replace(/^Submitted\s+/i, '');
    if (submitted) {
      const bySubmitted = matches.filter((item) => formatDateTime(item.createdAt) === submitted);
      if (bySubmitted.length === 1) return bySubmitted[0];
      if (bySubmitted.length) matches = bySubmitted;
    }

    const ticketId = cleanValue(ticketValue('Ticket ID'));
    if (ticketId) {
      const byTicket = matches.filter((item) => item.ticket?.ticketId === ticketId);
      if (byTicket.length === 1) return byTicket[0];
      if (byTicket.length) matches = byTicket;
    }

    const eligible = matches.filter((item) => {
      const state = item.ticket?.state || 'none';
      return item.review?.status === 'approved' && ['none', 'checkout_created'].includes(state);
    });
    return eligible.length === 1 ? eligible[0] : null;
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
      const ticketState = application.ticket?.state || 'none';
      if (!['none', 'checkout_created'].includes(ticketState)) throw new Error('This guest already has an active or completed ticket record.');
      if (!window.confirm(`Issue a complimentary NOCTURNE ticket to ${application.fullName}?\n\nNo Stripe payment will be required. Any unpaid checkout record will be replaced by the complimentary ticket.`)) return;
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
      // Always re-read the current application state so a newly approved or redeemed
      // invite can receive a comp ticket without requiring a full browser reload.
      const application = await selectedApplication(true);
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

      if (application.review?.inviteState === 'redeemed') {
        let note = panel.querySelector('.admin-comp-eligible-note');
        if (!note) {
          note = document.createElement('div');
          note.className = 'admin-invite-note admin-comp-eligible-note';
          note.textContent = 'Invitation redeemed · Eligible for a complimentary ticket without Stripe checkout.';
          panel.append(note);
        }
      }
    } catch (error) {
      console.error('NOCTURNE comp ticket controls could not load:', error);
    }
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
