(() => {
  const API = '/.netlify/functions/admin-operations';
  const money = (cents) => {
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(cents || 0) / 100); }
    catch { return `$${(Number(cents || 0) / 100).toFixed(2)}`; }
  };
  const dateTime = (value) => {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  };
  const set = (id, value) => { const node = document.querySelector(id); if (node) node.textContent = value; };
  const esc = (value = '') => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');

  let timer = null;
  let loading = false;

  function render(data) {
    const gate = data.gate || {};
    const bar = data.bar || {};
    const live = data.live || {};

    set('#ops-live-attendance', live.currentAttendance || 0);
    set('#ops-live-attendance-detail', `${Number(gate.attendancePercent || 0).toFixed(1)}% of active admissions`);
    set('#ops-live-wristbands', live.activeWristbands || 0);
    set('#ops-live-wristband-detail', `${live.assignedWristbands || 0} assigned total`);
    set('#ops-live-water', live.activeWaterPackages || 0);
    set('#ops-live-exceptions', (live.exceptions || []).length);

    set('#gate-tickets-sold', gate.ticketsSold || 0);
    set('#gate-comp-tickets', gate.compTickets || 0);
    set('#gate-active', gate.activeAdmissions || 0);
    set('#gate-checked-in', gate.checkedIn || 0);
    set('#gate-waiting', gate.notYetCheckedIn || 0);
    set('#gate-refunds', money(gate.admissionRefundsCents));
    set('#gate-attendance', `${Number(gate.attendancePercent || 0).toFixed(1)}%`);
    set('#gate-net-revenue', money(gate.netAdmissionRevenueCents));
    set('#gate-gross-revenue', `Gross ${money(gate.grossAdmissionRevenueCents)}`);

    set('#bar-package-revenue', money(bar.packageRevenueCents));
    set('#bar-premium-revenue', `Premium upgrades ${money(bar.premiumUpgradeCents)}`);
    set('#bar-six-sold', bar.sixDrinkPackagesSold || 0);
    set('#bar-water-sold', bar.waterPackagesSold || 0);
    set('#bar-credits-redeemed', bar.creditsRedeemed || 0);
    set('#bar-credits-remaining', bar.creditsRemaining || 0);
    set('#bar-average-used', Number(bar.averageCreditsUsedPerPackage || 0).toFixed(2));
    set('#bar-active-bands', bar.activeWristbands || 0);
    set('#bar-beer', bar.drinkCounts?.beer || 0);
    set('#bar-well', bar.drinkCounts?.well || 0);
    set('#bar-premium', bar.drinkCounts?.premium || 0);
    set('#bar-nonalcoholic', bar.drinkCounts?.nonalcoholic || 0);

    const bartenderBody = document.querySelector('#ops-bartenders');
    if (bartenderBody) {
      const rows = bar.bartenders || [];
      bartenderBody.innerHTML = rows.length ? rows.map((item) => `<tr><td>${esc(item.name)}</td><td>${Number(item.redemptions || 0)}</td><td>${Number(item.premiumUpgrades || 0)}</td><td>${money(item.premiumUpgradeCents)}</td><td>${esc(dateTime(item.lastActivityAt))}</td></tr>`).join('') : '<tr><td colspan="5">No bartender activity yet.</td></tr>';
    }

    const exceptionBox = document.querySelector('#ops-exceptions');
    if (exceptionBox) {
      const items = live.exceptions || [];
      exceptionBox.innerHTML = items.length ? items.map((item) => `<article class="ops-feed-item" data-severity="${esc(item.severity || 'medium')}"><strong>${esc(item.message || item.type || 'Exception')}<span class="ops-chip">${esc(item.severity || 'review')}</span></strong><span>${esc(item.ticketId || item.submissionId || 'System event')} · ${esc(dateTime(item.occurredAt))}</span></article>`).join('') : '<p class="ops-empty">No current exceptions.</p>';
    }

    const checkinBox = document.querySelector('#ops-checkins');
    if (checkinBox) {
      const items = live.recentCheckIns || [];
      checkinBox.innerHTML = items.length ? items.map((item) => `<article class="ops-feed-item"><strong>${esc(item.guestName || 'NOCTURNE Guest')}</strong><span>${esc(item.ticketId || 'Ticket')} · ${esc(dateTime(item.occurredAt))}</span></article>`).join('') : '<p class="ops-empty">No check-ins yet.</p>';
    }

    const redemptionBox = document.querySelector('#ops-redemptions');
    if (redemptionBox) {
      const items = live.recentRedemptions || [];
      redemptionBox.innerHTML = items.length ? items.map((item) => `<article class="ops-feed-item"><strong>${esc(item.drinkType || 'drink')} · ${esc(item.staffName || 'Bartender')}${item.rapidOverride ? '<span class="ops-chip">override</span>' : ''}</strong><span>${esc(item.guestName || item.ticketId || 'Guest')} · ${Number(item.creditsRemaining || 0)} credits left${item.premiumUpgradeCents ? ` · ${money(item.premiumUpgradeCents)} upgrade` : ''} · ${esc(dateTime(item.redeemedAt))}</span></article>`).join('') : '<p class="ops-empty">No drink redemptions yet.</p>';
    }

    set('#ops-updated', `Updated ${dateTime(data.generatedAt)}`);
  }

  async function load() {
    if (loading) return;
    loading = true;
    const status = document.querySelector('#ops-status');
    if (status) { status.textContent = 'Refreshing live operations…'; status.classList.remove('error'); }
    try {
      const response = await fetch(API, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) {
        window.location.href = '/admin';
        return;
      }
      if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
      render(data);
      if (status) status.textContent = '';
    } catch (error) {
      if (status) { status.textContent = error.message || 'Could not refresh live operations.'; status.classList.add('error'); }
    } finally {
      loading = false;
    }
  }

  function schedule() {
    clearInterval(timer);
    const enabled = document.querySelector('#ops-auto-refresh')?.checked;
    if (enabled) timer = setInterval(load, 30000);
  }

  document.querySelector('#ops-refresh')?.addEventListener('click', load);
  document.querySelector('#ops-auto-refresh')?.addEventListener('change', schedule);
  load();
  schedule();
})();
