import { getStore } from '@netlify/blobs';
import { makeTicketToken } from './_ticket-token.mjs';
import { readTicketAccess } from './_ticket-auth.mjs';

const ORDER_STORE = 'nocturne-ticket-orders';

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function page({ paid = false, pending = false, ticketId = '', amount = '', digitalTicketUrl = '', message = '', drinkPackagePurchased = false, waterPackagePurchased = false } = {}) {
  const heading = paid ? 'Your ticket is confirmed.' : pending ? 'Payment received.' : 'We could not confirm that ticket.';
  const kicker = paid ? 'Ticket Confirmed' : pending ? 'Finalizing Purchase' : 'Ticket Status';
  const detail = paid
    ? `Your NOCTURNE ticket is registered. ${amount ? `Payment received: ${escapeHtml(amount)}.` : ''}`
    : pending
      ? 'Stripe returned you to NOCTURNE successfully. We are waiting for the signed payment confirmation from Stripe.'
      : escapeHtml(message || 'The ticket record could not be found.');
  const status = paid
    ? `<div class="private-access-status"><strong>Ticket ID</strong><br>${escapeHtml(ticketId)}</div>`
    : pending
      ? '<div class="private-access-status"><strong>Finalizing your ticket…</strong><br>This normally takes only a few seconds. Refresh this page shortly if needed.</div>'
      : '<div class="private-access-status"><strong>No paid ticket was found for this session.</strong></div>';
  const packageNotice = paid && drinkPackagePurchased ? '<div class="private-access-status"><strong>Six-Drink Package · FINAL SALE / NON-REFUNDABLE</strong><br>The package portion cannot be refunded, exchanged, prorated, transferred, or converted to cash, including unused credits.</div>' : '';
  const waterNotice = paid && waterPackagePurchased ? '<div class="private-access-status"><strong>Unlimited Drinking Water · FINAL SALE / NON-REFUNDABLE</strong><br>Unlimited drinking-water service is attached to this ticket for festival operating hours. The package is personal, non-transferable, and non-refundable.</div>' : '';
  const ticketAction = paid && digitalTicketUrl ? `<a class="btn" href="${escapeHtml(digitalTicketUrl)}">Open Digital Ticket →</a>` : '';

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#030303"><meta name="robots" content="noindex,nofollow,noarchive"><title>${escapeHtml(kicker)} | NOCTURNE</title><link rel="icon" href="/assets/images/favicon.png"><link rel="stylesheet" href="/assets/css/styles.css"><link rel="stylesheet" href="/assets/css/private-access.css"></head>
<body class="private-access-page"><main class="private-access-shell"><section class="private-access-card" aria-labelledby="ticket-title"><div class="private-access-logo-wrap"><img class="private-access-logo" src="/assets/images/nocturne-logo.webp" alt="NOCTURNE Festival — presented by Wild Ones" width="1536" height="768"></div><p class="section-kicker">${escapeHtml(kicker)}</p><h1 id="ticket-title">${escapeHtml(heading)}</h1><p>${detail}</p>${status}${packageNotice}${waterNotice}<p>${paid ? 'Your digital ticket contains the unique QR code you will present at event check-in.' : 'Do not submit another payment unless this page continues to show an error after Stripe has finished processing.'}</p><div class="private-access-actions">${ticketAction}<a class="btn secondary" href="/">Return to NOCTURNE</a></div></section></main></body></html>`;
}

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method not allowed.', { status: 405 });
  const url = new URL(req.url);
  const access = readTicketAccess(req);
  if (!access) return new Response(page({ message: 'Private ticket access has expired. Use the secure link from your NOCTURNE email to return.' }), { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow,noarchive', 'Referrer-Policy': 'no-referrer' } });
  const sessionId = String(url.searchParams.get('session_id') || '').trim();
  if (!/^cs_(test_|live_)?[A-Za-z0-9_]{10,}$/.test(sessionId)) return new Response(page({ message: 'The checkout session ID is missing or invalid.' }), { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive' } });
  const store = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const order = await store.get(sessionId, { type: 'json', consistency: 'strong' });
  if (order && order.submissionId !== access.submissionId) return new Response(page({ message: 'This confirmation does not belong to the current private access session.' }), { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow,noarchive', 'Referrer-Policy': 'no-referrer' } });

  let html;
  let status = 200;
  if (!order) { html = page({ pending: true }); status = 202; }
  else if (order.status === 'paid') {
    const amount = Number.isFinite(Number(order.amountTotal)) ? `${String(order.currency || 'usd').toUpperCase()} ${(Number(order.amountTotal) / 100).toFixed(2)}` : '';
    const token = makeTicketToken(order.ticketId, order.submissionId);
    const base = (process.env.NOCTURNE_SITE_URL || url.origin).replace(/\/$/, '');
    const digitalTicketUrl = order.digitalTicketUrl || (token ? `${base}/ticket?token=${encodeURIComponent(token)}` : '');
    html = page({
      paid: true,
      ticketId: order.ticketId || 'Confirmed',
      amount,
      digitalTicketUrl,
      drinkPackagePurchased: Boolean(order.drinkPackageRequested || order.drinkPackagePurchased),
      waterPackagePurchased: Boolean(order.waterPackageRequested || order.waterPackagePurchased)
    });
  } else { html = page({ pending: true }); status = 202; }

  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive' } });
};
