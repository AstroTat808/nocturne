import { makeReentryToken } from './_ticket-auth.mjs';
import { ticketPricing } from './_ticket-pricing.mjs';

const HELP_EMAIL = process.env.NOCTURNE_HELP_EMAIL || 'help@nocturnefestival.com';

function escapeHtml(value = '') {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

export async function sendPurchaseReminder(application, submissionId, idempotencyKey) {
  const site = (process.env.NOCTURNE_SITE_URL || 'https://nocturnefestival.com').replace(/\/$/, '');
  const reentryToken = makeReentryToken(submissionId);
  if (!reentryToken) throw new Error('Ticket re-entry signing is not configured.');
  const checkoutUrl = `${site}/ticket-access/reenter?token=${encodeURIComponent(reentryToken)}`;
  const displayName = application.preferredName || application.fullName || 'Guest';
  const pricing = ticketPricing();
  const price = pricing.priceCents / 100;
  const currency = String(process.env.NOCTURNE_TICKET_CURRENCY || 'usd').toUpperCase();
  const priceText = `${currency} ${price.toFixed(2)}`;
  const priceChangeText = pricing.changed ? 'Current admission price: $35.' : 'Admission is $25 through 11:59 PM HST tonight and increases to $35 at midnight.';
  const subject = pricing.changed ? 'Complete Your $35 NOCTURNE Ticket' : 'Complete Your NOCTURNE Ticket Before the Price Increase';
  const text = [
    `${displayName},`, '',
    'You redeemed your NOCTURNE invitation, but your ticket purchase is not yet complete.', '',
    priceChangeText,
    `Complete your ${priceText} ticket purchase: ${checkoutUrl}`, '',
    'Optional at checkout: Late Checkout / Car Camping is $20 and allows the registered ticket holder to remain on the property after the 3:00 AM event end until 8:00 AM. Capacity is limited to 30 guests and availability is first-come, first-served.',
    'FINAL SALE / NON-REFUNDABLE: Late Checkout / Car Camping cannot be refunded, exchanged, prorated, transferred, converted to account credit, or redeemed for cash.', '',
    'Your invitation permits one ticket. This reminder stops automatically after your purchase is confirmed.', '',
    `Need help? ${HELP_EMAIL}`, '',
    'NOCTURNE Festival', 'Presented by Wild Ones & Bass Babes · Hawai‘i'
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#030303;color:#f7efe3;font-family:Arial,sans-serif"><div style="max-width:640px;margin:0 auto;padding:44px 24px"><div style="border:1px solid rgba(216,154,43,.35);background:#080604;padding:38px 30px"><div style="color:#d89a2b;font-size:11px;letter-spacing:3px;text-transform:uppercase">NOCTURNE · Ticket Reminder</div><h1 style="font-family:Georgia,serif;font-weight:400;font-size:42px;line-height:1.04;color:#fff3df;margin:16px 0 22px">Your invitation<br>is waiting.</h1><p style="color:#c8baa4;line-height:1.7">${escapeHtml(displayName)}, you redeemed your NOCTURNE invitation, but your ticket purchase is not yet complete.</p><div style="margin:28px 0;padding:18px;border-left:2px solid #d89a2b;background:#020202;color:#d8c7ac;line-height:1.7"><strong>General admission:</strong> ${escapeHtml(priceText)}<br><strong>Status:</strong> Awaiting purchase<br><strong style="color:#ffca61">${escapeHtml(priceChangeText)}</strong></div><p style="text-align:center;margin:30px 0"><a href="${escapeHtml(checkoutUrl)}" style="display:inline-block;padding:14px 20px;background:#d89a2b;color:#0b0803;text-decoration:none;font-size:12px;letter-spacing:2px;text-transform:uppercase">Complete Ticket Purchase</a></p><div style="margin:24px 0;padding:16px;border:1px solid rgba(216,154,43,.26);background:#050403;color:#b9aa94;line-height:1.65;font-size:13px"><strong style="color:#ffca61">Optional Late Checkout / Car Camping · $20</strong><br>Stay on the property after the 3:00 AM event end until 8:00 AM. Limited to 30 guests and available first-come, first-served during checkout.<br><br><strong style="color:#ffca61">FINAL SALE / NON-REFUNDABLE:</strong> Cannot be refunded, exchanged, prorated, transferred, converted to account credit, or redeemed for cash.</div><p style="color:#9d907f;line-height:1.7">This reminder stops automatically after your purchase is confirmed.</p><p style="color:#807564;font-size:12px">Need help? <a href="mailto:${escapeHtml(HELP_EMAIL)}" style="color:#ffca61">${escapeHtml(HELP_EMAIL)}</a></p><div style="margin-top:34px;padding-top:20px;border-top:1px solid rgba(216,154,43,.18);color:#74695b;font-size:11px;letter-spacing:1px;text-transform:uppercase">NOCTURNE Festival · Presented by Wild Ones &amp; Bass Babes · Hawai‘i</div></div></div></body></html>`;

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
  return { messageId: data.id || null, checkoutUrl };
}
