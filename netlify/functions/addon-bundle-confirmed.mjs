import { getStore } from '@netlify/blobs';
import { makeTicketToken } from './_ticket-token.mjs';
import { fulfillAddonBundle } from './_addon-bundle.mjs';

const ORDER_STORE = 'nocturne-ticket-orders';
function escapeHtml(value=''){return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');}
function page({confirmed=false,pending=false,cancelled=false,message='',ticketUrl='',items=[]}){
 const heading=confirmed?'Your add-ons are confirmed.':pending?'Payment is being verified.':cancelled?'Checkout canceled.':'We could not confirm those add-ons.';
 const status=confirmed?`<div class="private-access-status"><strong>Added to your ticket</strong><br>${items.map(escapeHtml).join(' · ')}</div>`:pending?'<div class="private-access-status"><strong>Finalizing your add-ons…</strong><br>This page will refresh automatically.</div>':cancelled?'<div class="private-access-status"><strong>No charge was completed.</strong><br>Your existing ticket and entitlements are unchanged.</div>':`<div class="private-access-status"><strong>${escapeHtml(message||'Add-on confirmation was not found.')}</strong></div>`;
 const action=confirmed&&ticketUrl?`<a class="btn" href="${escapeHtml(ticketUrl)}">Open Updated Ticket →</a>`:'';
 return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive">${pending?'<meta http-equiv="refresh" content="3">':''}<title>Add-On Status | NOCTURNE</title><link rel="stylesheet" href="/assets/css/styles.css"><link rel="stylesheet" href="/assets/css/private-access.css"></head><body class="private-access-page"><main class="private-access-shell"><section class="private-access-card"><div class="private-access-logo-wrap"><img class="private-access-logo" src="/assets/images/nocturne-logo.webp" alt="NOCTURNE Festival — presented by Wild Ones"></div><p class="section-kicker">Manage Add-Ons</p><h1>${escapeHtml(heading)}</h1>${status}<p>${confirmed?'Your selected add-ons are now attached to this ticket. Late Checkout / Car Camping permits departure by 10:00 AM.':'Use your original digital ticket to return to Manage Add-Ons.'}</p><div class="private-access-actions">${action}<a class="btn secondary" href="/">Return to NOCTURNE</a></div></section></main></body></html>`;
}
export default async(req)=>{
 if(req.method!=='GET')return new Response('Method not allowed.',{status:405});
 const url=new URL(req.url);const headers={'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Robots-Tag':'noindex,nofollow,noarchive','Referrer-Policy':'no-referrer'};
 if(url.searchParams.get('cancelled')==='1')return new Response(page({cancelled:true}),{status:200,headers});
 const sessionId=String(url.searchParams.get('session_id')||'').trim();
 if(!/^cs_(test_|live_)?[A-Za-z0-9_]{10,}$/.test(sessionId))return new Response(page({message:'The checkout session ID is missing or invalid.'}),{status:400,headers});
 const store=getStore({name:ORDER_STORE,consistency:'strong'});const checkout=await store.get(sessionId,{type:'json',consistency:'strong'});if(!checkout||checkout.purchaseType!=='addon-bundle')return new Response(page({pending:true}),{status:202,headers});
 let summary=await store.get(`submission-${checkout.submissionId}`,{type:'json',consistency:'strong'});
 if(checkout.status!=='paid'&&process.env.STRIPE_SECRET_KEY){const stripe=await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,{headers:{Authorization:`Bearer ${process.env.STRIPE_SECRET_KEY}`}});const session=await stripe.json().catch(()=>null);if(stripe.ok&&session?.payment_status==='paid')summary=await fulfillAddonBundle(session).catch(()=>summary);}
 if(summary?.addonBundleCheckoutStatus==='paid'&&summary.addonBundleCheckoutSessionId===sessionId){const token=makeTicketToken(summary.ticketId,summary.submissionId);const base=(process.env.NOCTURNE_SITE_URL||url.origin).replace(/\/$/,'');const ticketUrl=token?`${base}/ticket?token=${encodeURIComponent(token)}`:'';const items=[];if(checkout.drinkPackageRequested)items.push('Six-Drink Package');if(checkout.waterPackageRequested)items.push('Unlimited Drinking Water');if(checkout.lateStayRequested)items.push('Late Stay until 10:00 AM');return new Response(page({confirmed:true,ticketUrl,items}),{status:200,headers});}
 return new Response(page({pending:true}),{status:202,headers});
};
