import { getStore } from '@netlify/blobs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { writeAudit } from './_audit.mjs';
import { sendOpsAlert } from './_ops-alert.mjs';

const APPLICATION_STORE = 'nocturne-applications';
const REVIEW_STORE = 'nocturne-application-reviews';
const ORDER_STORE = 'nocturne-ticket-orders';
const SESSION_COOKIE = 'nocturne_admin';
const REFUND_ACTIONS = new Set(['admission-only', 'package-only', 'combined']);

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
  return left.length === right.length && timingSafeEqual(left, right);
}

function sign(value) {
  return createHmac('sha256', sessionSecret()).update(value).digest('base64url');
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.get('cookie') || '').split(';').map((part) => {
    const index = part.indexOf('=');
    if (index < 0) return ['', ''];
    let value = part.slice(index + 1).trim();
    try { value = decodeURIComponent(value); } catch {}
    return [part.slice(0, index).trim(), value];
  }).filter(([key]) => key));
}

function hasValidSession(req) {
  if (!sessionSecret()) return false;
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token?.includes('.')) return false;
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

function operatorName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

function validOperator(value) {
  return /^[A-Za-z0-9 .,'’_-]{2,80}$/.test(value);
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

function refundHistory(record = {}) {
  const history = Array.isArray(record.refundHistory) ? record.refundHistory.filter(Boolean).map((item) => ({ ...item })) : [];
  const has = (type, id) => history.some((item) => item.type === type && id && item.stripeRefundId === id);

  if (record.stripeRefundId && !has('admission', record.stripeRefundId)) {
    history.push({
      id: `legacy-admission-${record.stripeRefundId}`,
      type: 'admission',
      label: 'Admission refund',
      amountCents: Number(record.refundedAmount ?? record.amountTotal ?? 0),
      currency: record.currency || 'usd',
      stripeRefundId: record.stripeRefundId,
      paymentIntentId: record.stripePaymentIntentId || null,
      date: record.refundedAt || null,
      status: record.refundStatus || 'submitted',
      initiatedBy: record.refundInitiatedBy || 'Not recorded (legacy)',
      source: 'legacy'
    });
  }

  if (record.drinkPackageRefundId && !has('drink_package', record.drinkPackageRefundId)) {
    history.push({
      id: `legacy-package-${record.drinkPackageRefundId}`,
      type: 'drink_package',
      label: 'Drink package refund',
      amountCents: Number(record.drinkPackageRefundAmount ?? record.drinkPackagePriceCents ?? 0),
      currency: record.currency || 'usd',
      stripeRefundId: record.drinkPackageRefundId,
      paymentIntentId: record.drinkPackagePaymentIntentId || null,
      date: record.drinkPackageRefundedAt || null,
      status: record.drinkPackageRefundStatus || 'submitted',
      initiatedBy: record.drinkPackageRefundInitiatedBy || 'Not recorded (legacy)',
      source: 'legacy'
    });
  }

  for (const item of history) {
    if (item.type === 'admission' && item.stripeRefundId === record.stripeRefundId) item.status = record.refundStatus || item.status;
    if (item.type === 'drink_package' && item.stripeRefundId === record.drinkPackageRefundId) item.status = record.drinkPackageRefundStatus || item.status;
  }

  return history.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
}

function makeHistoryEntry({ type, refund, record, initiatedBy, action, date }) {
  const packageRefund = type === 'drink_package';
  return {
    id: `refund-${refund.id || randomBytes(10).toString('hex')}`,
    type,
    label: packageRefund ? 'Drink package refund' : 'Admission refund',
    amountCents: Number(refund.amount ?? (packageRefund ? record.drinkPackagePriceCents : record.amountTotal) ?? 0),
    currency: refund.currency || record.currency || 'usd',
    stripeRefundId: refund.id || null,
    paymentIntentId: packageRefund ? record.drinkPackagePaymentIntentId : record.stripePaymentIntentId,
    date,
    status: refund.status || 'submitted',
    initiatedBy,
    source: 'admin_dashboard',
    action
  };
}

function appendHistory(record, entry) {
  const history = refundHistory(record).filter((item) => !(entry.stripeRefundId && item.stripeRefundId === entry.stripeRefundId && item.type === entry.type));
  history.push(entry);
  return history.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
}

async function getRecords(submissionId) {
  const applicationStore = getStore({ name: APPLICATION_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const summaryKey = `submission-${submissionId}`;
  const [application, review, summaryEntry] = await Promise.all([
    applicationStore.get(submissionId, { type: 'json', consistency: 'strong' }),
    reviewStore.get(submissionId, { type: 'json', consistency: 'strong' }),
    orderStore.getWithMetadata(summaryKey, { type: 'json', consistency: 'strong' })
  ]);
  const summary = summaryEntry?.data || null;
  const order = summary?.stripeCheckoutSessionId
    ? await orderStore.get(summary.stripeCheckoutSessionId, { type: 'json', consistency: 'strong' })
    : null;
  const addonOrder = summary?.drinkPackageCheckoutSessionId
    ? await orderStore.get(summary.drinkPackageCheckoutSessionId, { type: 'json', consistency: 'strong' })
    : null;
  return { applicationStore, reviewStore, orderStore, summaryKey, application, review, summaryEntry, summary, order, addonOrder };
}

async function syncSummary(records, summary, reviewPatch = {}, orderPatch = {}, addonPatch = {}) {
  await records.orderStore.setJSON(records.summaryKey, summary);
  if (records.summary?.stripeCheckoutSessionId && records.order) {
    await records.orderStore.setJSON(records.summary.stripeCheckoutSessionId, { ...records.order, ...orderPatch, refundHistory: summary.refundHistory, updatedAt: summary.updatedAt });
  }
  if (records.summary?.drinkPackageCheckoutSessionId && records.addonOrder) {
    await records.orderStore.setJSON(records.summary.drinkPackageCheckoutSessionId, { ...records.addonOrder, ...addonPatch, refundHistory: summary.refundHistory, updatedAt: summary.updatedAt });
  }
  if (records.review) {
    await records.reviewStore.setJSON(summary.submissionId, { ...records.review, ...reviewPatch, refundHistory: summary.refundHistory, updatedAt: summary.updatedAt });
  }
}

async function claimPackage(records, action, initiatedBy, alsoClaimAdmission = false) {
  const current = records.summaryEntry?.data;
  if (!current) throw new Error('Ticket summary is missing.');
  if (current.drinkPackagePurchaseType !== 'addon') throw new Error('This ticket does not have a separately charged drink package.');
  if (!current.drinkPackagePaymentIntentId) throw new Error('The drink-package Stripe payment intent is missing.');
  if (current.drinkPackageCheckoutStatus === 'refunded' || current.drinkPackageRefundId) return { summary: current, alreadyRefunded: true };
  if (current.drinkPackageCheckoutStatus !== 'paid') throw new Error(`Drink package is ${current.drinkPackageCheckoutStatus || 'not paid'} and cannot be refunded.`);
  if (Number(current.drinkCreditsRedeemed || 0) > 0) {
    throw new Error('This drink package is non-refundable because at least one drink credit has already been redeemed.');
  }
  if (['disputed', 'dispute_won'].includes(String(current.drinkPackageStatus || '')) || ['disputed', 'dispute_won'].includes(String(current.drinkPackageCheckoutStatus || ''))) {
    throw new Error('A disputed drink-package payment cannot use the automatic refund action.');
  }
  if (alsoClaimAdmission) {
    if (current.status !== 'paid') throw new Error(`Admission is ${current.status || 'not paid'} and cannot be refunded.`);
    if (!current.stripePaymentIntentId) throw new Error('The admission Stripe payment intent is missing.');
    if (current.checkedInAt || records.review?.checkedInAt || records.review?.ticketState === 'checked_in') throw new Error('Checked-in admission cannot use the automatic refund action.');
  }

  const claimAt = new Date().toISOString();
  const claimId = randomBytes(12).toString('hex');
  const claimed = {
    ...current,
    ...(alsoClaimAdmission ? { status: 'refund_pending', admissionRefundPreviousStatus: current.status } : {}),
    drinkPackageStatus: 'refund_pending',
    drinkPackageCheckoutStatus: 'refund_pending',
    drinkPackageRefundPreviousStatus: current.drinkPackageStatus,
    drinkPackageRefundPreviousCheckoutStatus: current.drinkPackageCheckoutStatus,
    refundClaimId: claimId,
    refundClaimAction: action,
    refundClaimInitiatedBy: initiatedBy,
    refundClaimedAt: claimAt,
    updatedAt: claimAt
  };
  const write = await records.orderStore.setJSON(records.summaryKey, claimed, { onlyIfMatch: records.summaryEntry.etag });
  if (!write.modified) throw new Error('Ticket or drink-package status changed while the refund was being prepared. Refresh and try again.');
  return { summary: claimed, alreadyRefunded: false };
}

async function claimAdmission(records, action, initiatedBy) {
  const fresh = await records.orderStore.getWithMetadata(records.summaryKey, { type: 'json', consistency: 'strong' });
  const current = fresh?.data;
  if (!current) throw new Error('Ticket summary is missing.');
  if (current.status === 'refunded' || current.stripeRefundId) return { summary: current, alreadyRefunded: true };
  if (current.status !== 'paid') throw new Error(`Admission is ${current.status || 'not paid'} and cannot be refunded.`);
  if (!current.stripePaymentIntentId) throw new Error('The admission Stripe payment intent is missing.');
  if (current.checkedInAt || records.review?.checkedInAt || records.review?.ticketState === 'checked_in') throw new Error('Checked-in admission cannot use the automatic refund action.');
  if (current.ticketSource === 'comp' || /^NOC-TKT-COMP-/.test(current.ticketId || '')) throw new Error('Complimentary admission has no Stripe payment to refund.');
  if (current.drinkPackagePurchaseType === 'addon' && current.drinkPackageCheckoutStatus === 'paid') {
    throw new Error('A separate paid drink package is still attached. Use the combined refund action, or refund the package first.');
  }

  const now = new Date().toISOString();
  const claimed = {
    ...current,
    status: 'refund_pending',
    admissionRefundPreviousStatus: current.status,
    refundClaimId: randomBytes(12).toString('hex'),
    refundClaimAction: action,
    refundClaimInitiatedBy: initiatedBy,
    refundClaimedAt: now,
    updatedAt: now
  };
  const write = await records.orderStore.setJSON(records.summaryKey, claimed, { onlyIfMatch: fresh.etag });
  if (!write.modified) throw new Error('Ticket status changed while the refund was being prepared. Refresh and try again.');
  return { summary: claimed, alreadyRefunded: false };
}

async function restorePackageClaim(records, claimed, restoreAdmission = false) {
  const fresh = await records.orderStore.getWithMetadata(records.summaryKey, { type: 'json', consistency: 'strong' });
  if (!fresh?.data || fresh.data.refundClaimId !== claimed.refundClaimId) return;
  const restored = {
    ...fresh.data,
    ...(restoreAdmission && fresh.data.status === 'refund_pending' ? { status: claimed.admissionRefundPreviousStatus || 'paid' } : {}),
    drinkPackageStatus: claimed.drinkPackageRefundPreviousStatus || 'pending_activation',
    drinkPackageCheckoutStatus: claimed.drinkPackageRefundPreviousCheckoutStatus || 'paid',
    refundClaimId: null,
    refundClaimAction: null,
    refundClaimInitiatedBy: null,
    refundClaimedAt: null,
    updatedAt: new Date().toISOString()
  };
  await records.orderStore.setJSON(records.summaryKey, restored, { onlyIfMatch: fresh.etag }).catch(() => {});
}

async function restoreAdmissionClaim(records, claimed) {
  const fresh = await records.orderStore.getWithMetadata(records.summaryKey, { type: 'json', consistency: 'strong' });
  if (!fresh?.data || fresh.data.refundClaimId !== claimed.refundClaimId || fresh.data.status !== 'refund_pending') return;
  await records.orderStore.setJSON(records.summaryKey, {
    ...fresh.data,
    status: claimed.admissionRefundPreviousStatus || 'paid',
    refundClaimId: null,
    refundClaimAction: null,
    refundClaimInitiatedBy: null,
    refundClaimedAt: null,
    updatedAt: new Date().toISOString()
  }, { onlyIfMatch: fresh.etag }).catch(() => {});
}

async function finalizePackage(records, claimed, refund, initiatedBy, action) {
  const fresh = await records.orderStore.get(records.summaryKey, { type: 'json', consistency: 'strong' });
  const now = new Date().toISOString();
  const entry = makeHistoryEntry({ type: 'drink_package', refund, record: fresh || claimed, initiatedBy, action, date: now });
  const summary = {
    ...(fresh || claimed),
    ...(action === 'combined' && (fresh || claimed).status === 'refund_pending' ? {} : { status: (fresh || claimed).status }),
    drinkPackageStatus: 'refunded',
    drinkPackageCheckoutStatus: 'refunded',
    drinkPackageRefundId: refund.id,
    drinkPackageRefundStatus: refund.status || 'submitted',
    drinkPackageRefundAmount: refund.amount ?? (fresh || claimed).drinkPackagePriceCents ?? null,
    drinkPackageRefundedAt: now,
    drinkPackageRefundInitiatedBy: initiatedBy,
    drinkPackageInvalidatedAt: now,
    drinkPackageInvalidationReason: 'refunded',
    drinkCreditsRemainingBeforeRefund: Number((fresh || claimed).drinkCreditsRemaining || 0),
    drinkCreditsRemaining: 0,
    refundHistory: appendHistory(fresh || claimed, entry),
    updatedAt: now
  };
  await syncSummary(records, summary,
    { drinkPackageStatus: 'refunded', drinkPackageCheckoutStatus: 'refunded', drinkPackageRefundId: refund.id, drinkPackageRefundStatus: refund.status || 'submitted', drinkPackageRefundedAt: now, drinkPackageRefundInitiatedBy: initiatedBy, drinkCreditsRemaining: 0 },
    { drinkPackageStatus: 'refunded', drinkCreditsRemaining: 0 },
    { status: 'refunded', drinkPackageStatus: 'refunded', drinkPackageCheckoutStatus: 'refunded', drinkPackageRefundId: refund.id, drinkPackageRefundStatus: refund.status || 'submitted', drinkPackageRefundedAt: now, drinkPackageRefundInitiatedBy: initiatedBy, drinkCreditsRemaining: 0 }
  );
  await writeAudit('drink_package.admin_refunded', { submissionId: summary.submissionId, ticketId: summary.ticketId, stripePaymentIntentId: summary.drinkPackagePaymentIntentId, stripeRefundId: refund.id, refundStatus: refund.status || 'submitted', initiatedBy, action });
  return summary;
}

async function finalizeAdmission(records, claimed, refund, initiatedBy, action) {
  const fresh = await records.orderStore.get(records.summaryKey, { type: 'json', consistency: 'strong' });
  const now = new Date().toISOString();
  const entry = makeHistoryEntry({ type: 'admission', refund, record: fresh || claimed, initiatedBy, action, date: now });
  const hasIncludedPackage = Boolean((fresh || claimed).drinkPackagePurchased && (fresh || claimed).drinkPackagePurchaseType !== 'addon');
  const summary = {
    ...(fresh || claimed),
    status: 'refunded',
    stripeRefundId: refund.id,
    refundStatus: refund.status || 'submitted',
    refundedAt: now,
    refundedAmount: refund.amount ?? (fresh || claimed).amountTotal ?? null,
    refundInitiatedBy: initiatedBy,
    ...(hasIncludedPackage ? {
      drinkPackageStatus: 'refunded',
      drinkPackageInvalidatedAt: now,
      drinkPackageInvalidationReason: 'admission_refunded',
      drinkCreditsRemainingBeforeRefund: Number((fresh || claimed).drinkCreditsRemaining || 0),
      drinkCreditsRemaining: 0
    } : {}),
    refundHistory: appendHistory(fresh || claimed, entry),
    refundClaimId: null,
    refundClaimAction: null,
    refundClaimInitiatedBy: null,
    refundClaimedAt: null,
    updatedAt: now
  };
  await syncSummary(records, summary,
    { ticketState: 'refunded', ticketRefundedAt: now, stripeRefundId: refund.id, refundStatus: refund.status || 'submitted', refundInitiatedBy: initiatedBy, ...(hasIncludedPackage ? { drinkPackageStatus: 'refunded', drinkCreditsRemaining: 0 } : {}) },
    { status: 'refunded', stripeRefundId: refund.id, refundStatus: refund.status || 'submitted', refundedAt: now, refundedAmount: refund.amount ?? summary.amountTotal ?? null, refundInitiatedBy: initiatedBy, ...(hasIncludedPackage ? { drinkPackageStatus: 'refunded', drinkCreditsRemaining: 0 } : {}) },
    {}
  );
  await writeAudit('ticket.admin_refunded', { submissionId: summary.submissionId, ticketId: summary.ticketId, stripePaymentIntentId: summary.stripePaymentIntentId, stripeRefundId: refund.id, refundStatus: refund.status || 'submitted', initiatedBy, action });
  return summary;
}

async function sendRefundEmail(application, summary, action, admissionRefund, packageRefund) {
  if (!process.env.RESEND_API_KEY || !process.env.NOCTURNE_EMAIL_FROM || !application?.email) return { status: 'not_configured', messageId: null, error: null };
  const displayName = application.preferredName || application.fullName || 'Guest';
  const currency = String(admissionRefund?.currency || packageRefund?.currency || summary.currency || 'usd').toUpperCase();
  const admissionAmount = admissionRefund ? Number(admissionRefund.amount ?? summary.amountTotal ?? 0) : 0;
  const packageAmount = packageRefund ? Number(packageRefund.amount ?? summary.drinkPackagePriceCents ?? 0) : 0;
  const total = admissionAmount + packageAmount;
  const packageOnly = action === 'package-only';
  const heading = packageOnly ? 'Drink package refunded.' : action === 'combined' ? 'Admission & package refunded.' : 'Admission refunded.';
  const explanation = packageOnly
    ? 'Your separate NOCTURNE six-credit drink package has been canceled and refunded. Your admission ticket remains active.'
    : action === 'combined'
      ? 'Your NOCTURNE admission and separate six-credit drink package have been canceled and refunded.'
      : 'Your NOCTURNE admission has been canceled and refunded.';
  const lines = [
    `${displayName},`, '', explanation, '', `Ticket ID: ${summary.ticketId}`,
    ...(admissionRefund ? [`Admission refund: ${currency} ${(admissionAmount / 100).toFixed(2)} (${admissionRefund.id})`] : []),
    ...(packageRefund ? [`Drink package refund: ${currency} ${(packageAmount / 100).toFixed(2)} (${packageRefund.id})`] : []),
    ...(action === 'combined' ? [`Total submitted for refund: ${currency} ${(total / 100).toFixed(2)}`] : []), '',
    packageOnly ? 'Your admission ticket remains valid. The refunded drink package can no longer be activated or redeemed.' : 'Any refunded admission or package is no longer valid. Bank posting times vary by payment method.', '',
    'NOCTURNE Festival', 'Presented by Wild Ones · Hawai‘i'
  ];
  const text = lines.join('\n');
  const detailHtml = `${admissionRefund ? `<br><strong>Admission refund:</strong> ${escapeHtml(currency)} ${(admissionAmount / 100).toFixed(2)} · ${escapeHtml(admissionRefund.id)}` : ''}${packageRefund ? `<br><strong>Drink package refund:</strong> ${escapeHtml(currency)} ${(packageAmount / 100).toFixed(2)} · ${escapeHtml(packageRefund.id)}` : ''}${action === 'combined' ? `<br><strong>Total:</strong> ${escapeHtml(currency)} ${(total / 100).toFixed(2)}` : ''}`;
  const html = `<!doctype html><html><body style="margin:0;background:#030303;color:#f7efe3;font-family:Arial,sans-serif"><div style="max-width:640px;margin:0 auto;padding:44px 24px"><div style="border:1px solid rgba(216,154,43,.35);background:#080604;padding:38px 30px"><div style="color:#d89a2b;font-size:11px;letter-spacing:3px;text-transform:uppercase">NOCTURNE · Refund</div><h1 style="font-family:Georgia,serif;font-weight:400;font-size:42px;line-height:1.04;color:#fff3df;margin:16px 0 22px">${escapeHtml(heading)}</h1><p style="color:#c8baa4;line-height:1.7">${escapeHtml(displayName)}, ${escapeHtml(explanation)}</p><div style="margin:28px 0;padding:18px;border-left:2px solid #d89a2b;background:#020202;color:#d8c7ac;line-height:1.8"><strong>Ticket ID:</strong> ${escapeHtml(summary.ticketId)}${detailHtml}</div><p style="color:#9d907f;line-height:1.7">${packageOnly ? 'Your admission ticket remains active. The refunded package is disabled.' : 'Refunded ticket/package access is disabled. Bank posting times vary by payment method.'}</p><div style="margin-top:34px;padding-top:20px;border-top:1px solid rgba(216,154,43,.18);color:#74695b;font-size:11px;letter-spacing:1px;text-transform:uppercase">NOCTURNE Festival · Presented by Wild Ones · Hawai‘i</div></div></div></body></html>`;
  try {
    const keyPart = [admissionRefund?.id, packageRefund?.id].filter(Boolean).join('-');
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `refund-email-${keyPart}`.slice(0, 250) },
      body: JSON.stringify({ from: process.env.NOCTURNE_EMAIL_FROM, to: [application.email], subject: packageOnly ? 'Your NOCTURNE Drink Package Refund' : action === 'combined' ? 'Your NOCTURNE Admission & Drink Package Refund' : 'Your NOCTURNE Admission Refund', html, text })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || `Resend returned ${response.status}.`);
    return { status: 'sent', messageId: data.id || null, error: null };
  } catch (error) {
    return { status: 'failed', messageId: null, error: String(error?.message || error).slice(0, 500) };
  }
}

async function updateEmailStatus(records, summary, email) {
  const now = new Date().toISOString();
  const next = { ...summary, refundEmailStatus: email.status, refundEmailSentAt: email.status === 'sent' ? now : null, refundEmailMessageId: email.messageId, refundEmailError: email.error, updatedAt: now };
  await records.orderStore.setJSON(records.summaryKey, next);
  if (records.review) await records.reviewStore.setJSON(next.submissionId, { ...records.review, refundHistory: next.refundHistory, refundEmailStatus: email.status, refundEmailSentAt: email.status === 'sent' ? now : null, refundEmailMessageId: email.messageId, refundEmailError: email.error, updatedAt: now });
  return next;
}

async function historyResponse(submissionId) {
  if (!validSubmissionId(submissionId)) return json({ error: 'Invalid submission ID.' }, 400);
  const records = await getRecords(submissionId);
  if (!records.summary) return json({ error: 'Ticket record not found.' }, 404);
  return json({ ok: true, submissionId, ticketId: records.summary.ticketId || null, history: refundHistory(records.summary) });
}

async function refundAction(body) {
  if (!process.env.STRIPE_SECRET_KEY) return json({ error: 'Stripe refunds are not configured.' }, 503);
  const submissionId = String(body.submissionId || '').trim();
  const confirmTicketId = String(body.confirmTicketId || '').trim();
  const action = REFUND_ACTIONS.has(String(body.action || '')) ? String(body.action) : 'combined';
  const initiatedBy = operatorName(body.initiatedBy);
  if (!validSubmissionId(submissionId)) return json({ error: 'Invalid submission ID.' }, 400);
  if (!validOperator(initiatedBy)) return json({ error: 'Enter the admin name or initials (2–80 characters) for the refund history.' }, 400);

  const records = await getRecords(submissionId);
  if (!records.application || !records.summary) return json({ error: 'The ticket record could not be found.' }, 404);
  if (!records.summary.ticketId || confirmTicketId !== records.summary.ticketId) return json({ error: 'Ticket confirmation did not match.' }, 400);

  let current = records.summary;
  let packageRefund = null;
  let admissionRefund = null;

  if (action === 'package-only' || action === 'combined') {
    let claim;
    try {
      claim = await claimPackage(records, action, initiatedBy, action === 'combined');
      current = claim.summary;
      if (claim.alreadyRefunded) {
        packageRefund = { id: current.drinkPackageRefundId || null, status: current.drinkPackageRefundStatus || 'succeeded', amount: current.drinkPackageRefundAmount ?? current.drinkPackagePriceCents ?? null, currency: current.currency || 'usd', reused: true };
      } else {
        packageRefund = await createStripeRefund(current.drinkPackagePaymentIntentId, submissionId, 'drink-package-addon');
        current = await finalizePackage(records, current, packageRefund, initiatedBy, action);
      }
    } catch (error) {
      if (claim?.summary && !claim.alreadyRefunded) await restorePackageClaim(records, claim.summary, action === 'combined');
      await writeAudit('refund.package_failed', { submissionId, ticketId: records.summary.ticketId, initiatedBy, action, error: String(error?.message || error) }).catch(() => {});
      return json({ error: error.message || 'Drink-package refund failed.', partial: false }, 409);
    }

    if (action === 'package-only') {
      const email = await sendRefundEmail(records.application, current, action, null, packageRefund);
      current = await updateEmailStatus(records, current, email);
      await writeAudit('refund.package_only_completed', { submissionId, ticketId: current.ticketId, initiatedBy, stripeRefundId: packageRefund?.id || null, emailStatus: email.status });
      return json({ ok: true, action, ticketId: current.ticketId, admissionRemainsActive: current.status === 'paid', packageRefund, history: refundHistory(current), refundEmailStatus: email.status });
    }
  }

  if (action === 'admission-only') {
    let claim;
    try {
      claim = await claimAdmission(records, action, initiatedBy);
      current = claim.summary;
      if (claim.alreadyRefunded) {
        admissionRefund = { id: current.stripeRefundId || null, status: current.refundStatus || 'succeeded', amount: current.refundedAmount ?? current.amountTotal ?? null, currency: current.currency || 'usd', reused: true };
      } else {
        admissionRefund = await createStripeRefund(current.stripePaymentIntentId, submissionId, 'admission');
        current = await finalizeAdmission(records, current, admissionRefund, initiatedBy, action);
      }
    } catch (error) {
      if (claim?.summary && !claim.alreadyRefunded) await restoreAdmissionClaim(records, claim.summary);
      await writeAudit('refund.admission_failed', { submissionId, ticketId: records.summary.ticketId, initiatedBy, action, error: String(error?.message || error) }).catch(() => {});
      return json({ error: error.message || 'Admission refund failed.', partial: false }, 409);
    }
  }

  if (action === 'combined') {
    try {
      const fresh = await records.orderStore.getWithMetadata(records.summaryKey, { type: 'json', consistency: 'strong' });
      current = fresh?.data || current;
      if (current.status === 'refunded' || current.stripeRefundId) {
        admissionRefund = { id: current.stripeRefundId || null, status: current.refundStatus || 'succeeded', amount: current.refundedAmount ?? current.amountTotal ?? null, currency: current.currency || 'usd', reused: true };
      } else {
        if (current.status !== 'refund_pending') throw new Error(`Admission is ${current.status || 'not refundable'} after the package refund.`);
        admissionRefund = await createStripeRefund(current.stripePaymentIntentId, submissionId, 'admission');
        current = await finalizeAdmission(records, current, admissionRefund, initiatedBy, action);
      }
    } catch (error) {
      const fresh = await records.orderStore.getWithMetadata(records.summaryKey, { type: 'json', consistency: 'strong' });
      if (fresh?.data?.status === 'refund_pending') {
        await records.orderStore.setJSON(records.summaryKey, { ...fresh.data, status: fresh.data.admissionRefundPreviousStatus || 'paid', refundClaimId: null, refundClaimAction: null, refundClaimInitiatedBy: null, refundClaimedAt: null, updatedAt: new Date().toISOString() }, { onlyIfMatch: fresh.etag }).catch(() => {});
      }
      const message = `Drink package was refunded, but admission refund failed: ${error.message || error}`;
      await writeAudit('refund.combined_partial_failure', { submissionId, ticketId: records.summary.ticketId, initiatedBy, packageRefundId: packageRefund?.id || null, error: String(error?.message || error) }).catch(() => {});
      await sendOpsAlert('Combined refund needs completion', [`Submission: ${submissionId}`, `Ticket: ${records.summary.ticketId}`, `Initiated by: ${initiatedBy}`, `Drink package refund: ${packageRefund?.id || 'recorded as refunded'}`, `Admission payment: ${records.summary.stripePaymentIntentId || 'unknown'}`, `Error: ${String(error?.message || error)}`, 'The drink package is refunded. Admission remains active until its refund succeeds.']).catch(() => {});
      return json({ error: message, partial: true, packageRefund, admissionRefund: null }, 502);
    }
  }

  const email = await sendRefundEmail(records.application, current, action, admissionRefund, packageRefund);
  current = await updateEmailStatus(records, current, email);
  await writeAudit('refund.completed', { submissionId, ticketId: current.ticketId, initiatedBy, action, admissionRefundId: admissionRefund?.id || null, packageRefundId: packageRefund?.id || null, emailStatus: email.status });
  return json({ ok: true, action, ticketId: current.ticketId, admissionRefund, packageRefund, history: refundHistory(current), refundEmailStatus: email.status });
}

export default async (req) => {
  if (!['GET', 'POST'].includes(req.method)) return json({ error: 'Method not allowed.' }, 405);
  if (!hasValidSession(req)) return json({ error: 'Admin session expired. Sign in again.' }, 401);
  if (req.method === 'GET') return historyResponse(String(new URL(req.url).searchParams.get('submissionId') || '').trim());
  if (!allowedPostOrigin(req)) return json({ error: 'Request origin was not allowed.' }, 403);
  const body = await readBody(req);
  if (!body) return json({ error: 'Invalid request body.' }, 400);
  return refundAction(body);
};
