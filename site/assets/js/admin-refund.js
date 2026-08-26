(() => {
  const DASHBOARD_API = '/api/admin/dashboard';
  const REFUND_API = '/.netlify/functions/admin-refunds';
  const REFUND_BUTTONS = new Set(['Refund & cancel ticket', 'Complete admission refund']);
  const REASONS = [
    ['guest_request', 'Guest request'],
    ['duplicate_purchase', 'Duplicate purchase'],
    ['event_cancellation', 'Event cancellation'],
    ['event_change', 'Material event change'],
    ['payment_error', 'Payment / checkout error'],
    ['goodwill', 'Administrative goodwill'],
    ['other', 'Other']
  ];

  let enhanceTimer = null;
  let enhancing = false;

  function panelField(panel, label) {
    const card = Array.from(panel.querySelectorAll('.admin-ticket-card'))
      .find((item) => item.querySelector('small')?.textContent?.trim() === label);
    return card?.querySelector('p, a')?.textContent?.trim() || '';
  }

  function setPanelStatus(panel, message, isError = false) {
    const status = panel.querySelector('.admin-ticket-actions .admin-status');
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('error', Boolean(isError));
  }

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
    if (!response.ok) {
      const error = new Error(data.error || `Request failed (${response.status}).`);
      error.data = data;
      throw error;
    }
    return data;
  }

  function money(cents, currency = 'usd') {
    const amount = Number(cents || 0) / 100;
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: String(currency || 'usd').toUpperCase() }).format(amount);
    } catch {
      return `$${amount.toFixed(2)}`;
    }
  }

  function dateTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }

  function operatorName() {
    const saved = String(localStorage.getItem('nocturneRefundOperator') || '').trim();
    const entered = window.prompt('Enter your name or initials for the refund history:', saved);
    if (entered === null) return '';
    const clean = entered.trim().replace(/\s+/g, ' ');
    if (clean.length < 2 || clean.length > 80) return '';
    localStorage.setItem('nocturneRefundOperator', clean);
    return clean;
  }

  function refundMeta(panel) {
    const reason = panel.querySelector('[data-refund-reason]')?.value || '';
    const notes = panel.querySelector('[data-refund-notes]')?.value?.trim() || '';
    return { reason, notes };
  }

  function renderRefundFields(panel) {
    if (panel.querySelector('[data-refund-meta="true"]')) return;
    const actions = panel.querySelector('.admin-ticket-actions');
    if (!actions) return;

    const box = document.createElement('section');
    box.dataset.refundMeta = 'true';
    box.style.cssText = 'margin:1rem 0;padding:1rem;border:1px solid rgba(216,154,43,.24);background:rgba(216,154,43,.035);text-align:left;';

    const title = document.createElement('h3');
    title.textContent = 'Refund details';
    title.style.cssText = 'margin:0 0 .75rem;font-size:.95rem;';
    box.appendChild(title);

    const reasonLabel = document.createElement('label');
    reasonLabel.textContent = 'Reason';
    reasonLabel.style.cssText = 'display:grid;gap:.4rem;color:#b9aa94;font-size:.72rem;';
    const select = document.createElement('select');
    select.dataset.refundReason = 'true';
    select.required = true;
    select.style.cssText = 'width:100%;min-height:44px;padding:.65rem .75rem;border:1px solid rgba(216,154,43,.28);background:#090806;color:#eee1ca;';
    select.innerHTML = '<option value="">Choose a reason…</option>' + REASONS.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
    reasonLabel.appendChild(select);
    box.appendChild(reasonLabel);

    const notesLabel = document.createElement('label');
    notesLabel.textContent = 'Notes';
    notesLabel.style.cssText = 'display:grid;gap:.4rem;margin-top:.75rem;color:#b9aa94;font-size:.72rem;';
    const notes = document.createElement('textarea');
    notes.dataset.refundNotes = 'true';
    notes.rows = 3;
    notes.maxLength = 1000;
    notes.placeholder = 'Optional details, reference numbers, guest communication, or other context. Required when reason is Other.';
    notes.style.cssText = 'width:100%;box-sizing:border-box;padding:.7rem .75rem;border:1px solid rgba(216,154,43,.28);background:#090806;color:#eee1ca;resize:vertical;line-height:1.45;';
    notesLabel.appendChild(notes);
    box.appendChild(notesLabel);

    actions.before(box);
  }

  function renderHistory(panel, history = []) {
    panel.querySelector('[data-refund-history="true"]')?.remove();
    const section = document.createElement('section');
    section.dataset.refundHistory = 'true';
    section.style.cssText = 'margin-top:1rem;padding:1rem;border:1px solid rgba(216,154,43,.24);background:rgba(216,154,43,.035);text-align:left;';
    const title = document.createElement('h3');
    title.textContent = 'Refund history';
    title.style.cssText = 'margin:0 0 .75rem;font-size:.95rem;';
    section.appendChild(title);

    if (!history.length) {
      const empty = document.createElement('p');
      empty.textContent = 'No refunds recorded.';
      empty.style.cssText = 'margin:0;color:#8f8372;font-size:.78rem;';
      section.appendChild(empty);
      panel.appendChild(section);
      return;
    }

    for (const item of history) {
      const row = document.createElement('div');
      row.style.cssText = 'padding:.85rem 0;border-top:1px solid rgba(216,154,43,.14);font-size:.76rem;line-height:1.55;';
      const heading = document.createElement('strong');
      heading.textContent = `${item.label || 'Admission refund'} · ${money(item.amountCents, item.currency)}`;
      row.appendChild(heading);

      const details = document.createElement('div');
      details.style.cssText = 'margin-top:.25rem;color:#a99b87;word-break:break-word;';
      details.textContent = `Status: ${item.status || '—'} · Date: ${dateTime(item.date)} · Stripe: ${item.stripeRefundId || '—'} · Initiated by: ${item.initiatedBy || '—'}`;
      row.appendChild(details);

      const reason = document.createElement('div');
      reason.style.cssText = 'margin-top:.3rem;color:#d5c2a4;';
      reason.textContent = `Reason: ${item.reasonLabel || item.reason || 'Not recorded (legacy)'}`;
      row.appendChild(reason);

      const notes = document.createElement('div');
      notes.style.cssText = 'margin-top:.2rem;color:#8f8372;white-space:pre-wrap;';
      notes.textContent = `Notes: ${item.notes || '—'}`;
      row.appendChild(notes);
      section.appendChild(row);
    }
    panel.appendChild(section);
  }

  async function enhancePanel(panel) {
    const ticketId = panelField(panel, 'Ticket ID');
    if (!ticketId || ticketId === '—') return;
    renderRefundFields(panel);
    const dashboard = await request(`${DASHBOARD_API}?action=applications`);
    const application = (dashboard.applications || []).find((item) => item.ticket?.ticketId === ticketId);
    if (!application) return;
    panel.dataset.refundSubmissionId = application.id;
    try {
      const result = await request(`${REFUND_API}?submissionId=${encodeURIComponent(application.id)}`);
      renderHistory(panel, result.history || []);
    } catch {
      renderHistory(panel, []);
    }
  }

  function scheduleEnhance() {
    clearTimeout(enhanceTimer);
    enhanceTimer = setTimeout(async () => {
      if (enhancing) return;
      const panel = document.querySelector('#admin-detail .admin-ticket-panel');
      if (!panel) return;
      enhancing = true;
      try { await enhancePanel(panel); }
      catch (error) { console.error('NOCTURNE refund panel enhancement failed:', error); }
      finally { enhancing = false; }
    }, 80);
  }

  scheduleEnhance();
  const detail = document.querySelector('#admin-detail');
  if (detail) new MutationObserver(() => scheduleEnhance()).observe(detail, { childList: true, subtree: true });

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('button.admin-danger-button');
    if (!button || !REFUND_BUTTONS.has(button.textContent.trim())) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    const panel = button.closest('.admin-ticket-panel');
    if (!panel) return;
    const ticketId = panelField(panel, 'Ticket ID');
    const amount = panelField(panel, 'Amount');
    const guestName = document.querySelector('.admin-detail-head h2')?.textContent?.trim() || 'this guest';
    const submissionId = panel.dataset.refundSubmissionId;
    const meta = refundMeta(panel);

    if (!ticketId || ticketId === '—') return setPanelStatus(panel, 'Ticket ID is missing. Refund canceled.', true);
    if (/^NOC-TKT-COMP-/.test(ticketId)) return setPanelStatus(panel, 'Complimentary admission has no Stripe payment to refund.', true);
    if (!submissionId) return setPanelStatus(panel, 'Refund record is still loading. Wait a moment and try again.', true);
    if (!meta.reason) return setPanelStatus(panel, 'Choose a refund reason before continuing.', true);
    if (meta.reason === 'other' && meta.notes.length < 3) return setPanelStatus(panel, 'Enter notes when the refund reason is Other.', true);

    const reasonLabel = REASONS.find(([value]) => value === meta.reason)?.[1] || meta.reason;
    const firstConfirm = window.confirm(
      `Refund and cancel ${guestName}'s admission?\n\nTicket: ${ticketId}\nAdmission: ${amount || 'Eligible admission amount'}\nReason: ${reasonLabel}${meta.notes ? `\nNotes: ${meta.notes}` : ''}\n\nOnly the refundable admission portion will be sent to Stripe. Any drink-package charge remains non-refundable and its entitlement will be forfeited when admission is canceled.`
    );
    if (!firstConfirm) return;

    const typed = window.prompt(`Type the ticket ID exactly to continue:\n${ticketId}`);
    if (typed === null) return;
    if (typed.trim() !== ticketId) return setPanelStatus(panel, 'Ticket ID did not match. Refund canceled.', true);

    const initiatedBy = operatorName();
    if (!initiatedBy) return setPanelStatus(panel, 'Refund canceled. Enter a valid admin name or initials for the audit history.', true);
    if (!window.confirm(`Final confirmation\n\nSubmit the admission-only Stripe refund for ${ticketId}?\nReason: ${reasonLabel}`)) return;

    button.disabled = true;
    setPanelStatus(panel, 'Calculating the refundable admission amount and submitting to Stripe…');

    try {
      const result = await request(REFUND_API, {
        method: 'POST',
        body: JSON.stringify({
          action: 'admission-only',
          submissionId,
          confirmTicketId: ticketId,
          initiatedBy,
          refundReason: meta.reason,
          refundNotes: meta.notes
        })
      });
      setPanelStatus(panel, `Admission refund submitted: ${result.admissionRefund?.id || 'recorded'} · ${result.refundReasonLabel || reasonLabel}.`);
      document.querySelector('#admin-refresh')?.click();
      setTimeout(scheduleEnhance, 300);
    } catch (error) {
      setPanelStatus(panel, error.message || 'Refund could not be submitted.', true);
      button.disabled = false;
    }
  }, true);
})();
