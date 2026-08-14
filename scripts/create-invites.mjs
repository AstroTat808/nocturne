import { writeFile } from 'node:fs/promises';

const [countArg = '1', ...labelParts] = process.argv.slice(2);
const count = Math.min(Math.max(Number(countArg) || 1, 1), 100);
const label = labelParts.join(' ') || 'Approved guest';
const siteUrl = (process.env.NOCTURNE_SITE_URL || '').replace(/\/$/, '');
const adminKey = process.env.NOCTURNE_ADMIN_KEY || '';

if (!siteUrl || !adminKey) {
  console.error('Set NOCTURNE_SITE_URL and NOCTURNE_ADMIN_KEY before running this command.');
  process.exit(1);
}

const res = await fetch(`${siteUrl}/api/admin/create-invites`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${adminKey}`
  },
  body: JSON.stringify({ count, label })
});

const payload = await res.json();
if (!res.ok) {
  console.error(payload.error || 'Invite creation failed.');
  process.exit(1);
}

const rows = [
  ['code', 'label', 'expiresAt'],
  ...payload.invites.map((invite) => [invite.code, invite.label, invite.expiresAt])
];
const csv = rows.map((row) => row.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(',')).join('\n');
const filename = `nocturne-invites-${new Date().toISOString().slice(0, 10)}.csv`;
await writeFile(filename, `${csv}\n`);
console.log(`Created ${payload.created} invite code(s). Saved to ${filename}.`);
