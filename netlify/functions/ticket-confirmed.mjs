import { getStore } from '@netlify/blobs';
import { makeTicketToken } from './_ticket-token.mjs';
import { accessTtlSeconds, makeAccessCookie, makeAccessToken, readTicketAccess, verifyReentryToken } from './_ticket-auth.mjs';
import { LATE_STAY_POLICY_TEXT } from './_late-stay.mjs';

const ORDER_STORE = 'nocturne-ticket-orders';

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function page({ paid = false, pending = false, ticketId = '', amount = '', digitalTicketUrl = '', message = '', drinkPackagePurchased = false, waterPackagePurchased = false, lateStayPurchased = false } = {}) {
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
  const lateStayNotice = paid && lateStayPurchased ? `<div class="private-access-status"><strong>Late Checkout / Car Camping · Until 8:00 AM · FINAL SALE / NON-REFUNDABLE</strong><br>You may remain on the property after the 3:00 AM event end until 8:00 AM. ${escapeHtml(LATE_STAY_POLICY_TEXT)}</div>` : '';
  const ticketAction = paid && digitalTicketUrl ? `<a class="btn" href="${escapeHtml(digitalTicketUrl)}">Open Digital Ticket →</a>` : '';

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#030303"><meta name="robots" content="noindex,nofollow,noarchive"><title>${escapeHtml(kicker)} | NOCTURNE</title><link rel="icon" href="/assets/images/favicon.png"><link rel="stylesheet" href="/assets/css/styles.css"><link rel="stylesheet" href="/assets/css/private-access.css"></head>
<body class="private-access-page"><main class="private-access-shell"><section class="private-access-card" aria-labelledby="ticket-title"><div class="private-access-logo-wrap"><img class="private-access-logo" src="/assets/images/nocturne-logo.webp" alt="NOCTURNE Festival — presented by Wild Ones" width="1536" height="768"></div><p class="section-kicker">${escapeHtml(kicker)}</p><h1 id="ticket-title">${escapeHtml(heading)}</h1><p>${detail}</p>${status}${packageNotice}${waterNotice}${lateStayNotice}<p>${paid ? 'Your digital ticket contains the unique QR code you will present at event check-in.' : 'Do not submit another payment unless this page continues to show an error after Stripe has finished processing.'}</p><div class="private-access-actions">${ticketAction}<a class="btn secondary" href="/">Return to NOCTURNE</a></div></section></main></body></html>`;
}

function htmlResponse(html, status = 200, extraHeaders = {}) {
  return new Response(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow,noarchive',
      'Referrer-Policy': 'no-referrer',
      ...extraHeaders
    }
  });
}

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method not allowed.', { status: 405 });
  const url = new URL(req.url);
  const sessionId = String(url.searchParams.get('session_id') || '').trim();
  if (!/^cs_(test_|live_)?[A-Za-z0-9_]{10,}$/.test(sessionId)) return htmlResponse(page({ message: 'The checkout session ID is missing or invalid.' }), 400);

  const store = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const order = await store.get(sessionId, { type: 'json', consistency: 'strong' });
  const cookieAccess = readTicketAccess(req);
  const returnAccess = verifyReentryToken(String(url.searchParams.get('return_token') || '').trim());
  const access = cookieAccess || returnAccess;

  if (!access) return htmlResponse(page({ message: 'Private ticket access has expired. Use the secure link from your NOCTURNE email to return.' }), 401);
  if (order && order.submissionId !== access.submissionId) return htmlResponse(page({ message: 'This confirmation does not belong to the current private access session.' }), 403);

  let extraHeaders = {};
  if (!cookieAccess && returnAccess) {
    const ttlSeconds = accessTtlSeconds();
    const token = makeAccessToken(returnAccess.submissionId, ttlSeconds);
    if (token) extraHeaders = { 'Set-Cookie': makeAccessCookie(token, ttlSeconds) };
  }

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
      waterPackagePurchased: Boolean(order.waterPackageRequested || order.waterPackagePurchased),
      lateStayPurchased: Boolean(order.lateStayPurchased || order.lateStayRequested)
    });
  } else { html = page({ pending: true }); status = 202; }

  return htmlResponse(html, status, extraHeaders);
};