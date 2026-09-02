(() => {
  const dashboard = document.querySelector('#admin-dashboard');
  const statsGrid = document.querySelector('.admin-ticket-stats');
  const originalPaidCard = statsGrid?.querySelector('[data-ticket-state-filter="paid"]');
  const list = document.querySelector('#admin-application-list');
  const refreshButton = document.querySelector('#admin-refresh');
  const ticketOverview = document.querySelector('.admin-ticket-overview:not(.admin-drink-overview)');
  const drinkOverview = document.querySelector('.admin-drink-overview');

  if (ticketOverview && drinkOverview && ticketOverview.nextElementSibling !== drinkOverview) {
    drinkOverview.parentNode?.insertBefore(ticketOverview, drinkOverview);
  }

  if (!dashboard || !statsGrid || !originalPaidCard) return;

  const totalCard = document.createElement('article');
  totalCard.className = 'admin-ticket-stat admin-ticket-source-stat admin-ticket-total-stat';
  totalCard.innerHTML = '<span id="ticket-stat-total-holders">0</span><small>Total Ticket Holders</small><em>Valid admission · including checked in</em>';

  const paidCard = document.createElement('article');
  paidCard.className = 'admin-ticket-stat admin-ticket-source-stat';
  paidCard.innerHTML = '<span id="ticket-stat-paid-source">0</span><small>Paid</small><em>Purchased · ready for entry</em>';

  const compCard = document.createElement('article');
  compCard.className = 'admin-ticket-stat admin-ticket-source-stat';
  compCard.innerHTML = '<span id="ticket-stat-comp">0</span><small>Comp</small><em>Complimentary · ready for entry</em>';

  originalPaidCard.replaceWith(totalCard, paidCard, compCard);

  const totalEl = totalCard.querySelector('#ticket-stat-total-holders');
  const paidEl = paidCard.querySelector('#ticket-stat-paid-source');
  const compEl = compCard.querySelector('#ticket-stat-comp');

  const style = document.createElement('style');
  style.textContent = `
    .admin-ticket-source-stat{cursor:default}
    .admin-ticket-source-stat:hover{border-color:rgba(216,154,43,.14);background:#050403;transform:none}
    .admin-ticket-total-stat{border-color:rgba(106,191,131,.34);background:rgba(106,191,131,.035)}
    .admin-ticket-total-stat span{color:#a8dcb8}
    @media(min-width:981px){.admin-ticket-stats{grid-template-columns:repeat(6,minmax(0,1fr))}}
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
      let total = 0;
      let paid = 0;
      let comp = 0;

      for (const application of applications) {
        const ticket = application?.ticket || {};
        if (['paid', 'checked_in'].includes(ticket.state)) total += 1;
        if (ticket.state !== 'paid') continue;
        if (String(ticket.ticketSource || '').toLowerCase() === 'comp') comp += 1;
        else paid += 1;
      }

      totalEl.textContent = String(total);
      paidEl.textContent = String(paid);
      compEl.textContent = String(comp);
    } catch (error) {
      console.warn('NOCTURNE ticket-holder counts unavailable:', error);
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
