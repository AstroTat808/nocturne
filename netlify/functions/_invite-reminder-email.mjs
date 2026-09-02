const HELP_EMAIL = process.env.NOCTURNE_HELP_EMAIL || 'help@nocturnefestival.com';

function escapeHtml(value = '') {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function senderAddress() {
  const from = String(process.env.NOCTURNE_EMAIL_FROM || 'NOCTURNE <invites@nocturnefestival.com>');
  const angle = /<([^>]+)>/.exec(from)?.[1];
  return angle || from;
}

export async function sendInviteReminder(application, review, idempotencyKey) {
  if (!process.env.RESEND_API_KEY || !process.env.NOCTURNE_EMAIL_FROM) throw new Error('Email is not configured.');
  if (!application?.email) throw new Error('Applicant email is unavailable.');

  const site = (process.env.NOCTURNE_SITE_URL || 'https://nocturnefestival.com').replace(/\/$/, '');
  const inviteUrl = `${site}/invite`;
  const displayName = application.preferredName || application.fullName || 'Guest';
  const sender = senderAddress();
  const sentAt = review?.inviteEmailSentAt ? new Date(review.inviteEmailSentAt) : null;
  const sentDate = sentAt && !Number.isNaN(sentAt.getTime())
    ? new Intl.DateTimeFormat('en-US', { timeZone: 'Pacific/Honolulu', month: 'long', day: 'numeric', year: 'numeric' }).format(sentAt)
    : null;
  const subject = 'Your NOCTURNE Invitation Is Still Waiting';

  const text = [
    `${displayName},`, '',
    'Your request to enter NOCTURNE was approved, but your private invitation has not been redeemed yet.',
    sentDate ? `Your original invitation email was sent on ${sentDate}.` : 'Your original invitation email has already been sent.', '',
    'IMPORTANT: Please check your Inbox, Spam, Junk, and Promotions folders for the original NOCTURNE invitation email containing your private redemption code.',
    `Search your mailbox for “NOCTURNE” or messages from ${sender}.`, '',
    `Invitation verification page: ${inviteUrl}`, '',
    'After redemption, your private ticket checkout will also show an optional $20 Late Checkout / Car Camping add-on. It allows one registered guest to stay on the property after the 3:00 AM event end until 8:00 AM. Capacity is limited to 30 guests and is first-come, first-served.',
    'FINAL SALE / NON-REFUNDABLE: Late Checkout / Car Camping cannot be refunded, exchanged, prorated, transferred, converted to account credit, or redeemed for cash.', '',
    'For security, automated reminders do not repeat your private invitation code. If you cannot locate the original invitation email, contact NOCTURNE support and we can help you recover access.',
    'This reminder stops automatically as soon as your invitation is redeemed.', '',
    `Need help? ${HELP_EMAIL}`, '',
    'NOCTURNE Festival', 'Presented by Wild Ones · Hawai‘i'
  ].join('\n');

  const html = `<!doctype html><html><body style="margin:0;background:#030303;color:#f7efe3;font-family:Arial,sans-serif"><div style="max-width:640px;margin:0 auto;padding:44px 24px"><div style="border:1px solid rgba(216,154,43,.35);background:#080604;padding:38px 30px"><div style="color:#d89a2b;font-size:11px;letter-spacing:3px;text-transform:uppercase">NOCTURNE · Invitation Reminder</div><h1 style="font-family:Georgia,serif;font-weight:400;font-size:42px;line-height:1.04;color:#fff3df;margin:16px 0 22px">Your invitation<br>is still waiting.</h1><p style="color:#c8baa4;line-height:1.7">${escapeHtml(displayName)}, your request to enter NOCTURNE was approved, but your private invitation has not been redeemed yet.</p>${sentDate ? `<p style="color:#9d907f;line-height:1.7">Your original invitation email was sent on <strong style="color:#d8c7ac">${escapeHtml(sentDate)}</strong>.</p>` : ''}<div style="margin:26px 0;padding:18px;border:1px solid rgba(255,202,97,.34);background:#120d05;color:#d8c7ac;line-height:1.7"><strong style="display:block;color:#ffca61;letter-spacing:1px;text-transform:uppercase;font-size:12px;margin-bottom:8px">Check Spam / Junk / Promotions</strong>Email providers may route private invitation messages away from your main inbox. Search your mailbox for <strong>NOCTURNE</strong> or messages from <strong>${escapeHtml(sender)}</strong>.</div><p style="text-align:center;margin:30px 0"><a href="${escapeHtml(inviteUrl)}" style="display:inline-block;padding:14px 20px;background:#d89a2b;color:#0b0803;text-decoration:none;font-size:12px;letter-spacing:2px;text-transform:uppercase">Open Invitation Verification</a></p><div style="margin:24px 0;padding:16px;border:1px solid rgba(216,154,43,.26);background:#050403;color:#b9aa94;line-height:1.65;font-size:13px"><strong style="color:#ffca61">Optional Late Checkout / Car Camping · $20</strong><br>After redemption, ticket checkout will offer the option to stay on the property after the 3:00 AM event end until 8:00 AM. Limited to 30 guests, first-come, first-served.<br><br><strong style="color:#ffca61">FINAL SALE / NON-REFUNDABLE:</strong> Cannot be refunded, exchanged, prorated, transferred, converted to account credit, or redeemed for cash.</div><p style="color:#9d907f;line-height:1.7">For security, automated reminders do not repeat your private invitation code. If you cannot locate the original invitation email, contact NOCTURNE support and we can help you recover access.</p><p style="color:#9d907f;line-height:1.7">This reminder stops automatically as soon as your invitation is redeemed.</p><p style="color:#807564;font-size:12px">Need help? <a href="mailto:${escapeHtml(HELP_EMAIL)}?subject=NOCTURNE%20Invitation%20Help" style="color:#ffca61">${escapeHtml(HELP_EMAIL)}</a></p><div style="margin-top:34px;padding-top:20px;border-top:1px solid rgba(216,154,43,.18);color:#74695b;font-size:11px;letter-spacing:1px;text-transform:uppercase">NOCTURNE Festival · Presented by Wild Ones · Hawai‘i</div></div></div></body></html>`;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': String(idempotencyKey).slice(0, 256)
    },
    body: JSON.stringify({ from: process.env.NOCTURNE_EMAIL_FROM, to: [application.email], subject, html, text })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `Resend returned ${response.status}.`);
  return { messageId: data.id || null, inviteUrl };
}