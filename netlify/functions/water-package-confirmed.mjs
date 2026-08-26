import { getStore } from '@netlify/blobs';
import { reconcileWaterPackageCheckout } from './_water-package.mjs';

const ORDER_STORE = 'nocturne-ticket-orders';
const REVIEW_STORE = 'nocturne-application-reviews';

function escapeHtml(value = '') {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function page({ confirmed = false, pending = false, cancelled = false, message = '', amount = '' }) {
  const kicker = confirmed ? 'Water Package Confirmed' : pending ? 'Finalizing Purchase' : cancelled ? 'Checkout Canceled' : 'Water Package Status';
  const heading = confirmed ? 'Unlimited water is active.' : pending ? 'Payment is being verified.' : cancelled ? 'No charge was made.' : 'We could not confirm that package.';
  const status = confirmed
    ? `<div class="private-access-status"><strong>Unlimited Drinking Water Added</strong>${amount ? `<br>${escapeHtml(amount)}` : ''}</div><div class="private-access-status"><strong>FINAL SALE / NON-REFUNDABLE</strong><br>This package cannot be refunded, exchanged, prorated, transferred, or converted to cash.</div>`
    : pending
      ? '<div class="private-access-status"><strong>Finalizing your water package…</strong><br>This page will refresh automatically.</div>'
      : cancelled
        ? '<div class="private-access-status"><strong>Checkout canceled.</strong><br>Your existing admission ticket remains unchanged.</div>'
        : `<div class="private-access-status"><strong>${escapeHtml(message || 'Water-package confirmation was not found.')}</strong></div>`;
  const copy = confirmed
    ? 'Reopen or refresh your original digital ticket to see the Unlimited Drinking Water entitlement. The entitlement is personal to this ticket and may be used throughout festival operating hours.'
    : cancelled
      ? 'You can return to your original digital ticket whenever you are ready to add unlimited drinking water.'
      : pending
        ? 'NOCTURNE is verifying the Stripe payment. Do not submit another payment.'
        : 'Use your original digital ticket to try again, or contact help@nocturnefestival.com.';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#030303"><meta name="robots" content="noindex,nofollow,noarchive">${pending ? '<meta http-equiv="refresh" content="3">' : ''}<title>${escapeHtml(kicker)} | NOCTURNE</title><link rel="icon" href="/assets/images/favicon.png"><link rel="stylesheet" href="/assets/css/styles.css"><link rel="stylesheet" href="/assets/css/private-access.css"></head><body class="private-access-page"><main class="private-access-shell"><section class="private-access-card"><div class="private-access-logo-wrap"><img class="private-access-logo" src="/assets/images/nocturne-logo.webp" alt="NOCTURNE Festival — presented by Wild Ones" width="1536" height="768"></div><p class="section-kicker">${escapeHtml(kicker)}</p><h1>${escapeHtml(heading)}</h1>${status}<p>${escapeHtml(copy)}</p><div class="private-access-actions"><a class="btn secondary" href="/">Return to NOCTURNE</a></div></section></main></body></html>`;
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
  if (!checkoutOrder || checkoutOrder.purchaseType !== 'water-package-addon' || !checkoutOrder.submissionId) return new Response(page({ pending: true }), { status: 202, headers });
  const summaryEntry = await orderStore.getWithMetadata(`submission-${checkoutOrder.submissionId}`, { type: 'json', consistency: 'strong' });
  const summary = await reconcileWaterPackageCheckout({ summaryEntry, orderStore, reviewStore });
  if (summary?.waterPackagePurchased && summary.waterPackageCheckoutSessionId === sessionId) {
    const amount = Number.isFinite(Number(summary.waterPackagePriceCents)) ? `${String(checkoutOrder.currency || 'usd').toUpperCase()} ${(Number(summary.waterPackagePriceCents) / 100).toFixed(2)}` : '';
    return new Response(page({ confirmed: true, amount }), { status: 200, headers });
  }
  return new Response(page({ pending: true }), { status: 202, headers });
};
