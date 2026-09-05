import { getStore } from '@netlify/blobs';
import { writeAudit } from './_audit.mjs';
import { sendOpsAlert } from './_ops-alert.mjs';
import { sendInviteReminder } from './_invite-reminder-email.mjs';
import { beforeEvent, dailyRemindersPaused, honoluluDate } from './_reminder-policy.mjs';

const APPLICATION_STORE = 'nocturne-applications';
const REVIEW_STORE = 'nocturne-application-reviews';
const INVITE_STORE = 'nocturne-invites';
const EMAIL_EVENT_STORE = 'nocturne-email-events';

function remindersEnabled() {
  const enabled = process.env.NOCTURNE_INVITE_REMINDERS_ENABLED ?? process.env.NOCTURNE_PURCHASE_REMINDERS_ENABLED ?? '';
  const mode = process.env.NOCTURNE_INVITE_REMINDERS_MODE ?? process.env.NOCTURNE_PURCHASE_REMINDERS_MODE ?? 'test';
  return String(enabled).toLowerCase() === 'true' && String(mode).toLowerCase() === 'live';
}

export function eligibleForInviteReminder(review, invite, now = Date.now()) {
  if (!review || review.status !== 'approved' || review.inviteState !== 'active' || !review.inviteHash) return false;
  if (!review.inviteEmailSentAt) return false;
  if (review.inviteRedeemedAt || review.inviteRevokedAt) return false;
  if (!invite || invite.used === true || invite.usedAt) return false;

  const expiresAt = new Date(review.inviteExpiresAt || invite.expiresAt || 0).getTime();
  if (Number.isFinite(expiresAt) && expiresAt > 0 && now >= expiresAt) return false;

  const sentAt = new Date(review.inviteEmailSentAt || 0).getTime();
  const minimumHours = Math.max(1, Number(process.env.NOCTURNE_INVITE_REMINDER_MIN_HOURS || 20));
  return Number.isFinite(sentAt) && sentAt > 0 && now - sentAt >= minimumHours * 60 * 60 * 1000;
}

async function processCandidate(submissionId, dateKey, stores) {
  const markerKey = `invite-reminder-${dateKey}-${submissionId}`;
  const marker = await stores.emailEvents.setJSON(markerKey, {
    submissionId,
    dateKey,
    status: 'sending',
    createdAt: new Date().toISOString()
  }, { onlyIfNew: true });
  if (!marker.modified) return { status: 'duplicate' };

  try {
    const [application, reviewEntry] = await Promise.all([
      stores.applications.get(submissionId, { type: 'json', consistency: 'strong' }),
      stores.reviews.getWithMetadata(submissionId, { type: 'json', consistency: 'strong' })
    ]);
    const review = reviewEntry?.data;
    const invite = review?.inviteHash
      ? await stores.invites.get(String(review.inviteHash), { type: 'json', consistency: 'strong' })
      : null;

    if (!application?.email || !eligibleForInviteReminder(review, invite)) {
      await stores.emailEvents.delete(markerKey);
      return { status: 'ineligible' };
    }

    const sent = await sendInviteReminder(application, review, `invite-reminder-${dateKey}-${submissionId}`);
    const sentAt = new Date().toISOString();
    await stores.emailEvents.setJSON(markerKey, {
      submissionId,
      dateKey,
      status: 'sent',
      sentAt,
      messageId: sent.messageId
    });

    if (reviewEntry?.etag) {
      await stores.reviews.setJSON(submissionId, {
        ...review,
        inviteReminderStatus: 'sent',
        inviteReminderLastSentAt: sentAt,
        inviteReminderLastDate: dateKey,
        inviteReminderCount: Number(review.inviteReminderCount || 0) + 1,
        inviteReminderMessageId: sent.messageId,
        inviteReminderError: null,
        updatedAt: sentAt
      }, { onlyIfMatch: reviewEntry.etag });
    }

    await writeAudit('invite_reminder.sent', {
      submissionId,
      recipient: application.email,
      messageId: sent.messageId
    });
    return { status: 'sent' };
  } catch (error) {
    await stores.emailEvents.delete(markerKey).catch(() => {});
    await writeAudit('invite_reminder.failed', { submissionId, error: String(error?.message || error) });
    return { status: 'failed', error: String(error?.message || error) };
  }
}

export async function runInviteReminders({ trigger = 'schedule', scanAll = false } = {}) {
  if (trigger === 'schedule' && dailyRemindersPaused()) {
    return { enabled: false, reason: 'Scheduled reminder emails are paused for Sept. 5 HST.', scanned: 0, sent: 0, duplicate: 0, ineligible: 0, failed: 0 };
  }
  if (!remindersEnabled()) {
    return { enabled: false, reason: 'Invitation reminders are not enabled in live mode.', scanned: 0, sent: 0, duplicate: 0, ineligible: 0, failed: 0 };
  }
  if (!beforeEvent()) {
    return { enabled: true, reason: 'The event start cutoff has passed.', scanned: 0, sent: 0, duplicate: 0, ineligible: 0, failed: 0 };
  }
  if (!process.env.RESEND_API_KEY || !process.env.NOCTURNE_EMAIL_FROM) {
    console.error('NOCTURNE daily invite reminders are enabled but email is not configured.');
    return { enabled: true, reason: 'Email is not configured.', scanned: 0, sent: 0, duplicate: 0, ineligible: 0, failed: 0 };
  }

  const stores = {
    applications: getStore({ name: APPLICATION_STORE, consistency: 'strong' }),
    reviews: getStore({ name: REVIEW_STORE, consistency: 'strong' }),
    invites: getStore({ name: INVITE_STORE, consistency: 'strong' }),
    emailEvents: getStore({ name: EMAIL_EVENT_STORE, consistency: 'strong' })
  };

  const { blobs } = await stores.reviews.list();
  const dateKey = honoluluDate();
  const scheduledLimit = Math.max(1, Math.min(Number(process.env.NOCTURNE_INVITE_REMINDER_BATCH_LIMIT || 100), 250));
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

  console.log('NOCTURNE daily invite reminder run:', output);
  await writeAudit('invite_reminder.run', output);

  if (summary.failed) {
    await sendOpsAlert('Invitation reminder failures', [
      `Date: ${dateKey}`,
      `Trigger: ${trigger}`,
      `Sent: ${summary.sent || 0}`,
      `Failed: ${summary.failed}`,
      'Review the Netlify function log for daily-invite-reminders.'
    ]).catch((error) => console.error('NOCTURNE invite reminder alert failed:', error));
  }

  return output;
}

export default async () => {
  await runInviteReminders();
};

// 19:00 UTC = 9:00 AM Hawai‘i Standard Time year-round.
export const config = { schedule: '0 19 * * *' };
