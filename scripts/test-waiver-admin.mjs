import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const audit = read('netlify/functions/admin-gate-audit.mjs');
const reminder = read('netlify/functions/admin-waiver-reminders.mjs');
const email = read('netlify/functions/_waiver-reminder-email.mjs');
const adminGate = read('site/assets/js/admin-gate.js');
const loader = read('site/assets/js/admin-ticket-source-stats.js');

assert.ok(audit.includes('waiverSigned: signed'), 'Gate audit must expose waiver status per ticket.');
assert.ok(audit.includes('unsignedWaivers'), 'Gate audit must count unsigned waivers.');
assert.ok(audit.includes('tickets: ticketRows'), 'Gate audit must return active ticket rows for admin filtering.');

assert.ok(reminder.includes("summary.status === 'paid'"), 'Waiver reminder eligibility must include active paid ticket summaries.');
assert.ok(reminder.includes("['paid', 'checked_in']"), 'Waiver reminder eligibility must include paid and checked-in ticket state.');
assert.ok(reminder.includes('waiverSigned(summary'), 'Signed waivers must be excluded from reminders.');
assert.ok(reminder.includes('COOLDOWN_MS = 2 * 60 * 60 * 1000'), 'Bulk reminders must have duplicate-send cooldown protection.');
assert.ok(reminder.includes("SEND WAIVER REMINDERS"), 'Bulk reminder endpoint must require explicit confirmation.');
assert.ok(reminder.includes("writeAudit('waiver.bulk_reminders_sent'"), 'Bulk waiver sends must be audited.');

assert.ok(email.includes('/ticket/waiver?token='), 'Waiver email must deep-link to the ticket-specific waiver.');
assert.ok(email.includes('ticket QR and gate check-in remain unavailable'), 'Waiver email must clearly explain the entry lock.');
assert.ok(email.includes('parent or legal guardian'), 'Waiver email must preserve guardian signing guidance.');

assert.ok(adminGate.includes('Unsigned waiver'), 'Admin waiver filter must expose an Unsigned Waiver option.');
assert.ok(adminGate.includes('Waiver signed'), 'Admin rows must support signed waiver badges.');
assert.ok(adminGate.includes('Waiver unsigned'), 'Admin rows must support unsigned waiver badges.');
assert.ok(adminGate.includes('Send Waiver Reminders'), 'Admin must expose the bulk waiver reminder action.');
assert.ok(adminGate.includes('/api/admin/waiver-reminders'), 'Admin reminder UI must call the protected waiver reminder endpoint.');
assert.ok(loader.includes("import('/assets/js/admin-gate.js"), 'The live admin bundle must load gate and waiver tools.');

console.log('Waiver reminder, badge, filter, and admin loading regressions passed.');
