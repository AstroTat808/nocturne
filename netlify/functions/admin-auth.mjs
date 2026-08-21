import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION_COOKIE = 'nocturne_admin';
const SESSION_TTL_SECONDS = 8 * 60 * 60;

function constantTimeEqual(a = '', b = '') {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function sessionSecret() {
  return process.env.NOCTURNE_ADMIN_SESSION_SECRET || process.env.NOCTURNE_ADMIN_KEY || '';
}

function sign(value) {
  return createHmac('sha256', sessionSecret()).update(value).digest('base64url');
}

function makeSessionToken() {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    role: 'admin',
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
    nonce: randomBytes(12).toString('base64url')
  })).toString('base64url');
  return `${payload}.${sign(payload)}`;
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

function allowedOrigin(req) {
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

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders
    }
  });
}

async function readBody(req) {
  const type = (req.headers.get('content-type') || '').toLowerCase();
  if (type.includes('application/json')) {
    try { return await req.json(); } catch { return null; }
  }
  try {
    const text = await req.text();
    const params = new URLSearchParams(text);
    return Object.fromEntries(params.entries());
  } catch {
    return null;
  }
}

function isBrowserForm(req) {
  const type = (req.headers.get('content-type') || '').toLowerCase();
  return type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data');
}

function redirect(location, cookie = null) {
  const headers = { Location: location, 'Cache-Control': 'no-store' };
  if (cookie) headers['Set-Cookie'] = cookie;
  return new Response(null, { status: 303, headers });
}

export default async (req) => {
  try {
    const url = new URL(req.url);

    if (req.method === 'GET') {
      if (!hasValidSession(req)) return json({ authenticated: false }, 401);
      return json({ authenticated: true, expiresIn: SESSION_TTL_SECONDS });
    }

    if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405, { Allow: 'GET, POST' });
    if (!allowedOrigin(req)) return json({ error: 'Origin not allowed.' }, 403);

    const body = await readBody(req);
    if (!body) return json({ error: 'Invalid request body.' }, 400);
    const action = String(body.action || 'login');

    if (action === 'logout') {
      if (isBrowserForm(req)) return redirect('/admin', clearSessionCookie());
      return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
    }

    if (action !== 'login') return json({ error: 'Unknown action.' }, 400);

    const adminKey = process.env.NOCTURNE_ADMIN_KEY || '';
    if (!adminKey || !sessionSecret()) return json({ error: 'Admin authentication is not configured.' }, 500);
    if (!constantTimeEqual(body.password || '', adminKey)) {
      if (isBrowserForm(req)) return redirect('/admin?auth=failed');
      return json({ error: 'Invalid admin password.' }, 401);
    }

    const cookie = setSessionCookie(makeSessionToken());
    if (isBrowserForm(req)) return redirect('/admin', cookie);
    return json({ ok: true, expiresIn: SESSION_TTL_SECONDS }, 200, { 'Set-Cookie': cookie });
  } catch (error) {
    console.error('NOCTURNE admin auth failed:', error);
    return json({ error: 'Admin authentication service failed.' }, 500);
  }
};
