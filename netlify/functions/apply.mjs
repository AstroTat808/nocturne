import { getStore } from '@netlify/blobs';
import { createHash, randomUUID } from 'node:crypto';

const APPLICATION_STORE = 'nocturne-applications';
const RATE_STORE = 'nocturne-application-rate-limits';
const APPLICATION_NOTIFY_TO = process.env.NOCTURNE_APPLICATION_NOTIFY_TO || 'invites@nocturnefestival.com';
const HELP_EMAIL = process.env.NOCTURNE_HELP_EMAIL || 'help@nocturnefestival.com';
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 5;
const DUPLICATE_WINDOW_MS = 30 * 60 * 1000;
const MAX = {
  full_name: 120,
  preferred_name: 120,
  email: 254,
  phone: 40,
  location: 160,
  instagram: 120,
  referral: 160,
  community: 1500,
  why_nocturne: 2000,
  group_names: 1000
};

function clean(value, max = 5000) {
  return String(value ?? '').trim().slice(0, max);
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function phoneDigits(value = '') {
  let digits = String(value).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  return digits;
}

function formatPhone(value = '') {
  const digits = phoneDigits(value);
  if (digits.length !== 10) return clean(value, MAX.phone);
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function json(data, status = 200, extraHeaders = {}) {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      ...extraHeaders
    }
  });
}

async function readFields(req) {
  const type = (req.headers.get('content-type') || '').toLowerCase();

  if (type.includes('application/json')) {
    const body = await req.json();
    return body && typeof body === 'object' ? body : {};
  }

  if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
    const form = await req.formData();
    return Object.fromEntries(form.entries());
  }

  throw new Error('Unsupported content type.');
}

function validate(fields) {
  const fullName = clean(fields.full_name, MAX.full_name);
  const email = clean(fields.email, MAX.email).toLowerCase();
  const phone = clean(fields.phone, MAX.phone);
  const location = clean(fields.location, MAX.location);
  const referral = clean(fields.referral, MAX.referral);
  const whyNocturne = clean(fields.why_nocturne, MAX.why_nocturne);

  if (!fullName) return 'Full name is required.';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'A valid email address is required.';
  if (phoneDigits(phone).length !== 10) return 'Please enter a valid 10-digit mobile number.';
  if (!location) return 'Location is required.';
  if (!referral) return 'Referral source is required.';
  if (whyNocturne.length < 50) return 'Please tell us a little more about why you want to attend.';
  if (clean(fields.conduct_ack) !== 'yes') return 'The Code of Conduct acknowledgement is required.';
  if (clean(fields.selection_ack) !== 'yes') return 'The selection acknowledgement is required.';
  if (clean(fields.privacy_ack) !== 'yes') return 'The Privacy Notice acknowledgement is required.';

  return null;
}

function spamScore(fields) {
  const text = [
    fields.full_name,
    fields.preferred_name,
    fields.location,
    fields.instagram,
    fields.referral,
    fields.community,
    fields.why_nocturne,
    fields.group_names
  ].map((value) => clean(value, 5000).toLowerCase()).join('\n');

  let score = 0;
  const urls = text.match(/(?:https?:\/\/|www\.)\S+/g) || [];
  if (urls.length >= 2) score += 3;
  else if (urls.length === 1) score += 1;

  const strongSignals = [
    't.me/',
    'telegram',
    'wa.me/',
    'whatsapp',
    '50,000 messages',
    '50000 messages',
    'million messages',
    'contact form messages',
    'send messages lawfully',
    'bulk messages',
    'our service is free'
  ];
  for (const signal of strongSignals) {
    if (text.includes(signal)) score += 2;
  }

  if (/\$\s?\d{2,4}/.test(text) && /(message|marketing|service|telegram|whatsapp)/.test(text)) score += 2;
  if ((text.match(/https?:\/\//g) || []).length >= 3) score += 2;

  return score;
}

function clientIp(req) {
  const direct = clean(req.headers.get('x-nf-client-connection-ip'), 80);
  if (direct) return direct;
  return clean((req.headers.get('x-forwarded-for') || '').split(',')[0], 80) || 'unknown';
}

function hashKey(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

async function enforceRateLimit(req, fields) {
  const store = getStore({ name: RATE_STORE, consistency: 'strong' });
  const now = Date.now();
  const ipHash = hashKey(clientIp(req));
  const emailHash = hashKey(clean(fields.email, MAX.email).toLowerCase());
  const ipKey = `ip-${ipHash}`;
  const emailKey = `email-${emailHash}`;

  const [ipState, emailState] = await Promise.all([
    store.get(ipKey, { type: 'json', consistency: 'strong' }).catch(() => null),
    store.get(emailKey, { type: 'json', consistency: 'strong' }).catch(() => null)
  ]);

  const currentIp = ipState && Number(ipState.windowStart) > now - RATE_WINDOW_MS
    ? ipState
    : { windowStart: now, count: 0 };

  if (Number(currentIp.count) >= RATE_MAX) {
    const retryAfter = Math.max(60, Math.ceil((Number(currentIp.windowStart) + RATE_WINDOW_MS - now) / 1000));
    return { blocked: true, status: 429, error: 'Too many invitation requests were submitted from this connection. Please try again later.', retryAfter };
  }

  if (emailState && Number(emailState.lastSubmittedAt) > now - DUPLICATE_WINDOW_MS) {
    return { blocked: true, status: 429, error: 'An invitation request for this email was submitted recently. Please wait before trying again.', retryAfter: 1800 };
  }

  await Promise.all([
    store.setJSON(ipKey, { windowStart: Number(currentIp.windowStart), count: Number(currentIp.count) + 1, updatedAt: now }),
    store.setJSON(emailKey, { lastSubmittedAt: now })
  ]);

  return { blocked: false };
}

async function verifyTurnstile(req, fields) {
  const secret = clean(process.env.NOCTURNE_TURNSTILE_SECRET_KEY, 500);
  const siteKey = clean(process.env.NOCTURNE_TURNSTILE_SITE_KEY, 500);
  if (!secret && !siteKey) return { ok: true, configured: false };
  if (!secret || !siteKey) return { ok: false, configured: true, error: 'Bot protection is temporarily unavailable. Please contact support.' };

  const token = clean(fields['cf-turnstile-response'], 4096);
  if (!token) return { ok: false, configured: true, error: 'Please complete the security check and try again.' };

  const body = new URLSearchParams({
    secret,
    response: token,
    remoteip: clientIp(req)
  });

  let response;
  try {
    response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
  } catch {
    return { ok: false, configured: true, error: 'The security check could not be verified. Please try again.' };
  }

  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.success !== true) {
    console.warn('NOCTURNE Turnstile verification failed:', result['error-codes'] || response.status);
    return { ok: false, configured: true, error: 'The security check could not be verified. Please try again.' };
  }

  if (result.action && result.action !== 'invite_request') {
    return { ok: false, configured: true, error: 'The security check was invalid. Please refresh and try again.' };
  }

  const expectedHosts = new Set(['nocturnefestival.com', 'www.nocturnefestival.com']);
  try {
    for (const value of [process.env.NOCTURNE_SITE_URL, process.env.URL, process.env.DEPLOY_PRIME_URL]) {
      if (value) expectedHosts.add(new URL(value).hostname);
    }
  } catch {}
  if (result.hostname && !expectedHosts.has(result.hostname)) {
    return { ok: false, configured: true, error: 'The security check came from an unexpected host.' };
  }

  return { ok: true, configured: true };
}

async function sendApplicationNotification(application) {
  if (!process.env.RESEND_API_KEY || !process.env.NOCTURNE_EMAIL_FROM) {
    return { sent: false, reason: 'Email not configured.' };
  }

  const site = (process.env.NOCTURNE_SITE_URL || 'https://nocturnefestival.com').replace(/\/$/, '');
  const adminUrl = `${site}/admin`;
  const subject = `New NOCTURNE invite request — ${application.fullName}`;
  const text = [
    'A new NOCTURNE invitation request was submitted.',
    '',
    `Name: ${application.fullName}`,
    application.preferredName ? `Preferred name: ${application.preferredName}` : '',
    `Email: ${application.email}`,
    `Phone: ${application.phone}`,
    `Location: ${application.location}`,
    application.instagram ? `Instagram: ${application.instagram}` : '',
    `Referral: ${application.referral}`,
    '',
    `Why NOCTURNE: ${application.whyNocturne}`,
    '',
    `Review in admin: ${adminUrl}`,
    '',
    `Site support: ${HELP_EMAIL}`
  ].filter(Boolean).join('\n');

  const html = `<!doctype html><html><body style="margin:0;background:#030303;color:#f7efe3;font-family:Arial,sans-serif"><div style="max-width:680px;margin:0 auto;padding:40px 24px"><div style="border:1px solid rgba(216,154,43,.35);background:#080604;padding:34px 28px"><div style="color:#d89a2b;font-size:11px;letter-spacing:3px;text-transform:uppercase">NOCTURNE · New Invitation Request</div><h1 style="font-family:Georgia,serif;font-weight:400;color:#fff3df">${escapeHtml(application.fullName)}</h1><div style="line-height:1.8;color:#c8baa4"><strong>Email:</strong> ${escapeHtml(application.email)}<br><strong>Phone:</strong> ${escapeHtml(application.phone)}<br><strong>Location:</strong> ${escapeHtml(application.location)}${application.instagram ? `<br><strong>Instagram:</strong> ${escapeHtml(application.instagram)}` : ''}<br><strong>Referral:</strong> ${escapeHtml(application.referral)}</div><div style="margin:24px 0;padding:18px;border-left:2px solid #d89a2b;background:#020202;color:#d8c7ac;line-height:1.7"><strong>Why NOCTURNE</strong><br>${escapeHtml(application.whyNocturne)}</div><p style="text-align:center;margin:28px 0"><a href="${escapeHtml(adminUrl)}" style="display:inline-block;padding:14px 20px;background:#d89a2b;color:#0b0803;text-decoration:none;font-size:12px;letter-spacing:2px;text-transform:uppercase">Open Admin Review</a></p><p style="color:#807564;font-size:12px">Site support: <a href="mailto:${escapeHtml(HELP_EMAIL)}" style="color:#ffca61">${escapeHtml(HELP_EMAIL)}</a></p></div></div></body></html>`;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: process.env.NOCTURNE_EMAIL_FROM,
      to: [APPLICATION_NOTIFY_TO],
      subject,
      html,
      text
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `Resend returned ${response.status}.`);
  return { sent: true, messageId: data.id || null };
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  let fields;
  try {
    fields = await readFields(req);
  } catch {
    return json({ error: 'Invalid application request.' }, 400);
  }

  if (clean(fields['bot-field'])) {
    return req.headers.get('x-nocturne-ajax') === '1'
      ? json({ ok: true }, 201)
      : new Response(null, { status: 303, headers: { Location: '/application-received.html' } });
  }

  const error = validate(fields);
  if (error) return json({ error }, 400);

  if (spamScore(fields) >= 4) {
    console.warn('NOCTURNE application rejected by spam scoring.');
    return req.headers.get('x-nocturne-ajax') === '1'
      ? json({ ok: true }, 201)
      : new Response(null, { status: 303, headers: { Location: '/application-received.html' } });
  }

  const turnstile = await verifyTurnstile(req, fields);
  if (!turnstile.ok) return json({ error: turnstile.error }, 403);

  try {
    const rate = await enforceRateLimit(req, fields);
    if (rate.blocked) {
      return json({ error: rate.error }, rate.status, { 'Retry-After': String(rate.retryAfter) });
    }
  } catch (error) {
    console.error('NOCTURNE application rate-limit check failed:', error);
    return json({ error: 'Your request could not be verified. Please try again.' }, 503);
  }

  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const application = {
    id,
    createdAt,
    fullName: clean(fields.full_name, MAX.full_name),
    preferredName: clean(fields.preferred_name, MAX.preferred_name),
    email: clean(fields.email, MAX.email).toLowerCase(),
    phone: formatPhone(fields.phone),
    location: clean(fields.location, MAX.location),
    instagram: clean(fields.instagram, MAX.instagram),
    referral: clean(fields.referral, MAX.referral),
    community: clean(fields.community, MAX.community),
    whyNocturne: clean(fields.why_nocturne, MAX.why_nocturne),
    groupNames: clean(fields.group_names, MAX.group_names),
    conductAck: clean(fields.conduct_ack) === 'yes',
    selectionAck: clean(fields.selection_ack) === 'yes',
    privacyAck: clean(fields.privacy_ack) === 'yes',
    marketingOptIn: clean(fields.marketing_opt_in) === 'yes'
  };

  try {
    const store = getStore({ name: APPLICATION_STORE, consistency: 'strong' });
    await store.setJSON(id, application, {
      metadata: { createdAt, email: application.email }
    });
  } catch (error) {
    console.error('NOCTURNE application storage failed:', error);
    return json({ error: 'Your application could not be stored. Please try again.' }, 500);
  }

  try {
    await sendApplicationNotification(application);
  } catch (error) {
    console.error('NOCTURNE application notification email failed:', error);
  }

  if (req.headers.get('x-nocturne-ajax') === '1') return json({ ok: true, id }, 201);

  return new Response(null, {
    status: 303,
    headers: {
      Location: '/application-received.html',
      'Cache-Control': 'no-store'
    }
  });
};
