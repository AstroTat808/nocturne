import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const ACCESS_COOKIE = 'nocturne_ticket_access';
const ACCESS_SCOPE = 'ticket-access';
const REENTRY_SCOPE = 'ticket-reentry';

export function accessSecret() {
  return process.env.NOCTURNE_TICKET_ACCESS_SECRET || process.env.NOCTURNE_ADMIN_SESSION_SECRET || process.env.NOCTURNE_ADMIN_KEY || '';
}

function clampedHours(value, fallback = 168) {
  const configured = Number(value);
  const hours = Number.isFinite(configured) ? Math.min(Math.max(configured, 1), 720) : fallback;
  return hours;
}

export function accessTtlSeconds() {
  return Math.floor(clampedHours(process.env.NOCTURNE_TICKET_ACCESS_TTL_HOURS || 168) * 60 * 60);
}

export function reentryTtlSeconds() {
  return Math.floor(clampedHours(process.env.NOCTURNE_TICKET_REENTRY_TTL_HOURS || process.env.NOCTURNE_TICKET_ACCESS_TTL_HOURS || 168) * 60 * 60);
}

function sign(payload) {
  return createHmac('sha256', accessSecret()).update(payload).digest('base64url');
}

function constantTimeEqual(a = '', b = '') {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function makeScopedToken(scope, submissionId, ttlSeconds) {
  if (!accessSecret()) return null;
  const id = String(submissionId || '').trim();
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(id)) return null;

  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    scope,
    submissionId: id,
    iat: now,
    exp: now + ttlSeconds,
    nonce: randomBytes(10).toString('base64url')
  })).toString('base64url');

  return `${payload}.${sign(payload)}`;
}

function verifyScopedToken(token, scope) {
  if (!accessSecret() || !token || !String(token).includes('.')) return null;
  const [payload, signature] = String(token).split('.', 2);
  if (!constantTimeEqual(signature, sign(payload))) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.scope !== scope) return null;
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(String(data.submissionId || ''))) return null;
    if (Number(data.exp) <= Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

export function makeAccessToken(submissionId, ttlSeconds = accessTtlSeconds()) {
  return makeScopedToken(ACCESS_SCOPE, submissionId, ttlSeconds);
}

export function verifyAccessToken(token) {
  return verifyScopedToken(token, ACCESS_SCOPE);
}

export function makeReentryToken(submissionId, ttlSeconds = reentryTtlSeconds()) {
  return makeScopedToken(REENTRY_SCOPE, submissionId, ttlSeconds);
}

export function verifyReentryToken(token) {
  return verifyScopedToken(token, REENTRY_SCOPE);
}

export function parseCookies(req) {
  const header = req.headers.get('cookie') || '';
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => {
        const index = part.indexOf('=');
        if (index < 0) return ['', ''];
        const key = part.slice(0, index).trim();
        let value = part.slice(index + 1).trim();
        try { value = decodeURIComponent(value); } catch {}
        return [key, value];
      })
      .filter(([key]) => key)
  );
}

export function readTicketAccess(req) {
  return verifyAccessToken(parseCookies(req)[ACCESS_COOKIE]);
}

export function makeAccessCookie(token, ttlSeconds = accessTtlSeconds()) {
  return `${ACCESS_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${ttlSeconds}`;
}

export function clearAccessCookie() {
  return `${ACCESS_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}
