import { getStore } from '@netlify/blobs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  activeEmailRateLock,
  applicationEmailRateKey,
  applicationPhoneDigits,
  matchApplicationIdentity,
  normalizeApplicationEmail
} from './_application-identity.mjs';

const APPLICATION_STORE = 'nocturne-applications';
const RATE_STORE = 'nocturne-application-rate-limits';
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

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  if (!authenticated(req)) return json({ error: 'Unauthorized.' }, 401);
  if (!allowedOrigin(req)) return json({ error: 'Origin not allowed.' }, 403);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid request.' }, 400); }

  const email = normalizeApplicationEmail(body?.email);
  const phone = applicationPhoneDigits(body?.phone);
  if (!email && !phone) return json({ error: 'Enter an email address or phone number.' }, 400);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Enter a valid email address.' }, 400);
  if (body?.phone && phone.length !== 10) return json({ error: 'Enter a valid 10-digit phone number.' }, 400);

  try {
    const applicationStore = getStore({ name: APPLICATION_STORE, consistency: 'strong' });
    const rateStore = getStore({ name: RATE_STORE, consistency: 'strong' });
    const [{ blobs }, rateState] = await Promise.all([
      applicationStore.list(),
      email ? rateStore.get(applicationEmailRateKey(email), { type: 'json' }) : Promise.resolve(null)
    ]);

    const records = await mapLimit(Array.isArray(blobs) ? blobs : [], 8, async ({ key }) => {
      const application = await applicationStore.get(key, { type: 'json' });
      if (!application) return null;
      const matched = matchApplicationIdentity(application, { email, phone });
      if (!matched.emailMatches && !matched.phoneMatches) return null;
      return {
        id: application.id || key,
        fullName: application.fullName || '',
        email: application.email || '',
        phone: application.phone || '',
        createdAt: application.createdAt || null,
        matchedBy: [matched.emailMatches ? 'email' : '', matched.phoneMatches ? 'phone' : ''].filter(Boolean)
      };
    });

    const matches = records.filter(Boolean);
    const emailMatches = matches.filter((record) => record.matchedBy.includes('email')).length;
    const phoneMatches = matches.filter((record) => record.matchedBy.includes('phone')).length;
    const emailRateLock = activeEmailRateLock(rateState);

    console.info('NOCTURNE application identity diagnostic completed.', {
      emailChecked: Boolean(email),
      phoneChecked: Boolean(phone),
      emailMatches,
      phoneMatches,
      emailRateLocked: emailRateLock.active
    });

    return json({
      checked: { email: email || null, phone: phone || null },
      blocked: matches.length > 0 || emailRateLock.active,
      permanentDuplicateBlocked: matches.length > 0,
      emailMatches,
      phoneMatches,
      matches,
      emailRateLock
    });
  } catch (error) {
    console.error('NOCTURNE application identity diagnostic failed:', error);
    return json({ error: 'The live application records could not be checked completely.' }, 502);
  }
};
