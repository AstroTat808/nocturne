import QRCode from 'qrcode';
import { getStore } from '@netlify/blobs';
import { verifyTicketToken } from './_ticket-token.mjs';

const ORDER_STORE = 'nocturne-ticket-orders';

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method not allowed.', { status: 405 });

  const url = new URL(req.url);
  const token = String(url.searchParams.get('token') || '').trim();
  const parsed = verifyTicketToken(token);
  if (!parsed) return new Response('Invalid ticket.', { status: 400, headers: { 'Cache-Control': 'no-store' } });

  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const order = await orderStore.get(`submission-${parsed.submissionId}`, { type: 'json', consistency: 'strong' });
  if (!order || order.status !== 'paid' || order.ticketId !== parsed.ticketId) {
    return new Response('Inactive ticket.', { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }

  const base = (process.env.NOCTURNE_SITE_URL || url.origin).replace(/\/$/, '');
  const ticketUrl = `${base}/ticket?token=${encodeURIComponent(token)}`;
  const svg = await QRCode.toString(ticketUrl, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 520,
    color: { dark: '#050505', light: '#ffffff' }
  });

  return new Response(svg, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow, noarchive'
    }
  });
};
