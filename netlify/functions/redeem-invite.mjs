import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';
import { accessSecret, accessTtlSeconds, makeAccessCookie, makeAccessToken } from './_ticket-auth.mjs';

const STORE_NAME = 'nocturne-invites';
const REVIEW_STORE = 'nocturne-application-reviews';
const APPLICATION_STORE = 'nocturne-applications';

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

function normalizeCode(code) {
  return String(code).trim().toUpperCase().replace(/\s+/g, '');
}

function hashCode(code) {
  return createHash('sha256').update(normalizeCode(code)).digest('hex');
}

function emailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.NOCTURNE_EMAIL_FROM);
}

function builtInCheckoutConfigured() {
  const price = Number(process.env.NOCTURNE_TICKET_PRICE_CENTS || 0);
  return Boolean(process.env.STRIPE_SECRET_KEY && Number.isInteger(price) && price >= 50);
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function readCode(req) {
  const contentType = (req.headers.get('content-type') || '').toLowerCase();

  if (contentType.includes('application/json')) {
    const body = await req.json();
    return normalizeCode(body?.code || '');
  }

  if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
    const form = await req.formData();
    return normalizeCode(form.get('code') || '');
  }

  throw new Error('Unsupported request type.');
}

function isBrowserFormPost(req) {
  const contentType = (req.headers.get('content-type') || '').toLowerCase();
  return !req.headers.get('x-nocturne-ajax') && (
    contentType.includes('application/x-www-form-urlencoded') ||
    contentType.includes('multipart/form-data')
  );
}

function browserRedirect(location, extraHeaders = {}) {
  return new Response(null, {
    status: 303,
    headers: {
      Location: location,
      'Cache-Control': 'no-store',
      ...extraHeaders
    }
  });
}

function failure(req, message, status) {
  if (isBrowserFormPost(req)) {
    return browserRedirect(`/invite?error=${encodeURIComponent(message)}`);
  }
  return json({ error: message }, status);
}

async function updateReview(submissionId, patch) {
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const current = await reviewStore.get(submissionId, { type: 'json', consistency: 'strong' });
  if (!current) return null;
  const next = { ...current, ...patch };
  await reviewStore.setJSON(submissionId, next);
  return next;
}

async function sendRedemptionConfirmation(req, invite, usedAt, ticketUrl) {
  const submissionId = String(invite.sourceSubmissionId || '').trim();
  if (!submissionId) return { sent: false, reason: 'No source application is associated with this invitation.' };

  const attemptedAt = new Date().toISOString();

  try {
    const applicationStore = getStore({ name: APPLICATION_STORE, consistency: 'strong' });
    const application = await applicationStore.get(submissionId, { type: 'json', consistency: 'strong' });

    if (!application?.email) {
      const error = 'Application has no email address.';
      await updateReview(submissionId, {
        inviteState: 'redeemed',
        inviteRedeemedAt: usedAt,
        redemptionConfirmationStatus: 'failed',
        redemptionConfirmationAttemptedAt: attemptedAt,
        redemptionConfirmationSentAt: null,
        redemptionConfirmationMessageId: null,
        redemptionConfirmationError: error,
        updatedAt: attemptedAt
      });
      return { sent: false, reason: error };
    }

    if (!emailConfigured()) {
      const error = 'Redemption confirmation email is not configured.';
      await updateReview(submissionId, {
        inviteState: 'redeemed',
        inviteRedeemedAt: usedAt,
        redemptionConfirmationStatus: 'failed',
        redemptionConfirmationAttemptedAt: attemptedAt,
        redemptionConfirmationSentAt: null,
        redemptionConfirmationMessageId: null,
        redemptionConfirmationError: error,
        updatedAt: attemptedAt
      });
      return { sent: false, reason: error };
    }

    const displayName = application.preferredName || application.fullName || 'Guest';
    const safeName = escapeHtml(displayName);
    const siteUrl = (process.env.NOCTURNE_SITE_URL || new URL(req.url).origin).replace(/\/$/, '');
    const internalCheckout = ticketUrl === '/ticket-access' && builtInCheckoutConfigured();
    const externalCheckout = /^https:\/\//i.test(ticketUrl);
    const statusCopy = internalCheckout
      ? 'Your private NOCTURNE ticket checkout is now available. Return to the private access page in the browser where you redeemed your invitation to purchase your ticket.'
      : externalCheckout
        ? 'Your invitation has been successfully redeemed and your private ticket access is ready.'
        : 'Private ticket checkout is not live yet, so there is nothing else you need to do right now. Approved guests will receive the next instructions when checkout opens.';

    const text = [
      `${displayName},`,
      '',
      'Your access is confirmed.',
      '',
      'Your NOCTURNE invitation was successfully redeemed.',
      statusCopy,
      '',
      'Keep an eye on this email address for future private access instructions.',
      '',
      `NOCTURNE: ${siteUrl}`,
      '',
      'NOCTURNE Festival',
      'Presented by Wild Ones · Hawai‘i'
    ].join('\n');

    const html = `<!doctype html><html><body style="margin:0;background:#030303;color:#f7efe3;font-family:Arial,sans-serif"><div style="max-width:640px;margin:0 auto;padding:44px 24px"><div style="border:1px solid rgba(216,154,43,.35);background:#080604;padding:38px 30px"><div style="color:#d89a2b;font-size:11px;letter-spacing:3px;text-transform:uppercase">NOCTURNE · Access Confirmed</div><h1 style="font-family:Georgia,serif;font-weight:400;font-size:42px;line-height:1.04;color:#fff3df;margin:16px 0 22px">Your access<br>is confirmed.</h1><p style="color:#c8baa4;line-height:1.7">${safeName}, your NOCTURNE invitation was successfully redeemed.</p><div style="margin:28px 0;padding:18px;border-left:2px solid #d89a2b;background:#020202;color:#d8c7ac;line-height:1.7">${escapeHtml(statusCopy)}</div><p style="color:#9d907f;line-height:1.7">Keep an eye on this email address for future private access instructions.</p><p style="text-align:center;margin:30px 0 10px"><a href="${escapeHtml(siteUrl)}" style="display:inline-block;padding:14px 20px;border:1px solid rgba(216,154,43,.6);color:#ffca61;text-decoration:none;font-size:11px;letter-spacing:2px;text-transform:uppercase">Return to NOCTURNE</a></p><div style="margin-top:34px;padding-top:20px;border-top:1px solid rgba(216,154,43,.18);color:#74695b;font-size:11px;letter-spacing:1px;text-transform:uppercase">NOCTURNE Festival · Presented by Wild Ones · Hawai‘i</div></div></div></body></html>`;

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: process.env.NOCTURNE_EMAIL_FROM,
        to: [application.email],
        subject: 'Access Confirmed — NOCTURNE',
        html,
        text
      })
    });

    const responseData = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = responseData.message || `Resend returned ${response.status}.`;
      console.error('NOCTURNE redemption confirmation email failed:', response.status, responseData);
      await updateReview(submissionId, {
        inviteState: 'redeemed',
        inviteRedeemedAt: usedAt,
        redemptionConfirmationStatus: 'failed',
        redemptionConfirmationAttemptedAt: attemptedAt,
        redemptionConfirmationSentAt: null,
        redemptionConfirmationMessageId: null,
        redemptionConfirmationError: String(error).slice(0, 500),
        updatedAt: attemptedAt
      });
      return { sent: false, reason: error };
    }

    const sentAt = new Date().toISOString();
    await updateReview(submissionId, {
      inviteState: 'redeemed',
      inviteRedeemedAt: usedAt,
      redemptionConfirmationStatus: 'sent',
      redemptionConfirmationAttemptedAt: attemptedAt,
      redemptionConfirmationSentAt: sentAt,
      redemptionConfirmationMessageId: responseData.id || null,
      redemptionConfirmationError: null,
      updatedAt: sentAt
    });

    return { sent: true, sentAt, messageId: responseData.id || null };
  } catch (error) {
    console.error('NOCTURNE redemption confirmation workflow failed:', error);
    try {
      await updateReview(submissionId, {
        inviteState: 'redeemed',
        inviteRedeemedAt: usedAt,
        redemptionConfirmationStatus: 'failed',
        redemptionConfirmationAttemptedAt: attemptedAt,
        redemptionConfirmationSentAt: null,
        redemptionConfirmationMessageId: null,
        redemptionConfirmationError: String(error?.message || error || 'Unknown email error').slice(0, 500),
        updatedAt: attemptedAt
      });
    } catch (reviewError) {
      console.error('NOCTURNE redemption confirmation failure record could not be saved:', reviewError);
    }
    return { sent: false, reason: error?.message || 'Confirmation email failed.' };
  }
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);

  const origin = req.headers.get('origin');
  const requestOrigin = new URL(req.url).origin;
  if (origin && origin !== requestOrigin) return failure(req, 'Origin not allowed.', 403);

  let code;
  try {
    code = await readCode(req);
  } catch {
    return failure(req, 'Invalid request.', 400);
  }

  if (!/^NOC-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)) {
    return failure(req, 'That invitation code is not valid.', 400);
  }

  const store = getStore({ name: STORE_NAME, consistency: 'strong' });
  const key = hashCode(code);
  const entry = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });

  if (!entry) return failure(req, 'Invitation not found or no longer active.', 404);

  const invite = entry.data;
  if (invite.used) return failure(req, 'This invitation has already been redeemed.', 410);

  if (invite.expiresAt && Date.now() > new Date(invite.expiresAt).getTime()) {
    return failure(req, 'This invitation has expired.', 410);
  }

  const configuredTicketUrl = invite.purchaseUrl || process.env.NOCTURNE_TICKET_URL || '';
  const usingBuiltInAccess = !configuredTicketUrl;
  const ticketUrl = configuredTicketUrl || '/ticket-access';

  if (!usingBuiltInAccess && !/^https:\/\//i.test(ticketUrl)) {
    return failure(req, 'Ticket access URL is not valid.', 503);
  }

  if (usingBuiltInAccess && !accessSecret()) {
    return failure(req, 'Private ticket access is not configured.', 503);
  }

  const usedAt = new Date().toISOString();
  const result = await store.setJSON(
    key,
    { ...invite, used: true, usedAt },
    { onlyIfMatch: entry.etag }
  );

  if (!result.modified) return failure(req, 'This invitation was just redeemed elsewhere.', 409);

  if (invite.sourceSubmissionId) {
    try {
      await updateReview(invite.sourceSubmissionId, {
        inviteState: 'redeemed',
        inviteRedeemedAt: usedAt,
        redemptionConfirmationStatus: 'pending',
        redemptionConfirmationError: null,
        updatedAt: usedAt
      });
    } catch (error) {
      console.error('NOCTURNE review redemption sync failed:', error);
    }
  }

  const confirmation = await sendRedemptionConfirmation(req, invite, usedAt, ticketUrl);

  const headers = {};
  if (usingBuiltInAccess) {
    const ttlSeconds = accessTtlSeconds();
    const token = makeAccessToken(invite.sourceSubmissionId || '', ttlSeconds);
    if (token) headers['Set-Cookie'] = makeAccessCookie(token, ttlSeconds);
  }

  if (isBrowserFormPost(req)) {
    return browserRedirect(ticketUrl, headers);
  }

  return json({
    ok: true,
    message: 'Invitation accepted.',
    ticketUrl,
    temporaryAccess: usingBuiltInAccess && !builtInCheckoutConfigured(),
    builtInCheckout: usingBuiltInAccess && builtInCheckoutConfigured(),
    confirmationEmailSent: confirmation.sent
  }, 200, headers);
};
