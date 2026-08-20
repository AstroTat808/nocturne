import { getStore } from '@netlify/blobs';
import { createHash, createHmac, randomBytes } from 'node:crypto';

const STORE_NAME = 'nocturne-invites';
const REVIEW_STORE = 'nocturne-application-reviews';
const ACCESS_COOKIE = 'nocturne_ticket_access';
const ACCESS_TTL_SECONDS = 30 * 60;

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

function normalizeCode(code) {
  return String(code).trim().toUpperCase().replace(/\s+/g, '');
}

function hashCode(code) {
  return createHash('sha256').update(normalizeCode(code)).digest('hex');
}

function accessSecret() {
  return process.env.NOCTURNE_TICKET_ACCESS_SECRET || process.env.NOCTURNE_ADMIN_SESSION_SECRET || process.env.NOCTURNE_ADMIN_KEY || '';
}

function sign(payload) {
  return createHmac('sha256', accessSecret()).update(payload).digest('base64url');
}

function makeAccessCookie(sourceSubmissionId = '') {
  if (!accessSecret()) return null;
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    scope: 'ticket-access',
    submissionId: sourceSubmissionId,
    iat: now,
    exp: now + ACCESS_TTL_SECONDS,
    nonce: randomBytes(10).toString('base64url')
  })).toString('base64url');
  const token = `${payload}.${sign(payload)}`;
  return `${ACCESS_COOKIE}=${encodeURIComponent(token)}; Path=/ticket-access; HttpOnly; Secure; SameSite=Strict; Max-Age=${ACCESS_TTL_SECONDS}`;
}

async function readCode(req) {
  const contentType = (req.headers.get('content-type') || '').toLowerCase();

  if (contentType.includes('application/json')) {
    const body = await req.json();
    return normalizeCode(body?.code || '');
  }

  if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
    const form = await req.formData();
    return normalizeCode(form.get('code') || '');
  }

  throw new Error('Unsupported request type.');
}

function isBrowserFormPost(req) {
  const contentType = (req.headers.get('content-type') || '').toLowerCase();
  return !req.headers.get('x-nocturne-ajax') && (
    contentType.includes('application/x-www-form-urlencoded') ||
    contentType.includes('multipart/form-data')
  );
}

function browserRedirect(location, extraHeaders = {}) {
  return new Response(null, {
    status: 303,
    headers: {
      Location: location,
      'Cache-Control': 'no-store',
      ...extraHeaders
    }
  });
}

function failure(req, message, status) {
  if (isBrowserFormPost(req)) {
    return browserRedirect(`/invite?error=${encodeURIComponent(message)}`);
  }
  return json({ error: message }, status);
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const origin = req.headers.get('origin');
  const requestOrigin = new URL(req.url).origin;
  if (origin && origin !== requestOrigin) return failure(req, 'Origin not allowed.', 403);

  let code;
  try {
    code = await readCode(req);
  } catch {
    return failure(req, 'Invalid request.', 400);
  }

  if (!/^NOC-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)) {
    return failure(req, 'That invitation code is not valid.', 400);
  }

  const store = getStore({ name: STORE_NAME, consistency: 'strong' });
  const key = hashCode(code);
  const entry = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });

  if (!entry) return failure(req, 'Invitation not found or no longer active.', 404);

  const invite = entry.data;
  if (invite.used) return failure(req, 'This invitation has already been redeemed.', 410);

  if (invite.expiresAt && Date.now() > new Date(invite.expiresAt).getTime()) {
    return failure(req, 'This invitation has expired.', 410);
  }

  const configuredTicketUrl = invite.purchaseUrl || process.env.NOCTURNE_TICKET_URL || '';
  const usingTemporaryAccess = !configuredTicketUrl;
  const ticketUrl = configuredTicketUrl || '/ticket-access';

  if (!usingTemporaryAccess && !/^https:\/\//i.test(ticketUrl)) {
    return failure(req, 'Ticket access URL is not valid.', 503);
  }

  if (usingTemporaryAccess && !accessSecret()) {
    return failure(req, 'Temporary ticket access is not configured.', 503);
  }

  const usedAt = new Date().toISOString();
  const result = await store.setJSON(
    key,
    { ...invite, used: true, usedAt },
    { onlyIfMatch: entry.etag }
  );

  if (!result.modified) return failure(req, 'This invitation was just redeemed elsewhere.', 409);

  if (invite.sourceSubmissionId) {
    try {
      const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
      const review = await reviewStore.get(invite.sourceSubmissionId, { type: 'json', consistency: 'strong' });
      if (review) {
        await reviewStore.setJSON(invite.sourceSubmissionId, {
          ...review,
          inviteState: 'redeemed',
          inviteRedeemedAt: usedAt,
          updatedAt: usedAt
        });
      }
    } catch (error) {
      console.error('NOCTURNE review redemption sync failed:', error);
    }
  }

  const headers = {};
  if (usingTemporaryAccess) {
    const cookie = makeAccessCookie(invite.sourceSubmissionId || '');
    if (cookie) headers['Set-Cookie'] = cookie;
  }

  if (isBrowserFormPost(req)) {
    return browserRedirect(ticketUrl, headers);
  }

  return json({
    ok: true,
    message: 'Invitation accepted.',
    ticketUrl,
    temporaryAccess: usingTemporaryAccess
  }, 200, headers);
};
