import { getStore } from '@netlify/blobs';
import { verifyTicketToken } from './_ticket-token.mjs';
import { appleWalletConfigured } from './_apple-wallet.mjs';
import { drinkPackageConfig } from './_drink-package.mjs';
import { privateVenue, privateVenueConfigured, privateVenueMapUrl } from './_venue.mjs';

const ORDER_STORE = 'nocturne-ticket-orders';
const APPLICATION_STORE = 'nocturne-applications';
const REVIEW_STORE = 'nocturne-application-reviews';

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function page({ valid = false, checkedIn = false, ticketId = '', guestName = '', ticketName = '', token = '', message = '', drinkPackage = null, drinkPackageAddon = null, appleWalletAvailable = false }) {
  const qr = valid ? `/ticket/qr?token=${encodeURIComponent(token)}` : '';
  const status = checkedIn
    ? '<div class="private-access-status"><strong>Already checked in.</strong><br>This ticket was previously admitted.</div>'
    : valid
      ? '<div class="private-access-status"><strong>Valid paid ticket.</strong><br>Present this QR code at event check-in.</div>'
      : `<div class="private-access-status"><strong>${escapeHtml(message || 'Invalid ticket.')}</strong></div>`;

  const venue = privateVenue();
  const mapUrl = privateVenueMapUrl();
  const eventDetails = valid ? `<section class="ticket-event-details" aria-label="NOCTURNE event details">
    <p class="section-kicker">Event Details</p>
    <div class="ticket-event-grid">
      <div><span>Date &amp; Time</span><strong>Sunday, September 6, 2026<br>3:00 PM — 3:00 AM</strong></div>
      <div><span>Private Location</span><strong>${escapeHtml(venue.name)}<br><span class="ticket-address">${escapeHtml(venue.address)}</span></strong></div>
    </div>
    <a class="ticket-map-link" href="${escapeHtml(mapUrl)}" target="_blank" rel="noopener noreferrer">Open in Maps →</a>
    <p class="ticket-location-note">This location is provided privately to approved NOCTURNE guests. Please do not post or share the address publicly.</p>
  </section>` : '';
  const drinkDetails = valid && drinkPackage?.purchased ? `<section class="ticket-event-details" aria-label="Drink package"><p class="section-kicker">Six-Drink Package</p><div class="ticket-event-grid"><div><span>Status</span><strong>${escapeHtml(String(drinkPackage.status || 'pending activation').replaceAll('_', ' '))}</strong></div><div><span>Credits</span><strong>${Number(drinkPackage.remaining || 0)} of ${Number(drinkPackage.purchasedCredits || 6)} remaining</strong></div></div><p class="ticket-location-note">Bring valid 21+ photo ID to the bar to activate your assigned wristband. Each credit covers one beer or well cocktail; premium cocktails require a $5 upgrade at the bar.</p><p class="ticket-location-note"><strong>Refund policy:</strong> The package is refundable only before the first drink credit is redeemed. Once any drink is redeemed, the entire package is non-refundable and no prorated refund is available.</p></section>` : '';
  const drinkAddon = valid && !drinkPackage?.purchased && drinkPackageAddon?.available ? `<section class="ticket-drink-addon" aria-label="Add drink package"><p class="section-kicker">Optional Bar Add-On</p><h2>Six-drink package · ${escapeHtml(drinkPackageAddon.price)}</h2><p>Six prepaid credits for beer or well cocktails. Premium cocktails use one credit plus a $5 upgrade at the bar.</p><p class="ticket-refund-warning"><strong>Refund policy:</strong> Refundable only before the first drink credit is redeemed. Once any drink is redeemed, the entire package becomes non-refundable and no prorated refund is available.</p><form method="post" action="/ticket/drinks/checkout"><input type="hidden" name="token" value="${escapeHtml(token)}"><button class="btn" type="submit">Add Six-Drink Package →</button></form><small>For guests 21+ with valid photo ID. One package per ticket; credits are linked to a staff-issued wristband and cannot be shared.</small></section>` : '';
  const walletAction = valid && appleWalletAvailable ? `<div class="ticket-wallet-action"><a class="btn" href="/ticket/wallet?token=${encodeURIComponent(token)}">Download Apple Wallet Pass</a><small>Open this ticket on iPhone or Mac to add it to Wallet.</small></div>` : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#030303"><meta name="robots" content="noindex,nofollow,noarchive"><title>Digital Ticket | NOCTURNE</title><link rel="icon" href="/assets/images/favicon.png"><link rel="stylesheet" href="/assets/css/styles.css"><link rel="stylesheet" href="/assets/css/private-access.css"><style>.ticket-qr{width:min(360px,78vw);aspect-ratio:1;margin:1.5rem auto;background:#fff;padding:.7rem}.ticket-qr img{width:100%;height:100%;object-fit:contain}.ticket-name{font-family:var(--serif);font-size:1.55rem;color:#f5e7ce;margin:.4rem 0}.ticket-id{font-size:.72rem;letter-spacing:.16em;color:#8f8372;word-break:break-all}.ticket-guest{color:#d6c5aa!important}.ticket-event-details{margin:1.7rem 0 0;padding:1.25rem;border:1px solid rgba(216,154,43,.3);background:rgba(216,154,43,.045);text-align:left}.ticket-event-details .section-kicker{margin:0 0 .9rem}.ticket-event-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem}.ticket-event-grid div{padding:.9rem;border:1px solid rgba(216,154,43,.16);background:rgba(0,0,0,.26)}.ticket-event-grid span{display:block;margin-bottom:.35rem;color:#a9813f;font-size:.58rem;font-weight:600;letter-spacing:.16em;text-transform:uppercase}.ticket-event-grid strong{display:block;color:#f5e7ce;font-family:var(--serif);font-size:1.08rem;font-weight:500;line-height:1.4}.ticket-event-grid .ticket-address{margin:.15rem 0 0;color:#c9baa3;font-family:var(--sans);font-size:.72rem;font-weight:400;letter-spacing:.02em;line-height:1.55;text-transform:none}.ticket-map-link{display:inline-block;margin-top:1rem;color:var(--gold-bright);font-size:.7rem;font-weight:600;letter-spacing:.12em;text-decoration:none;text-transform:uppercase}.ticket-map-link:hover,.ticket-map-link:focus-visible{text-decoration:underline}.ticket-location-note{margin:.8rem 0 0!important;color:#928570!important;font-size:.68rem!important;line-height:1.6!important}.ticket-drink-addon{margin:1.7rem 0;padding:1.35rem;border:1px solid rgba(216,154,43,.48);background:linear-gradient(135deg,rgba(216,154,43,.1),rgba(0,0,0,.4));text-align:left}.ticket-drink-addon .section-kicker{margin:0 0 .65rem}.ticket-drink-addon h2{margin:0 0 .7rem;color:#f5e7ce;font-family:var(--serif);font-size:1.3rem;font-weight:500}.ticket-drink-addon p{margin:.5rem 0 1rem!important}.ticket-refund-warning{padding:.8rem;border:1px solid rgba(255,202,97,.38);background:rgba(255,202,97,.07);color:#ffca61!important;font-size:.7rem!important;line-height:1.55!important}.ticket-drink-addon form{margin:.9rem 0}.ticket-drink-addon .btn{width:100%}.ticket-drink-addon small{display:block;color:#928570;font-size:.65rem;line-height:1.55}.ticket-wallet-action{display:grid;gap:.5rem;margin:1.4rem 0}.ticket-wallet-action .btn{width:100%}.ticket-wallet-action small{color:#7f7465;font-size:.64rem}.ticket-staff{margin-top:1.6rem;padding:1rem;border:1px solid rgba(216,154,43,.28);background:rgba(216,154,43,.04)}.ticket-staff[hidden]{display:none}.ticket-staff p{margin:.5rem auto!important;font-size:.72rem}.ticket-staff[data-state=valid]{border-color:rgba(86,197,124,.6)}.ticket-staff[data-state=used]{border-color:rgba(255,202,97,.55)}.ticket-staff[data-state=invalid]{border-color:rgba(222,93,76,.6)}@media(max-width:560px){.ticket-event-grid{grid-template-columns:1fr}}</style><script src="/assets/js/ticket-view.js" defer></script></head>
<body class="private-access-page"><main class="private-access-shell"><section class="private-access-card">
<div class="private-access-logo-wrap"><img class="private-access-logo" src="/assets/images/nocturne-logo.webp" alt="NOCTURNE Festival — presented by Wild Ones" width="1536" height="768"></div>
<p class="section-kicker">Digital Ticket</p><h1>${valid ? 'Your NOCTURNE<br>ticket.' : 'Ticket could not<br>be verified.'}</h1>
${valid ? `<p class="ticket-guest">${escapeHtml(guestName || 'NOCTURNE Guest')}</p><p class="ticket-name">${escapeHtml(ticketName || 'NOCTURNE Festival — General Admission')}</p><p class="ticket-id">${escapeHtml(ticketId)}</p>${eventDetails}${drinkDetails}${drinkAddon}<div class="ticket-qr"><img src="${qr}" alt="QR code for NOCTURNE ticket ${escapeHtml(ticketId)}"></div>` : ''}
${status}
<p>${valid ? 'Keep this ticket private. The QR code is unique to this paid ticket and will be marked used when admitted.' : 'Use the original ticket confirmation email or contact the NOCTURNE team if you believe this is an error.'}</p>
${walletAction}
${valid ? '<section id="ticket-staff-panel" class="ticket-staff" hidden><p class="section-kicker">Staff Check-In</p><button id="ticket-staff-checkin" class="btn" type="button">Check In This Guest →</button><p id="ticket-staff-result" role="status" aria-live="assertive">Authorized staff session detected.</p></section>' : ''}
<div class="private-access-actions"><a class="btn secondary" href="/">Return to NOCTURNE</a></div>
</section></main></body></html>`;
}

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method not allowed.', { status: 405 });
  const token = String(new URL(req.url).searchParams.get('token') || '').trim();
  const parsed = verifyTicketToken(token);
  if (!parsed) return new Response(page({ message: 'This ticket link is invalid.' }), { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow,noarchive' } });

  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const applicationStore = getStore({ name: APPLICATION_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const [order, application, review] = await Promise.all([
    orderStore.get(`submission-${parsed.submissionId}`, { type: 'json', consistency: 'strong' }),
    applicationStore.get(parsed.submissionId, { type: 'json', consistency: 'strong' }),
    reviewStore.get(parsed.submissionId, { type: 'json', consistency: 'strong' })
  ]);

  if (!order || order.status !== 'paid' || order.ticketId !== parsed.ticketId || (review?.ticketState !== 'paid' && review?.ticketState !== 'checked_in')) {
    return new Response(page({ message: 'This ticket is not active.' }), { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow,noarchive' } });
  }

  if (!privateVenueConfigured()) {
    return new Response(page({ message: 'Private event details are temporarily unavailable.' }), { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow,noarchive' } });
  }

  const checkedIn = Boolean(order.checkedInAt || review?.checkedInAt || review?.ticketState === 'checked_in');
  const packageConfig = drinkPackageConfig();
  const configuredCurrency = String(process.env.NOCTURNE_TICKET_CURRENCY || 'usd').toUpperCase();
  const packagePrice = new Intl.NumberFormat('en-US', { style: 'currency', currency: /^[A-Z]{3}$/.test(configuredCurrency) ? configuredCurrency : 'USD' }).format(packageConfig.priceCents / 100);
  return new Response(page({
    valid: true,
    checkedIn,
    ticketId: parsed.ticketId,
    guestName: application?.preferredName || application?.fullName || '',
    ticketName: process.env.NOCTURNE_TICKET_NAME || 'NOCTURNE Festival — General Admission',
    drinkPackage: { purchased: Boolean(order.drinkPackagePurchased), status: order.drinkPackageStatus, remaining: order.drinkCreditsRemaining, purchasedCredits: order.drinkCreditsPurchased },
    drinkPackageAddon: { available: packageConfig.enabled && Boolean(process.env.STRIPE_SECRET_KEY), price: packagePrice },
    appleWalletAvailable: appleWalletConfigured(),
    token
  }), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow,noarchive', 'Referrer-Policy': 'no-referrer' } });
};
