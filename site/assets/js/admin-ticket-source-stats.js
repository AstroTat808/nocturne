(() => {
  const dashboard = document.querySelector('#admin-dashboard');
  const statsGrid = document.querySelector('.admin-ticket-stats');
  const originalPaidCard = statsGrid?.querySelector('[data-ticket-state-filter="paid"]');
  const list = document.querySelector('#admin-application-list');
  const refreshButton = document.querySelector('#admin-refresh');
  const ticketOverview = document.querySelector('.admin-ticket-overview:not(.admin-drink-overview)');
  const drinkOverview = document.querySelector('.admin-drink-overview');
  const originalRevenue = document.querySelector('#ticket-revenue');

  if (ticketOverview && drinkOverview && ticketOverview.nextElementSibling !== drinkOverview) drinkOverview.parentNode?.insertBefore(ticketOverview, drinkOverview);
  if (!dashboard || !statsGrid || !originalPaidCard) return;

  const totalCard = document.createElement('article'); totalCard.className='admin-ticket-stat admin-ticket-source-stat admin-ticket-total-stat'; totalCard.innerHTML='<span id="ticket-stat-total-holders">0</span><small>Total Ticket Holders</small><em>Valid admission · including checked in</em>';
  const paidCard = document.createElement('article'); paidCard.className='admin-ticket-stat admin-ticket-source-stat'; paidCard.innerHTML='<span id="ticket-stat-paid-source">0</span><small>Paid</small><em>Purchased · ready for entry</em>';
  const compCard = document.createElement('article'); compCard.className='admin-ticket-stat admin-ticket-source-stat'; compCard.innerHTML='<span id="ticket-stat-comp">0</span><small>Comp</small><em>Complimentary · ready for entry</em>';
  originalPaidCard.replaceWith(totalCard, paidCard, compCard);
  const totalEl=totalCard.querySelector('#ticket-stat-total-holders'), paidEl=paidCard.querySelector('#ticket-stat-paid-source'), compEl=compCard.querySelector('#ticket-stat-comp');

  let admissionRevenueEl=null, addonRevenueEl=null, totalCollectedEl=null;
  if(originalRevenue){
    const host=originalRevenue.parentElement;
    if(host){
      host.classList.add('admin-revenue-split-host');
      const label=host.querySelector('small'); if(label) label.textContent='Admission Revenue';
      originalRevenue.id='admission-revenue'; admissionRevenueEl=originalRevenue;
      const split=document.createElement('div'); split.className='admin-revenue-split';
      split.innerHTML='<div><small>Add-On Revenue</small><strong id="addon-revenue">$0.00</strong></div><div class="admin-revenue-total"><small>Total Collected</small><strong id="total-collected">$0.00</strong></div>';
      host.append(split); addonRevenueEl=split.querySelector('#addon-revenue'); totalCollectedEl=split.querySelector('#total-collected');
    }
  }

  const style=document.createElement('style'); style.textContent=`.admin-ticket-source-stat{cursor:default}.admin-ticket-source-stat:hover{border-color:rgba(216,154,43,.14);background:#050403;transform:none}.admin-ticket-total-stat{border-color:rgba(106,191,131,.34);background:rgba(106,191,131,.035)}.admin-ticket-total-stat span{color:#a8dcb8}.admin-revenue-split{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem;margin-top:1.2rem;padding-top:1.2rem;border-top:1px solid rgba(216,154,43,.16)}.admin-revenue-split>div{display:flex;flex-direction:column;gap:.35rem}.admin-revenue-split small{font-size:.68rem;letter-spacing:.16em;text-transform:uppercase;color:#8f877a}.admin-revenue-split strong{font-family:Georgia,serif;font-size:clamp(1.65rem,4vw,2.4rem);font-weight:400;color:#e8dfd0}.admin-revenue-total strong{color:#a8dcb8}@media(min-width:981px){.admin-ticket-stats{grid-template-columns:repeat(6,minmax(0,1fr))}}@media(max-width:600px){.admin-revenue-split{grid-template-columns:1fr 1fr;gap:.75rem}.admin-revenue-split strong{font-size:1.55rem}}`; document.head.append(style);

  const money=(cents,currency='usd')=>{try{return new Intl.NumberFormat(undefined,{style:'currency',currency:String(currency).toUpperCase()}).format(Number(cents||0)/100)}catch{return`$${(Number(cents||0)/100).toFixed(2)}`}};
  let loading=false,timer=0;
  async function refreshSourceCounts(){
    if(loading||dashboard.hidden)return; loading=true;
    try{
      const [applicationsResponse,entitlementsResponse]=await Promise.all([
        fetch('/api/admin/dashboard?action=applications',{credentials:'same-origin',headers:{Accept:'application/json'},cache:'no-store'}),
        fetch('/.netlify/functions/admin-row-entitlements',{credentials:'same-origin',headers:{Accept:'application/json'},cache:'no-store'})
      ]);
      if(!applicationsResponse.ok||!entitlementsResponse.ok)return;
      const data=await applicationsResponse.json().catch(()=>({})); const entitlements=await entitlementsResponse.json().catch(()=>({}));
      const applications=Array.isArray(data.applications)?data.applications:[]; let total=0,paid=0,comp=0,ticketCollected=0; let currency='usd';
      for(const application of applications){const ticket=application?.ticket||{};if(['paid','checked_in'].includes(ticket.state)){total+=1;const amount=Number(ticket.amountTotal||0);if(Number.isFinite(amount)&&amount>0)ticketCollected+=amount;currency=ticket.currency||currency}if(ticket.state!=='paid')continue;if(String(ticket.ticketSource||'').toLowerCase()==='comp')comp+=1;else paid+=1}
      const packageSummary=entitlements.summary||{}; const bundled=Number(packageSummary.bundledAddonRevenueCents||0); const addons=Number(packageSummary.packageRevenueCents||0); const admission=Math.max(0,ticketCollected-bundled); const totalCollected=admission+addons;
      totalEl.textContent=String(total);paidEl.textContent=String(paid);compEl.textContent=String(comp);
      if(admissionRevenueEl)admissionRevenueEl.textContent=money(admission,currency); if(addonRevenueEl)addonRevenueEl.textContent=money(addons,currency); if(totalCollectedEl)totalCollectedEl.textContent=money(totalCollected,currency);
    }catch(error){console.warn('NOCTURNE ticket/revenue summary unavailable:',error)}finally{loading=false}
  }
  function scheduleRefresh(delay=120){clearTimeout(timer);timer=setTimeout(refreshSourceCounts,delay)}
  new MutationObserver(()=>{if(!dashboard.hidden)scheduleRefresh()}).observe(dashboard,{attributes:true,attributeFilter:['hidden']});
  if(list)new MutationObserver(()=>scheduleRefresh(250)).observe(list,{childList:true});
  refreshButton?.addEventListener('click',()=>scheduleRefresh(350)); scheduleRefresh(50);
})();
