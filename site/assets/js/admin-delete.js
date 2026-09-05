(() => {
  const DELETE_API = '/api/admin/delete-application';
  const nativeRenderDetail = renderDetail;

  function applicationStats() {
    const stats = { total: state.applications.length, pending: 0, shortlist: 0, approved: 0, declined: 0 };
    for (const application of state.applications) {
      const value = reviewStatus(application);
      if (Object.prototype.hasOwnProperty.call(stats, value)) stats[value] += 1;
      else stats.pending += 1;
    }
    return stats;
  }

  async function removeFromUi(application, response) {
    state.applications = state.applications.filter((item) => item.id !== application.id);
    state.selectedId = null;
    renderStats(applicationStats());
    renderInviteStats();
    recomputeTicketStats();
    renderDetail();
    setStatus(
      els.loadStatus,
      response.forced
        ? `Revoked ticket access and deleted ${application.fullName || response.deletedEmail || 'applicant'}${response.financialRecordRetained ? '; minimal accounting/audit records were retained' : ''}.`
        : `${response.compTicketRevoked ? 'Revoked the complimentary ticket and deleted' : 'Deleted'} ${application.fullName || response.deletedEmail || 'applicant'}${response.inviteRevoked ? ' and revoked their invitation' : ''}.`
    );
  }

  function enhanceDeleteControl() {
    if (!els.detail || !state.selectedId) return;
    if (els.detail.querySelector('[data-admin-delete-panel]')) return;

    const application = state.applications.find((item) => item.id === state.selectedId);
    if (!application) return;

    const panel = document.createElement('section');
    panel.className = 'admin-review-panel';
    panel.dataset.adminDeletePanel = 'true';

    const heading = document.createElement('h3');
    heading.textContent = 'Record management';

    const note = document.createElement('p');
    note.className = 'admin-invite-note';

    const actions = document.createElement('div');
    actions.className = 'admin-ticket-actions';

    const result = document.createElement('span');
    result.className = 'admin-status';

    const ticket = application.ticket || {};
    const isComp = String(ticket.ticketSource || '').toLowerCase() === 'comp';
    const isCheckedIn = Boolean(ticket.checkedInAt || ticketState(application) === 'checked_in');
    const hasStripeActivity = Boolean(
      ticket.stripeCheckoutSessionId
      || ticket.stripePaymentIntentId
      || ticket.stripeRefundId
      || ticket.drinkPackageCheckoutSessionId
      || ticket.drinkPackagePaymentIntentId
      || ticket.drinkPackageRefundId
      || ticket.waterPackageCheckoutSessionId
      || ticket.waterPackagePaymentIntentId
      || ticket.lateStayCheckoutSessionId
      || ticket.lateStayPaymentIntentId
      || ticket.addonBundleCheckoutSessionId
      || ticket.addonBundlePaymentIntentId
    );
    const canDeleteComp = isComp
      && ticketState(application) === 'paid'
      && !isCheckedIn
      && !hasStripeActivity;
    const hasTicketActivity = ticketState(application) !== 'none' && !canDeleteComp;

    if (hasTicketActivity) {
      note.textContent = 'This applicant has ticket, payment, or admission activity. You may force-revoke the ticket and delete the applicant record. Any add-on entitlement is invalidated immediately. Minimal financial/admission identifiers are retained for accounting and audit. No refund is issued by this action.';
      const button = actionButton('Force Revoke & Delete', async () => {
        const expected = String(application.email || '').trim();
        if (!expected) {
          setStatus(result, 'This applicant has no email address to use for deletion confirmation.', true);
          return;
        }

        const typedEmail = window.prompt(
          `FORCE REVOKE AND DELETE ${application.fullName || 'this applicant'}?\n\n` +
          'This immediately invalidates admission and add-on access, even if the ticket was already checked in. It does NOT issue a refund. Minimal accounting/audit data will remain.\n\n' +
          `Type the applicant email exactly to continue:\n${expected}`
        );
        if (typedEmail === null) return;
        if (typedEmail.trim().toLowerCase() !== expected.toLowerCase()) {
          setStatus(result, 'Email did not match. Nothing was changed.', true);
          return;
        }

        const phrase = window.prompt('Type REVOKE AND DELETE to confirm this irreversible action:');
        if (phrase === null) return;
        if (phrase.trim().toUpperCase() !== 'REVOKE AND DELETE') {
          setStatus(result, 'Confirmation phrase did not match. Nothing was changed.', true);
          return;
        }

        button.disabled = true;
        setStatus(result, 'Revoking ticket access and deleting applicant…');
        try {
          const response = await api(DELETE_API, {
            method: 'POST',
            body: JSON.stringify({
              submissionId: application.id,
              confirmEmail: typedEmail.trim(),
              force: true,
              confirmAction: phrase.trim()
            })
          });
          await removeFromUi(application, response);
        } catch (error) {
          setStatus(result, error.message || 'Force deletion failed.', true);
          button.disabled = false;
        }
      }, { danger: true });
      actions.append(button, result);
    } else {
      note.textContent = canDeleteComp
        ? 'Permanently revoke this active complimentary ticket and delete its order, applicant record, internal review, and invitation. The existing digital ticket link will stop working. This cannot be undone.'
        : 'Permanently delete this applicant, their internal review, and any unused invitation tied to the application. This cannot be undone.';
      const button = actionButton(canDeleteComp ? 'Revoke comp & delete' : 'Delete applicant', async () => {
        const expected = String(application.email || '').trim();
        if (!expected) {
          setStatus(result, 'This applicant has no email address to use for deletion confirmation.', true);
          return;
        }

        const typed = window.prompt(
          `Permanently delete ${application.fullName || 'this applicant'}?\n\n` +
          `${canDeleteComp ? 'This revokes the complimentary ticket and removes its order, application, review, and invitation.' : 'This removes the application, review, and any unused invitation.'}\n\n` +
          `Type the applicant email exactly to continue:\n${expected}`
        );
        if (typed === null) return;
        if (typed.trim().toLowerCase() !== expected.toLowerCase()) {
          setStatus(result, 'Email did not match. Nothing was deleted.', true);
          return;
        }

        button.disabled = true;
        setStatus(result, 'Deleting applicant…');
        try {
          const response = await api(DELETE_API, {
            method: 'POST',
            body: JSON.stringify({
              submissionId: application.id,
              confirmEmail: typed.trim()
            })
          });
          await removeFromUi(application, response);
        } catch (error) {
          setStatus(result, error.message || 'Applicant deletion failed.', true);
          button.disabled = false;
        }
      }, { danger: true });
      actions.append(button, result);
    }

    panel.append(heading, note, actions);
    els.detail.append(panel);
  }

  renderDetail = function renderDetailWithDeleteControl() {
    const output = nativeRenderDetail();
    queueMicrotask(enhanceDeleteControl);
    return output;
  };

  queueMicrotask(enhanceDeleteControl);
})();
