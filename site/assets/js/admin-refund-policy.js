(() => {
  const PACKAGE_LABELS = new Set([
    'Refund drink package only',
    'Package non-refundable — drink redeemed',
    'Refund admission + package',
    'Refund both in Stripe'
  ]);

  function panelHasPackage(panel) {
    return Array.from(panel.querySelectorAll('.admin-ticket-card')).some((card) => {
      const label = card.querySelector('small')?.textContent?.trim();
      const value = card.querySelector('p, a')?.textContent?.trim();
      return ['Drink package', 'Unlimited water'].includes(label) && value && value !== '—';
    });
  }

  function applyPolicy(root = document) {
    for (const panel of root.querySelectorAll('.admin-ticket-panel')) {
      const hasPackage = panelHasPackage(panel);
      for (const button of panel.querySelectorAll('button.admin-danger-button')) {
        const label = button.textContent.trim();
        if (PACKAGE_LABELS.has(label)) {
          button.disabled = true;
          button.textContent = 'Drink package — non-refundable';
          button.title = 'All NOCTURNE drink packages are FINAL SALE / NON-REFUNDABLE.';
          continue;
        }
        if (hasPackage && label === 'Refund & cancel ticket') {
          button.disabled = false;
          button.title = 'Refunds only the refundable admission portion. Any drink-package amount remains non-refundable and the attached package is forfeited when admission is canceled.';
        }
      }
    }
  }

  applyPolicy();
  const detail = document.querySelector('#admin-detail');
  if (detail) {
    new MutationObserver(() => queueMicrotask(() => applyPolicy(detail)))
      .observe(detail, { childList: true, subtree: true });
  }
})();
