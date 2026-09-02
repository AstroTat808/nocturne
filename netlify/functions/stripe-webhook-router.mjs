import { getStore } from '@netlify/blobs';
import stripeWebhook from './stripe-webhook.mjs';
import { verifyStripeSignature } from './_stripe-signature.mjs';
import { makeTicketToken } from './_ticket-token.mjs';
import { writeAudit } from './_audit.mjs';
import { reconcileLateStayCheckout } from './_late-stay.mjs';

const ORDER_STORE = 'nocturne-ticket-orders';
const REVIEW_STORE = 'nocturne-application-reviews';
const APPLICATION_STORE = 'nocturne-applications';
const HELP_EMAIL = process.env.NOCTURNE_HELP_EMAIL || 'help@nocturnefestival.com';

function escapeHtml(value = '') {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function ticketLink(submissionId, ticketId) {
  const token = makeTicketToken(ticketId, submissionId);
  if (!token) return '';
  const site = (process.env.NOCTURNE_SITE_URL || 'https://nocturnefestival.com').replace(/\/$/, '');
  return `${site}/ticket?token=${encodeURIComponent(token)}`;
}

async function sendWaterReceipt(session) {
  if (session?.payment_status !== 'paid' || !session?.id) return;
  const submissionId = String(session.client_reference_id || session.metadata?.submissionId || '').trim();
  const ticketId = String(session.metadata?.ticketId || '').trim();
  if (!submissionId || !ticketId) return;

  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const applicationStore = getStore({ name: APPLICATION_STORE, consistency: 'strong' });
  const [checkoutOrder, application] = await Promise.all([
    orderStore.get(session.id, { type: 'json', consistency: 'strong' }),
    applicationStore.get(submissionId, { type: 'json', consistency: 'strong' })
  ]);
  if (checkoutOrder?.purchaseType !== 'water-package-addon' || checkoutOrder.ticketId !== ticketId) return;
  if (!process.env.RESEND_API_KEY || !process.env.NOCTURNE_EMAIL_FROM || !application?.email) return;

  const amount = Number(session.amount_total ?? checkoutOrder.amountTotal ?? 0) / 100;
  const currency = String(session.currency || checkoutOrder.currency || 'usd').toUpperCase();
  const displayName = application.preferredName || application.fullName || 'Guest';
  const digitalTicketUrl = ticketLink(submissionId, ticketId);
  const policy = 'FINAL SALE / NON-REFUNDABLE: The Unlimited Drinking Water Package cannot be refunded, exchanged, prorated, transferred, converted to account credit, or redeemed for cash.';
  const text = [
    `${displayName},`, '', 'Your NOCTURNE Unlimited Drinking Water Package purchase is confirmed.', '',
    `Ticket ID: ${ticketId}`, `Amount: ${currency} ${amount.toFixed(2)}`,
    digitalTicketUrl ? `Open your updated digital ticket: ${digitalTicketUrl}` : '', '',
    'Unlimited drinking-water service is personal to the registered ticket holder and is available during festival operating hours.', '',
    policy, '', `Need help? ${HELP_EMAIL}`, '', 'NOCTURNE Festival', 'Presented by Wild Ones · Hawai‘i'
  ].filter(Boolean).join('\n');
  const button = digitalTicketUrl ? `<p style="text-align:center;margin:30px 0"><a href="${escapeHtml(digitalTicketUrl)}" style="display:inline-block;padding:14px 20px;background:#d89a2b;color:#0b0803;text-decoration:none;font-size:12px;letter-spacing:2px;text-transform:uppercase">Open Updated Ticket</a></p>` : '';
  const html = `<!doctype html><html><body style="margin:0;background:#030303;color:#f7efe3;font-family:Arial,sans-serif"><div style="max-width:640px;margin:0 auto;padding:44px 24px"><div style="border:1px solid rgba(216,154,43,.35);background:#080604;padding:38px 30px"><div style="color:#d89a2b;font-size:11px;letter-spacing:3px;text-transform:uppercase">NOCTURNE · Water Package Confirmed</div><h1 style="font-family:Georgia,serif;font-weight:400;font-size:40px;line-height:1.05;color:#fff3df">Unlimited water<br>is confirmed.</h1><p style="color:#c8baa4;line-height:1.7">${escapeHtml(displayName)}, the Unlimited Drinking Water Package is attached to your NOCTURNE ticket.</p><div style="margin:28px 0;padding:18px;border-left:2px solid #d89a2b;background:#020202;color:#d8c7ac;line-height:1.8"><strong>Ticket ID:</strong> ${escapeHtml(ticketId)}<br><strong>Amount:</strong> ${escapeHtml(currency)} ${amount.toFixed(2)}</div>${button}<p style="color:#9d907f;line-height:1.7">Unlimited drinking-water service is personal to the registered ticket holder and is available during festival operating hours.</p><p style="color:#ffca61;font-size:12px;line-height:1.7"><strong>FINAL SALE / NON-REFUNDABLE:</strong> The Unlimited Drinking Water Package cannot be refunded, exchanged, prorated, transferred, converted to account credit, or redeemed for cash.</p><p style="color:#807564;font-size:12px">Need help? ${escapeHtml(HELP_EMAIL)}</p></div></div></body></html>`;

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `water-package-confirmation-${session.id}`.slice(0, 256) },
      body: JSON.stringify({ from: process.env.NOCTURNE_EMAIL_FROM, to: [application.email], subject: 'Your NOCTURNE Water Package Is Confirmed', html, text })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || `Resend returned ${response.status}.`);
    await orderStore.setJSON(session.id, { ...checkoutOrder, waterPackageEmailStatus: 'sent', waterPackageEmailMessageId: data.id || null, waterPackageEmailSentAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await writeAudit('water_package.email_sent', { submissionId, ticketId, stripeCheckoutSessionId: session.id, messageId: data.id || null });
  } catch (error) {
    await orderStore.setJSON(session.id, { ...checkoutOrder, waterPackageEmailStatus: 'failed', waterPackageEmailError: String(error?.message || error).slice(0, 500), updatedAt: new Date().toISOString() }).catch(() => {});
    await writeAudit('water_package.email_failed', { submissionId, ticketId, stripeCheckoutSessionId: session.id, error: String(error?.message || error) }).catch(() => {});
  }
}

async function fulfillAndSendLateStayReceipt(session) {
  if (session?.payment_status !== 'paid' || !session?.id) return;
  const submissionId = String(session.client_reference_id || session.metadata?.submissionId || '').trim();
  const ticketId = String(session.metadata?.ticketId || '').trim();
  if (!submissionId || !ticketId) return;

  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const applicationStore = getStore({ name: APPLICATION_STORE, consistency: 'strong' });
  const checkoutOrder = await orderStore.get(session.id, { type: 'json', consistency: 'strong' });
  if (checkoutOrder?.purchaseType !== 'late-stay-addon' || checkoutOrder.ticketId !== ticketId) return;

  const summaryEntry = await orderStore.getWithMetadata(`submission-${submissionId}`, { type: 'json', consistency: 'strong' });
  const summary = await reconcileLateStayCheckout({ summaryEntry, orderStore, reviewStore });
  if (!summary?.lateStayPurchased || summary.lateStayCheckoutSessionId !== session.id) throw new Error('Late Checkout / Car Camping payment could not be attached to the ticket.');

  const application = await applicationStore.get(submissionId, { type: 'json', consistency: 'strong' });
  if (!process.env.RESEND_API_KEY || !process.env.NOCTURNE_EMAIL_FROM || !application?.email) return;
  const amount = Number(session.amount_total ?? checkoutOrder.amountTotal ?? 0) / 100;
  const currency = String(session.currency || checkoutOrder.currency || 'usd').toUpperCase();
  const displayName = application.preferredName || application.fullName || 'Guest';
  const digitalTicketUrl = ticketLink(submissionId, ticketId);
  const text = [
    `${displayName},`, '', 'Your NOCTURNE Late Checkout / Car Camping add-on is confirmed.', '',
    `Ticket ID: ${ticketId}`, `Amount: ${currency} ${amount.toFixed(2)}`, 'Departure deadline: 8:00 AM',
    digitalTicketUrl ? `Open your updated digital ticket: ${digitalTicketUrl}` : '', '',
    'You may remain on the NOCTURNE property after the 3:00 AM event end until 8:00 AM, including resting or sleeping in your vehicle where directed by event staff.',
    'Each person remaining on the property after 3:00 AM must have this add-on attached to their own ticket.', '',
    'FINAL SALE / NON-TRANSFERABLE: This limited-capacity add-on is attached to one registered ticket holder and cannot be transferred to another guest.', '',
    `Need help? ${HELP_EMAIL}`, '', 'NOCTURNE Festival', 'Presented by Wild Ones · Hawai‘i'
  ].filter(Boolean).join('\n');
  const button = digitalTicketUrl ? `<p style="text-align:center;margin:30px 0"><a href="${escapeHtml(digitalTicketUrl)}" style="display:inline-block;padding:14px 20px;background:#d89a2b;color:#0b0803;text-decoration:none;font-size:12px;letter-spacing:2px;text-transform:uppercase">Open Updated Ticket</a></p>` : '';
  const html = `<!doctype html><html><body style="margin:0;background:#030303;color:#f7efe3;font-family:Arial,sans-serif"><div style="max-width:640px;margin:0 auto;padding:44px 24px"><div style="border:1px solid rgba(216,154,43,.35);background:#080604;padding:38px 30px"><div style="color:#d89a2b;font-size:11px;letter-spacing:3px;text-transform:uppercase">NOCTURNE · Late Stay Confirmed</div><h1 style="font-family:Georgia,serif;font-weight:400;font-size:40px;line-height:1.05;color:#fff3df">Stay until<br>8:00 AM.</h1><p style="color:#c8baa4;line-height:1.7">${escapeHtml(displayName)}, Late Checkout / Car Camping is now attached to your NOCTURNE ticket.</p><div style="margin:28px 0;padding:18px;border-left:2px solid #d89a2b;background:#020202;color:#d8c7ac;line-height:1.8"><strong>Ticket ID:</strong> ${escapeHtml(ticketId)}<br><strong>Amount:</strong> ${escapeHtml(currency)} ${amount.toFixed(2)}<br><strong>Departure deadline:</strong> 8:00 AM</div>${button}<p style="color:#9d907f;line-height:1.7">You may remain on the property after the 3:00 AM event end until 8:00 AM, including resting or sleeping in your vehicle where directed by event staff. Each person staying after 3:00 AM must have this entitlement on their own ticket.</p><p style="color:#ffca61;font-size:12px;line-height:1.7"><strong>FINAL SALE / NON-TRANSFERABLE:</strong> This limited-capacity add-on is attached to one registered ticket holder.</p><p style="color:#807564;font-size:12px">Need help? ${escapeHtml(HELP_EMAIL)}</p></div></div></body></html>`;

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `late-stay-confirmation-${session.id}`.slice(0, 256) },
      body: JSON.stringify({ from: process.env.NOCTURNE_EMAIL_FROM, to: [application.email], subject: 'Your NOCTURNE Late Checkout / Car Camping Is Confirmed', html, text })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || `Resend returned ${response.status}.`);
    const latest = await orderStore.get(session.id, { type: 'json', consistency: 'strong' });
    await orderStore.setJSON(session.id, { ...(latest || checkoutOrder), lateStayEmailStatus: 'sent', lateStayEmailMessageId: data.id || null, lateStayEmailSentAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await writeAudit('late_stay.email_sent', { submissionId, ticketId, stripeCheckoutSessionId: session.id, messageId: data.id || null });
  } catch (error) {
    const latest = await orderStore.get(session.id, { type: 'json', consistency: 'strong' }).catch(() => checkoutOrder);
    await orderStore.setJSON(session.id, { ...(latest || checkoutOrder), lateStayEmailStatus: 'failed', lateStayEmailError: String(error?.message || error).slice(0, 500), updatedAt: new Date().toISOString() }).catch(() => {});
    await writeAudit('late_stay.email_failed', { submissionId, ticketId, stripeCheckoutSessionId: session.id, error: String(error?.message || error) }).catch(() => {});
  }
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed.', { status: 405 });
  const rawBody = await req.text();
  const signature = req.headers.get('stripe-signature') || '';
  if (!verifyStripeSignature(rawBody, signature)) return new Response('Invalid Stripe signature.', { status: 400 });

  let event;
  try { event = JSON.parse(rawBody); } catch { return new Response('Invalid payload.', { status: 400 }); }
  const object = event?.data?.object || {};
  const purchaseType = String(object?.metadata?.purchaseType || '');
  if (purchaseType === 'water-package-addon' && String(event?.type || '').startsWith('checkout.session.')) {
    if ((event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') && object.payment_status === 'paid') {
      await sendWaterReceipt(object);
    }
    return Response.json({ received: true, waterPackage: true });
  }
  if (purchaseType === 'late-stay-addon' && String(event?.type || '').startsWith('checkout.session.')) {
    if ((event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') && object.payment_status === 'paid') {
      await fulfillAndSendLateStayReceipt(object);
    }
    return Response.json({ received: true, lateStay: true });
  }

  const forwarded = new Request(req.url, { method: 'POST', headers: req.headers, body: rawBody });
  return stripeWebhook(forwarded);
};
