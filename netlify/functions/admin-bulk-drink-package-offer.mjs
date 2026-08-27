import { getStore } from '@netlify/blobs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { makeTicketToken } from './_ticket-token.mjs';
import { writeAudit } from './_audit.mjs';
import { drinkPackageConfig } from './_drink-package.mjs';
import { waterPackageConfig } from './_water-package.mjs';
import { honoluluDate } from './_reminder-policy.mjs';

const APPLICATION_STORE = 'nocturne-applications';
const REVIEW_STORE = 'nocturne-application-reviews';
const ORDER_STORE = 'nocturne-ticket-orders';
const EMAIL_EVENT_STORE = 'nocturne-email-events';
const SESSION_COOKIE = 'nocturne_admin';
const CAMPAIGN_VERSION = 'v2';

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

function safeEqual(a = '', b = '') {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function sessionSecret() {
  return process.env.NOCTURNE_ADMIN_SESSION_SECRET || process.env.NOCTURNE_ADMIN_KEY || '';
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

function escapeHtml(value = '') {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function offerState(summary, review, configs) {
  const validTicket = Boolean(
    summary
    && summary.status === 'paid'
    && summary.ticketId
    && ['paid', 'checked_in'].includes(String(review?.ticketState || ''))
  );
  if (!validTicket) return { eligible: false, offerDrink: false, offerWater: false };

  const offerDrink = Boolean(configs.drink.enabled && !summary.drinkPackagePurchased);
  const offerWater = Boolean(configs.water.enabled && !summary.waterPackagePurchased);
  return {
    eligible: offerDrink || offerWater,
    offerDrink,
    offerWater
  };
}

function money(cents, currency) {
  return `${currency} ${(Number(cents || 0) / 100).toFixed(2)}`;
}

async function sendOffer(req, application, summary, submissionId, dateKey, configs, offers) {
  const token = makeTicketToken(summary.ticketId, submissionId);
  if (!token) throw new Error('Digital ticket signing is not configured.');

  const site = (process.env.NOCTURNE_SITE_URL || new URL(req.url).origin).replace(/\/$/, '');
  const ticketUrl = `${site}/ticket?token=${encodeURIComponent(token)}`;
  const displayName = application.preferredName || application.fullName || 'Guest';
  const currency = String(process.env.NOCTURNE_TICKET_CURRENCY || 'usd').toUpperCase();
  const drinkPrice = money(configs.drink.priceCents, currency);
  const waterPrice = money(configs.water.priceCents, currency);

  const offeredNames = [
    offers.offerDrink ? 'Six-Drink Package' : '',
    offers.offerWater ? 'Unlimited Drinking Water Package' : ''
  ].filter(Boolean);
  const subject = offeredNames.length > 1
    ? "It's Not Too Late to Add Extras to Your NOCTURNE Ticket"
    : offers.offerDrink
      ? "It's Not Too Late to Add Your NOCTURNE Drink Package"
      : "It's Not Too Late to Add Unlimited Water to Your NOCTURNE Ticket";

  const packageLines = [];
  if (offers.offerDrink) {
    packageLines.push(
      `Six-Drink Package — ${drinkPrice}`,
      'Six prepaid drink credits.',
      'Beer and well cocktails: one credit each.',
      'Premium cocktails: one credit plus a $5 upgrade at the bar.',
      'Valid 21+ photo ID is required to activate the drink-package wristband.',
      ''
    );
  }
  if (offers.offerWater) {
    packageLines.push(
      `Unlimited Drinking Water Package — ${waterPrice}`,
      'Unlimited drinking water during the festival for the ticket holder.',
      'Personal and non-transferable.',
      ''
    );
  }

  const text = [
    `${displayName},`, '',
    `Your NOCTURNE ticket is confirmed, and it's not too late to add ${offeredNames.length > 1 ? 'optional add-ons' : `the optional ${offeredNames[0]}`} to your existing ticket.`, '',
    ...packageLines,
    'IMPORTANT — FINAL SALE / NON-REFUNDABLE: Add-on package sales are final. Packages cannot be refunded, exchanged, prorated, transferred, or converted to cash.', '',
    `Open your digital ticket to review and add your available package${offeredNames.length > 1 ? 's' : ''}: ${ticketUrl}`, '',
    'NOCTURNE Festival',
    'Presented by Wild Ones · Hawai‘i'
  ].join('\n');

  const cards = [
    offers.offerDrink ? `<div style="margin:18px 0;padding:18px;border-left:2px solid #d89a2b;background:#020202;color:#d8c7ac;line-height:1.8"><strong style="color:#fff3df">Six-Drink Package — ${escapeHtml(drinkPrice)}</strong><br>Six prepaid drink credits<br>Beer / well: one credit<br>Premium: one credit + $5 at the bar<br>Valid 21+ photo ID required for activation</div>` : '',
    offers.offerWater ? `<div style="margin:18px 0;padding:18px;border-left:2px solid #63b3de;background:#020202;color:#d8c7ac;line-height:1.8"><strong style="color:#d9effa">Unlimited Drinking Water — ${escapeHtml(waterPrice)}</strong><br>Unlimited drinking water during the festival<br>Personal and non-transferable</div>` : ''
  ].filter(Boolean).join('');

  const headline = offeredNames.length > 1
    ? 'It’s not too late<br>to add your extras.'
    : offers.offerDrink
      ? 'It’s not too late<br>to add six drinks.'
      : 'It’s not too late<br>to add unlimited water.';

  const html = `<!doctype html><html><body style="margin:0;background:#030303;color:#f7efe3;font-family:Arial,sans-serif"><div style="max-width:640px;margin:0 auto;padding:44px 24px"><div style="border:1px solid rgba(216,154,43,.35);background:#080604;padding:38px 30px"><div style="color:#d89a2b;font-size:11px;letter-spacing:3px;text-transform:uppercase">NOCTURNE · Ticket Add-Ons</div><h1 style="font-family:Georgia,serif;font-weight:400;font-size:42px;line-height:1.04;color:#fff3df;margin:16px 0 22px">${headline}</h1><p style="color:#c8baa4;line-height:1.7">${escapeHtml(displayName)}, your NOCTURNE ticket is confirmed. You can still add ${offeredNames.length > 1 ? 'these optional packages' : `the ${escapeHtml(offeredNames[0])}`} directly to your existing ticket.</p>${cards}<p style="color:#ffca61;font-size:13px;line-height:1.7;padding:14px;border:1px solid rgba(255,202,97,.4);background:rgba(255,202,97,.07)"><strong>FINAL SALE / NON-REFUNDABLE:</strong> Add-on package sales are final. Packages cannot be refunded, exchanged, prorated, transferred, or converted to cash.</p><p style="text-align:center;margin:30px 0"><a href="${escapeHtml(ticketUrl)}" style="display:inline-block;padding:14px 20px;background:#d89a2b;color:#0b0803;text-decoration:none;font-size:12px;letter-spacing:2px;text-transform:uppercase">View Available Add-Ons</a></p><p style="color:#9d907f;line-height:1.7">Open your ticket, review the package policies, and complete secure add-on checkout. Every package remains linked to your existing NOCTURNE ticket.</p><div style="margin-top:34px;padding-top:20px;border-top:1px solid rgba(216,154,43,.18);color:#74695b;font-size:11px;letter-spacing:1px;text-transform:uppercase">NOCTURNE Festival · Presented by Wild Ones · Hawai‘i</div></div></div></body></html>`;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `bulk-ticket-addon-offer-${CAMPAIGN_VERSION}-${dateKey}-${submissionId}`.slice(0, 256)
    },
    body: JSON.stringify({
      from: process.env.NOCTURNE_EMAIL_FROM,
      to: [application.email],
      subject,
      html,
      text
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `Resend returned ${response.status}.`);
  return { messageId: data.id || null, ticketUrl };
}

async function processCandidate(req, key, stores, dateKey, configs) {
  const [application, review, summary] = await Promise.all([
    stores.applications.get(key, { type: 'json', consistency: 'strong' }),
    stores.reviews.get(key, { type: 'json', consistency: 'strong' }),
    stores.orders.get(`submission-${key}`, { type: 'json', consistency: 'strong' })
  ]);

  if (!application?.email) return { status: 'ineligible' };
  const offers = offerState(summary, review, configs);
  if (!offers.eligible) return { status: 'ineligible' };

  const markerKey = `ticket-addon-offer-${CAMPAIGN_VERSION}-${dateKey}-${key}`;
  const marker = await stores.emailEvents.setJSON(markerKey, {
    submissionId: key,
    ticketId: summary.ticketId,
    dateKey,
    campaignVersion: CAMPAIGN_VERSION,
    offerDrink: offers.offerDrink,
    offerWater: offers.offerWater,
    status: 'sending',
    createdAt: new Date().toISOString()
  }, { onlyIfNew: true });

  if (!marker.modified) return { status: 'duplicate' };

  try {
    const sent = await sendOffer(req, application, summary, key, dateKey, configs, offers);
    const sentAt = new Date().toISOString();
    await stores.emailEvents.setJSON(markerKey, {
      submissionId: key,
      ticketId: summary.ticketId,
      dateKey,
      campaignVersion: CAMPAIGN_VERSION,
      offerDrink: offers.offerDrink,
      offerWater: offers.offerWater,
      status: 'sent',
      sentAt,
      messageId: sent.messageId
    });
    await writeAudit('ticket_addon.bulk_offer_email_sent', {
      submissionId: key,
      ticketId: summary.ticketId,
      recipient: application.email,
      offerDrink: offers.offerDrink,
      offerWater: offers.offerWater,
      messageId: sent.messageId
    });
    return { status: 'sent', offerDrink: offers.offerDrink, offerWater: offers.offerWater };
  } catch (error) {
    await stores.emailEvents.delete(markerKey).catch(() => {});
    await writeAudit('ticket_addon.bulk_offer_email_failed', {
      submissionId: key,
      ticketId: summary.ticketId,
      recipient: application.email,
      offerDrink: offers.offerDrink,
      offerWater: offers.offerWater,
      error: String(error?.message || error)
    }).catch(() => {});
    return { status: 'failed', error: String(error?.message || error) };
  }
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  if (!authenticated(req)) return json({ error: 'Unauthorized.' }, 401);
  if (!allowedOrigin(req)) return json({ error: 'Origin not allowed.' }, 403);
  if (!process.env.RESEND_API_KEY || !process.env.NOCTURNE_EMAIL_FROM) return json({ error: 'Transactional email is not configured.' }, 503);
  if (!process.env.STRIPE_SECRET_KEY) return json({ error: 'Ticket add-on checkout is not currently available.' }, 503);

  const configs = {
    drink: drinkPackageConfig(),
    water: waterPackageConfig()
  };
  if (!configs.drink.enabled && !configs.water.enabled) return json({ error: 'Ticket add-on packages are currently disabled.' }, 503);

  const stores = {
    applications: getStore({ name: APPLICATION_STORE, consistency: 'strong' }),
    reviews: getStore({ name: REVIEW_STORE, consistency: 'strong' }),
    orders: getStore({ name: ORDER_STORE, consistency: 'strong' }),
    emailEvents: getStore({ name: EMAIL_EVENT_STORE, consistency: 'strong' })
  };

  try {
    const { blobs } = await stores.applications.list();
    const dateKey = honoluluDate();
    const results = [];

    for (let index = 0; index < blobs.length; index += 5) {
      const batch = blobs.slice(index, index + 5);
      results.push(...await Promise.all(batch.map(({ key }) => processCandidate(req, key, stores, dateKey, configs))));
    }

    const counts = results.reduce((output, result) => {
      output[result.status] = (output[result.status] || 0) + 1;
      if (result.status === 'sent') {
        if (result.offerDrink && result.offerWater) output.bothOffers += 1;
        else if (result.offerDrink) output.drinkOnly += 1;
        else if (result.offerWater) output.waterOnly += 1;
      }
      return output;
    }, { bothOffers: 0, drinkOnly: 0, waterOnly: 0 });

    const summary = {
      dateKey,
      campaignVersion: CAMPAIGN_VERSION,
      scanned: blobs.length,
      sent: counts.sent || 0,
      bothOffers: counts.bothOffers || 0,
      drinkOnly: counts.drinkOnly || 0,
      waterOnly: counts.waterOnly || 0,
      duplicate: counts.duplicate || 0,
      ineligible: counts.ineligible || 0,
      failed: counts.failed || 0
    };

    await writeAudit('ticket_addon.bulk_offer_run', summary);
    return json({ ok: true, ...summary });
  } catch (error) {
    console.error('NOCTURNE bulk ticket add-on offer failed:', error);
    await writeAudit('ticket_addon.bulk_offer_run_failed', { error: String(error?.message || error) }).catch(() => {});
    return json({ error: error?.message || 'Bulk ticket add-on offer could not be completed.' }, 500);
  }
};
