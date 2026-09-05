import { getStore } from '@netlify/blobs';
import { verifyTicketToken } from './_ticket-token.mjs';
import { drinkPackageConfig, drinkPackageAddonEligible } from './_drink-package.mjs';
import { waterPackageConfig, waterPackageAddonEligible, reconcileWaterPackageCheckout } from './_water-package.mjs';
import { lateStayAddonEligible, lateStayAvailability, reconcileLateStayCheckout } from './_late-stay.mjs';

const APPLICATION_STORE = 'nocturne-applications';
const REVIEW_STORE = 'nocturne-application-reviews';
const ORDER_STORE = 'nocturne-ticket-orders';

function escapeHtml(value = '') { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;'); }
function money(cents) { return `$${(Number(cents || 0) / 100).toFixed(0)}`; }
function openCheckout(summary, prefix) {
  if (summary?.[`${prefix}Purchased`] || summary?.[`${prefix}CheckoutStatus`] !== 'checkout_created' || !summary?.[`${prefix}CheckoutUrl`]) return null;
  const expires = new Date(summary?.[`${prefix}CheckoutExpiresAt`] || 0).getTime();
  return Number.isFinite(expires) && expires > Date.now() ? summary[`${prefix}CheckoutUrl`] : null;
}
function statusCard(label, purchased, pendingUrl) {
  if (purchased) return `<div class="addon-status addon-owned"><strong>${escapeHtml(label)}</strong><span>Already on this ticket</span></div>`;
  if (pendingUrl) return `<div class="addon-status addon-pending"><strong>${escapeHtml(label)}</strong><span>A previous checkout is still open. Resume it, or select this add-on below to replace that unpaid checkout with a new combined checkout.</span><a class="btn secondary" href="${escapeHtml(pendingUrl)}">Resume Previous Checkout →</a></div>`;
  return '';
}
function option(item, { name, title, body, badge = '', featured = false, className = '' }) {
  if (!item.available) return '';
  return `<label class="addon-card ${featured ? 'addon-card-featured' : ''} ${className}" data-addon-choice data-price-cents="${Number(item.priceCents || 0)}">
    <input type="checkbox" name="${name}" value="yes">
    <span class="addon-card-copy">
      <span class="addon-card-top">${badge ? `<em class="addon-badge">${escapeHtml(badge)}</em>` : '<em class="addon-badge addon-badge-quiet">OPTIONAL</em>'}<strong class="addon-price">${money(item.priceCents)}</strong></span>
      <strong class="addon-title">${escapeHtml(title)}</strong>
      <small>${escapeHtml(body)}${item.pendingUrl ? ' Selecting this will replace the previous unpaid checkout.' : ''}</small>
      <span class="addon-select-copy">Select this add-on</span>
    </span>
  </label>`;
}

function page({ token, guestName, ticketId, drink, water, late, message = '' }) {
  const selectable = [drink, water, late].filter((x) => x.available);
  const owned = [drink, water, late].filter((x) => x.purchased).length;
  const pending = [drink, water, late].filter((x) => x.pendingUrl).length;
  const alert = message ? `<div class="private-access-status"><strong>${escapeHtml(message)}</strong></div>` : '';
  const cards = [
    option(drink, { name: 'drink_package', title: 'Six-Drink Package', badge: 'MOST POPULAR', featured: true, className: 'addon-card-drink', body: 'Six prepaid credits for beer or well cocktails. Premium cocktails use one credit plus a $5 upgrade at the bar. 21+ photo ID required.' }),
    option(late, { name: 'late_stay', title: 'Late Checkout / Car Camping', badge: 'STAY UNTIL 10 AM', featured: true, className: 'addon-card-late', body: 'Remain on the property after the 3:00 AM event end until 10:00 AM, including resting or sleeping in your vehicle where directed by staff.' }),
    option(water, { name: 'water_package', title: 'Unlimited Drinking Water', className: 'addon-card-water', body: 'Unlimited drinking-water service for the registered ticket holder throughout festival operating hours.' })
  ].join('');
  const form = selectable.length ? `<form method="post" action="/ticket/addons/checkout" class="private-access-checkout addon-manager-form">
    <input type="hidden" name="token" value="${escapeHtml(token)}">
    <div class="addon-grid">${cards}</div>
    <label class="drink-package-option addon-policy" data-addon-policy><input type="checkbox" name="package_policy" value="yes" disabled><span><strong>I understand every selected add-on is FINAL SALE / NON-REFUNDABLE.</strong><small>This single acknowledgment applies to all add-ons selected above.</small></span></label>
    <div class="addon-total"><div><span data-addon-count>Nothing selected yet</span><small>One Stripe checkout</small></div><strong data-addon-total>$0</strong></div>
    <div class="private-access-actions"><button class="btn" type="submit" disabled>Checkout Selected Add-Ons →</button></div>
  </form>` : '<div class="private-access-status"><strong>No additional add-ons are currently available for this ticket.</strong></div>';
  const states = [statusCard('Six-Drink Package', drink.purchased, drink.pendingUrl), statusCard('Unlimited Drinking Water', water.purchased, water.pendingUrl), statusCard('Late Checkout / Car Camping', late.purchased, late.pendingUrl)].join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#030303"><meta name="robots" content="noindex,nofollow,noarchive"><title>Buy / Manage Add-Ons | NOCTURNE</title><link rel="icon" href="/assets/images/favicon.png"><link rel="stylesheet" href="/assets/css/styles.css"><link rel="stylesheet" href="/assets/css/private-access.css"><style>
  .addon-hero{margin:.4rem auto 1.35rem;max-width:680px;color:#b9aa93;line-height:1.65}.addon-hero strong{color:#f5e7ce}.addon-manager-form{margin-top:1.1rem}.addon-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}.addon-card{position:relative;display:block;cursor:pointer;padding:1.25rem;border:1px solid rgba(216,154,43,.26);background:linear-gradient(145deg,rgba(20,17,12,.92),rgba(2,2,2,.94));text-align:left;transition:transform .18s ease,border-color .18s ease,box-shadow .18s ease}.addon-card:hover{transform:translateY(-2px);border-color:rgba(216,154,43,.55)}.addon-card-featured{border-color:rgba(227,172,67,.52);box-shadow:0 16px 45px rgba(0,0,0,.24),inset 0 0 32px rgba(216,154,43,.035)}.addon-card-drink{background:radial-gradient(circle at 85% 10%,rgba(216,154,43,.17),transparent 42%),linear-gradient(145deg,rgba(25,20,12,.96),rgba(2,2,2,.95))}.addon-card-late{background:radial-gradient(circle at 85% 10%,rgba(125,104,170,.18),transparent 42%),linear-gradient(145deg,rgba(18,15,25,.96),rgba(2,2,2,.95))}.addon-card-water{grid-column:1/-1;opacity:.9}.addon-card input{position:absolute;right:1rem;bottom:1rem;width:1.2rem;height:1.2rem;accent-color:#d89a2b}.addon-card-top{display:flex;align-items:center;justify-content:space-between;gap:.8rem;margin-bottom:1rem}.addon-badge{display:inline-block;padding:.34rem .55rem;border:1px solid rgba(227,172,67,.65);color:#f0bd5d;background:rgba(216,154,43,.08);font-style:normal;font-size:.56rem;font-weight:800;letter-spacing:.14em}.addon-badge-quiet{color:#8f8372;border-color:rgba(143,131,114,.3);background:transparent}.addon-price{font-family:var(--serif);font-size:1.6rem;color:#f5e7ce;font-weight:500}.addon-title{display:block;margin-bottom:.6rem;font-family:var(--serif);font-size:1.28rem;color:#f5e7ce;font-weight:500;line-height:1.2}.addon-card small{display:block;padding-right:1.5rem;color:#a99b86;line-height:1.55}.addon-select-copy{display:inline-block;margin-top:1rem;color:#d9a947;font-size:.62rem;font-weight:700;letter-spacing:.1em;text-transform:uppercase}.addon-card.is-selected{border-color:#efbd60;box-shadow:0 0 0 1px rgba(239,189,96,.28),0 18px 50px rgba(0,0,0,.32)}.addon-card.is-selected .addon-select-copy::after{content:' ✓'}.addon-policy{margin:1rem 0}.addon-total{display:flex;justify-content:space-between;align-items:center;gap:1rem;margin:1rem 0;padding:1rem 1.15rem;border:1px solid rgba(216,154,43,.34);background:rgba(216,154,43,.055);text-align:left}.addon-total span{display:block;color:#f5e7ce;font-size:.78rem}.addon-total small{display:block;color:#8f8372;font-size:.62rem;margin-top:.2rem}.addon-total>strong{font-family:var(--serif);font-size:2rem;font-weight:500;color:#f0bd5d}.addon-status{margin:.75rem 0;padding:1rem;border:1px solid rgba(216,154,43,.28);background:rgba(216,154,43,.04);display:grid;gap:.45rem;text-align:left}.addon-status strong{color:#f5e7ce}.addon-status span{color:#928570;font-size:.72rem;line-height:1.5}.addon-status .btn{margin-top:.35rem}.addon-owned{border-color:rgba(86,197,124,.42)}.addon-pending{border-color:rgba(255,202,97,.42)}button[disabled]{opacity:.48;cursor:not-allowed}@media(max-width:650px){.addon-grid{grid-template-columns:1fr}.addon-card-water{grid-column:auto}}
  </style><script src="/assets/js/ticket-package-policy.js?v=20260905c" defer></script><script src="/assets/js/addon-manager.js?v=20260905a" defer></script></head><body class="private-access-page"><main class="private-access-shell"><section class="private-access-card"><div class="private-access-logo-wrap"><img class="private-access-logo" src="/assets/images/nocturne-logo.webp" alt="NOCTURNE Festival — presented by Wild Ones" width="1536" height="768"></div><p class="section-kicker">Ticket Add-Ons</p><h1>Upgrade<br>your NOCTURNE.</h1><p class="addon-hero"><strong>${escapeHtml(guestName || 'NOCTURNE Guest')}</strong> · Select one, two, or all three. Your running total updates below and everything selected is paid for in one Stripe checkout.</p>${alert}<div class="private-access-status"><strong>${owned} owned · ${selectable.length} available${pending ? ` · ${pending} previous checkout${pending === 1 ? '' : 's'} open` : ''}</strong></div>${states}${form}<p class="ticket-location-note">One of each add-on per ticket. Add-ons are personal to the registered ticket holder and are FINAL SALE / NON-REFUNDABLE.</p><div class="private-access-actions"><a class="btn secondary" href="/ticket?token=${encodeURIComponent(token)}">Back to Digital Ticket</a></div></section></main></body></html>`;
}

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method not allowed.', { status: 405 });
  const url = new URL(req.url);
  const token = String(url.searchParams.get('token') || '').trim();
  const parsed = verifyTicketToken(token);
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex,nofollow,noarchive', 'Referrer-Policy': 'no-referrer' };
  if (!parsed) return new Response(page({ token: '', guestName: '', ticketId: '', drink: {}, water: {}, late: {}, message: 'This digital ticket link is invalid.' }), { status: 400, headers });

  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const applicationStore = getStore({ name: APPLICATION_STORE, consistency: 'strong' });
  const key = `submission-${parsed.submissionId}`;
  let [summaryEntry, review, application] = await Promise.all([
    orderStore.getWithMetadata(key, { type: 'json', consistency: 'strong' }),
    reviewStore.get(parsed.submissionId, { type: 'json', consistency: 'strong' }),
    applicationStore.get(parsed.submissionId, { type: 'json', consistency: 'strong' })
  ]);
  let summary = summaryEntry?.data || null;
  if (!summary || summary.status !== 'paid' || summary.ticketId !== parsed.ticketId || !['paid', 'checked_in'].includes(String(review?.ticketState || ''))) {
    return new Response(page({ token, guestName: '', ticketId: parsed.ticketId, drink: {}, water: {}, late: {}, message: 'This ticket is not active.' }), { status: 403, headers });
  }

  if (!summary.waterPackagePurchased && summary.waterPackageCheckoutStatus === 'checkout_created') {
    summary = await reconcileWaterPackageCheckout({ summaryEntry, orderStore, reviewStore }).catch(() => summary);
    summaryEntry = await orderStore.getWithMetadata(key, { type: 'json', consistency: 'strong' }); summary = summaryEntry?.data || summary;
  }
  if (!summary.lateStayPurchased && summary.lateStayCheckoutStatus === 'checkout_created') {
    summary = await reconcileLateStayCheckout({ summaryEntry, orderStore, reviewStore }).catch(() => summary);
    summaryEntry = await orderStore.getWithMetadata(key, { type: 'json', consistency: 'strong' }); summary = summaryEntry?.data || summary;
  }

  const drinkConfig = drinkPackageConfig();
  const waterConfig = waterPackageConfig();
  const lateConfig = await lateStayAvailability();
  const stripeReady = Boolean(process.env.STRIPE_SECRET_KEY);
  const drinkPending = openCheckout(summary, 'drinkPackage');
  const waterPending = openCheckout(summary, 'waterPackage');
  const latePending = openCheckout(summary, 'lateStay');
  const drink = { purchased: Boolean(summary.drinkPackagePurchased), pendingUrl: drinkPending, priceCents: drinkConfig.priceCents, available: drinkConfig.enabled && stripeReady && drinkPackageAddonEligible(summary, review, parsed.ticketId) };
  const water = { purchased: Boolean(summary.waterPackagePurchased), pendingUrl: waterPending, priceCents: waterConfig.priceCents, available: waterConfig.enabled && stripeReady && waterPackageAddonEligible(summary, review, parsed.ticketId) };
  const late = { purchased: Boolean(summary.lateStayPurchased), pendingUrl: latePending, priceCents: lateConfig.priceCents, available: lateConfig.enabled && stripeReady && lateStayAddonEligible(summary, review, parsed.ticketId) };
  return new Response(page({ token, guestName: application?.preferredName || application?.fullName || '', ticketId: parsed.ticketId, drink, water, late, message: url.searchParams.get('error') || '' }), { status: 200, headers });
};
