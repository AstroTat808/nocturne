import { getStore } from '@netlify/blobs';
import adminRefundsCore from './admin-refunds-core.mjs';

const ORDER_STORE = 'nocturne-ticket-orders';
const NON_REFUNDABLE_MESSAGE = 'All NOCTURNE drink packages are non-refundable. Package-only and combined package refunds are disabled by policy.';

function policyError(message) {
  return Response.json({ error: message, policy: 'drink-packages-non-refundable' }, {
    status: 409,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' }
  });
}

export default async (req) => {
  if (req.method === 'POST') {
    let body = null;
    try { body = await req.clone().json(); } catch {}
    const action = String(body?.action || '');

    if (action === 'package-only' || action === 'combined') {
      return policyError(NON_REFUNDABLE_MESSAGE);
    }

    if (action === 'admission-only') {
      const submissionId = String(body?.submissionId || '').trim();
      if (/^[A-Za-z0-9_-]{6,128}$/.test(submissionId)) {
        const summary = await getStore({ name: ORDER_STORE, consistency: 'strong' })
          .get(`submission-${submissionId}`, { type: 'json', consistency: 'strong' })
          .catch(() => null);
        if (summary?.drinkPackagePurchased) {
          return policyError('The Six-Drink Package is non-refundable. Admission attached to this package cannot use the automatic full-refund action because that could refund the package amount. Process only the refundable admission portion directly in Stripe and leave the package charge untouched.');
        }
      }
    }
  }

  return adminRefundsCore(req);
};
