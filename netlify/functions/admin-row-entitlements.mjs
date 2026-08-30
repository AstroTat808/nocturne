import { getStore } from '@netlify/blobs';
import { createHmac, timingSafeEqual } from 'node:crypto';

const APPLICATION_STORE = 'nocturne-applications';
const REVIEW_STORE = 'nocturne-application-reviews';
const ORDER_STORE = 'nocturne-ticket-orders';
const SESSION_COOKIE = 'nocturne_admin';

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

function safeEqual(a = '', b = '') {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function sessionSecret() {
  return process.env.NOCTURNE_ADMIN_SESSION_SECRET || process.env.NOCTURNE_ADMIN_KEY || '';
}

function sign(value) {
  return createHmac('sha256', sessionSecret()).update(value).digest('base64url');
}

function parseCookies(req) {
  const header = req.headers.get('cookie') || '';
  return Object.fromEntries(header.split(';').map((part) => {
    const index = part.indexOf('=');
    if (index < 0) return ['', ''];
    let value = part.slice(index + 1).trim();
    try { value = decodeURIComponent(value); } catch {}
    return [part.slice(0, index).trim(), value];
  }).filter(([key]) => key));
}

function authenticated(req) {
  if (!sessionSecret()) return false;
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token || !token.includes('.')) return false;
  const [payload, signature] = token.split('.', 2);
  if (!safeEqual(signature, sign(payload))) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.role === 'admin' && Number(data.exp) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function ticketState(summary, review) {
  if (summary?.status === 'disputed' || review?.ticketState === 'disputed') return 'disputed';
  if (summary?.status === 'refunded' || review?.ticketState === 'refunded') return 'refunded';
  if (summary?.checkedInAt || review?.checkedInAt || review?.ticketState === 'checked_in') return 'checked_in';
  if (summary?.status === 'paid' || review?.ticketState === 'paid') return 'paid';
  if (summary?.status === 'checkout_created') return 'checkout_created';
  if (summary?.status === 'checkout_expired') return 'checkout_expired';
  return 'none';
}

function activeEntitlement(purchased, status) {
  if (!purchased) return false;
  const value = String(status || '').toLowerCase();
  return !['revoked', 'refunded', 'forfeited', 'invalidated', 'none'].includes(value);
}

export default async (req) => {
  if (req.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
  if (!authenticated(req)) return json({ error: 'Unauthorized.' }, 401);

  try {
    const applicationStore = getStore({ name: APPLICATION_STORE, consistency: 'strong' });
    const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
    const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
    const { blobs } = await applicationStore.list();

    const entries = (await Promise.all(blobs.map(async ({ key }) => {
      const [application, review, summary] = await Promise.all([
        applicationStore.get(key, { type: 'json', consistency: 'strong' }),
        reviewStore.get(key, { type: 'json', consistency: 'strong' }),
        orderStore.get(`submission-${key}`, { type: 'json', consistency: 'strong' })
      ]);
      if (!application?.email) return null;

      const state = ticketState(summary, review);
      const drinkPurchased = Boolean(summary?.drinkPackagePurchased || review?.drinkPackagePurchased);
      const drinkStatus = summary?.drinkPackageStatus || review?.drinkPackageStatus || 'none';
      const waterPurchased = Boolean(summary?.waterPackagePurchased || review?.waterPackagePurchased);
      const waterStatus = summary?.waterPackageStatus || review?.waterPackageStatus || 'none';

      return {
        applicationId: application.id || key,
        email: String(application.email).trim().toLowerCase(),
        ticketId: summary?.ticketId || review?.ticketId || null,
        ticketState: state,
        hasValidTicket: ['paid', 'checked_in'].includes(state),
        drinkPackagePurchased: drinkPurchased,
        drinkPackageStatus: drinkStatus,
        hasDrinkPackage: activeEntitlement(drinkPurchased, drinkStatus),
        drinkCreditsRemaining: Number(summary?.drinkCreditsRemaining ?? review?.drinkCreditsRemaining ?? 0),
        waterPackagePurchased: waterPurchased,
        waterPackageStatus: waterStatus,
        hasWaterPackage: activeEntitlement(waterPurchased, waterStatus)
      };
    }))).filter(Boolean);

    const summary = entries.reduce((counts, entry) => {
      if (entry.drinkPackagePurchased) counts.drinkPackagePurchases += 1;
      if (entry.waterPackagePurchased) counts.waterPackagePurchases += 1;
      if (entry.hasDrinkPackage) counts.activeDrinkPackages += 1;
      if (entry.hasWaterPackage) counts.activeWaterPackages += 1;
      return counts;
    }, {
      drinkPackagePurchases: 0,
      waterPackagePurchases: 0,
      activeDrinkPackages: 0,
      activeWaterPackages: 0
    });

    return json({ entries, summary });
  } catch (error) {
    console.error('NOCTURNE admin row entitlement lookup failed:', error);
    return json({ error: 'Ticket/package indicators could not be loaded.' }, 500);
  }
};
