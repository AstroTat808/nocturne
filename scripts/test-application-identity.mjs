import assert from 'node:assert/strict';
import {
  APPLICATION_DUPLICATE_WINDOW_MS,
  activeEmailRateLock,
  applicationEmailRateKey,
  applicationPhoneDigits,
  matchApplicationIdentity,
  normalizeApplicationEmail
} from '../netlify/functions/_application-identity.mjs';

assert.equal(normalizeApplicationEmail('  Chris@Sibel.org  '), 'chris@sibel.org');
assert.equal(applicationPhoneDigits('+1 (808) 960-0059'), '8089600059');
assert.equal(applicationPhoneDigits('808-960-0059'), '8089600059');
assert.match(applicationEmailRateKey('Chris@Sibel.org'), /^email-[a-f0-9]{64}$/);
assert.equal(applicationEmailRateKey(''), '');

assert.deepEqual(
  matchApplicationIdentity(
    { email: 'chris@sibel.org', phone: '808-960-0059' },
    { email: 'CHRIS@SIBEL.ORG', phone: '(808) 960-0059' }
  ),
  { emailMatches: true, phoneMatches: true }
);
assert.deepEqual(
  matchApplicationIdentity(
    { email: 'someone@example.com', phone: '808-960-0059' },
    { email: 'chris@sibel.org', phone: '8089600059' }
  ),
  { emailMatches: false, phoneMatches: true }
);

const now = Date.parse('2026-09-05T05:00:00.000Z');
const active = activeEmailRateLock({ lastSubmittedAt: now - 60_000 }, now);
assert.equal(active.active, true);
assert.equal(active.retryAfterSeconds, (APPLICATION_DUPLICATE_WINDOW_MS - 60_000) / 1000);
assert.deepEqual(activeEmailRateLock({ lastSubmittedAt: now - APPLICATION_DUPLICATE_WINDOW_MS }, now), {
  active: false,
  lastSubmittedAt: now - APPLICATION_DUPLICATE_WINDOW_MS,
  expiresAt: null,
  retryAfterSeconds: 0
});

console.log('Application identity diagnostic tests passed.');
