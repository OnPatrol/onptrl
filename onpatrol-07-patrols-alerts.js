// ---------------- Patrol notifications dashboard ----------------
let notifications = [];

function severityColor(sev){
  return sev === 'red' ? 'var(--danger)' : sev === 'orange' ? 'var(--warn)' : 'var(--success)';
}
function timeAgo(iso){
  const ms = nowMs() - new Date(iso).getTime();
  const mins = Math.round(ms/60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.round(mins/60);
  if (hrs < 24) return hrs + 'h ago';
  return new Date(iso).toLocaleDateString();
}

async function loadNotifications(opts){
  if (!profile || (profile.role !== 'admin' && profile.role !== 'controller')){ notifications = []; return; }
  // Active (uncleared) alerts never expire on their own here — they must be resolved.
  // Resolved ones only stay in this working set for 24h; the full history lives in
  // Admin → Reports → Controller Comments, queried separately with its own date range.
  //
  // Three separate queries, because with many sites the routine "patrol completed" rows
  // (green) arrive by the hundred and would otherwise push real alerts out of a single
  // "newest 300" list:
  //   1. everything still needing attention (red/orange, uncleared) — never truncated
  //   2. recently resolved alerts (cleared in the last 24h)
  //   3. completed-patrol notices still on screen (green, uncleared)
  const now = nowMs();
  const cutoff = new Date(now - 24*60*60*1000).toISOString();
  const greenSince = new Date(now - 3*60*60*1000).toISOString();
  const sel = '*, notification_comments(id, body, created_at, author_id, profiles(full_name))';
  const [openQ, resolvedQ, greenQ] = await Promise.all([
    sb.from('patrol_notifications').select(sel).is('cleared_at', null).neq('severity', 'green')
      .order('occurred_at', { ascending: false }).limit(1000),
    sb.from('patrol_notifications').select(sel).gte('cleared_at', cutoff)
      .order('cleared_at', { ascending: false }).limit(200),
    sb.from('patrol_notifications').select(sel).is('cleared_at', null).eq('severity', 'green').gte('occurred_at', greenSince)
      .order('occurred_at', { ascending: false }).limit(500)
  ]);
  const error = openQ.error || resolvedQ.error || greenQ.error;
  if (error){ if (!(opts && opts.quiet)) showToast('Could not load notifications', error.message, 'danger'); return; }
  const byId = new Map();
  [openQ.data, resolvedQ.data, greenQ.data].forEach(list => (list || []).forEach(n => byId.set(n.id, n)));
  notifications = [...byId.values()].sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at));
  announceNewAlerts();
}

// ---- Live delivery: don't depend on the realtime socket alone ----
// Realtime pushes alerts the moment they're written, but a dropped socket, a sleeping
// laptop or a flaky connection can silently stop that. So controllers/admins ALSO poll
// every few seconds (see pollLiveData) — whichever path sees an alert first announces it.
const seenNotifIds = new Set();
let seenNotifsSeeded = false;
function announceNewAlerts(){
  const fresh = notifications.filter(n => !seenNotifIds.has(n.id));
  fresh.forEach(n => seenNotifIds.add(n.id));
  if (!seenNotifsSeeded){ seenNotifsSeeded = true; return; }   // first load = history, not news
  const news = fresh.filter(n => !n.cleared_at && n.severity !== 'green'
    && nowMs() - new Date(n.occurred_at).getTime() < 15 * 60 * 1000);
  news.filter(n => n.kind === 'panic').forEach(n => { SOUND.panic(); showToast('Panic alert', n.title + (sitePhoneOf(n.site_id) ? ' · Site phone ' + cleanPhone(sitePhoneOf(n.site_id)) : ''), 'danger'); });
  const others = news.filter(n => n.kind !== 'panic');
  others.slice(0, 3).forEach(n => showToast(n.severity === 'red' ? 'New critical alert' : 'New warning', n.title, n.severity === 'red' ? 'danger' : 'warn'));
  if (others.length > 3) showToast(`${others.length - 3} more new alerts`, 'See Attention required on the dashboard.', 'warn');
}
function notifSignature(){
  return notifications.map(n => `${n.id}:${n.cleared_at || ''}:${(n.notification_comments || []).length}`).join('|');
}
async function pollNewScans(){
  // Incremental: only scans written in the last couple of minutes, merged by id.
  const since = new Date(nowMs() - 2 * 60 * 1000).toISOString();
  const { data, error } = await sb.from('scans').select('*').gte('created_at', since).order('created_at', { ascending: true }).limit(500);
  if (error || !data) return false;
  let added = false;
  data.forEach(row => {
    if (!scans.some(x => x.id === row.id)){ scans.push(rowToScan(row)); added = true; }
  });
  if (added){
    scans.sort((a, b) => a.timestamp - b.timestamp);
    renderStats(); renderLog(); renderPatrolsAdmin();
  }
  return added;
}
async function pollLiveData(){
  if (livePolling || !profile || (profile.role !== 'admin' && profile.role !== 'controller')) return;
  if (navigator.onLine === false) return;
  livePolling = true;
  try{
    await sweepPatrolInstanceNotifications();          // raises missed / late / completed alerts as soon as they fall due
    const before = notifSignature();
    await loadNotifications({ quiet: true });          // picks up anything the realtime socket didn't deliver
    if (notifSignature() !== before) renderNotifications();
    await pollNewScans();
  }catch(e){ console.warn('live poll', e); }
  finally{ livePolling = false; }
}

// Green "patrol completed" notices and orange "tag skipped" notices clear themselves after an hour.
function isAutoClearing(n){ return n.severity === 'green' || n.kind === 'tag_skipped'; }
function isGreenExpired(n){
  return isAutoClearing(n) && (nowMs() - new Date(n.occurred_at).getTime()) > 60*60*1000;
}

// Combines the site name with the notification's specific reason so an alert reads
// as e.g. "Head Office · 20:30 patrol · Guard 20m from checkpoint" instead of just
// a bare title — the site alone was crowding out the actual reason before.
function notifContextLine(n, site){
  const parts = [];
  if (site) parts.push(escapeHtmlForPrint(site.name));
  const rawDetail = (n.detail || '').trim();
  if (n.kind === 'radius_alert'){
    // Position alerts specifically promise a distance/reason — never let one
    // through showing just the site name again with nothing else, whether
    // that's from stale data or a future write that forgot to fill it in.
    const siteName = site ? site.name : '';
    const isUninformative = !rawDetail || rawDetail === '—' || rawDetail.toLowerCase() === siteName.toLowerCase();
    parts.push(isUninformative ? 'No distance recorded for this alert' : escapeHtmlForPrint(rawDetail));
  } else if (n.kind === 'panic'){
    // The detail text is either "Location: <url>" or an explicit "not
    // available" note (set server-side in trigger_panic) - turn the URL
    // into a real tappable link instead of leaving it as plain text.
    const m = rawDetail.match(/^Location:\s*(https?:\/\/\S+)/);
    parts.push(site && site.phone ? `Site phone: ${phoneLinkHtml(site.phone)}` : '<span style="color:var(--warn);">Site phone not set</span>');
    parts.push(m ? `<a href="${m[1]}" target="_blank" rel="noopener" style="color:inherit; text-decoration:underline;">Open guard's location in Maps</a>` : escapeHtmlForPrint(rawDetail || 'Location was not available.'));
  } else if (rawDetail){
    parts.push(escapeHtmlForPrint(rawDetail));
  }
  return parts.join(' · ');
}

let notifFilters = { admin: { site: '', kind: '' }, ctrl: { site: '', kind: '' } };

function populateFilterSiteSelect(id, currentVal){
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = '<option value="">All sites</option>' + sites.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
  el.value = currentVal || '';
}

function renderNotificationsInto(activeId, resolvedId, filterKey){
  const activeEl = document.getElementById(activeId);
  const resolvedEl = document.getElementById(resolvedId);
  if (!activeEl && !resolvedEl) return;
  const filters = (filterKey && notifFilters[filterKey]) || { site: '', kind: '' };

  // Active alerts are scoped to the shift under way, same as the counter tiles in
  // renderControllerStats() and the feed in renderLog() — an unresolved alert from
  // a shift that's already ended shouldn't keep showing up as "active" here; it
  // still exists in the DB (and in admin → reports) for follow-up, it just isn't
  // surfaced as a live alert for the current shift anymore.
  const shiftStart = currentShiftStart(nowMs());
  let active = notifications.filter(n => !n.cleared_at && !isGreenExpired(n) && new Date(n.occurred_at).getTime() >= shiftStart);
  let resolved = notifications.filter(n => n.cleared_at || isGreenExpired(n));

  if (filters.site){ active = active.filter(n => n.site_id === filters.site); resolved = resolved.filter(n => n.site_id === filters.site); }
  if (filters.kind){ active = active.filter(n => n.kind === filters.kind); resolved = resolved.filter(n => n.kind === filters.kind); }

  // Sort/slice happens after filtering, so a filtered view still shows up to
  // 20 matching items instead of the 20 most recent unfiltered ones.
  resolved = resolved
    .sort((a,b) => new Date(b.cleared_at || b.occurred_at) - new Date(a.cleared_at || a.occurred_at))
    .slice(0, 20);

  if (activeEl){
    // Most urgent first: panic, then critical, warning, and completed patrols last.
    const rank = n => n.kind === 'panic' ? 0 : n.severity === 'red' ? 1 : n.severity === 'orange' ? 2 : 3;
    active.sort((a, b) => rank(a) - rank(b) || new Date(b.occurred_at) - new Date(a.occurred_at));
    // On the controller dashboard, routine "patrol completed" notices collapse into one
    // line (with 70 sites they'd bury the alerts). Pick "Successful patrol" in the type
    // filter to see them individually.
    let greenCount = 0;
    if (activeId === 'ctrlNotifActive' && filters.kind !== 'success_patrol'){
      greenCount = active.filter(n => n.severity === 'green').length;
      active = active.filter(n => n.severity !== 'green');
    }
    if (activeId === 'ctrlNotifActive') uiSetAttentionCount(active);
    const greenNote = greenCount
      ? `<div class="alert-foot" style="border-top:0; padding-top:4px;">${greenCount} patrol${greenCount === 1 ? '' : 's'} completed on time in the last hour</div>`
      : '';
    activeEl.innerHTML = (active.length
      ? active.map(n => uiAlertCard(n, sites.find(s => s.id === n.site_id))).join('')
      : ((filters.site || filters.kind)
          ? '<div class="empty">No alerts match this filter.</div>'
          : '<div class="empty is-clear"><div><strong>All clear</strong>No open alerts. Every site is operating normally.</div></div>')) + greenNote;

    activeEl.querySelectorAll('[data-notif-submit]').forEach(btn => {
      btn.addEventListener('click', () => submitNotificationComment(btn.dataset.notifSubmit, activeEl));
    });
  }

  if (resolvedEl){
    resolvedEl.innerHTML = resolved.length
      ? resolved.map(n => uiResolvedRow(n, sites.find(s => s.id === n.site_id))).join('')
      : `<div class="empty">${(filters.site || filters.kind) ? 'No resolved alerts match this filter.' : 'Nothing resolved yet.'}</div>`;
  }
}

async function submitNotificationComment(notifId, containerEl){
  const input = containerEl.querySelector(`[data-notif-comment="${notifId}"]`);
  const body = input.value.trim();
  if (!body) return;
  const btn = containerEl.querySelector(`[data-notif-submit="${notifId}"]`);
  btn.disabled = true;
  const { error: cErr } = await sb.from('notification_comments').insert({ notification_id: notifId, author_id: session.user.id, body });
  if (cErr){ showToast('Could not post comment', cErr.message, 'danger'); btn.disabled = false; return; }
  const { error: uErr } = await sb.from('patrol_notifications').update({ cleared_at: new Date().toISOString(), cleared_by: session.user.id }).eq('id', notifId);
  if (uErr){ showToast('Comment posted, but could not clear the alert', uErr.message, 'warn'); }
  else showToast('Resolved', 'Cleared and visible to the admin.', 'success');
  await loadNotifications();
  renderNotifications();
}

function renderNotifications(){
  // A re-render rebuilds the alert cards, so hold on to any comment a controller is
  // part-way through typing (and where their cursor was) and put it straight back.
  const saved = {}; let focusId = null, caret = null;
  document.querySelectorAll('[data-notif-comment]').forEach(i => {
    if (i.value) saved[i.dataset.notifComment] = i.value;
    if (document.activeElement === i){ focusId = i.dataset.notifComment; caret = i.selectionStart; }
  });
  renderNotificationsCore();
  document.querySelectorAll('[data-notif-comment]').forEach(i => {
    const v = saved[i.dataset.notifComment];
    if (v !== undefined) i.value = v;
    if (focusId && i.dataset.notifComment === focusId){ i.focus(); try{ i.setSelectionRange(caret, caret); }catch(e){} }
  });
}
function renderNotificationsCore(){
  populateFilterSiteSelect('adminNotifSiteFilter', notifFilters.admin.site);
  populateFilterSiteSelect('ctrlNotifSiteFilter', notifFilters.ctrl.site);
  renderNotificationsInto(null, 'adminNotifResolved', 'admin');
  renderNotificationsInto('ctrlNotifActive', null, 'ctrl');
  renderControllerStats();
  uiAfterNotifications();
}

['admin','ctrl'].forEach(key => {
  const siteEl = document.getElementById(key + 'NotifSiteFilter');
  const kindEl = document.getElementById(key + 'NotifKindFilter');
  if (siteEl) siteEl.addEventListener('change', () => { notifFilters[key].site = siteEl.value; renderNotifications(); });
  if (kindEl) kindEl.addEventListener('change', () => { notifFilters[key].kind = kindEl.value; renderNotifications(); });
});

// Detect newly-resolved whole-patrol instances (missed / late / on-time) and record them.
// Best-effort: runs whenever an admin or controller session is open.
async function sweepPatrolInstanceNotifications(){
  if (!profile || (profile.role !== 'admin' && profile.role !== 'controller')) return;
  const now = nowMs();
  const windowStart = now - 6*60*60*1000;
  const rows = [];
  schedules.filter(isScheduleLive).forEach(sched => {
    const insts = generateInstances(sched, windowStart, now);
    insts.forEach(inst => {
      const st = instanceStatus(inst, now).status;
      const r = routes.find(rt => rt.id === inst.routeId);
      if (!r) return;
      const time = fmtClock(inst.expectedTime);
      if (st === 'missed'){
        rows.push({ site_id: r.siteId, route_id: r.id, kind: 'missed_patrol', severity: 'red', title: `${r.name} patrol missed`, detail: `${time} patrol · No checkpoint scans were logged in the patrol window.`, occurred_at: new Date(inst.expectedTime).toISOString(), auto_clear: false });
      } else if (st === 'completed_late'){
        rows.push({ site_id: r.siteId, route_id: r.id, kind: 'late_patrol', severity: 'red', title: `${r.name} patrol finished late`, detail: `${time} patrol · Checkpoints were completed after the expected window.`, occurred_at: new Date(inst.expectedTime).toISOString(), auto_clear: false });
      } else if (st === 'completed'){
        rows.push({ site_id: r.siteId, route_id: r.id, kind: 'success_patrol', severity: 'green', title: `${r.name} patrol completed on time`, detail: `${time} patrol · All checkpoints completed on time.`, occurred_at: new Date(inst.expectedTime).toISOString(), auto_clear: true });
      }
    });
  });
  const have = new Set(notifications.map(n => `${n.kind}|${n.route_id}|${new Date(n.occurred_at).getTime()}`));
  const fresh = rows.filter(r => !have.has(`${r.kind}|${r.route_id}|${new Date(r.occurred_at).getTime()}`));
  if (!fresh.length) return;
  const { error } = await sb.from('patrol_notifications').upsert(fresh, { onConflict: 'kind,route_id,occurred_at', ignoreDuplicates: true });
  if (!error){
    await loadNotifications();
    renderNotifications();
  }
}

// Actually clear (not just hide) green successes once they've been visible for an hour.
async function sweepAutoClearGreens(){
  if (!profile || (profile.role !== 'admin' && profile.role !== 'controller')) return;
  const stale = notifications.filter(n => isAutoClearing(n) && !n.cleared_at && isGreenExpired(n));
  if (!stale.length) return;
  const { error } = await sb.from('patrol_notifications')
    .update({ cleared_at: new Date().toISOString() })
    .in('id', stale.map(n => n.id));
  if (!error) await loadNotifications();
}

// ---------------- Patrols admin rendering ----------------
function renderSchedRouteSelect(){
  const sel = document.getElementById('newSchedRoute');
  const scoped = routes.filter(r => r.siteId === activeSiteId);
  sel.innerHTML = scoped.map(r => `<option value="${r.id}">${r.name}</option>`).join('')
    || '<option value="">No routes at this site — add one under Routes</option>';
}

function renderSchedTable(){
  const body = document.getElementById('schedTableBody');
  const scoped = schedules.filter(s => {
    const r = routes.find(r => r.id === s.routeId);
    return r && r.siteId === activeSiteId;
  });
  if (scoped.length === 0){
    body.innerHTML = '<tr><td colspan="6" style="font-family:var(--sans); color:var(--muted);">No schedules at this site yet.</td></tr>';
    return;
  }
  body.innerHTML = scoped.map(s => {
    const r = routes.find(r => r.id === s.routeId);
    return `
      <tr${s.active === false ? ' style="opacity:0.55;"' : ''}>
        <td style="font-family:var(--sans);">${r ? r.name : '—'}${s.active === false ? ' <span class="result-meta">(off)</span>' : ''}</td>
        <td>every ${s.intervalMinutes}m</td>
        <td>${s.shiftStart}–${s.shiftEnd}</td>
        <td>${s.durationMinutes}m</td>
        <td>${s.graceMinutes}m</td>
        <td>
          <label class="switch" title="${s.active === false ? 'Schedule is off — no patrols expected' : 'Schedule is on'}">
            <input type="checkbox" class="sched-active-toggle" data-sched-active="${s.id}" ${s.active !== false ? 'checked' : ''}>
            <span class="slider-tog"></span>
          </label>
        </td>
        <td><button class="del-btn" data-del-sched="${s.id}" aria-label="Delete schedule"><i>&times;</i></button></td>
      </tr>
    `;
  }).join('');
  body.querySelectorAll('.sched-active-toggle').forEach(tog => tog.addEventListener('change', async e => {
    const s = schedules.find(sc => sc.id === e.target.dataset.schedActive);
    if (!s) return;
    const prev = s.active;
    s.active = e.target.checked;
    const { error } = await sb.from('schedules').update({ active: e.target.checked }).eq('id', s.id);
    if (error){
      s.active = prev; e.target.checked = prev;
      showToast('Could not update schedule', error.message, 'danger');
      return;
    }
    showToast('Schedule updated', e.target.checked ? 'This patrol schedule is on again.' : 'This patrol schedule is off — no patrols expected until turned back on.', 'success');
    renderSchedTable();
    renderAll();
  }));
  body.querySelectorAll('[data-del-sched]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this schedule? Guards will no longer be prompted to run this patrol. This can\'t be undone.')) return;
      const { error } = await sb.from('schedules').delete().eq('id', btn.dataset.delSched);
      if (error){ showToast('Could not delete schedule', error.message, 'danger'); return; }
      showToast('Schedule deleted', '', 'success');
      await loadSchedules();
      renderAll();
    });
  });
}

function allInstancesForSite(winStart, winEnd){
  const scoped = schedules.filter(s => {
    const r = routes.find(r => r.id === s.routeId);
    return r && r.siteId === activeSiteId && isScheduleLive(s);
  });
  let out = [];
  scoped.forEach(s => out = out.concat(generateInstances(s, winStart, winEnd)));
  out.sort((a,b) => a.expectedTime - b.expectedTime);
  return out;
}

// ---------------- Patrol detail modal ----------------
let pastInstanceLookup = {};

function openPatrolDetail(instId){
  const inst = pastInstanceLookup[instId];
  if (!inst) return;
  const r = routes.find(rt => rt.id === inst.routeId);
  const st = instanceStatus(inst, nowMs());
  const winStart = inst.expectedTime - 5*60000;
  const winEnd = st.windowEnd;
  const attempts = scans
    .filter(s => st.cpIds.includes(s.qrId) && s.timestamp >= winStart && s.timestamp < winEnd)
    .sort((a,b) => a.timestamp - b.timestamp);

  document.getElementById('patrolDetailTitle').textContent =
    `${r ? r.name : '—'} · ${new Date(inst.expectedTime).toLocaleString([], {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', hour12: false})}`;
  document.getElementById('patrolDetailSub').innerHTML =
    `<span class="status-pill ${st.status}">${statusLabel(st.status)}</span>
     <span class="result-meta">${st.doneCps.length}/${st.totalCps} checkpoints · ${r && r.strictOrder ? 'strict order' : 'flexible order'} · ${inst.durationMinutes}m duration + ${inst.graceMinutes}m grace, concludes ${new Date(st.concludeAt).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', hour12: false})}</span>`;

  const sequenceHtml = st.cpIds.map((id, i) => {
    const done = st.doneCps.includes(id);
    const skipped = st.skippedCps.includes(id);
    return `<span class="cp-dot ${skipped ? 'skipped' : done ? 'done' : ''}">${i+1}. ${id}${skipped ? ' — skipped' : done ? ' ✓' : ''}</span>`;
  }).join('');

  const attemptsHtml = attempts.length ? attempts.map(s => {
    const ok = s.result === 'ACCEPTED';
    const skipped = s.result === 'SKIPPED';
    const lateFlag = ok && s.isLate
      ? ' <span style="color:var(--warn); font-family:var(--sans); font-size:10px;">(late)</span>' : '';
    const detailBits = [];
    if (s.distance != null) detailBits.push(`${s.distance.toFixed(0)}m from point`);
    if (skipped) detailBits.push(escapeHtmlForPrint(skipReasonLabel(s.skipReason)));
    if (s.result === 'REJECTED_OUT_OF_ORDER' && s.expectedQrId) detailBits.push(`expected ${escapeHtmlForPrint(s.expectedQrId)} next`);
    return `
      <tr>
        <td>${new Date(s.timestamp).toLocaleTimeString([], { hour12: false })}</td>
        <td style="font-family:var(--sans);">${escapeHtmlForPrint(s.qrId)} — ${escapeHtmlForPrint(s.cpName || 'unknown')}</td>
        <td><span class="badge ${skipped ? 'skipped' : ok ? 'accepted' : 'rejected'}">${s.result.replace('REJECTED_','').replace(/_/g,' ')}</span>${lateFlag}</td>
        <td class="progress-mini">${detailBits.join(' · ') || '—'}</td>
      </tr>
    `;
  }).join('') : '<tr><td colspan="4" style="font-family:var(--sans); color:var(--muted);">No scan attempts recorded in this patrol\'s window — the checkpoints were never scanned at all.</td></tr>';

  document.getElementById('patrolDetailBody').innerHTML = `
    <div class="field-label" style="margin-top:0;">Expected sequence</div>
    <div class="cp-progress" style="margin-bottom:14px;">${sequenceHtml}</div>
    <div class="field-label">Scan attempts</div>
    <div class="table-scroll">
      <table>
        <thead><tr><th>Time</th><th>Checkpoint</th><th>Result</th><th>Detail</th></tr></thead>
        <tbody>${attemptsHtml}</tbody>
      </table>
    </div>
  `;

  document.getElementById('patrolDetailModalBg').classList.add('show');
}

function renderPatrolLists(upWrapId, pastBodyId){
  const now = nowMs();
  const dayMs = 24*60*60*1000;

  const upcoming = allInstancesForSite(now, now + dayMs)
    .filter(inst => ['upcoming','due_soon','active','grace'].includes(instanceStatus(inst, now).status))
    .slice(0, 20);
  const upWrap = document.getElementById(upWrapId);
  if (upWrap){
    upWrap.innerHTML = upcoming.length ? upcoming.map(inst => {
      const r = routes.find(r => r.id === inst.routeId);
      const st = instanceStatus(inst, now);
      return `
        <div class="log-entry">
          <div class="log-bar st-${st.status}"></div>
          <div class="log-main">
            <div class="log-top">
              <span>${r ? r.name : '—'} · ${new Date(inst.expectedTime).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit', hour12: false})}</span>
              <span class="status-pill ${st.status}">${statusLabel(st.status)}</span>
            </div>
            <div class="log-sub">${fmtCountdown(inst.expectedTime - now)} · ${st.doneCps.length}/${st.totalCps} checkpoints</div>
          </div>
        </div>
      `;
    }).join('') : '<div class="empty">No upcoming patrols scheduled.</div>';
  }

  const past = allInstancesForSite(now - dayMs, now)
    .filter(inst => ['completed','completed_late','missed'].includes(instanceStatus(inst, now).status))
    .sort((a,b) => b.expectedTime - a.expectedTime)
    .slice(0, 30);
  const pastBody = document.getElementById(pastBodyId);
  if (pastBody){
    past.forEach(inst => { pastInstanceLookup[inst.id] = inst; });
    pastBody.innerHTML = past.length ? past.map(inst => {
      const r = routes.find(r => r.id === inst.routeId);
      const st = instanceStatus(inst, now);
      return `
        <tr data-patrol-detail="${inst.id}">
          <td>${fmtTs(inst.expectedTime)}</td>
          <td style="font-family:var(--sans);">${r ? r.name : '—'}</td>
          <td class="progress-mini">${st.doneCps.length}/${st.totalCps}</td>
          <td><span class="status-pill ${st.status}">${statusLabel(st.status)}</span></td>
        </tr>
      `;
    }).join('') : '<tr><td colspan="4" style="font-family:var(--sans); color:var(--muted);">No past patrols in the last 24h yet.</td></tr>';
    pastBody.querySelectorAll('[data-patrol-detail]').forEach(row => {
      row.addEventListener('click', () => openPatrolDetail(row.dataset.patrolDetail));
    });
  }
}

function renderPatrolsAdmin(){
  if (!activeSiteId) return;
  renderSchedRouteSelect();
  renderSchedTable();
  pastInstanceLookup = {};
  renderPatrolLists('upcomingWrap', 'pastPatrolsBody');
  renderPatrolLists('ctrlUpcomingWrap', 'ctrlPastPatrolsBody');
}

// ---------------- Duty-route patrol notifications ----------------
let notifiedFiveMin = new Set(), notifiedStart = new Set(), notifiedLate = new Set(), notifiedMissed = new Set();

function currentDutyRouteNextInstance(){
  const dutySiteId = activeDutySiteId || guardSiteId;
  if (!dutySiteId) return null;
  const siteRouteIds = new Set(routes.filter(r => r.siteId === dutySiteId).map(r => r.id));
  const siteScheds = schedules.filter(s => siteRouteIds.has(s.routeId) && isScheduleLive(s));
  if (!siteScheds.length) return null;

  const now = nowMs();
  const dayMs = 24*60*60*1000;
  let allInsts = [];
  siteScheds.forEach(sched => { allInsts = allInsts.concat(generateInstances(sched, now - dayMs, now + dayMs)); });

  // Prefer whatever's happening right now (active/due soon/in grace), earliest first.
  const inProgress = allInsts
    .filter(i => ['due_soon','active','grace'].includes(instanceStatus(i, now).status))
    .sort((a,b) => a.expectedTime - b.expectedTime);
  if (inProgress[0]) return { inst: inProgress[0] };

  // Otherwise the soonest upcoming one.
  const upcoming = allInsts
    .filter(i => instanceStatus(i, now).status === 'upcoming')
    .sort((a,b) => a.expectedTime - b.expectedTime);
  if (upcoming[0]) return { inst: upcoming[0] };

  return null;
}

function renderGuardPatrolCard(){
  const card = document.getElementById('guardPatrolCard');
  if (!card) return;

  ensurePatrolAssignment(); // fire-and-forget — shows the modal itself if a round needs an answer

  const gate = guardPatrolGate();
  const scanBtn = document.getElementById('manualScanBtn');
  const camBtn = document.getElementById('camToggleBtn');
  const clockedIn = !!myAttendance;
  if (scanBtn) scanBtn.disabled = !clockedIn || !gate.inProgress;
  const skipBtn = document.getElementById('skipTagBtn');
  if (skipBtn) skipBtn.disabled = !clockedIn || !gate.inProgress;
  if (camBtn) camBtn.disabled = !clockedIn;

  // Green in-camera hint: only while there's an active round with nothing scanned
  // on it yet — gone for good the moment the first tag lands, back for the next round.
  const camInstructionEl = document.getElementById('camInstruction');
  if (camInstructionEl){
    const showInstruction = clockedIn && gate.inProgress && !hasScannedThisPatrol(gate.dutyInfo ? gate.dutyInfo.inst : null);
    camInstructionEl.style.display = showInstruction ? 'block' : 'none';
  }

  const found = gate.dutyInfo;
  if (!found){ card.style.display = 'none'; return; }
  const { inst } = found;
  const now = nowMs();
  const st = instanceStatus(inst, now);
  const r = routes.find(r => r.id === inst.routeId);
  card.style.display = 'block';
  document.getElementById('guardPatrolRouteName').textContent = r ? r.name : '—';
  const statusEl = document.getElementById('guardPatrolStatus');
  statusEl.className = 'status-pill ' + st.status;
  statusEl.textContent = statusLabel(st.status);

  const countdownEl = document.getElementById('guardPatrolCountdown');
  const diff = inst.expectedTime - now;
  countdownEl.textContent = diff > 0
    ? `Next patrol ${fmtCountdown(diff)} (${new Date(inst.expectedTime).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit', hour12: false})})`
    : `Started ${fmtCountdown(diff)} ago`;
  countdownEl.className = 'patrol-countdown ' + (st.status === 'missed' ? 'danger' : st.status === 'grace' ? 'warn' : st.status === 'due_soon' ? 'warn' : st.status === 'active' ? 'ok' : '');

  const cpsEl = document.getElementById('guardPatrolCps');
  cpsEl.innerHTML = st.cpIds.map(id => {
    const cp = checkpoints.find(c => c.qrId === id);
    const label = cp ? cp.name : id;
    const skipped = st.skippedCps.includes(id);
    return `<span class="cp-dot ${skipped ? 'skipped' : st.doneCps.includes(id) ? 'done' : ''}">${label}${skipped ? ' — skipped' : st.doneCps.includes(id) ? ' ✓' : ''}</span>`;
  }).join('');
}

function checkGuardNotifications(){
  // Patrol countdown/start/late sounds are a guard-only cue — controllers and admins
  // get their alerts through the notifications panel, not audio (until the panic
  // button ships), so bail out immediately for any other role.
  if (!profile || profile.role !== 'guard') return;
  const found = currentDutyRouteNextInstance();
  if (!found) return;
  const { inst } = found;
  const now = nowMs();
  const st = instanceStatus(inst, now);

  if (now >= inst.expectedTime - 5*60000 && now < inst.expectedTime && !notifiedFiveMin.has(inst.id)){
    notifiedFiveMin.add(inst.id);
    SOUND.fiveMinWarning();
    showToast('Patrol in 5 minutes', new Date(inst.expectedTime).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit', hour12: false}), 'warn');
  }
  if (now >= inst.expectedTime && !notifiedStart.has(inst.id)){
    notifiedStart.add(inst.id);
    SOUND.patrolStart();
    showToast('Patrol time — begin your round', '', 'success');
  }
  const durationEnd = inst.expectedTime + inst.durationMinutes*60000;
  const concludeAt = durationEnd + inst.graceMinutes*60000;
  if (now >= durationEnd && st.doneCps.length < st.totalCps && !notifiedLate.has(inst.id)){
    notifiedLate.add(inst.id);
    SOUND.lateReminder();
    showToast('Patrol running long', `${st.doneCps.length}/${st.totalCps} checkpoints scanned — ${inst.graceMinutes}m grace period left before this round is concluded`, 'warn');
  }
  if (now >= concludeAt && st.doneCps.length < st.totalCps && !notifiedMissed.has(inst.id)){
    notifiedMissed.add(inst.id);
    SOUND.lateReminder();
    showToast('Patrol concluded — missed', `${st.doneCps.length}/${st.totalCps} checkpoints scanned. Any further tags for this round will be logged as late.`, 'danger');
  }
}

function renderAlertsForm(){
  const d = document.getElementById('notifyDashboard');
  if (!d) return;
  d.checked = alertSettings.dashboard;
  document.getElementById('notifySms').checked = alertSettings.sms;
  document.getElementById('notifyEmail').checked = alertSettings.email;
  document.getElementById('escalationThreshold').value = alertSettings.escalation;
}

function renderAll(){
  renderSiteSwitchers();
  renderSiteTable();
  renderControllerSiteTable();
  renderGuardSiteName();
  renderAttendanceCard();
  renderTeammatesCard();
  renderPanicActingAsSelector();
  renderManageSiteBasicInfo();
  renderCpTable();
  renderStats();
  renderLog();
  renderRouteBuilder();
  renderRouteTable();
  renderSiteShiftsTable();
  renderPatrolsAdmin();
  renderGuardPatrolCard();
  renderAlertsForm();
  renderReportSiteSelect();
  defaultReportDates();
  renderNotifications();
  renderUsersTable();
}

// ---------------- Scan processing ----------------
// Reads the guard's live GPS position. Returns null (rather than throwing) when
// location can't be obtained, so callers can surface a clear rejection reason.
function getGuardPosition(){
  return new Promise(resolve => {
    if (!navigator.geolocation){ resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 3000 }
    );
  });
}

// Whether the guard currently has a patrol actually under way (not just upcoming/due-soon),
// and the duty-route context that goes with it. Shared by the scan gate and the UI banner
// so both agree on the same definition of "in progress".
function guardPatrolGate(){
  const dutyInfo = currentDutyRouteNextInstance();
  const dutyRoute = dutyInfo ? routes.find(r => r.id === dutyInfo.inst.routeId) : null;
  const instSt = dutyInfo ? instanceStatus(dutyInfo.inst, nowMs()) : null;
  const rawInProgress = !!(instSt && instSt.scannable);
  // On a multi-guard site, nothing is scannable for this round until "who's
  // on patrol" has been answered - see ensurePatrolAssignment().
  const needsAssignment = rawInProgress && !patrolAssignmentsCache[dutyInfo.inst.id] &&
    onDutyGuardsAtSite(activeDutySiteId || guardSiteId).length >= 2;
  const inProgress = rawInProgress && !needsAssignment;
  return { dutyInfo, dutyRoute, instSt, inProgress, needsAssignment };
}

// Whether at least one tag has already been scanned for this specific round —
// drives the in-camera green hint (it's shown until the first tag, then gone
// until the next round starts). Local-only rejections (no patrol, already
// scanned, etc.) never reach `scans` at all, so this only counts real attempts.
function hasScannedThisPatrol(inst){
  if (!inst) return false;
  const dutySiteId = activeDutySiteId || guardSiteId;
  return scans.some(s => s.siteId === dutySiteId && s.timestamp >= inst.expectedTime);
}

async function processScan(qrId){
  const dutySiteId = activeDutySiteId || guardSiteId;
  // Only checkpoints belonging to the site the guard is actually clocked in at
  // count as "known" tags — this is what makes the app behave as a site app now:
  // a reliever clocked in at a different site scans against THAT site's tags.
  const cp = checkpoints.find(c => c.qrId === qrId && c.siteId === dutySiteId);
  // A tag that's real but belongs to a different site — reported distinctly from "unknown".
  const cpElsewhere = !cp ? checkpoints.find(c => c.qrId === qrId) : null;

  // Hard gate: scanning is disabled entirely until the guard has clocked in for a
  // shift. Rejected locally — no DB write, so it never reaches the activity feed.
  if (!myAttendance){
    return { qrId, cpName: cp ? cp.name : null, distance: null, result: 'REJECTED_NOT_CLOCKED_IN', siteId: cp ? cp.siteId : dutySiteId, expectedQrId: null, timestamp: Date.now(), localOnly: true };
  }

  const { dutyInfo, dutyRoute, instSt, inProgress } = guardPatrolGate();

  // Hard gate: nothing is accepted or even evaluated unless a patrol is actually in
  // progress. Rejected entirely locally — no DB write, so no activity reaches the
  // controller or admin feeds.
  if (!inProgress){
    return { qrId, cpName: cp ? cp.name : null, distance: null, result: 'REJECTED_NO_PATROL', siteId: cp ? cp.siteId : dutySiteId, expectedQrId: null, timestamp: Date.now(), localOnly: true };
  }

  // Duration is the real patrol window — a tag scanned within it is on time. One
  // scanned during the grace period that follows is still accepted (the guard may
  // have been delayed by something and is catching up), but it's logged as late.
  const isLate = Date.now() >= instSt.durationEnd;
  // Already checked in on this tag for the current patrol — reject locally without
  // touching the DB, so re-scanning a completed checkpoint never creates a new activity.
  const alreadyScanned = !!(cp && dutyRoute && dutyRoute.cpIds.includes(qrId) && instSt.doneCps.includes(qrId) && !instSt.skippedCps.includes(qrId));
  if (alreadyScanned){
    return { qrId, cpName: cp.name, distance: null, result: 'REJECTED_ALREADY_SCANNED', siteId: cp.siteId, expectedQrId: null, timestamp: Date.now(), localOnly: true };
  }

  let result, distance = null, expectedQrId = null;
  const pos = cp ? await getGuardPosition() : null;
  if (cp && pos) distance = distMeters(pos.lat, pos.lng, cp.lat, cp.lng);

  if (!cp){
    result = cpElsewhere ? 'REJECTED_WRONG_SITE' : 'REJECTED_UNKNOWN_QR';
  } else if (!pos){
    result = 'REJECTED_NO_LOCATION';
  } else if (distance > cp.radius){
    result = 'REJECTED_OUT_OF_RANGE';
  } else if (dutyRoute && dutyRoute.strictOrder && dutyRoute.cpIds.includes(qrId) && !instSt.skippedCps.includes(qrId)){
    expectedQrId = nextExpectedCheckpoint(dutyInfo.inst);
    result = (expectedQrId && expectedQrId !== qrId) ? 'REJECTED_OUT_OF_ORDER' : 'ACCEPTED';
  } else {
    result = 'ACCEPTED';
  }

  const siteId = cp ? cp.siteId : dutySiteId;

  // Attribute this scan to whoever was locked in as "on patrol" for this exact
  // round (if the site has more than one guard and an answer was given) rather
  // than blindly to the logged-in session — that's the one who's actually
  // walking it on a shared device.
  const lockedAssignment = dutyInfo ? patrolAssignmentsCache[dutyInfo.inst.id] : null;
  const actingGuardId = lockedAssignment ? lockedAssignment.guardId : session.user.id;
  const actingAttendance = actingGuardId === session.user.id
    ? myAttendance
    : attendance.find(a => a.guardId === actingGuardId && a.status === 'on_duty' && a.siteId === dutySiteId) || myAttendance;

  const insertPayload = {
    id: offlineNewId(),   // created on the phone so a retry can never save the same scan twice
    site_id: siteId,
    checkpoint_id: cp ? cp.id : null,
    raw_qr_id: qrId,
    route_id: dutyInfo ? dutyInfo.inst.routeId : null,
    guard_id: actingGuardId,
    attendance_id: actingAttendance.id,
    result,
    distance_m: distance,
    is_mock: false,
    is_late: result === 'ACCEPTED' && isLate,
    expected_qr_id: result === 'REJECTED_OUT_OF_ORDER' ? expectedQrId : null
  };

  let row = null, error = null;
  if (OFFLINE_ENABLED && navigator.onLine === false){
    error = { name: 'AbortError', message: 'offline' };
  } else {
    const r = await withTimeout(sb.from('scans').insert(insertPayload).select().single(), offlineKnownDown() ? 4000 : OFFLINE_SERVER_TIMEOUT_MS);
    row = r.data; error = r.error;
    if (!error) offlineMarkServerUp();
  }
  if (error && OFFLINE_ENABLED && isNetworkFailure(error)){
    // No connection: keep the scan on this phone with the time it really happened; it is sent as soon as signal returns.
    offlineMarkServerDown();
    row = Object.assign({}, insertPayload, { created_at: new Date().toISOString() });
    await offlineEnqueue('scan', { row });
    showToast('Saved on this phone', 'No connection — this scan will send automatically.', 'warn');
    error = null;
  }
  if (error){
    showToast('Scan could not be saved', error.message, 'danger');
    return { qrId, cpName: cp ? cp.name : null, distance, result, siteId, expectedQrId, timestamp: Date.now(), saveFailed: true };
  }

  // Flag location-related rejections to the controller/admin alert feed, with the
  // specific reason spelled out (site, scheduled patrol time, and distance/cause) —
  // best-effort and never blocks the scan itself if it fails to save.
  if (result === 'REJECTED_OUT_OF_RANGE' || result === 'REJECTED_NO_LOCATION'){
    const patrolTime = fmtClock(dutyInfo.inst.expectedTime);
    const scanTime = fmtClock(Date.now());
    const baseDetail = result === 'REJECTED_OUT_OF_RANGE'
      ? `Patrol scheduled for ${patrolTime} · Tag scanned at ${scanTime}, ${Math.round(distance)}m away from ${cp.name}'s assigned position (outside its ${cp.radius}m radius)`
      : `Patrol scheduled for ${patrolTime} · No location was detected when the tag was scanned at ${scanTime} (${cp.name})`;

    // Alert Settings' escalation threshold, made real: count this guard's
    // location-related rejections at this site since the shift began (the
    // in-memory `scans` cache covers this — it only drops rows after 48h, and a
    // single shift is always well inside that). At or above the configured
    // number, raise this alert to red instead of the usual orange so it actually
    // stands out, rather than the threshold sitting unused.
    const shiftStart = currentShiftStart(nowMs());
    const priorRejections = scans.filter(s => s.siteId === siteId && s.guardId === actingGuardId &&
      (s.result === 'REJECTED_OUT_OF_RANGE' || s.result === 'REJECTED_NO_LOCATION') && s.timestamp >= shiftStart).length;
    const rejectionCount = priorRejections + 1;
    const threshold = Math.max(1, alertSettings.escalation || 3);
    const escalated = rejectionCount >= threshold;

    offlineInsertNotification({
      id: offlineNewId(),
      site_id: siteId,
      route_id: dutyInfo.inst.routeId,
      kind: 'radius_alert',
      severity: escalated ? 'red' : 'orange',
      title: (escalated ? 'Escalated — ' : '') + (result === 'REJECTED_OUT_OF_RANGE' ? 'Guard outside checkpoint radius' : 'Guard location unavailable'),
      detail: escalated ? `${baseDetail} · ${rejectionCount} rejections this shift, reached the escalation threshold` : baseDetail,
      occurred_at: new Date().toISOString(),
      auto_clear: false
    });
  }

  const record = rowToScan(row);
  if (!scans.some(s => s.id === record.id)) scans.push(record);
  renderStats();
  renderLog();
  return record;
}

