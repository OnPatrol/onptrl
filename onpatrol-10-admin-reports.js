// ---------------- Admin view interactions ----------------
document.getElementById('newCpRadiusSlider').addEventListener('input', e => {
  document.getElementById('newCpRadiusVal').textContent = `${e.target.value} m`;
});

document.getElementById('detectCpLocBtn').addEventListener('click', () => {
  const statusEl = document.getElementById('detectCpStatus');
  const hintEl = document.getElementById('cpRadiusHint');
  if (!navigator.geolocation){
    statusEl.textContent = 'Geolocation not supported in this browser.';
    return;
  }
  statusEl.textContent = 'Detecting…';
  navigator.geolocation.getCurrentPosition(
    pos => {
      const { latitude, longitude, accuracy } = pos.coords;
      document.getElementById('newCpLat').value = latitude.toFixed(6);
      document.getElementById('newCpLng').value = longitude.toFixed(6);
      statusEl.textContent = `Locked — GPS accuracy ±${accuracy.toFixed(0)}m`;
      const suggested = Math.min(100, Math.max(5, Math.round(accuracy * 1.5)));
      const slider = document.getElementById('newCpRadiusSlider');
      slider.value = suggested;
      document.getElementById('newCpRadiusVal').textContent = `${suggested} m`;
      hintEl.textContent = `Suggested from ±${accuracy.toFixed(0)}m GPS accuracy — narrow it for tighter spots (e.g. server rooms), widen it for open yards.`;
    },
    err => {
      statusEl.textContent = `Couldn't get location (${err.message}). You can still enter coordinates manually.`;
      document.getElementById('newCpLat').removeAttribute('readonly');
      document.getElementById('newCpLng').removeAttribute('readonly');
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

document.getElementById('addCpBtn').addEventListener('click', async () => {
  const name = document.getElementById('newCpName').value.trim();
  const lat = parseFloat(document.getElementById('newCpLat').value);
  const lng = parseFloat(document.getElementById('newCpLng').value);
  const radius = parseFloat(document.getElementById('newCpRadiusSlider').value) || 15;
  if (!name || isNaN(lat) || isNaN(lng) || !activeSiteId){
    document.getElementById('detectCpStatus').textContent = 'Name and a detected location are both required.';
    return;
  }

  const maxNum = checkpoints.reduce((max, c) => {
    const m = /^CP-(\d+)$/.exec(c.qrId);
    return m ? Math.max(max, parseInt(m[1])) : max;
  }, 0);
  const qrId = 'CP-' + String(maxNum + 1).padStart(3, '0');

  const { error } = await sb.from('checkpoints').insert({ site_id: activeSiteId, qr_id: qrId, name, lat, lng, radius_m: radius });
  if (error){
    document.getElementById('detectCpStatus').textContent = 'Could not save — ' + error.message;
    return;
  }
  document.getElementById('newCpName').value = '';
  document.getElementById('newCpLat').value = '';
  document.getElementById('newCpLng').value = '';
  document.getElementById('newCpRadiusSlider').value = 15;
  document.getElementById('newCpRadiusVal').textContent = '15 m';
  document.getElementById('detectCpStatus').textContent = '';
  document.getElementById('cpRadiusHint').textContent = 'Stand at the checkpoint and tap "Use my location" — radius auto-suggests from GPS accuracy, then adjust if needed.';
  showToast('Checkpoint added', `${name} (${qrId}) is ready to scan.`, 'success');
  await loadCheckpoints();
  renderAll();
});

document.getElementById('addSiteBtn').addEventListener('click', async () => {
  const name = document.getElementById('newSiteName').value.trim();
  const address = document.getElementById('newSiteAddress').value.trim();
  const phone = cleanPhone(document.getElementById('newSitePhone').value);
  if (!name) return;
  if (!isValidPhone(phone)){ showToast('Site phone number needed', 'Enter the main phone number at this site, e.g. 082 123 4567 or +27 82 123 4567.', 'warn'); document.getElementById('newSitePhone').focus(); return; }
  const { data, error } = await sb.from('sites').insert({ name, address: address || null, phone }).select().single();
  if (error){ showToast('Could not add site', error.message, 'danger'); return; }
  document.getElementById('newSiteName').value = '';
  document.getElementById('newSiteAddress').value = '';
  document.getElementById('newSitePhone').value = '';
  showToast('Site added', `${name} is ready to configure. Share code ${data.site_code} with its guards.`, 'success');
  await loadSites();
  setActiveSite(data.id);
  renderAll();
  // Straight into the map modal so the admin can set the pin (and drag it into
  // place, since GPS/geocoding can be a few metres off), draw the perimeter, and
  // add site contacts as part of creating the site, not as a separate step later.
  openSiteMapModal(data.id);
});

document.getElementById('siteSearch').addEventListener('input', renderSiteTable);
document.getElementById('userSearch').addEventListener('input', renderUsersTable);

['siteQuickSwitchCp','siteQuickSwitchManage','siteQuickSwitchPatrols','siteQuickSwitchAlerts','ctrlSiteSwitch'].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('change', e => {
    setActiveSite(e.target.value);
    renderAll();
  });
});

document.getElementById('siteQuickSwitchManage').addEventListener('change', refreshManageSitePanels);

let muteTimeout = null;
document.getElementById('soundToggleBtn').addEventListener('click', (e) => {
  soundOn = !soundOn;
  e.target.classList.toggle('on', soundOn);
  e.target.textContent = soundOn ? '🔊' : '🔇';
  if (muteTimeout){ clearTimeout(muteTimeout); muteTimeout = null; }
  if (soundOn){
    beep(700, 90, 'sine', 0.12);
  } else {
    muteTimeout = setTimeout(() => {
      soundOn = true;
      e.target.classList.add('on');
      e.target.textContent = '🔊';
      muteTimeout = null;
      showToast('Sound re-enabled', 'Mute automatically expires after 60 seconds so alerts don\'t stay silenced by accident.', '');
    }, 60000);
  }
});

document.getElementById('addRouteBtn').addEventListener('click', async () => {
  const name = document.getElementById('newRouteName').value.trim();
  if (!name || routeBuilderOrder.length === 0 || !activeSiteId) return;
  const strictOrder = document.getElementById('newRouteStrictOrder').checked;

  const { data: routeRow, error } = await sb.from('routes').insert({ site_id: activeSiteId, name, strict_order: strictOrder }).select().single();
  if (error){ showToast('Could not add route', error.message, 'danger'); return; }

  const rcRows = routeBuilderOrder.map((qrId, i) => {
    const cp = checkpoints.find(c => c.qrId === qrId);
    return cp ? { route_id: routeRow.id, checkpoint_id: cp.id, position: i + 1 } : null;
  }).filter(Boolean);
  if (rcRows.length){
    const { error: rcError } = await sb.from('route_checkpoints').insert(rcRows);
    if (rcError) showToast('Route created but checkpoints failed to save', rcError.message, 'danger');
    else showToast('Route added', `${name} was created with ${rcRows.length} checkpoint${rcRows.length === 1 ? '' : 's'}.`, 'success');
  } else {
    showToast('Route added', `${name} was created.`, 'success');
  }

  document.getElementById('newRouteName').value = '';
  document.getElementById('newRouteStrictOrder').checked = false;
  routeBuilderOrder = [];
  await loadAllData();
  renderAll();
});

document.getElementById('saveAlertsBtn').addEventListener('click', async () => {
  if (!activeSiteId) return;
  const payload = {
    site_id: activeSiteId,
    notify_dashboard: document.getElementById('notifyDashboard').checked,
    notify_sms: document.getElementById('notifySms').checked,
    notify_email: document.getElementById('notifyEmail').checked,
    escalation_threshold: parseInt(document.getElementById('escalationThreshold').value) || 3,
    updated_at: new Date().toISOString()
  };
  const { error } = await sb.from('alert_settings').upsert(payload);
  const msg = document.getElementById('alertsSavedMsg');
  if (error){
    msg.textContent = 'Could not save — ' + error.message;
    msg.style.color = 'var(--danger)';
  } else {
    alertSettings = { dashboard: payload.notify_dashboard, sms: payload.notify_sms, email: payload.notify_email, escalation: payload.escalation_threshold };
    msg.textContent = 'Settings saved.';
    msg.style.color = 'var(--success)';
  }
  msg.style.display = 'block';
  setTimeout(() => { msg.style.display = 'none'; }, 2500);
});

// ---------------- Patrol schedules ----------------
document.getElementById('newSchedIntervalPreset').addEventListener('change', e => {
  document.getElementById('newSchedCustomWrap').style.display = e.target.value === 'custom' ? 'flex' : 'none';
  updateSchedConcludePreview();
});

// Keeps the "concludes at" helper text in sync with duration/grace/interval as the
// admin types, including a heads-up if duration+grace would run past the next
// scheduled patrol — late scans can only be attributed to this instance up to the
// repeat interval, so a longer window than that would silently lose late scans.
function updateSchedConcludePreview(){
  const el = document.getElementById('newSchedConcludePreview');
  if (!el) return;
  const duration = parseInt(document.getElementById('newSchedDuration').value) || 0;
  const grace = parseInt(document.getElementById('newSchedGrace').value) || 0;
  const preset = document.getElementById('newSchedIntervalPreset').value;
  const interval = preset === 'custom'
    ? (parseInt(document.getElementById('newSchedIntervalCustom').value) || 0)
    : parseInt(preset);
  const total = duration + grace;
  let msg = `Scans up to ${total} minutes after the patrol starts (${duration}m duration + ${grace}m grace) still count as on time. The round then concludes — any tag scanned after that is treated as late.`;
  if (interval && total > interval){
    msg += ` Heads up: that's longer than the ${interval}m repeat interval, so a late tag scanned after the next patrol has already started won't count toward this one — keep duration + grace at or under the repeat interval.`;
  }
  el.textContent = msg;
}
document.getElementById('newSchedDuration').addEventListener('input', updateSchedConcludePreview);
document.getElementById('newSchedGrace').addEventListener('input', updateSchedConcludePreview);
document.getElementById('newSchedIntervalCustom').addEventListener('input', updateSchedConcludePreview);

document.getElementById('addSchedBtn').addEventListener('click', async () => {
  const routeId = document.getElementById('newSchedRoute').value;
  if (!routeId) return;
  const preset = document.getElementById('newSchedIntervalPreset').value;
  const intervalMinutes = preset === 'custom'
    ? (parseInt(document.getElementById('newSchedIntervalCustom').value) || 30)
    : parseInt(preset);
  const shiftStart = document.getElementById('newSchedStart').value || '22:00';
  const shiftEnd = document.getElementById('newSchedEnd').value || '05:00';
  const durationMinutes = parseInt(document.getElementById('newSchedDuration').value) || 20;
  const graceMinutes = parseInt(document.getElementById('newSchedGrace').value) || 10;

  const { error } = await sb.from('schedules').insert({
    route_id: routeId, interval_minutes: intervalMinutes, shift_start: shiftStart,
    shift_end: shiftEnd, duration_minutes: durationMinutes, grace_minutes: graceMinutes, active: true
  });
  if (error){ showToast('Could not add schedule', error.message, 'danger'); return; }
  document.getElementById('newSchedIntervalCustom').value = '';
  showToast('Schedule added', `Guards will be prompted every ${intervalMinutes}m between ${shiftStart}\u2013${shiftEnd}.`, 'success');
  await loadSchedules();
  renderAll();
});

// ---------------- Reports ----------------
function renderReportSiteSelect(){
  const sel = document.getElementById('reportSiteSelect');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">All sites</option>' + sites.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
  if (current) sel.value = current;
}

function defaultReportDates(){
  const fromEl = document.getElementById('reportFrom');
  const toEl = document.getElementById('reportTo');
  if (fromEl && !fromEl.value && toEl && !toEl.value){
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7*24*60*60*1000);
    toEl.value = now.toISOString().slice(0,10);
    fromEl.value = weekAgo.toISOString().slice(0,10);
  }
}

let lastReportRows = [];
let lastReportSummary = null;
let lastReportDetail = [];
let lastReportComments = [];
let lastReportPositionAlerts = [];

// Hand-built SVG charts instead of a canvas library: no external script to fail
// to load, and no "screenshot the canvas before it's finished animating" timing
// problem — the markup below is the final chart the instant it's inserted, so
// what's on screen is exactly what goes into the printed report too.
function svgStackedBarChart(rows){
  const w = 480, h = 220, padL = 30, padB = 30, padT = 10, padR = 10;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const successColor = '#3FB878', warnColor = '#E8862A', dangerColor = '#E5484D', gridColor = '#33383C', textColor = '#8C9296';
  if (!rows.length){
    return `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" style="width:100%; height:auto;"><text x="${w/2}" y="${h/2}" text-anchor="middle" font-size="12" fill="${textColor}" font-family="sans-serif">No resolved patrols in this range</text></svg>`;
  }
  const maxTotal = Math.max(1, ...rows.map(r => r.onTime + r.late + r.missed));
  const gap = plotW / rows.length;
  const barW = Math.max(6, Math.min(46, gap * 0.55));
  let grid = '';
  [0, 0.25, 0.5, 0.75, 1].forEach(f => {
    const y = padT + plotH - f * plotH;
    grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${(w-padR).toFixed(1)}" y2="${y.toFixed(1)}" stroke="${gridColor}" stroke-width="1"/>`;
  });
  let bars = '';
  rows.forEach((r, i) => {
    const x = padL + gap * i + (gap - barW) / 2;
    let yCursor = padT + plotH;
    [[r.onTime, successColor], [r.late, warnColor], [r.missed, dangerColor]].forEach(([val, color]) => {
      const segH = (val / maxTotal) * plotH;
      if (segH > 0){
        yCursor -= segH;
        bars += `<rect x="${x.toFixed(1)}" y="${yCursor.toFixed(1)}" width="${barW.toFixed(1)}" height="${segH.toFixed(1)}" fill="${color}" rx="2"/>`;
      }
    });
    const label = r.routeName.length > 11 ? r.routeName.slice(0, 10) + '…' : r.routeName;
    bars += `<text x="${(x+barW/2).toFixed(1)}" y="${(padT+plotH+16).toFixed(1)}" font-size="9" fill="${textColor}" text-anchor="middle" font-family="sans-serif">${escapeHtmlForPrint(label)}</text>`;
  });
  return `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" style="width:100%; height:auto;">${grid}${bars}</svg>`;
}

function svgDonutChart(onTime, late, missed){
  const size = 200, r = 74, cx = size/2, cy = size/2, strokeW = 26;
  const successColor = '#3FB878', warnColor = '#E8862A', dangerColor = '#E5484D', mutedColor = '#8C9296', textColor = '#EDEEEC';
  const total = onTime + late + missed;
  if (!total){
    return `<svg viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg" style="width:100%; max-width:200px;">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#2A2F33" stroke-width="${strokeW}"/>
      <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle" font-size="11" fill="${mutedColor}" font-family="sans-serif">No data</text>
    </svg>`;
  }
  const circumference = 2 * Math.PI * r;
  let offset = 0, circles = '';
  [[onTime, successColor], [late, warnColor], [missed, dangerColor]].forEach(([val, color]) => {
    if (!val) return;
    const dash = (val / total) * circumference;
    circles += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${strokeW}" stroke-dasharray="${dash.toFixed(2)} ${(circumference-dash).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`;
    offset += dash;
  });
  const pct = Math.round((onTime/total)*100);
  return `<svg viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg" style="width:100%; max-width:200px;">
    ${circles}
    <text x="${cx}" y="${cy-4}" text-anchor="middle" font-size="22" font-weight="700" fill="${textColor}" font-family="sans-serif">${pct}%</text>
    <text x="${cx}" y="${cy+15}" text-anchor="middle" font-size="10" fill="${mutedColor}" font-family="sans-serif">on time</text>
  </svg>`;
}

// Scans older than ~48h have already fallen out of the in-memory `scans` cache
// (loadScans() only keeps a rolling 48h window for the live dashboards), so a
// report over any longer range was silently working off missing data — that's
// why it looked like reports "didn't generate" for anything but the last couple
// of days. Reports now pull exactly the scans they need, straight from the DB.
async function fetchScansForReportRange(winStartMs, winEndMs, siteFilter){
  const since = new Date(winStartMs - 6*60*60*1000).toISOString(); // small lookback pad for patrol windows that start just before winStart
  const until = new Date(winEndMs).toISOString();
  const { rows, error } = await fetchScansPaged({
    since, until: new Date(winEndMs + 1).toISOString(),
    siteIds: siteFilter ? [siteFilter] : null, maxRows: 400000
  });
  if (error){ showToast('Could not load scan history for report', error.message, 'danger'); return null; }
  const data = rows.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return (data || []).map(rowToScan);
}

async function computeReport(){
  const siteFilter = document.getElementById('reportSiteSelect').value || null;
  const fromVal = document.getElementById('reportFrom').value;
  const toVal = document.getElementById('reportTo').value;
  if (!fromVal || !toVal){
    showToast('Pick a date range', 'Choose both a "From" and "To" date first.', 'warn');
    return false;
  }
  const winStart = new Date(fromVal + 'T00:00:00').getTime();
  const winEnd = new Date(toVal + 'T23:59:59').getTime();
  const now = nowMs();

  const statusEl = document.getElementById('reportRunStatus');
  if (statusEl) statusEl.textContent = 'Fetching scan history for this range…';

  const rangeScans = await fetchScansForReportRange(winStart, winEnd, siteFilter);
  if (rangeScans === null){ if (statusEl) statusEl.textContent = ''; return false; }

  const relevantRoutes = routes.filter(r => !siteFilter || r.siteId === siteFilter);
  const routeIds = new Set(relevantRoutes.map(r => r.id));
  const relevantScheds = schedules.filter(s => routeIds.has(s.routeId));
  if (relevantScheds.some(s => patrolCreationFloor(s) > winStart)){
    showToast('Range starts before setup', 'Patrols are only counted from when each site and schedule was created.', 'warn');
  }

  // instanceStatus()/scansForInstance() read the module-level `scans` array, so
  // swap in the range-scoped data for this computation and put the live
  // dashboard's cache back immediately after — nothing else should ever see
  // this substitution.
  const savedScans = scans;
  scans = rangeScans;
  const byRoute = {};
  const detail = [];
  try {
    relevantScheds.forEach(sched => {
      const insts = generateInstances(sched, winStart, winEnd);
      insts.forEach(inst => {
        const st = instanceStatus(inst, now).status;
        if (!['completed','completed_late','missed'].includes(st)) return; // not yet resolved
        const r = routes.find(rt => rt.id === inst.routeId);
        if (!r) return;
        const site = sites.find(s => s.id === r.siteId);
        const key = r.id;
        if (!byRoute[key]){
          byRoute[key] = { routeId: r.id, routeName: r.name, siteName: site ? site.name : '—', scheduled: 0, onTime: 0, late: 0, missed: 0 };
        }
        byRoute[key].scheduled++;
        if (st === 'completed') byRoute[key].onTime++;
        else if (st === 'completed_late') byRoute[key].late++;
        else if (st === 'missed') byRoute[key].missed++;

        // Tag-level detail: every checkpoint the route requires, and when (if
        // ever) it was actually scanned during this patrol's window.
        const cpIds = routeCheckpoints(inst.routeId);
        const found = scansForInstance(inst);
        const firstScanAt = {};
        found.forEach(s => { if (!(s.qrId in firstScanAt) || s.timestamp < firstScanAt[s.qrId]) firstScanAt[s.qrId] = s.timestamp; });
        const cpDetail = cpIds.map(id => {
          const cp = checkpoints.find(c => c.qrId === id);
          const t = firstScanAt[id];
          const skipRow = found.find(s => s.qrId === id && s.result === 'SKIPPED');
          const wasScanned = found.some(s => s.qrId === id && s.result === 'ACCEPTED');
          return { name: cp ? cp.name : id, qrId: id, scannedAt: t != null ? t : null, skipped: (!wasScanned && skipRow) ? skipReasonLabel(skipRow.skipReason) : null };
        });
        detail.push({
          siteName: site ? site.name : '—',
          routeName: r.name,
          expectedTime: inst.expectedTime,
          status: st,
          checkpoints: cpDetail
        });
      });
    });
  } finally {
    scans = savedScans;
  }

  const rows = Object.values(byRoute).sort((a,b) => a.siteName.localeCompare(b.siteName) || a.routeName.localeCompare(b.routeName));
  const summary = rows.reduce((acc, r) => {
    acc.scheduled += r.scheduled; acc.onTime += r.onTime; acc.late += r.late; acc.missed += r.missed;
    return acc;
  }, { scheduled: 0, onTime: 0, late: 0, missed: 0 });

  detail.sort((a,b) => a.expectedTime - b.expectedTime);

  lastReportRows = rows;
  lastReportSummary = summary;
  lastReportDetail = detail;
  if (statusEl) statusEl.textContent = '';
  return true;
}

// One line per checkpoint in the patrol report: scan time, skipped (with the reason), or not scanned.
function reportCpLabel(cp){
  const what = cp.skipped
    ? `skipped (${escapeHtmlForPrint(cp.skipped)})`
    : (cp.scannedAt != null ? new Date(cp.scannedAt).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', hour12: false}) : 'not scanned');
  return `${escapeHtmlForPrint(cp.name)} — ${what}`;
}
function renderReport(){
  const summary = lastReportSummary;
  document.getElementById('repScheduled').textContent = summary.scheduled;
  document.getElementById('repOnTime').textContent = summary.onTime;
  document.getElementById('repLate').textContent = summary.late;
  document.getElementById('repMissed').textContent = summary.missed;
  const pct = summary.scheduled ? Math.round((summary.onTime / summary.scheduled) * 100) : 0;
  document.getElementById('repOnTimePct').textContent = summary.scheduled ? `${pct}% completed on time overall` : 'No resolved patrols in this range yet.';

  const body = document.getElementById('reportByRouteBody');
  body.innerHTML = lastReportRows.length ? lastReportRows.map(r => {
    const rp = r.scheduled ? Math.round((r.onTime / r.scheduled) * 100) : 0;
    return `<tr><td style="font-family:var(--sans);">${escapeHtmlForPrint(r.siteName)}</td><td style="font-family:var(--sans);">${escapeHtmlForPrint(r.routeName)}</td><td>${r.scheduled}</td><td>${r.onTime}</td><td>${r.late}</td><td>${r.missed}</td><td>${rp}%</td></tr>`;
  }).join('') : '<tr><td colspan="7" style="font-family:var(--sans); color:var(--muted);">No resolved patrols in this range.</td></tr>';

  const detailBody = document.getElementById('reportDetailBody');
  detailBody.innerHTML = lastReportDetail.length ? lastReportDetail.map(d => {
    const cpText = d.checkpoints.map(reportCpLabel).join('<br>');
    return `<tr><td style="font-family:var(--sans);">${escapeHtmlForPrint(d.siteName)}</td><td style="font-family:var(--sans);">${escapeHtmlForPrint(d.routeName)}</td><td>${new Date(d.expectedTime).toLocaleString([], {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', hour12: false})}</td><td>${statusLabel(d.status)}</td><td style="font-family:var(--sans);">${cpText}</td></tr>`;
  }).join('') : '<tr><td colspan="5" style="font-family:var(--sans); color:var(--muted);">No resolved patrols in this range.</td></tr>';

  renderReportCharts();
}

function renderReportCharts(){
  const barEl = document.getElementById('reportBarChart');
  const donutEl = document.getElementById('reportDonutChart');
  if (!barEl || !donutEl) return;
  barEl.innerHTML = svgStackedBarChart(lastReportRows);
  const s = lastReportSummary;
  donutEl.innerHTML = svgDonutChart(s.onTime, s.late, s.missed);
}

document.getElementById('runReportBtn').addEventListener('click', async () => {
  const ok = await computeReport();
  if (ok) renderReport();
  await loadAndRenderPositionAlerts();
  await loadAndRenderControllerComments();
});

async function loadAndRenderPositionAlerts(){
  const siteFilter = document.getElementById('reportSiteSelect').value || null;
  const fromVal = document.getElementById('reportFrom').value;
  const toVal = document.getElementById('reportTo').value;
  const body = document.getElementById('positionAlertsBody');
  if (!fromVal || !toVal) return;
  const winStart = new Date(fromVal + 'T00:00:00').toISOString();
  const winEnd = new Date(toVal + 'T23:59:59').toISOString();

  let query = sb.from('patrol_notifications')
    .select('id, site_id, title, detail, severity, occurred_at')
    .eq('kind', 'radius_alert')
    .gte('occurred_at', winStart)
    .lte('occurred_at', winEnd)
    .order('occurred_at', { ascending: false })
    .limit(300);
  if (siteFilter) query = query.eq('site_id', siteFilter);

  const { data, error } = await query;
  if (error){ showToast('Could not load position alerts', error.message, 'danger'); return; }

  const rows = (data || []).map(n => {
    const siteName = (sites.find(s => s.id === n.site_id) || {}).name || '—';
    const rawDetail = (n.detail || '').trim();
    // Some alerts in this table were never written by this app's scan-rejection
    // path (e.g. older data, or another client writing to the same table) and
    // only ever stored the site name in `detail` — no distance, no checkpoint.
    // Showing that back verbatim just repeats the Site column and reads as if
    // the distance info is there when it isn't. Say so plainly instead of
    // fabricating a number or silently duplicating the site name.
    const isUninformative = !rawDetail || rawDetail === '—' || rawDetail.toLowerCase() === siteName.toLowerCase();
    return {
      when: n.occurred_at,
      site: siteName,
      title: n.title,
      // The distance/reason is spelled out here when available — e.g. "Patrol
      // scheduled for 04:45 · Tag scanned at 04:52, 20m away from Gate's
      // assigned position (outside its 15m radius)" — this is what actually
      // answers "how far off, from which checkpoint, and at what time," not
      // just that an alert fired.
      detail: isUninformative ? 'No distance recorded for this alert' : rawDetail,
      severity: n.severity
    };
  });
  lastReportPositionAlerts = rows;

  if (!body) return;
  body.innerHTML = rows.length ? rows.map(r => `
    <tr>
      <td>${new Date(r.when).toLocaleString([], {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', hour12: false})}</td>
      <td style="font-family:var(--sans);">${escapeHtmlForPrint(r.site)}</td>
      <td style="font-family:var(--sans);"><span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:${severityColor(r.severity)}; margin-right:6px;"></span>${escapeHtmlForPrint(r.title)}</td>
      <td style="font-family:var(--sans);">${escapeHtmlForPrint(r.detail)}</td>
    </tr>
  `).join('') : '<tr><td colspan="4" style="font-family:var(--sans); color:var(--muted);">No position alerts in this range.</td></tr>';
}

async function loadAndRenderControllerComments(){
  const siteFilter = document.getElementById('reportSiteSelect').value || null;
  const fromVal = document.getElementById('reportFrom').value;
  const toVal = document.getElementById('reportTo').value;
  const body = document.getElementById('controllerCommentsBody');
  if (!fromVal || !toVal) return;
  const winStart = new Date(fromVal + 'T00:00:00').toISOString();
  const winEnd = new Date(toVal + 'T23:59:59').toISOString();

  let query = sb.from('patrol_notifications')
    .select('id, site_id, title, severity, occurred_at, cleared_at, notification_comments!inner(body, created_at, profiles(full_name))')
    .gte('occurred_at', winStart)
    .lte('occurred_at', winEnd)
    .order('occurred_at', { ascending: false })
    .limit(300);
  if (siteFilter) query = query.eq('site_id', siteFilter);

  const { data, error } = await query;
  if (error){ showToast('Could not load controller comments', error.message, 'danger'); return; }

  if (!data || !data.length){
    lastReportComments = [];
    body.innerHTML = '<tr><td colspan="5" style="font-family:var(--sans); color:var(--muted);">No commented alerts in this range.</td></tr>';
    return;
  }

  const rows = [];
  data.forEach(n => {
    const site = sites.find(s => s.id === n.site_id);
    (n.notification_comments || []).forEach(c => {
      rows.push({
        when: c.created_at,
        site: site ? site.name : '—',
        title: n.title,
        severity: n.severity,
        body: c.body,
        author: (c.profiles && c.profiles.full_name) || 'Someone'
      });
    });
  });
  rows.sort((a,b) => new Date(b.when) - new Date(a.when));
  lastReportComments = rows;

  // Escaped defensively — a comment containing characters like < or & shouldn't
  // ever be able to blank out or break the row that's supposed to show it.
  body.innerHTML = rows.map(r => `
    <tr>
      <td>${new Date(r.when).toLocaleString([], {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', hour12: false})}</td>
      <td style="font-family:var(--sans);">${escapeHtmlForPrint(r.site)}</td>
      <td style="font-family:var(--sans);"><span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:${severityColor(r.severity)}; margin-right:6px;"></span>${escapeHtmlForPrint(r.title)}</td>
      <td style="font-family:var(--sans);">${escapeHtmlForPrint(r.body)}</td>
      <td style="font-family:var(--sans);">${escapeHtmlForPrint(r.author)}</td>
    </tr>
  `).join('');
}

document.getElementById('downloadReportBtn').addEventListener('click', async () => {
  if (!(await computeReport())) return;
  renderReport();
  const siteLabel = document.getElementById('reportSiteSelect').selectedOptions[0].textContent;
  const from = document.getElementById('reportFrom').value;
  const to = document.getElementById('reportTo').value;
  let csv = 'OnPatrol report\n';
  csv += `Site,${siteLabel}\nFrom,${from}\nTo,${to}\n\n`;
  csv += `Scheduled,On time,Late,Missed,On-time %\n`;
  const s = lastReportSummary;
  const pct = s.scheduled ? Math.round((s.onTime / s.scheduled) * 100) : 0;
  csv += `${s.scheduled},${s.onTime},${s.late},${s.missed},${pct}%\n\n`;
  csv += 'Site,Route,Scheduled,On time,Late,Missed,On-time %\n';
  lastReportRows.forEach(r => {
    const rp = r.scheduled ? Math.round((r.onTime / r.scheduled) * 100) : 0;
    csv += `"${r.siteName}","${r.routeName}",${r.scheduled},${r.onTime},${r.late},${r.missed},${rp}%\n`;
  });
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `patrol-report_${from}_to_${to}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast('Report downloaded', '', 'success');
  logAudit('export', 'patrol_report', null, document.getElementById('reportSiteSelect').value || null, `Downloaded the patrol report as CSV - ${siteLabel}, ${from} to ${to}`, { format: 'csv', from, to });
});

document.getElementById('printPdfReportBtn').addEventListener('click', async () => {
  const btn = document.getElementById('printPdfReportBtn');
  btn.disabled = true;
  const statusEl = document.getElementById('reportRunStatus');
  try {
    if (!(await computeReport())){ return; }
    renderReport();
    await loadAndRenderPositionAlerts();
    await loadAndRenderControllerComments();

    const siteLabel = document.getElementById('reportSiteSelect').selectedOptions[0].textContent;
    const from = document.getElementById('reportFrom').value;
    const to = document.getElementById('reportTo').value;
    const logoEl = document.querySelector('.brand-logo');
    const logoSrc = logoEl ? logoEl.getAttribute('src') : null;
    const s = lastReportSummary;
    const pct = s.scheduled ? Math.round((s.onTime / s.scheduled) * 100) : 0;

    const byRouteRows = lastReportRows.map(r => {
      const rp = r.scheduled ? Math.round((r.onTime / r.scheduled) * 100) : 0;
      return `<tr><td>${escapeHtmlForPrint(r.siteName)}</td><td>${escapeHtmlForPrint(r.routeName)}</td><td>${r.scheduled}</td><td>${r.onTime}</td><td>${r.late}</td><td>${r.missed}</td><td>${rp}%</td></tr>`;
    }).join('') || '<tr><td colspan="7" class="empty-row">No resolved patrols in this range.</td></tr>';

    const detailRows = lastReportDetail.map(d => {
      const cpText = d.checkpoints.map(reportCpLabel).join('<br>');
      return `<tr><td>${escapeHtmlForPrint(d.siteName)}</td><td>${escapeHtmlForPrint(d.routeName)}</td><td>${new Date(d.expectedTime).toLocaleString([], {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', hour12: false})}</td><td>${statusLabel(d.status)}</td><td>${cpText}</td></tr>`;
    }).join('') || '<tr><td colspan="5" class="empty-row">No resolved patrols in this range.</td></tr>';

    const positionAlertRows = lastReportPositionAlerts.map(a => `
      <tr><td>${new Date(a.when).toLocaleString([], {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', hour12: false})}</td><td>${escapeHtmlForPrint(a.site)}</td><td>${escapeHtmlForPrint(a.title)}</td><td>${escapeHtmlForPrint(a.detail)}</td></tr>
    `).join('') || '<tr><td colspan="4" class="empty-row">No position alerts in this range.</td></tr>';

    const commentRows = lastReportComments.map(c => `
      <tr><td>${new Date(c.when).toLocaleString([], {month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', hour12: false})}</td><td>${escapeHtmlForPrint(c.site)}</td><td>${escapeHtmlForPrint(c.title)}</td><td>${escapeHtmlForPrint(c.body)}</td><td>${escapeHtmlForPrint(c.author)}</td></tr>
    `).join('') || '<tr><td colspan="5" class="empty-row">No commented alerts in this range.</td></tr>';

    logAudit('print', 'patrol_report', null, document.getElementById('reportSiteSelect').value || null, `Printed the patrol report - ${siteLabel}, ${from} to ${to}`, { format: 'pdf', from, to });
    const win = window.open('', '_blank');
    if (!win){
      showToast('Could not open print window', 'Your browser may have blocked the popup — allow popups for this site and try again.', 'danger');
      return;
    }

    win.document.write(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>OnPatrol report — ${escapeHtmlForPrint(siteLabel)} — ${from} to ${to}</title>
<style>
  @page { size: A4; margin: 1.4cm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin:0; padding:0; background:#fff; color:#111; }
  h1 { font-size:20px; margin:0; }
  h2 { font-size:14px; margin:26px 0 8px; border-bottom:1px solid #ddd; padding-bottom:4px; }
  .header { display:flex; align-items:center; gap:14px; background:#0b0f14; padding:16px 18px; border-radius:10px; }
  .header img { height:38px; width:auto; }
  .header h1 { color:#fff; }
  .header .meta { color:#b9c2cc; }
  .summary { display:flex; gap:10px; margin-top:16px; }
  .summary .card { flex:1; border:1px solid #ddd; border-radius:8px; padding:10px; text-align:center; }
  .summary .card .label { font-size:10px; color:#666; text-transform:uppercase; letter-spacing:0.4px; }
  .summary .card .val { font-size:20px; font-weight:700; margin-top:2px; }
  .charts { display:flex; gap:20px; align-items:center; margin-top:18px; }
  .charts > div:first-child { flex:1.4; }
  .charts > div:last-child { flex:1; display:flex; justify-content:center; }
  table { width:100%; border-collapse:collapse; font-size:10.5px; margin-top:6px; }
  th, td { border:1px solid #ddd; padding:5px 7px; text-align:left; vertical-align:top; }
  th { background:#14314f; color:#fff; font-weight:600; }
  tr:nth-child(even) td { background:#f7f9fb; }
  .empty-row { color:#888; text-align:center; }
  footer { position:fixed; bottom:-0.6cm; left:0; right:0; font-size:9px; color:#999; display:flex; justify-content:space-between; border-top:1px solid #eee; padding-top:4px; }
  @media print { .no-print { display:none; } table { page-break-inside:auto; } tr { page-break-inside:avoid; } }
</style>
</head>
<body>
  <div class="header">
    ${logoSrc ? `<img src="${logoSrc}" alt="OnPatrol">` : ''}
    <div>
      <h1>Patrol Report</h1>
      <div class="meta">Site: ${escapeHtmlForPrint(siteLabel)} &nbsp;•&nbsp; ${from} to ${to} &nbsp;•&nbsp; Generated ${new Date().toLocaleString([], { hour12: false })}</div>
    </div>
  </div>

  <div class="summary">
    <div class="card"><div class="label">Scheduled</div><div class="val">${s.scheduled}</div></div>
    <div class="card"><div class="label">On time</div><div class="val" style="color:#1f8a4c;">${s.onTime}</div></div>
    <div class="card"><div class="label">Late</div><div class="val" style="color:#b5760a;">${s.late}</div></div>
    <div class="card"><div class="label">Missed</div><div class="val" style="color:#c92a2a;">${s.missed}</div></div>
    <div class="card"><div class="label">On-time %</div><div class="val">${pct}%</div></div>
  </div>

  <div class="charts">
    <div>${svgStackedBarChart(lastReportRows).replace(/fill="#8C9296"/g, 'fill="#555"').replace(/stroke="#33383C"/g, 'stroke="#ddd"')}</div>
    <div>${svgDonutChart(s.onTime, s.late, s.missed).replace(/fill="#EDEEEC"/g, 'fill="#111"').replace(/fill="#8C9296"/g, 'fill="#555"')}</div>
  </div>

  <h2>By patrol / route</h2>
  <table>
    <thead><tr><th>Site</th><th>Route</th><th>Scheduled</th><th>On time</th><th>Late</th><th>Missed</th><th>On-time %</th></tr></thead>
    <tbody>${byRouteRows}</tbody>
  </table>

  <h2>Patrol-by-patrol detail</h2>
  <table>
    <thead><tr><th>Site</th><th>Route</th><th>Expected</th><th>Status</th><th>Checkpoints (tag — time scanned)</th></tr></thead>
    <tbody>${detailRows}</tbody>
  </table>

  <h2>Position alerts</h2>
  <table>
    <thead><tr><th>When</th><th>Site</th><th>Alert</th><th>Detail</th></tr></thead>
    <tbody>${positionAlertRows}</tbody>
  </table>

  <h2>Controller comments</h2>
  <table>
    <thead><tr><th>When</th><th>Site</th><th>Alert</th><th>Comment</th><th>Controller</th></tr></thead>
    <tbody>${commentRows}</tbody>
  </table>

  <footer><span>Powered by OnPatrol</span><span>${escapeHtmlForPrint(siteLabel)} · ${from} to ${to}</span></footer>

  <script>
    window.onload = function(){ setTimeout(function(){ window.print(); }, 300); };
  <\/script>
</body>
</html>`);
    win.document.close();
  } finally {
    btn.disabled = false;
    if (statusEl) statusEl.textContent = '';
  }
});

// ---------------- Inner admin tabs ----------------
document.querySelectorAll('[data-admin-view]').forEach(btn => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('[data-admin-view]').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.admin-view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('admin-' + btn.dataset.adminView).classList.add('active');
    if (btn.dataset.adminView === 'attendance'){
      await loadSiteShifts(); await loadAttendanceRecent(); await loadAbsencesRecent();
      renderSiteShiftsTable();
      renderCoverageGrid('coverageGridAdmin');
    }
    if (btn.dataset.adminView === 'manage'){
      await refreshManageSitePanels();
    }
    if (btn.dataset.adminView === 'incidents'){
      await loadAndRenderIncidents('admin');
    }
    if (btn.dataset.adminView === 'siteoverview'){
      renderSiteOverview('admin');
    }
    if (btn.dataset.adminView === 'tracking'){
      trackingViewOpened('admin');
    }
    if (btn.dataset.adminView === 'reports'){
      auditFillPanel('admin', true);
      auditInit('admin');
    }
  });
});

// ---------------- Inner controller tabs ----------------
document.querySelectorAll('[data-ctrl-view]').forEach(btn => {
  btn.addEventListener('click', async () => {
    document.querySelectorAll('[data-ctrl-view]').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.ctrl-view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('ctrl-' + btn.dataset.ctrlView).classList.add('active');
    if (btn.dataset.ctrlView === 'attendance'){
      await loadSiteShifts(); await loadAttendanceRecent(); await loadAbsencesRecent();
      renderCoverageGrid('coverageGridCtrl');
    }
    if (btn.dataset.ctrlView === 'team'){
      await loadTeamDirectory();
      renderTeamTable();
    }
    if (btn.dataset.ctrlView === 'incidents'){
      await loadAndRenderIncidents('ctrl');
    }
    if (btn.dataset.ctrlView === 'siteoverview'){
      renderSiteOverview('ctrl');
    }
    if (btn.dataset.ctrlView === 'tracking'){
      trackingViewOpened('ctrl');
    }
    if (btn.dataset.ctrlView === 'audit'){
      auditFillPanel('ctrl', false);
      auditInit('ctrl');
    }
  });
});

// ---------------- Platform (business-owner) admin ----------------
let platformOrgs = [];

async function loadAndRenderPlatformOrgs(){
  const list = document.getElementById('platformOrgsList');
  list.innerHTML = '<div class="result-meta">Loading...</div>';
  const { data, error } = await sb.functions.invoke('platform-admin', { body: { action: 'list_orgs' } });
  if (error || data?.error){
    list.innerHTML = `<div class="result-meta" style="color:var(--danger);">${await functionErrorMessage(data, error, 'Unknown error')}</div>`;
    return;
  }
  platformOrgs = data.organizations || [];
  renderPlatformOrgs();
}

function renderPlatformOrgs(){
  const list = document.getElementById('platformOrgsList');
  if (!platformOrgs.length){ list.innerHTML = '<div class="result-meta">No companies yet.</div>'; return; }
  list.innerHTML = platformOrgs.map(org => {
    const acceptRate = org.scans_30d ? Math.round((org.accepted_30d / org.scans_30d) * 100) : null;
    return `
    <div class="detail-modal" style="margin-bottom:14px; padding:16px;">
      <div style="display:flex; justify-content:space-between; align-items:baseline; gap:10px; flex-wrap:wrap;">
        <div style="font-size:15px; font-weight:600;">${escapeHtmlForPrint(org.name)}</div>
        <span class="role-pill">${escapeHtmlForPrint(org.subscription_status)}</span>
      </div>
      <div class="result-meta" style="margin:6px 0 12px;">
        ${org.site_count} site${org.site_count === 1 ? '' : 's'} ·
        ${org.guard_count} guard${org.guard_count === 1 ? '' : 's'} ·
        ${org.admin_count} admin${org.admin_count === 1 ? '' : 's'} ·
        ${org.controller_count} controller${org.controller_count === 1 ? '' : 's'}<br>
        Last 30 days: ${org.scans_30d} scan${org.scans_30d === 1 ? '' : 's'}${acceptRate !== null ? ` (${acceptRate}% accepted)` : ''} ·
        Last scan: ${org.last_scan_at ? fmtClock(new Date(org.last_scan_at).getTime()) + ' on ' + new Date(org.last_scan_at).toLocaleDateString() : 'never'}
      </div>

      <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">
        <div>
          <div class="field-label" style="margin-top:0;">Plan</div>
          <input type="text" data-org-field="plan" data-org-id="${org.id}" value="${escapeHtmlForPrint(org.plan || '')}" disabled>
        </div>
        <div>
          <div class="field-label" style="margin-top:0;">Subscription status</div>
          <select data-org-field="subscription_status" data-org-id="${org.id}" disabled>
            ${['trial','active','past_due','cancelled'].map(s => `<option value="${s}" ${s === org.subscription_status ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </div>
        <div>
          <div class="field-label">Billing email</div>
          <input type="email" data-org-field="billing_email" data-org-id="${org.id}" value="${escapeHtmlForPrint(org.billing_email || '')}" disabled>
        </div>
        <div>
          <div class="field-label">Trial ends</div>
          <input type="date" data-org-field="trial_ends_at" data-org-id="${org.id}" value="${org.trial_ends_at ? org.trial_ends_at.slice(0,10) : ''}" disabled>
        </div>
      </div>
      <div class="field-label">Notes</div>
      <input type="text" data-org-field="notes" data-org-id="${org.id}" value="${escapeHtmlForPrint(org.notes || '')}" disabled>

      <div class="btn-row" style="margin-top:14px;">
        <button class="btn" data-org-edit="${org.id}">Edit</button>
        <button class="btn btn-primary" data-org-save="${org.id}" style="display:none;">Save changes</button>
        <button class="btn" data-org-cancel="${org.id}" style="display:none;">Cancel</button>
        <button class="btn" data-org-export="${org.id}">Download data</button>
        <button class="btn" data-org-delete="${org.id}" style="background:var(--danger); color:#fff;">Delete company</button>
      </div>
    </div>`;
  }).join('');

  // Fields are locked until Edit is pressed, so nothing can be changed by a stray tap.
  list.querySelectorAll('[data-org-edit]').forEach(btn => {
    btn.addEventListener('click', () => {
      const orgId = btn.dataset.orgEdit;
      list.querySelectorAll(`[data-org-id="${orgId}"]`).forEach(input => { input.disabled = false; });
      btn.style.display = 'none';
      list.querySelector(`[data-org-save="${orgId}"]`).style.display = '';
      list.querySelector(`[data-org-cancel="${orgId}"]`).style.display = '';
    });
  });
  list.querySelectorAll('[data-org-cancel]').forEach(btn => {
    btn.addEventListener('click', () => renderPlatformOrgs());   // drops any edits and locks the tile again
  });

  list.querySelectorAll('[data-org-save]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const orgId = btn.dataset.orgSave;
      const org = platformOrgs.find(o => o.id === orgId) || {};
      const updates = {};
      // Only send what was really changed. (Sending the untouched trial date back would also
      // reset its exact time and could trigger a second trial reminder email.)
      list.querySelectorAll(`[data-org-id="${orgId}"]`).forEach(input => {
        const field = input.dataset.orgField;
        const raw = input.value.trim();
        const before = field === 'trial_ends_at' ? (org.trial_ends_at ? org.trial_ends_at.slice(0, 10) : '') : String(org[field] || '');
        if (raw === before) return;
        updates[field] = field === 'trial_ends_at' ? (raw ? new Date(raw).toISOString() : null) : (raw || null);
      });
      if (!Object.keys(updates).length){ showToast('No changes to save', '', 'success'); renderPlatformOrgs(); return; }
      btn.disabled = true;
      const { data, error } = await sb.functions.invoke('platform-admin', { body: { action: 'update_org', org_id: orgId, updates } });
      btn.disabled = false;
      if (error || data?.error){ showToast('Could not save', await functionErrorMessage(data, error, 'Unknown error'), 'danger'); return; }
      showToast('Saved', '', 'success');
      await loadAndRenderPlatformOrgs();
    });
  });

  list.querySelectorAll('[data-org-export]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const orgId = btn.dataset.orgExport;
      const org = platformOrgs.find(o => o.id === orgId);
      btn.disabled = true;
      btn.textContent = 'Preparing...';
      const { data, error } = await sb.functions.invoke('platform-admin', { body: { action: 'export_org', org_id: orgId } });
      btn.disabled = false;
      btn.textContent = 'Download data';
      if (error || data?.error){ showToast('Export failed', await functionErrorMessage(data, error, 'Unknown error'), 'danger'); return; }
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(org?.name || 'company').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-export-${new Date().toISOString().slice(0,10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      showToast('Export downloaded', '', 'success');
    });
  });

  list.querySelectorAll('[data-org-delete]').forEach(btn => {
    btn.addEventListener('click', () => {
      const orgId = btn.dataset.orgDelete;
      const org = platformOrgs.find(o => o.id === orgId);
      document.getElementById('platformDeleteOrgName').textContent = org?.name || '';
      document.getElementById('platformDeleteConfirmInput').value = '';
      document.getElementById('platformDeleteConfirmInput').placeholder = org?.name || '';
      document.getElementById('platformDeleteError').style.display = 'none';
      document.getElementById('platformDeleteSubmitBtn').dataset.orgId = orgId;
      document.getElementById('platformDeleteModalBg').classList.add('show');
    });
  });
}

document.getElementById('platformRefreshBtn').addEventListener('click', loadAndRenderPlatformOrgs);
document.getElementById('platformTabBtn').addEventListener('click', loadAndRenderPlatformOrgs);

document.getElementById('platformDeleteSubmitBtn').addEventListener('click', async () => {
  const btn = document.getElementById('platformDeleteSubmitBtn');
  const orgId = btn.dataset.orgId;
  const org = platformOrgs.find(o => o.id === orgId);
  const typed = document.getElementById('platformDeleteConfirmInput').value.trim();
  const errEl = document.getElementById('platformDeleteError');
  errEl.style.display = 'none';
  if (typed !== org?.name){
    errEl.textContent = 'That doesn\'t match the company name exactly.';
    errEl.style.display = 'block';
    return;
  }
  btn.disabled = true;
  try{
    const { data, error } = await sb.functions.invoke('platform-admin', { body: { action: 'delete_org', org_id: orgId, confirm_name: typed } });
    if (error || data?.error){
      errEl.textContent = await functionErrorMessage(data, error, 'Unknown error');
      errEl.style.display = 'block';
      return;
    }
    document.getElementById('platformDeleteModalBg').classList.remove('show');
    showToast('Company deleted', `${org?.name} and all its data have been removed.`, 'success');
    await loadAndRenderPlatformOrgs();
  } catch(err){
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
  }
});

