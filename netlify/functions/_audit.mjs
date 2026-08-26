import { getStore } from '@netlify/blobs';
import { randomUUID } from 'node:crypto';

const AUDIT_STORE = 'nocturne-audit-log';

function cleanDetails(details = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(details || {})) {
    if (value === undefined) continue;
    if (typeof value === 'string') safe[key] = value.slice(0, 500);
    else if (value === null || typeof value === 'number' || typeof value === 'boolean') safe[key] = value;
  }
  return safe;
}

export async function writeAudit(type, details = {}) {
  const occurredAt = new Date().toISOString();
  const record = {
    id: randomUUID(),
    type: String(type || 'unknown').slice(0, 100),
    occurredAt,
    ...cleanDetails(details)
  };

  try {
    const store = getStore({ name: AUDIT_STORE, consistency: 'strong' });
    await store.setJSON(`${occurredAt}-${record.id}`, record, { onlyIfNew: true });
  } catch (error) {
    console.error('NOCTURNE audit write failed:', error);
  }

  return record;
}

export async function readAudit(limit = 500) {
  const store = getStore({ name: AUDIT_STORE, consistency: 'strong' });
  const { blobs } = await store.list();
  const selected = [...blobs]
    .sort((a, b) => String(b.key).localeCompare(String(a.key)))
    .slice(0, Math.max(1, Math.min(Number(limit) || 500, 2000)));
  const records = await Promise.all(selected.map(({ key }) => store.get(key, { type: 'json', consistency: 'strong' })));
  return records.filter(Boolean);
}
