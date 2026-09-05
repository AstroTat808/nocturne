import { getStore } from '@netlify/blobs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { makeTicketToken } from './_ticket-token.mjs';
import { writeAudit } from './_audit.mjs';
import { drinkPackageConfig } from './_drink-package.mjs';
import { waterPackageConfig } from './_water-package.mjs';
import { lateStayAvailability } from './_late-stay.mjs';
import { honoluluDate } from './_reminder-policy.mjs';
import { ensureMarketingUnsubscribeUrl, isMarketingSuppressed, marketingEmailFrom, marketingListHeaders } from './_marketing-preferences.mjs';

const APPLICATION_STORE='nocturne-applications',REVIEW_STORE='nocturne-application-reviews',ORDER_STORE='nocturne-ticket-orders',EMAIL_EVENT_STORE='nocturne-email-events',SESSION_COOKIE='nocturne_admin',CAMPAIGN_VERSION='v6';
const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','Content-Type':'application/json; charset=utf-8'}});
function safeEqual(a='',b=''){const l=Buffer.from(String(a)),r=Buffer.from(String(b));return l.length===r.length&&timingSafeEqual(l,r)}
function secret(){return process.env.NOCTURNE_ADMIN_SESSION_SECRET||process.env.NOCTURNE_ADMIN_KEY||''}
function cookies(req){return Object.fromEntries((req.headers.get('cookie')||'').split(';').map(p=>{const i=p.indexOf('=');if(i<0)return['',''];let v=p.slice(i+1).trim();try{v=decodeURIComponent(v)}catch{}return[p.slice(0,i).trim(),v]}).filter(([k])=>k))}
function auth(req){const s=secret(),t=cookies(req)[SESSION_COOKIE];if(!s||!t||!t.includes('.'))return false;const[p,sig]=t.split('.',2),expected=createHmac('sha256',s).update(p).digest('base64url');if(!safeEqual(sig,expected))return false;try{const d=JSON.parse(Buffer.from(p,'base64url').toString('utf8'));return d.role==='admin'&&Number(d.exp)>Math.floor(Date.now()/1000)}catch{return false}}
function allowedOrigin(req){const o=req.headers.get('origin');if(!o)return true;const a=new Set(['https://nocturnefestival.com','https://www.nocturnefestival.com']);try{a.add(new URL(req.url).origin)}catch{}for(const v of [process.env.NOCTURNE_SITE_URL,process.env.URL,process.env.DEPLOY_PRIME_URL])try{if(v)a.add(new URL(v).origin)}catch{}return a.has(o)}
const esc=(v='')=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
function offerState(summary,review,configs){
  const valid=summary?.status==='paid'&&summary?.ticketId&&['paid','checked_in'].includes(String(review?.ticketState||''));
  if(!valid)return{eligible:false,offerDrink:false,offerWater:false,offerLateStay:false};
  const offerDrink=Boolean(configs.drink.enabled&&!summary.drinkPackagePurchased);
  const offerWater=Boolean(configs.water.enabled&&!summary.waterPackagePurchased);
  const offerLateStay=Boolean(configs.lateStay.enabled&&!summary.lateStayPurchased);
  return{eligible:offerDrink||offerWater||offerLateStay,offerDrink,offerWater,offerLateStay};
}
const money=(c,cur)=>`${cur} ${(Number(c||0)/100).toFixed(2)}`;
async function sendOffer(req,application,summary,submissionId,dateKey,configs,offers){
  const token=makeTicketToken(summary.ticketId,submissionId);if(!token)throw new Error('Digital ticket signing is not configured.');
  const from=marketingEmailFrom();if(!from)throw new Error('NOCTURNE_UPDATES_EMAIL_FROM is not configured.');
  const site=(process.env.NOCTURNE_SITE_URL||new URL(req.url).origin).replace(/\/$/,'');
  const ticketUrl=`${site}/ticket?token=${encodeURIComponent(token)}`,unsubscribeUrl=await ensureMarketingUnsubscribeUrl(req,application.email);
  const name=application.preferredName||application.fullName||'Guest',cur=String(process.env.NOCTURNE_TICKET_CURRENCY||'usd').toUpperCase();
  const drinkPrice=money(configs.drink.priceCents,cur),waterPrice=money(configs.water.priceCents,cur),lateStayPrice=money(configs.lateStay.priceCents,cur);
  const names=[offers.offerDrink?'Six-Drink Package':'',offers.offerWater?'Unlimited Drinking Water':'',offers.offerLateStay?'Late Checkout / Car Camping':''].filter(Boolean);
  const subject=names.length>1?'Optional NOCTURNE Ticket Add-Ons Available':offers.offerDrink?'Optional Six-Drink Package for Your NOCTURNE Ticket':offers.offerWater?'Optional Unlimited Water for Your NOCTURNE Ticket':'Optional Late Checkout / Car Camping for NOCTURNE';
  const lines=[];
  if(offers.offerDrink)lines.push(`Six-Drink Package — ${drinkPrice}`,'Six prepaid drink credits. Beer/well use one credit; premium uses one credit plus $5.','');
  if(offers.offerWater)lines.push(`Unlimited Drinking Water — ${waterPrice}`,'Unlimited drinking water during festival operating hours.','');
  if(offers.offerLateStay)lines.push(`Late Checkout / Car Camping — ${lateStayPrice}`,'Stay on the property after the 3:00 AM event end until 8:00 AM. Each person staying after 3:00 AM needs their own add-on.','FINAL SALE / NON-REFUNDABLE: Late Checkout / Car Camping cannot be refunded, exchanged, prorated, transferred, converted to account credit, or redeemed for cash.','');
  const text=[`${name},`,'','Your NOCTURNE ticket is confirmed. These optional add-ons are still available for your ticket.','',...lines,'All optional add-on purchases are final sale and non-refundable.','',`Review available add-ons: ${ticketUrl}`,'',`Unsubscribe from promotional NOCTURNE updates: ${unsubscribeUrl}`,'','NOCTURNE Festival'].join('\n');
  const cards=[offers.offerDrink?`<p><strong>Six-Drink Package — ${esc(drinkPrice)}</strong><br>Six prepaid drink credits. Beer/well use one credit; premium uses one credit plus $5.</p>`:'',offers.offerWater?`<p><strong>Unlimited Drinking Water — ${esc(waterPrice)}</strong><br>Unlimited drinking water during festival operating hours.</p>`:'',offers.offerLateStay?`<p><strong>Late Checkout / Car Camping — ${esc(lateStayPrice)}</strong><br>Stay after the 3:00 AM event end until 8:00 AM. Each person staying after 3:00 AM needs this add-on on their own ticket.<br><br><strong style="color:#ffca61">FINAL SALE / NON-REFUNDABLE:</strong> Cannot be refunded, exchanged, prorated, transferred, converted to account credit, or redeemed for cash.</p>`:''].join('');
  const html=`<!doctype html><html><body style="margin:0;background:#030303;color:#f7efe3;font-family:Arial,sans-serif"><div style="max-width:640px;margin:auto;padding:44px 24px"><div style="border:1px solid rgba(216,154,43,.35);background:#080604;padding:38px 30px"><div style="color:#d89a2b;font-size:11px;letter-spacing:3px;text-transform:uppercase">NOCTURNE · Ticket Add-Ons</div><h1 style="font-family:Georgia,serif;font-weight:400;color:#fff3df">Optional add-ons for your ticket.</h1><p style="color:#c8baa4;line-height:1.7">${esc(name)}, your NOCTURNE ticket is confirmed. These optional add-ons are still available.</p>${cards}<p style="color:#ffca61"><strong>FINAL SALE / NON-REFUNDABLE:</strong> Optional add-on purchases cannot be refunded.</p><p style="text-align:center"><a href="${esc(ticketUrl)}" style="display:inline-block;padding:14px 20px;background:#d89a2b;color:#0b0803;text-decoration:none">View Available Add-Ons</a></p><p style="margin-top:34px;color:#74695b;font-size:11px">Prefer not to receive promotional NOCTURNE updates? <a href="${esc(unsubscribeUrl)}" style="color:#9fbfd0">Unsubscribe</a>. Essential ticket and event-access emails will continue.</p></div></div></body></html>`;
  const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':`bulk-ticket-addon-offer-${CAMPAIGN_VERSION}-${dateKey}-${submissionId}`.slice(0,256)},body:JSON.stringify({from,to:[application.email],subject,html,text,headers:marketingListHeaders(unsubscribeUrl)})});
  const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.message||`Resend returned ${response.status}.`);return{messageId:data.id||null};
}
async function processCandidate(req,key,stores,dateKey,configs){
  const [application,review,summary]=await Promise.all([stores.applications.get(key,{type:'json',consistency:'strong'}),stores.reviews.get(key,{type:'json',consistency:'strong'}),stores.orders.get(`submission-${key}`,{type:'json',consistency:'strong'})]);
  if(!application?.email)return{status:'ineligible'};if(await isMarketingSuppressed(application.email))return{status:'suppressed'};const offers=offerState(summary,review,configs);if(!offers.eligible)return{status:'ineligible'};
  const markerKey=`ticket-addon-offer-${CAMPAIGN_VERSION}-${dateKey}-${key}`,marker=await stores.emailEvents.setJSON(markerKey,{submissionId:key,ticketId:summary.ticketId,dateKey,status:'sending',createdAt:new Date().toISOString()},{onlyIfNew:true});if(!marker.modified)return{status:'duplicate'};
  try{const sent=await sendOffer(req,application,summary,key,dateKey,configs,offers),sentAt=new Date().toISOString();await stores.emailEvents.setJSON(markerKey,{submissionId:key,ticketId:summary.ticketId,dateKey,status:'sent',sentAt,messageId:sent.messageId});await writeAudit('ticket_addon.bulk_offer_email_sent',{submissionId:key,ticketId:summary.ticketId,recipient:application.email,offerDrink:offers.offerDrink,offerWater:offers.offerWater,offerLateStay:offers.offerLateStay,messageId:sent.messageId});return{status:'sent',...offers}}catch(error){await stores.emailEvents.delete(markerKey).catch(()=>{});await writeAudit('ticket_addon.bulk_offer_email_failed',{submissionId:key,error:String(error?.message||error)}).catch(()=>{});return{status:'failed'}}
}
export default async(req)=>{
  if(req.method!=='POST')return json({error:'Method not allowed.'},405);if(!auth(req))return json({error:'Unauthorized.'},401);if(!allowedOrigin(req))return json({error:'Origin not allowed.'},403);if(!process.env.RESEND_API_KEY||!marketingEmailFrom())return json({error:'Promotional email sender is not configured.'},503);if(!process.env.STRIPE_SECRET_KEY)return json({error:'Ticket add-on checkout is not available.'},503);
  const configs={drink:drinkPackageConfig(),water:waterPackageConfig(),lateStay:await lateStayAvailability()};
  const stores={applications:getStore({name:APPLICATION_STORE,consistency:'strong'}),reviews:getStore({name:REVIEW_STORE,consistency:'strong'}),orders:getStore({name:ORDER_STORE,consistency:'strong'}),emailEvents:getStore({name:EMAIL_EVENT_STORE,consistency:'strong'})};
  const{blobs}=await stores.applications.list(),dateKey=honoluluDate(),results=[];for(let i=0;i<blobs.length;i+=5)results.push(...await Promise.all(blobs.slice(i,i+5).map(({key})=>processCandidate(req,key,stores,dateKey,configs))));
  const counts={sent:0,duplicate:0,suppressed:0,ineligible:0,failed:0,multi:0,drink:0,water:0,lateStay:0};
  for(const result of results){counts[result.status]=(counts[result.status]||0)+1;if(result.status!=='sent')continue;const offered=[result.offerDrink,result.offerWater,result.offerLateStay].filter(Boolean).length;if(offered>1)counts.multi+=1;else if(result.offerDrink)counts.drink+=1;else if(result.offerWater)counts.water+=1;else if(result.offerLateStay)counts.lateStay+=1;}
  const summary={dateKey,campaignVersion:CAMPAIGN_VERSION,scanned:blobs.length,sent:counts.sent||0,multiOffers:counts.multi,drinkOnly:counts.drink,waterOnly:counts.water,lateStayOnly:counts.lateStay,lateStayUnlimited:true,duplicate:counts.duplicate||0,suppressed:counts.suppressed||0,ineligible:counts.ineligible||0,failed:counts.failed||0};
  await writeAudit('ticket_addon.bulk_offer_run',summary);return json({ok:true,...summary});
};