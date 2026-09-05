import { getStore } from '@netlify/blobs';
import { verifyTicketToken } from './_ticket-token.mjs';
import { drinkPackageConfig, drinkPackageAddonEligible } from './_drink-package.mjs';
import { waterPackageConfig, waterPackageAddonEligible, reconcileWaterPackageCheckout } from './_water-package.mjs';
import { lateStayAddonEligible, lateStayAvailability, reconcileLateStayCheckout } from './_late-stay.mjs';

const APPLICATION_STORE = 'nocturne-applications';
const REVIEW_STORE = 'nocturne-application-reviews';
const ORDER_STORE = 'nocturne-ticket-orders';

function escapeHtml(value = '') {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}
function money(cents) { return `$${(Number(cents || 0) / 100).toFixed(0)}`; }
function openCheckout(summary, prefix) {
  if (summary?.[`${prefix}Purchased`] || summary?.[`${prefix}CheckoutStatus`] !== 'checkout_created' || !summary?.[`${prefix}CheckoutUrl`]) return null;
  const expires = new Date(summary?.[`${prefix}CheckoutExpiresAt`] || 0).getTime();
  return Number.isFinite(expires) && expires > Date.now() ? summary[`${prefix}CheckoutUrl`] : null;
}
function statusCard(label, purchased, pendingUrl) {
  if (purchased) return `<div class="addon-status addon-owned"><strong>${escapeHtml(label)}</strong><span>Already on this ticket</span></div>`;
  if (pendingUrl) return `<div class="addon-status addon-pending"><strong>${escapeHtml(label)}</strong><span>A previous checkout is still open. You may resume it, or select this add-on below to replace that checkout with a new combined checkout.</span><a class="btn secondary" href="${escapeHtml(pendingUrl)}">Resume Previous Checkout →</a></div>`;
  return '';
}

function page({ token, guestName, ticketId, drink, water, late, message = '' }) {
  const selectable = [drink, water, late].filter((x) => x.available);
  const owned = [drink, water, late].filter((x) => x.purchased).length;
  const pending = [drink, water, late].filter((x) => x.pendingUrl).length;
  const option = (item, name, title, body) => item.available ? `<label class="drink-package-option addon-choice"><input type="checkbox" name="${name}" value="yes"><span><strong>${escapeHtml(title)} · ${money(item.priceCents)}</strong><small>${escapeHtml(body)}${item.pendingUrl ? ' Selecting this will replace the previous unpaid checkout.' : ''}</small></span></label>` : '';
  const alert = message ? `<div class="private-access-status"><strong>${escapeHtml(message)}</strong></div>` : '';
  const form = selectable.length ? `<form method="post" action="/ticket/addons/checkout" class="private-access-checkout addon-manager-form">
    <input type="hidden" name="token" value="${escapeHtml(token)}">
    ${option(drink, 'drink_package', 'Six-Drink Package', 'Six prepaid credits for beer or well cocktails. Premium cocktails use one credit plus a $5 upgrade at the bar. 21+ photo ID required.')}
    ${option(water, 'water_package', 'Unlimited Drinking Water', 'Unlimited drinking-water service for the registered ticket holder throughout festival operating hours.')}
    ${option(late, 'late_stay', 'Late Checkout / Car Camping', 'Remain on the property after the 3:00 AM event end until 10:00 AM, including resting or sleeping in your vehicle where directed by staff.')}
    <label class="drink-package-option" data-addon-policy><input type="checkbox" name="package_policy" value="yes" disabled><span><strong>I understand every selected add-on is FINAL SALE / NON-REFUNDABLE.</strong><small>This single acknowledgment applies to all add-ons selected above.</small></span></label>
    <div class="private-access-actions"><button class="btn" type="submit">Checkout Selected Add-Ons →</button></div>
  </form>` : '<div class="private-access-status"><strong>No additional add-ons are currently available for this ticket.</strong></div>';
  const states = [
    statusCard('Six-Drink Package', drink.purchased, drink.pendingUrl),
    statusCard('Unlimited Drinking Water', water.purchased, water.pendingUrl),
    statusCard('Late Checkout / Car Camping', late.purchased, late.pendingUrl)
  ].join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#030303"><meta name="robots" content="noindex,nofollow,noarchive"><title>Manage Add-Ons | NOCTURNE</title><link rel="icon" href="/assets/images/favicon.png"><link rel="stylesheet" href="/assets/css/styles.css"><link rel="stylesheet" href="/assets/css/private-access.css"><style>.addon-manager-form{margin-top:1rem}.addon-choice{margin:.8rem 0}.addon-status{margin:.75rem 0;padding:1rem;border:1px solid rgba(216,154,43,.28);background:rgba(216,154,43,.04);display:grid;gap:.45rem;text-align:left}.addon-status strong{color:#f5e7ce}.addon-status span{color:#928570;font-size:.72rem;line-height:1.5}.addon-status .btn{margin-top:.35rem}.addon-owned{border-color:rgba(86,197,124,.42)}.addon-pending{border-color:rgba(255,202,97,.42)}</style><script src="/assets/js/ticket-package-policy.js?v=20260905c" defer></script></head><body class="private-access-page"><main class="private-access-shell"><section class="private-access-card"><div class="private-access-logo-wrap"><img class="private-access-logo" src="/assets/images/nocturne-logo.webp" alt="NOCTURNE Festival — presented by Wild Ones" width="1536" height="768"></div><p class="section-kicker">Ticket Add-Ons</p><h1>Manage<br>your add-ons.</h1><p>${escapeHtml(guestName || 'NOCTURNE Guest')} · ${escapeHtml(ticketId)}</p>${alert}<div class="private-access-status"><strong>${owned} owned · ${selectable.length} available${pending ? ` · ${pending} previous checkout${pending === 1 ? '' : 's'} open` : ''}</strong><br>Select any combination below and pay once through Stripe.</div>${states}${form}<p class="ticket-location-note">One of each add-on per ticket. Add-ons are personal to the registered ticket holder and are FINAL SALE / NON-REFUNDABLE.</p><div class="private-access-actions"><a class="btn secondary" href="/ticket?token=${encodeURIComponent(token)}">Back to Digital Ticket</a></div></section></main></body></html>`;
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
    summaryEntry = await orderStore.getWithMetadata(key, { type: 'json', consistency: 'strong' });
    summary = summaryEntry?.data || summary;
  }
  if (!summary.lateStayPurchased && summary.lateStayCheckoutStatus === 'checkout_created') {
    summary = await reconcileLateStayCheckout({ summaryEntry, orderStore, reviewStore }).catch(() => summary);
    summaryEntry = await orderStore.getWithMetadata(key, { type: 'json', consistency: 'strong' });
    summary = summaryEntry?.data || summary;
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
