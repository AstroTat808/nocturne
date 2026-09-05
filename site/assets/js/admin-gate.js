(() => {
  const dashboard = document.querySelector('#admin-dashboard');
  if (!dashboard) return;

  const dedupeWaiverTools = () => {
    const panels = Array.from(dashboard.querySelectorAll('.admin-waiver-tools'));
    for (const panel of panels.slice(1)) panel.remove();
  };
  if (!window.__nocturneAdminGateDedupeObserver) {
    const observer = new MutationObserver(dedupeWaiverTools);
    observer.observe(dashboard, { childList: true, subtree: true });
    window.__nocturneAdminGateDedupeObserver = observer;
  }
  dedupeWaiverTools();
  if (window.__nocturneAdminGateUiInitialized || dashboard.querySelector('.admin-waiver-tools')) {
    window.__nocturneAdminGateUiInitialized = true;
    return;
  }
  window.__nocturneAdminGateUiInitialized = true;

  const nav = dashboard.querySelector('.admin-operations-nav');
  if (nav && !nav.querySelector('[data-event-day-ready-link]')) {
    const link = document.createElement('a');
    link.className = 'admin-operation-card primary';
    link.href = '/admin-event-day.html';
    link.dataset.eventDayReadyLink = 'true';
    link.innerHTML = '<strong>Event Day Ready</strong><span>Gate audit, waivers, Stripe, bar & backups →</span>';
    nav.insertBefore(link, nav.firstChild);
  }

  const style = document.createElement('style');
  style.textContent = `
    .admin-waiver-badge{display:inline-flex;align-items:center;width:max-content;margin-top:.35rem;padding:.24rem .48rem;border:1px solid;border-radius:999px;font-size:.58rem;font-weight:700;letter-spacing:.09em;text-transform:uppercase;line-height:1}
    .admin-waiver-badge[data-state="signed"]{border-color:rgba(106,191,131,.55);background:rgba(106,191,131,.08);color:#9be0ae}.admin-waiver-badge[data-state="unsigned"]{border-color:rgba(217,113,92,.65);background:rgba(217,113,92,.09);color:#ffb5a5}
    .admin-waiver-row-remind{display:block;margin-top:.45rem;padding:.38rem .55rem;border:1px solid rgba(216,154,43,.45);background:rgba(216,154,43,.05);color:#f0bd5d;font-size:.58rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;cursor:pointer}.admin-waiver-row-remind:disabled{opacity:.55;cursor:wait}
    .admin-waiver-tools{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(300px,.8fr);gap:1.25rem;align-items:center;margin:1.25rem 0;padding:1.35rem;border:1px solid rgba(216,154,43,.3);background:linear-gradient(135deg,rgba(216,154,43,.055),rgba(217,113,92,.035))}.admin-waiver-tools h2{margin:.35rem 0 .5rem;font-family:var(--serif);font-weight:500;color:#fff2df}.admin-waiver-actions{display:grid;gap:.6rem}.admin-waiver-actions .btn{width:100%;min-height:48px}.admin-waiver-count{color:#ffca61;font-weight:700}.admin-waiver-note{margin:0;color:#8f8372;font-size:.7rem;line-height:1.5}.admin-waiver-filter-wrap select{min-width:190px}
    @media(max-width:760px){.admin-waiver-tools{grid-template-columns:1fr}}
  `;
  document.head.append(style);

  const waiverTools = document.createElement('section');
  waiverTools.className = 'admin-waiver-tools';
  waiverTools.innerHTML = `<div><p class="admin-kicker">Required waiver outreach</p><h2>Unsigned waiver reminders.</h2><p class="admin-muted">Daily reminders run at 8:00 AM HST until the event. You can also send all eligible unsigned guests now, or send one reminder directly from an unsigned ticket row.</p></div><div class="admin-waiver-actions"><button id="admin-waiver-remind" class="btn" type="button">Send Waiver Reminders →</button><p id="admin-waiver-reminder-status" class="admin-status" role="status" aria-live="polite">Loading unsigned count…</p><p class="admin-waiver-note">Only active tickets are targeted. Signed, refunded, disputed, and inactive tickets are excluded. Manual duplicate sends are suppressed for two hours.</p></div>`;
  if (nav) nav.insertAdjacentElement('afterend', waiverTools);
  else dashboard.prepend(waiverTools);

  const toolbar = dashboard.querySelector('.admin-toolbar-ops');
  let waiverFilter = null;
  if (toolbar) {
    const wrap = document.createElement('label');
    wrap.className = 'admin-waiver-filter-wrap';
    wrap.innerHTML = '<span>Waiver status</span><select id="admin-waiver-filter"><option value="all">All waiver states</option><option value="unsigned">Unsigned waiver</option><option value="signed">Signed waiver</option></select>';
    toolbar.append(wrap);
    waiverFilter = wrap.querySelector('select');
  }

  const remindButton = waiverTools.querySelector('#admin-waiver-remind');
  const remindStatus = waiverTools.querySelector('#admin-waiver-reminder-status');
  const list = document.querySelector('#admin-application-list');
  const visibleCount = document.querySelector('#admin-visible-count');
  const pagination = document.querySelector('.admin-pagination');
  const pageStatus = document.querySelector('#admin-page-status');
  let ticketRows = [];
  let loadingTickets = false;

  function ticketForRow(row) {
    const text = row.textContent || '';
    for (const ticket of ticketRows) if (ticket.ticketId && text.includes(ticket.ticketId)) return ticket;
    return null;
  }

  async function sendIndividual(ticket, control) {
    if (!ticket?.submissionId || ticket.waiverSigned) return;
    const original = control.textContent;
    control.disabled = true;
    control.textContent = 'Sending…';
    try {
      const response = await fetch('/api/admin/waiver-reminders', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ submissionId: ticket.submissionId, confirm: 'SEND WAIVER REMINDER' })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Reminder failed.');
      control.textContent = data.sent ? 'Sent ✓' : 'Recently sent';
      await refreshReminderStatus();
    } catch (error) {
      control.textContent = 'Send failed';
      control.title = error.message || 'Reminder failed.';
      setTimeout(() => { control.textContent = original; control.disabled = false; }, 2500);
      return;
    }
    setTimeout(() => { control.disabled = false; control.textContent = original; }, 3500);
  }

  function decorateRows() {
    if (!list) return;
    for (const row of list.querySelectorAll('.admin-application-row')) {
      row.querySelectorAll('.admin-waiver-badge,.admin-waiver-row-remind').forEach((node) => node.remove());
      const ticket = ticketForRow(row);
      if (!ticket) { row.dataset.waiverState = 'none'; continue; }
      row.dataset.waiverState = ticket.waiverSigned ? 'signed' : 'unsigned';
      const ticketCell = row.querySelector('.admin-list-ticket') || row;
      const badge = document.createElement('span');
      badge.className = 'admin-waiver-badge';
      badge.dataset.state = row.dataset.waiverState;
      badge.textContent = ticket.waiverSigned ? 'Waiver signed' : 'Waiver unsigned';
      ticketCell.append(badge);
      if (!ticket.waiverSigned) {
        const send = document.createElement('button');
        send.type = 'button';
        send.className = 'admin-waiver-row-remind';
        send.textContent = 'Send Waiver Reminder';
        send.addEventListener('click', (event) => { event.stopPropagation(); sendIndividual(ticket, send); });
        ticketCell.append(send);
      }
    }
    applyWaiverFilter(false);
  }

  function applyWaiverFilter(resetPagination = true) {
    if (!list || !waiverFilter) return;
    const value = waiverFilter.value;
    const rows = Array.from(list.querySelectorAll('.admin-application-row'));
    if (value === 'all') {
      for (const row of rows) row.style.removeProperty('display');
      if (pagination) pagination.hidden = false;
      if (resetPagination) document.querySelector('#admin-search')?.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    let matches = 0;
    for (const row of rows) {
      const match = row.dataset.waiverState === value;
      row.style.setProperty('display', match ? 'grid' : 'none', 'important');
      if (match) matches += 1;
    }
    if (visibleCount) visibleCount.textContent = String(matches);
    if (pagination) pagination.hidden = true;
    if (pageStatus) pageStatus.textContent = `Showing all ${matches} ${value} waiver result${matches === 1 ? '' : 's'}`;
  }

  async function refreshReminderStatus() {
    try {
      const response = await fetch('/api/admin/waiver-reminders', { credentials: 'same-origin', headers: { Accept: 'application/json' }, cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Could not load waiver reminder status.');
      remindButton.disabled = Number(data.eligibleNow || 0) === 0;
      remindStatus.classList.remove('error');
      remindStatus.innerHTML = `<span class="admin-waiver-count">${Number(data.unsigned || 0)}</span> unsigned · ${Number(data.eligibleNow || 0)} eligible to email now${Number(data.recentlySent || 0) ? ` · ${Number(data.recentlySent)} recently reminded` : ''}`;
    } catch (error) {
      remindButton.disabled = true;
      remindStatus.textContent = error.message || 'Waiver reminder status unavailable.';
      remindStatus.classList.add('error');
    }
  }

  async function sendReminders() {
    const unsigned = ticketRows.filter((row) => !row.waiverSigned).length;
    if (!unsigned) return;
    if (!window.confirm(`Send the required waiver reminder to all currently eligible unsigned paid and comp ticket holders?\n\nUnsigned active tickets: ${unsigned}\n\nGuests reminded within the last two hours will be skipped.`)) return;
    remindButton.disabled = true;
    remindStatus.classList.remove('error');
    remindStatus.textContent = 'Sending waiver reminders…';
    try {
      const response = await fetch('/api/admin/waiver-reminders', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'SEND WAIVER REMINDERS' })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok && response.status !== 207) throw new Error(data.error || 'Bulk reminder send failed.');
      const pieces = [`${Number(data.sent || 0)} sent`];
      if (data.skippedRecent) pieces.push(`${Number(data.skippedRecent)} skipped (recent)`);
      if (data.skippedNoEmail) pieces.push(`${Number(data.skippedNoEmail)} skipped (no email)`);
      if (data.failed) pieces.push(`${Number(data.failed)} failed`);
      remindStatus.textContent = `Waiver reminder run complete: ${pieces.join(' · ')}.`;
      remindStatus.classList.toggle('error', Number(data.failed || 0) > 0);
    } catch (error) {
      remindStatus.textContent = error.message || 'Bulk reminder send failed.';
      remindStatus.classList.add('error');
    } finally {
      await refreshReminderStatus();
    }
  }

  async function loadTicketRows() {
    if (loadingTickets || dashboard.hidden) return;
    loadingTickets = true;
    try {
      const response = await fetch('/api/admin/gate-audit', { credentials: 'same-origin', headers: { Accept: 'application/json' }, cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Waiver status could not be loaded.');
      ticketRows = Array.isArray(data.tickets) ? data.tickets : [];
      decorateRows();
      await refreshReminderStatus();
    } catch (error) {
      console.warn('NOCTURNE waiver status enhancement unavailable:', error);
    } finally {
      loadingTickets = false;
    }
  }

  remindButton.addEventListener('click', sendReminders);
  waiverFilter?.addEventListener('change', () => applyWaiverFilter());
  document.querySelector('#admin-refresh')?.addEventListener('click', () => setTimeout(loadTicketRows, 150));
  if (list) new MutationObserver(() => { if (!dashboard.hidden) queueMicrotask(decorateRows); }).observe(list, { childList: true });
  new MutationObserver(() => { if (!dashboard.hidden) loadTicketRows(); }).observe(dashboard, { attributes: true, attributeFilter: ['hidden'] });
  if (!dashboard.hidden) loadTicketRows();
})();
