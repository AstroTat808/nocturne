import { getStore } from '@netlify/blobs';
import { makeTicketToken } from './_ticket-token.mjs';
import { writeAudit } from './_audit.mjs';
import { sendOpsAlert } from './_ops-alert.mjs';
import { verifyStripeSignature } from './_stripe-signature.mjs';
import { drinkPackageAddonEligible, drinkPackageAddonFields, initialDrinkPackageFields, invalidateDrinkPackage } from './_drink-package.mjs';

const ORDER_STORE = 'nocturne-ticket-orders';
const REVIEW_STORE = 'nocturne-application-reviews';
const APPLICATION_STORE = 'nocturne-applications';
const EVENT_STORE = 'nocturne-stripe-events';
const HELP_EMAIL = process.env.NOCTURNE_HELP_EMAIL || 'help@nocturnefestival.com';

function escapeHtml(value = '') {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function validSubmissionId(value) {
  return /^[A-Za-z0-9_-]{6,128}$/.test(String(value || ''));
}

function ticketLink(submissionId, ticketId) {
  const token = makeTicketToken(ticketId, submissionId);
  if (!token) return null;
  const site = (process.env.NOCTURNE_SITE_URL || 'https://nocturnefestival.com').replace(/\/$/, '');
  return `${site}/ticket?token=${encodeURIComponent(token)}`;
}

async function stripePost(path, body, idempotencyKey = '') {
  const response = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {})
    },
    body: new URLSearchParams(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `Stripe returned ${response.status}.`);
  return data;
}

async function claimEvent(event) {
  if (!/^evt_[A-Za-z0-9_]+$/.test(String(event?.id || ''))) throw new Error('Stripe event ID is missing or invalid.');
  const store = getStore({ name: EVENT_STORE, consistency: 'strong' });
  const entry = await store.getWithMetadata(event.id, { type: 'json', consistency: 'strong' });
  if (entry?.data?.status === 'processed') return { duplicate: true, store };
  const started = new Date(entry?.data?.startedAt || 0).getTime();
  if (entry?.data?.status === 'processing' && Number.isFinite(started) && Date.now() - started < 300_000) return { duplicate: true, store };
  const record = {
    eventId: event.id,
    eventType: event.type,
    livemode: Boolean(event.livemode),
    status: 'processing',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const result = await store.setJSON(event.id, record, entry ? { onlyIfMatch: entry.etag } : { onlyIfNew: true });
  return result.modified ? { duplicate: false, store, record } : { duplicate: true, store };
}

async function completeEvent(claim, status, error = null) {
  await claim.store.setJSON(claim.record.eventId, {
    ...claim.record,
    status,
    error: error ? String(error).slice(0, 500) : null,
    completedAt: status === 'processed' ? new Date().toISOString() : null,
    updatedAt: new Date().toISOString()
  });
}

async function sendTicketReceipt(application, session, ticketId, submissionId, drinkPackagePurchased = false) {
  if (!process.env.RESEND_API_KEY || !process.env.NOCTURNE_EMAIL_FROM || !application?.email) return { sent: false, reason: 'Email not configured.' };
  const amount = Number(session.amount_total || 0) / 100;
  const currency = String(session.currency || 'usd').toUpperCase();
  const displayName = application.preferredName || application.fullName || 'Guest';
  const digitalTicketUrl = ticketLink(submissionId, ticketId);
  const text = [
    `${displayName},`, '', 'Your NOCTURNE ticket purchase is confirmed.', '',
    `Ticket ID: ${ticketId}`, `Amount: ${currency} ${amount.toFixed(2)}`,
    drinkPackagePurchased ? 'Drink package: Six credits (beer or well cocktail; premium requires a $5 bar upgrade)' : '',
    digitalTicketUrl ? `Open your digital ticket: ${digitalTicketUrl}` : '', '',
    'Your ticket is registered to the email used in your application. Keep this message and your digital ticket private. Present the QR code at event check-in.', '',
    `Need help with the website or your digital ticket? ${HELP_EMAIL}`, '',
    'NOCTURNE Festival', 'Presented by Wild Ones & Bass Babes · Hawai‘i'
  ].filter(Boolean).join('\n');
  const ticketButton = digitalTicketUrl ? `<p style="text-align:center;margin:30px 0"><a href="${escapeHtml(digitalTicketUrl)}" style="display:inline-block;padding:14px 20px;background:#d89a2b;color:#0b0803;text-decoration:none;font-size:12px;letter-spacing:2px;text-transform:uppercase">Open Digital Ticket</a></p>` : '';
  const packageHtml = drinkPackagePurchased ? '<br><strong>Drink package:</strong> Six credits · activate at the bar with 21+ photo ID' : '';
  const html = `<!doctype html><html><body style="margin:0;background:#030303;color:#f7efe3;font-family:Arial,sans-serif"><div style="max-width:640px;margin:0 auto;padding:44px 24px"><div style="border:1px solid rgba(216,154,43,.35);background:#080604;padding:38px 30px"><div style="color:#d89a2b;font-size:11px;letter-spacing:3px;text-transform:uppercase">NOCTURNE · Ticket Confirmed</div><h1 style="font-family:Georgia,serif;font-weight:400;font-size:42px;line-height:1.04;color:#fff3df;margin:16px 0 22px">Your ticket<br>is confirmed.</h1><p style="color:#c8baa4;line-height:1.7">${escapeHtml(displayName)}, your NOCTURNE ticket purchase has been received.</p><div style="margin:28px 0;padding:18px;border-left:2px solid #d89a2b;background:#020202;color:#d8c7ac;line-height:1.8"><strong>Ticket ID:</strong> ${escapeHtml(ticketId)}<br><strong>Amount:</strong> ${currency} ${amount.toFixed(2)}${packageHtml}</div>${ticketButton}<p style="color:#9d907f;line-height:1.7">Keep your digital ticket private. Its QR code is unique and will be marked used when you are admitted.</p><p style="color:#807564;font-size:12px">Need help? <a href="mailto:${escapeHtml(HELP_EMAIL)}" style="color:#ffca61">${escapeHtml(HELP_EMAIL)}</a></p><div style="margin-top:34px;padding-top:20px;border-top:1px solid rgba(216,154,43,.18);color:#74695b;font-size:11px;letter-spacing:1px;text-transform:uppercase">NOCTURNE Festival · Presented by Wild Ones &amp; Bass Babes · Hawai‘i</div></div></div></body></html>`;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': `ticket-confirmation-${session.id}`.slice(0, 256)
    },
    body: JSON.stringify({ from: process.env.NOCTURNE_EMAIL_FROM, to: [application.email], subject: 'Your NOCTURNE Ticket Is Confirmed', html, text })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `Resend returned ${response.status}.`);
  return { sent: true, messageId: data.id || null, digitalTicketUrl };
}

async function sendDrinkPackageReceipt(application, session, ticketId, submissionId) {
  if (!process.env.RESEND_API_KEY || !process.env.NOCTURNE_EMAIL_FROM || !application?.email) return { sent: false, reason: 'Email not configured.' };
  const displayName = application.preferredName || application.fullName || 'Guest';
  const digitalTicketUrl = ticketLink(submissionId, ticketId);
  const amount = Number(session.amount_total || 0) / 100;
  const currency = String(session.currency || 'usd').toUpperCase();
  const text = [
    `${displayName},`, '', 'Your NOCTURNE six-drink package has been added to your existing ticket.', '',
    `Ticket ID: ${ticketId}`, `Amount: ${currency} ${amount.toFixed(2)}`,
    digitalTicketUrl ? `Open your updated digital ticket: ${digitalTicketUrl}` : '', '',
    'Bring valid 21+ photo ID to the bar to activate a staff-issued wristband. Each credit covers one beer or well cocktail; premium cocktails require a $5 upgrade at the bar.', '',
    `Need help? ${HELP_EMAIL}`, '', 'NOCTURNE Festival', 'Presented by Wild Ones & Bass Babes · Hawai‘i'
  ].filter(Boolean).join('\n');
  const ticketButton = digitalTicketUrl ? `<p style="text-align:center;margin:30px 0"><a href="${escapeHtml(digitalTicketUrl)}" style="display:inline-block;padding:14px 20px;background:#d89a2b;color:#0b0803;text-decoration:none;font-size:12px;letter-spacing:2px;text-transform:uppercase">Open Updated Ticket</a></p>` : '';
  const html = `<!doctype html><html><body style="margin:0;background:#030303;color:#f7efe3;font-family:Arial,sans-serif"><div style="max-width:640px;margin:0 auto;padding:44px 24px"><div style="border:1px solid rgba(216,154,43,.35);background:#080604;padding:38px 30px"><div style="color:#d89a2b;font-size:11px;letter-spacing:3px;text-transform:uppercase">NOCTURNE · Package Confirmed</div><h1 style="font-family:Georgia,serif;font-weight:400;font-size:42px;line-height:1.04;color:#fff3df;margin:16px 0 22px">Your six credits<br>are ready.</h1><p style="color:#c8baa4;line-height:1.7">${escapeHtml(displayName)}, the six-drink package is now attached to your existing NOCTURNE ticket.</p><div style="margin:28px 0;padding:18px;border-left:2px solid #d89a2b;background:#020202;color:#d8c7ac;line-height:1.8"><strong>Ticket ID:</strong> ${escapeHtml(ticketId)}<br><strong>Amount:</strong> ${escapeHtml(currency)} ${amount.toFixed(2)}<br><strong>Credits:</strong> Six</div>${ticketButton}<p style="color:#9d907f;line-height:1.7">Bring valid 21+ photo ID to the bar to activate a staff-issued wristband. Beer and well cocktails use one credit; premium cocktails require a $5 upgrade.</p><p style="color:#807564;font-size:12px">Need help? <a href="mailto:${escapeHtml(HELP_EMAIL)}" style="color:#ffca61">${escapeHtml(HELP_EMAIL)}</a></p><div style="margin-top:34px;padding-top:20px;border-top:1px solid rgba(216,154,43,.18);color:#74695b;font-size:11px;letter-spacing:1px;text-transform:uppercase">NOCTURNE Festival · Presented by Wild Ones &amp; Bass Babes · Hawai‘i</div></div></div></body></html>`;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': `drink-package-confirmation-${session.id}`.slice(0, 256) },
    body: JSON.stringify({ from: process.env.NOCTURNE_EMAIL_FROM, to: [application.email], subject: 'Your NOCTURNE Drink Package Is Confirmed', html, text })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `Resend returned ${response.status}.`);
  return { sent: true, messageId: data.id || null };
}

async function refundDuplicateSession(session, submissionId, reason = 'duplicate') {
  if (!session.payment_intent) throw new Error('Duplicate payment does not include a payment intent.');
  const refund = await stripePost('refunds', {
    payment_intent: session.payment_intent,
    reason: 'duplicate',
    'metadata[submissionId]': submissionId,
    'metadata[event]': 'NOCTURNE',
    'metadata[automaticReason]': reason
  }, `nocturne-duplicate-refund-${session.id}`);
  const now = new Date().toISOString();
  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  await orderStore.setJSON(session.id, {
    stripeCheckoutSessionId: session.id,
    stripePaymentIntentId: session.payment_intent,
    submissionId,
    status: 'duplicate_refunded',
    paymentStatus: session.payment_status,
    amountTotal: session.amount_total || null,
    currency: session.currency || null,
    stripeRefundId: refund.id,
    refundStatus: refund.status || 'submitted',
    refundedAt: now,
    duplicateReason: reason,
    updatedAt: now
  });
  await writeAudit('payment.duplicate_refunded', { submissionId, stripeCheckoutSessionId: session.id, stripeRefundId: refund.id });
  await sendOpsAlert('Duplicate payment automatically refunded', [`Submission: ${submissionId}`, `Checkout session: ${session.id}`, `Refund: ${refund.id}`]).catch((error) => console.error('NOCTURNE duplicate refund alert failed:', error));
}

async function syncDrinkPackageReview(reviewStore, submissionId, fields) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const entry = await reviewStore.getWithMetadata(submissionId, { type: 'json', consistency: 'strong' });
    if (!entry?.data) return;
    const write = await reviewStore.setJSON(submissionId, { ...entry.data, ...fields }, { onlyIfMatch: entry.etag });
    if (write.modified) return;
  }
  throw new Error('Application review changed during drink-package synchronization.');
}

async function handleDrinkPackageCompleted(session) {
  if (!session?.id || session.payment_status !== 'paid') return;
  const submissionId = String(session.client_reference_id || session.metadata?.submissionId || '').trim();
  const ticketId = String(session.metadata?.ticketId || '').trim();
  if (!validSubmissionId(submissionId) || !ticketId) throw new Error('Drink-package Checkout Session is missing its ticket identity.');
  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const applicationStore = getStore({ name: APPLICATION_STORE, consistency: 'strong' });
  const summaryKey = `submission-${submissionId}`;
  const [addonOrder, application, review] = await Promise.all([
    orderStore.get(session.id, { type: 'json', consistency: 'strong' }),
    applicationStore.get(submissionId, { type: 'json', consistency: 'strong' }),
    reviewStore.get(submissionId, { type: 'json', consistency: 'strong' })
  ]);
  if (addonOrder?.purchaseType !== 'drink-package-addon' || addonOrder.ticketId !== ticketId) {
    await refundDuplicateSession(session, submissionId, 'unrecognized_drink_package_checkout');
    return;
  }
  const expectedAmount = Number(addonOrder.amountTotal || 0);
  if (expectedAmount < 50 || Number(session.amount_total || 0) !== expectedAmount) {
    await refundDuplicateSession(session, submissionId, 'drink_package_amount_mismatch');
    return;
  }
  if (!application || !review || !['paid', 'checked_in'].includes(review.ticketState)) {
    await refundDuplicateSession(session, submissionId, 'inactive_ticket_for_drink_package');
    return;
  }

  const paidAt = new Date().toISOString();
  let packageFields = drinkPackageAddonFields({ sessionId: session.id, paymentIntentId: session.payment_intent || null, paidAt, priceCents: Number(addonOrder.drinkPackagePriceCents || expectedAmount) });

  let persistedSummary = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const entry = await orderStore.getWithMetadata(summaryKey, { type: 'json', consistency: 'strong' });
    const summary = entry?.data || null;
    if (!summary || (!drinkPackageAddonEligible(summary, review, ticketId) && !summary.drinkPackagePurchased)) {
      await refundDuplicateSession(session, submissionId, 'inactive_ticket_for_drink_package');
      return;
    }
    if (summary.drinkPackagePurchased) {
      if (summary.drinkPackageCheckoutSessionId === session.id) {
        packageFields = { ...Object.fromEntries(Object.entries(summary).filter(([name]) => name.startsWith('drink'))), updatedAt: summary.updatedAt || paidAt };
        persistedSummary = summary;
        break;
      }
      await refundDuplicateSession(session, submissionId, 'existing_drink_package');
      return;
    }
    const next = { ...summary, ...packageFields };
    const write = await orderStore.setJSON(summaryKey, next, { onlyIfMatch: entry.etag });
    if (write.modified) {
      persistedSummary = next;
      break;
    }
  }
  if (!persistedSummary) throw new Error('Ticket changed during drink-package payment finalization.');

  const completedOrder = {
    ...addonOrder,
    stripePaymentIntentId: session.payment_intent || null,
    status: 'paid',
    paymentStatus: session.payment_status,
    customerEmail: session.customer_details?.email || application.email || null,
    customerName: session.customer_details?.name || application.fullName || null,
    paidAt,
    ...packageFields
  };
  await orderStore.setJSON(session.id, completedOrder);
  if (session.payment_intent) {
    await orderStore.setJSON(`payment-intent-${session.payment_intent}`, { submissionId, stripeCheckoutSessionId: session.id, paymentRole: 'drink_package_addon', createdAt: paidAt });
  }
  await syncDrinkPackageReview(reviewStore, submissionId, packageFields);
  await writeAudit('drink_package.paid', { submissionId, ticketId, stripeCheckoutSessionId: session.id, stripePaymentIntentId: session.payment_intent || null, amountTotal: session.amount_total || expectedAmount });

  try {
    const email = await sendDrinkPackageReceipt(application, session, ticketId, submissionId);
    await orderStore.setJSON(session.id, { ...completedOrder, drinkPackageEmailStatus: email.sent ? 'sent' : 'not_configured', drinkPackageEmailMessageId: email.messageId || null, drinkPackageEmailError: email.reason || null, updatedAt: new Date().toISOString() });
    await writeAudit(email.sent ? 'drink_package.email_sent' : 'drink_package.email_not_configured', { submissionId, ticketId, messageId: email.messageId || null });
  } catch (error) {
    console.error('NOCTURNE drink-package confirmation email failed:', error);
    await orderStore.setJSON(session.id, { ...completedOrder, drinkPackageEmailStatus: 'failed', drinkPackageEmailError: String(error?.message || error).slice(0, 500), updatedAt: new Date().toISOString() }).catch(() => {});
    await sendOpsAlert('Drink-package confirmation email failed', [`Submission: ${submissionId}`, `Ticket: ${ticketId}`, String(error?.message || error)]).catch(() => {});
  }
}

async function handleCompletedSession(session) {
  if (!session?.id || session.payment_status !== 'paid') return;
  if (session.metadata?.purchaseType === 'drink-package-addon') return handleDrinkPackageCompleted(session);
  const submissionId = String(session.client_reference_id || session.metadata?.submissionId || '').trim();
  if (!validSubmissionId(submissionId)) throw new Error('Stripe session is missing a valid submission ID.');
  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const applicationStore = getStore({ name: APPLICATION_STORE, consistency: 'strong' });
  const summaryKey = `submission-${submissionId}`;
  const [existing, summaryEntry, application, review] = await Promise.all([
    orderStore.get(session.id, { type: 'json', consistency: 'strong' }),
    orderStore.getWithMetadata(summaryKey, { type: 'json', consistency: 'strong' }),
    applicationStore.get(submissionId, { type: 'json', consistency: 'strong' }),
    reviewStore.get(submissionId, { type: 'json', consistency: 'strong' })
  ]);
  if (!application || !review || review.status !== 'approved' || review.inviteState !== 'redeemed') {
    await refundDuplicateSession(session, submissionId, 'ineligible_application');
    return;
  }
  const currentSummary = summaryEntry?.data || null;
  if (existing?.status === 'paid' && currentSummary?.status === 'paid' && currentSummary.stripeCheckoutSessionId === session.id && review.ticketState === 'paid' && review.ticketId === existing.ticketId) return;
  if (currentSummary?.status === 'paid' && currentSummary.stripeCheckoutSessionId !== session.id) {
    await refundDuplicateSession(session, submissionId, 'existing_active_ticket');
    return;
  }
  const drinkPackagePurchased = Boolean(existing?.drinkPackageRequested && session.metadata?.drinkPackage === 'six-credit');
  const expectedAmount = Number(existing?.amountTotal || currentSummary?.expectedAmountTotal || 0);
  if (expectedAmount > 0 && Number(session.amount_total || 0) !== expectedAmount) {
    await refundDuplicateSession(session, submissionId, 'amount_mismatch');
    return;
  }
  const drinkFields = initialDrinkPackageFields(drinkPackagePurchased, Number(existing?.drinkPackagePriceCents || 5500));

  const paidAt = new Date().toISOString();
  const ticketId = existing?.ticketId || `NOC-TKT-${session.id.slice(-12).toUpperCase()}`;
  const digitalTicketUrl = ticketLink(submissionId, ticketId);
  const order = {
    ...(existing || {}), stripeCheckoutSessionId: session.id, stripePaymentIntentId: session.payment_intent || null,
    submissionId, ticketId, ticketSource: 'stripe', status: 'paid', paymentStatus: session.payment_status,
    amountTotal: session.amount_total || null, currency: session.currency || null,
    customerEmail: session.customer_details?.email || application.email || null,
    customerName: session.customer_details?.name || application.fullName || null,
    paidAt, digitalTicketUrl, checkedInAt: null, ...drinkFields,
    ticketEmailStatus: existing?.ticketEmailStatus === 'sent' ? 'sent' : 'pending',
    ticketEmailMessageId: existing?.ticketEmailMessageId || null,
    ticketEmailError: existing?.ticketEmailStatus === 'sent' ? null : existing?.ticketEmailError || null,
    updatedAt: paidAt
  };
  const summary = {
    stripeCheckoutSessionId: session.id, stripePaymentIntentId: session.payment_intent || null, submissionId, ticketId,
    ticketSource: 'stripe', status: 'paid', paymentStatus: session.payment_status,
    amountTotal: session.amount_total || null, currency: session.currency || null,
    paidAt, digitalTicketUrl, checkedInAt: null, ...drinkFields, updatedAt: paidAt
  };

  await orderStore.setJSON(session.id, order);
  const summaryWrite = await orderStore.setJSON(summaryKey, summary, summaryEntry ? { onlyIfMatch: summaryEntry.etag } : { onlyIfNew: true });
  if (!summaryWrite.modified) {
    const latest = await orderStore.get(summaryKey, { type: 'json', consistency: 'strong' });
    if (latest?.status === 'paid' && latest.stripeCheckoutSessionId !== session.id) {
      await refundDuplicateSession(session, submissionId, 'concurrent_payment');
      return;
    }
    throw new Error('Ticket summary changed during payment finalization.');
  }
  if (session.payment_intent) await orderStore.setJSON(`payment-intent-${session.payment_intent}`, { submissionId, stripeCheckoutSessionId: session.id, createdAt: paidAt });
  const persistedReview = {
    ...review, ticketState: 'paid', ticketSource: 'stripe', ticketPurchasedAt: paidAt, ticketId, digitalTicketUrl,
    checkedInAt: null, stripeCheckoutSessionId: session.id, stripePaymentIntentId: session.payment_intent || null, ...drinkFields,
    ticketEmailStatus: existing?.ticketEmailStatus === 'sent' ? 'sent' : 'pending',
    ticketEmailSentAt: existing?.ticketEmailStatus === 'sent' ? existing.updatedAt || paidAt : null,
    ticketEmailMessageId: existing?.ticketEmailMessageId || null,
    ticketEmailError: existing?.ticketEmailStatus === 'sent' ? null : existing?.ticketEmailError || null,
    updatedAt: paidAt
  };
  await reviewStore.setJSON(submissionId, persistedReview);
  await writeAudit('ticket.paid', { submissionId, ticketId, stripeCheckoutSessionId: session.id, stripePaymentIntentId: session.payment_intent || null, drinkPackagePurchased });

  if (existing?.ticketEmailStatus === 'sent') return;

  let emailStatus = 'not_configured';
  let emailMessageId = null;
  let emailError = null;
  try {
    const email = await sendTicketReceipt(application, session, ticketId, submissionId, drinkPackagePurchased);
    emailStatus = email.sent ? 'sent' : 'not_configured';
    emailMessageId = email.messageId || null;
    emailError = email.reason || null;
  } catch (error) {
    console.error('NOCTURNE ticket confirmation email failed:', error);
    emailStatus = 'failed';
    emailError = String(error?.message || error).slice(0, 500);
    await sendOpsAlert('Ticket confirmation email failed', [`Submission: ${submissionId}`, `Ticket: ${ticketId}`, emailError]).catch(() => {});
  }
  const emailAt = new Date().toISOString();
  await orderStore.setJSON(session.id, { ...order, ticketEmailStatus: emailStatus, ticketEmailMessageId: emailMessageId, ticketEmailError: emailError, updatedAt: emailAt });
  await reviewStore.setJSON(submissionId, { ...persistedReview, ticketEmailStatus: emailStatus, ticketEmailSentAt: emailStatus === 'sent' ? emailAt : null, ticketEmailMessageId: emailMessageId, ticketEmailError: emailError, updatedAt: emailAt });
  await writeAudit(emailStatus === 'sent' ? 'ticket.email_sent' : 'ticket.email_failed', { submissionId, ticketId, messageId: emailMessageId, error: emailError });
}

async function findByPaymentIntent(paymentIntentId) {
  if (!paymentIntentId) return null;
  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const alias = await orderStore.get(`payment-intent-${paymentIntentId}`, { type: 'json', consistency: 'strong' });
  if (alias?.submissionId) return alias;
  const { blobs } = await orderStore.list();
  for (const { key } of blobs) {
    if (!key.startsWith('cs_')) continue;
    const order = await orderStore.get(key, { type: 'json', consistency: 'strong' });
    if (order?.stripePaymentIntentId === paymentIntentId) {
      const found = { submissionId: order.submissionId, stripeCheckoutSessionId: order.stripeCheckoutSessionId || key, paymentRole: order.purchaseType === 'drink-package-addon' ? 'drink_package_addon' : 'ticket' };
      await orderStore.setJSON(`payment-intent-${paymentIntentId}`, found);
      return found;
    }
  }
  return null;
}

async function transitionDrinkPackagePayment(link, paymentIntentId, state, details = {}) {
  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const summaryKey = `submission-${link.submissionId}`;
  const [summaryEntry, addonOrder] = await Promise.all([
    orderStore.getWithMetadata(summaryKey, { type: 'json', consistency: 'strong' }),
    orderStore.get(link.stripeCheckoutSessionId, { type: 'json', consistency: 'strong' })
  ]);
  const summary = summaryEntry?.data || null;
  if (!summary || summary.drinkPackagePaymentIntentId !== paymentIntentId) return;
  if (state === 'dispute_won' && summary.drinkPackageCheckoutStatus === 'refunded') return;
  const now = new Date().toISOString();
  const nextStatus = state === 'dispute_won' ? 'paid' : state;
  const restoredStatus = Number(summary.drinkCreditsRemaining || 0) <= 0 ? 'exhausted' : summary.drinkPackageWristbandHash ? 'active' : 'pending_activation';
  const financialDetails = {
    ...(details.stripeChargeId ? { drinkPackageStripeChargeId: details.stripeChargeId } : {}),
    ...(details.stripeRefundId ? { drinkPackageRefundId: details.stripeRefundId } : {}),
    ...(details.refundStatus ? { drinkPackageRefundStatus: details.refundStatus } : {}),
    ...(details.stripeDisputeId ? { drinkPackageDisputeId: details.stripeDisputeId } : {}),
    ...(details.disputeStatus ? { drinkPackageDisputeStatus: details.disputeStatus } : {}),
    ...(details.disputeClosedAt ? { drinkPackageDisputeClosedAt: details.disputeClosedAt } : {})
  };
  const packagePatch = state === 'dispute_won'
    ? { drinkPackageStatus: restoredStatus, drinkPackageCheckoutStatus: 'paid', drinkPackageInvalidatedAt: null, drinkPackageInvalidationReason: null, drinkPackageDisputedAt: null, ...financialDetails, updatedAt: now }
    : { ...invalidateDrinkPackage(summary, state), drinkPackageCheckoutStatus: state, ...(state === 'refunded' ? { drinkPackageRefundedAt: now } : { drinkPackageDisputedAt: now }), ...financialDetails, updatedAt: now };
  const write = await orderStore.setJSON(summaryKey, { ...summary, ...packagePatch }, { onlyIfMatch: summaryEntry.etag });
  if (!write.modified) throw new Error('Drink-package balance changed during payment transition.');
  if (addonOrder) await orderStore.setJSON(link.stripeCheckoutSessionId, { ...addonOrder, status: nextStatus, ...packagePatch });
  await syncDrinkPackageReview(reviewStore, link.submissionId, packagePatch);
  await writeAudit(`drink_package.payment_${state}`, { submissionId: link.submissionId, ticketId: summary.ticketId, stripePaymentIntentId: paymentIntentId, ...details });
}

async function transitionPayment(paymentIntentId, state, details = {}) {
  const link = await findByPaymentIntent(paymentIntentId);
  if (!link?.submissionId) return;
  if (link.paymentRole === 'drink_package_addon') return transitionDrinkPackagePayment(link, paymentIntentId, state, details);
  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const summaryKey = `submission-${link.submissionId}`;
  const [summary, order, review] = await Promise.all([
    orderStore.get(summaryKey, { type: 'json', consistency: 'strong' }),
    orderStore.get(link.stripeCheckoutSessionId, { type: 'json', consistency: 'strong' }),
    reviewStore.get(link.submissionId, { type: 'json', consistency: 'strong' })
  ]);
  if (!summary || summary.stripePaymentIntentId !== paymentIntentId) return;
  if (state === 'dispute_won' && summary.status === 'refunded') return;
  const now = new Date().toISOString();
  const nextStatus = state === 'dispute_won' ? 'paid' : state;
  const restoreDrinkStatus = (record) => Number(record?.drinkCreditsRemaining || 0) <= 0 ? 'exhausted' : record?.drinkPackageWristbandHash ? 'active' : 'pending_activation';
  const drinkPatch = summary.drinkPackagePurchased
    ? (state === 'dispute_won' ? { drinkPackageStatus: restoreDrinkStatus(summary), drinkPackageInvalidatedAt: null, drinkPackageInvalidationReason: null } : invalidateDrinkPackage(summary, state))
    : {};
  const patch = { status: nextStatus, ...details, ...drinkPatch, updatedAt: now };
  await orderStore.setJSON(summaryKey, { ...summary, ...patch });
  if (order) await orderStore.setJSON(link.stripeCheckoutSessionId, { ...order, ...patch });
  if (review) await reviewStore.setJSON(link.submissionId, { ...review, ticketState: nextStatus === 'paid' && review.checkedInAt ? 'checked_in' : nextStatus, ...details, updatedAt: now });
  await writeAudit(`payment.${state}`, { submissionId: link.submissionId, stripePaymentIntentId: paymentIntentId, ...details });
  if (summary.drinkPackagePurchaseType === 'addon' && ['refunded', 'disputed'].includes(state)) {
    await sendOpsAlert('Admission payment changed with separate drink-package charge', [
      `Submission: ${link.submissionId}`,
      `Ticket payment: ${paymentIntentId}`,
      `Drink-package payment: ${summary.drinkPackagePaymentIntentId || 'unknown'}`,
      `Admission state: ${state}`,
      'Review both Stripe payments so the guest is not left with a paid package attached to inactive admission.'
    ]).catch(() => {});
  }
}

async function handleCheckoutExpired(session) {
  const submissionId = String(session.client_reference_id || session.metadata?.submissionId || '').trim();
  if (!validSubmissionId(submissionId)) return;
  const store = getStore({ name: ORDER_STORE, consistency: 'strong' });
  if (session.metadata?.purchaseType === 'drink-package-addon') {
    const addonOrder = await store.get(session.id, { type: 'json', consistency: 'strong' });
    if (addonOrder?.purchaseType === 'drink-package-addon' && addonOrder.status === 'checkout_created') {
      const now = new Date().toISOString();
      await store.setJSON(session.id, { ...addonOrder, status: 'checkout_expired', checkoutExpiredAt: now, checkoutUrl: null, updatedAt: now });
      const summaryKey = `submission-${submissionId}`;
      const entry = await store.getWithMetadata(summaryKey, { type: 'json', consistency: 'strong' });
      if (entry?.data?.drinkPackageCheckoutSessionId === session.id && !entry.data.drinkPackagePurchased) {
        const write = await store.setJSON(summaryKey, { ...entry.data, drinkPackageCheckoutStatus: 'checkout_expired', drinkPackageCheckoutUrl: null, drinkPackageCheckoutExpiresAt: null, updatedAt: now }, { onlyIfMatch: entry.etag });
        if (write.modified) await writeAudit('drink_package.checkout_expired', { submissionId, ticketId: entry.data.ticketId, stripeCheckoutSessionId: session.id });
      }
    }
    return;
  }
  const key = `submission-${submissionId}`;
  const entry = await store.getWithMetadata(key, { type: 'json', consistency: 'strong' });
  if (!entry?.data || entry.data.status !== 'checkout_created' || entry.data.stripeCheckoutSessionId !== session.id) return;
  const now = new Date().toISOString();
  const write = await store.setJSON(key, { ...entry.data, status: 'checkout_expired', checkoutExpiredAt: now, checkoutUrl: null, updatedAt: now }, { onlyIfMatch: entry.etag });
  if (write.modified) await writeAudit('checkout.expired', { submissionId, stripeCheckoutSessionId: session.id });
}

async function processEvent(event) {
  const object = event.data?.object || {};
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') return handleCompletedSession(object);
  if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') return handleCheckoutExpired(object);
  if (event.type === 'charge.refunded' && (object.refunded || Number(object.amount_refunded || 0) >= Number(object.amount || 0))) return transitionPayment(object.payment_intent, 'refunded', { stripeChargeId: object.id, refundedAt: new Date().toISOString() });
  if (event.type === 'refund.updated' && object.status === 'succeeded') return transitionPayment(object.payment_intent, 'refunded', { stripeRefundId: object.id, refundStatus: object.status, refundedAt: new Date().toISOString() });
  if (event.type === 'charge.dispute.created') return transitionPayment(object.payment_intent, 'disputed', { stripeDisputeId: object.id, disputeStatus: object.status, disputedAt: new Date().toISOString() });
  if (event.type === 'charge.dispute.closed') return transitionPayment(object.payment_intent, object.status === 'won' ? 'dispute_won' : 'disputed', { stripeDisputeId: object.id, disputeStatus: object.status, disputeClosedAt: new Date().toISOString() });
}

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed.', { status: 405 });
  const rawBody = await req.text();
  if (!verifyStripeSignature(rawBody, req.headers.get('stripe-signature') || '')) return new Response('Invalid Stripe signature.', { status: 400 });
  let event;
  try { event = JSON.parse(rawBody); } catch { return new Response('Invalid payload.', { status: 400 }); }
  let claim;
  try {
    claim = await claimEvent(event);
    if (claim.duplicate) return Response.json({ received: true, duplicate: true });
    await processEvent(event);
    await completeEvent(claim, 'processed');
    return Response.json({ received: true });
  } catch (error) {
    console.error('NOCTURNE Stripe webhook processing failed:', error);
    if (claim?.record) await completeEvent(claim, 'failed', error?.message || error).catch(() => {});
    await writeAudit('stripe.webhook_failed', { eventId: event?.id, eventType: event?.type, error: String(error?.message || error) });
    await sendOpsAlert('Stripe webhook failed', [`Event: ${event?.id || 'unknown'}`, `Type: ${event?.type || 'unknown'}`, String(error?.message || error)]).catch(() => {});
    return new Response('Webhook processing failed.', { status: 500 });
  }
};
