import { getStore } from '@netlify/blobs';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { verifyTicketToken } from './_ticket-token.mjs';
import { writeAudit } from './_audit.mjs';
import { drinkPackageConfig } from './_drink-package.mjs';

const ORDER_STORE = 'nocturne-ticket-orders';
const REVIEW_STORE = 'nocturne-application-reviews';
const APPLICATION_STORE = 'nocturne-applications';
const REDEMPTION_STORE = 'nocturne-drink-redemptions';
const COOKIE = 'nocturne_bar';
const TTL_SECONDS = 12 * 60 * 60;

function json(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}
function key() { return process.env.NOCTURNE_BAR_KEY || process.env.NOCTURNE_CHECKIN_KEY || process.env.NOCTURNE_ADMIN_KEY || ''; }
function secret() { return process.env.NOCTURNE_BAR_SESSION_SECRET || process.env.NOCTURNE_CHECKIN_SESSION_SECRET || process.env.NOCTURNE_ADMIN_SESSION_SECRET || process.env.NOCTURNE_ADMIN_KEY || ''; }
function safeEqual(a = '', b = '') { const left = Buffer.from(String(a)); const right = Buffer.from(String(b)); return left.length === right.length && timingSafeEqual(left, right); }
function sign(payload) { return createHmac('sha256', secret()).update(payload).digest('base64url'); }
function cookies(req) { return Object.fromEntries((req.headers.get('cookie') || '').split(';').map((part) => { const i = part.indexOf('='); if (i < 0) return ['', '']; let value = part.slice(i + 1).trim(); try { value = decodeURIComponent(value); } catch {} return [part.slice(0, i).trim(), value]; }).filter(([name]) => name)); }
function makeSession(staffName) { const now = Math.floor(Date.now() / 1000); const payload = Buffer.from(JSON.stringify({ role: 'bar', staffName, iat: now, exp: now + TTL_SECONDS, nonce: randomBytes(10).toString('base64url') })).toString('base64url'); return `${payload}.${sign(payload)}`; }
function session(req) { if (!secret()) return null; const token = cookies(req)[COOKIE]; if (!token?.includes('.')) return null; const [payload, signature] = token.split('.', 2); if (!safeEqual(signature, sign(payload))) return null; try { const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); return data.role === 'bar' && Number(data.exp) > Math.floor(Date.now() / 1000) ? data : null; } catch { return null; } }
function setCookie(token) { return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${TTL_SECONDS}`; }
function clearCookie() { return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`; }
async function input(req) { try { return await req.json(); } catch { return null; } }
function ticketToken(value = '') { const raw = String(value).trim(); if (!raw) return ''; try { return new URL(raw).searchParams.get('token') || ''; } catch { return raw; } }
function wristband(value = '') { return String(value).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 96); }
function wristbandHash(value) { return createHash('sha256').update(`nocturne-wristband:${value}`).digest('hex'); }
function publicPackage(summary, application) { return { submissionId: summary.submissionId, ticketId: summary.ticketId, guestName: application?.preferredName || application?.fullName || 'NOCTURNE Guest', packageStatus: summary.drinkPackageStatus, creditsPurchased: Number(summary.drinkCreditsPurchased || 0), creditsRedeemed: Number(summary.drinkCreditsRedeemed || 0), creditsRemaining: Number(summary.drinkCreditsRemaining || 0), activatedAt: summary.drinkPackageActivatedAt || null, lastRedeemedAt: summary.drinkPackageLastRedeemedAt || null }; }

async function resolvePackage(value) {
  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const parsed = verifyTicketToken(ticketToken(value));
  let submissionId = parsed?.submissionId || '';
  let expectedTicketId = parsed?.ticketId || '';
  if (!submissionId) {
    const serial = wristband(value);
    if (!serial) return null;
    const alias = await getStore({ name: REDEMPTION_STORE, consistency: 'strong' }).get(`wristband-${wristbandHash(serial)}`, { type: 'json', consistency: 'strong' });
    submissionId = alias?.submissionId || '';
  }
  if (!submissionId) return null;
  const entry = await orderStore.getWithMetadata(`submission-${submissionId}`, { type: 'json', consistency: 'strong' });
  if (!entry?.data || (expectedTicketId && entry.data.ticketId !== expectedTicketId)) return null;
  const application = await getStore({ name: APPLICATION_STORE, consistency: 'strong' }).get(submissionId, { type: 'json', consistency: 'strong' });
  return { entry, summary: entry.data, application, orderStore };
}

async function syncSecondary(summary) {
  try {
    const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
    const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
    if (summary.stripeCheckoutSessionId) {
      const order = await orderStore.get(summary.stripeCheckoutSessionId, { type: 'json', consistency: 'strong' });
      if (order) await orderStore.setJSON(summary.stripeCheckoutSessionId, { ...order, ...summary });
    }
    const review = await reviewStore.get(summary.submissionId, { type: 'json', consistency: 'strong' });
    if (review) {
      const packageFields = Object.fromEntries(Object.entries(summary).filter(([name]) => name.startsWith('drink')));
      await reviewStore.setJSON(summary.submissionId, { ...review, ...packageFields, updatedAt: summary.updatedAt });
    }
  } catch (error) { console.error('NOCTURNE drink package secondary sync failed:', error); }
}

async function lookup(value) {
  const found = await resolvePackage(value);
  if (!found?.summary || found.summary.status !== 'paid' || !found.summary.drinkPackagePurchased || ['refunded', 'disputed'].includes(found.summary.drinkPackageStatus)) return json({ error: 'No active drink package was found.' }, 404);
  return json({ ok: true, package: publicPackage(found.summary, found.application) });
}

async function activate(inputData, staff) {
  if (!inputData.ageVerified) return json({ error: 'Confirm that a bartender checked the guest’s 21+ photo ID.' }, 400);
  const found = await resolvePackage(inputData.ticket);
  const serial = wristband(inputData.wristband);
  if (!found?.summary || found.summary.status !== 'paid' || !found.summary.drinkPackagePurchased) return json({ error: 'This ticket does not have an active drink package.' }, 404);
  if (!found.summary.checkedInAt) return json({ error: 'Guest must complete event gate check-in before the Six-Drink Package can be activated.' }, 409);
  if (!serial || serial.length < 6) return json({ error: 'Scan or enter a wristband code with at least six characters.' }, 400);
  if (found.summary.drinkPackageStatus !== 'pending_activation') return json({ error: `Package is already ${found.summary.drinkPackageStatus || 'unavailable'}.` }, 409);
  const hash = wristbandHash(serial);
  const redemptionStore = getStore({ name: REDEMPTION_STORE, consistency: 'strong' });
  const aliasKey = `wristband-${hash}`;
  const now = new Date().toISOString();
  const claim = await redemptionStore.setJSON(aliasKey, { submissionId: found.summary.submissionId, ticketId: found.summary.ticketId, createdAt: now }, { onlyIfNew: true });
  if (!claim.modified) return json({ error: 'That wristband is already assigned.' }, 409);
  const next = { ...found.summary, drinkPackageStatus: 'active', drinkPackageWristbandHash: hash, drinkPackageActivatedAt: now, drinkPackageActivatedBy: staff.staffName, drinkPackageAgeVerifiedAt: now, updatedAt: now };
  const write = await found.orderStore.setJSON(`submission-${found.summary.submissionId}`, next, { onlyIfMatch: found.entry.etag });
  if (!write.modified) { await redemptionStore.delete(aliasKey); return json({ error: 'Package changed during activation. Scan again.' }, 409); }
  await syncSecondary(next);
  await writeAudit('drink_package.activated', { submissionId: next.submissionId, ticketId: next.ticketId, staffName: staff.staffName });
  return json({ ok: true, package: publicPackage(next, found.application) });
}

async function redeem(inputData, staff) {
  const found = await resolvePackage(inputData.value || inputData.wristband);
  if (!found?.summary || found.summary.status !== 'paid' || found.summary.drinkPackageStatus !== 'active') return json({ error: 'This wristband does not have an active drink package.' }, 403);
  const drinkType = String(inputData.drinkType || '').toLowerCase();
  if (!['beer', 'well', 'premium', 'nonalcoholic'].includes(drinkType)) return json({ error: 'Choose the drink being redeemed.' }, 400);
  if (drinkType === 'premium' && !inputData.premiumUpgradePaid) return json({ error: 'Confirm the $5 premium upgrade was collected.' }, 400);
  const remaining = Number(found.summary.drinkCreditsRemaining || 0);
  if (remaining < 1) return json({ error: 'This package has no credits remaining.' }, 409);
  const config = drinkPackageConfig();
  const elapsedMs = Date.now() - new Date(found.summary.drinkPackageLastRedeemedAt || 0).getTime();
  if (found.summary.drinkPackageLastRedeemedAt && elapsedMs < config.rapidWarningMinutes * 60_000 && !inputData.rapidOverride) {
    return json({ error: `Last redemption was less than ${config.rapidWarningMinutes} minutes ago. Confirm bartender override to continue.`, code: 'rapid_redemption', package: publicPackage(found.summary, found.application) }, 409);
  }
  const now = new Date().toISOString();
  const nextRemaining = remaining - 1;
  const counter = `${drinkType === 'nonalcoholic' ? 'Nonalcoholic' : drinkType[0].toUpperCase() + drinkType.slice(1)}Redemptions`;
  const counterKey = `drink${counter}`;
  const next = { ...found.summary, drinkPackageStatus: nextRemaining === 0 ? 'exhausted' : 'active', drinkCreditsRedeemed: Number(found.summary.drinkCreditsRedeemed || 0) + 1, drinkCreditsRemaining: nextRemaining, drinkPackageLastRedeemedAt: now, drinkPackageLastRedeemedBy: staff.staffName, [counterKey]: Number(found.summary[counterKey] || 0) + 1, drinkPremiumUpgradeTotalCents: Number(found.summary.drinkPremiumUpgradeTotalCents || 0) + (drinkType === 'premium' ? config.premiumUpgradeCents : 0), updatedAt: now };
  const write = await found.orderStore.setJSON(`submission-${found.summary.submissionId}`, next, { onlyIfMatch: found.entry.etag });
  if (!write.modified) return json({ error: 'Balance changed during redemption. Scan again.' }, 409);
  const redemptionId = `${Date.now()}-${randomBytes(8).toString('hex')}`;
  await getStore({ name: REDEMPTION_STORE, consistency: 'strong' }).setJSON(`redemption-${redemptionId}`, { redemptionId, submissionId: next.submissionId, ticketId: next.ticketId, drinkType, premiumUpgradePaid: drinkType === 'premium', premiumUpgradeCents: drinkType === 'premium' ? config.premiumUpgradeCents : 0, rapidOverride: Boolean(inputData.rapidOverride), staffName: staff.staffName, creditsRemaining: nextRemaining, redeemedAt: now });
  await syncSecondary(next);
  await writeAudit('drink_package.redeemed', { submissionId: next.submissionId, ticketId: next.ticketId, drinkType, staffName: staff.staffName, creditsRemaining: nextRemaining, rapidOverride: Boolean(inputData.rapidOverride) });
  return json({ ok: true, package: publicPackage(next, found.application), drinkType });
}

export default async (req) => {
  if (!['GET', 'POST'].includes(req.method)) return json({ error: 'Method not allowed.' }, 405);
  if (req.method === 'GET') { const staff = session(req); return staff ? json({ authenticated: true, staffName: staff.staffName }) : json({ authenticated: false }, 401); }
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(req.url).origin) return json({ error: 'Origin not allowed.' }, 403);
  const data = await input(req); if (!data) return json({ error: 'Invalid request.' }, 400);
  const action = String(data.action || 'lookup');
  if (action === 'login') { const staffName = String(data.staffName || '').trim().slice(0, 80); if (!key() || !secret()) return json({ error: 'Bar authentication is not configured.' }, 500); if (!staffName) return json({ error: 'Enter the bartender name.' }, 400); if (!safeEqual(data.password || '', key())) return json({ error: 'Invalid bar password.' }, 401); return json({ ok: true, staffName }, 200, { 'Set-Cookie': setCookie(makeSession(staffName)) }); }
  if (action === 'logout') return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
  const staff = session(req); if (!staff) return json({ error: 'Unauthorized.' }, 401);
  if (action === 'lookup') return lookup(data.value || data.ticket || data.wristband);
  if (action === 'activate') return activate(data, staff);
  if (action === 'redeem') return redeem(data, staff);
  return json({ error: 'Unknown action.' }, 400);
};
