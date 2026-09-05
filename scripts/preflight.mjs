import { readFile, readdir } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const root = process.cwd();
const siteRoot = join(root, 'site');
const failures = [];

async function filesUnder(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await filesUnder(path));
    else output.push(path);
  }
  return output;
}

const siteFiles = await filesUnder(siteRoot);
const publicTextFiles = siteFiles.filter((path) => ['.html', '.js', '.css', '.xml', '.txt'].includes(extname(path)));

const ticketViewSource = await readFile(join(root, 'netlify/functions/ticket-view-v2.mjs'), 'utf8');
const walletSource = await readFile(join(root, 'netlify/functions/_apple-wallet.mjs'), 'utf8');
const venueSource = await readFile(join(root, 'netlify/functions/_venue.mjs'), 'utf8');
if (!ticketViewSource.includes("from './_venue.mjs'")) failures.push('ticket-view-v2.mjs must load private venue details from runtime configuration.');
if (!walletSource.includes("from './_venue.mjs'")) failures.push('_apple-wallet.mjs must load private venue details from runtime configuration.');
if (!venueSource.includes('NOCTURNE_VENUE_NAME') || !venueSource.includes('NOCTURNE_VENUE_ADDRESS')) failures.push('_venue.mjs must read private venue details from environment variables.');
for (const [name, text] of [['ticket-view-v2.mjs', ticketViewSource], ['_apple-wallet.mjs', walletSource]]) {
  for (const forbidden of ['EVENT_VENUE =', 'EVENT_ADDRESS =', 'EVENT_MAP_URL =']) {
    if (text.includes(forbidden)) failures.push(`${name} contains a hard-coded private venue constant (${forbidden}).`);
  }
}

const routePrefixes = ['/api/', '/ticket', '/invite', '/admin', '/check-in', '/bar', '/festival', '/apply', '/privacy', '/terms', '/conduct', '/application-received'];
const generatedAssets = new Set(['/assets/vendor/html5-qrcode.min.js']);
for (const path of siteFiles.filter((file) => extname(file) === '.html')) {
  const text = await readFile(path, 'utf8');
  for (const match of text.matchAll(/(?:href|src)="(\/[^"]+)"/g)) {
    const target = match[1].split(/[?#]/, 1)[0];
    if (!target || target === '/') continue;
    if (generatedAssets.has(target)) continue;
    if (routePrefixes.some((prefix) => target === prefix || target.startsWith(`${prefix}/`))) continue;
    const diskPath = join(siteRoot, target.replace(/^\//, ''));
    if (!siteFiles.includes(diskPath)) failures.push(`Broken local asset reference ${target} in ${relative(root, path)}.`);
  }
}

const privatePages = [
  'invite.html',
  'admin.html',
  'admin-launch.html',
  'admin-event-day.html',
  'admin-operations.html',
  'admin-rehearsal.html',
  'check-in.html',
  'bar.html',
  'application-received.html'
];
for (const name of privatePages) {
  const text = await readFile(join(siteRoot, name), 'utf8');
  if (!/name="robots" content="[^"]*noindex/i.test(text)) failures.push(`${name} must remain noindex.`);
}

const netlifyConfig = await readFile(join(root, 'netlify.toml'), 'utf8');
for (const header of ['Strict-Transport-Security', 'Content-Security-Policy', 'X-Frame-Options', 'Referrer-Policy']) {
  if (!netlifyConfig.includes(header)) failures.push(`Security header ${header} is missing from netlify.toml.`);
}
if (!netlifyConfig.includes('to = "/.netlify/functions/admin-delete-application-v2"')) failures.push('Canonical admin deletion route must use the hardened v2 deletion handler.');
if (!netlifyConfig.includes('to = "/.netlify/functions/stripe-webhook-router-v2"')) failures.push('Stripe webhook route must use the hardened v2 router.');
if (!netlifyConfig.includes('to = "/.netlify/functions/ticket-view-v2"')) failures.push('Digital ticket route must use ticket-view-v2.');

const reminders = await readFile(join(root, 'netlify/functions/daily-purchase-reminders.mjs'), 'utf8');
const backups = await readFile(join(root, 'netlify/functions/daily-data-backup.mjs'), 'utf8');
if (!reminders.includes("schedule: '0 20 * * *'")) failures.push('Daily purchase reminder schedule is missing or changed.');
if (!backups.includes("schedule: '30 20 * * *'")) failures.push('Daily backup schedule is missing or changed.');

if (failures.length) {
  console.error(`NOCTURNE preflight failed with ${failures.length} issue(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`NOCTURNE preflight passed: ${publicTextFiles.length} text assets checked; production ticket/Stripe/admin routes and private venue gating verified.`);
