import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';
import { verifyTicketToken } from './_ticket-token.mjs';
import { WAIVER_TITLE, WAIVER_TEXT, WAIVER_VERSION, WAIVER_TEXT_HASH, waiverFields, waiverSigned } from './_waiver.mjs';
import { writeAudit } from './_audit.mjs';

const ORDER_STORE = 'nocturne-ticket-orders';
const REVIEW_STORE = 'nocturne-application-reviews';
const APPLICATION_STORE = 'nocturne-applications';

function esc(v=''){return String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');}
function clean(v,max=160){return String(v||'').trim().replace(/\s+/g,' ').slice(0,max);}
function headers(){return {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Robots-Tag':'noindex,nofollow,noarchive','Referrer-Policy':'no-referrer'};}
function clientIp(req){return String(req.headers.get('x-nf-client-connection-ip')||req.headers.get('x-forwarded-for')||'').split(',')[0].trim();}
function ipHash(req){const ip=clientIp(req);return ip?createHash('sha256').update(`nocturne-waiver:${ip}`).digest('hex'):'';}
function formValue(form,name){return clean(form.get(name)||'',200);}
function checked(form,name){return ['1','true','yes','on'].includes(String(form.get(name)||'').toLowerCase());}
function allowedOrigin(req){const origin=req.headers.get('origin');if(!origin)return true;const allowed=new Set(['https://nocturnefestival.com','https://www.nocturnefestival.com']);try{allowed.add(new URL(req.url).origin);}catch{}for(const value of[process.env.NOCTURNE_SITE_URL,process.env.URL,process.env.DEPLOY_PRIME_URL]){try{if(value)allowed.add(new URL(value).origin);}catch{}}return allowed.has(origin);}

function page({token='',ticketId='',participantName='',signed=false,signedAt='',signerName='',error=''}){
  const text=WAIVER_TEXT.split('\n').map((p)=>p?`<p>${esc(p)}</p>`:'').join('');
  const status=signed?`<div class="waiver-complete"><strong>WAIVER SIGNED</strong><span>${esc(signerName||participantName)} · ${esc(new Date(signedAt).toLocaleString('en-US',{dateStyle:'medium',timeStyle:'short'}))}</span></div>`:'';
  const form=signed?'':`<form method="post" action="/ticket/waiver" class="waiver-form">
    <input type="hidden" name="token" value="${esc(token)}">
    <label><span>Ticket holder legal name</span><input name="participant_name" value="${esc(participantName)}" autocomplete="name" required maxlength="160"></label>
    <label><span>Who is signing?</span><select name="signer_role" required><option value="self">I am the ticket holder and I am 18 or older</option><option value="guardian">I am the parent/legal guardian signing for this ticket holder</option></select></label>
    <label><span>Signer full legal name</span><input name="signer_name" autocomplete="name" required maxlength="160"></label>
    <label><span>Parent/guardian relationship (only if signing for a minor)</span><input name="guardian_relationship" maxlength="100" placeholder="Parent / legal guardian"></label>
    <label class="waiver-check"><input type="checkbox" name="electronic_consent" value="yes" required><span>I agree to conduct this waiver electronically and understand that typing my name constitutes my electronic signature.</span></label>
    <label class="waiver-check"><input type="checkbox" name="risk_ack" value="yes" required><span>I have read this waiver, understand the risks described above, voluntarily assume those risks, and agree to the release to the fullest extent permitted by Hawaii law.</span></label>
    <label class="waiver-check"><input type="checkbox" name="truth_ack" value="yes" required><span>I certify that the names and signer relationship I entered are accurate.</span></label>
    <button class="btn" type="submit">Sign Required Waiver →</button>
  </form>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive"><meta name="theme-color" content="#030303"><title>Required Waiver | NOCTURNE</title><link rel="stylesheet" href="/assets/css/styles.css"><link rel="stylesheet" href="/assets/css/private-access.css"><style>.waiver-doc{text-align:left;margin:1.2rem 0;padding:1.25rem;border:1px solid rgba(216,154,43,.32);background:rgba(0,0,0,.28);max-height:52vh;overflow:auto}.waiver-doc h2{font-family:var(--serif);font-weight:500;color:#f5e7ce}.waiver-doc p{color:#baa98f;line-height:1.65;font-size:.82rem}.waiver-form{display:grid;gap:1rem;text-align:left}.waiver-form label>span{display:block;margin-bottom:.35rem;color:#c8b89f;font-size:.72rem}.waiver-form input,.waiver-form select{width:100%;box-sizing:border-box}.waiver-check{display:grid!important;grid-template-columns:auto 1fr;gap:.7rem;align-items:flex-start;padding:.9rem;border:1px solid rgba(216,154,43,.24)}.waiver-check input{width:auto;margin-top:.2rem}.waiver-check span{margin:0!important;line-height:1.5}.waiver-complete{display:grid;gap:.35rem;margin:1rem 0;padding:1rem;border:1px solid rgba(83,196,123,.5);background:rgba(83,196,123,.07)}.waiver-complete strong{color:#8fe0aa;letter-spacing:.12em}.waiver-complete span{color:#b8ad9a}.waiver-error{padding:.8rem;border:1px solid rgba(225,95,95,.5);color:#ffb0a8}</style></head><body class="private-access-page"><main class="private-access-shell"><section class="private-access-card"><div class="private-access-logo-wrap"><img class="private-access-logo" src="/assets/images/nocturne-logo.webp" alt="NOCTURNE Festival — presented by Wild Ones"></div><p class="section-kicker">Required Before Entry</p><h1>Participant<br>waiver.</h1><p>${esc(participantName||'NOCTURNE Guest')} · ${esc(ticketId)}</p>${error?`<div class="waiver-error">${esc(error)}</div>`:''}${status}<section class="waiver-doc"><h2>${esc(WAIVER_TITLE)}</h2><p><strong>Version ${esc(WAIVER_VERSION)}</strong></p>${text}</section>${form}<div class="private-access-actions"><button class="btn secondary" type="button" onclick="window.print()">Print / Save Waiver</button><a class="btn secondary" href="/ticket?token=${encodeURIComponent(token)}">Back to Digital Ticket</a></div></section></main></body></html>`;
}

async function load(parsed){const orderStore=getStore({name:ORDER_STORE,consistency:'strong'});const reviewStore=getStore({name:REVIEW_STORE,consistency:'strong'});const applicationStore=getStore({name:APPLICATION_STORE,consistency:'strong'});const [summaryEntry,review,application]=await Promise.all([orderStore.getWithMetadata(`submission-${parsed.submissionId}`,{type:'json',consistency:'strong'}),reviewStore.get(parsed.submissionId,{type:'json',consistency:'strong'}),applicationStore.get(parsed.submissionId,{type:'json',consistency:'strong'})]);return{orderStore,reviewStore,summaryEntry,summary:summaryEntry?.data||null,review,application};}

export default async(req)=>{
  if(!['GET','POST'].includes(req.method))return new Response('Method not allowed.',{status:405});
  if(req.method==='POST'&&!allowedOrigin(req))return new Response(page({error:'Request origin was not allowed.'}),{status:403,headers:headers()});
  const url=new URL(req.url);let token=String(url.searchParams.get('token')||'').trim();let form=null;
  if(req.method==='POST'){try{form=await req.formData();token=formValue(form,'token');}catch{return new Response(page({error:'Waiver submission could not be read.'}),{status:400,headers:headers()});}}
  const parsed=verifyTicketToken(token);if(!parsed)return new Response(page({error:'This ticket link is invalid.'}),{status:400,headers:headers()});
  const records=await load(parsed);const {summary,review,application}=records;if(!summary||summary.status!=='paid'||summary.ticketId!==parsed.ticketId||!['paid','checked_in'].includes(String(review?.ticketState||'')))return new Response(page({token,ticketId:parsed.ticketId,error:'This ticket is not active.'}),{status:403,headers:headers()});
  const participantDefault=application?.fullName||application?.preferredName||summary.customerName||'NOCTURNE Guest';
  if(req.method==='GET'||waiverSigned(summary,review))return new Response(page({token,ticketId:parsed.ticketId,participantName:summary.waiverParticipantName||review?.waiverParticipantName||participantDefault,signed:waiverSigned(summary,review),signedAt:summary.waiverSignedAt||review?.waiverSignedAt||'',signerName:summary.waiverSignerName||review?.waiverSignerName||''}),{status:200,headers:headers()});

  const participantName=formValue(form,'participant_name');const signerName=formValue(form,'signer_name');const signerRole=formValue(form,'signer_role');const guardianRelationship=formValue(form,'guardian_relationship');
  if(participantName.length<2||signerName.length<2)return new Response(page({token,ticketId:parsed.ticketId,participantName:participantDefault,error:'Enter the ticket holder and signer full legal names.'}),{status:400,headers:headers()});
  if(!['self','guardian'].includes(signerRole))return new Response(page({token,ticketId:parsed.ticketId,participantName,error:'Choose who is signing.'}),{status:400,headers:headers()});
  if(signerRole==='guardian'&&guardianRelationship.length<3)return new Response(page({token,ticketId:parsed.ticketId,participantName,error:'Enter the parent or legal guardian relationship.'}),{status:400,headers:headers()});
  if(!checked(form,'electronic_consent')||!checked(form,'risk_ack')||!checked(form,'truth_ack'))return new Response(page({token,ticketId:parsed.ticketId,participantName,error:'All waiver acknowledgments are required.'}),{status:400,headers:headers()});

  const signedAt=new Date().toISOString();const fields=waiverFields({signerName,participantName,signerRole,guardianRelationship,signedAt,userAgent:req.headers.get('user-agent')||'',clientIpHash:ipHash(req)});
  const write=await records.orderStore.setJSON(`submission-${parsed.submissionId}`,{...summary,...fields},{onlyIfMatch:records.summaryEntry.etag});if(!write.modified)return new Response(page({token,ticketId:parsed.ticketId,participantName,error:'Ticket changed while the waiver was being signed. Reload and try again.'}),{status:409,headers:headers()});
  if(review)await records.reviewStore.setJSON(parsed.submissionId,{...review,...fields});
  await writeAudit('ticket.waiver_signed',{submissionId:parsed.submissionId,ticketId:parsed.ticketId,waiverVersion:WAIVER_VERSION,waiverTextHash:WAIVER_TEXT_HASH,signerRole});
  return new Response(null,{status:303,headers:{Location:`/ticket?token=${encodeURIComponent(token)}&waiver=signed`,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
};

export const config={path:'/ticket/waiver'};
