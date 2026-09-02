import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const scriptTag = '<script src="/assets/js/public-ticket-pricing.js?v=20260901b" defer></script>';
const styleTag = '<link rel="stylesheet" href="/assets/css/public-offers.css?v=20260901a">';
const files = ['site/index.html', 'site/festival.html'];

const priceAlert = `
    <aside class="ticket-price-alert" data-ticket-price-alert aria-label="Ticket price update">
      <strong>Ticket price increases tonight.</strong>
      <span data-ticket-price-alert-copy>Approved admission is $25 through 11:59 PM HST tonight. The price becomes $35 at midnight.</span>
    </aside>`;

const addOns = `
        <section class="public-addons" id="optional-addons" aria-labelledby="optional-addons-title">
          <div class="public-addons-head">
            <div><p class="section-kicker">Optional Add-Ons</p><h3 id="optional-addons-title">Make the night<br><em>yours.</em></h3></div>
            <p>Eligible guests can add options during private checkout or, when available, from their digital ticket after purchasing admission.</p>
          </div>
          <div class="public-addon-grid">
            <article class="public-addon-card"><small>$55</small><strong>Six-Drink<br>Package</strong><p>Six beverage credits for the registered ticket holder.</p></article>
            <article class="public-addon-card"><small>$15</small><strong>Unlimited<br>Drinking Water</strong><p>Unlimited drinking-water service throughout festival operating hours.</p></article>
            <article class="public-addon-card"><small>$20</small><strong>Late Checkout /<br>Car Camping</strong><p>Stay on the property after the 3:00 AM event end until 8:00 AM. Limited to the first 30 purchasers.</p></article>
          </div>
          <p class="public-addon-policy"><strong>All add-ons are FINAL SALE / NON-REFUNDABLE.</strong> Add-ons are personal, non-transferable, subject to availability, and must be attached to the registered guest's ticket.</p>
        </section>`;

const addOnFaq = `<div class="faq-item"><button aria-expanded="false"><span>What optional add-ons are available?</span><span class="plus">+</span></button><div class="faq-answer"><p>Approved ticket holders can choose from the <strong>$55 Six-Drink Package</strong>, <strong>$15 Unlimited Drinking Water Package</strong>, and <strong>$20 Late Checkout / Car Camping</strong> add-on. The Six-Drink Package includes six beverage credits. Unlimited Water covers drinking-water service during festival operating hours. Late Checkout / Car Camping allows the registered ticket holder to remain on the property after 3:00 AM until 8:00 AM and is limited to the first 30 purchasers. All add-ons are personal, non-transferable, <strong>final sale / non-refundable</strong>, and subject to availability.</p></div></div>`;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceFaq(html, question) {
  const pattern = new RegExp(`<div class="faq-item"><button aria-expanded="false"><span>${escapeRegex(question)}<\\/span><span class="plus">\\+<\\/span><\\/button><div class="faq-answer"><p>[\\s\\S]*?<\\/p><\\/div><\\/div>`, 'g');
  return html.replace(pattern, addOnFaq);
}

for (const relative of files) {
  const file = path.join(root, relative);
  let html = fs.readFileSync(file, 'utf8');

  if (!html.includes(styleTag)) html = html.replace('</head>', `  ${styleTag}\n</head>`);
  if (!html.includes(scriptTag)) html = html.replace('</body>', `  ${scriptTag}\n</body>`);

  html = html.replace(/(<meta[^>]+content=")[^"]*\$25[^"]*("[^>]*>)/gi, (match) => {
    if (match.includes('$25 through Sept. 1 · $35 beginning Sept. 2')) return match;
    return match.replaceAll('$25', '$25 through Sept. 1 · $35 beginning Sept. 2');
  });

  if (!html.includes('data-ticket-price-alert')) html = html.replace('<main id="main">', `<main id="main">${priceAlert}`);

  if (!html.includes('id="optional-addons"')) {
    html = html.replace(/<div class="event-facts"[^>]*>[\s\S]*?<\/div>/, (eventFacts) => `${eventFacts}${addOns}`);
  }

  html = replaceFaq(html, 'Are drink or water packages available?');
  html = replaceFaq(html, 'Are there optional drink packages?');

  fs.writeFileSync(file, html);
}

console.log('Public ticket-price alert and optional add-ons injected.');
