import adminRefundsCore from './admin-refunds-core.mjs';
import adminAdmissionRefund from './admin-admission-refund.mjs';

const NON_REFUNDABLE_MESSAGE = 'All NOCTURNE drink packages are FINAL SALE / NON-REFUNDABLE. Package-only and combined package refunds are disabled by policy.';

function policyError(message) {
  return Response.json({ error: message, policy: 'drink-packages-non-refundable' }, {
    status: 409,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' }
  });
}

export default async (req) => {
  if (req.method === 'GET') return adminRefundsCore(req);
  if (req.method !== 'POST') return adminRefundsCore(req);

  let body = null;
  try { body = await req.clone().json(); } catch {}
  const action = String(body?.action || '');

  if (action === 'package-only' || action === 'combined') {
    return policyError(NON_REFUNDABLE_MESSAGE);
  }

  if (action === 'admission-only') return adminAdmissionRefund(req);
  return policyError('Only admission-only refunds are permitted. Drink packages are FINAL SALE / NON-REFUNDABLE.');
};
