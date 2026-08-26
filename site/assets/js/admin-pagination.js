(() => {
  const list = document.querySelector('#admin-application-list');
  const previous = document.querySelector('#admin-page-previous');
  const next = document.querySelector('#admin-page-next');
  const status = document.querySelector('#admin-page-status');
  const visibleCount = document.querySelector('#admin-visible-count');
  if (!list || !previous || !next || !status || !visibleCount) return;

  const pageSize = 25;
  let page = 1;

  function rows() {
    return Array.from(list.querySelectorAll('.admin-application-row'));
  }

  function renderPage({ resetScroll = false } = {}) {
    const applicationRows = rows();
    const total = applicationRows.length;
    const pages = Math.max(1, Math.ceil(total / pageSize));

    page = Math.min(Math.max(page, 1), pages);
    const start = (page - 1) * pageSize;
    const end = start + pageSize;

    applicationRows.forEach((row, index) => {
      const visible = index >= start && index < end;
      row.hidden = !visible;
      row.style.display = visible ? '' : 'none';
      row.setAttribute('aria-hidden', visible ? 'false' : 'true');
    });

    visibleCount.textContent = String(total);
    previous.disabled = page <= 1;
    next.disabled = page >= pages;
    previous.setAttribute('aria-disabled', String(previous.disabled));
    next.setAttribute('aria-disabled', String(next.disabled));
    status.textContent = total ? `Page ${page} of ${pages} · ${total} results` : 'Page 1 of 1 · 0 results';

    if (resetScroll) {
      list.scrollTop = 0;
      list.scrollLeft = 0;
    }
  }

  function resetAfterRender() {
    page = 1;
    queueMicrotask(() => renderPage({ resetScroll: true }));
  }

  previous.addEventListener('click', (event) => {
    event.preventDefault();
    if (previous.disabled || page <= 1) return;
    page -= 1;
    renderPage({ resetScroll: true });
  });

  next.addEventListener('click', (event) => {
    event.preventDefault();
    const totalPages = Math.max(1, Math.ceil(rows().length / pageSize));
    if (next.disabled || page >= totalPages) return;
    page += 1;
    renderPage({ resetScroll: true });
  });

  for (const control of document.querySelectorAll('#admin-search, #admin-status-filter, #admin-invite-filter, #admin-ticket-filter')) {
    control.addEventListener(control.matches('input') ? 'input' : 'change', resetAfterRender);
  }

  for (const button of document.querySelectorAll('[data-invite-state-filter], [data-ticket-state-filter]')) {
    button.addEventListener('click', resetAfterRender);
  }

  new MutationObserver(() => renderPage()).observe(list, { childList: true });
  renderPage();
})();
