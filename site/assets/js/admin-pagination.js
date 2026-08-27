(() => {
  const list = document.querySelector('#admin-application-list');
  const showMore = document.querySelector('#admin-show-more');
  const status = document.querySelector('#admin-show-more-status');
  const controls = document.querySelector('#admin-show-more-controls');
  const visibleCount = document.querySelector('#admin-visible-count');
  if (!list || !showMore || !status || !controls || !visibleCount) return;

  const batchSize = 20;
  let visibleLimit = batchSize;

  function rows() {
    return Array.from(list.querySelectorAll('.admin-application-row'));
  }

  function renderBatch({ resetScroll = false } = {}) {
    const applicationRows = rows();
    const total = applicationRows.length;
    const shown = Math.min(visibleLimit, total);

    applicationRows.forEach((row, index) => {
      const visible = index < shown;
      row.hidden = !visible;
      row.style.display = visible ? '' : 'none';
      row.setAttribute('aria-hidden', visible ? 'false' : 'true');
    });

    visibleCount.textContent = String(total);
    controls.hidden = total === 0;
    showMore.hidden = total <= shown;
    showMore.disabled = total <= shown;
    showMore.setAttribute('aria-disabled', String(showMore.disabled));
    status.textContent = total
      ? shown < total
        ? `Showing ${shown} of ${total} results`
        : `Showing all ${total} results`
      : '0 results';

    if (resetScroll) {
      list.scrollTop = 0;
      list.scrollLeft = 0;
    }
  }

  function resetAfterRender() {
    visibleLimit = batchSize;
    queueMicrotask(() => renderBatch({ resetScroll: true }));
  }

  showMore.addEventListener('click', (event) => {
    event.preventDefault();
    if (showMore.disabled) return;
    visibleLimit += batchSize;
    renderBatch();
  });

  for (const control of document.querySelectorAll('#admin-search, #admin-status-filter, #admin-invite-filter, #admin-ticket-filter')) {
    control.addEventListener(control.matches('input') ? 'input' : 'change', resetAfterRender);
  }

  for (const button of document.querySelectorAll('[data-invite-state-filter], [data-ticket-state-filter]')) {
    button.addEventListener('click', resetAfterRender);
  }

  new MutationObserver(() => renderBatch()).observe(list, { childList: true });
  renderBatch();
})();
