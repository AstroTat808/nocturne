const API='/api/check-in';
const login=document.querySelector('#checkin-login');
const consolePanel=document.querySelector('#checkin-console');
const loginForm=document.querySelector('#checkin-login-form');
const loginStatus=document.querySelector('#checkin-login-status');
const logout=document.querySelector('#checkin-logout');
const startButton=document.querySelector('#start-scanner');
const stopButton=document.querySelector('#stop-scanner');
const video=document.querySelector('#checkin-video');
const help=document.querySelector('#scanner-help');
const manualForm=document.querySelector('#manual-checkin-form');
const ticketInput=document.querySelector('#ticket-input');
const result=document.querySelector('#checkin-result');
let stream=null;
let detector=null;
let scanning=false;
let processing=false;
let lastValue='';
let lastAt=0;

async function api(body){const response=await fetch(API,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(body)});let data={};try{data=await response.json()}catch{}if(!response.ok){const error=new Error(data.error||data.message||`Request failed (${response.status}).`);error.data=data;throw error}return data}
function showLogin(){login.hidden=false;consolePanel.hidden=true}
function showConsole(){login.hidden=true;consolePanel.hidden=false}
function setResult(state,title,detail=''){result.dataset.state=state;result.querySelector('strong').textContent=title;result.querySelector('span').textContent=detail}
function formatTime(value){if(!value)return'';const date=new Date(value);if(Number.isNaN(date.getTime()))return'';return new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(date)}

async function validateTicket(value){const normalized=String(value||'').trim();if(!normalized||processing)return;const now=Date.now();if(normalized===lastValue&&now-lastAt<2500)return;lastValue=normalized;lastAt=now;processing=true;setResult('idle','CHECKING','Validating ticket…');try{const data=await api({action:'check-in',value:normalized});if(data.result==='valid'){setResult('valid','VALID — CHECKED IN',`${data.guestName||'Guest'} · ${data.ticketId||''}`)}else if(data.result==='already_used'){setResult('used','ALREADY CHECKED IN',`${data.guestName||'Guest'}${data.checkedInAt?` · ${formatTime(data.checkedInAt)}`:''}`)}else{setResult('invalid','INVALID TICKET',data.message||'Ticket could not be validated.')}}catch(error){const data=error.data||{};if(data.result==='invalid'){setResult('invalid','INVALID TICKET',data.message||'Ticket could not be validated.')}else if(error.message==='Unauthorized.'){await stopScanner();showLogin();loginStatus.textContent='Check-in session expired. Sign in again.'}else setResult('invalid','CHECK-IN ERROR',error.message)}finally{processing=false}}

async function scanLoop(){if(!scanning||!detector)return;try{const codes=await detector.detect(video);if(codes.length&&codes[0].rawValue)await validateTicket(codes[0].rawValue)}catch{}if(scanning)requestAnimationFrame(scanLoop)}

async function startScanner(){if(scanning)return;if(!('BarcodeDetector'in window)){help.textContent='This browser does not provide built-in QR scanning. Use the manual field below, or open this page in a current Chrome/Android browser.';return}try{detector=new BarcodeDetector({formats:['qr_code']});stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});video.srcObject=stream;await video.play();scanning=true;startButton.hidden=true;stopButton.hidden=false;help.textContent='Scanner active. Hold the guest QR code inside the gold frame.';requestAnimationFrame(scanLoop)}catch(error){help.textContent=`Camera scanner could not start: ${error.message}. You can still paste a ticket link below.`}}
async function stopScanner(){scanning=false;if(stream){for(const track of stream.getTracks())track.stop()}stream=null;video.srcObject=null;startButton.hidden=false;stopButton.hidden=true}

loginForm?.addEventListener('submit',async event=>{event.preventDefault();const button=loginForm.querySelector('button[type="submit"]');button.disabled=true;loginStatus.textContent='Verifying…';try{await api({action:'login',password:new FormData(loginForm).get('password')});loginForm.reset();loginStatus.textContent='';showConsole()}catch(error){loginStatus.textContent=error.message}finally{button.disabled=false}});
logout?.addEventListener('click',async()=>{await stopScanner();try{await api({action:'logout'})}catch{}showLogin()});
startButton?.addEventListener('click',startScanner);
stopButton?.addEventListener('click',stopScanner);
manualForm?.addEventListener('submit',async event=>{event.preventDefault();await validateTicket(ticketInput.value);ticketInput.select()});

(async function init(){try{const response=await fetch(API,{credentials:'same-origin',headers:{Accept:'application/json'}});if(response.ok)showConsole();else showLogin()}catch{showLogin()}})();
