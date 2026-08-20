import { createHmac, timingSafeEqual } from 'node:crypto';

function ticketSecret() {
  return process.env.NOCTURNE_TICKET_QR_SECRET || process.env.NOCTURNE_TICKET_ACCESS_SECRET || process.env.NOCTURNE_ADMIN_SESSION_SECRET || process.env.NOCTURNE_ADMIN_KEY || '';
}

function constantTimeEqual(a = '', b = '') {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function sign(payload) {
  return createHmac('sha256', ticketSecret()).update(payload).digest('base64url');
}

export function ticketTokensConfigured() {
  return Boolean(ticketSecret());
}

export function makeTicketToken(ticketId, submissionId) {
  if (!ticketSecret()) return null;
  const ticket = String(ticketId || '').trim();
  const submission = String(submissionId || '').trim();
  if (!/^NOC-TKT-[A-Z0-9_-]{6,40}$/.test(ticket)) return null;
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(submission)) return null;

  const payload = Buffer.from(JSON.stringify({
    v: 1,
    scope: 'nocturne-ticket',
    t: ticket,
    s: submission
  })).toString('base64url');

  return `${payload}.${sign(payload)}`;
}

export function verifyTicketToken(token) {
  if (!ticketSecret() || !token || !String(token).includes('.')) return null;
  const [payload, signature] = String(token).split('.', 2);
  if (!constantTimeEqual(signature, sign(payload))) return null;

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.v !== 1 || data.scope !== 'nocturne-ticket') return null;
    if (!/^NOC-TKT-[A-Z0-9_-]{6,40}$/.test(String(data.t || ''))) return null;
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(String(data.s || ''))) return null;
    return { ticketId: data.t, submissionId: data.s };
  } catch {
    return null;
  }
}
