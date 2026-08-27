import { createHmac, timingSafeEqual } from 'node:crypto';
import { writeAudit } from './_audit.mjs';
import { runInviteReminders } from './daily-invite-reminders.mjs';
import { runPurchaseReminders } from './daily-purchase-reminders.mjs';

const SESSION_COOKIE = 'nocturne_admin';

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

function sessionSecret() {
  return process.env.NOCTURNE_ADMIN_SESSION_SECRET || process.env.NOCTURNE_ADMIN_KEY || '';
}

function safeEqual(a = '', b = '') {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function sign(value) {
  return createHmac('sha256', sessionSecret()).update(value).digest('base64url');
}

function parseCookies(req) {
  const header = req.headers.get('cookie') || '';
  return Object.fromEntries(header.split(';').map((part) => {
    const index = part.indexOf('=');
    if (index < 0) return ['', ''];
    let value = part.slice(index + 1).trim();
    try { value = decodeURIComponent(value); } catch {}
    return [part.slice(0, index).trim(), value];
  }).filter(([key]) => key));
}

function authenticated(req) {
  if (!sessionSecret()) return false;
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token || !token.includes('.')) return false;
  const [payload, signature] = token.split('.', 2);
  if (!safeEqual(signature, sign(payload))) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.role === 'admin' && Number(data.exp) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
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

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  if (!authenticated(req)) return json({ error: 'Unauthorized.' }, 401);
  if (!allowedOrigin(req)) return json({ error: 'Origin not allowed.' }, 403);

  try {
    const invite = await runInviteReminders({ trigger: 'admin', scanAll: true });
    const purchase = await runPurchaseReminders({ trigger: 'admin', scanAll: true });
    const total = {
      scanned: Number(invite.scanned || 0) + Number(purchase.scanned || 0),
      sent: Number(invite.sent || 0) + Number(purchase.sent || 0),
      duplicate: Number(invite.duplicate || 0) + Number(purchase.duplicate || 0),
      ineligible: Number(invite.ineligible || 0) + Number(purchase.ineligible || 0),
      failed: Number(invite.failed || 0) + Number(purchase.failed || 0)
    };

    await writeAudit('reminders.manual_run', {
      invite,
      purchase,
      total
    });

    return json({ ok: true, invite, purchase, total });
  } catch (error) {
    console.error('NOCTURNE manual reminder run failed:', error);
    await writeAudit('reminders.manual_run_failed', { error: String(error?.message || error) }).catch(() => {});
    return json({ error: error?.message || 'Reminder run failed.' }, 500);
  }
};
