(() => {
  const REFUND_BUTTON_TEXT = 'Refund & cancel ticket';
  const REFUND_API = '/api/admin/dashboard';

  function panelField(panel, label) {
    const cards = Array.from(panel.querySelectorAll('.admin-ticket-card'));
    const card = cards.find((item) => item.querySelector('small')?.textContent?.trim() === label);
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
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  }

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('button.admin-danger-button');
    if (!button || button.textContent.trim() !== REFUND_BUTTON_TEXT) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    const panel = button.closest('.admin-ticket-panel');
    if (!panel) return;

    const ticketId = panelField(panel, 'Ticket ID');
    const amount = panelField(panel, 'Amount');
    const guestName = document.querySelector('.admin-detail-head h2')?.textContent?.trim() || 'this guest';

    if (!ticketId || ticketId === '—') {
      setPanelStatus(panel, 'Ticket ID is missing. Refund canceled.', true);
      return;
    }

    if (/^NOC-TKT-COMP-/.test(ticketId)) {
      button.remove();
      setPanelStatus(panel, 'Complimentary tickets have no Stripe payment to refund.', false);
      return;
    }

    const firstConfirm = window.confirm(
      `Refund and cancel ${guestName}'s ticket?\n\nTicket: ${ticketId}\nAmount: ${amount || 'Full payment'}\n\nThis submits a full Stripe refund and permanently invalidates the digital ticket.`
    );
    if (!firstConfirm) return;

    const finalConfirm = window.confirm(
      `Final confirmation\n\nSubmit the full Stripe refund for ${ticketId} now?`
    );
    if (!finalConfirm) return;

    button.disabled = true;
    setPanelStatus(panel, 'Locating ticket record…');

    try {
      const dashboard = await request(`${REFUND_API}?action=applications`);
      const application = (dashboard.applications || []).find((item) => item.ticket?.ticketId === ticketId);

      if (!application) throw new Error('The ticket record could not be located. Refresh the dashboard and try again.');
      if (application.ticket?.state !== 'paid') throw new Error(`This ticket is currently ${application.ticket?.state || 'not refundable'}.`);

      setPanelStatus(panel, 'Submitting Stripe refund…');
      const result = await request(REFUND_API, {
        method: 'POST',
        body: JSON.stringify({
          action: 'refund-ticket',
          submissionId: application.id,
          confirmTicketId: ticketId
        })
      });

      setPanelStatus(panel, `Refund submitted: ${result.refund?.id || 'Stripe refund'}.`);
      document.querySelector('#admin-refresh')?.click();
    } catch (error) {
      setPanelStatus(panel, error.message || 'Refund could not be submitted.', true);
      button.disabled = false;
    }
  }, true);
})();
