import { getStore } from '@netlify/blobs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { appleWalletStatus } from './_apple-wallet.mjs';
import { readAudit, writeAudit } from './_audit.mjs';

const SESSION_COOKIE = 'nocturne_admin';
const STORE = 'nocturne-rehearsal';
const STATE_KEY = 'current';
const APPLICATION_STORE = 'nocturne-applications';
const REVIEW_STORE = 'nocturne-application-reviews';
const ORDER_STORE = 'nocturne-ticket-orders';
const REDEMPTION_STORE = 'nocturne-drink-redemptions';

const MANUAL_ITEMS = [
  ['device_iphone','Digital ticket opens correctly on a real iPhone','Digital ticket & Wallet'],
  ['device_android','Digital ticket opens correctly on a real Android device','Digital ticket & Wallet'],
  ['wallet_add','Apple Wallet pass adds successfully on a real iPhone','Digital ticket & Wallet'],
  ['wallet_scan','Apple Wallet ticket QR scans successfully at check-in','Digital ticket & Wallet'],
  ['gate_valid','Valid paid ticket checks in successfully','Gate rehearsal'],
  ['gate_comp','Complimentary ticket checks in successfully','Gate rehearsal'],
  ['gate_duplicate','Second scan of an already-used ticket is blocked','Gate rehearsal'],
  ['gate_refunded','Refunded/inactive ticket is rejected at the gate','Gate rehearsal'],
  ['bar_login','Bartender can sign in with the dedicated bar password','Bar rehearsal'],
  ['bar_age','21+ ID acknowledgment is required before wristband activation','Bar rehearsal'],
  ['bar_beer','Beer redemption deducts exactly one credit','Bar rehearsal'],
  ['bar_well','Well cocktail redemption deducts exactly one credit','Bar rehearsal'],
  ['bar_premium','Premium cocktail deducts one credit and requires the $5 upgrade confirmation','Bar rehearsal'],
  ['bar_rapid','Rapid-redemption warning and bartender override work correctly','Bar rehearsal'],
  ['bar_exhaust','Six-credit package becomes exhausted after all credits are redeemed','Bar rehearsal'],
  ['refund_plain','Admission-only purchase refunds correctly','Refund rehearsal'],
  ['refund_bundle','Bundled admission + drink package refunds admission only','Refund rehearsal'],
  ['refund_addon','Admission with separately purchased package refunds admission only','Refund rehearsal'],
  ['refund_water','Admission with Unlimited Water refunds admission only and forfeits water access','Refund rehearsal'],
  ['dashboard_known_totals','Live Festival Dashboard matches a controlled set of known totals','Reporting verification'],
  ['failure_internet','Temporary internet outage procedure has been rehearsed','Failure drills'],
  ['failure_camera','QR camera permission denial/fallback has been rehearsed','Failure drills'],
  ['failure_abandoned_checkout','Abandoned Stripe checkout has been tested','Failure drills'],
  ['failure_session_expiry','Expired admin/bar/check-in sessions recover safely','Failure drills'],
  ['failure_concurrent_credit','Two bartenders attempting the same last credit cannot double-redeem','Failure drills'],
  ['final_staff_brief','Gate, bar, and supervisor staff have completed the operational briefing','Final sign-off'],
  ['final_owner_signoff','Owner/producer final launch sign-off completed','Final sign-off']
];

function json(data,status=200){return Response.json(data,{status,headers:{'Cache-Control':'no-store','Content-Type':'application/json; charset=utf-8'}})}
function secret(){return process.env.NOCTURNE_ADMIN_SESSION_SECRET||process.env.NOCTURNE_ADMIN_KEY||''}
function safeEqual(a='',b=''){const l=Buffer.from(String(a)),r=Buffer.from(String(b));return l.length===r.length&&timingSafeEqual(l,r)}
function cookies(req){return Object.fromEntries((req.headers.get('cookie')||'').split(';').map((part)=>{const i=part.indexOf('=');if(i<0)return['',''];let v=part.slice(i+1).trim();try{v=decodeURIComponent(v)}catch{}return[part.slice(0,i).trim(),v]}).filter(([k])=>k))}
function authenticated(req){const s=secret();if(!s)return false;const token=cookies(req)[SESSION_COOKIE];if(!token?.includes('.'))return false;const[p,sig]=token.split('.',2);const expected=createHmac('sha256',s).update(p).digest('base64url');if(!safeEqual(sig,expected))return false;try{const d=JSON.parse(Buffer.from(p,'base64url').toString('utf8'));return d.role==='admin'&&Number(d.exp)>Math.floor(Date.now()/1000)}catch{return false}}
function allowedOrigin(req){const origin=req.headers.get('origin');if(!origin)return true;const allowed=new Set(['https://nocturnefestival.com','https://www.nocturnefestival.com']);try{allowed.add(new URL(req.url).origin)}catch{}for(const value of[process.env.NOCTURNE_SITE_URL,process.env.URL,process.env.DEPLOY_PRIME_URL]){try{if(value)allowed.add(new URL(value).origin)}catch{}}return allowed.has(origin)}
function manualDefinition(){return MANUAL_ITEMS.map(([id,label,category])=>({id,label,category,mode:'manual'}))}
async function listJson(storeName,prefix=''){const store=getStore({name:storeName,consistency:'strong'});const{blobs}=await store.list();const keys=blobs.map(({key})=>key).filter((key)=>!prefix||key.startsWith(prefix));const rows=await Promise.all(keys.map((key)=>store.get(key,{type:'json',consistency:'strong'})));return rows.filter(Boolean)}
async function automaticItems(){
  const [apps,reviews,summaries,redemptions,audits]=await Promise.all([
    listJson(APPLICATION_STORE),listJson(REVIEW_STORE),listJson(ORDER_STORE,'submission-'),listJson(REDEMPTION_STORE,'redemption-'),readAudit(1000)
  ]);
  const wallet=appleWalletStatus();
  const hasAudit=(type)=>audits.some((a)=>a?.type===type);
  const drinkTypes=new Set(redemptions.map((r)=>r?.drinkType).filter(Boolean));
  const config=[
    ['cfg_stripe','Stripe secret key configured',Boolean(process.env.STRIPE_SECRET_KEY),'Configuration'],
    ['cfg_webhook','Stripe webhook signing secret configured',Boolean(process.env.STRIPE_WEBHOOK_SECRET),'Configuration'],
    ['cfg_email','Resend sending configuration present',Boolean(process.env.RESEND_API_KEY&&process.env.NOCTURNE_EMAIL_FROM),'Configuration'],
    ['cfg_venue','Private venue runtime variables configured',Boolean(process.env.NOCTURNE_VENUE_NAME&&process.env.NOCTURNE_VENUE_ADDRESS),'Configuration'],
    ['cfg_bar','Dedicated bartender password configured',Boolean(process.env.NOCTURNE_BAR_KEY),'Configuration'],
    ['cfg_checkin','Dedicated check-in password configured',Boolean(process.env.NOCTURNE_CHECKIN_KEY),'Configuration'],
    ['cfg_sessions','Dedicated admin/check-in/bar session secrets configured',Boolean(process.env.NOCTURNE_ADMIN_SESSION_SECRET&&process.env.NOCTURNE_CHECKIN_SESSION_SECRET&&process.env.NOCTURNE_BAR_SESSION_SECRET),'Configuration'],
    ['cfg_ticket_signing','Ticket QR/access signing secrets configured',Boolean(process.env.NOCTURNE_TICKET_QR_SECRET&&process.env.NOCTURNE_TICKET_ACCESS_SECRET),'Configuration'],
    ['cfg_wallet','Apple Wallet signing configuration complete',Boolean(wallet?.configured),'Configuration']
  ].map(([id,label,ok,category])=>({id,label,category,mode:'automatic',state:ok?'pass':'fail',detail:ok?'Configured':'Configuration missing'}));
  const evidence=[
    ['flow_application','At least one rehearsal application has been submitted',apps.length>0,'Core purchase flow'],
    ['flow_approved','At least one applicant has been approved',reviews.some((r)=>r?.status==='approved'),'Core purchase flow'],
    ['flow_redeemed','At least one invitation has been redeemed',reviews.some((r)=>r?.inviteState==='redeemed'||r?.inviteRedeemedAt),'Core purchase flow'],
    ['flow_ticket','At least one paid/comp digital ticket exists',summaries.some((s)=>s?.status==='paid'&&s?.ticketId),'Core purchase flow'],
    ['flow_drink','At least one Six-Drink Package purchase is recorded',summaries.some((s)=>s?.drinkPackagePurchased),'Package flow'],
    ['flow_water','At least one Unlimited Water Package purchase is recorded',summaries.some((s)=>s?.waterPackagePurchased),'Package flow'],
    ['flow_checkin','A successful event check-in has been recorded',hasAudit('ticket.checked_in')||summaries.some((s)=>s?.checkedInAt),'Gate rehearsal'],
    ['flow_band','A drink-package wristband activation has been recorded',hasAudit('drink_package.activated')||summaries.some((s)=>s?.drinkPackageActivatedAt),'Bar rehearsal'],
    ['flow_beer','Beer redemption evidence recorded',drinkTypes.has('beer'),'Bar rehearsal'],
    ['flow_well','Well-cocktail redemption evidence recorded',drinkTypes.has('well'),'Bar rehearsal'],
    ['flow_premium','Premium-cocktail redemption evidence recorded',drinkTypes.has('premium'),'Bar rehearsal'],
    ['flow_refund','An admission refund with reason metadata is recorded',summaries.some((s)=>Array.isArray(s?.refundHistory)&&s.refundHistory.some((r)=>r?.type==='admission'&&r?.reason)),'Refund rehearsal']
  ].map(([id,label,ok,category])=>({id,label,category,mode:'automatic',state:ok?'pass':'pending',detail:ok?'Evidence found':'No rehearsal evidence yet'}));
  return [...config,...evidence];
}
function normalizeState(value){return['pending','pass','fail','na'].includes(String(value))?String(value):'pending'}
function clean(value,max=1000){return String(value||'').trim().slice(0,max)}
async function readState(){const store=getStore({name:STORE,consistency:'strong'});return(await store.get(STATE_KEY,{type:'json',consistency:'strong'}))||{items:{},tester:'',startedAt:null,updatedAt:null}}
function progress(items){const applicable=items.filter((i)=>i.state!=='na');const passed=applicable.filter((i)=>i.state==='pass').length;const failed=applicable.filter((i)=>i.state==='fail').length;return{total:applicable.length,passed,failed,pending:applicable.length-passed-failed,percent:applicable.length?Math.round(passed/applicable.length*100):0}}
async function payload(){const[state,auto]=await Promise.all([readState(),automaticItems()]);const manual=manualDefinition().map((item)=>{const saved=state.items?.[item.id]||{};return{...item,state:normalizeState(saved.state),notes:clean(saved.notes),updatedAt:saved.updatedAt||null,updatedBy:saved.updatedBy||null}});const items=[...auto,...manual];return{ok:true,tester:state.tester||'',startedAt:state.startedAt||null,updatedAt:state.updatedAt||null,items,progress:progress(items)}}
export default async(req)=>{
  if(!authenticated(req))return json({error:'Admin session expired. Sign in again.'},401);
  if(req.method==='GET')return json(await payload());
  if(req.method!=='POST')return json({error:'Method not allowed.'},405);
  if(!allowedOrigin(req))return json({error:'Request origin was not allowed.'},403);
  let body;try{body=await req.json()}catch{return json({error:'Invalid request.'},400)}
  const store=getStore({name:STORE,consistency:'strong'});const current=await readState();const now=new Date().toISOString();
  if(body?.action==='reset'){
    if(String(body?.confirm||'')!=='RESET REHEARSAL')return json({error:'Confirmation phrase did not match.'},400);
    const next={items:{},tester:clean(body?.tester,80),startedAt:now,updatedAt:now};await store.setJSON(STATE_KEY,next);await writeAudit('rehearsal.reset',{tester:next.tester});return json(await payload());
  }
  if(body?.action==='update'){
    const id=clean(body?.id,100);if(!MANUAL_ITEMS.some(([itemId])=>itemId===id))return json({error:'Unknown rehearsal item.'},400);
    const state=normalizeState(body?.state);const tester=clean(body?.tester||current.tester,80);const notes=clean(body?.notes,1000);
    const next={...current,tester,startedAt:current.startedAt||now,updatedAt:now,items:{...(current.items||{}),[id]:{state,notes,updatedAt:now,updatedBy:tester||'Admin'}}};
    await store.setJSON(STATE_KEY,next);await writeAudit('rehearsal.item_updated',{id,state,tester:tester||'Admin'});return json(await payload());
  }
  if(body?.action==='set-tester'){
    const tester=clean(body?.tester,80);const next={...current,tester,startedAt:current.startedAt||now,updatedAt:now};await store.setJSON(STATE_KEY,next);return json(await payload());
  }
  return json({error:'Unknown action.'},400);
};
