import { getStore } from '@netlify/blobs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { appleWalletStatus } from './_apple-wallet.mjs';
import { drinkPackageConfig } from './_drink-package.mjs';
import { waterPackageConfig } from './_water-package.mjs';

const APPLICATION_STORE = 'nocturne-applications';
const REVIEW_STORE = 'nocturne-application-reviews';
const INVITE_STORE = 'nocturne-invites';
const ORDER_STORE = 'nocturne-ticket-orders';
const STRIPE_EVENT_STORE = 'nocturne-stripe-events';
const EMAIL_EVENT_STORE = 'nocturne-email-events';
const DRINK_REDEMPTION_STORE = 'nocturne-drink-redemptions';
const BACKUP_STORE = 'nocturne-backups';
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

function liveAdmissionSession(session, priceCents) {
  const purchaseType = String(session?.metadata?.purchaseType || '').trim().toLowerCase();
  return Boolean(
    session?.livemode === true
    && session?.status === 'complete'
    && session?.payment_status === 'paid'
    && String(session?.metadata?.event || '').trim().toUpperCase() === 'NOCTURNE'
    && !['drink-package-addon', 'water-package-addon'].includes(purchaseType)
    && Number(session?.amount_total || 0) >= Math.max(50, Number(priceCents || 0))
  );
}

async function latestLiveAdmissionPayment(priceCents) {
  const result = { verified: false, payment: null, error: null };
  try {
    const sessions = await stripeGet('checkout/sessions?limit=100&status=complete');
    const matches = Array.isArray(sessions?.data)
      ? sessions.data.filter((session) => liveAdmissionSession(session, priceCents))
      : [];
    matches.sort((a, b) => Number(b?.created || 0) - Number(a?.created || 0));
    const session = matches[0] || null;
    if (!session) return result;
    result.verified = true;
    result.payment = {
      submissionId: String(session?.metadata?.submissionId || session?.client_reference_id || '').trim() || null,
      stripeCheckoutSessionId: session.id || null,
      stripePaymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id || null,
      amountTotal: Number(session.amount_total || 0),
      currency: String(session.currency || process.env.NOCTURNE_TICKET_CURRENCY || 'usd').toLowerCase(),
      receivedAt: Number(session.created) > 0 ? new Date(Number(session.created) * 1000).toISOString() : null,
      drinkPackageIncluded: String(session?.metadata?.drinkPackage || '') === 'six-credit',
      waterPackageIncluded: String(session?.metadata?.waterPackage || '') === 'unlimited'
    };
  } catch (error) {
    result.error = String(error?.message || error).slice(0, 300);
  }
  return result;
}

async function fulfillmentStatus(payment) {
  const result = { verified: false, ticketId: null, paidAt: null, currentStatus: null, error: null };
  if (!payment?.submissionId || !payment?.stripeCheckoutSessionId) {
    result.error = 'Live payment did not include a NOCTURNE submission identity.';
    return result;
  }
  try {
    const store = getStore({ name: ORDER_STORE, consistency: 'strong' });
    const summary = await store.get(`submission-${payment.submissionId}`, { type: 'json', consistency: 'strong' });
    if (!summary) {
      result.error = 'No NOCTURNE ticket summary exists for the successful live Stripe checkout.';
      return result;
    }
    result.ticketId = summary.ticketId || null;
    result.paidAt = summary.paidAt || null;
    result.currentStatus = summary.status || null;
    const checkoutMatches = String(summary.stripeCheckoutSessionId || '') === String(payment.stripeCheckoutSessionId);
    const paymentIntentMatches = !payment.stripePaymentIntentId
      || !summary.stripePaymentIntentId
      || String(summary.stripePaymentIntentId) === String(payment.stripePaymentIntentId);
    result.verified = Boolean(checkoutMatches && paymentIntentMatches && summary.ticketId && summary.paidAt);
    if (!result.verified) result.error = 'Stripe payment exists, but the matching NOCTURNE ticket fulfillment record is incomplete or mismatched.';
  } catch (error) {
    result.error = String(error?.message || error).slice(0, 300);
  }
  return result;
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
    configurationReady: false,
    livePaymentVerified: false,
    livePayment: null,
    livePaymentCheckError: null,
    fulfillmentVerified: false,
    fulfillment: null,
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

    result.configurationReady = result.apiMode === 'live'
      && result.webhookSecretConfigured
      && result.webhookEndpointConfigured
      && result.webhookEventsConfigured
      && result.priceCents >= 50;

    if (result.apiMode === 'live') {
      const evidence = await latestLiveAdmissionPayment(result.priceCents);
      result.livePaymentVerified = evidence.verified;
      result.livePayment = evidence.payment;
      result.livePaymentCheckError = evidence.error;
      if (evidence.verified) {
        result.fulfillment = await fulfillmentStatus(evidence.payment);
        result.fulfillmentVerified = Boolean(result.fulfillment?.verified);
      }
    }

    result.readyForLive = result.configurationReady && result.livePaymentVerified && result.fulfillmentVerified;
  } catch (error) {
    result.error = String(error?.message || error).slice(0, 300);
  }

  return result;
}

async function emailStatus() {
  const configured = Boolean(process.env.RESEND_API_KEY && process.env.NOCTURNE_EMAIL_FROM);
  const from = String(process.env.NOCTURNE_EMAIL_FROM || '').trim();
  const domainName = /@([^>\s]+)/.exec(from)?.[1]?.toLowerCase() || '';
  const result = {
    configured,
    operational: false,
    restrictedSendOnlyKey: false,
    fromAddress: from,
    domainName,
    domainFound: false,
    domainStatus: null,
    sendingCapability: null,
    receivingCapability: null,
    region: null,
    sendingEnabled: false,
    diagnostic: null,
    error: null
  };

  if (!configured) {
    result.diagnostic = 'RESEND_API_KEY and/or NOCTURNE_EMAIL_FROM is not configured.';
    return result;
  }
  if (!domainName) {
    result.diagnostic = 'NOCTURNE_EMAIL_FROM does not contain a valid sending domain.';
    return result;
  }

  try {
    const response = await fetch('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || `Resend returned ${response.status}.`);
    const domain = Array.isArray(data.data) ? data.data.find((item) => String(item?.name || '').toLowerCase() === domainName) : null;
    result.domainFound = Boolean(domain);
    if (!domain) {
      result.diagnostic = `Resend API: domain ${domainName} was not found in this account.`;
      return result;
    }

    result.domainStatus = domain?.status || null;
    result.sendingCapability = domain?.capabilities?.sending || null;
    result.receivingCapability = domain?.capabilities?.receiving || null;
    result.region = domain?.region || null;
    result.sendingEnabled = result.sendingCapability === 'enabled' || result.domainStatus === 'verified';
    result.operational = result.sendingEnabled;
    result.diagnostic = [
      `Domain ${domainName}`,
      `status: ${result.domainStatus || 'not reported'}`,
      `sending: ${result.sendingCapability || 'not reported'}`,
      result.region ? `region: ${result.region}` : null
    ].filter(Boolean).join(' · ');
  } catch (error) {
    result.error = String(error?.message || error).slice(0, 300);
    result.restrictedSendOnlyKey = /restricted to only send emails/i.test(result.error);
    result.operational = configured && result.restrictedSendOnlyKey;
    result.diagnostic = result.restrictedSendOnlyKey
      ? `Send-only Resend API key accepted for ${domainName}; domain-management lookup is intentionally unavailable.`
      : `Resend API error: ${result.error}`;
  }
  return result;
}

function inviteRemindersEnabled() {
  const enabled = process.env.NOCTURNE_INVITE_REMINDERS_ENABLED ?? process.env.NOCTURNE_PURCHASE_REMINDERS_ENABLED ?? '';
  const mode = process.env.NOCTURNE_INVITE_REMINDERS_MODE ?? process.env.NOCTURNE_PURCHASE_REMINDERS_MODE ?? 'test';
  return String(enabled).toLowerCase() === 'true' && String(mode).toLowerCase() === 'live';
}

function operationsStatus() {
  const drink = drinkPackageConfig();
  const water = waterPackageConfig();
  const dedicatedSecrets = {
    adminSession: Boolean(process.env.NOCTURNE_ADMIN_SESSION_SECRET),
    checkinKey: Boolean(process.env.NOCTURNE_CHECKIN_KEY),
    checkinSession: Boolean(process.env.NOCTURNE_CHECKIN_SESSION_SECRET),
    barKey: Boolean(process.env.NOCTURNE_BAR_KEY),
    barSession: Boolean(process.env.NOCTURNE_BAR_SESSION_SECRET),
    ticketQr: Boolean(process.env.NOCTURNE_TICKET_QR_SECRET),
    ticketAccess: Boolean(process.env.NOCTURNE_TICKET_ACCESS_SECRET)
  };
  const turnstile = {
    siteKeyConfigured: Boolean(process.env.NOCTURNE_TURNSTILE_SITE_KEY),
    secretKeyConfigured: Boolean(process.env.NOCTURNE_TURNSTILE_SECRET_KEY)
  };
  turnstile.ready = turnstile.siteKeyConfigured && turnstile.secretKeyConfigured;
  const venue = {
    nameConfigured: Boolean(process.env.NOCTURNE_VENUE_NAME),
    addressConfigured: Boolean(process.env.NOCTURNE_VENUE_ADDRESS)
  };
  venue.ready = venue.nameConfigured && venue.addressConfigured;
  const ticketing = {
    signingReady: dedicatedSecrets.ticketQr && dedicatedSecrets.ticketAccess,
    gateReady: dedicatedSecrets.checkinKey && dedicatedSecrets.checkinSession,
    barReady: dedicatedSecrets.barKey && dedicatedSecrets.barSession,
    adminSessionReady: dedicatedSecrets.adminSession
  };
  const packages = {
    drink: {
      enabled: drink.enabled,
      priceCents: drink.priceCents,
      credits: drink.credits,
      premiumUpgradeCents: drink.premiumUpgradeCents,
      expected: drink.enabled && drink.priceCents === 5500 && drink.credits === 6 && drink.premiumUpgradeCents === 500
    },
    water: {
      enabled: water.enabled,
      priceCents: water.priceCents,
      expected: water.enabled && water.priceCents === 1500
    }
  };
  packages.ready = packages.drink.expected && packages.water.expected;
  return {
    turnstile,
    venue,
    ticketing,
    packages,
    inviteRemindersEnabled: inviteRemindersEnabled(),
    inviteReminderSchedule: '9:00 AM HST daily',
    purchaseRemindersEnabled: String(process.env.NOCTURNE_PURCHASE_REMINDERS_ENABLED || '').toLowerCase() === 'true'
      && String(process.env.NOCTURNE_PURCHASE_REMINDERS_MODE || 'test').toLowerCase() === 'live',
    purchaseReminderSchedule: '10:00 AM HST daily',
    backupSchedule: '10:30 AM HST daily',
    backupRetentionDays: Math.max(7, Math.min(Number(process.env.NOCTURNE_BACKUP_RETENTION_DAYS || 30), 365)),
    opsAlertsConfigured: Boolean((process.env.NOCTURNE_OPS_ALERT_TO || process.env.NOCTURNE_APPLICATION_NOTIFY_TO) && process.env.RESEND_API_KEY && process.env.NOCTURNE_EMAIL_FROM),
    appleWallet: appleWalletStatus(),
    appleWalletLaunchBlocking: false,
    dedicatedSecrets,
    dedicatedSecretsReady: Object.values(dedicatedSecrets).every(Boolean)
  };
}

async function backupStatus(retentionDays) {
  const result = {
    healthy: false,
    latestKey: null,
    lastSuccessfulAt: null,
    ageHours: null,
    recordCount: null,
    retentionDays,
    error: null
  };
  try {
    const store = getStore({ name: BACKUP_STORE, consistency: 'strong' });
    const { blobs } = await store.list();
    const latest = blobs
      .filter(({ key }) => /^daily-\d{4}-\d{2}-\d{2}$/.test(String(key)))
      .sort((a, b) => String(b.key).localeCompare(String(a.key)))[0];
    if (!latest) {
      result.error = 'No completed daily backup exists yet.';
      return result;
    }
    const record = await store.get(latest.key, { type: 'json', consistency: 'strong' });
    result.latestKey = latest.key;
    result.lastSuccessfulAt = record?.createdAt || null;
    result.recordCount = record?.counts
      ? Object.values(record.counts).reduce((sum, count) => sum + Number(count || 0), 0)
      : null;
    const created = new Date(result.lastSuccessfulAt || 0).getTime();
    if (Number.isFinite(created) && created > 0) {
      result.ageHours = Math.round(((Date.now() - created) / 3600000) * 10) / 10;
      result.healthy = result.ageHours <= 36;
    }
    if (!result.healthy && !result.error) result.error = 'The most recent successful backup is older than 36 hours.';
  } catch (error) {
    result.error = String(error?.message || error).slice(0, 300);
  }
  return result;
}

function coreReadiness(stripe, email, operations, backup) {
  const blockers = [];
  if (!stripe.configurationReady) blockers.push('Stripe live configuration');
  if (!stripe.livePaymentVerified) blockers.push('successful live admission payment');
  if (!stripe.fulfillmentVerified) blockers.push('webhook ticket fulfillment evidence');
  if (!email.operational) blockers.push('email sending');
  if (!operations.turnstile.ready) blockers.push('application Turnstile protection');
  if (!operations.venue.ready) blockers.push('private venue runtime');
  if (!operations.ticketing.signingReady) blockers.push('digital ticket signing');
  if (!operations.ticketing.gateReady) blockers.push('gate scanner credentials');
  if (!operations.ticketing.barReady) blockers.push('bar console credentials');
  if (!operations.ticketing.adminSessionReady) blockers.push('admin session signing');
  if (!operations.packages.ready) blockers.push('drink/water package configuration');
  if (!operations.inviteRemindersEnabled) blockers.push('unredeemed invitation reminders');
  if (!operations.purchaseRemindersEnabled) blockers.push('ticket purchase reminders');
  if (!operations.dedicatedSecretsReady) blockers.push('dedicated secret separation');
  if (!backup.healthy) blockers.push('recent successful data backup');
  return { coreReady: blockers.length === 0, blockers };
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
    const operations = operationsStatus();
    const backup = await backupStatus(operations.backupRetentionDays);
    return json({ stripe, email, operations, backup, overall: coreReadiness(stripe, email, operations, backup) });
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
