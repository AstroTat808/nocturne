import adminRefundsCore from './admin-refunds-core.mjs';
import adminAdmissionRefund from './admin-admission-refund.mjs';

const NON_REFUNDABLE_MESSAGE = 'All NOCTURNE drink packages are FINAL SALE / NON-REFUNDABLE. Package-only and combined package refunds are disabled by policy.';

function policyError(message) {
  return Response.json({ error: message, policy: 'drink-packages-non-refundable' }, {
    status: 409,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function normalizeHistoryItem(item = {}) {
  const reason = String(item.reason || '').trim() || 'not_recorded';
  const reasonLabel = String(item.reasonLabel || '').trim() || (reason === 'not_recorded' ? 'Not recorded (legacy)' : reason.replaceAll('_', ' '));
  const notes = typeof item.notes === 'string' ? item.notes : '';
  return { ...item, reason, reasonLabel, notes };
}

async function historyResponse(req) {
  const response = await adminRefundsCore(req);
  if (!response.ok) return response;
  let data;
  try { data = await response.json(); } catch { return response; }
  return Response.json({ ...data, history: Array.isArray(data.history) ? data.history.map(normalizeHistoryItem) : [] }, {
    status: response.status,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' }
  });
}

export default async (req) => {
  if (req.method === 'GET') return historyResponse(req);
  if (req.method !== 'POST') return adminRefundsCore(req);

  let body = null;
  try { body = await req.clone().json(); } catch {}
  const action = String(body?.action || '');

  if (action === 'package-only' || action === 'combined') return policyError(NON_REFUNDABLE_MESSAGE);
  if (action === 'admission-only') return adminAdmissionRefund(req);
  return policyError('Only admission-only refunds are permitted. Drink packages are FINAL SALE / NON-REFUNDABLE.');
};
