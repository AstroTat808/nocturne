import { getStore } from '@netlify/blobs';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { writeAudit } from './_audit.mjs';

const APPLICATION_STORE = 'nocturne-applications';
const REVIEW_STORE = 'nocturne-application-reviews';
const INVITE_STORE = 'nocturne-invites';
const ORDER_STORE = 'nocturne-ticket-orders';
const REDEMPTION_STORE = 'nocturne-drink-redemptions';
const SESSION_COOKIE = 'nocturne_admin';
const FORCE_PHRASE = 'REVOKE AND DELETE';

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

async function safeGet(store, key) {
  try {
    return await store.get(key, { type: 'json', consistency: 'strong' });
  } catch {
    return null;
  }
}

async function safeGetWithMetadata(store, key) {
  try {
    return await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
  } catch {
    return null;
  }
}

function hasTicketActivity(review, summary) {
  const state = String(review?.ticketState || '').toLowerCase();
  const status = String(summary?.status || '').toLowerCase();
  if (state && state !== 'none') return true;
  if (status && status !== 'none') return true;
  return Boolean(
    review?.ticketId
    || review?.stripeCheckoutSessionId
    || review?.stripePaymentIntentId
    || review?.stripeRefundId
    || review?.drinkPackageCheckoutSessionId
    || review?.drinkPackagePaymentIntentId
    || review?.drinkPackageRefundId
    || review?.waterPackageCheckoutSessionId
    || review?.waterPackagePaymentIntentId
    || review?.lateStayCheckoutSessionId
    || review?.lateStayPaymentIntentId
    || summary?.ticketId
    || summary?.stripeCheckoutSessionId
    || summary?.stripePaymentIntentId
    || summary?.stripeRefundId
    || summary?.drinkPackageCheckoutSessionId
    || summary?.drinkPackagePaymentIntentId
    || summary?.drinkPackageRefundId
    || summary?.waterPackageCheckoutSessionId
    || summary?.waterPackagePaymentIntentId
    || summary?.lateStayCheckoutSessionId
    || summary?.lateStayPaymentIntentId
    || summary?.checkedInAt
    || summary?.paidAt
    || summary?.refundedAt
  );
}

function ticketSource(review, summary) {
  return String(summary?.ticketSource || review?.ticketSource || '').toLowerCase();
}

function hasStripeActivity(review, summary) {
  return Boolean(
    review?.stripeCheckoutSessionId
    || review?.stripePaymentIntentId
    || review?.stripeRefundId
    || review?.drinkPackageCheckoutSessionId
    || review?.drinkPackagePaymentIntentId
    || review?.drinkPackageRefundId
    || review?.waterPackageCheckoutSessionId
    || review?.waterPackagePaymentIntentId
    || review?.lateStayCheckoutSessionId
    || review?.lateStayPaymentIntentId
    || summary?.stripeCheckoutSessionId
    || summary?.stripePaymentIntentId
    || summary?.stripeRefundId
    || summary?.drinkPackageCheckoutSessionId
    || summary?.drinkPackagePaymentIntentId
    || summary?.drinkPackageRefundId
    || summary?.waterPackageCheckoutSessionId
    || summary?.waterPackagePaymentIntentId
    || summary?.lateStayCheckoutSessionId
    || summary?.lateStayPaymentIntentId
  );
}

function isCheckedIn(review, summary) {
  return Boolean(
    review?.checkedInAt
    || summary?.checkedInAt
    || String(review?.ticketState || '').toLowerCase() === 'checked_in'
    || String(summary?.status || '').toLowerCase() === 'checked_in'
  );
}

function isActiveDeletableComp(review, summary) {
  if (ticketSource(review, summary) !== 'comp') return false;
  if (hasStripeActivity(review, summary) || isCheckedIn(review, summary)) return false;

  const state = String(review?.ticketState || '').toLowerCase();
  const status = String(summary?.status || '').toLowerCase();
  return state === 'paid' || status === 'paid';
}

function emailHash(value) {
  return createHash('sha256').update(String(value || '').trim().toLowerCase()).digest('hex');
}

function financialTombstone(record, submissionId, revokedAt) {
  if (!record) return null;
  const drinkPurchased = Boolean(record.drinkPackagePurchased || record.drinkPackageRequested);
  const waterPurchased = Boolean(record.waterPackagePurchased || record.waterPackageRequested);
  const lateStayPurchased = Boolean(record.lateStayPurchased || record.lateStayRequested);
  return {
    submissionId,
    status: 'revoked',
    revocationReason: 'admin_force_delete',
    revokedAt,
    updatedAt: revokedAt,
    deletedApplicant: true,
    ticketId: record.ticketId || null,
    ticketSource: record.ticketSource || null,
    amountTotal: Number.isFinite(Number(record.amountTotal)) ? Number(record.amountTotal) : null,
    ticketAmount: Number.isFinite(Number(record.ticketAmount)) ? Number(record.ticketAmount) : null,
    currency: record.currency || process.env.NOCTURNE_TICKET_CURRENCY || 'usd',
    stripeCheckoutSessionId: record.stripeCheckoutSessionId || null,
    stripePaymentIntentId: record.stripePaymentIntentId || null,
    stripeRefundId: record.stripeRefundId || null,
    refundStatus: record.refundStatus || null,
    paidAt: record.paidAt || null,
    refundedAt: record.refundedAt || null,
    disputedAt: record.disputedAt || null,
    disputeStatus: record.disputeStatus || null,
    checkedInAt: record.checkedInAt || null,
    drinkPackagePurchased: drinkPurchased,
    drinkPackageStatus: drinkPurchased ? 'revoked' : 'none',
    drinkPackagePriceCents: Number(record.drinkPackagePriceCents || 0),
    drinkCreditsPurchased: Number(record.drinkCreditsPurchased || 0),
    drinkCreditsRedeemed: Number(record.drinkCreditsRedeemed || 0),
    drinkCreditsRemaining: 0,
    drinkPackageCheckoutSessionId: record.drinkPackageCheckoutSessionId || null,
    drinkPackagePaymentIntentId: record.drinkPackagePaymentIntentId || null,
    drinkPackageRefundId: record.drinkPackageRefundId || null,
    drinkPackagePaidAt: record.drinkPackagePaidAt || null,
    drinkPackageInvalidatedAt: drinkPurchased ? revokedAt : null,
    drinkPackageInvalidationReason: drinkPurchased ? 'admin_force_delete' : null,
    waterPackagePurchased: waterPurchased,
    waterPackageStatus: waterPurchased ? 'revoked' : 'none',
    waterPackagePriceCents: Number(record.waterPackagePriceCents || 0),
    waterPackageCheckoutSessionId: record.waterPackageCheckoutSessionId || null,
    waterPackagePaymentIntentId: record.waterPackagePaymentIntentId || null,
    waterPackagePaidAt: record.waterPackagePaidAt || null,
    waterPackageInvalidatedAt: waterPurchased ? revokedAt : null,
    waterPackageInvalidationReason: waterPurchased ? 'admin_force_delete' : null,
    lateStayPurchased,
    lateStayStatus: lateStayPurchased ? 'revoked' : 'none',
    lateStayPriceCents: Number(record.lateStayPriceCents || 0),
    lateStayPurchaseType: record.lateStayPurchaseType || null,
    lateStayCheckoutSessionId: record.lateStayCheckoutSessionId || null,
    lateStayPaymentIntentId: record.lateStayPaymentIntentId || null,
    lateStayPaidAt: record.lateStayPaidAt || null,
    lateStaySlot: record.lateStaySlot || null,
    lateStayDepartureTime: record.lateStayDepartureTime || null,
    lateStayInvalidatedAt: lateStayPurchased ? revokedAt : null,
    lateStayInvalidationReason: lateStayPurchased ? 'admin_force_delete' : null
  };
}

async function revokeOrderRecord(orderStore, key, submissionId, revokedAt) {
  if (!key) return false;
  const record = await safeGet(orderStore, key);
  if (!record) return false;
  await orderStore.setJSON(key, financialTombstone(record, submissionId, revokedAt));
  return true;
}

async function forceRevokeAndDelete({ applicationStore, reviewStore, inviteStore, orderStore, redemptionStore, submissionId, application, review, summary }) {
  const revokedAt = new Date().toISOString();
  const sessionKeys = new Set([
    summary?.stripeCheckoutSessionId,
    summary?.drinkPackageCheckoutSessionId,
    summary?.waterPackageCheckoutSessionId,
    summary?.lateStayCheckoutSessionId,
    review?.stripeCheckoutSessionId,
    review?.drinkPackageCheckoutSessionId,
    review?.waterPackageCheckoutSessionId,
    review?.lateStayCheckoutSessionId
  ].filter(Boolean).map(String));

  for (const key of sessionKeys) {
    await revokeOrderRecord(orderStore, key, submissionId, revokedAt);
  }

  if (summary) {
    await orderStore.setJSON(`submission-${submissionId}`, financialTombstone(summary, submissionId, revokedAt));
  } else if (hasTicketActivity(review, summary)) {
    await orderStore.setJSON(`submission-${submissionId}`, financialTombstone(review, submissionId, revokedAt));
  }

  if (summary?.drinkPackageWristbandHash) {
    await redemptionStore.delete(`wristband-${summary.drinkPackageWristbandHash}`).catch(() => {});
  }

  await orderStore.delete(`checkout-attempt-${submissionId}`).catch(() => {});
  await orderStore.delete(`late-stay-checkout-attempt-${submissionId}`).catch(() => {});
  if (review?.inviteHash) await inviteStore.delete(String(review.inviteHash)).catch(() => {});
  await reviewStore.delete(submissionId);
  await applicationStore.delete(submissionId);

  await writeAudit('application.force_deleted', {
    submissionId,
    applicantEmailHash: emailHash(application?.email),
    ticketId: summary?.ticketId || review?.ticketId || null,
    ticketWasCheckedIn: isCheckedIn(review, summary),
    financialRecordRetained: Boolean(summary || hasTicketActivity(review, summary)),
    inviteRevoked: Boolean(review?.inviteHash),
    drinkPackageRevoked: Boolean(summary?.drinkPackagePurchased || review?.drinkPackagePurchased),
    waterPackageRevoked: Boolean(summary?.waterPackagePurchased || review?.waterPackagePurchased),
    lateStayRevoked: Boolean(summary?.lateStayPurchased || review?.lateStayPurchased),
    revokedAt
  });

  return {
    ok: true,
    forced: true,
    deletedId: submissionId,
    deletedEmail: String(application?.email || '').trim().toLowerCase(),
    ticketRevoked: Boolean(summary?.ticketId || review?.ticketId || hasTicketActivity(review, summary)),
    ticketWasCheckedIn: isCheckedIn(review, summary),
    inviteRevoked: Boolean(review?.inviteHash),
    financialRecordRetained: Boolean(summary || hasTicketActivity(review, summary))
  };
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  if (!authenticated(req)) return json({ error: 'Unauthorized.' }, 401);
  if (!allowedOrigin(req)) return json({ error: 'Origin not allowed.' }, 403);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid request.' }, 400); }

  const submissionId = String(body?.submissionId || '').trim();
  const confirmEmail = String(body?.confirmEmail || '').trim().toLowerCase();
  const force = body?.force === true;
  const confirmAction = String(body?.confirmAction || '').trim().toUpperCase();
  if (!submissionId || submissionId.length > 180 || submissionId.includes('..')) {
    return json({ error: 'Invalid applicant ID.' }, 400);
  }
  if (force && confirmAction !== FORCE_PHRASE) {
    return json({ error: `Force deletion requires the confirmation phrase ${FORCE_PHRASE}.` }, 400);
  }

  const applicationStore = getStore({ name: APPLICATION_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const inviteStore = getStore({ name: INVITE_STORE, consistency: 'strong' });
  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const redemptionStore = getStore({ name: REDEMPTION_STORE, consistency: 'strong' });

  try {
    const [application, review, summaryEntry] = await Promise.all([
      safeGet(applicationStore, submissionId),
      safeGet(reviewStore, submissionId),
      safeGetWithMetadata(orderStore, `submission-${submissionId}`)
    ]);
    const summary = summaryEntry?.data || null;

    if (!application) return json({ error: 'Applicant not found.' }, 404);
    const email = String(application.email || '').trim().toLowerCase();
    if (!email || confirmEmail !== email) {
      return json({ error: 'Email confirmation did not match this applicant.' }, 400);
    }

    if (force) {
      const result = await forceRevokeAndDelete({ applicationStore, reviewStore, inviteStore, orderStore, redemptionStore, submissionId, application, review, summary });
      return json(result);
    }

    const compTicket = isActiveDeletableComp(review, summary);
    if (ticketSource(review, summary) === 'comp' && isCheckedIn(review, summary)) {
      return json({
        error: 'This complimentary ticket has already been checked in. Use Force Revoke & Delete if you intentionally want to invalidate it and remove the applicant.'
      }, 409);
    }

    if (hasTicketActivity(review, summary) && !compTicket) {
      return json({
        error: 'This applicant has ticket or payment activity. Use Force Revoke & Delete only when you intentionally want to invalidate the ticket while retaining a minimal accounting record.'
      }, 409);
    }

    if (compTicket) {
      if (summary) {
        const revokedAt = new Date().toISOString();
        const write = await orderStore.setJSON(`submission-${submissionId}`, {
          ...summary,
          status: 'revoked',
          revokedAt,
          updatedAt: revokedAt
        }, { onlyIfMatch: summaryEntry.etag });

        if (!write.modified) {
          const latest = await safeGet(orderStore, `submission-${submissionId}`);
          if (isCheckedIn(review, latest)) {
            return json({
              error: 'This complimentary ticket was checked in while deletion was being confirmed. Its admission record was preserved.'
            }, 409);
          }
          return json({ error: 'The complimentary ticket changed while deletion was being confirmed. Refresh and try again.' }, 409);
        }
      }
      await orderStore.delete(`submission-${submissionId}`);
    }

    if (review?.inviteHash) {
      await inviteStore.delete(String(review.inviteHash));
    }

    await reviewStore.delete(submissionId);
    await applicationStore.delete(submissionId);
    if (!compTicket) await orderStore.delete(`submission-${submissionId}`);

    await writeAudit('application.deleted', {
      submissionId,
      applicantEmailHash: emailHash(email),
      inviteRevoked: Boolean(review?.inviteHash),
      compTicketRevoked: compTicket
    });

    return json({
      ok: true,
      deletedId: submissionId,
      deletedEmail: email,
      inviteRevoked: Boolean(review?.inviteHash),
      compTicketRevoked: compTicket
    });
  } catch (error) {
    console.error('NOCTURNE applicant deletion failed:', error);
    return json({ error: error?.message || 'Applicant deletion failed.' }, 500);
  }
};
