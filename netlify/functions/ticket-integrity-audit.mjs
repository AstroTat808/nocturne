import { getStore } from '@netlify/blobs';
import { createHash, createPublicKey, timingSafeEqual, verify as verifySignature } from 'node:crypto';
import { makeTicketToken, verifyTicketToken } from './_ticket-token.mjs';
import { gateReadiness } from './_gate-readiness.mjs';
import { waiverSigned } from './_waiver.mjs';

const ORDER_STORE = 'nocturne-ticket-orders';
const REVIEW_STORE = 'nocturne-application-reviews';
const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const GITHUB_OIDC_AUDIENCE = 'nocturne-ticket-audit';
const GITHUB_REPOSITORY = 'AstroTat808/nocturne';
const GITHUB_REF = 'refs/heads/ticket-integrity-audit-20260905';
let githubJwks = null;

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8', 'X-Robots-Tag': 'noindex,nofollow,noarchive' } });
}
function safeEqual(a = '', b = '') {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}
function auditSecret() {
  return String(Netlify.env.get('NOCTURNE_TICKET_AUDIT_SECRET') || '');
}
function decodeJwtPart(value = '') {
  try { return JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8')); } catch { return null; }
}
function audienceMatches(aud) {
  return Array.isArray(aud) ? aud.includes(GITHUB_OIDC_AUDIENCE) : aud === GITHUB_OIDC_AUDIENCE;
}
async function githubOidcAuthorized(req) {
  const authorization = String(req.headers.get('authorization') || '');
  if (!authorization.startsWith('Bearer ')) return false;
  const token = authorization.slice(7).trim();
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJwtPart(encodedHeader);
  const payload = decodeJwtPart(encodedPayload);
  if (!header || !payload || header.alg !== 'RS256' || !header.kid) return false;
  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== GITHUB_OIDC_ISSUER || !audienceMatches(payload.aud)) return false;
  if (payload.repository !== GITHUB_REPOSITORY || payload.ref !== GITHUB_REF) return false;
  if (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) <= now) return false;
  if (payload.nbf && Number(payload.nbf) > now + 30) return false;
  if (payload.iat && Number(payload.iat) > now + 30) return false;
  try {
    if (!githubJwks) {
      const response = await fetch(`${GITHUB_OIDC_ISSUER}/.well-known/jwks`);
      if (!response.ok) return false;
      githubJwks = await response.json();
    }
    const jwk = githubJwks?.keys?.find((item) => item.kid === header.kid && item.kty === 'RSA');
    if (!jwk) return false;
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    return verifySignature(
      'RSA-SHA256',
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      key,
      Buffer.from(encodedSignature, 'base64url')
    );
  } catch {
    return false;
  }
}
async function authorized(req) {
  const expected = auditSecret();
  const supplied = String(req.headers.get('x-nocturne-audit-secret') || new URL(req.url).searchParams.get('key') || '');
  if (expected && supplied && safeEqual(expected, supplied)) return true;
  return githubOidcAuthorized(req);
}
function tokenFromUrl(value = '') {
  try { return new URL(String(value)).searchParams.get('token') || ''; } catch { return ''; }
}
function anon(value = '') {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}
function activeAddonStatus(status = '') {
  return !['refunded', 'disputed', 'cancelled', 'invalidated'].includes(String(status || '').toLowerCase());
}
function addIssue(list, code, severity = 'error', detail = '') {
  list.push({ code, severity, detail });
}
async function stripeGet(path) {
  const key = String(Netlify.env.get('STRIPE_SECRET_KEY') || '');
  if (!key) return { ok: false, error: 'stripe_not_configured' };
  try {
    const response = await fetch(`https://api.stripe.com/v1/${path}`, { headers: { Authorization: `Bearer ${key}` } });
    const data = await response.json().catch(() => ({}));
    return response.ok ? { ok: true, data } : { ok: false, error: data?.error?.message || `stripe_${response.status}` };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}
async function productionGet(path) {
  const base = String(Netlify.env.get('NOCTURNE_SITE_URL') || 'https://nocturnefestival.com').replace(/\/$/, '');
  try {
    const response = await fetch(`${base}${path}`, { redirect: 'manual', headers: { 'User-Agent': 'NOCTURNE-Ticket-Audit/1.0' } });
    return { status: response.status, contentType: response.headers.get('content-type') || '' };
  } catch (error) {
    return { status: 0, error: String(error?.message || error) };
  }
}

export default async (req) => {
  if (req.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
  if (!(await authorized(req))) return json({ error: 'Unauthorized.' }, 401);

  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const { blobs } = await orderStore.list({ prefix: 'submission-' });
  const rows = [];

  for (let i = 0; i < blobs.length; i += 8) {
    const batch = blobs.slice(i, i + 8);
    const batchRows = await Promise.all(batch.map(async ({ key }) => {
      const submissionId = key.slice('submission-'.length);
      const [summary, review] = await Promise.all([
        orderStore.get(key, { type: 'json' }),
        reviewStore.get(submissionId, { type: 'json' })
      ]);
      if (!summary?.ticketId) return null;
      const activeCandidate = summary.status === 'paid' || ['paid', 'checked_in'].includes(String(review?.ticketState || ''));
      if (!activeCandidate) return null;

      const issues = [];
      const gate = gateReadiness(summary, review, summary.ticketId);
      for (const error of gate.errors) addIssue(issues, 'gate_readiness', 'error', error);
      for (const warning of gate.warnings) addIssue(issues, 'gate_warning', 'warning', warning);

      const generatedToken = makeTicketToken(summary.ticketId, submissionId);
      if (!generatedToken) addIssue(issues, 'token_generation_failed', 'error');
      else {
        const parsed = verifyTicketToken(generatedToken);
        if (!parsed || parsed.ticketId !== summary.ticketId || parsed.submissionId !== submissionId) addIssue(issues, 'generated_token_failed_verification', 'error');
      }

      const storedToken = tokenFromUrl(summary.digitalTicketUrl || review?.digitalTicketUrl || '');
      if (!storedToken) addIssue(issues, 'stored_ticket_url_missing_token', 'warning');
      else {
        const parsed = verifyTicketToken(storedToken);
        if (!parsed) addIssue(issues, 'stored_ticket_token_invalid', 'error');
        else if (parsed.ticketId !== summary.ticketId || parsed.submissionId !== submissionId) addIssue(issues, 'stored_ticket_token_wrong_record', 'error');
      }

      const effectiveToken = storedToken || generatedToken || '';
      let ticketHttp = null;
      let qrHttp = null;
      if (effectiveToken) {
        [ticketHttp, qrHttp] = await Promise.all([
          productionGet(`/ticket?token=${encodeURIComponent(effectiveToken)}`),
          productionGet(`/ticket/qr?token=${encodeURIComponent(effectiveToken)}`)
        ]);
        if (ticketHttp.status !== 200) addIssue(issues, 'production_ticket_page_not_200', 'error', String(ticketHttp.status));
        const signed = waiverSigned(summary, review);
        if (signed && qrHttp.status !== 200) addIssue(issues, 'signed_ticket_qr_not_200', 'error', String(qrHttp.status));
        if (!signed && qrHttp.status !== 403) addIssue(issues, 'unsigned_ticket_qr_unexpected_status', 'warning', String(qrHttp.status));
      }

      const source = summary.ticketSource === 'comp' || /^NOC-TKT-COMP-/.test(String(summary.ticketId || '')) ? 'comp' : 'paid';
      if (source === 'comp') {
        if (summary.stripePaymentIntentId) addIssue(issues, 'comp_has_admission_payment_intent', 'error');
        if (Number(summary.amountTotal || 0) !== 0) addIssue(issues, 'comp_has_nonzero_admission_amount', 'error', String(summary.amountTotal));
      } else if (summary.stripePaymentIntentId) {
        const admissionStripe = await stripeGet(`payment_intents/${encodeURIComponent(summary.stripePaymentIntentId)}`);
        if (!admissionStripe.ok) addIssue(issues, 'admission_payment_intent_lookup_failed', 'error', admissionStripe.error || 'unknown');
        else if (admissionStripe.data.status !== 'succeeded') addIssue(issues, 'admission_payment_not_succeeded', 'error', String(admissionStripe.data.status || 'missing'));
      } else {
        addIssue(issues, 'paid_ticket_missing_admission_payment_intent', 'warning');
      }

      const addons = {
        drink: Boolean(summary.drinkPackagePurchased),
        water: Boolean(summary.waterPackagePurchased),
        lateStay: Boolean(summary.lateStayPurchased)
      };
      const addonPaymentIntents = [];

      if (addons.drink) {
        const status = String(summary.drinkPackageStatus || '');
        const purchased = Number(summary.drinkCreditsPurchased || 0);
        const remaining = Number(summary.drinkCreditsRemaining || 0);
        const redeemed = Number(summary.drinkCreditsRedeemed || 0);
        if (!activeAddonStatus(status)) addIssue(issues, 'drink_addon_not_active', 'error', status || 'missing');
        if (purchased !== 6) addIssue(issues, 'drink_credit_purchase_count_invalid', 'error', String(purchased));
        if (remaining < 0 || remaining > purchased) addIssue(issues, 'drink_credit_remaining_invalid', 'error', String(remaining));
        if (redeemed < 0 || redeemed > purchased || redeemed + remaining !== purchased) addIssue(issues, 'drink_credit_accounting_mismatch', 'error', `${redeemed}+${remaining}!=${purchased}`);
        if (status === 'active' && !summary.drinkPackageWristbandHash) addIssue(issues, 'active_drink_package_missing_wristband', 'error');
        if (status === 'exhausted' && remaining !== 0) addIssue(issues, 'exhausted_drink_package_has_remaining_credit', 'error', String(remaining));
        if (summary.drinkPackagePaymentIntentId) addonPaymentIntents.push(['drink', summary.drinkPackagePaymentIntentId]);
      }
      if (addons.water) {
        const status = String(summary.waterPackageStatus || '');
        if (!activeAddonStatus(status) || (status && status !== 'active')) addIssue(issues, 'water_addon_not_active', 'error', status || 'missing');
        if (summary.waterPackagePaymentIntentId) addonPaymentIntents.push(['water', summary.waterPackagePaymentIntentId]);
      }
      if (addons.lateStay) {
        const status = String(summary.lateStayStatus || '');
        if (!activeAddonStatus(status) || (status && status !== 'active')) addIssue(issues, 'late_stay_addon_not_active', 'error', status || 'missing');
        if (summary.lateStayDepartureTime && summary.lateStayDepartureTime !== '10:00 AM') addIssue(issues, 'late_stay_departure_stale', 'warning', String(summary.lateStayDepartureTime));
        if (summary.lateStayPaymentIntentId) addonPaymentIntents.push(['lateStay', summary.lateStayPaymentIntentId]);
      }

      for (const [kind, paymentIntentId] of addonPaymentIntents) {
        const pi = await stripeGet(`payment_intents/${encodeURIComponent(paymentIntentId)}`);
        if (!pi.ok) addIssue(issues, `${kind}_payment_intent_lookup_failed`, 'error', pi.error || 'unknown');
        else if (pi.data.status !== 'succeeded') addIssue(issues, `${kind}_payment_not_succeeded`, 'error', String(pi.data.status || 'missing'));
      }

      return {
        ref: anon(submissionId),
        ticketRef: anon(summary.ticketId),
        source,
        signedWaiver: waiverSigned(summary, review),
        checkedIn: Boolean(summary.checkedInAt || review?.checkedInAt || review?.ticketState === 'checked_in'),
        ticketPageStatus: ticketHttp?.status || null,
        qrStatus: qrHttp?.status || null,
        addons,
        drinkStatus: summary.drinkPackagePurchased ? summary.drinkPackageStatus || null : null,
        waterStatus: summary.waterPackagePurchased ? summary.waterPackageStatus || null : null,
        lateStayStatus: summary.lateStayPurchased ? summary.lateStayStatus || null : null,
        ready: !issues.some((item) => item.severity === 'error'),
        issues
      };
    }));
    rows.push(...batchRows.filter(Boolean));
  }

  const byTicketRef = new Map();
  for (const row of rows) {
    const arr = byTicketRef.get(row.ticketRef) || [];
    arr.push(row);
    byTicketRef.set(row.ticketRef, arr);
  }
  for (const group of byTicketRef.values()) {
    if (group.length < 2) continue;
    for (const row of group) {
      addIssue(row.issues, 'duplicate_active_ticket_id', 'error');
      row.ready = false;
    }
  }

  const count = (fn) => rows.filter(fn).length;
  const errors = rows.filter((r) => r.issues.some((i) => i.severity === 'error'));
  const warnings = rows.filter((r) => r.issues.some((i) => i.severity === 'warning'));
  const summary = {
    activeTickets: rows.length,
    paidTickets: count((r) => r.source === 'paid'),
    compTickets: count((r) => r.source === 'comp'),
    signedWaivers: count((r) => r.signedWaiver),
    unsignedWaivers: count((r) => !r.signedWaiver),
    alreadyCheckedIn: count((r) => r.checkedIn),
    readyNow: count((r) => r.ready),
    brokenOrBlocked: errors.length,
    withWarnings: warnings.length,
    drinkPackages: count((r) => r.addons.drink),
    waterPackages: count((r) => r.addons.water),
    lateStayPackages: count((r) => r.addons.lateStay),
    ticketsWithAnyAddon: count((r) => r.addons.drink || r.addons.water || r.addons.lateStay),
    ticketPages200: count((r) => r.ticketPageStatus === 200),
    signedQr200: count((r) => r.signedWaiver && r.qrStatus === 200),
    unsignedQrLocked403: count((r) => !r.signedWaiver && r.qrStatus === 403),
    allIntegrityChecksPass: errors.length === 0
  };

  return json({ ok: true, generatedAt: new Date().toISOString(), summary, errors, warnings, rows });
};

export const config = { path: '/api/internal/ticket-integrity-audit' };
