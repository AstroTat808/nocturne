import { getStore } from '@netlify/blobs';
import { readTicketAccess } from './_ticket-auth.mjs';

const APPLICATION_STORE = 'nocturne-applications';
const REVIEW_STORE = 'nocturne-application-reviews';
const ORDER_STORE = 'nocturne-ticket-orders';

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function redirect(location) {
  return new Response(null, {
    status: 303,
    headers: { Location: location, 'Cache-Control': 'no-store' }
  });
}

function browserFormPost(req) {
  return (req.headers.get('content-type') || '').toLowerCase().includes('application/x-www-form-urlencoded');
}

function fail(req, message, status) {
  if (browserFormPost(req)) return redirect(`/ticket-access?checkout_error=${encodeURIComponent(message)}`);
  return json({ error: message }, status);
}

function checkoutConfigured() {
  const price = Number(process.env.NOCTURNE_TICKET_PRICE_CENTS || 0);
  return Boolean(process.env.STRIPE_SECRET_KEY && Number.isInteger(price) && price >= 50);
}

function siteUrl(req) {
  return (process.env.NOCTURNE_SITE_URL || new URL(req.url).origin).replace(/\/$/, '');
}

async function stripeRequest(path, body) {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `Stripe returned ${response.status}.`);
  return data;
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(req.url).origin) return fail(req, 'Origin not allowed.', 403);

  const access = readTicketAccess(req);
  if (!access) return fail(req, 'Private ticket access has expired. Redeem a new invitation to continue.', 401);
  if (!checkoutConfigured()) return fail(req, 'Ticket checkout is not configured yet.', 503);

  const submissionId = access.submissionId;
  const applicationStore = getStore({ name: APPLICATION_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });

  const [application, review] = await Promise.all([
    applicationStore.get(submissionId, { type: 'json', consistency: 'strong' }),
    reviewStore.get(submissionId, { type: 'json', consistency: 'strong' })
  ]);

  if (!application || !review || review.status !== 'approved' || review.inviteState !== 'redeemed') {
    return fail(req, 'This invitation is not eligible for ticket checkout.', 403);
  }

  if (review.ticketState === 'paid' && review.stripeCheckoutSessionId) {
    return fail(req, 'A ticket has already been purchased for this invitation.', 409);
  }

  const existing = await orderStore.get(`submission-${submissionId}`, { type: 'json', consistency: 'strong' });
  if (existing?.status === 'paid') return fail(req, 'A ticket has already been purchased for this invitation.', 409);

  const unitAmount = Number(process.env.NOCTURNE_TICKET_PRICE_CENTS);
  const currency = String(process.env.NOCTURNE_TICKET_CURRENCY || 'usd').toLowerCase();
  const productName = String(process.env.NOCTURNE_TICKET_NAME || 'NOCTURNE Festival — General Admission').slice(0, 120);
  const baseUrl = siteUrl(req);

  const params = {
    mode: 'payment',
    success_url: `${baseUrl}/ticket-confirmed?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/ticket-access?checkout=cancelled`,
    client_reference_id: submissionId,
    'metadata[submissionId]': submissionId,
    'metadata[event]': 'NOCTURNE',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': currency,
    'line_items[0][price_data][unit_amount]': String(unitAmount),
    'line_items[0][price_data][product_data][name]': productName,
    'payment_intent_data[metadata][submissionId]': submissionId,
    'payment_intent_data[metadata][event]': 'NOCTURNE'
  };

  if (application.email) params.customer_email = application.email;
  if (process.env.NOCTURNE_TICKET_DESCRIPTION) {
    params['line_items[0][price_data][product_data][description]'] = String(process.env.NOCTURNE_TICKET_DESCRIPTION).slice(0, 500);
  }

  try {
    const session = await stripeRequest('checkout/sessions', params);
    const createdAt = new Date().toISOString();
    await orderStore.setJSON(session.id, {
      stripeCheckoutSessionId: session.id,
      submissionId,
      status: 'checkout_created',
      amountTotal: unitAmount,
      currency,
      customerEmail: application.email || null,
      createdAt,
      updatedAt: createdAt
    });
    await orderStore.setJSON(`submission-${submissionId}`, {
      stripeCheckoutSessionId: session.id,
      submissionId,
      status: 'checkout_created',
      createdAt,
      updatedAt: createdAt
    });

    if (browserFormPost(req)) return redirect(session.url);
    return json({ ok: true, checkoutUrl: session.url });
  } catch (error) {
    console.error('NOCTURNE Stripe checkout creation failed:', error);
    return fail(req, 'Ticket checkout could not be started. Please try again.', 502);
  }
};
