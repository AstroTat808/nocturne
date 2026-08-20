const staffPanel=document.querySelector('#ticket-staff-panel');
const staffButton=document.querySelector('#ticket-staff-checkin');
const staffResult=document.querySelector('#ticket-staff-result');
const token=new URLSearchParams(window.location.search).get('token')||'';

async function sessionActive(){try{const response=await fetch('/api/check-in',{credentials:'same-origin',headers:{Accept:'application/json'}});return response.ok}catch{return false}}

async function checkIn(){if(!token||!staffButton)return;staffButton.disabled=true;staffResult.textContent='Checking in…';try{const response=await fetch('/api/check-in',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({action:'check-in',token})});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.message||data.error||'Check-in failed.');if(data.result==='valid'){staffResult.textContent=`VALID — CHECKED IN · ${data.guestName||''}`;staffPanel.dataset.state='valid';staffButton.hidden=true}else if(data.result==='already_used'){staffResult.textContent=`ALREADY CHECKED IN${data.checkedInAt?` · ${new Date(data.checkedInAt).toLocaleString()}`:''}`;staffPanel.dataset.state='used';staffButton.hidden=true}else{staffResult.textContent=data.message||'INVALID TICKET';staffPanel.dataset.state='invalid'}}catch(error){staffResult.textContent=error.message;staffPanel.dataset.state='invalid'}finally{staffButton.disabled=false}}

staffButton?.addEventListener('click',checkIn);
(async()=>{if(staffPanel&&await sessionActive())staffPanel.hidden=false})();
