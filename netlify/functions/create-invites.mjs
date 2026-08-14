import { getStore } from '@netlify/blobs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

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

function constantTimeEqual(a = '', b = '') {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
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

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const adminKey = process.env.NOCTURNE_ADMIN_KEY;
  if (!adminKey) return json({ error: 'Admin key is not configured.' }, 500);

  const auth = req.headers.get('authorization') || '';
  const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!constantTimeEqual(supplied, adminKey)) return json({ error: 'Unauthorized.' }, 401);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body.' }, 400);
  }

  const count = Math.min(Math.max(Number(body.count || 1), 1), 100);
  const label = String(body.label || 'Approved guest').slice(0, 120);
  const expiresAt = body.expiresAt
    ? new Date(body.expiresAt)
    : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  if (Number.isNaN(expiresAt.getTime())) return json({ error: 'Invalid expiresAt.' }, 400);

  const purchaseUrl = body.purchaseUrl ? String(body.purchaseUrl) : null;
  if (purchaseUrl && !/^https:\/\//i.test(purchaseUrl)) {
    return json({ error: 'purchaseUrl must use https.' }, 400);
  }

  const store = getStore({ name: STORE_NAME, consistency: 'strong' });
  const created = [];

  for (let i = 0; i < count; i++) {
    let code;
    let hash;
    let saved = false;
    for (let tries = 0; tries < 5 && !saved; tries++) {
      code = makeCode();
      hash = hashCode(code);
      const result = await store.setJSON(
        hash,
        {
          label,
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
    if (!saved) return json({ error: 'Could not create a unique invite code.' }, 500);
    created.push({ code, label, expiresAt: expiresAt.toISOString() });
  }

  return json({
    created: created.length,
    invites: created,
    note: 'Store these raw codes securely. Only their hashes are persisted in Netlify Blobs.'
  }, 201);
};
