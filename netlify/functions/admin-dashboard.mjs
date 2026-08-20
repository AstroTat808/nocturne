import { getStore } from '@netlify/blobs';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const APPLICATION_STORE = 'nocturne-applications';
const REVIEW_STORE = 'nocturne-application-reviews';
const INVITE_STORE = 'nocturne-invites';
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
        return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
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

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
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

async function getApplications() {
  const applicationStore = getStore({ name: APPLICATION_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const { blobs } = await applicationStore.list();

  const applications = await Promise.all(
    blobs.map(async ({ key }) => {
      const application = await applicationStore.get(key, { type: 'json', consistency: 'strong' });
      const review = await reviewStore.get(key, { type: 'json', consistency: 'strong' });
      if (!application) return null;

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

async function saveReview(body) {
  const submissionId = String(body.submissionId || '').trim();
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(submissionId)) {
    return json({ error: 'Invalid submission ID.' }, 400);
  }

  const status = String(body.status || 'pending').toLowerCase();
  if (!REVIEW_STATUSES.has(status)) {
    return json({ error: 'Invalid review status.' }, 400);
  }

  let score = body.score;
  if (score === '' || score === undefined || score === null) {
    score = null;
  } else {
    score = Number(score);
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      return json({ error: 'Score must be between 1 and 5.' }, 400);
    }
  }

  const notes = String(body.notes || '').slice(0, 5000);
  const store = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const current = await store.get(submissionId, { type: 'json', consistency: 'strong' }) || {};
  const review = { ...current, status, score, notes, updatedAt: new Date().toISOString() };
  await store.setJSON(submissionId, review);
  return json({ ok: true, review });
}

async function createInvite(submissionId, label, { replace = false } = {}) {
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(submissionId)) {
    return { error: 'Invalid submission ID.', status: 400 };
  }

  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const inviteStore = getStore({ name: INVITE_STORE, consistency: 'strong' });
  const review = await reviewStore.get(submissionId, { type: 'json', consistency: 'strong' });

  if (!review || review.status !== 'approved') {
    return { error: 'Application must be approved before creating an invite.', status: 409 };
  }

  if (review.inviteHash && review.inviteState === 'active' && !replace) {
    return { error: 'An active invitation already exists for this application.', status: 409 };
  }

  if (replace && review.inviteHash) {
    await inviteStore.delete(review.inviteHash);
  }

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

  return json({
    ok: true,
    ...result,
    note: 'Copy this code now. The raw code is not stored in the review record.'
  }, 201);
}

async function revokeInvite(body) {
  const submissionId = String(body.submissionId || '').trim();
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(submissionId)) {
    return json({ error: 'Invalid submission ID.' }, 400);
  }

  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const inviteStore = getStore({ name: INVITE_STORE, consistency: 'strong' });
  const review = await reviewStore.get(submissionId, { type: 'json', consistency: 'strong' });

  if (!review?.inviteHash) return json({ error: 'No revocable invitation is recorded for this applicant.' }, 409);
  if (review.inviteState === 'revoked') return json({ error: 'This invitation is already revoked.' }, 409);

  await inviteStore.delete(review.inviteHash);
  const now = new Date().toISOString();
  const updatedReview = {
    ...review,
    inviteState: 'revoked',
    inviteRevokedAt: now,
    updatedAt: now
  };
  await reviewStore.setJSON(submissionId, updatedReview);
  return json({ ok: true, review: updatedReview });
}

async function regenerateInvite(body) {
  const submissionId = String(body.submissionId || '').trim();
  const result = await createInvite(submissionId, body.label, { replace: true });
  if (result.error) return json({ error: result.error }, result.status);

  return json({
    ok: true,
    ...result,
    note: 'The previous invitation was invalidated. Copy the replacement code now.'
  }, 201);
}

async function sendApprovalEmail(req, body) {
  if (!emailConfigured()) {
    return json({
      error: 'Direct email is not configured. Add RESEND_API_KEY and NOCTURNE_EMAIL_FROM in Netlify.'
    }, 503);
  }

  const submissionId = String(body.submissionId || '').trim();
  const code = normalizeCode(body.code || '');
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(submissionId)) return json({ error: 'Invalid submission ID.' }, 400);
  if (!/^NOC-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)) return json({ error: 'Invalid invitation code.' }, 400);

  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const review = await reviewStore.get(submissionId, { type: 'json', consistency: 'strong' });
  if (!review || review.status !== 'approved' || review.inviteState !== 'active' || !review.inviteHash) {
    return json({ error: 'The applicant must have an active approved invitation before email can be sent.' }, 409);
  }
  if (!constantTimeEqual(hashCode(code), review.inviteHash)) {
    return json({ error: 'The supplied invitation code does not match the active invite.' }, 409);
  }

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
    `${displayName},`,
    '',
    'Your request to enter NOCTURNE has been approved.',
    personalNote ? `\n${personalNote}\n` : '',
    `Invitation code: ${code}`,
    `Redeem your invitation: ${redeemUrl}`,
    '',
    'This invitation is intended for you and may be redeemed once.',
    '',
    'NOCTURNE Festival',
    'Presented by Wild Ones · Hawai‘i'
  ].filter(Boolean).join('\n');

  const html = `<!doctype html><html><body style="margin:0;background:#030303;color:#f7efe3;font-family:Arial,sans-serif"><div style="max-width:640px;margin:0 auto;padding:44px 24px"><div style="border:1px solid rgba(216,154,43,.35);background:#080604;padding:38px 30px"><div style="color:#d89a2b;font-size:11px;letter-spacing:3px;text-transform:uppercase">NOCTURNE · Private Invitation</div><h1 style="font-family:Georgia,serif;font-weight:400;font-size:40px;line-height:1.05;color:#fff3df;margin:16px 0 22px">The night has opened<br>for you.</h1><p style="color:#c8baa4;line-height:1.7">${safeName}, your request to enter NOCTURNE has been approved.</p>${safeNote ? `<p style="color:#c8baa4;line-height:1.7">${safeNote}</p>` : ''}<div style="margin:28px 0;padding:18px;text-align:center;border:1px solid rgba(255,202,97,.3);background:#020202;color:#ffca61;font-size:20px;letter-spacing:3px">${safeCode}</div><p style="text-align:center;margin:28px 0"><a href="${escapeHtml(redeemUrl)}" style="display:inline-block;padding:14px 20px;background:#d89a2b;color:#0b0803;text-decoration:none;font-size:12px;letter-spacing:2px;text-transform:uppercase">Redeem Invitation</a></p><p style="color:#8f8372;font-size:12px;line-height:1.7">This invitation is intended for you and may be redeemed once. Keep the code private.</p><div style="margin-top:34px;padding-top:20px;border-top:1px solid rgba(216,154,43,.18);color:#74695b;font-size:11px;letter-spacing:1px;text-transform:uppercase">NOCTURNE Festival · Presented by Wild Ones · Hawai‘i</div></div></div></body></html>`;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: process.env.NOCTURNE_EMAIL_FROM,
      to: [application.email],
      subject,
      html,
      text
    })
  });

  const responseData = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('NOCTURNE approval email failed:', response.status, responseData);
    return json({ error: responseData.message || 'Approval email could not be sent.' }, 502);
  }

  const now = new Date().toISOString();
  const updatedReview = {
    ...review,
    inviteEmailSentAt: now,
    inviteEmailMessageId: responseData.id || null,
    updatedAt: now
  };
  await reviewStore.setJSON(submissionId, updatedReview);

  return json({
    ok: true,
    recipient: application.email,
    messageId: responseData.id || null,
    review: updatedReview
  });
}

export default async (req) => {
  const url = new URL(req.url);
  const action = url.searchParams.get('action') || '';

  if (req.method === 'POST') {
    const body = await readBody(req);
    if (!body) return json({ error: 'Invalid JSON body.' }, 400);

    const bodyAction = String(body.action || action || '');
    if (bodyAction === 'login') {
      const adminKey = process.env.NOCTURNE_ADMIN_KEY || '';
      if (!adminKey || !sessionSecret()) {
        return json({ error: 'Admin authentication is not configured.' }, 500);
      }
      if (!constantTimeEqual(body.password || '', adminKey)) {
        return json({ error: 'Invalid admin password.' }, 401);
      }
      return json(
        { ok: true, expiresIn: SESSION_TTL_SECONDS },
        200,
        { 'Set-Cookie': setSessionCookie(makeSessionToken()) }
      );
    }

    if (bodyAction === 'logout') {
      return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
    }

    if (!hasValidSession(req)) return json({ error: 'Unauthorized.' }, 401);
    if (bodyAction === 'review') return saveReview(body);
    if (bodyAction === 'generate-invite') return generateInvite(body);
    if (bodyAction === 'revoke-invite') return revokeInvite(body);
    if (bodyAction === 'regenerate-invite') return regenerateInvite(body);
    if (bodyAction === 'send-approval-email') return sendApprovalEmail(req, body);
    return json({ error: 'Unknown action.' }, 400);
  }

  if (req.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
  if (!hasValidSession(req)) return json({ authenticated: false }, 401);
  if (action === 'session') return json({ authenticated: true, emailConfigured: emailConfigured() });

  if (action === 'applications') {
    try {
      const result = await getApplications();
      return json({
        ...result,
        stats: summarize(result.applications),
        capabilities: { emailConfigured: emailConfigured() }
      });
    } catch (error) {
      console.error('NOCTURNE admin application load failed:', error);
      return json({ error: error.message || 'Could not load applications.' }, 502);
    }
  }

  return json({ authenticated: true, emailConfigured: emailConfigured() });
};
