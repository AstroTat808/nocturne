import { getStore } from '@netlify/blobs';
import { reconcileLateStayCheckout } from './_late-stay.mjs';

const ORDER_STORE = 'nocturne-ticket-orders';
const REVIEW_STORE = 'nocturne-application-reviews';

function escapeHtml(value = '') {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function page({ confirmed = false, pending = false, cancelled = false, message = '', amount = '', slot = null }) {
  const kicker = confirmed ? 'Late Stay Confirmed' : pending ? 'Finalizing Purchase' : cancelled ? 'Checkout Canceled' : 'Late Stay Status';
  const heading = confirmed ? 'You can stay until 8:00 AM.' : pending ? 'Payment is being verified.' : cancelled ? 'No charge was made.' : 'We could not confirm that add-on.';
  const status = confirmed
    ? `<div class="private-access-status"><strong>Late Checkout / Car Camping Added</strong>${amount ? `<br>${escapeHtml(amount)}` : ''}${slot ? `<br>Capacity slot ${Number(slot)}` : ''}</div><div class="private-access-status"><strong>Departure deadline: 8:00 AM</strong><br>Each person remaining on the property after 3:00 AM must have this add-on attached to their own ticket.</div>`
    : pending
      ? '<div class="private-access-status"><strong>Finalizing your late-stay add-on…</strong><br>This page will refresh automatically.</div>'
      : cancelled
        ? '<div class="private-access-status"><strong>Checkout canceled.</strong><br>Your existing admission ticket remains unchanged and the temporary capacity reservation will expire.</div>'
        : `<div class="private-access-status"><strong>${escapeHtml(message || 'Late-stay confirmation was not found.')}</strong></div>`;
  const copy = confirmed
    ? 'Reopen or refresh your original digital ticket to see the Late Checkout / Car Camping entitlement. You may remain on the NOCTURNE property after the 3:00 AM event end until 8:00 AM, including resting or sleeping in your vehicle where directed by event staff.'
    : cancelled
      ? 'You can return to your digital ticket while capacity remains if you decide to add Late Checkout / Car Camping.'
      : pending
        ? 'NOCTURNE is verifying the Stripe payment. Do not submit another payment.'
        : 'Use your original digital ticket to try again, or contact help@nocturnefestival.com.';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#030303"><meta name="robots" content="noindex,nofollow,noarchive">${pending ? '<meta http-equiv="refresh" content="3">' : ''}<title>${escapeHtml(kicker)} | NOCTURNE</title><link rel="icon" href="/assets/images/favicon.png"><link rel="stylesheet" href="/assets/css/styles.css"><link rel="stylesheet" href="/assets/css/private-access.css"></head><body class="private-access-page"><main class="private-access-shell"><section class="private-access-card"><div class="private-access-logo-wrap"><img class="private-access-logo" src="/assets/images/nocturne-logo.webp" alt="NOCTURNE Festival — presented by Wild Ones" width="1536" height="768"></div><p class="section-kicker">${escapeHtml(kicker)}</p><h1>${escapeHtml(heading)}</h1>${status}<p>${escapeHtml(copy)}</p>${confirmed ? '<div class="private-access-status"><strong>FINAL SALE / NON-TRANSFERABLE</strong><br>This limited-capacity add-on is attached to one registered ticket holder and cannot be transferred to another guest.</div>' : ''}<div class="private-access-actions"><a class="btn secondary" href="/">Return to NOCTURNE</a></div></section></main></body></html>`;
}

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method not allowed.', { status: 405 });
  const url = new URL(req.url);
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'Referrer-Policy': 'no-referrer' };
  if (url.searchParams.get('cancelled') === '1') return new Response(page({ cancelled: true }), { status: 200, headers });
  if (url.searchParams.has('error')) return new Response(page({ message: url.searchParams.get('error') }), { status: 400, headers });
  const sessionId = String(url.searchParams.get('session_id') || '').trim();
  if (!/^cs_(test_|live_)?[A-Za-z0-9_]{10,}$/.test(sessionId)) return new Response(page({ message: 'The checkout session ID is missing or invalid.' }), { status: 400, headers });

  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const checkoutOrder = await orderStore.get(sessionId, { type: 'json', consistency: 'strong' });
  if (!checkoutOrder || checkoutOrder.purchaseType !== 'late-stay-addon' || !checkoutOrder.submissionId) return new Response(page({ pending: true }), { status: 202, headers });
  const summaryEntry = await orderStore.getWithMetadata(`submission-${checkoutOrder.submissionId}`, { type: 'json', consistency: 'strong' });
  const summary = await reconcileLateStayCheckout({ summaryEntry, orderStore, reviewStore }).catch(() => summaryEntry?.data || null);
  if (summary?.lateStayPurchased && summary.lateStayCheckoutSessionId === sessionId) {
    const amount = Number.isFinite(Number(summary.lateStayPriceCents)) ? `${String(checkoutOrder.currency || 'usd').toUpperCase()} ${(Number(summary.lateStayPriceCents) / 100).toFixed(2)}` : '';
    return new Response(page({ confirmed: true, amount, slot: summary.lateStaySlot || null }), { status: 200, headers });
  }
  return new Response(page({ pending: true }), { status: 202, headers });
};
