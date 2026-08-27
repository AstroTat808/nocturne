(() => {
  const paidEl = document.querySelector('#ticket-stat-paid');
  const compEl = document.querySelector('#ticket-stat-comp');
  const dashboard = document.querySelector('#admin-dashboard');
  const list = document.querySelector('#admin-application-list');
  const refreshButton = document.querySelector('#admin-refresh');

  if (!paidEl || !compEl || !dashboard) return;

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
