import { getStore } from '@netlify/blobs';
import { verifyTicketToken } from './_ticket-token.mjs';

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

function ticketUrl(req, token) {
  const base = (process.env.NOCTURNE_SITE_URL || new URL(req.url).origin).replace(/\/$/, '');
  return `${base}/ticket?token=${encodeURIComponent(token)}`;
}

function qrUrl(value) {
  return `https://quickchart.io/qr?size=520&margin=2&text=${encodeURIComponent(value)}`;
}

function page({ valid = false, checkedIn = false, ticketId = '', guestName = '', ticketName = '', token = '', req, message = '' }) {
  const fullTicketUrl = valid ? ticketUrl(req, token) : '';
  const qr = valid ? qrUrl(fullTicketUrl) : '';
  const status = checkedIn
    ? '<div class="private-access-status"><strong>Already checked in.</strong><br>This ticket was previously admitted.</div>'
    : valid
      ? '<div class="private-access-status"><strong>Valid paid ticket.</strong><br>Present this QR code at event check-in.</div>'
      : `<div class="private-access-status"><strong>${escapeHtml(message || 'Invalid ticket.')}</strong></div>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#030303"><meta name="robots" content="noindex,nofollow,noarchive"><title>Digital Ticket | NOCTURNE</title><link rel="icon" href="/assets/images/favicon.png"><link rel="stylesheet" href="/assets/css/styles.css"><link rel="stylesheet" href="/assets/css/private-access.css"><style>.ticket-qr{width:min(360px,78vw);aspect-ratio:1;margin:1.5rem auto;background:#fff;padding:.7rem}.ticket-qr img{width:100%;height:100%;object-fit:contain}.ticket-name{font-family:var(--serif);font-size:1.55rem;color:#f5e7ce;margin:.4rem 0}.ticket-id{font-size:.72rem;letter-spacing:.16em;color:#8f8372;word-break:break-all}.ticket-guest{color:#d6c5aa!important}</style></head>
<body class="private-access-page"><main class="private-access-shell"><section class="private-access-card">
<div class="private-access-logo-wrap"><img class="private-access-logo" src="/assets/images/nocturne-logo.webp" alt="NOCTURNE Festival — presented by Wild Ones" width="1536" height="768"></div>
<p class="section-kicker">Digital Ticket</p><h1>${valid ? 'Your NOCTURNE<br>ticket.' : 'Ticket could not<br>be verified.'}</h1>
${valid ? `<p class="ticket-guest">${escapeHtml(guestName || 'NOCTURNE Guest')}</p><p class="ticket-name">${escapeHtml(ticketName || 'NOCTURNE Festival — General Admission')}</p><p class="ticket-id">${escapeHtml(ticketId)}</p><div class="ticket-qr"><img src="${qr}" alt="QR code for NOCTURNE ticket ${escapeHtml(ticketId)}"></div>` : ''}
${status}
<p>${valid ? 'Keep this ticket private. The QR code is unique to this paid ticket and will be marked used when admitted.' : 'Use the original ticket confirmation email or contact the NOCTURNE team if you believe this is an error.'}</p>
<div class="private-access-actions"><a class="btn secondary" href="/">Return to NOCTURNE</a></div>
</section></main></body></html>`;
}

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method not allowed.', { status: 405 });
  const token = String(new URL(req.url).searchParams.get('token') || '').trim();
  const parsed = verifyTicketToken(token);
  if (!parsed) return new Response(page({ req, message: 'This ticket link is invalid.' }), { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive' } });

  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const applicationStore = getStore({ name: APPLICATION_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const [order, application, review] = await Promise.all([
    orderStore.get(`submission-${parsed.submissionId}`, { type: 'json', consistency: 'strong' }),
    applicationStore.get(parsed.submissionId, { type: 'json', consistency: 'strong' }),
    reviewStore.get(parsed.submissionId, { type: 'json', consistency: 'strong' })
  ]);

  if (!order || order.status !== 'paid' || order.ticketId !== parsed.ticketId || review?.ticketState !== 'paid' && review?.ticketState !== 'checked_in') {
    return new Response(page({ req, message: 'This ticket is not active.' }), { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive' } });
  }

  const checkedIn = Boolean(order.checkedInAt || review?.checkedInAt || review?.ticketState === 'checked_in');
  return new Response(page({
    valid: true,
    checkedIn,
    ticketId: parsed.ticketId,
    guestName: application?.preferredName || application?.fullName || '',
    ticketName: process.env.NOCTURNE_TICKET_NAME || 'NOCTURNE Festival — General Admission',
    token,
    req
  }), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive' } });
};
