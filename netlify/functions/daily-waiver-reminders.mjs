import { getStore } from '@netlify/blobs';
import { waiverSigned, WAIVER_VERSION } from './_waiver.mjs';
import { sendWaiverReminder } from './_waiver-reminder-email.mjs';
import { beforeEvent, dailyRemindersPaused, honoluluDate } from './_reminder-policy.mjs';
import { writeAudit } from './_audit.mjs';
import { sendOpsAlert } from './_ops-alert.mjs';

const ORDER_STORE = 'nocturne-ticket-orders';
const REVIEW_STORE = 'nocturne-application-reviews';
const APPLICATION_STORE = 'nocturne-applications';
const EMAIL_EVENT_STORE = 'nocturne-email-events';
const REMINDER_STORE = 'nocturne-waiver-reminders';

function activeTicket(summary = {}, review = {}) {
  return Boolean(summary.ticketId)
    && summary.status === 'paid'
    && ['paid', 'checked_in'].includes(String(review.ticketState || ''));
}

function validEmail(value = '') {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim());
}

async function processCandidate(submissionId, dateKey, stores) {
  const markerKey = `waiver-reminder-${dateKey}-${submissionId}`;
  const marker = await stores.emailEvents.setJSON(markerKey, {
    submissionId,
    dateKey,
    waiverVersion: WAIVER_VERSION,
    status: 'sending',
    createdAt: new Date().toISOString()
  }, { onlyIfNew: true });
  if (!marker.modified) return { status: 'duplicate' };

  try {
    const [summary, review, application] = await Promise.all([
      stores.orders.get(`submission-${submissionId}`, { type: 'json', consistency: 'strong' }),
      stores.reviews.get(submissionId, { type: 'json', consistency: 'strong' }),
      stores.applications.get(submissionId, { type: 'json', consistency: 'strong' })
    ]);

    if (!activeTicket(summary, review || {}) || waiverSigned(summary, review || {})) {
      await stores.emailEvents.delete(markerKey);
      return { status: 'ineligible' };
    }
    if (!validEmail(application?.email)) {
      await stores.emailEvents.delete(markerKey);
      return { status: 'no_email' };
    }

    const sent = await sendWaiverReminder({
      application,
      submissionId,
      ticketId: summary.ticketId,
      idempotencyKey: `waiver-daily-${WAIVER_VERSION}-${dateKey}-${submissionId}`
    });
    const sentAt = new Date().toISOString();
    await Promise.all([
      stores.emailEvents.setJSON(markerKey, {
        submissionId,
        ticketId: summary.ticketId,
        dateKey,
        waiverVersion: WAIVER_VERSION,
        status: 'sent',
        sentAt,
        messageId: sent.messageId || null
      }),
      stores.reminders.setJSON(submissionId, {
        submissionId,
        ticketId: summary.ticketId,
        waiverVersion: WAIVER_VERSION,
        lastSentAt: sentAt,
        messageId: sent.messageId || null,
        recipient: sent.recipient,
        source: 'daily-schedule'
      })
    ]);
    await writeAudit('waiver.daily_reminder.sent', { submissionId, ticketId: summary.ticketId, recipient: application.email, messageId: sent.messageId || null });
    return { status: 'sent' };
  } catch (error) {
    await stores.emailEvents.delete(markerKey).catch(() => {});
    await writeAudit('waiver.daily_reminder.failed', { submissionId, error: String(error?.message || error) });
    return { status: 'failed', error: String(error?.message || error) };
  }
}

export async function runDailyWaiverReminders({ trigger = 'schedule' } = {}) {
  if (trigger === 'schedule' && dailyRemindersPaused()) {
    return { enabled: false, reason: 'Scheduled reminder emails are paused for Sept. 5 HST.', scanned: 0, sent: 0, duplicate: 0, ineligible: 0, noEmail: 0, failed: 0 };
  }
  if (!beforeEvent()) {
    return { enabled: true, reason: 'The event start cutoff has passed.', scanned: 0, sent: 0, duplicate: 0, ineligible: 0, noEmail: 0, failed: 0 };
  }
  if (!process.env.RESEND_API_KEY || !process.env.NOCTURNE_EMAIL_FROM) {
    return { enabled: true, reason: 'Email is not configured.', scanned: 0, sent: 0, duplicate: 0, ineligible: 0, noEmail: 0, failed: 0 };
  }

  const stores = {
    orders: getStore({ name: ORDER_STORE, consistency: 'strong' }),
    reviews: getStore({ name: REVIEW_STORE, consistency: 'strong' }),
    applications: getStore({ name: APPLICATION_STORE, consistency: 'strong' }),
    emailEvents: getStore({ name: EMAIL_EVENT_STORE, consistency: 'strong' }),
    reminders: getStore({ name: REMINDER_STORE, consistency: 'strong' })
  };
  const { blobs } = await stores.orders.list({ prefix: 'submission-' });
  const ids = blobs.map(({ key }) => key.slice('submission-'.length));
  const dateKey = honoluluDate();
  const results = [];
  for (let index = 0; index < ids.length; index += 5) {
    results.push(...await Promise.all(ids.slice(index, index + 5).map((id) => processCandidate(id, dateKey, stores))));
  }

  const counts = results.reduce((out, result) => {
    out[result.status] = (out[result.status] || 0) + 1;
    return out;
  }, {});
  const output = {
    enabled: true,
    trigger,
    dateKey,
    scanned: ids.length,
    sent: counts.sent || 0,
    duplicate: counts.duplicate || 0,
    ineligible: counts.ineligible || 0,
    noEmail: counts.no_email || 0,
    failed: counts.failed || 0
  };
  await writeAudit('waiver.daily_reminder.run', output);
  if (output.failed) {
    await sendOpsAlert('Daily waiver reminder failures', [
      `Date: ${dateKey}`,
      `Sent: ${output.sent}`,
      `Failed: ${output.failed}`,
      'Review the daily-waiver-reminders function log.'
    ]).catch(() => {});
  }
  return output;
}

export default async () => {
  await runDailyWaiverReminders();
};

// Netlify schedules are UTC. 18:00 UTC = 8:00 AM HST year-round.
export const config = { schedule: '0 18 * * *' };
