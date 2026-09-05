(() => {
  const dashboard = document.querySelector('#admin-dashboard');
  if (!dashboard) return;

  const panel = document.createElement('section');
  panel.className = 'admin-gate-readiness';
  panel.innerHTML = `
    <div class="admin-gate-head">
      <div><p class="admin-kicker">Gate readiness</p><h2>Paid + comp ticket audit.</h2></div>
      <button id="admin-gate-refresh" class="admin-outline-button" type="button">Run Gate Audit</button>
    </div>
    <div id="admin-gate-summary" class="admin-gate-summary" data-state="loading"><strong>CHECKING…</strong><span>Auditing active ticket records.</span></div>
    <div id="admin-gate-metrics" class="admin-gate-metrics"></div>
    <div id="admin-gate-issues" class="admin-gate-issues"></div>`;
  const nav = dashboard.querySelector('.admin-operations-nav');
  if (nav) nav.insertAdjacentElement('afterend', panel); else dashboard.prepend(panel);

  const summary = panel.querySelector('#admin-gate-summary');
  const metrics = panel.querySelector('#admin-gate-metrics');
  const issues = panel.querySelector('#admin-gate-issues');
  const button = panel.querySelector('#admin-gate-refresh');
  const esc = (v='') => String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');

  async function load() {
    button.disabled = true;
    summary.dataset.state = 'loading';
    summary.innerHTML = '<strong>CHECKING…</strong><span>Auditing active paid and comp tickets, signed waivers, QR integrity, and record consistency.</span>';
    try {
      const response = await fetch('/api/admin/gate-audit', { credentials: 'same-origin', headers: { Accept: 'application/json' }, cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Gate audit failed.');
      const s = data.summary || {};
      summary.dataset.state = s.allReady ? 'ready' : 'blocked';
      summary.innerHTML = s.allReady
        ? `<strong>ALL TICKETS READY</strong><span>${Number(s.readyForGate||0)} active tickets are gate-ready.</span>`
        : `<strong>${Number(s.blockedOrBroken||0)} TICKET${Number(s.blockedOrBroken||0)===1?'':'S'} NEED ATTENTION</strong><span>Resolve the items below before doors open.</span>`;
      metrics.innerHTML = [
        ['Active', s.activeTickets], ['Paid', s.paidTickets], ['Comp', s.compTickets], ['Ready', s.readyForGate], ['Blocked', s.blockedOrBroken], ['Warnings', s.withWarnings]
      ].map(([label,value]) => `<article><span>${Number(value||0)}</span><small>${label}</small></article>`).join('');
      const rows = [...(data.issues || []), ...(data.warnings || []).filter((w) => !(data.issues || []).some((i) => i.ticketId === w.ticketId))];
      issues.innerHTML = rows.length ? rows.map((row) => `<article class="admin-gate-issue ${row.ready?'warning':'error'}"><strong>${esc(row.guestName||'Unknown guest')} · ${esc(row.ticketId||'')}</strong><span>${esc((row.errors||[]).concat(row.warnings||[]).join(' • '))}</span><small>${esc(String(row.source||'').toUpperCase())}${row.email?` · ${esc(row.email)}`:''}</small></article>`).join('') : '<p class="admin-muted">No gate-readiness issues found.</p>';
    } catch (error) {
      summary.dataset.state = 'blocked';
      summary.innerHTML = `<strong>AUDIT ERROR</strong><span>${esc(error.message || 'Gate audit could not run.')}</span>`;
      metrics.innerHTML = '';
      issues.innerHTML = '';
    } finally {
      button.disabled = false;
    }
  }

  button.addEventListener('click', load);
  document.querySelector('#admin-refresh')?.addEventListener('click', () => setTimeout(load, 150));
  const observer = new MutationObserver(() => { if (!dashboard.hidden && summary.dataset.state === 'loading') load(); });
  observer.observe(dashboard, { attributes: true, attributeFilter: ['hidden'] });
  if (!dashboard.hidden) load();
})();
