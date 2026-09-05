import legacyRouter from './stripe-webhook-router.mjs';
import { verifyStripeSignature } from './_stripe-signature.mjs';
import { fulfillAddonBundle, expireAddonBundle } from './_addon-bundle.mjs';
import { handleAddonPaymentTransition } from './_addon-payment-transition.mjs';
import { fulfillStandaloneWater } from './_water-webhook.mjs';

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed.', { status: 405 });
  const rawBody = await req.text();
  const signature = req.headers.get('stripe-signature') || '';
  if (!verifyStripeSignature(rawBody, signature)) return new Response('Invalid Stripe signature.', { status: 400 });
  let event;
  try { event = JSON.parse(rawBody); } catch { return new Response('Invalid payload.', { status: 400 }); }
  const object = event?.data?.object || {};
  const purchaseType = String(object?.metadata?.purchaseType || '');

  if (purchaseType === 'addon-bundle' && String(event?.type || '').startsWith('checkout.session.')) {
    if ((event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') && object.payment_status === 'paid') await fulfillAddonBundle(object);
    if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') await expireAddonBundle(object);
    return Response.json({ received: true, addonBundle: true });
  }

  if (purchaseType === 'water-package-addon' && (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') && object.payment_status === 'paid') {
    await fulfillStandaloneWater(object);
  }

  if (await handleAddonPaymentTransition(event)) return Response.json({ received: true, addonPaymentTransition: true });

  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    if (String(input) === 'https://api.resend.com/emails' && typeof init?.body === 'string') {
      init = { ...init, body: init.body.replaceAll('8:00 AM', '10:00 AM').replaceAll('until 8:00 AM', 'until 10:00 AM').replaceAll('Stay until<br>8:00 AM.', 'Stay until<br>10:00 AM.') };
    }
    return previousFetch(input, init);
  };
  try {
    return await legacyRouter(new Request(req.url, { method: 'POST', headers: req.headers, body: rawBody }));
  } finally {
    globalThis.fetch = previousFetch;
  }
};
