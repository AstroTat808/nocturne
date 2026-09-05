(() => {
  const historicalPhrases = [
    '$25 through Sept. 1 · $35 beginning Sept. 2',
    '$25 through 11:59 PM HST tonight · $35 beginning at midnight',
    '$25 approved admission ends at 11:59 PM HST tonight. The price becomes $35 at midnight.',
    '$25 through September 1 · $35 starting at 12:00 AM HST September 2',
    '$25 through Sept. 1 · $35 starting midnight Sept. 2',
    '$25 THROUGH SEPT 1 · $35 STARTING MIDNIGHT SEPT 2'
  ];

  function normalizeText(text, before, current) {
    let next = String(text || '');
    for (const phrase of historicalPhrases) next = next.replaceAll(phrase, current);
    if (before && current && before !== current) next = next.replaceAll(before, current);
    return next;
  }

  async function loadPricing() {
    try {
      const response = await fetch('/api/ticket/pricing', { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (!response.ok) return;
      const pricing = await response.json();
      const current = String(pricing.displayPrice || '').trim();
      const before = String(pricing.beforeDisplayPrice || '$25').trim();
      if (!current) return;

      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const value = node.nodeValue || '';
          if (!value.includes(before) && !historicalPhrases.some((phrase) => value.includes(phrase))) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(parent.tagName)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      for (const node of nodes) node.nodeValue = normalizeText(node.nodeValue, before, current);

      for (const meta of document.querySelectorAll('meta[content]')) meta.content = normalizeText(meta.content, before, current);
      for (const element of document.querySelectorAll('[data-ticket-current-price]')) element.textContent = current;
      for (const windowCopy of document.querySelectorAll('[data-ticket-price-window]')) windowCopy.textContent = 'Current approved admission price';
      for (const increaseCopy of document.querySelectorAll('[data-ticket-price-increase]')) increaseCopy.remove();

      const alert = document.querySelector('[data-ticket-price-alert]');
      const alertCopy = document.querySelector('[data-ticket-price-alert-copy]');
      if (alert && alertCopy) {
        alert.querySelector('strong').textContent = 'Current ticket price';
        alertCopy.textContent = `Approved admission is now ${current}.`;
      }

      document.documentElement.dataset.ticketPrice = current;
      document.documentElement.dataset.ticketPriceChanged = String(Boolean(pricing.changed));
    } catch (error) {
      console.warn('NOCTURNE public ticket pricing unavailable:', error);
    }
  }

  loadPricing();
  window.setInterval(loadPricing, 60 * 1000);
})();
