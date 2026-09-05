import { getStore } from '@netlify/blobs';
import { readFile } from 'node:fs/promises';
import { PKPass } from 'passkit-generator';
import { verifyTicketToken } from './_ticket-token.mjs';
import { appleWalletCertificates, appleWalletConfigured, buildAppleWalletPass } from './_apple-wallet.mjs';
import { waiverSigned } from './_waiver.mjs';
import { writeAudit } from './_audit.mjs';

const ORDER_STORE = 'nocturne-ticket-orders';
const APPLICATION_STORE = 'nocturne-applications';
const REVIEW_STORE = 'nocturne-application-reviews';
const ASSET_NAMES = ['icon.png', 'icon@2x.png', 'icon@3x.png', 'logo.png', 'logo@2x.png', 'logo@3x.png'];

function response(message, status) { return new Response(message, { status, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow, noarchive' } }); }
async function passAssets(passJson) { const entries = await Promise.all(ASSET_NAMES.map(async (name) => [name, await readFile(new URL(`./wallet-assets/${name}`, import.meta.url))])); return { ...Object.fromEntries(entries), 'pass.json': Buffer.from(JSON.stringify(passJson)) }; }

export default async (req) => {
  if (req.method !== 'GET') return response('Method not allowed.', 405);
  const url = new URL(req.url);
  const token = String(url.searchParams.get('token') || '').trim();
  const parsed = verifyTicketToken(token);
  if (!parsed) return response('Invalid ticket.', 400);

  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const applicationStore = getStore({ name: APPLICATION_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const [order, application, review] = await Promise.all([
    orderStore.get(`submission-${parsed.submissionId}`, { type: 'json', consistency: 'strong' }),
    applicationStore.get(parsed.submissionId, { type: 'json', consistency: 'strong' }),
    reviewStore.get(parsed.submissionId, { type: 'json', consistency: 'strong' })
  ]);
  if (!order || order.status !== 'paid' || order.ticketId !== parsed.ticketId || !['paid', 'checked_in'].includes(review?.ticketState)) return response('This ticket is inactive.', 403);
  if (!appleWalletConfigured()) return response('Apple Wallet passes are not configured yet.', 503);

  const base = (process.env.NOCTURNE_SITE_URL || url.origin).replace(/\/$/, '');
  const ticketUrl = `${base}/ticket?token=${encodeURIComponent(token)}`;
  const manageAddonsUrl = `${base}/ticket/addons?token=${encodeURIComponent(token)}`;
  const waiverUrl = `${base}/ticket/waiver?token=${encodeURIComponent(token)}`;
  const guestName = application?.preferredName || application?.fullName || 'NOCTURNE Guest';
  const signed = waiverSigned(order, review);
  const passJson = buildAppleWalletPass({
    ticketId: parsed.ticketId,
    guestName,
    ticketName: process.env.NOCTURNE_TICKET_NAME || 'NOCTURNE Festival',
    ticketUrl,
    manageAddonsUrl,
    waiverUrl,
    waiverSigned: signed,
    checkedIn: Boolean(order.checkedInAt || review.checkedInAt || review.ticketState === 'checked_in'),
    drinkPackage: { purchased: Boolean(order.drinkPackagePurchased), remaining: order.drinkCreditsRemaining, purchasedCredits: order.drinkCreditsPurchased }
  });

  try {
    const pass = new PKPass(await passAssets(passJson), appleWalletCertificates());
    const output = pass.getAsBuffer();
    await writeAudit('ticket.apple_wallet_downloaded', { submissionId: parsed.submissionId, ticketId: parsed.ticketId, waiverSigned: signed });
    return new Response(output, { status: 200, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/vnd.apple.pkpass', 'Content-Disposition': `attachment; filename="NOCTURNE-${parsed.ticketId}.pkpass"`, 'Content-Length': String(output.length), 'X-Robots-Tag': 'noindex, nofollow, noarchive' } });
  } catch (error) {
    console.error('NOCTURNE Apple Wallet pass generation failed:', error);
    await writeAudit('ticket.apple_wallet_failed', { submissionId: parsed.submissionId, ticketId: parsed.ticketId, error: String(error?.message || error) });
    return response('Apple Wallet pass generation failed.', 500);
  }
};
