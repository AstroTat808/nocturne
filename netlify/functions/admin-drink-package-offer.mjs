import { getStore } from '@netlify/blobs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { makeTicketToken } from './_ticket-token.mjs';
import { writeAudit } from './_audit.mjs';
import { drinkPackageConfig } from './_drink-package.mjs';
import { ensureMarketingUnsubscribeUrl, isMarketingSuppressed, marketingEmailFrom, marketingListHeaders } from './_marketing-preferences.mjs';

const APPLICATION_STORE = 'nocturne-applications';
const REVIEW_STORE = 'nocturne-application-reviews';
const ORDER_STORE = 'nocturne-ticket-orders';
const SESSION_COOKIE = 'nocturne_admin';

function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' } });
}
function safeEqual(a = '', b = '') { const l = Buffer.from(String(a)); const r = Buffer.from(String(b)); return l.length === r.length && timingSafeEqual(l, r); }
function secret() { return process.env.NOCTURNE_ADMIN_SESSION_SECRET || process.env.NOCTURNE_ADMIN_KEY || ''; }
function parseCookies(req) { const h=req.headers.get('cookie')||''; return Object.fromEntries(h.split(';').map(p=>{const i=p.indexOf('=');if(i<0)return['',''];let v=p.slice(i+1).trim();try{v=decodeURIComponent(v)}catch{}return[p.slice(0,i).trim(),v]}).filter(([k])=>k)); }
function authenticated(req) { const s=secret(),t=parseCookies(req)[SESSION_COOKIE]; if(!s||!t||!t.includes('.')) return false; const[p,sig]=t.split('.',2),expected=createHmac('sha256',s).update(p).digest('base64url'); if(!safeEqual(sig,expected))return false; try{const d=JSON.parse(Buffer.from(p,'base64url').toString('utf8'));return d.role==='admin'&&Number(d.exp)>Math.floor(Date.now()/1000)}catch{return false} }
function allowedOrigin(req) { const o=req.headers.get('origin'); if(!o)return true; const a=new Set(['https://nocturnefestival.com','https://www.nocturnefestival.com']); try{a.add(new URL(req.url).origin)}catch{} for(const v of [process.env.NOCTURNE_SITE_URL,process.env.URL,process.env.DEPLOY_PRIME_URL])try{if(v)a.add(new URL(v).origin)}catch{} return a.has(o); }
function validSubmissionId(v){return /^[A-Za-z0-9_-]{6,128}$/.test(String(v||''));}
function esc(v=''){return String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  if (!authenticated(req)) return json({ error: 'Unauthorized.' }, 401);
  if (!allowedOrigin(req)) return json({ error: 'Origin not allowed.' }, 403);
  const from = marketingEmailFrom();
  if (!process.env.RESEND_API_KEY || !from) return json({ error: 'Promotional email sender is not configured.' }, 503);

  let body; try { body = await req.json(); } catch { return json({ error: 'Invalid request.' }, 400); }
  const submissionId = String(body?.submissionId || '').trim();
  if (!validSubmissionId(submissionId)) return json({ error: 'Invalid submission ID.' }, 400);

  const applicationStore = getStore({ name: APPLICATION_STORE, consistency: 'strong' });
  const reviewStore = getStore({ name: REVIEW_STORE, consistency: 'strong' });
  const orderStore = getStore({ name: ORDER_STORE, consistency: 'strong' });
  const [application, review, summary] = await Promise.all([
    applicationStore.get(submissionId, { type: 'json', consistency: 'strong' }),
    reviewStore.get(submissionId, { type: 'json', consistency: 'strong' }),
    orderStore.get(`submission-${submissionId}`, { type: 'json', consistency: 'strong' })
  ]);

  if (!application?.email) return json({ error: 'This guest does not have an email address.' }, 409);
  if (await isMarketingSuppressed(application.email)) return json({ error: 'This guest unsubscribed from promotional NOCTURNE updates.' }, 409);
  if (!summary || summary.status !== 'paid' || !summary.ticketId || !['paid', 'checked_in'].includes(String(review?.ticketState || ''))) return json({ error: 'Only active ticket holders can receive this offer.' }, 409);
  if (summary.drinkPackagePurchased) return json({ error: 'This ticket already has the Six-Drink Package.' }, 409);

  const config = drinkPackageConfig();
  if (!config.enabled || !process.env.STRIPE_SECRET_KEY) return json({ error: 'Drink-package checkout is not currently available.' }, 503);
  const token = makeTicketToken(summary.ticketId, submissionId);
  if (!token) return json({ error: 'Digital ticket signing is not configured.' }, 503);

  const site=(process.env.NOCTURNE_SITE_URL||new URL(req.url).origin).replace(/\/$/,'');
  const ticketUrl=`${site}/ticket?token=${encodeURIComponent(token)}`;
  const unsubscribeUrl=await ensureMarketingUnsubscribeUrl(req,application.email);
  const displayName=application.preferredName||application.fullName||'Guest';
  const currency=String(process.env.NOCTURNE_TICKET_CURRENCY||'usd').toUpperCase();
  const price=`${currency} ${(config.priceCents/100).toFixed(2)}`;
  const subject='Optional Six-Drink Package for Your NOCTURNE Ticket';
  const text=[`${displayName},`,'','Your NOCTURNE ticket is active. The optional Six-Drink Package is still available for your ticket.','',`Package price: ${price}`,'Six prepaid drink credits. Beer/well use one credit; premium uses one credit plus a $5 upgrade.','Valid 21+ photo ID is required for activation.','','All add-on package sales are final and non-refundable.','',`Review and add the package: ${ticketUrl}`,'',`Unsubscribe from promotional NOCTURNE updates: ${unsubscribeUrl}`].join('\n');
  const html=`<!doctype html><html><body style="margin:0;background:#030303;color:#f7efe3;font-family:Arial,sans-serif"><div style="max-width:640px;margin:auto;padding:44px 24px"><div style="border:1px solid rgba(216,154,43,.35);background:#080604;padding:38px 30px"><div style="color:#d89a2b;font-size:11px;letter-spacing:3px;text-transform:uppercase">NOCTURNE · Ticket Add-On</div><h1 style="font-family:Georgia,serif;font-weight:400;color:#fff3df">Optional Six-Drink Package.</h1><p style="color:#c8baa4;line-height:1.7">${esc(displayName)}, your ticket is active and the Six-Drink Package is available to add.</p><p><strong>${esc(price)}</strong><br>Six prepaid drink credits. Beer/well use one credit; premium uses one credit plus $5.</p><p style="text-align:center"><a href="${esc(ticketUrl)}" style="display:inline-block;padding:14px 20px;background:#d89a2b;color:#0b0803;text-decoration:none">View Package</a></p><p style="color:#74695b;font-size:11px">Prefer not to receive promotional NOCTURNE updates? <a href="${esc(unsubscribeUrl)}" style="color:#9fbfd0">Unsubscribe</a>. Essential ticket and event-access messages will continue.</p></div></div></body></html>`;

  try {
    const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':`drink-package-offer-${submissionId}-${randomBytes(10).toString('hex')}`.slice(0,256)},body:JSON.stringify({from,to:[application.email],subject,html,text,headers:marketingListHeaders(unsubscribeUrl)})});
    const data=await response.json().catch(()=>({})); if(!response.ok)throw new Error(data.message||`Resend returned ${response.status}.`);
    const sentAt=new Date().toISOString(); await writeAudit('drink_package.offer_email_sent',{submissionId,ticketId:summary.ticketId,recipient:application.email,messageId:data.id||null});
    return json({ok:true,recipient:application.email,messageId:data.id||null,sentAt});
  } catch(error){await writeAudit('drink_package.offer_email_failed',{submissionId,ticketId:summary.ticketId,recipient:application.email,error:String(error?.message||error)});return json({error:error.message||'Drink-package offer email could not be sent.'},502);}
};
