// ---------------- Tabs ----------------
document.querySelectorAll('.tab-btn[data-view]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn[data-view]').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('view-' + btn.dataset.view).classList.add('active');
  });
});

// ---------------- Enterprise UI layer (presentation only) ----------------
// Everything below reads state the app already keeps (scans, notifications,
// schedules, routes, sites, profile) and only ever writes to the DOM. It never
// touches the database, the realtime channels or any existing handler.
const UI_ICONS = {
  alert:  '<svg class="icon" viewBox="0 0 24 24"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4M12 17h.01"/></svg>',
  octagon:'<svg class="icon" viewBox="0 0 24 24"><path d="M7.86 2h8.28L22 7.86v8.28L16.14 22H7.86L2 16.14V7.86Z"/><path d="M12 8v4M12 16h.01"/></svg>',
  check:  '<svg class="icon" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>',
  sun:    '<svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>',
  moon:   '<svg class="icon" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>',
  bell:   '<svg class="icon" viewBox="0 0 24 24"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>'
};
const UI_KIND_LABELS = {
  panic: 'Panic button',
  missed_patrol: 'Missed patrol',
  late_patrol: 'Late patrol',
  radius_alert: 'Position alert',
  tag_skipped: 'Tag skipped',
  success_patrol: 'Patrol completed'
};

// "14:05" over "Today" / "Yesterday" / "Sep 19" — readable at a glance in tables.
function fmtTs(ms){
  const d = new Date(ms), now = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const yest = new Date(now); yest.setDate(yest.getDate() - 1);
  const date = d.toDateString() === now.toDateString() ? 'Today'
    : d.toDateString() === yest.toDateString() ? 'Yesterday'
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `<span class="ts"><span class="ts-time">${time}</span><span class="ts-date">${date}</span></span>`;
}
function uiScanResultLabel(result){
  if (result === 'ACCEPTED') return 'Accepted';
  if (result === 'SKIPPED') return 'Skipped';
  const t = String(result || '').replace('REJECTED_', '').replace(/_/g, ' ').toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// ---- Alert + incident card builders (used by the existing render functions) ----
function uiAlertCard(n, site){
  const isPanic = n.kind === 'panic';
  const sev = n.severity === 'red' ? { label: 'Critical', tone: 'crit' }
    : n.severity === 'orange' ? { label: 'Warning', tone: 'warn' }
    : { label: 'Completed', tone: 'success' };
  const icon = isPanic ? UI_ICONS.octagon : n.severity === 'green' ? UI_ICONS.check : UI_ICONS.alert;
  const kind = UI_KIND_LABELS[n.kind] || '';
  const head = `
    <div class="alert-head">
      <div class="alert-ico">${icon}</div>
      <div class="alert-main">
        <div class="alert-title">${escapeHtmlForPrint(n.title)}</div>
        <div class="alert-context">${notifContextLine(n, site)}</div>
        ${kind ? `<div class="alert-tags"><span class="alert-kind">${kind}</span></div>` : ''}
      </div>
      <div class="alert-side">
        <span class="st st-${sev.tone}">${isPanic ? 'Panic' : sev.label}</span>
        <span class="alert-time">${timeAgo(n.occurred_at)}</span>
      </div>
    </div>`;
  if (isAutoClearing(n)){
    const remainMin = Math.max(0, 60 - Math.round((nowMs() - new Date(n.occurred_at).getTime()) / 60000));
    return `<div class="alert-card sev-${n.severity}">${head}<div class="alert-foot">Clears automatically in ${remainMin}m</div></div>`;
  }
  const panicRow = isPanic ? `
      <div class="panic-contact">
        ${site && site.phone
          ? `<a class="btn btn-primary" href="${telHref(site.phone)}" style="width:auto; padding:8px 14px;">Call site · ${escapeHtmlForPrint(cleanPhone(site.phone))}</a>`
          : '<span class="panic-nophone">Site phone number not set</span>'}
        <button class="btn" type="button" data-track-site="${n.site_id}" style="width:auto; padding:8px 14px;">Live track</button>
      </div>` : '';
  return `
    <div class="alert-card sev-${n.severity}${isPanic ? ' is-panic' : ''}">
      ${head}
      ${panicRow}
      <div class="alert-actions">
        <input type="text" placeholder="Comment to resolve…" data-notif-comment="${n.id}">
        <button class="btn" data-notif-submit="${n.id}" style="flex:0 0 auto; width:auto; padding:8px 14px;">Post & clear</button>
      </div>
    </div>`;
}
function uiResolvedRow(n, site){
  const context = notifContextLine(n, site);
  const comment = (n.notification_comments || []).slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
  const note = comment
    ? `<div class="rr-note">“${escapeHtmlForPrint(comment.body)}” — ${escapeHtmlForPrint((comment.profiles && comment.profiles.full_name) || 'Someone')}</div>`
    : (isAutoClearing(n) ? '<div class="rr-note">Auto-cleared</div>' : '');
  return `
    <div class="resolved-row">
      <span class="st st-success">Resolved</span>
      <div class="rr-main">
        <div class="rr-title">${escapeHtmlForPrint(n.title)}</div>
        ${context ? `<div class="rr-note">${context}</div>` : ''}
        ${note}
      </div>
      <div class="rr-time">${timeAgo(n.cleared_at || n.occurred_at)}</div>
    </div>`;
}
function uiIncidentCard(inc, site, guardEntry){
  const sevKey = ['critical', 'high', 'medium', 'low'].includes(inc.severity) ? inc.severity : 'low';
  const tone = { critical: 'crit', high: 'warn', medium: 'info', low: 'neutral' }[sevKey];
  const meta = INCIDENT_SEVERITY_META[inc.severity] || { label: inc.severity };
  const reviewed = inc.status === 'reviewed';
  const desc = (inc.description || '').slice(0, 140) + ((inc.description || '').length > 140 ? '…' : '');
  return `
    <div class="incident-card sev-${sevKey}" data-open-incident="${inc.id}">
      <div class="incident-head">
        <div>
          <div class="incident-title">${escapeHtmlForPrint(INCIDENT_TYPE_LABELS[inc.incident_type] || inc.incident_type)}</div>
          <div class="incident-meta">${escapeHtmlForPrint(site ? site.name : '—')} · ${escapeHtmlForPrint(guardEntry ? guardEntry.full_name : 'Unknown guard')}</div>
        </div>
        <div class="incident-badges">
          <span class="st st-${tone}">${escapeHtmlForPrint(meta.label)}</span>
          ${inc.resolution ? '' : '<span class="st st-warn">Unresolved</span>'}
          <span class="st ${reviewed ? 'st-success' : 'st-info'}">${reviewed ? 'Reviewed' : 'Open'}</span>
        </div>
      </div>
      ${desc ? `<div class="incident-desc">${escapeHtmlForPrint(desc)}</div>` : ''}
      <div class="incident-time">${timeAgo(inc.occurred_at)}</div>
    </div>`;
}

// ---- Counts, KPI tones, header status ----
function uiOpenAlertCount(){
  if (typeof notifications === 'undefined' || !Array.isArray(notifications)) return 0;
  const shiftStart = currentShiftStart(nowMs());
  return notifications.filter(n => !n.cleared_at && n.severity !== 'green' && new Date(n.occurred_at).getTime() >= shiftStart).length;
}
function paintKpis(){
  document.querySelectorAll('.stat-card.k-crit, .stat-card.k-warn').forEach(card => {
    const v = card.querySelector('.stat-val');
    const n = v ? parseInt(v.textContent, 10) : 0;
    card.classList.toggle('alert-on', n > 0);
  });
}
function uiSetAttentionCount(activeList){
  const pill = document.getElementById('ctrlAttentionCount');
  if (!pill) return;
  const n = activeList.filter(x => x.severity !== 'green').length;
  pill.textContent = n;
  pill.classList.toggle('is-crit', n > 0);
  pill.classList.toggle('is-ok', n === 0);
}
function uiUpdateNavCounts(){
  const n = uiOpenAlertCount();
  document.querySelectorAll('[data-count="alerts"]').forEach(el => {
    el.textContent = n > 99 ? '99+' : String(n);
    el.classList.toggle('show', n > 0);
  });
}
function uiSystemState(){
  if (typeof profile === 'undefined' || !profile) return ['idle', 'Not signed in'];
  if (navigator.onLine === false) return ['down', offlineQueueCount ? `Offline · ${offlineQueueCount} saved` : 'Offline'];
  if (profile.role === 'guard' && offlineKnownDown()) return ['down', offlineQueueCount ? `No connection · ${offlineQueueCount} saved` : 'No connection'];
  let connected = true;
  try{ if (sb && sb.realtime && typeof sb.realtime.isConnected === 'function') connected = sb.realtime.isConnected(); }catch(e){}
  const ops = profile.role === 'admin' || profile.role === 'controller';
  if (connected && ops && notifChannelStatus !== 'SUBSCRIBED') return ['warn', 'Live feed degraded · polling every 5s'];
  return connected ? ['ok', 'All systems operational'] : ['warn', 'Reconnecting…'];
}
function uiTick(){
  try{
    const now = new Date();
    const clock = `${now.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} <b>${now.toLocaleTimeString([], { hour12: false })}</b>`;
    const gc = document.getElementById('ghClock'); if (gc) gc.innerHTML = clock;
    const oc = document.getElementById('opsClock'); if (oc) oc.innerHTML = clock;

    const [state, text] = uiSystemState();
    const pill = document.getElementById('sysPill');
    if (pill){ pill.dataset.state = state; document.getElementById('sysPillText').textContent = text; }
    offlineRenderBanner();

    const signedIn = typeof profile !== 'undefined' && !!profile;
    const shiftChip = document.getElementById('ghShift');
    if (shiftChip){
      shiftChip.hidden = !signedIn;
      if (signedIn){
        const day = isDayShift(nowMs());
        shiftChip.innerHTML = `${day ? UI_ICONS.sun : UI_ICONS.moon}${day ? 'Day shift' : 'Night shift'}`;
      }
    }
    const alertChip = document.getElementById('ghAlerts');
    if (alertChip){
      const ops = signedIn && (profile.role === 'admin' || profile.role === 'controller');
      alertChip.hidden = !ops;
      if (ops){
        const n = uiOpenAlertCount();
        alertChip.className = 'gh-chip ' + (n > 0 ? 'is-crit' : 'is-ok');
        alertChip.innerHTML = `${n > 0 ? UI_ICONS.alert : UI_ICONS.check}${n > 0 ? `${n} open alert${n === 1 ? '' : 's'}` : 'No open alerts'}`;
      }
    }
  }catch(e){ /* header status is best-effort */ }
}

// ---- Controller live-operations panels ----
function renderLiveFeed(){
  const el = document.getElementById('ctrlLiveFeed');
  if (!el) return;
  const shiftStart = currentShiftStart(nowMs());
  const rows = scans.filter(s => s.timestamp >= shiftStart).slice(-8).reverse();
  el.innerHTML = rows.length ? `<div class="feed-compact">${rows.map(s => {
    const ok = s.result === 'ACCEPTED';
    const skipped = s.result === 'SKIPPED';
    const site = sites.find(x => x.id === s.siteId);
    const time = new Date(s.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    return `
      <div class="feed-row">
        <div class="feed-time">${time}</div>
        <div class="feed-main">
          <span class="feed-title">${escapeHtmlForPrint(s.cpName || 'Unknown checkpoint')}</span>
          <div class="feed-meta">${escapeHtmlForPrint(site ? site.name : 'Unknown site')}</div>
        </div>
        <span class="st ${ok ? 'st-success' : skipped ? 'st-warn' : 'st-crit'}">${uiScanResultLabel(s.result)}</span>
      </div>`;
  }).join('')}</div>` : '<div class="empty">No scans yet this shift.</div>';
}

function computePatrolBoard(){
  const now = nowMs(), shiftStart = currentShiftStart(now);
  const c = { completed: 0, late: 0, missed: 0, live: 0 };
  const next = [];
  schedules.filter(isScheduleLive).forEach(sched => {
    const r = routes.find(x => x.id === sched.routeId);
    if (!r) return;
    generateInstances(sched, shiftStart, now + 3 * 3600 * 1000).forEach(inst => {
      const st = instanceStatus(inst, now).status;
      if (inst.expectedTime > now){ next.push({ inst, r }); return; }
      if (st === 'completed') c.completed++;
      else if (st === 'completed_late') c.late++;
      else if (st === 'missed') c.missed++;
      else c.live++;
    });
  });
  next.sort((a, b) => a.inst.expectedTime - b.inst.expectedTime);
  return { c, next: next.slice(0, 4), now };
}
function renderPatrolBoard(){
  const el = document.getElementById('ctrlPatrolBoard');
  if (!el) return;
  const { c, next, now } = computePatrolBoard();
  const due = c.completed + c.late + c.missed;
  const total = due + c.live;
  if (!total && !next.length){
    el.innerHTML = '<div class="empty">No patrols scheduled this shift.</div>';
    return;
  }
  const pct = due ? Math.round((c.completed / due) * 100) : null;
  const seg = (cls, n) => n ? `<i class="${cls}" style="flex:${n}"></i>` : '';
  const nextHtml = next.length ? `
    <div class="board-next">
      <div class="board-next-title">Coming up</div>
      ${next.map(({ inst, r }) => {
        const site = sites.find(s => s.id === r.siteId);
        const mins = Math.max(1, Math.round((inst.expectedTime - now) / 60000));
        const when = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins} min`;
        return `<div class="next-row">
          <div class="nr-main">${escapeHtmlForPrint(r.name)} <span class="nr-site">${escapeHtmlForPrint(site ? site.name : '')}</span></div>
          <div class="nr-when">${new Date(inst.expectedTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })} · in ${when}</div>
        </div>`;
      }).join('')}
    </div>` : '';
  el.innerHTML = `
    <div class="board-top"><div class="board-pct">${pct === null ? '—' : pct + '%'}<small>on time</small></div></div>
    <div class="board-sub">${due ? `${due} patrol${due === 1 ? '' : 's'} due so far this shift` : 'No patrols have come due yet this shift'}</div>
    <div class="segbar">${seg('seg-ok', c.completed)}${seg('seg-late', c.late)}${seg('seg-miss', c.missed)}${seg('seg-live', c.live)}</div>
    <div class="board-legend">
      <div><i class="seg-ok"></i>Completed<b>${c.completed}</b></div>
      <div><i class="seg-late"></i>Late<b>${c.late}</b></div>
      <div><i class="seg-miss"></i>Missed<b>${c.missed}</b></div>
      <div><i class="seg-live"></i>In progress<b>${c.live}</b></div>
    </div>
    ${nextHtml}`;
}
function uiAfterScans(){
  try{ renderLiveFeed(); renderPatrolBoard(); }catch(e){ console.warn('live ops panels', e); }
}
function uiAfterNotifications(){
  try{ paintKpis(); uiUpdateNavCounts(); uiTick(); renderPatrolBoard(); }catch(e){ console.warn('ops status', e); }
}

// ---- Navigation shell: workspace state, page title, sidebar visibility ----
const UI_PAGE_META = {
  guard:    ['Guard scan', 'Scan checkpoints, clock in and report incidents.'],
  platform: ['Platform', 'Every client company, their subscription and their usage.'],
  admin: {
    siteoverview:  ['Overview', 'Tag-scan and patrol completion across every site for the shift under way.'],
    notifications: ['Notifications', 'Alerts the control room has commented on and cleared in the last 24 hours.'],
    sites:         ['Sites', 'Search your sites and add new ones.'],
    manage:        ['Manage site', 'Checkpoints, routes, staffing and schedules for one site.'],
    overview:      ['Activity log', 'Every scan as it happens, most recent first.'],
    patrols:       ['Patrols', 'Upcoming and past patrols for the active site.'],
    alerts:        ['Alert settings', 'Choose how alerts are routed and escalated.'],
    invites:       ['Admin invites', 'Invite codes for new admins and controllers.'],
    users:         ['Users', 'Everyone in your company and their roles.'],
    attendance:    ['Attendance', 'Live coverage per site and shift, plus attendance exports.'],
    incidents:     ['Incidents', 'Reports filed by guards in the field.'],
    tracking:      ['Live tracking', 'See where a site\'s phone is, live. Search for a site to start.'],
    audit:         ['Audit trail', 'Who did what, and when — permanent and cannot be edited or deleted.'],
    reports:       ['Reports', 'Patrol reports over any date range.']
  },
  controller: {
    dashboard:     ['Dashboard', 'What needs attention right now, and what is happening on the ground.'],
    log:           ['Live activity log', 'Every scan across every site this shift, most recent first.'],
    patrols:       ['Patrols', 'Upcoming and past patrols by site.'],
    incidents:     ['Incidents', 'Read, comment on and review incident reports.'],
    attendance:    ['Attendance', 'Who is clocked in right now, per site and shift.'],
    tracking:      ['Live tracking', 'See where a site\'s phone is, live. Search for a site to start.'],
    siteoverview:  ['Overview', 'Tag-scan and patrol completion across every site for the shift under way.'],
    sites:         ['Sites', 'Read-only site directory with map locations.'],
    team:          ['Team', 'Everyone in the company at a glance.']
  }
};
function uiSyncShell(){
  const activeView = document.querySelector('.view.active');
  const ws = activeView ? activeView.id.replace('view-', '') : 'guard';
  document.body.dataset.view = ws;

  const wsBtns = [...document.querySelectorAll('.nav-ws [data-view]')].filter(b => b.style.display !== 'none');
  const hasContextNav = ws === 'admin' || ws === 'controller';
  document.body.classList.toggle('ws-solo', wsBtns.length <= 1);
  document.body.classList.toggle('no-sidebar', !hasContextNav && wsBtns.length <= 1);

  let meta = UI_PAGE_META[ws];
  if (ws === 'admin' || ws === 'controller'){
    const attr = ws === 'admin' ? 'data-admin-view' : 'data-ctrl-view';
    const btn = document.querySelector(`[${attr}].active`);
    const key = btn ? btn.getAttribute(attr) : null;
    meta = (key && UI_PAGE_META[ws][key]) || [ws === 'admin' ? 'Admin' : 'Controller', ''];
  }
  const t = document.getElementById('pageTitle'), d = document.getElementById('pageDesc');
  if (t && meta){ t.textContent = meta[0]; }
  if (d && meta){ d.textContent = meta[1] || ''; d.style.display = meta[1] ? '' : 'none'; }

  // A panel heading that just repeats the page title is noise — hide it.
  document.querySelectorAll('.dup-title').forEach(h => h.classList.remove('dup-title'));
  const shown = document.querySelector('.admin-view.active, .ctrl-view.active') || activeView;
  const h2 = shown && shown.querySelector('.panel > h2');
  if (h2 && meta && h2.textContent.trim().toLowerCase() === meta[0].toLowerCase()){
    h2.classList.add('dup-title');
  }
}
(function initUiShell(){
  const sidebar = document.getElementById('sidebar');
  if (sidebar){
    new MutationObserver(uiSyncShell).observe(sidebar, { subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
  }
  document.querySelectorAll('.nav-item').forEach(b => b.addEventListener('click', () => setTimeout(uiSyncShell, 0)));
  const viewAll = document.getElementById('opsViewAllLogBtn');
  if (viewAll) viewAll.addEventListener('click', () => {
    const b = document.querySelector('[data-ctrl-view="log"]');
    if (b) b.click();
  });
  window.addEventListener('online', uiTick);
  window.addEventListener('offline', uiTick);
  uiSyncShell();
  uiTick();
  setInterval(uiTick, 1000);
})();

// ---------------- Manage site: one setup step open at a time ----------------
// Opening a step collapses the others, then keeps the opened step's header in view.
(function initManageAccordion(){
  const steps = document.querySelectorAll('#admin-manage details.setup-step');
  steps.forEach(step => {
    step.addEventListener('toggle', () => {
      if (!step.open) return;
      steps.forEach(other => { if (other !== step && other.open) other.open = false; });
      const head = step.querySelector('summary');
      if (head) head.scrollIntoView({ block: 'nearest' });
    });
  });
})();

// ---------------- Boot ----------------
setAuthMode('signin');
initAuth();
