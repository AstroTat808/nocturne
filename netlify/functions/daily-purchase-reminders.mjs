import { getStore } from '@netlify/blobs';
import { writeAudit } from './_audit.mjs';
import { sendOpsAlert } from './_ops-alert.mjs';
import { sendPurchaseReminder } from './_purchase-reminder-email.mjs';
import { beforeEvent, eligibleForPurchaseReminder, honoluluDate } from './_reminder-policy.mjs';

const APPLICATION_STORE = 'nocturne-applications';
const REVIEW_STORE = 'nocturne-application-reviews';
const ORDER_STORE = 'nocturne-ticket-orders';
const EMAIL_EVENT_STORE = 'nocturne-email-events';

function remindersEnabled() {
  return String(process.env.NOCTURNE_PURCHASE_REMINDERS_ENABLED || '').toLowerCase() === 'true'
    && String(process.env.NOCTURNE_PURCHASE_REMINDERS_MODE || 'test').toLowerCase() === 'live';
}

async function processCandidate(submissionId, dateKey, stores) {
  const markerKey = `purchase-reminder-${dateKey}-${submissionId}`;
  const marker = await stores.emailEvents.setJSON(markerKey, { submissionId, dateKey, status: 'sending', createdAt: new Date().toISOString() }, { onlyIfNew: true });
  if (!marker.modified) return { status: 'duplicate' };

  try {
    const [application, reviewEntry, summary] = await Promise.all([
      stores.applications.get(submissionId, { type: 'json', consistency: 'strong' }),
      stores.reviews.getWithMetadata(submissionId, { type: 'json', consistency: 'strong' }),
      stores.orders.get(`submission-${submissionId}`, { type: 'json', consistency: 'strong' })
    ]);
    const review = reviewEntry?.data;
    if (!application?.email || !eligibleForPurchaseReminder(review, summary)) {
      await stores.emailEvents.delete(markerKey);
      return { status: 'ineligible' };
    }

    const sent = await sendPurchaseReminder(application, submissionId, `purchase-reminder-${dateKey}-${submissionId}`);
    const sentAt = new Date().toISOString();
    await stores.emailEvents.setJSON(markerKey, { submissionId, dateKey, status: 'sent', sentAt, messageId: sent.messageId });
    if (reviewEntry?.etag) {
      await stores.reviews.setJSON(submissionId, {
        ...review,
        purchaseReminderStatus: 'sent',
        purchaseReminderLastSentAt: sentAt,
        purchaseReminderLastDate: dateKey,
        purchaseReminderCount: Number(review.purchaseReminderCount || 0) + 1,
        purchaseReminderMessageId: sent.messageId,
        purchaseReminderError: null,
        updatedAt: sentAt
      }, { onlyIfMatch: reviewEntry.etag });
    }
    await writeAudit('purchase_reminder.sent', { submissionId, recipient: application.email, messageId: sent.messageId });
    return { status: 'sent' };
  } catch (error) {
    await stores.emailEvents.delete(markerKey).catch(() => {});
    await writeAudit('purchase_reminder.failed', { submissionId, error: String(error?.message || error) });
    return { status: 'failed', error: String(error?.message || error) };
  }
}

export async function runPurchaseReminders({ trigger = 'schedule', scanAll = false } = {}) {
  if (!remindersEnabled()) {
    return { enabled: false, reason: 'Purchase reminders are not enabled in live mode.', scanned: 0, sent: 0, duplicate: 0, ineligible: 0, failed: 0 };
  }
  if (!beforeEvent()) {
    return { enabled: true, reason: 'The event start cutoff has passed.', scanned: 0, sent: 0, duplicate: 0, ineligible: 0, failed: 0 };
  }
  if (!process.env.RESEND_API_KEY || !process.env.NOCTURNE_EMAIL_FROM) {
    console.error('NOCTURNE daily purchase reminders are enabled but email is not configured.');
    return { enabled: true, reason: 'Email is not configured.', scanned: 0, sent: 0, duplicate: 0, ineligible: 0, failed: 0 };
  }

  const stores = {
    applications: getStore({ name: APPLICATION_STORE, consistency: 'strong' }),
    reviews: getStore({ name: REVIEW_STORE, consistency: 'strong' }),
    orders: getStore({ name: ORDER_STORE, consistency: 'strong' }),
    emailEvents: getStore({ name: EMAIL_EVENT_STORE, consistency: 'strong' })
  };
  const { blobs } = await stores.reviews.list();
  const dateKey = honoluluDate();
  const scheduledLimit = Math.max(1, Math.min(Number(process.env.NOCTURNE_PURCHASE_REMINDER_BATCH_LIMIT || 100), 250));
  const ids = blobs.map(({ key }) => key).slice(0, scanAll ? blobs.length : scheduledLimit);
  const results = [];
  for (let index = 0; index < ids.length; index += 5) {
    results.push(...await Promise.all(ids.slice(index, index + 5).map((id) => processCandidate(id, dateKey, stores))));
  }

  const summary = results.reduce((counts, result) => {
    counts[result.status] = (counts[result.status] || 0) + 1;
    return counts;
  }, {});
  const output = {
    enabled: true,
    dateKey,
    trigger,
    scanned: ids.length,
    sent: summary.sent || 0,
    duplicate: summary.duplicate || 0,
    ineligible: summary.ineligible || 0,
    failed: summary.failed || 0
  };

  console.log('NOCTURNE daily purchase reminder run:', output);
  await writeAudit('purchase_reminder.run', output);
  if (summary.failed) {
    await sendOpsAlert('Purchase reminder failures', [
      `Date: ${dateKey}`,
      `Trigger: ${trigger}`,
      `Sent: ${summary.sent || 0}`,
      `Failed: ${summary.failed}`,
      'Review the Netlify function log for daily-purchase-reminders.'
    ]).catch((error) => console.error('NOCTURNE reminder alert failed:', error));
  }

  return output;
}

export default async () => {
  await runPurchaseReminders();
};

export const config = { schedule: '0 20 * * *' };
