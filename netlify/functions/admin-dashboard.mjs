import { getStore } from '@netlify/blobs';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { makeTicketToken } from './_ticket-token.mjs';

const APPLICATION_STORE = 'nocturne-applications';
const REVIEW_STORE = 'nocturne-application-reviews';
const INVITE_STORE = 'nocturne-invites';
const ORDER_STORE = 'nocturne-ticket-orders';
const SESSION_COOKIE = 'nocturne_admin';
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REVIEW_STATUSES = new Set(['pending', 'shortlist', 'approved', 'declined']);

function json(data, status = 200, extraHeaders = {}) {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      ...extraHeaders
    }
  });
}

function constantTimeEqual(a = '', b = '') {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function sessionSecret() {
  return process.env.NOCTURNE_ADMIN_SESSION_SECRET || process.env.NOCTURNE_ADMIN_KEY || '';
}

function sign(value) {
  return createHmac('sha256', sessionSecret()).update(value).digest('base64url');
}

function makeSessionToken() {
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(JSON.stringify({
    role: 'admin',
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
    nonce: randomBytes(12).toString('base64url')
  }));
  return `${payload}.${sign(payload)}`;
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

function setSessionCookie(token) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

function allowedPostOrigin(req) {
  const origin = req.headers.get('origin');
  if (!origin) return true;

  const allowed = new Set();
  try { allowed.add(new URL(req.url).origin); } catch {}

  for (const value of [process.env.NOCTURNE_SITE_URL, process.env.URL, process.env.DEPLOY_PRIME_URL]) {
    if (!value) continue;
    try { allowed.add(new URL(value).origin); } catch {}
  }

  allowed.add('https://nocturnefestival.com');
  allowed.add('https://www.nocturnefestival.com');
  return allowed.has(origin);
}

function normalizeCode(code) {
  return String(code).trim().toUpperCase().replace(/\s+/g, '');
}

function hashCode(code) {
  return createHash('sha256').update(normalizeCode(code)).digest('hex');
}

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(12);
  let raw = '';
  for (let i = 0; i < 12; i++) raw += chars[bytes[i] % chars.length];
  return `NOC-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

function emailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.NOCTURNE_EMAIL_FROM);
}

function refundConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function validSubmissionId(value) {
  return /^[A-Za-z0-9_-]{6,128}$/.test(String(value || ''));
}

async function readBody(req) {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

async function getApplication(submissionId) {
  const store = getStore({ name: APPLICATION_STORE, consistency: 'strong' });
  return store.get(submissionId, { type: 'json', consistency: 'strong' });
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
    customerEmail: order?.customerEmail || null,
    customerName: order?.customerName || null,
    digitalTicketUrl: summary?.digitalTicketUrl || order?.digitalTicketUrl || review?.digitalTicketUrl || null,
    ticketEmailStatus: order?.ticketEmailStatus || review?.ticketEmailStatus || null,
    ticketEmailSentAt: review?.ticketEmailSentAt || null,
    ticketEmailMessageId: order?.ticketEmailMessageId || review?.ticketEmailMessageId || null,
    ticketEmailError: order?.ticketEmailError || review?.ticketEmailError || null,
    refundEmailStatus: order?.refundEmailStatus || review?.refundEmailStatus || null,
    refundEmailSentAt: review?.refundEmailSentAt || null
  };
}

async function loadTicketData(submissionId, review = null) {
  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const summary = await orderStore.get(`submission-${submissionId}`, { type: 'json', consistency: 'strong' });
  let order = null;
  if (summary?.stripeCheckoutSessionId) {
    order = await orderStore.get(summary.stripeCheckoutSessionId, { type: 'json', consistency: 'strong' });
  }
  return { summary, order, ticket: ticketRecord(summary, order, review) };
}

async function getApplications() {
  const applicationStore = getStore({ name: APPLICATION_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const { blobs } = await applicationStore.list();

  const applications = await Promise.all(
    blobs.map(async ({ key }) => {
      const [application, review] = await Promise.all([
        applicationStore.get(key, { type: 'json', consistency: 'strong' }),
        reviewStore.get(key, { type: 'json', consistency: 'strong' })
      ]);
      if (!application) return null;
      const { ticket } = await loadTicketData(key, review);

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
        ticket,
        review: review || {
          status: 'pending',
          score: null,
          notes: '',
          updatedAt: null,
          inviteGeneratedAt: null,
          inviteState: null
        }
      };
    })
  );

  const filtered = applications.filter(Boolean);
  filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return { applications: filtered, formSubmissionCount: filtered.length };
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

async function saveReview(body) {
  const submissionId = String(body.submissionId || '').trim();
  if (!validSubmissionId(submissionId)) return json({ error: 'Invalid submission ID.' }, 400);

  const status = String(body.status || 'pending').toLowerCase();
  if (!REVIEW_STATUSES.has(status)) return json({ error: 'Invalid review status.' }, 400);

  let score = body.score;
  if (score === '' || score === undefined || score === null) {
    score = null;
  } else {
    score = Number(score);
    if (!Number.isInteger(score) || score < 1 || score > 5) return json({ error: 'Score must be between 1 and 5.' }, 400);
  }

  const notes = String(body.notes || '').slice(0, 5000);
  const store = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const current = await store.get(submissionId, { type: 'json', consistency: 'strong' }) || {};
  const review = { ...current, status, score, notes, updatedAt: new Date().toISOString() };
  await store.setJSON(submissionId, review);
  return json({ ok: true, review });
}

async function createInvite(submissionId, label, { replace = false } = {}) {
  if (!validSubmissionId(submissionId)) return { error: 'Invalid submission ID.', status: 400 };

  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const inviteStore = getStore({ name: INVITE_STORE, consistency: 'strong' });
  const review = await reviewStore.get(submissionId, { type: 'json', consistency: 'strong' });

  if (!review || review.status !== 'approved') return { error: 'Application must be approved before creating an invite.', status: 409 };
  if (review.inviteHash && review.inviteState === 'active' && !replace) return { error: 'An active invitation already exists for this application.', status: 409 };

  if (replace && review.inviteHash) await inviteStore.delete(review.inviteHash);

  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const purchaseUrl = process.env.NOCTURNE_TICKET_URL || null;
  let code;
  let hash;
  let saved = false;

  for (let tries = 0; tries < 5 && !saved; tries++) {
    code = makeCode();
    hash = hashCode(code);
    const result = await inviteStore.setJSON(
      hash,
      {
        label: String(label || 'Approved NOCTURNE guest').slice(0, 120),
        sourceSubmissionId: submissionId,
        createdAt: new Date().toISOString(),
        expiresAt: expiresAt.toISOString(),
        used: false,
        usedAt: null,
        purchaseUrl
      },
      { onlyIfNew: true }
    );
    saved = result.modified;
  }

  if (!saved) return { error: 'Could not create a unique invite code.', status: 500 };

  const now = new Date().toISOString();
  const updatedReview = {
    ...review,
    inviteGeneratedAt: now,
    inviteExpiresAt: expiresAt.toISOString(),
    inviteHash: hash,
    inviteState: 'active',
    inviteRevokedAt: null,
    inviteRedeemedAt: null,
    inviteEmailSentAt: null,
    inviteEmailMessageId: null,
    updatedAt: now
  };
  await reviewStore.setJSON(submissionId, updatedReview);

  return { code, expiresAt: expiresAt.toISOString(), review: updatedReview };
}

async function generateInvite(body) {
  const submissionId = String(body.submissionId || '').trim();
  const result = await createInvite(submissionId, body.label, { replace: false });
  if (result.error) return json({ error: result.error }, result.status);
  return json({ ok: true, ...result, note: 'Copy this code now. The raw code is not stored in the review record.' }, 201);
}

async function revokeInvite(body) {
  const submissionId = String(body.submissionId || '').trim();
  if (!validSubmissionId(submissionId)) return json({ error: 'Invalid submission ID.' }, 400);

  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const inviteStore = getStore({ name: INVITE_STORE, consistency: 'strong' });
  const review = await reviewStore.get(submissionId, { type: 'json', consistency: 'strong' });

  if (!review?.inviteHash) return json({ error: 'No revocable invitation is recorded for this applicant.' }, 409);
  if (review.inviteState === 'revoked') return json({ error: 'This invitation is already revoked.' }, 409);

  await inviteStore.delete(review.inviteHash);
  const now = new Date().toISOString();
  const updatedReview = { ...review, inviteState: 'revoked', inviteRevokedAt: now, updatedAt: now };
  await reviewStore.setJSON(submissionId, updatedReview);
  return json({ ok: true, review: updatedReview });
}

async function regenerateInvite(body) {
  const submissionId = String(body.submissionId || '').trim();
  const result = await createInvite(submissionId, body.label, { replace: true });
  if (result.error) return json({ error: result.error }, result.status);
  return json({ ok: true, ...result, note: 'The previous invitation was invalidated. Copy the replacement code now.' }, 201);
}

async function sendApprovalEmail(req, body) {
  if (!emailConfigured()) return json({ error: 'Direct email is not configured. Add RESEND_API_KEY and NOCTURNE_EMAIL_FROM in Netlify.' }, 503);

  const submissionId = String(body.submissionId || '').trim();
  const code = normalizeCode(body.code || '');
  if (!validSubmissionId(submissionId)) return json({ error: 'Invalid submission ID.' }, 400);
  if (!/^NOC-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)) return json({ error: 'Invalid invitation code.' }, 400);

  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const review = await reviewStore.get(submissionId, { type: 'json', consistency: 'strong' });
  if (!review || review.status !== 'approved' || review.inviteState !== 'active' || !review.inviteHash) {
    return json({ error: 'The applicant must have an active approved invitation before email can be sent.' }, 409);
  }
  if (!constantTimeEqual(hashCode(code), review.inviteHash)) return json({ error: 'The supplied invitation code does not match the active invite.' }, 409);

  const application = await getApplication(submissionId);
  if (!application?.email) return json({ error: 'This application does not have an email address.' }, 409);

  const siteUrl = (process.env.NOCTURNE_SITE_URL || new URL(req.url).origin).replace(/\/$/, '');
  const redeemUrl = `${siteUrl}/invite`;
  const subject = String(body.subject || 'Your NOCTURNE invitation').trim().slice(0, 160);
  const personalNote = String(body.note || '').trim().slice(0, 1400);
  const displayName = application.preferredName || application.fullName || 'Guest';
  const safeName = escapeHtml(displayName);
  const safeCode = escapeHtml(code);
  const safeNote = escapeHtml(personalNote).replaceAll('\n', '<br>');

  const text = [
    `${displayName},`, '', 'Your request to enter NOCTURNE has been approved.',
    personalNote ? `\n${personalNote}\n` : '', `Invitation code: ${code}`, `Redeem your invitation: ${redeemUrl}`, '',
    'This invitation is intended for you and may be redeemed once.', '', 'NOCTURNE Festival', 'Presented by Wild Ones · Hawai‘i'
  ].filter(Boolean).join('\n');

  const html = `<!doctype html><html><body style="margin:0;background:#030303;color:#f7efe3;font-family:Arial,sans-serif"><div style="max-width:640px;margin:0 auto;padding:44px 24px"><div style="border:1px solid rgba(216,154,43,.35);background:#080604;padding:38px 30px"><div style="color:#d89a2b;font-size:11px;letter-spacing:3px;text-transform:uppercase">NOCTURNE · Private Invitation</div><h1 style="font-family:Georgia,serif;font-weight:400;font-size:40px;line-height:1.05;color:#fff3df;margin:16px 0 22px">The night has opened<br>for you.</h1><p style="color:#c8baa4;line-height:1.7">${safeName}, your request to enter NOCTURNE has been approved.</p>${safeNote ? `<p style="color:#c8baa4;line-height:1.7">${safeNote}</p>` : ''}<div style="margin:28px 0;padding:18px;text-align:center;border:1px solid rgba(255,202,97,.3);background:#020202;color:#ffca61;font-size:20px;letter-spacing:3px">${safeCode}</div><p style="text-align:center;margin:28px 0"><a href="${escapeHtml(redeemUrl)}" style="display:inline-block;padding:14px 20px;background:#d89a2b;color:#0b0803;text-decoration:none;font-size:12px;letter-spacing:2px;text-transform:uppercase">Redeem Invitation</a></p><p style="color:#8f8372;font-size:12px;line-height:1.7">This invitation is intended for you and may be redeemed once. Keep the code private.</p><div style="margin-top:34px;padding-top:20px;border-top:1px solid rgba(216,154,43,.18);color:#74695b;font-size:11px;letter-spacing:1px;text-transform:uppercase">NOCTURNE Festival · Presented by Wild Ones · Hawai‘i</div></div></div></body></html>`;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.NOCTURNE_EMAIL_FROM, to: [application.email], subject, html, text })
  });

  const responseData = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('NOCTURNE approval email failed:', response.status, responseData);
    return json({ error: responseData.message || 'Approval email could not be sent.' }, 502);
  }

  const now = new Date().toISOString();
  const updatedReview = { ...review, inviteEmailSentAt: now, inviteEmailMessageId: responseData.id || null, updatedAt: now };
  await reviewStore.setJSON(submissionId, updatedReview);
  return json({ ok: true, recipient: application.email, messageId: responseData.id || null, review: updatedReview });
}

function digitalTicketUrl(req, submissionId, ticketId) {
  const token = makeTicketToken(ticketId, submissionId);
  if (!token) return null;
  const siteUrl = (process.env.NOCTURNE_SITE_URL || new URL(req.url).origin).replace(/\/$/, '');
  return `${siteUrl}/ticket?token=${encodeURIComponent(token)}`;
}

async function sendDigitalTicketEmail(req, application, ticket) {
  if (!emailConfigured()) throw new Error('Ticket email is not configured.');
  if (!application?.email) throw new Error('This application does not have an email address.');
  const url = digitalTicketUrl(req, application.id, ticket.ticketId);
  if (!url) throw new Error('Digital ticket signing is not configured.');

  const displayName = application.preferredName || application.fullName || 'Guest';
  const amount = Number(ticket.amountTotal || 0) / 100;
  const currency = String(ticket.currency || 'usd').toUpperCase();
  const amountText = Number.isFinite(amount) && amount > 0 ? `${currency} ${amount.toFixed(2)}` : '';
  const text = [
    `${displayName},`, '', 'Here is your NOCTURNE digital ticket.', '', `Ticket ID: ${ticket.ticketId}`,
    amountText ? `Amount paid: ${amountText}` : '', `Open your digital ticket: ${url}`, '',
    'Keep this ticket private. Present its QR code at event check-in.', '', 'NOCTURNE Festival', 'Presented by Wild Ones · Hawai‘i'
  ].filter(Boolean).join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#030303;color:#f7efe3;font-family:Arial,sans-serif"><div style="max-width:640px;margin:0 auto;padding:44px 24px"><div style="border:1px solid rgba(216,154,43,.35);background:#080604;padding:38px 30px"><div style="color:#d89a2b;font-size:11px;letter-spacing:3px;text-transform:uppercase">NOCTURNE · Digital Ticket</div><h1 style="font-family:Georgia,serif;font-weight:400;font-size:42px;line-height:1.04;color:#fff3df;margin:16px 0 22px">Your ticket<br>is ready.</h1><p style="color:#c8baa4;line-height:1.7">${escapeHtml(displayName)}, here is your NOCTURNE digital ticket.</p><div style="margin:28px 0;padding:18px;border-left:2px solid #d89a2b;background:#020202;color:#d8c7ac;line-height:1.8"><strong>Ticket ID:</strong> ${escapeHtml(ticket.ticketId)}${amountText ? `<br><strong>Amount paid:</strong> ${escapeHtml(amountText)}` : ''}</div><p style="text-align:center;margin:30px 0"><a href="${escapeHtml(url)}" style="display:inline-block;padding:14px 20px;background:#d89a2b;color:#0b0803;text-decoration:none;font-size:12px;letter-spacing:2px;text-transform:uppercase">Open Digital Ticket</a></p><p style="color:#9d907f;line-height:1.7">Keep this ticket private. Present its QR code at event check-in.</p><div style="margin-top:34px;padding-top:20px;border-top:1px solid rgba(216,154,43,.18);color:#74695b;font-size:11px;letter-spacing:1px;text-transform:uppercase">NOCTURNE Festival · Presented by Wild Ones · Hawai‘i</div></div></div></body></html>`;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.NOCTURNE_EMAIL_FROM, to: [application.email], subject: 'Your NOCTURNE Digital Ticket', html, text })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `Resend returned ${response.status}.`);
  return { messageId: data.id || null, digitalTicketUrl: url };
}

async function resendTicketEmail(req, body) {
  const submissionId = String(body.submissionId || '').trim();
  if (!validSubmissionId(submissionId)) return json({ error: 'Invalid submission ID.' }, 400);
  if (!emailConfigured()) return json({ error: 'Ticket email is not configured.' }, 503);

  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const [application, review] = await Promise.all([getApplication(submissionId), reviewStore.get(submissionId, { type: 'json', consistency: 'strong' })]);
  if (!application) return json({ error: 'Application not found.' }, 404);
  const { summary, order, ticket } = await loadTicketData(submissionId, review);
  if (!['paid', 'checked_in'].includes(ticket.state) || !ticket.ticketId || !summary?.stripeCheckoutSessionId) {
    return json({ error: 'Only paid active tickets can be resent.' }, 409);
  }

  try {
    const sent = await sendDigitalTicketEmail(req, application, ticket);
    const now = new Date().toISOString();
    const updatedReview = {
      ...(review || {}),
      digitalTicketUrl: sent.digitalTicketUrl,
      ticketEmailStatus: 'sent',
      ticketEmailSentAt: now,
      ticketEmailMessageId: sent.messageId,
      ticketEmailError: null,
      ticketEmailResentAt: now,
      updatedAt: now
    };
    await reviewStore.setJSON(submissionId, updatedReview);
    if (order) await orderStore.setJSON(summary.stripeCheckoutSessionId, { ...order, digitalTicketUrl: sent.digitalTicketUrl, ticketEmailStatus: 'sent', ticketEmailMessageId: sent.messageId, ticketEmailError: null, ticketEmailResentAt: now, updatedAt: now });
    await orderStore.setJSON(`submission-${submissionId}`, { ...summary, digitalTicketUrl: sent.digitalTicketUrl, updatedAt: now });
    const updatedTicket = ticketRecord({ ...summary, digitalTicketUrl: sent.digitalTicketUrl }, order ? { ...order, ticketEmailStatus: 'sent', ticketEmailMessageId: sent.messageId, digitalTicketUrl: sent.digitalTicketUrl } : order, updatedReview);
    return json({ ok: true, recipient: application.email, review: updatedReview, ticket: updatedTicket });
  } catch (error) {
    console.error('NOCTURNE digital ticket resend failed:', error);
    return json({ error: error.message || 'Digital ticket email could not be sent.' }, 502);
  }
}

async function createStripeRefund(paymentIntentId, submissionId) {
  const response = await fetch('https://api.stripe.com/v1/refunds', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      payment_intent: paymentIntentId,
      reason: 'requested_by_customer',
      'metadata[submissionId]': submissionId,
      'metadata[event]': 'NOCTURNE'
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `Stripe returned ${response.status}.`);
  if (['failed', 'canceled'].includes(data.status)) throw new Error(`Stripe refund ${data.status}.`);
  return data;
}

async function sendRefundEmail(application, ticket, refund) {
  if (!emailConfigured() || !application?.email) return { sent: false, reason: 'Email not configured.' };
  const displayName = application.preferredName || application.fullName || 'Guest';
  const amount = Number(refund.amount || ticket.amountTotal || 0) / 100;
  const currency = String(refund.currency || ticket.currency || 'usd').toUpperCase();
  const text = `${displayName},\n\nYour NOCTURNE ticket has been canceled and a refund was submitted to Stripe.\n\nTicket ID: ${ticket.ticketId}\nRefund: ${currency} ${amount.toFixed(2)}\nRefund reference: ${refund.id}\n\nThe digital ticket is no longer valid for admission. Bank posting times vary by payment method.\n\nNOCTURNE Festival\nPresented by Wild Ones · Hawai‘i`;
  const html = `<!doctype html><html><body style="margin:0;background:#030303;color:#f7efe3;font-family:Arial,sans-serif"><div style="max-width:640px;margin:0 auto;padding:44px 24px"><div style="border:1px solid rgba(216,154,43,.35);background:#080604;padding:38px 30px"><div style="color:#d89a2b;font-size:11px;letter-spacing:3px;text-transform:uppercase">NOCTURNE · Ticket Refunded</div><h1 style="font-family:Georgia,serif;font-weight:400;font-size:42px;line-height:1.04;color:#fff3df;margin:16px 0 22px">Your ticket<br>was canceled.</h1><p style="color:#c8baa4;line-height:1.7">${escapeHtml(displayName)}, a refund for your NOCTURNE ticket was submitted to Stripe.</p><div style="margin:28px 0;padding:18px;border-left:2px solid #d89a2b;background:#020202;color:#d8c7ac;line-height:1.8"><strong>Ticket ID:</strong> ${escapeHtml(ticket.ticketId)}<br><strong>Refund:</strong> ${escapeHtml(currency)} ${amount.toFixed(2)}<br><strong>Refund reference:</strong> ${escapeHtml(refund.id)}</div><p style="color:#9d907f;line-height:1.7">The digital ticket is no longer valid for admission. Bank posting times vary by payment method.</p><div style="margin-top:34px;padding-top:20px;border-top:1px solid rgba(216,154,43,.18);color:#74695b;font-size:11px;letter-spacing:1px;text-transform:uppercase">NOCTURNE Festival · Presented by Wild Ones · Hawai‘i</div></div></div></body></html>`;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.NOCTURNE_EMAIL_FROM, to: [application.email], subject: 'Your NOCTURNE Ticket Refund', html, text })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `Resend returned ${response.status}.`);
  return { sent: true, messageId: data.id || null };
}

async function refundTicket(body) {
  if (!refundConfigured()) return json({ error: 'Stripe refunds are not configured.' }, 503);
  const submissionId = String(body.submissionId || '').trim();
  if (!validSubmissionId(submissionId)) return json({ error: 'Invalid submission ID.' }, 400);

  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const [application, review] = await Promise.all([getApplication(submissionId), reviewStore.get(submissionId, { type: 'json', consistency: 'strong' })]);
  if (!application) return json({ error: 'Application not found.' }, 404);
  const { summary, order, ticket } = await loadTicketData(submissionId, review);
  if (ticket.state === 'refunded') return json({ error: 'This ticket has already been refunded.' }, 409);
  if (ticket.state === 'checked_in') return json({ error: 'Checked-in tickets cannot be refunded from the NOCTURNE dashboard. Handle exceptional cases directly in Stripe.' }, 409);
  if (ticket.state !== 'paid' || !ticket.stripePaymentIntentId || !summary?.stripeCheckoutSessionId) return json({ error: 'No refundable paid ticket is recorded.' }, 409);
  if (String(body.confirmTicketId || '').trim() !== ticket.ticketId) return json({ error: 'Ticket confirmation did not match.' }, 400);

  let refund;
  try {
    refund = await createStripeRefund(ticket.stripePaymentIntentId, submissionId);
  } catch (error) {
    console.error('NOCTURNE Stripe refund failed:', error);
    return json({ error: error.message || 'Stripe refund failed.' }, 502);
  }

  const now = new Date().toISOString();
  let refundEmailStatus = 'not_sent';
  let refundEmailMessageId = null;
  let refundEmailError = null;
  try {
    const sent = await sendRefundEmail(application, ticket, refund);
    refundEmailStatus = sent.sent ? 'sent' : 'not_configured';
    refundEmailMessageId = sent.messageId || null;
    refundEmailError = sent.reason || null;
  } catch (error) {
    console.error('NOCTURNE refund email failed:', error);
    refundEmailStatus = 'failed';
    refundEmailError = String(error?.message || error).slice(0, 500);
  }

  const common = {
    status: 'refunded',
    stripeRefundId: refund.id,
    refundStatus: refund.status || 'submitted',
    refundedAt: now,
    refundedAmount: refund.amount ?? ticket.amountTotal ?? null,
    refundEmailStatus,
    refundEmailMessageId,
    refundEmailError,
    updatedAt: now
  };

  const updatedSummary = { ...summary, ...common };
  await orderStore.setJSON(`submission-${submissionId}`, updatedSummary);
  if (order) await orderStore.setJSON(summary.stripeCheckoutSessionId, { ...order, ...common });
  const updatedReview = {
    ...(review || {}),
    ticketState: 'refunded',
    ticketRefundedAt: now,
    stripeRefundId: refund.id,
    refundStatus: refund.status || 'submitted',
    refundEmailStatus,
    refundEmailSentAt: refundEmailStatus === 'sent' ? now : null,
    refundEmailMessageId,
    refundEmailError,
    updatedAt: now
  };
  await reviewStore.setJSON(submissionId, updatedReview);

  return json({
    ok: true,
    review: updatedReview,
    ticket: ticketRecord(updatedSummary, order ? { ...order, ...common } : null, updatedReview),
    refund: { id: refund.id, status: refund.status || 'submitted', amount: refund.amount ?? null, currency: refund.currency || ticket.currency }
  });
}

export default async (req) => {
  const url = new URL(req.url);
  const action = url.searchParams.get('action') || '';

  if (req.method === 'POST') {
    if (!allowedPostOrigin(req)) return json({ error: 'Origin not allowed.' }, 403);

    const body = await readBody(req);
    if (!body) return json({ error: 'Invalid JSON body.' }, 400);

    const bodyAction = String(body.action || action || '');
    if (bodyAction === 'login') {
      const adminKey = process.env.NOCTURNE_ADMIN_KEY || '';
      if (!adminKey || !sessionSecret()) return json({ error: 'Admin authentication is not configured.' }, 500);
      if (!constantTimeEqual(body.password || '', adminKey)) return json({ error: 'Invalid admin password.' }, 401);
      return json({ ok: true, expiresIn: SESSION_TTL_SECONDS }, 200, { 'Set-Cookie': setSessionCookie(makeSessionToken()) });
    }

    if (bodyAction === 'logout') return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
    if (!hasValidSession(req)) return json({ error: 'Unauthorized.' }, 401);
    if (bodyAction === 'review') return saveReview(body);
    if (bodyAction === 'generate-invite') return generateInvite(body);
    if (bodyAction === 'revoke-invite') return revokeInvite(body);
    if (bodyAction === 'regenerate-invite') return regenerateInvite(body);
    if (bodyAction === 'send-approval-email') return sendApprovalEmail(req, body);
    if (bodyAction === 'resend-ticket-email') return resendTicketEmail(req, body);
    if (bodyAction === 'refund-ticket') return refundTicket(body);
    return json({ error: 'Unknown action.' }, 400);
  }

  if (req.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
  if (!hasValidSession(req)) return json({ authenticated: false }, 401);
  if (action === 'session') return json({ authenticated: true, emailConfigured: emailConfigured(), refundConfigured: refundConfigured() });

  if (action === 'applications') {
    try {
      const result = await getApplications();
      return json({
        ...result,
        stats: summarize(result.applications),
        ticketStats: summarizeTickets(result.applications),
        capabilities: { emailConfigured: emailConfigured(), refundConfigured: refundConfigured() }
      });
    } catch (error) {
      console.error('NOCTURNE admin application load failed:', error);
      return json({ error: error.message || 'Could not load applications.' }, 502);
    }
  }

  return json({ authenticated: true, emailConfigured: emailConfigured(), refundConfigured: refundConfigured() });
};
