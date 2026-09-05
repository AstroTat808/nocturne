import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const scriptTag = '<script src="/assets/js/public-ticket-pricing.js?v=20260905a" defer></script>';
const styleTag = '<link rel="stylesheet" href="/assets/css/public-offers.css?v=20260901b">';
const factStyleTag = '<link rel="stylesheet" href="/assets/css/event-facts-polish.css?v=20260901a">';
const files = ['site/index.html', 'site/festival.html'];
const currentPrice = '$35';

const priceAlert = `
    <aside class="ticket-price-alert" data-ticket-price-alert aria-label="Current ticket price">
      <strong>Current ticket price</strong>
      <span data-ticket-price-alert-copy>Approved admission is now $35.</span>
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
            <article class="public-addon-card"><small>$20</small><strong>Late Checkout /<br>Car Camping</strong><p>Stay on the property after the 3:00 AM event end until 10:00 AM.</p></article>
          </div>
          <p class="public-addon-policy"><strong>All add-ons are FINAL SALE / NON-REFUNDABLE.</strong> Add-ons are personal, non-transferable, subject to availability, and must be attached to the registered guest's ticket.</p>
        </section>`;

const addOnFaq = `<div class="faq-item"><button aria-expanded="false"><span>What optional add-ons are available?</span><span class="plus">+</span></button><div class="faq-answer"><p>Approved ticket holders can choose from the <strong>$55 Six-Drink Package</strong>, <strong>$15 Unlimited Drinking Water Package</strong>, and <strong>$20 Late Checkout / Car Camping</strong> add-on. The Six-Drink Package includes six beverage credits. Unlimited Water covers drinking-water service during festival operating hours. Late Checkout / Car Camping allows the registered ticket holder to remain on the property after 3:00 AM until 10:00 AM. All add-ons are personal, non-transferable, <strong>final sale / non-refundable</strong>, and subject to availability.</p></div></div>`;

function ticketCard(note) {
  return `<article class="event-fact event-fact-ticket"><small>Ticket</small><strong class="ticket-price-current" data-ticket-current-price>${currentPrice}</strong><p class="ticket-price-window" data-ticket-price-window>Current approved admission price</p><p class="ticket-price-note">${note}</p></article>`;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceFaq(html, question) {
  const pattern = new RegExp(`<div class="faq-item"><button aria-expanded="false"><span>${escapeRegex(question)}<\\/span><span class="plus">\\+<\\/span><\\/button><div class="faq-answer"><p>[\\s\\S]*?<\\/p><\\/div><\\/div>`, 'g');
  return html.replace(pattern, addOnFaq);
}

function normalizeHistoricalPriceCopy(html) {
  const replacements = [
    ['$25 through September 1 · $35 starting at 12:00 AM HST September 2', currentPrice],
    ['$25 through Sept. 1 · $35 starting midnight Sept. 2', currentPrice],
    ['$25 THROUGH SEPT 1 · $35 STARTING MIDNIGHT SEPT 2', '$35 APPROVED ACCESS'],
    ['<span>$25 if approved</span>', `<span>${currentPrice} if approved</span>`],
    ['Approved applicants receive access to purchase a $25 ticket, subject to availability.', `Approved applicants receive access to purchase a ${currentPrice} ticket, subject to availability.`],
    ['Tickets are $25 and are not offered through an open public sale.', `Tickets are ${currentPrice} and are not offered through an open public sale.`],
    ['Redeem your invitation to unlock the private $25 ticket checkout.', `Redeem your invitation to unlock the private ${currentPrice} ticket checkout.`],
    ['unlocks your $25 ticket purchase', `unlocks your ${currentPrice} ticket purchase`],
    ['purchase a $25 ticket, subject to availability and the applicable event terms.', `purchase a ${currentPrice} ticket, subject to availability and the applicable event terms.`],
    ['unlocks your private $25 ticket checkout.', `unlocks your private ${currentPrice} ticket checkout.`],
    ['Approved tickets are $25.', `Approved tickets are ${currentPrice}.`],
    ['purchase the $25 festival ticket.', `purchase the ${currentPrice} festival ticket.`],
    ['NOCTURNE Festival tickets are $25, but ticket checkout is private.', `NOCTURNE Festival tickets are ${currentPrice}, but ticket checkout is private.`],
    ['complete the private $25 ticket checkout for your individual admission.', `complete the private ${currentPrice} ticket checkout for your individual admission.`],
    ['Tickets are $25 for approved applicants.', `Tickets are ${currentPrice} for approved applicants.`],
    ['unlock the private $25 ticket checkout.', `unlock the private ${currentPrice} ticket checkout.`]
  ];
  for (const [from, to] of replacements) html = html.replaceAll(from, to);

  html = html.replace(/(<meta[^>]+content=")([^"]*)("[^>]*>)/gi, (match, start, content, end) => {
    const next = content
      .replaceAll('$25 through September 1 · $35 starting at 12:00 AM HST September 2', currentPrice)
      .replaceAll('$25 approved tickets', '$35 approved tickets')
      .replaceAll('$25 approved admission', '$35 approved admission')
      .replaceAll('$25 tickets', '$35 tickets');
    return `${start}${next}${end}`;
  });
  return html;
}

for (const relative of files) {
  const file = path.join(root, relative);
  let html = fs.readFileSync(file, 'utf8');

  if (!html.includes(styleTag)) html = html.replace('</head>', `  ${styleTag}\n</head>`);
  if (!html.includes(factStyleTag)) html = html.replace('</head>', `  ${factStyleTag}\n</head>`);
  if (!html.includes(scriptTag)) {
    html = html.replace(/<script src="\/assets\/js\/public-ticket-pricing\.js\?v=[^"]+" defer><\/script>/g, '');
    html = html.replace('</body>', `  ${scriptTag}\n</body>`);
  }

  html = normalizeHistoricalPriceCopy(html);
  html = html.replace(/<article class="event-fact(?: event-fact-ticket)?"><small>Ticket<\/small>[\s\S]*?<\/article>/, (card) => {
    if (!/\$25|data-ticket-current-price/.test(card)) return card;
    const note = card.includes('Private checkout becomes available')
      ? 'Private checkout becomes available after your invitation request is approved.'
      : 'Available only after your invitation request is approved.';
    return ticketCard(note);
  });

  const existingAlert = /\s*<aside class="ticket-price-alert"[\s\S]*?<\/aside>/;
  if (existingAlert.test(html)) html = html.replace(existingAlert, priceAlert);
  else html = html.replace(/<\/header>\s*<main id="main">/, () => `</header>${priceAlert}\n  <main id="main">`);

  if (!html.includes('id="optional-addons"')) {
    html = html.replace(/<div class="event-facts"[^>]*>[\s\S]*?<\/div>/, (eventFacts) => `${eventFacts}${addOns}`);
  } else {
    html = html
      .replaceAll('Stay on the property after the 3:00 AM event end until 8:00 AM. Limited to the first 30 purchasers.', 'Stay on the property after the 3:00 AM event end until 10:00 AM.')
      .replaceAll('Late Checkout / Car Camping allows the registered ticket holder to remain on the property after 3:00 AM until 8:00 AM and is limited to the first 30 purchasers.', 'Late Checkout / Car Camping allows the registered ticket holder to remain on the property after 3:00 AM until 10:00 AM.');
  }

  html = replaceFaq(html, 'Are drink or water packages available?');
  html = replaceFaq(html, 'Are there optional drink packages?');
  html = replaceFaq(html, 'What optional add-ons are available?');

  fs.writeFileSync(file, html);
}

console.log('Current $35 public ticket pricing, event facts, and optional add-ons injected.');
