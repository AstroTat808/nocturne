(() => {
  const API = '/api/admin/rehearsal';
  const STATES = [
    ['pending', 'Pending'],
    ['pass', 'Pass'],
    ['fail', 'Fail'],
    ['na', 'N/A']
  ];

  const esc = (value = '') => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
  const dateTime = (value) => {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  };

  let latest = null;
  let saving = false;
  let loadedForSession = false;

  async function request(options = {}) {
    const response = await fetch(API, {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {})
      },
      ...options
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) throw new Error('Admin session expired. Sign in again.');
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  }

  function ensureShell() {
    if (document.querySelector('#admin-rehearsal')) return document.querySelector('#admin-rehearsal');
    const nav = document.querySelector('.admin-operations-nav');
    if (!nav) return null;

    const section = document.createElement('section');
    section.id = 'admin-rehearsal';
    section.className = 'admin-rehearsal';
    section.innerHTML = `
      <div class="admin-rehearsal-head">
        <div>
          <p class="admin-kicker">Phase 12 · Test mode</p>
          <h2>Rehearsal checklist.</h2>
          <p>Use one shared checklist to certify payments, tickets, Wallet, gate, bar, refunds, reporting, and failure drills before launch.</p>
        </div>
        <div class="admin-rehearsal-score">
          <strong id="rehearsal-percent">0%</strong>
          <span id="rehearsal-summary">0 of 0 passed</span>
        </div>
      </div>
      <div class="admin-rehearsal-progress" aria-label="Rehearsal completion"><span id="rehearsal-progress-bar"></span></div>
      <div class="admin-rehearsal-toolbar">
        <label><span>Lead tester / supervisor</span><input id="rehearsal-tester" type="text" maxlength="80" placeholder="Name or initials"></label>
        <div class="admin-rehearsal-actions">
          <button id="rehearsal-save-tester" class="admin-outline-button" type="button">Save tester</button>
          <button id="rehearsal-refresh" class="admin-outline-button" type="button">Refresh checks</button>
          <button id="rehearsal-reset" class="admin-outline-button danger" type="button">Reset rehearsal</button>
        </div>
      </div>
      <p id="rehearsal-meta" class="admin-muted"></p>
      <p id="rehearsal-status" class="admin-status" role="status" aria-live="polite"></p>
      <div id="rehearsal-groups" class="admin-rehearsal-groups"></div>`;
    nav.after(section);
    return section;
  }

  function stateLabel(state) {
    return STATES.find(([value]) => value === state)?.[1] || state;
  }

  function render(data) {
    latest = data;
    const shell = ensureShell();
    if (!shell) return;
    const tester = shell.querySelector('#rehearsal-tester');
    if (tester && document.activeElement !== tester) tester.value = data.tester || '';

    const p = data.progress || {};
    shell.querySelector('#rehearsal-percent').textContent = `${Number(p.percent || 0)}%`;
    shell.querySelector('#rehearsal-summary').textContent = `${p.passed || 0} of ${p.total || 0} passed · ${p.failed || 0} failed · ${p.pending || 0} pending`;
    shell.querySelector('#rehearsal-progress-bar').style.width = `${Math.max(0, Math.min(100, Number(p.percent || 0)))}%`;
    shell.querySelector('#rehearsal-meta').textContent = `Started: ${dateTime(data.startedAt)} · Last updated: ${dateTime(data.updatedAt)}`;

    const grouped = new Map();
    for (const item of data.items || []) {
      if (!grouped.has(item.category)) grouped.set(item.category, []);
      grouped.get(item.category).push(item);
    }

    const host = shell.querySelector('#rehearsal-groups');
    host.innerHTML = '';
    for (const [category, items] of grouped) {
      const section = document.createElement('section');
      section.className = 'admin-rehearsal-group';
      const passed = items.filter((item) => item.state === 'pass').length;
      section.innerHTML = `<div class="admin-rehearsal-group-head"><h3>${esc(category)}</h3><span>${passed}/${items.filter((item)=>item.state!=='na').length} passed</span></div>`;
      for (const item of items) {
        const row = document.createElement('article');
        row.className = 'admin-rehearsal-item';
        row.dataset.state = item.state || 'pending';
        row.dataset.mode = item.mode || 'manual';
        const badge = item.mode === 'automatic' ? 'Automatic' : 'Manual';
        const controls = item.mode === 'manual'
          ? `<div class="admin-rehearsal-state-buttons" role="group" aria-label="${esc(item.label)} status">${STATES.map(([value,label]) => `<button type="button" data-rehearsal-state="${value}" class="${item.state===value?'active':''}">${label}</button>`).join('')}</div><label class="admin-rehearsal-notes"><span>Notes</span><textarea rows="2" maxlength="1000" data-rehearsal-notes placeholder="What was tested, device used, issue found, or follow-up needed…">${esc(item.notes || '')}</textarea></label>`
          : `<div class="admin-rehearsal-auto-detail"><strong>${esc(stateLabel(item.state))}</strong><span>${esc(item.detail || '')}</span></div>`;
        row.innerHTML = `<div class="admin-rehearsal-item-main"><span class="admin-rehearsal-mode">${badge}</span><strong>${esc(item.label)}</strong>${item.updatedAt ? `<small>Updated ${esc(dateTime(item.updatedAt))}${item.updatedBy ? ` by ${esc(item.updatedBy)}` : ''}</small>` : ''}</div>${controls}`;
        row.dataset.rehearsalId = item.id;
        section.appendChild(row);
      }
      host.appendChild(section);
    }
  }

  function setStatus(message, error = false) {
    const node = document.querySelector('#rehearsal-status');
    if (!node) return;
    node.textContent = message || '';
    node.classList.toggle('error', Boolean(error));
  }

  async function load() {
    setStatus('Refreshing rehearsal checks…');
    try {
      render(await request());
      setStatus('');
    } catch (error) {
      if (/session expired/i.test(error.message || '')) loadedForSession = false;
      setStatus(error.message || 'Could not load rehearsal checklist.', true);
    }
  }

  async function updateItem(row, state) {
    if (saving) return;
    const id = row.dataset.rehearsalId;
    const notes = row.querySelector('[data-rehearsal-notes]')?.value?.trim() || '';
    const tester = document.querySelector('#rehearsal-tester')?.value?.trim() || latest?.tester || '';
    saving = true;
    row.classList.add('saving');
    setStatus(`Saving ${stateLabel(state).toLowerCase()} status…`);
    try {
      const data = await request({ method: 'POST', body: JSON.stringify({ action: 'update', id, state, notes, tester }) });
      render(data);
      setStatus('Rehearsal item saved.');
    } catch (error) {
      setStatus(error.message || 'Could not save rehearsal item.', true);
    } finally {
      saving = false;
      row.classList.remove('saving');
    }
  }

  document.addEventListener('click', async (event) => {
    const stateButton = event.target.closest('[data-rehearsal-state]');
    if (stateButton) {
      const row = stateButton.closest('.admin-rehearsal-item');
      if (row) await updateItem(row, stateButton.dataset.rehearsalState);
      return;
    }

    if (event.target.closest('#rehearsal-refresh')) return load();

    if (event.target.closest('#rehearsal-save-tester')) {
      const tester = document.querySelector('#rehearsal-tester')?.value?.trim() || '';
      setStatus('Saving rehearsal lead…');
      try { render(await request({ method: 'POST', body: JSON.stringify({ action: 'set-tester', tester }) })); setStatus('Rehearsal lead saved.'); }
      catch (error) { setStatus(error.message || 'Could not save rehearsal lead.', true); }
      return;
    }

    if (event.target.closest('#rehearsal-reset')) {
      if (!window.confirm('Reset every manual rehearsal item to Pending? This does not delete ticket, payment, or audit data.')) return;
      const typed = window.prompt('Type RESET REHEARSAL to confirm:');
      if (typed !== 'RESET REHEARSAL') return setStatus('Reset canceled. Confirmation phrase did not match.', true);
      const tester = document.querySelector('#rehearsal-tester')?.value?.trim() || '';
      setStatus('Resetting rehearsal checklist…');
      try { render(await request({ method: 'POST', body: JSON.stringify({ action: 'reset', confirm: typed, tester }) })); setStatus('Rehearsal checklist reset.'); }
      catch (error) { setStatus(error.message || 'Could not reset rehearsal checklist.', true); }
    }
  });

  function boot() {
    const shell = ensureShell();
    const dashboard = document.querySelector('#admin-dashboard');
    if (!shell || !dashboard) return setTimeout(boot, 100);

    const maybeLoad = () => {
      if (dashboard.hidden) {
        loadedForSession = false;
        return;
      }
      if (!loadedForSession) {
        loadedForSession = true;
        load();
      }
    };

    new MutationObserver(maybeLoad).observe(dashboard, { attributes: true, attributeFilter: ['hidden'] });
    maybeLoad();
  }
  boot();
})();
