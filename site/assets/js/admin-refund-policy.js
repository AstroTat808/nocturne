(() => {
  const PACKAGE_LABELS = new Set([
    'Refund drink package only',
    'Package non-refundable — drink redeemed',
    'Refund admission + package',
    'Refund both in Stripe'
  ]);

  function panelHasDrinkPackage(panel) {
    return Array.from(panel.querySelectorAll('.admin-ticket-card')).some((card) => {
      const label = card.querySelector('small')?.textContent?.trim();
      const value = card.querySelector('p, a')?.textContent?.trim();
      return label === 'Drink package' && value && value !== '—';
    });
  }

  function applyPolicy(root = document) {
    for (const panel of root.querySelectorAll('.admin-ticket-panel')) {
      const hasPackage = panelHasDrinkPackage(panel);
      for (const button of panel.querySelectorAll('button.admin-danger-button')) {
        const label = button.textContent.trim();
        if (PACKAGE_LABELS.has(label)) {
          button.disabled = true;
          button.textContent = 'Drink package — non-refundable';
          button.title = 'All NOCTURNE drink packages are final sale and non-refundable.';
          continue;
        }
        if (hasPackage && label === 'Refund & cancel ticket') {
          button.disabled = true;
          button.textContent = 'Admission refund requires partial Stripe review';
          button.title = 'This ticket has a non-refundable drink package. Do not use a full automatic refund because it could refund the package amount. Refund only the eligible admission portion directly in Stripe.';
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
