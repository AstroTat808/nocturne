import adminRefunds from './admin-refunds.mjs';

const NON_REFUNDABLE_MESSAGE = 'All NOCTURNE drink packages are non-refundable. Package-only and combined package refunds are disabled by policy.';

export default async (req) => {
  if (req.method === 'POST') {
    let body = null;
    try { body = await req.clone().json(); } catch {}
    const action = String(body?.action || '');
    if (action === 'package-only' || action === 'combined') {
      return Response.json({
        error: NON_REFUNDABLE_MESSAGE,
        policy: 'drink-packages-non-refundable'
      }, {
        status: 409,
        headers: {
          'Cache-Control': 'no-store',
          'Content-Type': 'application/json; charset=utf-8'
        }
      });
    }
  }

  return adminRefunds(req);
};
