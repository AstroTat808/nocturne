import { getStore } from '@netlify/blobs';
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

function checkoutConfigured() {
  const price = Number(process.env.NOCTURNE_TICKET_PRICE_CENTS || 0);
  return Boolean(process.env.STRIPE_SECRET_KEY && Number.isInteger(price) && price >= 50);
}

function formattedPrice() {
  const amount = Number(process.env.NOCTURNE_TICKET_PRICE_CENTS || 0) / 100;
  const currency = String(process.env.NOCTURNE_TICKET_CURRENCY || 'usd').toUpperCase();
  return `${currency} ${amount.toFixed(2)}`;
}

function renderPage({ paid = false, ticketId = '', checkoutMessage = '' } = {}) {
  const configured = checkoutConfigured();
  const ticketName = escapeHtml(process.env.NOCTURNE_TICKET_NAME || 'NOCTURNE Festival — General Admission');

  let status;
  let actions;
  let lead;

  if (paid) {
    lead = 'Your invitation has been redeemed and your NOCTURNE ticket purchase is confirmed.';
    status = `<div class="private-access-status"><strong>Ticket confirmed.</strong><br>Ticket ID: ${escapeHtml(ticketId || 'Registered')}</div>`;
    actions = '<div class="private-access-actions"><a class="btn" href="/">Return to NOCTURNE</a><a class="btn secondary" href="https://instagram.com/nocturnehawaii" target="_blank" rel="noopener noreferrer">Follow @nocturnehawaii</a></div>';
  } else if (configured) {
    lead = 'Your invitation has been successfully redeemed. Your private ticket checkout is now available.';
    status = `<div class="private-access-status"><strong>${ticketName}</strong><br>${formattedPrice()} · One ticket per approved invitation</div>`;
    actions = `<form method="POST" action="/ticket-access/checkout" class="private-access-actions"><button class="btn" type="submit">Purchase Private Ticket →</button><a class="btn secondary" href="/">Return to NOCTURNE</a></form>`;
  } else {
    lead = 'Your invitation was successfully redeemed. The private ticket checkout is not live yet, so there is nothing else you need to do right now.';
    status = '<div class="private-access-status"><strong>Private ticket access is being prepared.</strong><br>Approved guests will receive the next instructions when checkout opens.</div>';
    actions = '<div class="private-access-actions"><a class="btn" href="/">Return to NOCTURNE</a><a class="btn secondary" href="https://instagram.com/nocturnehawaii" target="_blank" rel="noopener noreferrer">Follow @nocturnehawaii</a></div>';
  }

  const message = checkoutMessage ? `<div class="private-access-status"><strong>${escapeHtml(checkoutMessage)}</strong></div>` : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#030303">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <title>Private Ticket Access | NOCTURNE</title>
  <link rel="icon" href="/assets/images/favicon.png">
  <link rel="stylesheet" href="/assets/css/styles.css">
  <link rel="stylesheet" href="/assets/css/private-access.css">
</head>
<body class="private-access-page">
  <main class="private-access-shell">
    <section class="private-access-card" aria-labelledby="ticket-access-title">
      <div class="private-access-logo-wrap">
        <img class="private-access-logo" src="/assets/images/nocturne-logo.webp" alt="NOCTURNE Festival — presented by Wild Ones" width="1536" height="768">
      </div>
      <p class="section-kicker">Invitation Verified</p>
      <h1 id="ticket-access-title">Your access<br>is confirmed.</h1>
      <p>${escapeHtml(lead)}</p>
      ${message}
      ${status}
      <p>${paid ? 'Your purchase is recorded in the NOCTURNE guest system. Keep your confirmation email for your records.' : configured ? 'Checkout is processed securely by Stripe. Your approved invitation permits one ticket purchase.' : 'Keep an eye on the email and mobile number used in your application. Event details and ticket instructions will be released privately.'}</p>
      ${actions}
    </section>
  </main>
</body>
</html>`;
}

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method not allowed.', { status: 405 });

  const access = readTicketAccess(req);
  if (!access) {
    return new Response(`<!doctype html><html><head><meta name="robots" content="noindex"><meta http-equiv="refresh" content="2;url=/invite"><title>Private Access | NOCTURNE</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#030303;color:#d6c4a7;font:16px Arial,sans-serif;text-align:center}</style></head><body><p>Private access requires a valid redeemed invitation.<br>Returning to invitation verification…</p></body></html>`, {
      status: 401,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow, noarchive'
      }
    });
  }

  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const order = await orderStore.get(`submission-${access.submissionId}`, { type: 'json', consistency: 'strong' });
  const url = new URL(req.url);
  let checkoutMessage = '';
  if (url.searchParams.get('checkout') === 'cancelled') checkoutMessage = 'Checkout was cancelled. No charge was completed.';
  if (url.searchParams.get('checkout_error')) checkoutMessage = url.searchParams.get('checkout_error').slice(0, 240);

  return new Response(renderPage({
    paid: order?.status === 'paid',
    ticketId: order?.ticketId || '',
    checkoutMessage
  }), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow, noarchive'
    }
  });
};
