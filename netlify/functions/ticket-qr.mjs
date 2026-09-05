import QRCode from 'qrcode';
import { getStore } from '@netlify/blobs';
import { verifyTicketToken } from './_ticket-token.mjs';
import { waiverSigned } from './_waiver.mjs';

const ORDER_STORE = 'nocturne-ticket-orders';
const REVIEW_STORE = 'nocturne-application-reviews';

export default async (req) => {
  if (req.method !== 'GET') return new Response('Method not allowed.', { status: 405 });

  const url = new URL(req.url);
  const token = String(url.searchParams.get('token') || '').trim();
  const parsed = verifyTicketToken(token);
  if (!parsed) return new Response('Invalid ticket.', { status: 400, headers: { 'Cache-Control': 'no-store' } });

  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const [order, review] = await Promise.all([
    orderStore.get(`submission-${parsed.submissionId}`, { type: 'json', consistency: 'strong' }),
    reviewStore.get(parsed.submissionId, { type: 'json', consistency: 'strong' })
  ]);
  if (!order || order.status !== 'paid' || order.ticketId !== parsed.ticketId || !['paid', 'checked_in'].includes(String(review?.ticketState || ''))) {
    return new Response('Inactive ticket.', { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }
  if (!waiverSigned(order, review)) {
    return new Response('Required participant waiver has not been signed.', { status: 403, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow, noarchive' } });
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
