const API='/api/check-in';
const login=document.querySelector('#checkin-login');
const consolePanel=document.querySelector('#checkin-console');
const loginForm=document.querySelector('#checkin-login-form');
const loginStatus=document.querySelector('#checkin-login-status');
const logout=document.querySelector('#checkin-logout');
const startButton=document.querySelector('#start-scanner');
const stopButton=document.querySelector('#stop-scanner');
const scanImageButton=document.querySelector('#scan-image');
const imageInput=document.querySelector('#qr-image-input');
const scannerFrame=document.querySelector('#scanner-frame');
const video=document.querySelector('#checkin-video');
const help=document.querySelector('#scanner-help');
const manualForm=document.querySelector('#manual-checkin-form');
const ticketInput=document.querySelector('#ticket-input');
const result=document.querySelector('#checkin-result');
let stream=null;
let detector=null;
let html5Scanner=null;
let scanning=false;
let processing=false;
let lastValue='';
let lastAt=0;

async function api(body){const response=await fetch(API,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(body)});let data={};try{data=await response.json()}catch{}if(!response.ok){const error=new Error(data.error||data.message||`Request failed (${response.status}).`);error.data=data;throw error}return data}
function showLogin(){login.hidden=false;consolePanel.hidden=true}
function showConsole(){login.hidden=true;consolePanel.hidden=false}
function setResult(state,title,detail=''){result.dataset.state=state;result.querySelector('strong').textContent=title;result.querySelector('span').textContent=detail}
function formatTime(value){if(!value)return'';const date=new Date(value);if(Number.isNaN(date.getTime()))return'';return new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short'}).format(date)}
function scannerReady(active){scanning=active;startButton.hidden=active;stopButton.hidden=!active;scanImageButton.disabled=active}
function tokenFromValue(value){const raw=String(value||'').trim();try{return new URL(raw).searchParams.get('token')||raw}catch{return raw}}
async function waterEntitlement(value){const ticketToken=tokenFromValue(value);if(!ticketToken)return false;try{const response=await fetch(`/api/ticket/water?token=${encodeURIComponent(ticketToken)}`,{credentials:'same-origin',headers:{Accept:'application/json'}});if(!response.ok)return false;const data=await response.json();return Boolean(data.purchased)}catch{return false}}

async function validateTicket(value){const normalized=String(value||'').trim();if(!normalized||processing)return;const now=Date.now();if(normalized===lastValue&&now-lastAt<2500)return;lastValue=normalized;lastAt=now;processing=true;setResult('idle','CHECKING','Validating ticket…');try{const data=await api({action:'check-in',value:normalized});const hasWater=await waterEntitlement(normalized);const water=hasWater?' · UNLIMITED WATER':'';if(data.result==='valid'){setResult('valid','VALID — CHECKED IN',`${data.guestName||'Guest'} · ${data.ticketId||''}${water}`)}else if(data.result==='already_used'){setResult('used','ALREADY CHECKED IN',`${data.guestName||'Guest'}${data.checkedInAt?` · ${formatTime(data.checkedInAt)}`:''}${water}`)}else{setResult('invalid','INVALID TICKET',data.message||'Ticket could not be validated.')}}catch(error){const data=error.data||{};if(data.result==='invalid'){setResult('invalid','INVALID TICKET',data.message||'Ticket could not be validated.')}else if(error.message==='Unauthorized.'){await stopScanner();showLogin();loginStatus.textContent='Check-in session expired. Sign in again.'}else setResult('invalid','CHECK-IN ERROR',error.message)}finally{processing=false}}

async function scanLoop(){if(!scanning||!detector)return;try{const codes=await detector.detect(video);if(codes.length&&codes[0].rawValue)await validateTicket(codes[0].rawValue)}catch{}if(scanning&&detector)requestAnimationFrame(scanLoop)}

async function startHtml5Scanner(){if(!window.Html5Qrcode)throw new Error('QR scanner library did not load. Refresh the page and try again.');html5Scanner=new Html5Qrcode('checkin-reader');const cameras=await Html5Qrcode.getCameras();if(!cameras.length)throw new Error('No camera was found on this device.');const camera=cameras.find(item=>/back|rear|environment/i.test(item.label||''))||cameras[cameras.length-1];scannerFrame.dataset.mode='html5';await html5Scanner.start(camera.id,{fps:10,qrbox:{width:250,height:250},aspectRatio:1},async decodedText=>{await validateTicket(decodedText)},()=>{});scannerReady(true);help.textContent='Scanner active. Hold the guest QR code inside the gold frame.'}

async function startNativeScanner(){if(!navigator.mediaDevices?.getUserMedia)throw new Error('Camera access is not available in this browser.');detector=new BarcodeDetector({formats:['qr_code']});stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});video.srcObject=stream;await video.play();scannerFrame.dataset.mode='native';scannerReady(true);help.textContent='Scanner active. Hold the guest QR code inside the gold frame.';requestAnimationFrame(scanLoop)}

async function startScanner(){if(scanning)return;startButton.disabled=true;help.textContent='Requesting camera access…';try{if(window.Html5Qrcode){await startHtml5Scanner()}else if('BarcodeDetector'in window){await startNativeScanner()}else{throw new Error('This browser cannot scan QR codes with the camera. Use Scan QR From Photo or paste the ticket link below.')}}catch(error){scannerFrame.dataset.mode='idle';scannerReady(false);help.textContent=`Camera scanner could not start: ${error.message} If camera permission was denied, enable Camera for nocturnefestival.com in your browser settings and try again.`}finally{startButton.disabled=false}}

async function stopScanner(){scanning=false;detector=null;if(stream){for(const track of stream.getTracks())track.stop()}stream=null;video.srcObject=null;if(html5Scanner){try{if(html5Scanner.isScanning)await html5Scanner.stop()}catch{}try{await html5Scanner.clear()}catch{}html5Scanner=null}scannerFrame.dataset.mode='idle';scannerReady(false);help.textContent='Camera stopped. You can start it again, scan a saved QR image, or paste the ticket link below.'}

async function scanImage(file){if(!file)return;if(scanning)await stopScanner();if(!window.Html5Qrcode){help.textContent='QR image scanning is unavailable. Paste the ticket link below instead.';return}scanImageButton.disabled=true;help.textContent='Reading QR image…';try{scannerFrame.dataset.mode='html5';html5Scanner=new Html5Qrcode('checkin-reader');const decoded=await html5Scanner.scanFile(file,true);await validateTicket(decoded);help.textContent='QR image read successfully.'}catch(error){setResult('invalid','QR NOT READ','Try a clearer screenshot or use the camera scanner.');help.textContent=`Could not read that QR image: ${error.message||error}`}finally{if(html5Scanner){try{await html5Scanner.clear()}catch{}html5Scanner=null}scannerFrame.dataset.mode='idle';scanImageButton.disabled=false;imageInput.value=''}}

loginForm?.addEventListener('submit',async event=>{event.preventDefault();const button=loginForm.querySelector('button[type="submit"]');button.disabled=true;loginStatus.textContent='Verifying…';try{await api({action:'login',password:new FormData(loginForm).get('password')});loginForm.reset();loginStatus.textContent='';showConsole()}catch(error){loginStatus.textContent=error.message}finally{button.disabled=false}});
logout?.addEventListener('click',async()=>{await stopScanner();try{await api({action:'logout'})}catch{}showLogin()});
startButton?.addEventListener('click',startScanner);
stopButton?.addEventListener('click',stopScanner);
scanImageButton?.addEventListener('click',()=>imageInput.click());
imageInput?.addEventListener('change',()=>scanImage(imageInput.files?.[0]));
manualForm?.addEventListener('submit',async event=>{event.preventDefault();await validateTicket(ticketInput.value);ticketInput.select()});
window.addEventListener('pagehide',()=>{if(stream)for(const track of stream.getTracks())track.stop()});

(async function init(){try{const response=await fetch(API,{credentials:'same-origin',headers:{Accept:'application/json'}});if(response.ok)showConsole();else showLogin()}catch{showLogin()}})();
