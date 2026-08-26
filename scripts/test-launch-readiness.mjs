import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const backend = await readFile(new URL('../netlify/functions/admin-launch.mjs', import.meta.url), 'utf8');
const page = await readFile(new URL('../site/admin-launch.html', import.meta.url), 'utf8');
const ui = await readFile(new URL('../site/assets/js/admin-launch.js', import.meta.url), 'utf8');

for (const required of [
  'fulfillmentVerified',
  'NOCTURNE_TURNSTILE_SITE_KEY',
  'NOCTURNE_TURNSTILE_SECRET_KEY',
  'NOCTURNE_VENUE_NAME',
  'NOCTURNE_VENUE_ADDRESS',
  'inviteRemindersEnabled',
  'purchaseRemindersEnabled',
  'backupStatus',
  'rehearsalStatus',
  'appleWalletLaunchBlocking: false'
]) assert.ok(backend.includes(required), `Launch backend must include ${required}`);

for (const id of [
  'launch-overall',
  'launch-fulfillment',
  'launch-turnstile',
  'launch-venue',
  'launch-ticket-signing',
  'launch-gate',
  'launch-bar',
  'launch-drink-package',
  'launch-water-package',
  'launch-invite-reminders',
  'launch-backups',
  'launch-rehearsal-percent'
]) assert.ok(page.includes(`id="${id}"`), `Launch page must render ${id}`);

assert.ok(ui.includes("text(els.wallet, 'DEFERRED')"), 'Apple Wallet must render as deferred when unconfigured.');
assert.ok(ui.includes('not launch-blocking'), 'Launch UI must explain that deferred Apple Wallet is not a core blocker.');
assert.ok(ui.includes('CORE READY · REHEARSAL INCOMPLETE'), 'Launch UI must distinguish core readiness from rehearsal completion.');

console.log('Launch readiness regression checks passed.');
