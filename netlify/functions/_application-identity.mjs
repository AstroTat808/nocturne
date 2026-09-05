import { createHash } from 'node:crypto';

export const APPLICATION_DUPLICATE_WINDOW_MS = 30 * 60 * 1000;

export function normalizeApplicationEmail(value = '') {
  return String(value ?? '').trim().slice(0, 254).toLowerCase();
}

export function applicationPhoneDigits(value = '') {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  return digits;
}

export function applicationEmailRateKey(value = '') {
  const email = normalizeApplicationEmail(value);
  if (!email) return '';
  return `email-${createHash('sha256').update(email).digest('hex')}`;
}

export function matchApplicationIdentity(application, { email = '', phone = '' } = {}) {
  const normalizedEmail = normalizeApplicationEmail(email);
  const normalizedPhone = applicationPhoneDigits(phone);
  return {
    emailMatches: Boolean(normalizedEmail && normalizeApplicationEmail(application?.email) === normalizedEmail),
    phoneMatches: Boolean(normalizedPhone && applicationPhoneDigits(application?.phone) === normalizedPhone)
  };
}

export function activeEmailRateLock(rateState, now = Date.now()) {
  const lastSubmittedAt = Number(rateState?.lastSubmittedAt || 0);
  const expiresAt = lastSubmittedAt + APPLICATION_DUPLICATE_WINDOW_MS;
  if (!Number.isFinite(lastSubmittedAt) || lastSubmittedAt <= 0 || expiresAt <= now) {
    return { active: false, lastSubmittedAt: lastSubmittedAt || null, expiresAt: null, retryAfterSeconds: 0 };
  }
  return {
    active: true,
    lastSubmittedAt,
    expiresAt,
    retryAfterSeconds: Math.max(1, Math.ceil((expiresAt - now) / 1000))
  };
}
