(() => {
  const deadlinePhrases = [
    '$25 through Sept. 1 · $35 beginning Sept. 2',
    '$25 through 11:59 PM HST tonight · $35 beginning at midnight',
    '$25 approved admission ends at 11:59 PM HST tonight. The price becomes $35 at midnight.'
  ];

  function replaceCurrentPriceText(text, before, current) {
    if (!text?.includes(before) || current === before) return text;
    if (deadlinePhrases.some((phrase) => text.includes(phrase))) return text;
    return text.replaceAll(before, current);
  }

  async function loadPricing() {
    try {
      const response = await fetch('/api/ticket/pricing', { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (!response.ok) return;
      const pricing = await response.json();
      const current = String(pricing.displayPrice || '').trim();
      const before = String(pricing.beforeDisplayPrice || '$25').trim();
      if (!current || !before) return;

      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue?.includes(before)) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent || ['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(parent.tagName)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      for (const node of nodes) node.nodeValue = replaceCurrentPriceText(node.nodeValue, before, current);

      for (const meta of document.querySelectorAll('meta[content]')) {
        meta.content = replaceCurrentPriceText(meta.content, before, current);
      }

      const alert = document.querySelector('[data-ticket-price-alert]');
      const alertCopy = document.querySelector('[data-ticket-price-alert-copy]');
      if (alert && alertCopy) {
        if (pricing.changed) {
          alert.querySelector('strong').textContent = 'Current ticket price';
          alertCopy.textContent = `Approved admission is now ${current}.`;
        } else {
          alert.querySelector('strong').textContent = 'Ticket price increases tonight';
          alertCopy.textContent = `${before} approved admission ends at 11:59 PM HST tonight. The price becomes ${pricing.afterDisplayPrice || '$35'} at midnight.`;
        }
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
