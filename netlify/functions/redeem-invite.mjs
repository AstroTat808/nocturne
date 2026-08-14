import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';

const STORE_NAME = 'nocturne-invites';

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

function normalizeCode(code) {
  return String(code).trim().toUpperCase().replace(/\s+/g, '');
}

function hashCode(code) {
  return createHash('sha256').update(normalizeCode(code)).digest('hex');
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

  const ticketUrl = invite.purchaseUrl || process.env.NOCTURNE_TICKET_URL;
  if (!ticketUrl || !/^https:\/\//i.test(ticketUrl)) {
    return json({ error: 'Ticket access is not configured yet.' }, 503);
  }

  const result = await store.setJSON(
    key,
    { ...invite, used: true, usedAt: new Date().toISOString() },
    { onlyIfMatch: entry.etag }
  );

  if (!result.modified) return json({ error: 'This invitation was just redeemed elsewhere.' }, 409);

  return json({
    ok: true,
    message: 'Invitation accepted.',
    ticketUrl
  });
};
