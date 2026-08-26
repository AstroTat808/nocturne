import { getStore } from '@netlify/blobs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { writeAudit } from './_audit.mjs';
import { sendOpsAlert } from './_ops-alert.mjs';

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

function sessionSecret() {
  return process.env.NOCTURNE_ADMIN_SESSION_SECRET || process.env.NOCTURNE_ADMIN_KEY || '';
}

function constantTimeEqual(a = '', b = '') {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function sign(value) {
  return createHmac('sha256', sessionSecret()).update(value).digest('base64url');
}

function parseCookies(req) {
  const header = req.headers.get('cookie') || '';
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => {
        const index = part.indexOf('=');
        if (index < 0) return ['', ''];
        let value = part.slice(index + 1).trim();
        try { value = decodeURIComponent(value); } catch {}
        return [part.slice(0, index).trim(), value];
      })
      .filter(([key]) => key)
  );
}

function hasValidSession(req) {
  if (!sessionSecret()) return false;
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token || !token.includes('.')) return false;
  const [payload, signature] = token.split('.', 2);
  if (!constantTimeEqual(signature, sign(payload))) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return parsed.role === 'admin' && Number(parsed.exp) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function allowedPostOrigin(req) {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  const allowed = new Set(['https://nocturnefestival.com', 'https://www.nocturnefestival.com']);
  try { allowed.add(new URL(req.url).origin); } catch {}
  for (const value of [process.env.NOCTURNE_SITE_URL, process.env.URL, process.env.DEPLOY_PRIME_URL]) {
    if (!value) continue;
    try { allowed.add(new URL(value).origin); } catch {}
  }
  return allowed.has(origin);
}

function validSubmissionId(value) {
  return /^[A-Za-z0-9_-]{6,128}$/.test(String(value || ''));
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function readBody(req) {
  try { return await req.json(); } catch { return null; }
}

async function createStripeRefund(paymentIntentId, submissionId, role) {
  const response = await fetch('https://api.stripe.com/v1/refunds', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': `nocturne-admin-refund-${submissionId}-${role}`.slice(0, 250)
    },
    body: new URLSearchParams({
      payment_intent: paymentIntentId,
      reason: 'requested_by_customer',
      'metadata[submissionId]': submissionId,
      'metadata[event]': 'NOCTURNE',
      'metadata[refundRole]': role,
      'metadata[source]': 'admin_dashboard'
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `Stripe returned ${response.status}.`);
  if (['failed', 'canceled'].includes(data.status)) throw new Error(`Stripe refund ${data.status}.`);
  return data;
}

function packageRefundPatch(summary, refund, now) {
  return {
    drinkPackageStatus: 'refunded',
    drinkPackageCheckoutStatus: 'refunded',
    drinkPackageRefundId: refund?.id || summary?.drinkPackageRefundId || null,
    drinkPackageRefundStatus: refund?.status || summary?.drinkPackageRefundStatus || 'submitted',
    drinkPackageRefundedAt: now,
    drinkPackageInvalidatedAt: now,
    drinkPackageInvalidationReason: 'refunded',
    drinkCreditsRemainingBeforeRefund: Number(summary?.drinkCreditsRemaining || 0),
    drinkCreditsRemaining: 0,
    updatedAt: now
  };
}

function admissionRefundPatch(refund, amountTotal, now) {
  return {
    status: 'refunded',
    stripeRefundId: refund?.id || null,
    refundStatus: refund?.status || 'submitted',
    refundedAt: now,
    refundedAmount: refund?.amount ?? amountTotal ?? null,
    updatedAt: now
  };
}

async function persistPackageRefund({ orderStore, reviewStore, summary, review, addonOrder, submissionId, refund }) {
  const now = new Date().toISOString();
  const patch = packageRefundPatch(summary, refund, now);
  const updatedSummary = { ...summary, ...patch };
  await orderStore.setJSON(`submission-${submissionId}`, updatedSummary);
  if (summary.drinkPackageCheckoutSessionId && addonOrder) {
    await orderStore.setJSON(summary.drinkPackageCheckoutSessionId, {
      ...addonOrder,
      status: 'refunded',
      ...patch
    });
  }
  const updatedReview = review ? { ...review, ...patch } : null;
  if (updatedReview) await reviewStore.setJSON(submissionId, updatedReview);
  await writeAudit('drink_package.admin_refunded', {
    submissionId,
    ticketId: summary.ticketId,
    stripePaymentIntentId: summary.drinkPackagePaymentIntentId,
    stripeRefundId: refund?.id || null,
    refundStatus: refund?.status || 'submitted'
  });
  return { summary: updatedSummary, review: updatedReview || review, patch };
}

async function persistAdmissionRefund({ orderStore, reviewStore, summary, order, review, submissionId, refund }) {
  const now = new Date().toISOString();
  const patch = admissionRefundPatch(refund, summary.amountTotal, now);
  const updatedSummary = {
    ...summary,
    ...patch,
    drinkPackageStatus: summary.drinkPackagePurchased ? 'refunded' : summary.drinkPackageStatus,
    drinkPackageInvalidatedAt: summary.drinkPackagePurchased ? (summary.drinkPackageInvalidatedAt || now) : summary.drinkPackageInvalidatedAt,
    drinkPackageInvalidationReason: summary.drinkPackagePurchased ? 'refunded' : summary.drinkPackageInvalidationReason
  };
  await orderStore.setJSON(`submission-${submissionId}`, updatedSummary);
  if (summary.stripeCheckoutSessionId && order) {
    await orderStore.setJSON(summary.stripeCheckoutSessionId, {
      ...order,
      ...patch,
      drinkPackageStatus: updatedSummary.drinkPackageStatus,
      drinkPackageInvalidatedAt: updatedSummary.drinkPackageInvalidatedAt,
      drinkPackageInvalidationReason: updatedSummary.drinkPackageInvalidationReason
    });
  }
  const updatedReview = review ? {
    ...review,
    ticketState: 'refunded',
    ticketRefundedAt: now,
    stripeRefundId: refund?.id || null,
    refundStatus: refund?.status || 'submitted',
    drinkPackageStatus: updatedSummary.drinkPackageStatus,
    drinkPackageInvalidatedAt: updatedSummary.drinkPackageInvalidatedAt,
    drinkPackageInvalidationReason: updatedSummary.drinkPackageInvalidationReason,
    updatedAt: now
  } : null;
  if (updatedReview) await reviewStore.setJSON(submissionId, updatedReview);
  await writeAudit('ticket.admin_refunded', {
    submissionId,
    ticketId: summary.ticketId,
    stripePaymentIntentId: summary.stripePaymentIntentId,
    stripeRefundId: refund?.id || null,
    refundStatus: refund?.status || 'submitted'
  });
  return { summary: updatedSummary, review: updatedReview || review, patch };
}

async function sendCombinedRefundEmail(application, summary, admissionRefund, packageRefund) {
  if (!process.env.RESEND_API_KEY || !process.env.NOCTURNE_EMAIL_FROM || !application?.email) {
    return { status: 'not_configured', messageId: null, error: null };
  }
  const displayName = application.preferredName || application.fullName || 'Guest';
  const currency = String(admissionRefund?.currency || packageRefund?.currency || summary.currency || 'usd').toUpperCase();
  const admissionAmount = Number(admissionRefund?.amount ?? summary.amountTotal ?? 0);
  const packageAmount = Number(packageRefund?.amount ?? summary.drinkPackagePriceCents ?? 0);
  const total = admissionAmount + packageAmount;
  const text = [
    `${displayName},`, '',
    'Your NOCTURNE admission and separate six-credit drink package have been canceled and refunded through Stripe.', '',
    `Ticket ID: ${summary.ticketId}`,
    `Admission refund: ${currency} ${(admissionAmount / 100).toFixed(2)}${admissionRefund?.id ? ` (${admissionRefund.id})` : ''}`,
    `Drink package refund: ${currency} ${(packageAmount / 100).toFixed(2)}${packageRefund?.id ? ` (${packageRefund.id})` : ''}`,
    `Total submitted for refund: ${currency} ${(total / 100).toFixed(2)}`, '',
    'The digital ticket and drink package are no longer valid. Bank posting times vary by payment method.', '',
    'NOCTURNE Festival',
    'Presented by Wild Ones · Hawai‘i'
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#030303;color:#f7efe3;font-family:Arial,sans-serif"><div style="max-width:640px;margin:0 auto;padding:44px 24px"><div style="border:1px solid rgba(216,154,43,.35);background:#080604;padding:38px 30px"><div style="color:#d89a2b;font-size:11px;letter-spacing:3px;text-transform:uppercase">NOCTURNE · Refund Confirmed</div><h1 style="font-family:Georgia,serif;font-weight:400;font-size:42px;line-height:1.04;color:#fff3df;margin:16px 0 22px">Admission &amp; package<br>canceled.</h1><p style="color:#c8baa4;line-height:1.7">${escapeHtml(displayName)}, your NOCTURNE admission and separate six-credit drink package were submitted to Stripe for refund.</p><div style="margin:28px 0;padding:18px;border-left:2px solid #d89a2b;background:#020202;color:#d8c7ac;line-height:1.8"><strong>Ticket ID:</strong> ${escapeHtml(summary.ticketId)}<br><strong>Admission refund:</strong> ${escapeHtml(currency)} ${(admissionAmount / 100).toFixed(2)}${admissionRefund?.id ? ` · ${escapeHtml(admissionRefund.id)}` : ''}<br><strong>Drink package refund:</strong> ${escapeHtml(currency)} ${(packageAmount / 100).toFixed(2)}${packageRefund?.id ? ` · ${escapeHtml(packageRefund.id)}` : ''}<br><strong>Total:</strong> ${escapeHtml(currency)} ${(total / 100).toFixed(2)}</div><p style="color:#9d907f;line-height:1.7">The digital ticket and drink package are no longer valid. Bank posting times vary by payment method.</p><div style="margin-top:34px;padding-top:20px;border-top:1px solid rgba(216,154,43,.18);color:#74695b;font-size:11px;letter-spacing:1px;text-transform:uppercase">NOCTURNE Festival · Presented by Wild Ones · Hawai‘i</div></div></div></body></html>`;
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `combined-refund-email-${admissionRefund?.id || 'admission'}-${packageRefund?.id || 'package'}`.slice(0, 250)
      },
      body: JSON.stringify({
        from: process.env.NOCTURNE_EMAIL_FROM,
        to: [application.email],
        subject: 'Your NOCTURNE Admission & Drink Package Refund',
        html,
        text
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || `Resend returned ${response.status}.`);
    return { status: 'sent', messageId: data.id || null, error: null };
  } catch (error) {
    return { status: 'failed', messageId: null, error: String(error?.message || error).slice(0, 500) };
  }
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  if (!hasValidSession(req)) return json({ error: 'Admin session expired. Sign in again.' }, 401);
  if (!allowedPostOrigin(req)) return json({ error: 'Request origin was not allowed.' }, 403);
  if (!process.env.STRIPE_SECRET_KEY) return json({ error: 'Stripe refunds are not configured.' }, 503);

  const body = await readBody(req);
  if (!body) return json({ error: 'Invalid request body.' }, 400);
  const submissionId = String(body.submissionId || '').trim();
  const confirmTicketId = String(body.confirmTicketId || '').trim();
  if (!validSubmissionId(submissionId)) return json({ error: 'Invalid submission ID.' }, 400);

  const applicationStore = getStore({ name: APPLICATION_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const summaryKey = `submission-${submissionId}`;
  const [application, review, summary] = await Promise.all([
    applicationStore.get(submissionId, { type: 'json', consistency: 'strong' }),
    reviewStore.get(submissionId, { type: 'json', consistency: 'strong' }),
    orderStore.get(summaryKey, { type: 'json', consistency: 'strong' })
  ]);

  if (!application || !summary) return json({ error: 'The ticket record could not be found.' }, 404);
  if (!summary.ticketId || confirmTicketId !== summary.ticketId) return json({ error: 'Ticket confirmation did not match.' }, 400);
  if (summary.ticketSource === 'comp' || /^NOC-TKT-COMP-/.test(summary.ticketId)) return json({ error: 'Complimentary tickets do not have Stripe payments to refund.' }, 409);
  if (summary.drinkPackagePurchaseType !== 'addon') return json({ error: 'This ticket does not have a separately charged drink package.' }, 409);
  if (!summary.stripePaymentIntentId || !summary.drinkPackagePaymentIntentId) return json({ error: 'One or both Stripe payment intents are missing. No refund was submitted.' }, 409);
  if (summary.stripePaymentIntentId === summary.drinkPackagePaymentIntentId) return json({ error: 'Admission and package payment intents unexpectedly match. No refund was submitted.' }, 409);
  if (summary.checkedInAt || review?.checkedInAt || review?.ticketState === 'checked_in') return json({ error: 'Checked-in tickets cannot use the automatic combined refund action.' }, 409);
  if (Number(summary.drinkCreditsRedeemed || 0) > 0) return json({ error: 'This drink package already has redeemed credits, so an automatic full package refund is blocked.' }, 409);
  if (['disputed', 'dispute_won'].includes(String(summary.status || '')) || ['disputed', 'dispute_won'].includes(String(summary.drinkPackageCheckoutStatus || ''))) {
    return json({ error: 'A disputed payment cannot use the automatic combined refund action.' }, 409);
  }

  let currentSummary = summary;
  let currentReview = review;
  const order = summary.stripeCheckoutSessionId
    ? await orderStore.get(summary.stripeCheckoutSessionId, { type: 'json', consistency: 'strong' })
    : null;
  const addonOrder = summary.drinkPackageCheckoutSessionId
    ? await orderStore.get(summary.drinkPackageCheckoutSessionId, { type: 'json', consistency: 'strong' })
    : null;

  const packageAlreadyRefunded = currentSummary.drinkPackageCheckoutStatus === 'refunded' || Boolean(currentSummary.drinkPackageRefundId);
  const admissionAlreadyRefunded = currentSummary.status === 'refunded' || Boolean(currentSummary.stripeRefundId);
  if (packageAlreadyRefunded && admissionAlreadyRefunded) return json({ error: 'Admission and drink package are already refunded.' }, 409);
  if (!packageAlreadyRefunded && currentSummary.drinkPackageCheckoutStatus !== 'paid') return json({ error: `Drink package is ${currentSummary.drinkPackageCheckoutStatus || 'not paid'} and cannot be automatically refunded.` }, 409);
  if (!admissionAlreadyRefunded && currentSummary.status !== 'paid') return json({ error: `Admission is ${currentSummary.status || 'not paid'} and cannot be automatically refunded.` }, 409);

  let packageRefund = packageAlreadyRefunded ? {
    id: currentSummary.drinkPackageRefundId || null,
    status: currentSummary.drinkPackageRefundStatus || 'succeeded',
    amount: currentSummary.drinkPackagePriceCents || null,
    currency: currentSummary.currency || 'usd',
    reused: true
  } : null;

  if (!packageAlreadyRefunded) {
    try {
      packageRefund = await createStripeRefund(currentSummary.drinkPackagePaymentIntentId, submissionId, 'drink-package-addon');
      const persisted = await persistPackageRefund({
        orderStore,
        reviewStore,
        summary: currentSummary,
        review: currentReview,
        addonOrder,
        submissionId,
        refund: packageRefund
      });
      currentSummary = persisted.summary;
      currentReview = persisted.review;
    } catch (error) {
      await writeAudit('combined_refund.package_failed', {
        submissionId,
        ticketId: currentSummary.ticketId,
        stripePaymentIntentId: currentSummary.drinkPackagePaymentIntentId,
        error: String(error?.message || error)
      }).catch(() => {});
      return json({ error: `Drink package refund failed before admission was touched: ${error.message || error}`, partial: false }, 502);
    }
  }

  let admissionRefund = admissionAlreadyRefunded ? {
    id: currentSummary.stripeRefundId || null,
    status: currentSummary.refundStatus || 'succeeded',
    amount: currentSummary.refundedAmount ?? currentSummary.amountTotal ?? null,
    currency: currentSummary.currency || 'usd',
    reused: true
  } : null;

  if (!admissionAlreadyRefunded) {
    try {
      admissionRefund = await createStripeRefund(currentSummary.stripePaymentIntentId, submissionId, 'admission');
      const persisted = await persistAdmissionRefund({
        orderStore,
        reviewStore,
        summary: currentSummary,
        order,
        review: currentReview,
        submissionId,
        refund: admissionRefund
      });
      currentSummary = persisted.summary;
      currentReview = persisted.review;
    } catch (error) {
      const message = `Drink package was refunded, but admission refund failed: ${error.message || error}`;
      await writeAudit('combined_refund.partial_failure', {
        submissionId,
        ticketId: currentSummary.ticketId,
        drinkPackageRefundId: packageRefund?.id || null,
        stripePaymentIntentId: currentSummary.stripePaymentIntentId,
        error: String(error?.message || error)
      }).catch(() => {});
      await sendOpsAlert('Combined refund needs completion', [
        `Submission: ${submissionId}`,
        `Ticket: ${currentSummary.ticketId}`,
        `Drink package refund: ${packageRefund?.id || 'recorded as refunded'}`,
        `Admission payment: ${currentSummary.stripePaymentIntentId}`,
        `Error: ${String(error?.message || error)}`,
        'The package is canceled. Admission is still active until its refund succeeds.'
      ]).catch(() => {});
      return json({
        error: message,
        partial: true,
        packageRefund: { id: packageRefund?.id || null, status: packageRefund?.status || 'submitted' },
        admissionRefund: null
      }, 502);
    }
  }

  const email = await sendCombinedRefundEmail(application, currentSummary, admissionRefund, packageRefund);
  const completedAt = new Date().toISOString();
  const emailPatch = {
    refundEmailStatus: email.status,
    refundEmailSentAt: email.status === 'sent' ? completedAt : null,
    refundEmailMessageId: email.messageId,
    refundEmailError: email.error,
    combinedRefundCompletedAt: completedAt,
    updatedAt: completedAt
  };
  currentSummary = { ...currentSummary, ...emailPatch };
  await orderStore.setJSON(summaryKey, currentSummary);
  if (summary.stripeCheckoutSessionId && order) await orderStore.setJSON(summary.stripeCheckoutSessionId, { ...order, ...admissionRefundPatch(admissionRefund, summary.amountTotal, currentSummary.refundedAt || completedAt), ...emailPatch, drinkPackageStatus: 'refunded' });
  if (summary.drinkPackageCheckoutSessionId && addonOrder) await orderStore.setJSON(summary.drinkPackageCheckoutSessionId, { ...addonOrder, status: 'refunded', ...packageRefundPatch(currentSummary, packageRefund, currentSummary.drinkPackageRefundedAt || completedAt), ...emailPatch });
  if (currentReview) {
    currentReview = { ...currentReview, ...emailPatch, ticketState: 'refunded' };
    await reviewStore.setJSON(submissionId, currentReview);
  }

  await writeAudit('ticket_and_drink_package.admin_refunded', {
    submissionId,
    ticketId: currentSummary.ticketId,
    admissionRefundId: admissionRefund?.id || null,
    drinkPackageRefundId: packageRefund?.id || null,
    refundEmailStatus: email.status
  });

  return json({
    ok: true,
    ticketId: currentSummary.ticketId,
    admissionRefund: {
      id: admissionRefund?.id || null,
      status: admissionRefund?.status || 'submitted',
      amount: admissionRefund?.amount ?? currentSummary.amountTotal ?? null,
      currency: admissionRefund?.currency || currentSummary.currency || 'usd'
    },
    packageRefund: {
      id: packageRefund?.id || null,
      status: packageRefund?.status || 'submitted',
      amount: packageRefund?.amount ?? currentSummary.drinkPackagePriceCents ?? null,
      currency: packageRefund?.currency || currentSummary.currency || 'usd'
    },
    refundEmailStatus: email.status
  });
};
