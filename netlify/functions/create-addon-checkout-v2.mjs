import { getStore } from '@netlify/blobs';
import createAddonCheckout from './create-addon-checkout.mjs';
import { verifyTicketToken } from './_ticket-token.mjs';
import { releaseLateStayReservation } from './_late-stay.mjs';

const ORDER_STORE = 'nocturne-ticket-orders';
function accepted(value) { return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase()); }
async function parse(req) {
  const type = String(req.headers.get('content-type') || '').toLowerCase();
  if (type.includes('application/x-www-form-urlencoded')) {
    const raw = await req.text(); const form = new URLSearchParams(raw);
    return { raw, token: String(form.get('token') || '').trim(), drink: accepted(form.get('drink_package')), water: accepted(form.get('water_package')), late: accepted(form.get('late_stay')) };
  }
  if (type.includes('multipart/form-data')) {
    const form = await req.formData();
    return { form, token: String(form.get('token') || '').trim(), drink: accepted(form.get('drink_package')), water: accepted(form.get('water_package')), late: accepted(form.get('late_stay')) };
  }
  if (type.includes('application/json')) {
    const raw = await req.text(); let data = {}; try { data = JSON.parse(raw); } catch {}
    return { raw, token: String(data?.token || '').trim(), drink: accepted(data?.drinkPackage), water: accepted(data?.waterPackage), late: accepted(data?.lateStay) };
  }
  return { raw: '', token: '', drink: false, water: false, late: false };
}
function rebuild(req, parsed) {
  const headers = new Headers(req.headers); headers.delete('content-length');
  if (parsed.form) {
    headers.delete('content-type');
    return new Request(req.url, { method: req.method, headers, body: parsed.form });
  }
  return new Request(req.url, { method: req.method, headers, body: parsed.raw });
}
async function stripeSession(id) {
  if (!id || !process.env.STRIPE_SECRET_KEY) return null;
  const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` } });
  const data = await response.json().catch(() => null); return response.ok ? data : null;
}
async function expire(id) {
  if (!id || !process.env.STRIPE_SECRET_KEY) return false;
  const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(id)}/expire`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams() }).catch(() => null);
  if (!response) return false;
  if (response.ok) return true;
  const data = await response.json().catch(() => null);
  return response.status === 400 && ['expired', 'complete'].includes(String(data?.error?.checkout_session?.status || ''));
}

export default async (req) => {
  if (req.method !== 'POST') return createAddonCheckout(req);
  const parsedInput = await parse(req.clone()).catch(() => ({ token: '' }));
  const tokenData = verifyTicketToken(parsedInput.token || '');
  if (!tokenData) return createAddonCheckout(rebuild(req, parsedInput));
  const store = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const key = `submission-${tokenData.submissionId}`;
  const entry = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
  const summary = entry?.data || null;
  if (!summary || summary.ticketId !== tokenData.ticketId) return createAddonCheckout(rebuild(req, parsedInput));

  const selected = [
    { chosen: parsedInput.drink, prefix: 'drinkPackage' },
    { chosen: parsedInput.water, prefix: 'waterPackage' },
    { chosen: parsedInput.late, prefix: 'lateStay' }
  ];
  const patch = {};
  for (const item of selected) {
    if (!item.chosen || summary[`${item.prefix}Purchased`] || summary[`${item.prefix}CheckoutStatus`] !== 'checkout_created') continue;
    const id = summary[`${item.prefix}CheckoutSessionId`];
    const session = await stripeSession(id);
    if (!session) continue;
    if (session.payment_status === 'paid' || session.status === 'complete') continue;
    if (!['open', 'expired'].includes(String(session.status || ''))) continue;
    if (session.status === 'open' && !(await expire(id))) continue;
    if (item.prefix === 'lateStay') await releaseLateStayReservation({ slot: summary.lateStaySlot, reservationId: summary.lateStayReservationId, reason: 'replaced_by_combined_checkout' }).catch(() => {});
    patch[`${item.prefix}CheckoutStatus`] = 'replaced';
    patch[`${item.prefix}CheckoutUrl`] = null;
    patch[`${item.prefix}CheckoutExpiresAt`] = null;
    if (item.prefix === 'lateStay') { patch.lateStaySlot = null; patch.lateStayReservationId = null; }
  }
  if (Object.keys(patch).length) {
    const now = new Date().toISOString();
    await store.setJSON(key, { ...summary, ...patch, updatedAt: now }, { onlyIfMatch: entry.etag });
  }
  return createAddonCheckout(rebuild(req, parsedInput));
};
