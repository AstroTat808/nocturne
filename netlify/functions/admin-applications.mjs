import { getStore } from '@netlify/blobs';
import { createHmac, timingSafeEqual } from 'node:crypto';

const APPLICATION_STORE = 'nocturne-applications';
const REVIEW_STORE = 'nocturne-application-reviews';
const ORDER_STORE = 'nocturne-ticket-orders';
const SESSION_COOKIE = 'nocturne_admin';
const REVIEW_STATUSES = new Set(['pending', 'shortlist', 'approved', 'declined']);

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

function secret() {
  return process.env.NOCTURNE_ADMIN_SESSION_SECRET || process.env.NOCTURNE_ADMIN_KEY || '';
}

function sign(value) {
  return createHmac('sha256', secret()).update(value).digest('base64url');
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
  if (!secret()) return false;
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

async function safeGet(store, key) {
  try {
    return await store.get(key, { type: 'json', consistency: 'strong' });
  } catch (error) {
    console.error(`NOCTURNE admin data read failed for ${key}:`, error);
    return null;
  }
}

function ticketState(summary, order, review) {
  if (summary?.status === 'refunded' || order?.status === 'refunded' || review?.ticketState === 'refunded') return 'refunded';
  if (summary?.checkedInAt || order?.checkedInAt || review?.checkedInAt || review?.ticketState === 'checked_in') return 'checked_in';
  if (summary?.status === 'paid' || order?.status === 'paid' || review?.ticketState === 'paid') return 'paid';
  if (summary?.status === 'checkout_created' || order?.status === 'checkout_created') return 'checkout_created';
  return 'none';
}

function ticketRecord(summary, order, review) {
  const state = ticketState(summary, order, review);
  return {
    state,
    status: summary?.status || order?.status || null,
    ticketSource: summary?.ticketSource || order?.ticketSource || review?.ticketSource || null,
    ticketId: summary?.ticketId || order?.ticketId || review?.ticketId || null,
    amountTotal: order?.amountTotal ?? summary?.amountTotal ?? null,
    currency: order?.currency || summary?.currency || process.env.NOCTURNE_TICKET_CURRENCY || 'usd',
    stripeCheckoutSessionId: summary?.stripeCheckoutSessionId || order?.stripeCheckoutSessionId || review?.stripeCheckoutSessionId || null,
    stripePaymentIntentId: order?.stripePaymentIntentId || summary?.stripePaymentIntentId || review?.stripePaymentIntentId || null,
    stripeRefundId: summary?.stripeRefundId || order?.stripeRefundId || review?.stripeRefundId || null,
    refundStatus: summary?.refundStatus || order?.refundStatus || review?.refundStatus || null,
    paidAt: summary?.paidAt || order?.paidAt || review?.ticketPurchasedAt || null,
    refundedAt: summary?.refundedAt || order?.refundedAt || review?.ticketRefundedAt || null,
    checkedInAt: summary?.checkedInAt || order?.checkedInAt || review?.checkedInAt || null,
    customerEmail: order?.customerEmail || summary?.customerEmail || null,
    customerName: order?.customerName || summary?.customerName || null,
    digitalTicketUrl: summary?.digitalTicketUrl || order?.digitalTicketUrl || review?.digitalTicketUrl || null,
    ticketEmailStatus: summary?.ticketEmailStatus || order?.ticketEmailStatus || review?.ticketEmailStatus || null,
    ticketEmailSentAt: review?.ticketEmailSentAt || summary?.ticketEmailSentAt || null,
    ticketEmailMessageId: summary?.ticketEmailMessageId || order?.ticketEmailMessageId || review?.ticketEmailMessageId || null,
    ticketEmailError: summary?.ticketEmailError || order?.ticketEmailError || review?.ticketEmailError || null,
    refundEmailStatus: summary?.refundEmailStatus || order?.refundEmailStatus || review?.refundEmailStatus || null,
    refundEmailSentAt: review?.refundEmailSentAt || summary?.refundEmailSentAt || null
  };
}

function summarize(applications) {
  const stats = { total: applications.length, pending: 0, shortlist: 0, approved: 0, declined: 0 };
  for (const application of applications) {
    const status = REVIEW_STATUSES.has(application.review?.status) ? application.review.status : 'pending';
    stats[status] += 1;
  }
  return stats;
}

function summarizeTickets(applications) {
  const stats = {
    none: 0,
    checkout_created: 0,
    paid: 0,
    checked_in: 0,
    refunded: 0,
    collectedCents: 0,
    grossCents: 0,
    currency: String(process.env.NOCTURNE_TICKET_CURRENCY || 'usd').toLowerCase()
  };
  for (const application of applications) {
    const ticket = application.ticket || { state: 'none' };
    if (Object.prototype.hasOwnProperty.call(stats, ticket.state)) stats[ticket.state] += 1;
    const amount = Number(ticket.amountTotal || 0);
    if (Number.isFinite(amount) && amount > 0 && ['paid', 'checked_in', 'refunded'].includes(ticket.state)) stats.grossCents += amount;
    if (Number.isFinite(amount) && amount > 0 && ['paid', 'checked_in'].includes(ticket.state)) stats.collectedCents += amount;
  }
  return stats;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function loadApplications() {
  const applicationStore = getStore({ name: APPLICATION_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const { blobs } = await applicationStore.list();

  const applications = await mapLimit(blobs, 8, async ({ key }) => {
    const [application, review, summary] = await Promise.all([
      safeGet(applicationStore, key),
      safeGet(reviewStore, key),
      safeGet(orderStore, `submission-${key}`)
    ]);
    if (!application) return null;

    let order = null;
    if (summary?.stripeCheckoutSessionId) {
      order = await safeGet(orderStore, summary.stripeCheckoutSessionId);
    }

    return {
      id: application.id || key,
      number: null,
      createdAt: application.createdAt,
      fullName: application.fullName || '',
      preferredName: application.preferredName || '',
      email: application.email || '',
      phone: application.phone || '',
      location: application.location || '',
      instagram: application.instagram || '',
      referral: application.referral || '',
      community: application.community || '',
      whyNocturne: application.whyNocturne || '',
      groupNames: application.groupNames || '',
      conductAck: Boolean(application.conductAck),
      selectionAck: Boolean(application.selectionAck),
      privacyAck: Boolean(application.privacyAck),
      marketingOptIn: Boolean(application.marketingOptIn),
      ticket: ticketRecord(summary, order, review),
      review: review || {
        status: 'pending',
        score: null,
        notes: '',
        updatedAt: null,
        inviteGeneratedAt: null,
        inviteState: null
      }
    };
  });

  const filtered = applications.filter(Boolean);
  filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return filtered;
}

export default async (req) => {
  if (req.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
  if (!authenticated(req)) return json({ error: 'Unauthorized.' }, 401);

  try {
    const applications = await loadApplications();
    return json({
      applications,
      formSubmissionCount: applications.length,
      stats: summarize(applications),
      ticketStats: summarizeTickets(applications),
      capabilities: {
        emailConfigured: Boolean(process.env.RESEND_API_KEY && process.env.NOCTURNE_EMAIL_FROM),
        refundConfigured: Boolean(process.env.STRIPE_SECRET_KEY)
      }
    });
  } catch (error) {
    console.error('NOCTURNE dedicated admin application load failed:', error);
    return json({ error: error?.message || 'Could not load applications.' }, 502);
  }
};
