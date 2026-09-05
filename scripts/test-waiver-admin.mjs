import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const audit = read('netlify/functions/admin-gate-audit.mjs');
const reminder = read('netlify/functions/admin-waiver-reminders.mjs');
const daily = read('netlify/functions/daily-waiver-reminders.mjs');
const email = read('netlify/functions/_waiver-reminder-email.mjs');
const adminWaiver = read('site/assets/js/admin-gate.js');
const adminEventDay = read('site/assets/js/admin-event-day.js');
const adminEventDayHtml = read('site/admin-event-day.html');

assert.ok(audit.includes('waiverSigned: signed'), 'Gate audit must expose waiver status per ticket.');
assert.ok(audit.includes('unsignedWaivers'), 'Gate audit must count unsigned waivers.');
assert.ok(audit.includes('tickets: ticketRows'), 'Gate audit must return active ticket rows for admin filtering.');

assert.ok(reminder.includes("summary.status === 'paid'"), 'Waiver reminder eligibility must include active paid ticket summaries.');
assert.ok(reminder.includes("['paid', 'checked_in']"), 'Waiver reminder eligibility must include paid and checked-in ticket state.');
assert.ok(reminder.includes('waiverSigned(summary'), 'Signed waivers must be excluded from reminders.');
assert.ok(reminder.includes('COOLDOWN_MS = 2 * 60 * 60 * 1000'), 'Manual reminders must have duplicate-send cooldown protection.');
assert.ok(reminder.includes('SEND WAIVER REMINDERS'), 'Bulk reminder endpoint must require explicit confirmation.');
assert.ok(reminder.includes('SEND WAIVER REMINDER'), 'Individual reminder endpoint must require an individual confirmation phrase.');
assert.ok(reminder.includes('waiver.individual_reminder_sent'), 'Individual waiver sends must be audited.');
assert.ok(reminder.includes("writeAudit('waiver.bulk_reminders_sent'"), 'Bulk waiver sends must be audited.');

assert.ok(daily.includes("schedule: '0 18 * * *'"), 'Daily waiver reminder must run at 8:00 AM HST.');
assert.ok(daily.includes('beforeEvent()'), 'Daily waiver reminders must stop after event start.');
assert.ok(daily.includes('honoluluDate()'), 'Daily waiver reminders must dedupe using the Hawaii calendar date.');
assert.ok(daily.includes('waiverSigned(summary'), 'Daily reminders must exclude signed waivers.');
assert.ok(daily.includes('waiver-reminder-${dateKey}-${submissionId}'), 'Daily reminders must use one-send-per-day markers.');
assert.ok(daily.includes("source: 'daily-schedule'"), 'Scheduled sends must update the shared reminder state.');

assert.ok(email.includes('/ticket/waiver?token='), 'Waiver email must deep-link to the ticket-specific waiver.');
assert.ok(email.includes('ticket QR and gate check-in remain unavailable'), 'Waiver email must clearly explain the entry lock.');
assert.ok(email.includes('parent or legal guardian'), 'Waiver email must preserve guardian signing guidance.');

assert.ok(adminWaiver.includes('Unsigned waiver'), 'Main admin waiver filter must expose an Unsigned Waiver option.');
assert.ok(adminWaiver.includes('Waiver signed'), 'Main admin rows must support signed waiver badges.');
assert.ok(adminWaiver.includes('Waiver unsigned'), 'Main admin rows must support unsigned waiver badges.');
assert.ok(adminWaiver.includes('admin-waiver-row-remind'), 'Unsigned main-admin rows must expose an individual reminder button.');
assert.ok(adminWaiver.includes('SEND WAIVER REMINDER'), 'Individual reminder button must use the protected endpoint contract.');
assert.ok(adminWaiver.includes('/admin-event-day.html'), 'Main admin must expose a link to the dedicated Event Day Ready page.');
assert.ok(!adminWaiver.includes('Final command center.'), 'Main admin must no longer render Event Day Ready inline.');

assert.ok(adminEventDayHtml.includes('Event Day Ready'), 'Dedicated page must visibly identify Event Day Ready.');
assert.ok(adminEventDay.includes("readJson('/api/admin/gate-audit')"), 'Dedicated Event Day Ready page must read the protected gate audit.');
assert.ok(adminEventDay.includes("readJson('/api/admin/launch')"), 'Dedicated Event Day Ready page must read launch readiness.');
for (const label of ['Gate Readiness', 'Unsigned Waivers', 'Bartender', 'Stripe', 'Backups']) assert.ok(adminEventDay.includes(label), `Event Day Ready must include ${label}.`);

console.log('Waiver reminder schedule, individual action, badges, filter, and separated Event Day Ready regressions passed.');
