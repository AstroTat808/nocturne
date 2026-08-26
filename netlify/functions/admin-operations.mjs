import { getStore } from '@netlify/blobs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readAudit } from './_audit.mjs';
import { summarizeOperations } from './_operations-metrics.mjs';

const APPLICATION_STORE = 'nocturne-applications';
const ORDER_STORE = 'nocturne-ticket-orders';
const REDEMPTION_STORE = 'nocturne-drink-redemptions';
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

function safeEqual(a = '', b = '') {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function authenticated(req) {
  const secret = sessionSecret();
  if (!secret) return false;
  const cookies = Object.fromEntries((req.headers.get('cookie') || '').split(';').map((part) => {
    const index = part.indexOf('=');
    if (index < 0) return ['', ''];
    let value = part.slice(index + 1).trim();
    try { value = decodeURIComponent(value); } catch {}
    return [part.slice(0, index).trim(), value];
  }).filter(([key]) => key));
  const token = cookies[SESSION_COOKIE];
  if (!token?.includes('.')) return false;
  const [payload, signature] = token.split('.', 2);
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (!safeEqual(signature, expected)) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return parsed.role === 'admin' && Number(parsed.exp) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

async function loadSummaries() {
  const store = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const { blobs } = await store.list();
  const keys = blobs.map(({ key }) => key).filter((key) => key.startsWith('submission-'));
  const records = await Promise.all(keys.map((key) => store.get(key, { type: 'json', consistency: 'strong' })));
  return records.filter(Boolean);
}

async function loadRedemptions() {
  const store = getStore({ name: REDEMPTION_STORE, consistency: 'strong' });
  const { blobs } = await store.list();
  const keys = blobs.map(({ key }) => key).filter((key) => key.startsWith('redemption-'));
  const records = await Promise.all(keys.map((key) => store.get(key, { type: 'json', consistency: 'strong' })));
  return records.filter(Boolean);
}

async function loadGuestNames(summaries) {
  const applicationStore = getStore({ name: APPLICATION_STORE, consistency: 'strong' });
  const ids = [...new Set(summaries.map((summary) => summary?.submissionId).filter(Boolean))];
  const entries = await Promise.all(ids.map(async (id) => [id, await applicationStore.get(id, { type: 'json', consistency: 'strong' })]));
  return Object.fromEntries(entries.map(([id, application]) => [id, application?.preferredName || application?.fullName || 'NOCTURNE Guest']));
}

export default async (req) => {
  if (req.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
  if (!authenticated(req)) return json({ error: 'Admin session expired. Sign in again.' }, 401);

  try {
    const [summaries, redemptions, audits] = await Promise.all([
      loadSummaries(),
      loadRedemptions(),
      readAudit(1000)
    ]);
    const guestNames = await loadGuestNames(summaries);
    const metrics = summarizeOperations({ summaries, redemptions, audits, guestNames });
    return json({
      ok: true,
      generatedAt: new Date().toISOString(),
      ...metrics
    });
  } catch (error) {
    console.error('NOCTURNE live operations load failed:', error);
    return json({ error: error.message || 'Could not load live operations.' }, 502);
  }
};
