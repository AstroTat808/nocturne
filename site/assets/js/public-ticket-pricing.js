(() => {
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
      for (const node of nodes) node.nodeValue = node.nodeValue.replaceAll(before, current);

      for (const meta of document.querySelectorAll('meta[content]')) {
        if (meta.content.includes(before)) meta.content = meta.content.replaceAll(before, current);
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
