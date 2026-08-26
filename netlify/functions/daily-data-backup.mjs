import { getStore } from '@netlify/blobs';
import { writeAudit } from './_audit.mjs';
import { sendOpsAlert } from './_ops-alert.mjs';

const SOURCE_STORES = [
  'nocturne-applications',
  'nocturne-application-reviews',
  'nocturne-invites',
  'nocturne-ticket-orders',
  'nocturne-stripe-events',
  'nocturne-email-events',
  'nocturne-drink-redemptions',
  'nocturne-audit-log'
];
const BACKUP_STORE = 'nocturne-backups';

function dateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

async function readStore(name) {
  const store = getStore({ name, consistency: 'strong' });
  const { blobs } = await store.list();
  const entries = await Promise.all(blobs.map(async ({ key }) => [key, await store.get(key, { type: 'json', consistency: 'strong' })]));
  return Object.fromEntries(entries.filter(([, value]) => value !== null));
}

export default async () => {
  const backupStore = getStore({ name: BACKUP_STORE, consistency: 'strong' });
  const day = dateKey();
  try {
    const data = Object.fromEntries(await Promise.all(SOURCE_STORES.map(async (name) => [name, await readStore(name)])));
    const counts = Object.fromEntries(Object.entries(data).map(([name, entries]) => [name, Object.keys(entries).length]));
    await backupStore.setJSON(`daily-${day}`, { createdAt: new Date().toISOString(), counts, data });

    const retentionDays = Math.max(7, Math.min(Number(process.env.NOCTURNE_BACKUP_RETENTION_DAYS || 30), 365));
    const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString().slice(0, 10);
    const { blobs } = await backupStore.list();
    for (const { key } of blobs) {
      const match = /^daily-(\d{4}-\d{2}-\d{2})$/.exec(key);
      if (match && match[1] < cutoff) await backupStore.delete(key);
    }
    await writeAudit('backup.completed', { day, records: Object.values(counts).reduce((sum, count) => sum + count, 0) });
  } catch (error) {
    console.error('NOCTURNE daily backup failed:', error);
    await writeAudit('backup.failed', { day, error: String(error?.message || error) });
    await sendOpsAlert('Daily backup failed', [`Date: ${day}`, String(error?.message || error)]).catch(() => {});
    throw error;
  }
}

export const config = { schedule: '30 20 * * *' };
