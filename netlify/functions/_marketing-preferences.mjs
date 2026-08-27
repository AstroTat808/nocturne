import { getStore } from '@netlify/blobs';
import { createHash, randomBytes } from 'node:crypto';

const STORE_NAME = 'nocturne-marketing-preferences';

function normalizeEmail(value = '') {
  return String(value || '').trim().toLowerCase();
}

function emailHash(email) {
  return createHash('sha256').update(normalizeEmail(email)).digest('hex');
}

function store() {
  return getStore({ name: STORE_NAME, consistency: 'strong' });
}

export function transactionalEmailFrom() {
  return String(process.env.NOCTURNE_EMAIL_FROM || 'NOCTURNE Tickets <tickets@nocturnefestival.com>').trim();
}

export function marketingEmailFrom() {
  return String(process.env.NOCTURNE_UPDATES_EMAIL_FROM || '').trim();
}

export async function isMarketingSuppressed(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return true;
  const record = await store().get(`suppressed-${emailHash(normalized)}`, { type: 'json', consistency: 'strong' });
  return Boolean(record?.suppressed);
}

export async function ensureMarketingUnsubscribeUrl(req, email) {
  const normalized = normalizeEmail(email);
  if (!normalized) throw new Error('Marketing recipient email is unavailable.');

  const preferences = store();
  const hash = emailHash(normalized);
  const addressKey = `address-${hash}`;
  let address = await preferences.get(addressKey, { type: 'json', consistency: 'strong' });

  if (!address?.token) {
    const token = randomBytes(24).toString('base64url');
    const record = { email: normalized, emailHash: hash, token, createdAt: new Date().toISOString() };
    const write = await preferences.setJSON(addressKey, record, { onlyIfNew: true });
    if (write.modified) {
      address = record;
      await preferences.setJSON(`token-${token}`, record, { onlyIfNew: true });
    } else {
      address = await preferences.get(addressKey, { type: 'json', consistency: 'strong' });
    }
  }

  if (!address?.token) throw new Error('Could not create an unsubscribe link.');
  const tokenRecord = await preferences.get(`token-${address.token}`, { type: 'json', consistency: 'strong' });
  if (!tokenRecord) await preferences.setJSON(`token-${address.token}`, address, { onlyIfNew: true });

  const site = (process.env.NOCTURNE_SITE_URL || new URL(req.url).origin).replace(/\/$/, '');
  return `${site}/.netlify/functions/unsubscribe?token=${encodeURIComponent(address.token)}`;
}

export function marketingListHeaders(unsubscribeUrl) {
  return {
    'List-Unsubscribe': `<${unsubscribeUrl}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
  };
}

export async function suppressMarketingToken(token, source = 'unsubscribe') {
  const cleanToken = String(token || '').trim();
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(cleanToken)) return null;
  const preferences = store();
  const address = await preferences.get(`token-${cleanToken}`, { type: 'json', consistency: 'strong' });
  if (!address?.email || !address?.emailHash) return null;

  const record = {
    email: normalizeEmail(address.email),
    emailHash: address.emailHash,
    suppressed: true,
    source,
    suppressedAt: new Date().toISOString()
  };
  await preferences.setJSON(`suppressed-${address.emailHash}`, record);
  return record;
}
