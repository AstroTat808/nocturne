import { getStore } from '@netlify/blobs';
import { randomBytes } from 'node:crypto';
import { readTicketAccess } from './_ticket-auth.mjs';
import { writeAudit } from './_audit.mjs';
import { drinkPackageConfig, drinkPackageRequested } from './_drink-package.mjs';
import { waterPackageConfig } from './_water-package.mjs';

const APPLICATION_STORE = 'nocturne-applications';
const REVIEW_STORE = 'nocturne-application-reviews';
const ORDER_STORE = 'nocturne-ticket-orders';

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' } });
}
function redirect(location) { return new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store' } }); }
function browserFormPost(req) { return (req.headers.get('content-type') || '').toLowerCase().includes('application/x-www-form-urlencoded'); }
function fail(req, message, status) { return browserFormPost(req) ? redirect(`/ticket-access?checkout_error=${encodeURIComponent(message)}`) : json({ error: message }, status); }
function checkoutConfigured() { const price = Number(process.env.NOCTURNE_TICKET_PRICE_CENTS || 0); return Boolean(process.env.STRIPE_SECRET_KEY && Number.isInteger(price) && price >= 50); }
function siteUrl(req) { return (process.env.NOCTURNE_SITE_URL || new URL(req.url).origin).replace(/\/$/, ''); }
function requested(value) { return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase()); }

async function stripeRequest(path, body, idempotencyKey = '') {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) }, body: new URLSearchParams(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `Stripe returned ${response.status}.`);
  return data;
}

function checkoutStillOpen(summary, includeDrinkPackage, includeWaterPackage) {
  if (summary?.status !== 'checkout_created' || !summary.checkoutUrl) return false;
  if (Boolean(summary.drinkPackageRequested) !== includeDrinkPackage) return false;
  if (Boolean(summary.waterPackageRequested) !== includeWaterPackage) return false;
  const expiresAt = new Date(summary.checkoutExpiresAt || 0).getTime();
  return Number.isFinite(expiresAt) && expiresAt > Date.now() + 60_000;
}

async function claimCheckoutAttempt(store, submissionId, selectionKey) {
  const key = `checkout-attempt-${submissionId}`;
  const entry = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
  const now = Date.now();
  const current = entry?.data || null;
  const startedAt = new Date(current?.startedAt || 0).getTime();
  if (current?.status === 'creating' && Number.isFinite(startedAt) && now - startedAt < 120_000) return null;
  const reuseKey = current?.status !== 'completed' && current?.selectionKey === selectionKey && current?.idempotencyKey;
  const attempt = { submissionId, status: 'creating', idempotencyKey: reuseKey || `nocturne-checkout-${randomBytes(18).toString('hex')}`, selectionKey, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const result = await store.setJSON(key, attempt, entry ? { onlyIfMatch: entry.etag } : { onlyIfNew: true });
  return result.modified ? { key, attempt } : null;
}

async function checkoutInput(req) {
  const contentType = (req.headers.get('content-type') || '').toLowerCase();
  try {
    if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
      const form = await req.formData();
      return {
        drinkPackage: drinkPackageRequested(form.get('drink_package')),
        drinkPolicyAccepted: String(form.get('drink_package_policy') || '').toLowerCase() === 'yes',
        waterPackage: requested(form.get('water_package')),
        waterPolicyAccepted: String(form.get('water_package_policy') || '').toLowerCase() === 'yes'
      };
    }
    if (contentType.includes('application/json')) {
      const data = await req.json();
      return {
        drinkPackage: drinkPackageRequested(data?.drinkPackage),
        drinkPolicyAccepted: data?.drinkPackagePolicy === true || requested(data?.drinkPackagePolicy),
        waterPackage: requested(data?.waterPackage),
        waterPolicyAccepted: data?.waterPackagePolicy === true || requested(data?.waterPackagePolicy)
      };
    }
  } catch {}
  return { drinkPackage: false, drinkPolicyAccepted: false, waterPackage: false, waterPolicyAccepted: false };
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(req.url).origin) return fail(req, 'Origin not allowed.', 403);
  const access = readTicketAccess(req);
  if (!access) return fail(req, 'Private ticket access has expired. Redeem a new invitation to continue.', 401);
  if (!checkoutConfigured()) return fail(req, 'Ticket checkout is not configured yet.', 503);
  const input = await checkoutInput(req);
  const packageConfig = drinkPackageConfig();
  const waterConfig = waterPackageConfig();
  const includeDrinkPackage = packageConfig.enabled && input.drinkPackage;
  const includeWaterPackage = waterConfig.enabled && input.waterPackage;
  if (includeDrinkPackage && !input.drinkPolicyAccepted) return fail(req, 'You must acknowledge that the Six-Drink Package is FINAL SALE / NON-REFUNDABLE before checkout.', 400);
  if (includeWaterPackage && !input.waterPolicyAccepted) return fail(req, 'You must acknowledge that the Unlimited Drinking Water Package is FINAL SALE / NON-REFUNDABLE before checkout.', 400);

  const submissionId = access.submissionId;
  const applicationStore = getStore({ name: APPLICATION_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const [application, review] = await Promise.all([applicationStore.get(submissionId, { type: 'json', consistency: 'strong' }), reviewStore.get(submissionId, { type: 'json', consistency: 'strong' })]);
  if (!application || !review || review.status !== 'approved' || review.inviteState !== 'redeemed') return fail(req, 'This invitation is not eligible for ticket checkout.', 403);

  const blockedTicketStates = new Set(['paid', 'checked_in', 'refunded', 'disputed']);
  if (blockedTicketStates.has(String(review.ticketState || '').toLowerCase())) return fail(req, review.ticketState === 'paid' || review.ticketState === 'checked_in' ? 'A ticket has already been issued for this invitation.' : 'This invitation has a protected payment record and cannot start another checkout.', 409);

  const summaryKey = `submission-${submissionId}`;
  const existingEntry = await orderStore.getWithMetadata(summaryKey, { type: 'json', consistency: 'strong' });
  const existing = existingEntry?.data || null;
  if (blockedTicketStates.has(String(existing?.status || '').toLowerCase())) return fail(req, 'This invitation already has a protected ticket or payment record.', 409);
  if (checkoutStillOpen(existing, includeDrinkPackage, includeWaterPackage)) return browserFormPost(req) ? redirect(existing.checkoutUrl) : json({ ok: true, checkoutUrl: existing.checkoutUrl, reused: true });

  const selectionKey = ['ticket', includeDrinkPackage ? 'six-drink' : '', includeWaterPackage ? 'water' : ''].filter(Boolean).join('+');
  const claim = await claimCheckoutAttempt(orderStore, submissionId, selectionKey);
  if (!claim) return fail(req, 'Your checkout is already being prepared. Please wait a moment and try again.', 409);

  const unitAmount = Number(process.env.NOCTURNE_TICKET_PRICE_CENTS);
  const currency = String(process.env.NOCTURNE_TICKET_CURRENCY || 'usd').toLowerCase();
  const productName = String(process.env.NOCTURNE_TICKET_NAME || 'NOCTURNE Festival — General Admission').slice(0, 120);
  const baseUrl = siteUrl(req);
  const expectedAmountTotal = unitAmount + (includeDrinkPackage ? packageConfig.priceCents : 0) + (includeWaterPackage ? waterConfig.priceCents : 0);
  const params = {
    mode: 'payment', success_url: `${baseUrl}/ticket-confirmed?session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${baseUrl}/ticket-access?checkout=cancelled`, client_reference_id: submissionId,
    'metadata[submissionId]': submissionId, 'metadata[event]': 'NOCTURNE',
    'metadata[drinkPackage]': includeDrinkPackage ? 'six-credit' : 'none', 'metadata[drinkCredits]': includeDrinkPackage ? String(packageConfig.credits) : '0', 'metadata[drinkPackagePolicyAccepted]': includeDrinkPackage ? 'true' : 'false',
    'metadata[waterPackage]': includeWaterPackage ? 'unlimited' : 'none', 'metadata[waterPackagePolicyAccepted]': includeWaterPackage ? 'true' : 'false',
    'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': currency, 'line_items[0][price_data][unit_amount]': String(unitAmount), 'line_items[0][price_data][product_data][name]': productName,
    'payment_intent_data[metadata][submissionId]': submissionId, 'payment_intent_data[metadata][event]': 'NOCTURNE',
    'payment_intent_data[metadata][drinkPackage]': includeDrinkPackage ? 'six-credit' : 'none', 'payment_intent_data[metadata][drinkPackagePolicyAccepted]': includeDrinkPackage ? 'true' : 'false',
    'payment_intent_data[metadata][waterPackage]': includeWaterPackage ? 'unlimited' : 'none', 'payment_intent_data[metadata][waterPackagePolicyAccepted]': includeWaterPackage ? 'true' : 'false'
  };
  let lineIndex = 1;
  if (includeDrinkPackage) {
    params[`line_items[${lineIndex}][quantity]`] = '1';
    params[`line_items[${lineIndex}][price_data][currency]`] = currency;
    params[`line_items[${lineIndex}][price_data][unit_amount]`] = String(packageConfig.priceCents);
    params[`line_items[${lineIndex}][price_data][product_data][name]`] = 'NOCTURNE Six-Drink Package — NON-REFUNDABLE';
    params[`line_items[${lineIndex}][price_data][product_data][description]`] = 'FINAL SALE / NON-REFUNDABLE. Six prepaid bar credits. Beer or well cocktail per credit; premium cocktails require a $5 upgrade at the bar. 21+ ID required. Unused credits are not refundable, exchangeable, transferable, or redeemable for cash.';
    lineIndex += 1;
  }
  if (includeWaterPackage) {
    params[`line_items[${lineIndex}][quantity]`] = '1';
    params[`line_items[${lineIndex}][price_data][currency]`] = currency;
    params[`line_items[${lineIndex}][price_data][unit_amount]`] = String(waterConfig.priceCents);
    params[`line_items[${lineIndex}][price_data][product_data][name]`] = 'NOCTURNE Unlimited Drinking Water — NON-REFUNDABLE';
    params[`line_items[${lineIndex}][price_data][product_data][description]`] = 'FINAL SALE / NON-REFUNDABLE. Unlimited drinking-water service for the registered ticket holder during festival operating hours. One package per ticket; non-transferable.';
  }
  if (application.email) params.customer_email = application.email;
  if (process.env.NOCTURNE_TICKET_DESCRIPTION) params['line_items[0][price_data][product_data][description]'] = String(process.env.NOCTURNE_TICKET_DESCRIPTION).slice(0, 500);

  try {
    if (existing?.status === 'checkout_created' && existing.stripeCheckoutSessionId) await stripeRequest(`checkout/sessions/${encodeURIComponent(existing.stripeCheckoutSessionId)}/expire`, {}).catch(() => {});
    const session = await stripeRequest('checkout/sessions', params, claim.attempt.idempotencyKey);
    const createdAt = new Date().toISOString();
    const checkoutExpiresAt = session.expires_at ? new Date(Number(session.expires_at) * 1000).toISOString() : null;
    const record = {
      stripeCheckoutSessionId: session.id, submissionId, status: 'checkout_created', amountTotal: expectedAmountTotal, ticketAmount: unitAmount,
      drinkPackageRequested: includeDrinkPackage, drinkPackagePolicyAccepted: includeDrinkPackage ? true : null, drinkPackagePriceCents: includeDrinkPackage ? packageConfig.priceCents : 0, drinkCreditsPurchased: includeDrinkPackage ? packageConfig.credits : 0,
      waterPackageRequested: includeWaterPackage, waterPackagePolicyAccepted: includeWaterPackage ? true : null, waterPackagePriceCents: includeWaterPackage ? waterConfig.priceCents : 0,
      currency, customerEmail: application.email || null, checkoutUrl: session.url, checkoutExpiresAt, createdAt, updatedAt: createdAt
    };
    await orderStore.setJSON(session.id, record);
    const summaryWrite = await orderStore.setJSON(summaryKey, { ...record, expectedAmountTotal }, existingEntry ? { onlyIfMatch: existingEntry.etag } : { onlyIfNew: true });
    if (!summaryWrite.modified) {
      await stripeRequest(`checkout/sessions/${encodeURIComponent(session.id)}/expire`, {}).catch(() => {});
      await orderStore.setJSON(session.id, { ...record, status: 'checkout_conflict', updatedAt: new Date().toISOString() });
      throw new Error('Ticket eligibility changed while checkout was being prepared.');
    }
    await orderStore.setJSON(claim.key, { ...claim.attempt, status: 'completed', stripeCheckoutSessionId: session.id, checkoutExpiresAt, updatedAt: createdAt });
    await writeAudit('checkout.created', { submissionId, stripeCheckoutSessionId: session.id, drinkPackageRequested: includeDrinkPackage, drinkPackagePolicyAccepted: includeDrinkPackage ? true : null, waterPackageRequested: includeWaterPackage, waterPackagePolicyAccepted: includeWaterPackage ? true : null, expectedAmountTotal });
    return browserFormPost(req) ? redirect(session.url) : json({ ok: true, checkoutUrl: session.url });
  } catch (error) {
    await orderStore.setJSON(claim.key, { ...claim.attempt, status: 'failed', error: String(error?.message || error).slice(0, 500), updatedAt: new Date().toISOString() }).catch(() => {});
    await writeAudit('checkout.failed', { submissionId, error: String(error?.message || error) });
    console.error('NOCTURNE Stripe checkout creation failed:', error);
    return fail(req, 'Ticket checkout could not be started. Please try again.', 502);
  }
};
