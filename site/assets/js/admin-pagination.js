(() => {
  const list = document.querySelector('#admin-application-list');
  const previous = document.querySelector('#admin-page-previous');
  const next = document.querySelector('#admin-page-next');
  const status = document.querySelector('#admin-page-status');
  const visibleCount = document.querySelector('#admin-visible-count');
  if (!list || !previous || !next || !status || !visibleCount) return;

  const pageSize = 25;
  let page = 1;

  function renderPage() {
    const rows = Array.from(list.querySelectorAll('.admin-application-row'));
    visibleCount.textContent = String(rows.length);
    const pages = Math.max(1, Math.ceil(rows.length / pageSize));
    page = Math.min(Math.max(page, 1), pages);
    const start = (page - 1) * pageSize;
    rows.forEach((row, index) => { row.hidden = index < start || index >= start + pageSize; });
    previous.disabled = page <= 1;
    next.disabled = page >= pages;
    status.textContent = rows.length ? `Page ${page} of ${pages} · ${rows.length} results` : 'Page 1 of 1 · 0 results';
  }

  function resetAfterRender() {
    page = 1;
    queueMicrotask(renderPage);
  }

  previous.addEventListener('click', () => { page -= 1; renderPage(); list.scrollIntoView({ block: 'start', behavior: 'smooth' }); });
  next.addEventListener('click', () => { page += 1; renderPage(); list.scrollIntoView({ block: 'start', behavior: 'smooth' }); });
  for (const control of document.querySelectorAll('#admin-search, #admin-status-filter, #admin-invite-filter, #admin-ticket-filter')) {
    control.addEventListener(control.matches('input') ? 'input' : 'change', resetAfterRender);
  }
  for (const button of document.querySelectorAll('[data-invite-state-filter], [data-ticket-state-filter]')) button.addEventListener('click', resetAfterRender);

  new MutationObserver(renderPage).observe(list, { childList: true });
  renderPage();
})();
