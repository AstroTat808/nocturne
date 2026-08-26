import stripeWebhook from './stripe-webhook.mjs';
import { verifyStripeSignature } from './_stripe-signature.mjs';

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed.', { status: 405 });
  const rawBody = await req.text();
  const signature = req.headers.get('stripe-signature') || '';
  if (!verifyStripeSignature(rawBody, signature)) return new Response('Invalid Stripe signature.', { status: 400 });

  let event;
  try { event = JSON.parse(rawBody); } catch { return new Response('Invalid payload.', { status: 400 }); }
  const purchaseType = String(event?.data?.object?.metadata?.purchaseType || '');
  if (purchaseType === 'water-package-addon' && String(event?.type || '').startsWith('checkout.session.')) {
    return Response.json({ received: true, waterPackage: true });
  }

  const forwarded = new Request(req.url, {
    method: 'POST',
    headers: req.headers,
    body: rawBody
  });
  return stripeWebhook(forwarded);
};
