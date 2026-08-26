(() => {
  const STANDARD_REFUND_BUTTON = 'Refund & cancel ticket';
  const LEGACY_COMBINED_BUTTON = 'Refund both in Stripe';
  const COMBINED_REFUND_BUTTON = 'Refund admission + package';
  const RECOVERY_REFUND_BUTTON = 'Complete admission refund';
  const PACKAGE_ONLY_BUTTON = 'Refund drink package only';
  const PACKAGE_LOCKED_BUTTON = 'Package non-refundable — drink redeemed';
  const DASHBOARD_API = '/api/admin/dashboard';
  const REFUND_API = '/.netlify/functions/admin-refunds';

  let enhanceTimer = null;
  let enhancing = false;

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

  function unlockLegacyButtons(root = document) {
    for (const button of root.querySelectorAll('button.admin-danger-button')) {
      const label = button.textContent.trim();
      const panel = button.closest('.admin-ticket-panel');
      const packageState = panel ? panelField(panel, 'Drink package').toLowerCase() : '';
      const packagePayment = panel ? panelField(panel, 'Package payment') : '';
      if (label === LEGACY_COMBINED_BUTTON) {
        button.textContent = COMBINED_REFUND_BUTTON;
        button.disabled = false;
        button.title = 'Refunds the separate drink-package charge first, then refunds admission. Both refunds are audited.';
      } else if (label === STANDARD_REFUND_BUTTON && packageState.startsWith('refunded') && packagePayment && packagePayment !== 'Included with admission') {
        button.textContent = RECOVERY_REFUND_BUTTON;
        button.disabled = false;
        button.title = 'The separate drink package is already refunded. This completes the remaining admission refund.';
      }
    }
  }

  function removeGenerated(panel) {
    panel.querySelectorAll('[data-refund-generated="true"]').forEach((node) => node.remove());
  }

  function makePackageButton(panel, application) {
    const ticket = application?.ticket || {};
    if (!ticket.drinkPackagePurchased || ticket.drinkPackagePurchaseType !== 'addon') return;
    if (ticket.drinkPackageCheckoutStatus !== 'paid') return;
    const actions = panel.querySelector('.admin-ticket-actions');
    if (!actions) return;
    const redeemed = Number(ticket.drinkCreditsRedeemed || 0);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'admin-danger-button';
    button.dataset.refundGenerated = 'true';
    button.dataset.refundSubmissionId = application.id;
    button.dataset.refundAction = redeemed > 0 ? 'package-locked' : 'package-only';
    button.textContent = redeemed > 0 ? PACKAGE_LOCKED_BUTTON : PACKAGE_ONLY_BUTTON;
    if (redeemed > 0) {
      button.disabled = true;
      button.title = `${redeemed} drink credit${redeemed === 1 ? ' has' : 's have'} already been redeemed. The package is no longer refundable.`;
    } else {
      button.title = 'Refunds only the separate drink-package payment. Admission remains active.';
    }
    const status = actions.querySelector('.admin-status');
    actions.insertBefore(button, status || actions.firstChild);
  }

  function renderHistory(panel, history = []) {
    const section = document.createElement('section');
    section.dataset.refundGenerated = 'true';
    section.className = 'admin-refund-history';
    section.style.cssText = 'margin-top:1rem;padding:1rem;border:1px solid rgba(216,154,43,.24);background:rgba(216,154,43,.035);';
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
      row.style.cssText = 'padding:.8rem 0;border-top:1px solid rgba(216,154,43,.14);font-size:.76rem;line-height:1.55;';
      const heading = document.createElement('strong');
      heading.textContent = `${item.label || (item.type === 'drink_package' ? 'Drink package refund' : 'Admission refund')} · ${money(item.amountCents, item.currency)}`;
      row.appendChild(heading);
      const details = document.createElement('div');
      details.style.cssText = 'margin-top:.25rem;color:#a99b87;word-break:break-word;';
      details.textContent = `Status: ${item.status || '—'} · Date: ${dateTime(item.date)} · Stripe: ${item.stripeRefundId || '—'} · Initiated by: ${item.initiatedBy || '—'}`;
      row.appendChild(details);
      section.appendChild(row);
    }
    panel.appendChild(section);
  }

  async function enhancePanel(panel) {
    const ticketId = panelField(panel, 'Ticket ID');
    if (!ticketId || ticketId === '—') return;
    if (panel.dataset.refundEnhancedTicket === ticketId) return;
    const dashboard = await request(`${DASHBOARD_API}?action=applications`);
    const application = (dashboard.applications || []).find((item) => item.ticket?.ticketId === ticketId);
    if (!application) return;
    removeGenerated(panel);
    makePackageButton(panel, application);
    try {
      const result = await request(`${REFUND_API}?submissionId=${encodeURIComponent(application.id)}`);
      renderHistory(panel, result.history || []);
    } catch {
      renderHistory(panel, []);
    }
    panel.dataset.refundEnhancedTicket = ticketId;
  }

  function scheduleEnhance() {
    clearTimeout(enhanceTimer);
    enhanceTimer = setTimeout(async () => {
      if (enhancing) return;
      const panel = document.querySelector('#admin-detail .admin-ticket-panel');
      if (!panel) return;
      enhancing = true;
      try {
        unlockLegacyButtons(panel);
        await enhancePanel(panel);
      } catch (error) {
        console.error('NOCTURNE refund panel enhancement failed:', error);
      } finally {
        enhancing = false;
      }
    }, 80);
  }

  unlockLegacyButtons();
  scheduleEnhance();
  const detail = document.querySelector('#admin-detail');
  if (detail) new MutationObserver(() => scheduleEnhance()).observe(detail, { childList: true, subtree: true });

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('button.admin-danger-button');
    if (!button) return;
    const label = button.textContent.trim();
    const isStandard = label === STANDARD_REFUND_BUTTON;
    const isCombined = label === COMBINED_REFUND_BUTTON;
    const isRecovery = label === RECOVERY_REFUND_BUTTON;
    const isPackageOnly = label === PACKAGE_ONLY_BUTTON || button.dataset.refundAction === 'package-only';
    if (!isStandard && !isCombined && !isRecovery && !isPackageOnly) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    const panel = button.closest('.admin-ticket-panel');
    if (!panel) return;
    const ticketId = panelField(panel, 'Ticket ID');
    const amount = panelField(panel, 'Amount');
    const packagePayment = panelField(panel, 'Package payment');
    const guestName = document.querySelector('.admin-detail-head h2')?.textContent?.trim() || 'this guest';

    if (!ticketId || ticketId === '—') return setPanelStatus(panel, 'Ticket ID is missing. Refund canceled.', true);
    if (/^NOC-TKT-COMP-/.test(ticketId) && !isPackageOnly) return setPanelStatus(panel, 'Complimentary admission has no Stripe payment to refund.', true);

    const dashboard = await request(`${DASHBOARD_API}?action=applications`).catch((error) => {
      setPanelStatus(panel, error.message || 'Could not verify the payment record.', true);
      return null;
    });
    if (!dashboard) return;
    const application = (dashboard.applications || []).find((item) => item.ticket?.ticketId === ticketId);
    if (!application) return setPanelStatus(panel, 'The ticket record could not be located. Refresh and try again.', true);
    const ticket = application.ticket || {};

    if (isPackageOnly) {
      if (ticket.drinkPackagePurchaseType !== 'addon' || ticket.drinkPackageCheckoutStatus !== 'paid') return setPanelStatus(panel, 'The separate drink package is not currently refundable.', true);
      if (Number(ticket.drinkCreditsRedeemed || 0) > 0) return setPanelStatus(panel, 'Package refund blocked: at least one drink credit has already been redeemed.', true);
    }

    const firstConfirm = window.confirm(
      isPackageOnly
        ? `Refund ONLY ${guestName}'s separate drink package?\n\nTicket: ${ticketId}\nDrink package: ${packagePayment || 'Full package payment'}\n\nAdmission remains ACTIVE. The drink package will be permanently disabled. This is allowed only because zero drink credits have been redeemed.`
        : isCombined
          ? `Refund and cancel ${guestName}'s admission AND separate drink package?\n\nTicket: ${ticketId}\nAdmission: ${amount || 'Full admission payment'}\nDrink package: ${packagePayment || 'Full separate package payment'}\n\nThe package charge is refunded first. Admission is refunded second.`
          : isRecovery
            ? `Complete ${guestName}'s admission refund?\n\nTicket: ${ticketId}\nAdmission: ${amount || 'Full admission payment'}\n\nThe separate drink package is already refunded.`
            : `Refund and cancel ${guestName}'s admission?\n\nTicket: ${ticketId}\nAmount: ${amount || 'Full admission payment'}\n\nThis submits a Stripe refund and invalidates admission.`
    );
    if (!firstConfirm) return;

    const typed = window.prompt(`Type the ticket ID exactly to continue:\n${ticketId}`);
    if (typed === null) return;
    if (typed.trim() !== ticketId) return setPanelStatus(panel, 'Ticket ID did not match. Refund canceled.', true);

    const initiatedBy = operatorName();
    if (!initiatedBy) return setPanelStatus(panel, 'Refund canceled. Enter a valid admin name or initials for the audit history.', true);

    const finalConfirm = window.confirm(
      isPackageOnly
        ? `Final confirmation\n\nRefund the drink package for ${ticketId} now?\n\nAdmission will stay active. Any future drink-package redemption will be blocked.`
        : isCombined
          ? `Final confirmation\n\nSubmit BOTH Stripe refunds for ${ticketId} now?`
          : `Final confirmation\n\nSubmit the admission refund for ${ticketId} now?`
    );
    if (!finalConfirm) return;

    button.disabled = true;
    setPanelStatus(panel, 'Locking the current payment state and verifying refund eligibility…');

    try {
      const action = isPackageOnly ? 'package-only' : isCombined ? 'combined' : 'admission-only';
      const result = await request(REFUND_API, {
        method: 'POST',
        body: JSON.stringify({ action, submissionId: application.id, confirmTicketId: ticketId, initiatedBy })
      });
      if (isPackageOnly) {
        setPanelStatus(panel, `Drink package refunded: ${result.packageRefund?.id || 'recorded'}. Admission remains active.`);
      } else if (isCombined) {
        setPanelStatus(panel, `Refund workflow complete. Admission: ${result.admissionRefund?.id || 'recorded'} · Package: ${result.packageRefund?.id || 'recorded'}.`);
      } else {
        setPanelStatus(panel, `Admission refund submitted: ${result.admissionRefund?.id || 'recorded'}.`);
      }
      document.querySelector('#admin-refresh')?.click();
      setTimeout(scheduleEnhance, 300);
    } catch (error) {
      if (error.data?.partial) setPanelStatus(panel, `${error.message} The package refund is recorded; admission remains active.`, true);
      else setPanelStatus(panel, error.message || 'Refund could not be submitted.', true);
      button.disabled = false;
    }
  }, true);
})();
