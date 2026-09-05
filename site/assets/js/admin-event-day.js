(() => {
  const section = document.querySelector('#admin-event-day');
  if (!section) return;

  const readyState = document.querySelector('#event-day-ready-state');
  const readyGrid = document.querySelector('#event-day-ready-grid');
  const summary = document.querySelector('#admin-gate-summary');
  const metrics = document.querySelector('#admin-gate-metrics');
  const issues = document.querySelector('#admin-gate-issues');
  const refreshAll = document.querySelector('#event-day-refresh');
  const refreshGate = document.querySelector('#admin-gate-refresh');
  const status = document.querySelector('#event-day-status');
  const esc = (value = '') => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');

  function setStatus(message, error = false) {
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('error', Boolean(error));
  }

  async function readJson(url) {
    const response = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' }, cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  }

  async function requireAdmin() {
    const { response } = await readJson('/api/admin/auth');
    if (response.ok) return true;
    window.location.replace('/admin');
    return false;
  }

  function renderCommandCenter(gate, launch) {
    const gateSummary = gate?.summary || {};
    const stripe = launch?.stripe || {};
    const operations = launch?.operations || {};
    const backup = launch?.backup || {};
    const launchAvailable = !launch?.__unavailable;
    const checks = [
      {
        label: 'Gate Readiness',
        ready: Boolean(gateSummary.allReady),
        detail: gateSummary.allReady ? `${Number(gateSummary.readyForGate || 0)} active tickets ready` : `${Number(gateSummary.blockedOrBroken || 0)} ticket${Number(gateSummary.blockedOrBroken || 0) === 1 ? '' : 's'} blocked`
      },
      {
        label: 'Unsigned Waivers',
        ready: Number(gateSummary.unsignedWaivers || 0) === 0,
        detail: Number(gateSummary.unsignedWaivers || 0) === 0 ? 'All active waivers signed' : `${Number(gateSummary.unsignedWaivers || 0)} still unsigned`
      },
      {
        label: 'Bartender',
        ready: launchAvailable && Boolean(operations?.ticketing?.barReady),
        detail: !launchAvailable ? 'Launch status unavailable' : operations?.ticketing?.barReady ? 'Bar credentials ready' : 'Bar credentials need attention'
      },
      {
        label: 'Stripe',
        ready: launchAvailable && Boolean(stripe.readyForLive),
        detail: !launchAvailable ? 'Launch status unavailable' : stripe.readyForLive ? 'Live payment + fulfillment verified' : stripe.configurationReady ? 'Live config ready; verification incomplete' : 'Stripe live configuration needs attention'
      },
      {
        label: 'Backups',
        ready: launchAvailable && Boolean(backup.healthy),
        detail: !launchAvailable ? 'Launch status unavailable' : backup.healthy ? `Latest backup ${Number.isFinite(Number(backup.ageHours)) ? `${backup.ageHours}h ago` : 'is healthy'}` : (backup.error || 'Recent backup not verified')
      }
    ];
    const allReady = checks.every((item) => item.ready);
    readyState.dataset.state = allReady ? 'ready' : 'blocked';
    readyState.textContent = allReady ? 'EVENT DAY READY' : 'ACTION REQUIRED';
    readyGrid.innerHTML = checks.map((item) => `<article class="event-day-ready-card" data-state="${item.ready ? 'ready' : 'blocked'}"><strong>${esc(item.label)}</strong><span>${esc(item.detail)}</span></article>`).join('');
  }

  function renderGate(data = {}) {
    const s = data.summary || {};
    summary.dataset.state = s.allReady ? 'ready' : 'blocked';
    summary.innerHTML = s.allReady
      ? `<strong>ALL TICKETS READY</strong><span>${Number(s.readyForGate || 0)} active tickets are gate-ready.</span>`
      : `<strong>${Number(s.blockedOrBroken || 0)} TICKET${Number(s.blockedOrBroken || 0) === 1 ? '' : 'S'} NEED ATTENTION</strong><span>Resolve the items below before doors open.</span>`;

    metrics.innerHTML = [
      ['Active', s.activeTickets],
      ['Paid', s.paidTickets],
      ['Comp', s.compTickets],
      ['Waivers signed', s.signedWaivers],
      ['Waivers unsigned', s.unsignedWaivers],
      ['Ready', s.readyForGate],
      ['Blocked', s.blockedOrBroken],
      ['Warnings', s.withWarnings]
    ].map(([label, value]) => `<article><span>${Number(value || 0)}</span><small>${esc(label)}</small></article>`).join('');

    const problemRows = [
      ...(Array.isArray(data.issues) ? data.issues : []),
      ...(Array.isArray(data.warnings) ? data.warnings : []).filter((warning) => !(data.issues || []).some((issue) => issue.ticketId === warning.ticketId))
    ];
    issues.innerHTML = problemRows.length
      ? problemRows.map((row) => `<article class="admin-gate-issue ${row.ready ? 'warning' : 'error'}"><strong>${esc(row.guestName || 'Unknown guest')} · ${esc(row.ticketId || '')}</strong><span>${esc([...(row.errors || []), ...(row.warnings || [])].join(' • '))}</span><small>${esc(String(row.source || '').toUpperCase())}${row.email ? ` · ${esc(row.email)}` : ''}</small></article>`).join('')
      : '<p class="admin-muted">No gate-readiness issues found.</p>';
  }

  function setLoading() {
    refreshAll.disabled = true;
    refreshGate.disabled = true;
    readyState.dataset.state = 'blocked';
    readyState.textContent = 'CHECKING…';
    summary.dataset.state = 'loading';
    summary.innerHTML = '<strong>CHECKING…</strong><span>Auditing active paid and comp tickets, signed waivers, QR integrity, and record consistency.</span>';
    setStatus('Refreshing event-day readiness…');
  }

  async function loadAll() {
    setLoading();
    try {
      const [gateResult, launchResult] = await Promise.all([
        readJson('/api/admin/gate-audit'),
        readJson('/api/admin/launch')
      ]);
      if (gateResult.response.status === 401 || launchResult.response.status === 401) {
        window.location.replace('/admin');
        return;
      }
      if (!gateResult.response.ok) throw new Error(gateResult.data.error || 'Gate audit failed.');
      renderGate(gateResult.data);
      const launch = launchResult.response.ok ? launchResult.data : { __unavailable: true };
      renderCommandCenter(gateResult.data, launch);
      setStatus(launchResult.response.ok ? 'Event-day readiness check complete.' : 'Gate audit completed, but launch readiness could not be loaded.', !launchResult.response.ok);
    } catch (error) {
      summary.dataset.state = 'blocked';
      summary.innerHTML = `<strong>AUDIT ERROR</strong><span>${esc(error.message || 'Gate audit could not run.')}</span>`;
      metrics.innerHTML = '';
      issues.innerHTML = '';
      readyState.dataset.state = 'blocked';
      readyState.textContent = 'STATUS ERROR';
      setStatus(error.message || 'Event-day readiness could not be checked.', true);
    } finally {
      refreshAll.disabled = false;
      refreshGate.disabled = false;
    }
  }

  refreshAll.addEventListener('click', loadAll);
  refreshGate.addEventListener('click', loadAll);

  (async () => {
    try {
      if (!await requireAdmin()) return;
      section.hidden = false;
      await loadAll();
    } catch {
      window.location.replace('/admin');
    }
  })();
})();
