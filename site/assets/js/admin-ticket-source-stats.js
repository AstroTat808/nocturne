(() => {
  const dashboard = document.querySelector('#admin-dashboard');
  const statsGrid = document.querySelector('.admin-ticket-stats');
  const originalPaidCard = statsGrid?.querySelector('[data-ticket-state-filter="paid"]');
  const list = document.querySelector('#admin-application-list');
  const refreshButton = document.querySelector('#admin-refresh');

  if (!dashboard || !statsGrid || !originalPaidCard) return;

  const paidCard = document.createElement('article');
  paidCard.className = 'admin-ticket-stat admin-ticket-source-stat';
  paidCard.innerHTML = '<span id="ticket-stat-paid-source">0</span><small>Paid</small><em>Purchased · ready for entry</em>';

  const compCard = document.createElement('article');
  compCard.className = 'admin-ticket-stat admin-ticket-source-stat';
  compCard.innerHTML = '<span id="ticket-stat-comp">0</span><small>Comp</small><em>Complimentary · ready for entry</em>';

  originalPaidCard.replaceWith(paidCard, compCard);

  const paidEl = paidCard.querySelector('#ticket-stat-paid-source');
  const compEl = compCard.querySelector('#ticket-stat-comp');

  const style = document.createElement('style');
  style.textContent = `
    .admin-ticket-source-stat{cursor:default}
    .admin-ticket-source-stat:hover{border-color:rgba(216,154,43,.14);background:#050403;transform:none}
    @media(min-width:981px){.admin-ticket-stats{grid-template-columns:repeat(5,minmax(0,1fr))}}
  `;
  document.head.append(style);

  let loading = false;
  let timer = 0;

  async function refreshSourceCounts() {
    if (loading || dashboard.hidden) return;
    loading = true;
    try {
      const response = await fetch('/api/admin/dashboard?action=applications', {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) return;
      const data = await response.json().catch(() => ({}));
      const applications = Array.isArray(data.applications) ? data.applications : [];
      let paid = 0;
      let comp = 0;

      for (const application of applications) {
        const ticket = application?.ticket || {};
        if (ticket.state !== 'paid') continue;
        if (String(ticket.ticketSource || '').toLowerCase() === 'comp') comp += 1;
        else paid += 1;
      }

      paidEl.textContent = String(paid);
      compEl.textContent = String(comp);
    } catch (error) {
      console.warn('NOCTURNE paid/comp ticket counts unavailable:', error);
    } finally {
      loading = false;
    }
  }

  function scheduleRefresh(delay = 120) {
    clearTimeout(timer);
    timer = setTimeout(refreshSourceCounts, delay);
  }

  new MutationObserver(() => {
    if (!dashboard.hidden) scheduleRefresh();
  }).observe(dashboard, { attributes: true, attributeFilter: ['hidden'] });

  if (list) {
    new MutationObserver(() => scheduleRefresh(250)).observe(list, { childList: true });
  }

  refreshButton?.addEventListener('click', () => scheduleRefresh(350));
  scheduleRefresh(50);
})();
