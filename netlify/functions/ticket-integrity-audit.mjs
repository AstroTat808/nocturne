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
const PRODUCTION_BASE = 'https://nocturnefestival.com';
const WAIVER_ERROR = 'Required participant waiver has not been signed for this ticket.';
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
    return verifySignature('RSA-SHA256', Buffer.from(`${encodedHeader}.${encodedPayload}`), key, Buffer.from(encodedSignature, 'base64url'));
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
function addIssue(list, code, severity = 'error', detail = '') {
  list.push({ code, severity, detail });
}
function hasErrors(issues) {
  return issues.some((item) => item.severity === 'error');
}
function hasBlockers(issues) {
  return issues.some((item) => item.severity === 'blocker');
}
function stringIncludesAny(value, words) {
  const text = String(value || '').toLowerCase();
  return words.some((word) => text.includes(word));
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
async function verifyPaymentIntent(paymentIntentId, issues, codePrefix) {
  if (!paymentIntentId) return false;
  const result = await stripeGet(`payment_intents/${encodeURIComponent(paymentIntentId)}`);
  if (!result.ok) {
    addIssue(issues, `${codePrefix}_payment_intent_lookup_failed`, 'error', result.error || 'unknown');
    return false;
  }
  if (result.data.status !== 'succeeded') {
    addIssue(issues, `${codePrefix}_payment_not_succeeded`, 'error', String(result.data.status || 'missing'));
    return false;
  }
  return true;
}
async function checkoutSession(sessionId) {
  if (!sessionId) return { ok: false, error: 'missing_session' };
  return stripeGet(`checkout/sessions/${encodeURIComponent(sessionId)}`);
}
async function checkoutLineItems(sessionId) {
  if (!sessionId) return { ok: false, error: 'missing_session' };
  return stripeGet(`checkout/sessions/${encodeURIComponent(sessionId)}/line_items?limit=100`);
}
async function productionRequest(path, init = {}) {
  try {
    const response = await fetch(`${PRODUCTION_BASE}${path}`, { redirect: 'manual', ...init });
    const contentType = String(response.headers.get('content-type') || '');
    let data = null;
    if (contentType.includes('application/json')) data = await response.json().catch(() => null);
    return { status: response.status, contentType, data, setCookie: response.headers.get('set-cookie') || '' };
  } catch (error) {
    return { status: 0, contentType: '', data: null, error: String(error?.message || error), setCookie: '' };
  }
}
async function createBarLookupSession() {
  const password = String(Netlify.env.get('NOCTURNE_BAR_KEY') || Netlify.env.get('NOCTURNE_CHECKIN_KEY') || Netlify.env.get('NOCTURNE_ADMIN_KEY') || '');
  if (!password) return { ok: false, error: 'bar_auth_not_configured' };
  const response = await productionRequest('/api/bar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'NOCTURNE-Ticket-Audit/1.0' },
    body: JSON.stringify({ action: 'login', staffName: 'Ticket Integrity Audit', password })
  });
  const cookie = String(response.setCookie || '').split(';')[0];
  if (response.status !== 200 || !cookie) return { ok: false, error: `bar_login_${response.status}` };
  return { ok: true, cookie };
}
async function verifyAdmissionPayment(summary, source, issues) {
  if (source === 'comp') {
    let ok = true;
    if (summary.stripePaymentIntentId) { addIssue(issues, 'comp_has_admission_payment_intent', 'error'); ok = false; }
    if (Number(summary.amountTotal || 0) !== 0) { addIssue(issues, 'comp_has_nonzero_admission_amount', 'error', String(summary.amountTotal)); ok = false; }
    return ok;
  }

  const localPi = String(summary.stripePaymentIntentId || '');
  const sessionId = String(summary.stripeCheckoutSessionId || '');
  let piVerified = false;
  let sessionVerified = false;

  if (localPi) piVerified = await verifyPaymentIntent(localPi, issues, 'admission');

  if (sessionId) {
    const sessionResult = await checkoutSession(sessionId);
    if (!sessionResult.ok) {
      addIssue(issues, 'admission_checkout_session_lookup_failed', 'error', sessionResult.error || 'unknown');
    } else {
      const session = sessionResult.data;
      let sessionOk = true;
      if (session.payment_status !== 'paid') { addIssue(issues, 'admission_checkout_not_paid', 'error', String(session.payment_status || 'missing')); sessionOk = false; }
      if (session.status && session.status !== 'complete') { addIssue(issues, 'admission_checkout_not_complete', 'error', String(session.status)); sessionOk = false; }
      if (Number(summary.amountTotal || 0) > 0 && Number(session.amount_total || 0) !== Number(summary.amountTotal || 0)) {
        addIssue(issues, 'admission_checkout_amount_mismatch', 'error', `${session.amount_total || 0}!=${summary.amountTotal || 0}`);
        sessionOk = false;
      }
      const sessionPi = String(session.payment_intent || '');
      if (localPi && sessionPi && localPi !== sessionPi) { addIssue(issues, 'admission_payment_intent_mismatch', 'error'); sessionOk = false; }
      if (sessionPi) {
        const sessionPiVerified = localPi === sessionPi && piVerified ? true : await verifyPaymentIntent(sessionPi, issues, 'admission_session');
        sessionOk = sessionOk && sessionPiVerified;
        if (!localPi && sessionPiVerified) addIssue(issues, 'local_admission_payment_intent_missing_but_stripe_verified', 'warning');
      } else if (!piVerified) {
        addIssue(issues, 'admission_checkout_missing_payment_intent', 'error');
        sessionOk = false;
      }
      sessionVerified = sessionOk;
    }
  }

  if (!localPi && !sessionId) addIssue(issues, 'paid_ticket_without_stripe_payment_evidence', 'error');
  if (!piVerified && !sessionVerified) {
    addIssue(issues, 'admission_payment_not_verified', 'error');
    return false;
  }
  return true;
}
async function verifyAddonPayment(summary, kind, admissionVerified, issues) {
  const config = {
    drink: {
      purchased: Boolean(summary.drinkPackagePurchased),
      status: String(summary.drinkPackageStatus || ''),
      purchaseType: String(summary.drinkPackagePurchaseType || ''),
      checkoutStatus: String(summary.drinkPackageCheckoutStatus || ''),
      sessionId: String(summary.drinkPackageCheckoutSessionId || ''),
      paymentIntentId: String(summary.drinkPackagePaymentIntentId || ''),
      expectedPrice: Number(summary.drinkPackagePriceCents || 5500),
      lineWords: ['drink']
    },
    water: {
      purchased: Boolean(summary.waterPackagePurchased),
      status: String(summary.waterPackageStatus || ''),
      purchaseType: String(summary.waterPackagePurchaseType || ''),
      checkoutStatus: String(summary.waterPackageCheckoutStatus || ''),
      sessionId: String(summary.waterPackageCheckoutSessionId || ''),
      paymentIntentId: String(summary.waterPackagePaymentIntentId || ''),
      expectedPrice: Number(summary.waterPackagePriceCents || 1500),
      lineWords: ['water']
    },
    lateStay: {
      purchased: Boolean(summary.lateStayPurchased),
      status: String(summary.lateStayStatus || ''),
      purchaseType: String(summary.lateStayPurchaseType || ''),
      checkoutStatus: String(summary.lateStayCheckoutStatus || ''),
      sessionId: String(summary.lateStayCheckoutSessionId || ''),
      paymentIntentId: String(summary.lateStayPaymentIntentId || ''),
      expectedPrice: Number(summary.lateStayPriceCents || 2000),
      lineWords: ['late', 'camp']
    }
  }[kind];
  if (!config?.purchased) return true;

  const initialDrink = kind === 'drink' && config.purchaseType !== 'addon' && !config.sessionId;
  let sessionId = config.sessionId;
  let paymentIntentId = config.paymentIntentId;

  if (initialDrink) {
    sessionId = String(summary.stripeCheckoutSessionId || '');
    paymentIntentId = String(summary.stripePaymentIntentId || '');
    if (!admissionVerified) { addIssue(issues, 'initial_drink_admission_payment_not_verified', 'error'); return false; }
  } else {
    if (config.checkoutStatus && config.checkoutStatus !== 'paid') addIssue(issues, `${kind}_checkout_status_not_paid`, 'error', config.checkoutStatus);
    if (!sessionId) addIssue(issues, `${kind}_checkout_session_missing`, 'error');
  }

  let ok = !hasErrors(issues);
  let session = null;
  if (sessionId) {
    const result = await checkoutSession(sessionId);
    if (!result.ok) {
      addIssue(issues, `${kind}_checkout_session_lookup_failed`, 'error', result.error || 'unknown');
      ok = false;
    } else {
      session = result.data;
      if (session.payment_status !== 'paid') { addIssue(issues, `${kind}_checkout_not_paid`, 'error', String(session.payment_status || 'missing')); ok = false; }
      if (session.status && session.status !== 'complete') { addIssue(issues, `${kind}_checkout_not_complete`, 'error', String(session.status)); ok = false; }
      if (session.metadata?.ticketId && String(session.metadata.ticketId) !== String(summary.ticketId)) { addIssue(issues, `${kind}_checkout_ticket_mismatch`, 'error'); ok = false; }
      if (session.metadata?.submissionId && String(session.metadata.submissionId) !== String(summary.submissionId)) { addIssue(issues, `${kind}_checkout_submission_mismatch`, 'error'); ok = false; }
      if (!paymentIntentId && session.payment_intent) paymentIntentId = String(session.payment_intent);
      if (config.paymentIntentId && session.payment_intent && String(config.paymentIntentId) !== String(session.payment_intent)) { addIssue(issues, `${kind}_payment_intent_mismatch`, 'error'); ok = false; }
    }

    const lineResult = await checkoutLineItems(sessionId);
    if (!lineResult.ok) {
      addIssue(issues, `${kind}_line_items_lookup_failed`, 'error', lineResult.error || 'unknown');
      ok = false;
    } else {
      const matched = Array.isArray(lineResult.data?.data) && lineResult.data.data.some((item) => {
        const amountMatches = Number(item.amount_total || 0) === config.expectedPrice;
        return amountMatches && stringIncludesAny(item.description, config.lineWords);
      });
      if (!matched) { addIssue(issues, `${kind}_paid_line_item_not_found`, 'error'); ok = false; }
    }
  }

  if (paymentIntentId) {
    const verified = await verifyPaymentIntent(paymentIntentId, issues, `${kind}_addon`);
    ok = ok && verified;
    if (!config.paymentIntentId && !initialDrink && verified) addIssue(issues, `${kind}_local_payment_intent_missing_but_stripe_verified`, 'warning');
  } else if (!initialDrink) {
    addIssue(issues, `${kind}_payment_intent_missing`, 'error');
    ok = false;
  }

  return ok && !hasErrors(issues);
}

export default async (req) => {
  if (req.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
  if (!(await authorized(req))) return json({ error: 'Unauthorized.' }, 401);

  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const { blobs } = await orderStore.list({ prefix: 'submission-' });
  const barSession = await createBarLookupSession();
  const rows = [];

  for (let i = 0; i < blobs.length; i += 6) {
    const batch = blobs.slice(i, i + 6);
    const batchRows = await Promise.all(batch.map(async ({ key }) => {
      const submissionId = key.slice('submission-'.length);
      const [summary, review] = await Promise.all([
        orderStore.get(key, { type: 'json', consistency: 'strong' }),
        reviewStore.get(submissionId, { type: 'json', consistency: 'strong' })
      ]);
      if (!summary?.ticketId) return null;
      const activeCandidate = summary.status === 'paid' || ['paid', 'checked_in'].includes(String(review?.ticketState || ''));
      if (!activeCandidate) return null;

      const issues = [];
      const gate = gateReadiness(summary, review, summary.ticketId);
      for (const error of gate.errors) {
        if (error === WAIVER_ERROR) addIssue(issues, 'waiver_required_before_scan', 'blocker', error);
        else addIssue(issues, 'gate_readiness', 'error', error);
      }
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
          productionRequest(`/ticket?token=${encodeURIComponent(effectiveToken)}`, { headers: { 'User-Agent': 'NOCTURNE-Ticket-Audit/1.0' } }),
          productionRequest(`/ticket/qr?token=${encodeURIComponent(effectiveToken)}`, { headers: { 'User-Agent': 'NOCTURNE-Ticket-Audit/1.0' } })
        ]);
        if (ticketHttp.status !== 200) addIssue(issues, 'production_ticket_page_not_200', 'error', String(ticketHttp.status));
        const signed = waiverSigned(summary, review);
        if (signed && qrHttp.status !== 200) addIssue(issues, 'signed_ticket_qr_not_200', 'error', String(qrHttp.status));
        if (!signed && qrHttp.status !== 403) addIssue(issues, 'unsigned_ticket_qr_unexpected_status', 'error', String(qrHttp.status));
      }

      const source = summary.ticketSource === 'comp' || /^NOC-TKT-COMP-/.test(String(summary.ticketId || '')) ? 'comp' : 'paid';
      const admissionPaymentVerified = await verifyAdmissionPayment(summary, source, issues);

      const addons = {
        drink: Boolean(summary.drinkPackagePurchased),
        water: Boolean(summary.waterPackagePurchased),
        lateStay: Boolean(summary.lateStayPurchased)
      };
      const addonChecks = { drink: true, water: true, lateStay: true };
      const endpointChecks = { drinkBarLookup: !addons.drink, water: !addons.water, lateStay: !addons.lateStay };

      if (addons.drink) {
        const status = String(summary.drinkPackageStatus || '');
        const purchased = Number(summary.drinkCreditsPurchased || 0);
        const remaining = Number(summary.drinkCreditsRemaining || 0);
        const redeemed = Number(summary.drinkCreditsRedeemed || 0);
        if (!['pending_activation', 'active', 'exhausted'].includes(status)) addIssue(issues, 'drink_addon_status_invalid', 'error', status || 'missing');
        if (purchased !== 6) addIssue(issues, 'drink_credit_purchase_count_invalid', 'error', String(purchased));
        if (remaining < 0 || remaining > purchased) addIssue(issues, 'drink_credit_remaining_invalid', 'error', String(remaining));
        if (redeemed < 0 || redeemed > purchased || redeemed + remaining !== purchased) addIssue(issues, 'drink_credit_accounting_mismatch', 'error', `${redeemed}+${remaining}!=${purchased}`);
        if (status === 'pending_activation') {
          if (redeemed !== 0 || remaining !== 6) addIssue(issues, 'pending_drink_package_credit_state_invalid', 'error', `${redeemed}/${remaining}`);
          if (summary.drinkPackageWristbandHash) addIssue(issues, 'pending_drink_package_has_wristband', 'error');
        }
        if (status === 'active') {
          if (!summary.drinkPackageWristbandHash) addIssue(issues, 'active_drink_package_missing_wristband', 'error');
          if (!summary.checkedInAt) addIssue(issues, 'active_drink_package_guest_not_checked_in', 'error');
        }
        if (status === 'exhausted') {
          if (remaining !== 0) addIssue(issues, 'exhausted_drink_package_has_remaining_credit', 'error', String(remaining));
          if (!summary.drinkPackageWristbandHash) addIssue(issues, 'exhausted_drink_package_missing_wristband', 'error');
        }
        addonChecks.drink = await verifyAddonPayment(summary, 'drink', admissionPaymentVerified, issues);
        if (barSession.ok && effectiveToken) {
          const lookup = await productionRequest('/api/bar', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: barSession.cookie, 'User-Agent': 'NOCTURNE-Ticket-Audit/1.0' },
            body: JSON.stringify({ action: 'lookup', value: effectiveToken })
          });
          const pack = lookup.data?.package;
          const matches = lookup.status === 200
            && pack
            && String(pack.packageStatus || '') === status
            && Number(pack.creditsPurchased || 0) === purchased
            && Number(pack.creditsRedeemed || 0) === redeemed
            && Number(pack.creditsRemaining || 0) === remaining;
          endpointChecks.drinkBarLookup = Boolean(matches);
          if (!matches) addIssue(issues, 'production_bar_lookup_failed_or_mismatched', 'error', String(lookup.status));
        } else {
          addIssue(issues, 'production_bar_lookup_not_verified', 'error', barSession.error || 'missing_token');
        }
      }

      if (addons.water) {
        const status = String(summary.waterPackageStatus || '');
        if (status !== 'active') addIssue(issues, 'water_addon_status_invalid', 'error', status || 'missing');
        addonChecks.water = await verifyAddonPayment(summary, 'water', admissionPaymentVerified, issues);
        if (effectiveToken) {
          const result = await productionRequest(`/api/ticket/water?token=${encodeURIComponent(effectiveToken)}`, { headers: { 'User-Agent': 'NOCTURNE-Ticket-Audit/1.0' } });
          endpointChecks.water = result.status === 200 && result.data?.purchased === true && result.data?.status === 'active';
          if (!endpointChecks.water) addIssue(issues, 'production_water_entitlement_lookup_failed', 'error', String(result.status));
        }
      }

      if (addons.lateStay) {
        const status = String(summary.lateStayStatus || '');
        if (status !== 'active') addIssue(issues, 'late_stay_addon_status_invalid', 'error', status || 'missing');
        if (summary.lateStayDepartureTime && summary.lateStayDepartureTime !== '10:00 AM') addIssue(issues, 'late_stay_departure_stale', 'error', String(summary.lateStayDepartureTime));
        addonChecks.lateStay = await verifyAddonPayment(summary, 'lateStay', admissionPaymentVerified, issues);
        if (effectiveToken) {
          const result = await productionRequest(`/api/ticket/late-stay?token=${encodeURIComponent(effectiveToken)}`, { headers: { 'User-Agent': 'NOCTURNE-Ticket-Audit/1.0' } });
          endpointChecks.lateStay = result.status === 200 && result.data?.purchased === true && result.data?.status === 'active' && result.data?.departureTime === '10:00 AM';
          if (!endpointChecks.lateStay) addIssue(issues, 'production_late_stay_entitlement_lookup_failed', 'error', String(result.status));
        }
      }

      const checkedIn = Boolean(summary.checkedInAt || review?.checkedInAt || review?.ticketState === 'checked_in');
      const signedWaiver = waiverSigned(summary, review);
      const integrityValid = !hasErrors(issues);
      const scanReadyForFirstEntry = integrityValid && signedWaiver && !checkedIn && qrHttp?.status === 200;
      const onlyWaiverBlocksFirstEntry = integrityValid && !signedWaiver && !checkedIn && qrHttp?.status === 403;
      const addonIntegrityVerified = (!addons.drink || (addonChecks.drink && endpointChecks.drinkBarLookup))
        && (!addons.water || (addonChecks.water && endpointChecks.water))
        && (!addons.lateStay || (addonChecks.lateStay && endpointChecks.lateStay));

      return {
        ref: anon(submissionId),
        ticketRef: anon(summary.ticketId),
        source,
        signedWaiver,
        checkedIn,
        ticketPageStatus: ticketHttp?.status || null,
        qrStatus: qrHttp?.status || null,
        admissionPaymentVerified,
        addons,
        addonChecks,
        endpointChecks,
        drinkStatus: addons.drink ? summary.drinkPackageStatus || null : null,
        waterStatus: addons.water ? summary.waterPackageStatus || null : null,
        lateStayStatus: addons.lateStay ? summary.lateStayStatus || null : null,
        integrityValid,
        scanReadyForFirstEntry,
        onlyWaiverBlocksFirstEntry,
        addonIntegrityVerified,
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
      row.integrityValid = false;
      row.scanReadyForFirstEntry = false;
      row.onlyWaiverBlocksFirstEntry = false;
    }
  }

  const count = (fn) => rows.filter(fn).length;
  const errors = rows.filter((r) => r.issues.some((i) => i.severity === 'error'));
  const blockers = rows.filter((r) => r.issues.some((i) => i.severity === 'blocker'));
  const warnings = rows.filter((r) => r.issues.some((i) => i.severity === 'warning'));
  const addonRows = rows.filter((r) => r.addons.drink || r.addons.water || r.addons.lateStay);
  const signedRows = rows.filter((r) => r.signedWaiver);
  const unsignedRows = rows.filter((r) => !r.signedWaiver);
  const paidRows = rows.filter((r) => r.source === 'paid');
  const compRows = rows.filter((r) => r.source === 'comp');

  const summary = {
    activeTickets: rows.length,
    paidTickets: paidRows.length,
    compTickets: compRows.length,
    signedWaivers: signedRows.length,
    unsignedWaivers: unsignedRows.length,
    alreadyCheckedIn: count((r) => r.checkedIn),
    structurallyValidTickets: count((r) => r.integrityValid),
    structurallyBrokenTickets: errors.length,
    scanReadyForFirstEntry: count((r) => r.scanReadyForFirstEntry),
    unsignedTicketsOnlyBlockedByWaiver: count((r) => r.onlyWaiverBlocksFirstEntry),
    recordsWithExpectedWaiverBlocker: blockers.length,
    recordsWithWarnings: warnings.length,
    ticketPages200: count((r) => r.ticketPageStatus === 200),
    signedQr200: count((r) => r.signedWaiver && r.qrStatus === 200),
    unsignedQrLocked403: count((r) => !r.signedWaiver && r.qrStatus === 403),
    paidAdmissionPaymentsVerified: paidRows.filter((r) => r.admissionPaymentVerified).length,
    compAdmissionRecordsVerified: compRows.filter((r) => r.admissionPaymentVerified).length,
    ticketsWithAnyAddon: addonRows.length,
    addonTicketsFullyVerified: addonRows.filter((r) => r.addonIntegrityVerified && r.integrityValid).length,
    drinkPackages: count((r) => r.addons.drink),
    drinkPackagesBarLookupVerified: count((r) => r.addons.drink && r.endpointChecks.drinkBarLookup),
    waterPackages: count((r) => r.addons.water),
    waterPackagesEndpointVerified: count((r) => r.addons.water && r.endpointChecks.water),
    lateStayPackages: count((r) => r.addons.lateStay),
    lateStayPackagesEndpointVerified: count((r) => r.addons.lateStay && r.endpointChecks.lateStay),
    allTicketRecordsValid: errors.length === 0,
    allSignedTicketsReadyForFirstEntry: signedRows.every((r) => r.scanReadyForFirstEntry || r.checkedIn),
    allUnsignedTicketsValidExceptWaiver: unsignedRows.every((r) => r.onlyWaiverBlocksFirstEntry || r.checkedIn),
    allPaidAdmissionsStripeVerified: paidRows.every((r) => r.admissionPaymentVerified),
    allCompAdmissionsInternallyVerified: compRows.every((r) => r.admissionPaymentVerified),
    allAddonTicketsFullyVerified: addonRows.every((r) => r.addonIntegrityVerified && r.integrityValid)
  };

  return json({ ok: true, generatedAt: new Date().toISOString(), summary, errors, blockers, warnings, rows });
};

export const config = { path: '/api/internal/ticket-integrity-audit' };
