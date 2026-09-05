import { makeTicketToken } from './_ticket-token.mjs';
import { WAIVER_VERSION } from './_waiver.mjs';

const HELP_EMAIL = process.env.NOCTURNE_HELP_EMAIL || 'help@nocturnefestival.com';

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export async function sendWaiverReminder({ application, submissionId, ticketId, idempotencyKey }) {
  if (!process.env.RESEND_API_KEY || !process.env.NOCTURNE_EMAIL_FROM) {
    throw new Error('Waiver reminder email is not configured.');
  }

  const email = String(application?.email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Guest email is missing or invalid.');

  const token = makeTicketToken(ticketId, submissionId);
  if (!token) throw new Error('Ticket signing is not configured for this guest.');

  const site = (process.env.NOCTURNE_SITE_URL || 'https://nocturnefestival.com').replace(/\/$/, '');
  const waiverUrl = `${site}/ticket/waiver?token=${encodeURIComponent(token)}`;
  const ticketUrl = `${site}/ticket?token=${encodeURIComponent(token)}`;
  const displayName = application?.preferredName || application?.fullName || 'Guest';
  const subject = 'Action Required: Sign Your NOCTURNE Waiver Before Entry';

  const text = [
    `${displayName},`, '',
    'Your NOCTURNE ticket is active, but the required participant liability waiver has not yet been signed.', '',
    'IMPORTANT: Your ticket QR and event check-in remain locked until the current waiver is signed.', '',
    `Sign the required waiver now: ${waiverUrl}`, '',
    'If the ticket holder is a minor, a parent or legal guardian may complete the waiver for the participant.',
    'After signing, reopen your digital ticket and your QR code will be available for entry.', '',
    `Digital ticket: ${ticketUrl}`, '',
    `Need help? ${HELP_EMAIL}`, '',
    `Waiver version: ${WAIVER_VERSION}`,
    'NOCTURNE Festival',
    'Presented by Wild Ones & Bass Babes · Hawai‘i'
  ].join('\n');

  const html = `<!doctype html><html><body style="margin:0;background:#030303;color:#f7efe3;font-family:Arial,sans-serif"><div style="max-width:640px;margin:0 auto;padding:44px 24px"><div style="border:1px solid rgba(216,154,43,.38);background:#080604;padding:38px 30px"><div style="color:#d89a2b;font-size:11px;letter-spacing:3px;text-transform:uppercase">NOCTURNE · Entry Requirement</div><h1 style="font-family:Georgia,serif;font-weight:400;font-size:40px;line-height:1.05;color:#fff3df;margin:16px 0 22px">Sign your waiver<br>before you arrive.</h1><p style="color:#c8baa4;line-height:1.7">${escapeHtml(displayName)}, your NOCTURNE ticket is active, but the required participant liability waiver has not yet been signed.</p><div style="margin:26px 0;padding:18px;border:1px solid rgba(217,113,92,.5);background:rgba(217,113,92,.08);color:#f0c2b8;line-height:1.7"><strong style="color:#ffb5a5">ENTRY LOCKED UNTIL SIGNED</strong><br>Your ticket QR and gate check-in remain unavailable until the current waiver is completed.</div><p style="text-align:center;margin:30px 0"><a href="${escapeHtml(waiverUrl)}" style="display:inline-block;padding:15px 22px;background:#d89a2b;color:#0b0803;text-decoration:none;font-size:12px;letter-spacing:2px;text-transform:uppercase;font-weight:700">Sign Required Waiver</a></p><p style="color:#b9aa94;line-height:1.7;font-size:14px">If the ticket holder is a minor, a parent or legal guardian may complete the waiver for the participant. After signing, reopen the digital ticket and the QR code will unlock for entry.</p><p style="text-align:center;margin:22px 0"><a href="${escapeHtml(ticketUrl)}" style="color:#ffca61;text-decoration:none">Open Digital Ticket →</a></p><p style="color:#807564;font-size:12px">Need help? <a href="mailto:${escapeHtml(HELP_EMAIL)}" style="color:#ffca61">${escapeHtml(HELP_EMAIL)}</a></p><div style="margin-top:34px;padding-top:20px;border-top:1px solid rgba(216,154,43,.18);color:#74695b;font-size:11px;letter-spacing:1px;text-transform:uppercase">NOCTURNE Festival · Waiver ${escapeHtml(WAIVER_VERSION)} · Presented by Wild Ones &amp; Bass Babes · Hawai‘i</div></div></div></body></html>`;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': String(idempotencyKey || '').slice(0, 256)
    },
    body: JSON.stringify({
      from: process.env.NOCTURNE_EMAIL_FROM,
      to: [email],
      subject,
      html,
      text
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `Resend returned ${response.status}.`);
  return { messageId: data.id || null, waiverUrl, ticketUrl, recipient: email };
}
