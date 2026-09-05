(() => {
  const dashboard = document.querySelector('#admin-dashboard');
  if (!dashboard) return;

  const style = document.createElement('style');
  style.textContent = `
    .admin-waiver-badge{display:inline-flex;align-items:center;width:max-content;margin-top:.35rem;padding:.24rem .48rem;border:1px solid;border-radius:999px;font-size:.58rem;font-weight:700;letter-spacing:.09em;text-transform:uppercase;line-height:1}
    .admin-waiver-badge[data-state="signed"]{border-color:rgba(106,191,131,.55);background:rgba(106,191,131,.08);color:#9be0ae}.admin-waiver-badge[data-state="unsigned"]{border-color:rgba(217,113,92,.65);background:rgba(217,113,92,.09);color:#ffb5a5}
    .admin-waiver-row-remind{display:block;margin-top:.45rem;padding:.38rem .55rem;border:1px solid rgba(216,154,43,.45);background:rgba(216,154,43,.05);color:#f0bd5d;font-size:.58rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;cursor:pointer}.admin-waiver-row-remind:disabled{opacity:.55;cursor:wait}
    .admin-waiver-tools{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(300px,.8fr);gap:1.25rem;align-items:center;margin:1.25rem 0;padding:1.35rem;border:1px solid rgba(216,154,43,.3);background:linear-gradient(135deg,rgba(216,154,43,.055),rgba(217,113,92,.035))}.admin-waiver-tools h2{margin:.35rem 0 .5rem;font-family:var(--serif);font-weight:500;color:#fff2df}.admin-waiver-actions{display:grid;gap:.6rem}.admin-waiver-actions .btn{width:100%;min-height:48px}.admin-waiver-count{color:#ffca61;font-weight:700}.admin-waiver-note{margin:0;color:#8f8372;font-size:.7rem;line-height:1.5}.admin-waiver-filter-wrap select{min-width:190px}
    .event-day-ready{margin:1.25rem 0;padding:1.35rem;border:1px solid rgba(216,154,43,.32);background:#070604}.event-day-ready-head{display:flex;justify-content:space-between;gap:1rem;align-items:center;margin-bottom:1rem}.event-day-ready-head h2{margin:.3rem 0 0;font-family:var(--serif);font-weight:500;color:#fff2df}.event-day-ready-state{padding:.5rem .75rem;border:1px solid;font-size:.64rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase}.event-day-ready-state[data-state="ready"]{color:#9be0ae;border-color:rgba(106,191,131,.55);background:rgba(106,191,131,.08)}.event-day-ready-state[data-state="blocked"]{color:#ffb5a5;border-color:rgba(217,113,92,.65);background:rgba(217,113,92,.09)}.event-day-ready-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:.7rem}.event-day-ready-card{padding:1rem;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.018)}.event-day-ready-card[data-state="ready"]{border-color:rgba(106,191,131,.42);background:rgba(106,191,131,.045)}.event-day-ready-card[data-state="blocked"]{border-color:rgba(217,113,92,.52);background:rgba(217,113,92,.045)}.event-day-ready-card strong{display:block;color:#eee1cd;font-size:.74rem}.event-day-ready-card span{display:block;margin-top:.45rem;color:#8f8372;font-size:.64rem;line-height:1.45}.event-day-ready-card[data-state="ready"] strong::before{content:'● ';color:#78ce91}.event-day-ready-card[data-state="blocked"] strong::before{content:'● ';color:#e17b68}
    @media(max-width:900px){.event-day-ready-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:760px){.admin-waiver-tools{grid-template-columns:1fr}.event-day-ready-head{align-items:flex-start;flex-direction:column}}@media(max-width:520px){.event-day-ready-grid{grid-template-columns:1fr}}
  `;
  document.head.append(style);

  const command = document.createElement('section');
  command.className = 'event-day-ready';
  command.innerHTML = `<div class="event-day-ready-head"><div><p class="admin-kicker">Event Day Ready</p><h2>Final command center.</h2></div><div id="event-day-ready-state" class="event-day-ready-state" data-state="blocked">CHECKING…</div></div><div id="event-day-ready-grid" class="event-day-ready-grid"><article class="event-day-ready-card" data-state="blocked"><strong>Gate Readiness</strong><span>Checking…</span></article><article class="event-day-ready-card" data-state="blocked"><strong>Unsigned Waivers</strong><span>Checking…</span></article><article class="event-day-ready-card" data-state="blocked"><strong>Bartender</strong><span>Checking…</span></article><article class="event-day-ready-card" data-state="blocked"><strong>Stripe</strong><span>Checking…</span></article><article class="event-day-ready-card" data-state="blocked"><strong>Backups</strong><span>Checking…</span></article></div>`;

  const panel = document.createElement('section');
  panel.className = 'admin-gate-readiness';
  panel.innerHTML = `<div class="admin-gate-head"><div><p class="admin-kicker">Gate readiness</p><h2>Paid + comp ticket audit.</h2></div><button id="admin-gate-refresh" class="admin-outline-button" type="button">Run Gate Audit</button></div><div id="admin-gate-summary" class="admin-gate-summary" data-state="loading"><strong>CHECKING…</strong><span>Auditing active ticket records.</span></div><div id="admin-gate-metrics" class="admin-gate-metrics"></div><div id="admin-gate-issues" class="admin-gate-issues"></div>`;
  const nav = dashboard.querySelector('.admin-operations-nav');
  if (nav) { nav.insertAdjacentElement('afterend', command); command.insertAdjacentElement('afterend', panel); } else { dashboard.prepend(panel); dashboard.prepend(command); }

  const waiverTools = document.createElement('section');
  waiverTools.className = 'admin-waiver-tools';
  waiverTools.innerHTML = `<div><p class="admin-kicker">Required waiver outreach</p><h2>Unsigned waiver reminders.</h2><p class="admin-muted">Daily reminders run at 8:00 AM HST until the event. You can also send all eligible unsigned guests now, or send one reminder directly from an unsigned ticket row.</p></div><div class="admin-waiver-actions"><button id="admin-waiver-remind" class="btn" type="button">Send Waiver Reminders →</button><p id="admin-waiver-reminder-status" class="admin-status" role="status" aria-live="polite">Loading unsigned count…</p><p class="admin-waiver-note">Only active tickets are targeted. Signed, refunded, disputed, and inactive tickets are excluded. Manual duplicate sends are suppressed for two hours.</p></div>`;
  panel.insertAdjacentElement('afterend', waiverTools);

  const toolbar = dashboard.querySelector('.admin-toolbar-ops');
  let waiverFilter = null;
  if (toolbar) { const wrap = document.createElement('label'); wrap.className = 'admin-waiver-filter-wrap'; wrap.innerHTML = '<span>Waiver status</span><select id="admin-waiver-filter"><option value="all">All waiver states</option><option value="unsigned">Unsigned waiver</option><option value="signed">Signed waiver</option></select>'; toolbar.append(wrap); waiverFilter = wrap.querySelector('select'); }

  const summary = panel.querySelector('#admin-gate-summary');
  const metrics = panel.querySelector('#admin-gate-metrics');
  const issues = panel.querySelector('#admin-gate-issues');
  const button = panel.querySelector('#admin-gate-refresh');
  const remindButton = waiverTools.querySelector('#admin-waiver-remind');
  const remindStatus = waiverTools.querySelector('#admin-waiver-reminder-status');
  const readyState = command.querySelector('#event-day-ready-state');
  const readyGrid = command.querySelector('#event-day-ready-grid');
  const list = document.querySelector('#admin-application-list');
  const visibleCount = document.querySelector('#admin-visible-count');
  const pagination = document.querySelector('.admin-pagination');
  const pageStatus = document.querySelector('#admin-page-status');
  const esc = (v='') => String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
  let ticketRows = [];

  function ticketForRow(row) { const text = row.textContent || ''; for (const ticket of ticketRows) if (ticket.ticketId && text.includes(ticket.ticketId)) return ticket; return null; }

  async function sendIndividual(ticket, control) {
    if (!ticket?.submissionId || ticket.waiverSigned) return;
    const original = control.textContent;
    control.disabled = true; control.textContent = 'Sending…';
    try {
      const response = await fetch('/api/admin/waiver-reminders', { method:'POST', credentials:'same-origin', headers:{ Accept:'application/json','Content-Type':'application/json' }, body:JSON.stringify({ submissionId:ticket.submissionId, confirm:'SEND WAIVER REMINDER' }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Reminder failed.');
      control.textContent = data.sent ? 'Sent ✓' : 'Recently sent';
      await refreshReminderStatus();
    } catch (error) { control.textContent = 'Send failed'; control.title = error.message || 'Reminder failed.'; setTimeout(() => { control.textContent = original; control.disabled = false; }, 2500); return; }
    setTimeout(() => { control.disabled = false; control.textContent = original; }, 3500);
  }

  function decorateRows() {
    if (!list) return;
    for (const row of list.querySelectorAll('.admin-application-row')) {
      row.querySelectorAll('.admin-waiver-badge,.admin-waiver-row-remind').forEach((node) => node.remove());
      const ticket = ticketForRow(row);
      if (!ticket) { row.dataset.waiverState = 'none'; continue; }
      row.dataset.waiverState = ticket.waiverSigned ? 'signed' : 'unsigned';
      const ticketCell = row.querySelector('.admin-list-ticket') || row;
      const badge = document.createElement('span'); badge.className = 'admin-waiver-badge'; badge.dataset.state = row.dataset.waiverState; badge.textContent = ticket.waiverSigned ? 'Waiver signed' : 'Waiver unsigned'; ticketCell.append(badge);
      if (!ticket.waiverSigned) { const send = document.createElement('button'); send.type='button'; send.className='admin-waiver-row-remind'; send.textContent='Send Waiver Reminder'; send.addEventListener('click', (event) => { event.stopPropagation(); sendIndividual(ticket, send); }); ticketCell.append(send); }
    }
    applyWaiverFilter(false);
  }

  function applyWaiverFilter(resetPagination = true) {
    if (!list || !waiverFilter) return;
    const value = waiverFilter.value, rows = Array.from(list.querySelectorAll('.admin-application-row'));
    if (value === 'all') { for (const row of rows) row.style.removeProperty('display'); if (pagination) pagination.hidden = false; if (resetPagination) document.querySelector('#admin-search')?.dispatchEvent(new Event('input', { bubbles:true })); return; }
    let matches=0; for (const row of rows) { const match=row.dataset.waiverState===value; row.style.setProperty('display',match?'grid':'none','important'); if(match)matches+=1; }
    if(visibleCount)visibleCount.textContent=String(matches); if(pagination)pagination.hidden=true; if(pageStatus)pageStatus.textContent=`Showing all ${matches} ${value} waiver result${matches===1?'':'s'}`;
  }

  async function refreshReminderStatus() {
    try { const response=await fetch('/api/admin/waiver-reminders',{credentials:'same-origin',headers:{Accept:'application/json'},cache:'no-store'}); const data=await response.json().catch(()=>({})); if(!response.ok)throw new Error(data.error||'Could not load waiver reminder status.'); remindButton.disabled=Number(data.eligibleNow||0)===0; remindStatus.classList.remove('error'); remindStatus.innerHTML=`<span class="admin-waiver-count">${Number(data.unsigned||0)}</span> unsigned · ${Number(data.eligibleNow||0)} eligible to email now${Number(data.recentlySent||0)?` · ${Number(data.recentlySent)} recently reminded`:''}`; }
    catch(error){remindButton.disabled=true;remindStatus.textContent=error.message||'Waiver reminder status unavailable.';remindStatus.classList.add('error');}
  }

  async function sendReminders() {
    const unsigned=ticketRows.filter((row)=>!row.waiverSigned).length;if(!unsigned)return;if(!window.confirm(`Send the required waiver reminder to all currently eligible unsigned paid and comp ticket holders?\n\nUnsigned active tickets: ${unsigned}\n\nGuests reminded within the last two hours will be skipped.`))return;
    remindButton.disabled=true;remindStatus.classList.remove('error');remindStatus.textContent='Sending waiver reminders…';
    try{const response=await fetch('/api/admin/waiver-reminders',{method:'POST',credentials:'same-origin',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({confirm:'SEND WAIVER REMINDERS'})});const data=await response.json().catch(()=>({}));if(!response.ok&&response.status!==207)throw new Error(data.error||'Bulk reminder send failed.');const pieces=[`${Number(data.sent||0)} sent`];if(data.skippedRecent)pieces.push(`${Number(data.skippedRecent)} skipped (recent)`);if(data.skippedNoEmail)pieces.push(`${Number(data.skippedNoEmail)} skipped (no email)`);if(data.failed)pieces.push(`${Number(data.failed)} failed`);remindStatus.textContent=`Waiver reminder run complete: ${pieces.join(' · ')}.`;remindStatus.classList.toggle('error',Number(data.failed||0)>0);}catch(error){remindStatus.textContent=error.message||'Bulk reminder send failed.';remindStatus.classList.add('error');}finally{await refreshReminderStatus();}
  }

  function renderCommandCenter(gate, launch) {
    const s=gate?.summary||{}, stripe=launch?.stripe||{}, ops=launch?.operations||{}, backup=launch?.backup||{};
    const checks=[
      {label:'Gate Readiness',ready:Boolean(s.allReady),detail:s.allReady?`${Number(s.readyForGate||0)} active tickets ready`:`${Number(s.blockedOrBroken||0)} ticket${Number(s.blockedOrBroken||0)===1?'':'s'} blocked`},
      {label:'Unsigned Waivers',ready:Number(s.unsignedWaivers||0)===0,detail:Number(s.unsignedWaivers||0)===0?'All active waivers signed':`${Number(s.unsignedWaivers||0)} still unsigned`},
      {label:'Bartender',ready:Boolean(ops?.ticketing?.barReady),detail:ops?.ticketing?.barReady?'Bar credentials ready':'Bar credentials need attention'},
      {label:'Stripe',ready:Boolean(stripe.readyForLive),detail:stripe.readyForLive?'Live payment + fulfillment verified':stripe.configurationReady?'Live config ready; verification incomplete':'Stripe live configuration needs attention'},
      {label:'Backups',ready:Boolean(backup.healthy),detail:backup.healthy?`Latest backup ${Number.isFinite(Number(backup.ageHours))?`${backup.ageHours}h ago`:'is healthy'}`:(backup.error||'Recent backup not verified')}
    ];
    const allReady=checks.every((item)=>item.ready); readyState.dataset.state=allReady?'ready':'blocked';readyState.textContent=allReady?'EVENT DAY READY':'ACTION REQUIRED'; readyGrid.innerHTML=checks.map((item)=>`<article class="event-day-ready-card" data-state="${item.ready?'ready':'blocked'}"><strong>${esc(item.label)}</strong><span>${esc(item.detail)}</span></article>`).join('');
  }

  async function load() {
    button.disabled=true;summary.dataset.state='loading';summary.innerHTML='<strong>CHECKING…</strong><span>Auditing active paid and comp tickets, signed waivers, QR integrity, and record consistency.</span>';readyState.dataset.state='blocked';readyState.textContent='CHECKING…';
    try {
      const [gateResponse,launchResponse]=await Promise.all([
        fetch('/api/admin/gate-audit',{credentials:'same-origin',headers:{Accept:'application/json'},cache:'no-store'}),
        fetch('/api/admin/launch',{credentials:'same-origin',headers:{Accept:'application/json'},cache:'no-store'})
      ]);
      const data=await gateResponse.json().catch(()=>({})); const launch=await launchResponse.json().catch(()=>({}));
      if(!gateResponse.ok)throw new Error(data.error||'Gate audit failed.');
      const s=data.summary||{};ticketRows=Array.isArray(data.tickets)?data.tickets:[];
      summary.dataset.state=s.allReady?'ready':'blocked';summary.innerHTML=s.allReady?`<strong>ALL TICKETS READY</strong><span>${Number(s.readyForGate||0)} active tickets are gate-ready.</span>`:`<strong>${Number(s.blockedOrBroken||0)} TICKET${Number(s.blockedOrBroken||0)===1?'':'S'} NEED ATTENTION</strong><span>Resolve the items below before doors open.</span>`;
      metrics.innerHTML=[['Active',s.activeTickets],['Paid',s.paidTickets],['Comp',s.compTickets],['Waivers signed',s.signedWaivers],['Waivers unsigned',s.unsignedWaivers],['Ready',s.readyForGate],['Blocked',s.blockedOrBroken],['Warnings',s.withWarnings]].map(([label,value])=>`<article><span>${Number(value||0)}</span><small>${label}</small></article>`).join('');
      const rows=[...(data.issues||[]),...(data.warnings||[]).filter((w)=>!(data.issues||[]).some((i)=>i.ticketId===w.ticketId))];issues.innerHTML=rows.length?rows.map((row)=>`<article class="admin-gate-issue ${row.ready?'warning':'error'}"><strong>${esc(row.guestName||'Unknown guest')} · ${esc(row.ticketId||'')}</strong><span>${esc((row.errors||[]).concat(row.warnings||[]).join(' • '))}</span><small>${esc(String(row.source||'').toUpperCase())}${row.email?` · ${esc(row.email)}`:''}</small></article>`).join(''):'<p class="admin-muted">No gate-readiness issues found.</p>';
      if(!launchResponse.ok) launch.error=launch.error||'Launch status unavailable.'; renderCommandCenter(data,launch);decorateRows();await refreshReminderStatus();
    } catch(error){summary.dataset.state='blocked';summary.innerHTML=`<strong>AUDIT ERROR</strong><span>${esc(error.message||'Gate audit could not run.')}</span>`;metrics.innerHTML='';issues.innerHTML='';readyState.dataset.state='blocked';readyState.textContent='STATUS ERROR';}
    finally{button.disabled=false;}
  }

  remindButton.addEventListener('click',sendReminders);waiverFilter?.addEventListener('change',()=>applyWaiverFilter());button.addEventListener('click',load);document.querySelector('#admin-refresh')?.addEventListener('click',()=>setTimeout(load,150));
  const observer=new MutationObserver(()=>{if(!dashboard.hidden)queueMicrotask(decorateRows);});if(list)observer.observe(list,{childList:true});
  const dashboardObserver=new MutationObserver(()=>{if(!dashboard.hidden&&summary.dataset.state==='loading')load();});dashboardObserver.observe(dashboard,{attributes:true,attributeFilter:['hidden']});if(!dashboard.hidden)load();
})();
