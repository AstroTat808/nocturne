import { getStore } from '@netlify/blobs';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const APPLICATION_STORE = 'nocturne-applications';
const REVIEW_STORE = 'nocturne-application-reviews';
const SESSION_COOKIE = 'nocturne_admin';
const HELP_EMAIL = process.env.NOCTURNE_HELP_EMAIL || 'help@nocturnefestival.com';

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' } });
}

function safeEqual(a = '', b = '') {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function secret() {
  return process.env.NOCTURNE_ADMIN_SESSION_SECRET || process.env.NOCTURNE_ADMIN_KEY || '';
}

function sign(value) {
  return createHmac('sha256', secret()).update(value).digest('base64url');
}

function parseCookies(req) {
  const header = req.headers.get('cookie') || '';
  return Object.fromEntries(header.split(';').map((part) => {
    const i = part.indexOf('=');
    if (i < 0) return ['', ''];
    let value = part.slice(i + 1).trim();
    try { value = decodeURIComponent(value); } catch {}
    return [part.slice(0, i).trim(), value];
  }).filter(([name]) => name));
}

function authenticated(req) {
  if (!secret()) return false;
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token || !token.includes('.')) return false;
  const [payload, signature] = token.split('.', 2);
  if (!safeEqual(signature, sign(payload))) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.role === 'admin' && Number(data.exp) > Math.floor(Date.now() / 1000);
  } catch { return false; }
}

function allowedOrigin(req) {
  const origin = req.headers.get('origin');
  if (!origin) return true;
  const allowed = new Set(['https://nocturnefestival.com', 'https://www.nocturnefestival.com']);
  try { allowed.add(new URL(req.url).origin); } catch {}
  for (const value of [process.env.NOCTURNE_SITE_URL, process.env.URL, process.env.DEPLOY_PRIME_URL]) {
    try { if (value) allowed.add(new URL(value).origin); } catch {}
  }
  return allowed.has(origin);
}

function normalizeCode(code) {
  return String(code || '').trim().toUpperCase().replace(/\s+/g, '');
}

function hashCode(code) {
  return createHash('sha256').update(normalizeCode(code)).digest('hex');
}

function escapeHtml(value = '') {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  if (!allowedOrigin(req)) return json({ error: 'Origin not allowed.' }, 403);
  if (!authenticated(req)) return json({ error: 'Unauthorized.' }, 401);
  if (!process.env.RESEND_API_KEY || !process.env.NOCTURNE_EMAIL_FROM) return json({ error: 'Direct email is not configured.' }, 503);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid request.' }, 400); }
  const submissionId = String(body.submissionId || '').trim();
  const code = normalizeCode(body.code);
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(submissionId)) return json({ error: 'Invalid submission ID.' }, 400);
  if (!/^NOC-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)) return json({ error: 'Invalid invitation code.' }, 400);

  const applicationStore = getStore({ name: APPLICATION_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const [application, review] = await Promise.all([
    applicationStore.get(submissionId, { type: 'json', consistency: 'strong' }),
    reviewStore.get(submissionId, { type: 'json', consistency: 'strong' })
  ]);
  if (!application?.email) return json({ error: 'Application email was not found.' }, 404);
  if (!review || review.status !== 'approved' || review.inviteState !== 'active' || !review.inviteHash) return json({ error: 'The applicant must have an active approved invitation.' }, 409);
  if (!safeEqual(hashCode(code), review.inviteHash)) return json({ error: 'The invitation code does not match the active invite.' }, 409);

  const site = (process.env.NOCTURNE_SITE_URL || new URL(req.url).origin).replace(/\/$/, '');
  const redeemUrl = `${site}/invite?code=${encodeURIComponent(code)}`;
  const subject = String(body.subject || 'Your NOCTURNE invitation').trim().slice(0, 160);
  const personalNote = String(body.note || '').trim().slice(0, 1400);
  const displayName = application.preferredName || application.fullName || 'Guest';
  const safeNote = escapeHtml(personalNote).replaceAll('\n', '<br>');

  const text = [
    `${displayName},`, '', 'Your request to enter NOCTURNE has been approved.',
    personalNote ? `\n${personalNote}\n` : '',
    `Invitation code: ${code}`,
    `Open your invitation with the code already filled in: ${redeemUrl}`,
    '', 'This invitation is intended for you and may be redeemed once. Keep the code private.',
    '', `Need help with the website? ${HELP_EMAIL}`, '',
    'NOCTURNE Festival', 'Presented by Wild Ones · Hawai‘i'
  ].filter(Boolean).join('\n');

  const html = `<!doctype html><html><body style="margin:0;background:#030303;color:#f7efe3;font-family:Arial,sans-serif"><div style="max-width:640px;margin:0 auto;padding:44px 24px"><div style="border:1px solid rgba(216,154,43,.35);background:#080604;padding:38px 30px"><div style="color:#d89a2b;font-size:11px;letter-spacing:3px;text-transform:uppercase">NOCTURNE · Private Invitation</div><h1 style="font-family:Georgia,serif;font-weight:400;font-size:40px;line-height:1.05;color:#fff3df;margin:16px 0 22px">The night has opened<br>for you.</h1><p style="color:#c8baa4;line-height:1.7">${escapeHtml(displayName)}, your request to enter NOCTURNE has been approved.</p>${safeNote ? `<p style="color:#c8baa4;line-height:1.7">${safeNote}</p>` : ''}<div style="margin:28px 0;padding:18px;text-align:center;border:1px solid rgba(255,202,97,.3);background:#020202;color:#ffca61;font-size:20px;letter-spacing:3px">${escapeHtml(code)}</div><p style="text-align:center;margin:28px 0"><a href="${escapeHtml(redeemUrl)}" style="display:inline-block;padding:14px 20px;background:#d89a2b;color:#0b0803;text-decoration:none;font-size:12px;letter-spacing:2px;text-transform:uppercase">Open & Verify Invitation</a></p><p style="color:#9d907f;line-height:1.7">The button opens the NOCTURNE verification page with your invitation code already filled in. You only need to press Verify Invitation.</p><p style="color:#8f8372;font-size:12px;line-height:1.7">This invitation is intended for you and may be redeemed once. Keep the code private.</p><p style="color:#807564;font-size:12px">Need help with the website? <a href="mailto:${escapeHtml(HELP_EMAIL)}" style="color:#ffca61">${escapeHtml(HELP_EMAIL)}</a></p><div style="margin-top:34px;padding-top:20px;border-top:1px solid rgba(216,154,43,.18);color:#74695b;font-size:11px;letter-spacing:1px;text-transform:uppercase">NOCTURNE Festival · Presented by Wild Ones · Hawai‘i</div></div></div></body></html>`;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.NOCTURNE_EMAIL_FROM, to: [application.email], subject, html, text })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return json({ error: data.message || 'Approval email could not be sent.' }, 502);

  const now = new Date().toISOString();
  const updatedReview = { ...review, inviteEmailSentAt: now, inviteEmailMessageId: data.id || null, updatedAt: now };
  await reviewStore.setJSON(submissionId, updatedReview);
  return json({ ok: true, recipient: application.email, messageId: data.id || null, review: updatedReview });
};
