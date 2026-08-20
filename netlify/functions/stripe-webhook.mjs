import { getStore } from '@netlify/blobs';
import { createHmac, timingSafeEqual } from 'node:crypto';

const ORDER_STORE = 'nocturne-ticket-orders';
const REVIEW_STORE = 'nocturne-application-reviews';
const APPLICATION_STORE = 'nocturne-applications';

function safeEqual(a = '', b = '') {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function parseStripeSignature(header = '') {
  const parts = String(header).split(',').map((part) => part.trim());
  const timestamp = parts.find((part) => part.startsWith('t='))?.slice(2) || '';
  const signatures = parts.filter((part) => part.startsWith('v1=')).map((part) => part.slice(3));
  return { timestamp, signatures };
}

function verifyStripeSignature(rawBody, signatureHeader) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET || '';
  if (!secret) return false;
  const { timestamp, signatures } = parseStripeSignature(signatureHeader);
  if (!/^\d{9,12}$/.test(timestamp) || !signatures.length) return false;

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (age > 300) return false;

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return signatures.some((signature) => safeEqual(signature, expected));
}

async function sendTicketReceipt(application, session, ticketId) {
  if (!process.env.RESEND_API_KEY || !process.env.NOCTURNE_EMAIL_FROM || !application?.email) {
    return { sent: false, reason: 'Email not configured.' };
  }

  const amount = Number(session.amount_total || 0) / 100;
  const currency = String(session.currency || 'usd').toUpperCase();
  const displayName = application.preferredName || application.fullName || 'Guest';
  const text = `${displayName},\n\nYour NOCTURNE ticket purchase is confirmed.\n\nTicket ID: ${ticketId}\nAmount: ${currency} ${amount.toFixed(2)}\n\nYour ticket is registered to the email used in your application. Keep this message for your records. Additional event and check-in instructions will be sent privately.\n\nNOCTURNE Festival\nPresented by Wild Ones · Hawai‘i`;
  const html = `<!doctype html><html><body style="margin:0;background:#030303;color:#f7efe3;font-family:Arial,sans-serif"><div style="max-width:640px;margin:0 auto;padding:44px 24px"><div style="border:1px solid rgba(216,154,43,.35);background:#080604;padding:38px 30px"><div style="color:#d89a2b;font-size:11px;letter-spacing:3px;text-transform:uppercase">NOCTURNE · Ticket Confirmed</div><h1 style="font-family:Georgia,serif;font-weight:400;font-size:42px;line-height:1.04;color:#fff3df;margin:16px 0 22px">Your ticket<br>is confirmed.</h1><p style="color:#c8baa4;line-height:1.7">${displayName}, your NOCTURNE ticket purchase has been received.</p><div style="margin:28px 0;padding:18px;border-left:2px solid #d89a2b;background:#020202;color:#d8c7ac;line-height:1.8"><strong>Ticket ID:</strong> ${ticketId}<br><strong>Amount:</strong> ${currency} ${amount.toFixed(2)}</div><p style="color:#9d907f;line-height:1.7">Your ticket is registered to the email used in your application. Keep this message for your records. Additional event and check-in instructions will be sent privately.</p><div style="margin-top:34px;padding-top:20px;border-top:1px solid rgba(216,154,43,.18);color:#74695b;font-size:11px;letter-spacing:1px;text-transform:uppercase">NOCTURNE Festival · Presented by Wild Ones · Hawai‘i</div></div></div></body></html>`;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: process.env.NOCTURNE_EMAIL_FROM,
      to: [application.email],
      subject: 'Your NOCTURNE Ticket Is Confirmed',
      html,
      text
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `Resend returned ${response.status}.`);
  return { sent: true, messageId: data.id || null };
}

async function handleCompletedSession(session) {
  if (!session?.id || session.payment_status !== 'paid') return;
  const submissionId = String(session.client_reference_id || session.metadata?.submissionId || '').trim();
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(submissionId)) throw new Error('Stripe session is missing a valid submission ID.');

  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const applicationStore = getStore({ name: APPLICATION_STORE, consistency: 'strong' });

  const existing = await orderStore.get(session.id, { type: 'json', consistency: 'strong' });
  if (existing?.status === 'paid') return;

  const paidAt = new Date().toISOString();
  const ticketId = existing?.ticketId || `NOC-TKT-${session.id.slice(-12).toUpperCase()}`;
  const application = await applicationStore.get(submissionId, { type: 'json', consistency: 'strong' });
  const review = await reviewStore.get(submissionId, { type: 'json', consistency: 'strong' });

  let emailStatus = 'not_sent';
  let emailMessageId = null;
  let emailError = null;

  try {
    const email = await sendTicketReceipt(application, session, ticketId);
    emailStatus = email.sent ? 'sent' : 'not_configured';
    emailMessageId = email.messageId || null;
    emailError = email.reason || null;
  } catch (error) {
    console.error('NOCTURNE ticket confirmation email failed:', error);
    emailStatus = 'failed';
    emailError = String(error?.message || error).slice(0, 500);
  }

  const order = {
    ...(existing || {}),
    stripeCheckoutSessionId: session.id,
    stripePaymentIntentId: session.payment_intent || null,
    submissionId,
    ticketId,
    status: 'paid',
    paymentStatus: session.payment_status,
    amountTotal: session.amount_total || null,
    currency: session.currency || null,
    customerEmail: session.customer_details?.email || application?.email || null,
    customerName: session.customer_details?.name || application?.fullName || null,
    paidAt,
    ticketEmailStatus: emailStatus,
    ticketEmailMessageId: emailMessageId,
    ticketEmailError: emailError,
    updatedAt: paidAt
  };

  await orderStore.setJSON(session.id, order);
  await orderStore.setJSON(`submission-${submissionId}`, {
    stripeCheckoutSessionId: session.id,
    submissionId,
    ticketId,
    status: 'paid',
    paidAt,
    updatedAt: paidAt
  });

  if (review) {
    await reviewStore.setJSON(submissionId, {
      ...review,
      ticketState: 'paid',
      ticketPurchasedAt: paidAt,
      ticketId,
      stripeCheckoutSessionId: session.id,
      stripePaymentIntentId: session.payment_intent || null,
      ticketEmailStatus: emailStatus,
      ticketEmailSentAt: emailStatus === 'sent' ? paidAt : null,
      ticketEmailMessageId: emailMessageId,
      ticketEmailError: emailError,
      updatedAt: paidAt
    });
  }
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed.', { status: 405 });

  const rawBody = await req.text();
  const signature = req.headers.get('stripe-signature') || '';
  if (!verifyStripeSignature(rawBody, signature)) {
    return new Response('Invalid Stripe signature.', { status: 400 });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response('Invalid payload.', { status: 400 });
  }

  try {
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      await handleCompletedSession(event.data?.object);
    }
    return Response.json({ received: true });
  } catch (error) {
    console.error('NOCTURNE Stripe webhook processing failed:', error);
    return new Response('Webhook processing failed.', { status: 500 });
  }
};
