import { getStore } from '@netlify/blobs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { appleWalletStatus } from './_apple-wallet.mjs';

const APPLICATION_STORE = 'nocturne-applications';
const REVIEW_STORE = 'nocturne-application-reviews';
const INVITE_STORE = 'nocturne-invites';
const ORDER_STORE = 'nocturne-ticket-orders';
const STRIPE_EVENT_STORE = 'nocturne-stripe-events';
const EMAIL_EVENT_STORE = 'nocturne-email-events';
const DRINK_REDEMPTION_STORE = 'nocturne-drink-redemptions';
const SESSION_COOKIE = 'nocturne_admin';
const REQUIRED_WEBHOOK_EVENTS = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'charge.refunded',
  'refund.updated',
  'charge.dispute.created',
  'charge.dispute.closed'
]);

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

function adminSecret() {
  return process.env.NOCTURNE_ADMIN_SESSION_SECRET || process.env.NOCTURNE_ADMIN_KEY || '';
}

function sign(value) {
  return createHmac('sha256', adminSecret()).update(value).digest('base64url');
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
  if (!adminSecret()) return false;
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

function allowedOrigin(req) {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  const allowed = new Set(['https://nocturnefestival.com', 'https://www.nocturnefestival.com']);
  try { allowed.add(new URL(req.url).origin); } catch {}
  for (const value of [process.env.NOCTURNE_SITE_URL, process.env.URL, process.env.DEPLOY_PRIME_URL]) {
    try { if (value) allowed.add(new URL(value).origin); } catch {}
  }
  return allowed.has(origin);
}

async function stripeGet(path) {
  const key = process.env.STRIPE_SECRET_KEY || '';
  if (!key) throw new Error('Stripe secret key is not configured.');
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${key}` }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `Stripe returned ${response.status}.`);
  return data;
}

async function stripeStatus() {
  const key = process.env.STRIPE_SECRET_KEY || '';
  const keyMode = key.startsWith('sk_live_') || key.startsWith('rk_live_')
    ? 'live'
    : key.startsWith('sk_test_') || key.startsWith('rk_test_')
      ? 'test'
      : key
        ? 'unknown'
        : 'missing';

  const priceCents = Number(process.env.NOCTURNE_TICKET_PRICE_CENTS || 0);
  const currency = String(process.env.NOCTURNE_TICKET_CURRENCY || 'usd').toLowerCase();
  const webhookSecretConfigured = Boolean(process.env.STRIPE_WEBHOOK_SECRET);
  const result = {
    configured: Boolean(key),
    keyMode,
    apiReachable: false,
    apiMode: null,
    webhookSecretConfigured,
    webhookEndpointConfigured: false,
    webhookEventsConfigured: false,
    priceCents: Number.isInteger(priceCents) ? priceCents : 0,
    currency,
    readyForLive: false,
    error: null
  };

  if (!key) return result;

  try {
    const [balance, endpoints] = await Promise.all([
      stripeGet('balance'),
      stripeGet('webhook_endpoints?limit=100')
    ]);

    result.apiReachable = true;
    result.apiMode = balance?.livemode === true ? 'live' : balance?.livemode === false ? 'test' : null;

    const expectedUrl = `${(process.env.NOCTURNE_SITE_URL || 'https://nocturnefestival.com').replace(/\/$/, '')}/api/stripe/webhook`;
    const endpoint = Array.isArray(endpoints?.data)
      ? endpoints.data.find((item) => item?.url === expectedUrl && item?.status !== 'disabled')
      : null;
    result.webhookEndpointConfigured = Boolean(endpoint);
    if (endpoint) {
      const events = Array.isArray(endpoint.enabled_events) ? endpoint.enabled_events : [];
      result.webhookEventsConfigured = events.includes('*') || [...REQUIRED_WEBHOOK_EVENTS].every((event) => events.includes(event));
    }

    result.readyForLive = result.apiMode === 'live'
      && result.webhookSecretConfigured
      && result.webhookEndpointConfigured
      && result.webhookEventsConfigured
      && result.priceCents >= 50;
  } catch (error) {
    result.error = String(error?.message || error).slice(0, 300);
  }

  return result;
}

async function emailStatus() {
  const configured = Boolean(process.env.RESEND_API_KEY && process.env.NOCTURNE_EMAIL_FROM);
  const from = String(process.env.NOCTURNE_EMAIL_FROM || '');
  const domainName = /@([^>\s]+)/.exec(from)?.[1]?.toLowerCase() || '';
  const result = { configured, domainName, domainFound: false, domainStatus: null, sendingEnabled: false, error: null };
  if (!configured || !domainName) return result;
  try {
    const response = await fetch('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || `Resend returned ${response.status}.`);
    const domain = Array.isArray(data.data) ? data.data.find((item) => String(item?.name || '').toLowerCase() === domainName) : null;
    result.domainFound = Boolean(domain);
    result.domainStatus = domain?.status || null;
    result.sendingEnabled = domain?.capabilities?.sending === 'enabled' || domain?.status === 'verified';
  } catch (error) {
    result.error = String(error?.message || error).slice(0, 300);
  }
  return result;
}

function operationsStatus() {
  const dedicatedSecrets = {
    adminSession: Boolean(process.env.NOCTURNE_ADMIN_SESSION_SECRET),
    checkinKey: Boolean(process.env.NOCTURNE_CHECKIN_KEY),
    checkinSession: Boolean(process.env.NOCTURNE_CHECKIN_SESSION_SECRET),
    barKey: Boolean(process.env.NOCTURNE_BAR_KEY),
    barSession: Boolean(process.env.NOCTURNE_BAR_SESSION_SECRET),
    ticketQr: Boolean(process.env.NOCTURNE_TICKET_QR_SECRET),
    ticketAccess: Boolean(process.env.NOCTURNE_TICKET_ACCESS_SECRET)
  };
  return {
    purchaseRemindersEnabled: String(process.env.NOCTURNE_PURCHASE_REMINDERS_ENABLED || '').toLowerCase() === 'true'
      && String(process.env.NOCTURNE_PURCHASE_REMINDERS_MODE || 'test').toLowerCase() === 'live',
    purchaseReminderSchedule: '10:00 AM HST daily',
    backupsEnabled: true,
    backupSchedule: '10:30 AM HST daily',
    backupRetentionDays: Math.max(7, Math.min(Number(process.env.NOCTURNE_BACKUP_RETENTION_DAYS || 30), 365)),
    opsAlertsConfigured: Boolean((process.env.NOCTURNE_OPS_ALERT_TO || process.env.NOCTURNE_APPLICATION_NOTIFY_TO) && process.env.RESEND_API_KEY && process.env.NOCTURNE_EMAIL_FROM),
    appleWallet: appleWalletStatus(),
    dedicatedSecrets,
    dedicatedSecretsReady: Object.values(dedicatedSecrets).every(Boolean)
  };
}

function withoutInviteFields(review = {}) {
  const next = { ...review };
  for (const field of [
    'inviteGeneratedAt',
    'inviteExpiresAt',
    'inviteHash',
    'inviteState',
    'inviteRevokedAt',
    'inviteRedeemedAt',
    'inviteEmailSentAt',
    'inviteEmailMessageId',
    'inviteEmailError',
    'redemptionConfirmationStatus',
    'redemptionConfirmationAttemptedAt',
    'redemptionConfirmationSentAt',
    'redemptionConfirmationMessageId',
    'redemptionConfirmationError'
  ]) delete next[field];
  next.updatedAt = new Date().toISOString();
  return next;
}

async function deleteStoreEntries(storeName) {
  const store = getStore({ name: storeName, consistency: 'strong' });
  const { blobs } = await store.list();
  let deleted = 0;
  for (const { key } of blobs) {
    await store.delete(key);
    deleted += 1;
  }
  return deleted;
}

async function clearInvitations() {
  const inviteStore = getStore({ name: INVITE_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const [{ blobs: inviteBlobs }, { blobs: reviewBlobs }] = await Promise.all([
    inviteStore.list(),
    reviewStore.list()
  ]);

  let deletedInviteBlobs = 0;
  for (const { key } of inviteBlobs) {
    await inviteStore.delete(key);
    deletedInviteBlobs += 1;
  }

  let reviewsReset = 0;
  for (const { key } of reviewBlobs) {
    const review = await reviewStore.get(key, { type: 'json', consistency: 'strong' });
    if (!review) continue;
    const hasInviteData = Boolean(
      review.inviteHash
      || review.inviteState
      || review.inviteGeneratedAt
      || review.inviteRedeemedAt
      || review.inviteRevokedAt
      || review.redemptionConfirmationStatus
    );
    if (!hasInviteData) continue;
    await reviewStore.setJSON(key, withoutInviteFields(review));
    reviewsReset += 1;
  }

  return { deletedInviteBlobs, reviewsReset };
}

async function clearAllTestData() {
  // Delete dependent records first, then applications last. We intentionally use
  // individual delete() operations because the site's runtime previously rejected
  // deleteAll() for these site-wide stores with a 403.
  const deletedInvites = await deleteStoreEntries(INVITE_STORE);
  const deletedOrders = await deleteStoreEntries(ORDER_STORE);
  const deletedStripeEvents = await deleteStoreEntries(STRIPE_EVENT_STORE);
  const deletedEmailEvents = await deleteStoreEntries(EMAIL_EVENT_STORE);
  const deletedDrinkRedemptions = await deleteStoreEntries(DRINK_REDEMPTION_STORE);
  const deletedReviews = await deleteStoreEntries(REVIEW_STORE);
  const deletedApplications = await deleteStoreEntries(APPLICATION_STORE);

  return {
    deletedApplications,
    deletedReviews,
    deletedInvites,
    deletedOrders,
    deletedStripeEvents,
    deletedEmailEvents,
    deletedDrinkRedemptions,
    totalDeleted: deletedApplications + deletedReviews + deletedInvites + deletedOrders + deletedStripeEvents + deletedEmailEvents + deletedDrinkRedemptions
  };
}

export default async (req) => {
  if (!authenticated(req)) return json({ error: 'Unauthorized.' }, 401);

  if (req.method === 'GET') {
    const [stripe, email] = await Promise.all([stripeStatus(), emailStatus()]);
    return json({ stripe, email, operations: operationsStatus() });
  }

  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  if (!allowedOrigin(req)) return json({ error: 'Origin not allowed.' }, 403);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid request.' }, 400); }

  try {
    if (body?.action === 'clear-invitations') {
      if (String(body?.confirm || '') !== 'CLEAR INVITATIONS') {
        return json({ error: 'Confirmation phrase did not match.' }, 400);
      }
      const result = await clearInvitations();
      return json({ ok: true, action: 'clear-invitations', ...result });
    }

    if (body?.action === 'clear-all-test-data') {
      if (String(body?.confirm || '') !== 'CLEAR ALL TEST DATA') {
        return json({ error: 'Confirmation phrase did not match.' }, 400);
      }
      const result = await clearAllTestData();
      return json({ ok: true, action: 'clear-all-test-data', ...result });
    }

    return json({ error: 'Unknown action.' }, 400);
  } catch (error) {
    console.error('NOCTURNE launch cleanup failed:', error);
    return json({ error: error?.message || 'Launch cleanup failed.' }, 500);
  }
};
