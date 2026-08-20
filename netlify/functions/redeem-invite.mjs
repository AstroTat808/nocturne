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

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const origin = req.headers.get('origin');
  const requestOrigin = new URL(req.url).origin;
  if (origin && origin !== requestOrigin) return json({ error: 'Origin not allowed.' }, 403);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }

  const code = normalizeCode(body.code || '');
  if (!/^NOC-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)) {
    return json({ error: 'That invitation code is not valid.' }, 400);
  }

  const store = getStore({ name: STORE_NAME, consistency: 'strong' });
  const key = hashCode(code);
  const entry = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });

  if (!entry) return json({ error: 'Invitation not found or no longer active.' }, 404);

  const invite = entry.data;
  if (invite.used) return json({ error: 'This invitation has already been redeemed.' }, 410);

  if (invite.expiresAt && Date.now() > new Date(invite.expiresAt).getTime()) {
    return json({ error: 'This invitation has expired.' }, 410);
  }

  const configuredTicketUrl = invite.purchaseUrl || process.env.NOCTURNE_TICKET_URL || '';
  const usingTemporaryAccess = !configuredTicketUrl;
  const ticketUrl = configuredTicketUrl || '/ticket-access';

  if (!usingTemporaryAccess && !/^https:\/\//i.test(ticketUrl)) {
    return json({ error: 'Ticket access URL is not valid.' }, 503);
  }

  if (usingTemporaryAccess && !accessSecret()) {
    return json({ error: 'Temporary ticket access is not configured.' }, 503);
  }

  const result = await store.setJSON(
    key,
    { ...invite, used: true, usedAt: new Date().toISOString() },
    { onlyIfMatch: entry.etag }
  );

  if (!result.modified) return json({ error: 'This invitation was just redeemed elsewhere.' }, 409);

  if (invite.sourceSubmissionId) {
    try {
      const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
      const review = await reviewStore.get(invite.sourceSubmissionId, { type: 'json', consistency: 'strong' });
      if (review) {
        await reviewStore.setJSON(invite.sourceSubmissionId, {
          ...review,
          inviteState: 'redeemed',
          inviteRedeemedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
      }
    } catch (error) {
      console.error('NOCTURNE review redemption sync failed:', error);
    }
  }

  const headers = {};
  if (usingTemporaryAccess) headers['Set-Cookie'] = makeAccessCookie(invite.sourceSubmissionId || '');

  return json({
    ok: true,
    message: 'Invitation accepted.',
    ticketUrl,
    temporaryAccess: usingTemporaryAccess
  }, 200, headers);
};
