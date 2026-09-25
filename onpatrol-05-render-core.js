// ---------------- Rendering ----------------
function renderCpTable(){
  const body = document.getElementById('cpTableBody');
  const scoped = checkpoints.filter(c => c.siteId === activeSiteId);
  if (scoped.length === 0){
    body.innerHTML = '<tr><td colspan="4" style="font-family:var(--sans); color:var(--muted);">No checkpoints at this site yet.</td></tr>';
    return;
  }
  body.innerHTML = scoped.map(c => `
    <tr>
      <td><canvas class="qr-thumb" data-qr="${c.qrId}"></canvas></td>
      <td>${c.name}</td>
      <td><input type="number" class="cp-radius-edit" data-qr-radius="${c.qrId}" value="${c.radius}" min="5" max="200" style="width:56px; padding:4px 6px; font-size:11px;">m</td>
      <td><button class="del-btn" data-del="${c.qrId}" aria-label="Delete checkpoint"><i>&times;</i></button></td>
    </tr>
  `).join('');

  body.querySelectorAll('.cp-radius-edit').forEach(inp => {
    inp.addEventListener('change', async () => {
      const cp = checkpoints.find(c => c.qrId === inp.dataset.qrRadius);
      if (!cp) return;
      const newRadius = parseFloat(inp.value) || cp.radius;
      const prevRadius = cp.radius;
      cp.radius = newRadius;
      const { error } = await sb.from('checkpoints').update({ radius_m: newRadius }).eq('id', cp.id);
      if (error){ cp.radius = prevRadius; inp.value = prevRadius; showToast('Could not update radius', error.message, 'danger'); }
      else showToast('Radius updated', `${cp.name} now accepts scans within ${newRadius}m.`, 'success');
    });
  });

  body.querySelectorAll('.qr-thumb').forEach(cv => {
    new QRious({ element: cv, value: cv.dataset.qr, size: 56, background: '#fff', foreground: '#000' });
    cv.addEventListener('click', () => openQrModal(cv.dataset.qr));
  });
  body.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const cp = checkpoints.find(c => c.qrId === btn.dataset.del);
      if (!cp) return;
      if (!confirm(`Delete checkpoint "${cp.name}"? Any routes or schedules that use it will stop working until you update them. This can't be undone.`)) return;
      const { error } = await sb.from('checkpoints').delete().eq('id', cp.id);
      if (error){ showToast('Could not delete checkpoint', error.message, 'danger'); return; }
      showToast('Checkpoint deleted', `${cp.name} was removed.`, 'success');
      await loadAllData();
      renderAll();
    });
  });
}

function openQrModal(qrId){
  const cp = checkpoints.find(c => c.qrId === qrId);
  const canvas = document.getElementById('qrModalCanvas');
  new QRious({ element: canvas, value: qrId, size: 200, background: '#fff', foreground: '#000' });
  document.getElementById('qrModalLabel').textContent = `${qrId} — ${cp ? cp.name : ''}`;
  document.getElementById('qrModalBg').classList.add('show');
}

function escapeHtmlForPrint(str){
  return String(str).replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
}

function printSiteTags(){
  const site = sites.find(s => s.id === activeSiteId);
  const scoped = checkpoints.filter(c => c.siteId === activeSiteId);
  if (!scoped.length){
    showToast('No checkpoints to print', 'Add checkpoints to this site first.', 'warn');
    return;
  }

  const tagsHtml = scoped.map(c => {
    const canvas = document.createElement('canvas');
    new QRious({ element: canvas, value: c.qrId, size: 600, background: '#ffffff', foreground: '#000000' });
    const dataUrl = canvas.toDataURL('image/png');
    return `
      <div class="tag">
        <img src="${dataUrl}" alt="${escapeHtmlForPrint(c.qrId)}">
        <div class="tag-name">${escapeHtmlForPrint(c.name)}</div>
        <div class="tag-code">${escapeHtmlForPrint(c.qrId)}</div>
      </div>`;
  }).join('');

  const win = window.open('', '_blank');
  if (!win){
    showToast('Could not open print window', 'Your browser may have blocked the popup — allow popups for this site and try again.', 'danger');
    return;
  }

  win.document.write(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>${escapeHtmlForPrint(site ? site.name : 'Site')} — checkpoint tags</title>
<style>
  @page { size: A4; margin: 1cm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin:0; padding:0; background:#fff; color:#111; }
  .sheet-title { font-size:13px; color:#555; padding:6px 0 14px; text-align:center; }
  .grid { display:flex; flex-wrap:wrap; gap:0.3cm; }
  .tag {
    width:5cm; height:5cm; border:1px dashed #999; border-radius:3mm;
    display:flex; flex-direction:column; align-items:center; justify-content:center;
    padding:0.2cm; page-break-inside:avoid; overflow:hidden;
  }
  .tag img { width:3.5cm; height:3.5cm; image-rendering:pixelated; }
  .tag-name { font-size:9px; font-weight:700; margin-top:3px; text-align:center; max-width:4.6cm; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .tag-code { font-size:8px; color:#666; font-family:ui-monospace, "SF Mono", Menlo, Consolas, monospace; margin-top:1px; }
  @media print {
    .sheet-title { display:none; }
    .tag { border:1px dashed #bbb; }
  }
</style>
</head>
<body>
  <div class="sheet-title">${escapeHtmlForPrint(site ? site.name : 'Site')} — checkpoint tags (${scoped.length})</div>
  <div class="grid">${tagsHtml}</div>
  <script>
    window.onload = function(){ setTimeout(function(){ window.print(); }, 300); };
  <\/script>
</body>
</html>`);
  win.document.close();
}

document.getElementById('printCpTagsBtn').addEventListener('click', printSiteTags);

function setTextIf(id, val){
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}
function renderStats(){
  const total = scans.length;
  const accepted = scans.filter(s => s.result === 'ACCEPTED').length;
  const rejected = scans.filter(s => String(s.result).startsWith('REJECTED')).length;   // skipped tags are not rejections
  const alerts = scans.filter(s => s.result === 'REJECTED_OUT_OF_RANGE' || s.result === 'REJECTED_NO_LOCATION').length;
  setTextIf('statTotal', total);
  setTextIf('statAccepted', accepted);
  setTextIf('statRejected', rejected);
  setTextIf('statAlerts', alerts);
  paintKpis();
}

// Day shift 06:00–18:00, Night shift 18:00–06:00, in the browser's local time.
function isDayShift(atMs){
  const h = new Date(atMs).getHours();
  return h >= 6 && h < 18;
}
function fmtClock(atMs){
  return new Date(atMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}
function currentShiftStart(atMs){
  const d = new Date(atMs);
  const start = new Date(d);
  start.setSeconds(0, 0);
  if (isDayShift(atMs)){
    start.setHours(6, 0);
  } else if (d.getHours() >= 18){
    start.setHours(18, 0);
  } else {
    start.setDate(start.getDate() - 1);
    start.setHours(18, 0);
  }
  return start.getTime();
}

// ---------------- Site overview (gauges + SLA distribution) ----------------
function polarToCartesian(cx, cy, r, angleDeg){
  const rad = (angleDeg - 90) * Math.PI / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}
function describeArc(cx, cy, r, startAngle, endAngle){
  const start = polarToCartesian(cx, cy, r, endAngle);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const largeArc = endAngle - startAngle <= 180 ? '0' : '1';
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y}`;
}

// A hand-rolled semicircle gauge (0-100), red->orange->yellow->green bands with a
// needle — no charting library needed for something this simple, and it matches
// the app's own dark theme instead of whatever a library's defaults look like.
function buildGaugeSVG(value, max, title){
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const cx = 100, cy = 95, r = 78, sw = 16;
  // Angles here use polarToCartesian's convention (0° = straight up, clockwise), so a
  // left-to-right semicircle over the top runs from -90° (0%) to +90° (100%).
  const toAngle = p => -90 + p * 1.8;
  // Smooth red -> amber -> green sweep, drawn as many short segments so it reads as a
  // gradient. (Slight overlap between segments hides hairline seams.)
  const stops = [[0, [229, 72, 77]], [0.5, [227, 161, 58]], [1, [56, 178, 126]]];
  const colourAt = t => {
    const i = t <= stops[1][0] ? 0 : 1;
    const [t0, c0] = stops[i], [t1, c1] = stops[i + 1];
    const k = (t - t0) / (t1 - t0);
    return 'rgb(' + c0.map((v, n) => Math.round(v + (c1[n] - v) * k)).join(',') + ')';
  };
  const SEG = 48;
  let arcs = '';
  for (let i = 0; i < SEG; i++){
    const from = (i / SEG) * 100, to = Math.min(100, ((i + 1) / SEG) * 100 + 0.6);
    arcs += `<path d="${describeArc(cx, cy, r, toAngle(from), toAngle(to))}" stroke="${colourAt((i + 0.5) / SEG)}" stroke-width="${sw}" fill="none" stroke-linecap="butt"/>`;
  }
  const tip = polarToCartesian(cx, cy, r - sw/2 - 6, toAngle(pct));
  const pctLabel = max > 0 ? Math.round(pct) + '%' : '—';
  return `
    <svg viewBox="0 0 200 130" style="width:100%; max-width:220px;">
      ${arcs}
      <text x="${cx - r}" y="${cy + 16}" text-anchor="middle" font-size="9" fill="var(--muted)" font-family="var(--sans)">0</text>
      <text x="${cx + r}" y="${cy + 16}" text-anchor="middle" font-size="9" fill="var(--muted)" font-family="var(--sans)">100</text>
      <line x1="${cx}" y1="${cy}" x2="${tip.x}" y2="${tip.y}" stroke="var(--text)" stroke-width="3" stroke-linecap="round"/>
      <circle cx="${cx}" cy="${cy}" r="6" fill="var(--text)"/>
      <text x="${cx}" y="${cy + 30}" text-anchor="middle" font-size="18" font-weight="800" fill="var(--text)" font-family="var(--sans)">${pctLabel}</text>
    </svg>
    <div style="text-align:center; font-family:var(--sans); font-weight:700; font-size:12.5px; margin-top:-6px;">${title}</div>
    <div class="result-meta" style="text-align:center;">${value} / ${max}</div>
  `;
}

// Every checkpoint on a route counts as one "expected tag" per round; a round only
// counts toward "expected" once it's actually due (not while still "upcoming") so
// the numbers reflect what should have happened by now, not the whole shift ahead.
function computeSiteShiftStats(site){
  const shiftStart = currentShiftStart(nowMs());
  const now = nowMs();
  const siteRouteIds = new Set(routes.filter(r => r.siteId === site.id && r.active !== false).map(r => r.id));
  const siteScheds = schedules.filter(s => siteRouteIds.has(s.routeId) && isScheduleLive(s));

  // "Due" figures (expected*) only count rounds whose start time has passed — they drive
  // the SLA bands so a site isn't marked down for rounds still to come. "Shift" figures
  // (shift*) count every round scheduled across the whole shift, e.g. an hourly patrol of
  // 5 tags over a 6-hour night = 6 patrols and 30 tags, shown as done/total.
  const shiftEnd = shiftStart + 12 * 60 * 60 * 1000;
  let expectedTags = 0, expectedPatrols = 0, completedPatrols = 0;
  let shiftPatrols = 0, shiftPatrolsDone = 0, shiftTags = 0, shiftTagsDone = 0;
  siteScheds.forEach(sched => {
    const route = routes.find(r => r.id === sched.routeId);
    const cpCount = route ? route.cpIds.length : 0;
    generateInstances(sched, shiftStart, shiftEnd - 1).forEach(inst => {
      const st = instanceStatus(inst, now);
      shiftPatrols++;
      shiftTags += cpCount;
      shiftTagsDone += Math.min(st.doneCps.length, cpCount);
      if (st.status === 'completed' || st.status === 'completed_late') shiftPatrolsDone++;
    });
    const insts = generateInstances(sched, shiftStart, now).filter(i => i.expectedTime <= now);
    insts.forEach(inst => {
      expectedPatrols++;
      expectedTags += cpCount;
      const st = instanceStatus(inst, now);
      if (st.status === 'completed' || st.status === 'completed_late') completedPatrols++;
    });
  });

  const acceptedTags = scans.filter(s => s.siteId === site.id && (s.result === 'ACCEPTED' || s.result === 'SKIPPED') && s.timestamp >= shiftStart).length;   // skipped tags are excused, so they count as done
  const pct = expectedTags > 0 ? Math.min(100, (acceptedTags / expectedTags) * 100) : null;
  return { site, expectedTags, acceptedTags, expectedPatrols, completedPatrols, pct, shiftPatrols, shiftPatrolsDone, shiftTags, shiftTagsDone };
}

let overviewSelectedBand = { admin: null, ctrl: null };

function renderSiteOverview(who){
  const gaugesEl = document.getElementById(who + 'OverviewGauges');
  if (!gaugesEl) return;

  const perSite = sites.map(computeSiteShiftStats);
  // Gauges show progress against the whole shift's schedule (done / total for the shift).
  const totalExpectedTags = perSite.reduce((a, s) => a + s.shiftTags, 0);
  const totalAcceptedTags = perSite.reduce((a, s) => a + s.shiftTagsDone, 0);
  const totalExpectedPatrols = perSite.reduce((a, s) => a + s.shiftPatrols, 0);
  const totalCompletedPatrols = perSite.reduce((a, s) => a + s.shiftPatrolsDone, 0);

  gaugesEl.innerHTML = `
    <div>${buildGaugeSVG(totalAcceptedTags, totalExpectedTags, 'Tags scanned this shift')}</div>
    <div>${buildGaugeSVG(totalCompletedPatrols, totalExpectedPatrols, 'Patrols completed this shift')}</div>
  `;

  const slaInput = document.getElementById(who + 'OverviewSlaInput');
  // NaN-safe: an empty or non-numeric field falls back to 90 rather than
  // silently becoming 0 (which `Number(x) || 90` would do, since 0 is falsy).
  const rawSla = Number(slaInput.value);
  const sla = Math.max(1, Math.min(100, Number.isFinite(rawSla) && slaInput.value !== '' ? rawSla : 90));

  const rated = perSite.filter(s => s.pct !== null);
  // Each fixed breakpoint (25/50/75) is clamped to never exceed the SLA
  // threshold itself — otherwise, setting the threshold below 75% would make
  // the 50–75% band and the "passing" band overlap, double-counting any site
  // that falls in the overlap into two slices at once.
  const b1 = Math.min(25, sla), b2 = Math.min(50, sla), b3 = Math.min(75, sla);
  const bands = [
    { label: `0–${b1}%`, from: 0, to: b1, color: '#E5484D' },
    { label: `${b1}–${b2}%`, from: b1, to: b2, color: '#D9822B' },
    { label: `${b2}–${b3}%`, from: b2, to: b3, color: '#E3A13A' },
    { label: `${b3}–${sla}%`, from: b3, to: sla, color: '#9CBF66' },
    { label: `${sla}–100% (passing)`, from: sla, to: 100.0001, color: '#38B27E' }
  ].filter(b => b.to > b.from); // collapses any band a lower SLA threshold makes redundant

  const bandSites = bands.map(b => rated.filter(s => s.pct >= b.from && s.pct < b.to));
  const belowSlaCount = rated.filter(s => s.pct < sla).length;

  const donutEl = document.getElementById(who + 'OverviewDonutWrap');
  if (!rated.length){
    donutEl.innerHTML = '<div class="result-meta">No sites have a scheduled patrol due yet this shift.</div>';
  } else {
    const cx = 110, cy = 110, r = 88, sw = 34;
    let cursor = 0;
    const slices = bands.map((b, i) => {
      const count = bandSites[i].length;
      // Capped just under 360° — an SVG arc command can't actually draw a
      // full circle (its start and end point are mathematically the same
      // spot), so a band holding 100% of sites would otherwise render as an
      // invisible zero-length arc instead of a full ring.
      const sweep = rated.length ? Math.min((count / rated.length) * 360, 359.9) : 0;
      const path = count > 0 ? `<path data-band="${i}" d="${describeArc(cx, cy, r, cursor, cursor + Math.max(sweep, 0.01))}" stroke="${b.color}" stroke-width="${sw}" fill="none" style="cursor:pointer; opacity:${overviewSelectedBand[who] === i || overviewSelectedBand[who] == null ? '1' : '0.35'};"/>` : '';
      cursor += sweep;
      return path;
    }).join('');
    donutEl.innerHTML = `
      <svg viewBox="0 0 220 220" style="width:100%; max-width:260px;">
        ${slices}
        <text x="${cx}" y="${cy - 6}" text-anchor="middle" font-size="26" font-weight="800" fill="var(--text)" font-family="var(--sans)">${belowSlaCount}</text>
        <text x="${cx}" y="${cy + 16}" text-anchor="middle" font-size="11" fill="var(--muted)" font-family="var(--sans)">below ${sla}% SLA</text>
      </svg>
    `;
    donutEl.querySelectorAll('[data-band]').forEach(el => {
      el.addEventListener('click', () => {
        const idx = Number(el.dataset.band);
        overviewSelectedBand[who] = overviewSelectedBand[who] === idx ? null : idx;
        renderSiteOverview(who);
      });
    });
  }

  const detailEl = document.getElementById(who + 'OverviewBandDetail');
  const legendHtml = bands.map((b, i) => `
    <div data-band-legend="${i}" style="display:flex; align-items:center; gap:6px; padding:5px 8px; border-radius:8px; cursor:pointer; background:${overviewSelectedBand[who] === i ? 'var(--panel-2)' : 'transparent'};">
      <span style="width:10px; height:10px; border-radius:3px; background:${b.color}; flex:0 0 auto;"></span>
      <span class="result-meta" style="color:var(--text);">${b.label}</span>
      <span class="result-meta">(${bandSites[i].length})</span>
    </div>
  `).join('');

  const shown = overviewSelectedBand[who] != null ? bandSites[overviewSelectedBand[who]] : null;
  const notRated = perSite.filter(s => s.pct === null);
  detailEl.innerHTML = `
    <div style="display:flex; flex-wrap:wrap; gap:4px; margin-bottom:10px;">${legendHtml}</div>
    ${shown ? `
      <div class="attendance-card" style="margin:0;">
        ${shown.length ? shown.map(s => `
          <div style="display:flex; justify-content:space-between; padding:4px 0; font-size:12.5px; font-family:var(--sans);">
            <span>${s.site.name}</span>
            <span class="result-meta">${s.shiftPatrolsDone}/${s.shiftPatrols} patrols, ${s.shiftTagsDone}/${s.shiftTags} tags this shift (${Math.round(s.pct)}% of what's due so far)</span>
          </div>
        `).join('') : '<div class="result-meta">No sites in this band.</div>'}
      </div>
    ` : ''}
    ${notRated.length ? `<div class="result-meta" style="margin-top:10px;">${notRated.length} site${notRated.length === 1 ? '' : 's'} not shown — no patrol due yet this shift: ${notRated.map(s => s.site.name).join(', ')}</div>` : ''}
  `;
  detailEl.querySelectorAll('[data-band-legend]').forEach(el => {
    el.addEventListener('click', () => {
      const idx = Number(el.dataset.bandLegend);
      overviewSelectedBand[who] = overviewSelectedBand[who] === idx ? null : idx;
      renderSiteOverview(who);
    });
  });
}

['admin','ctrl'].forEach(who => {
  const slaEl = document.getElementById(who + 'OverviewSlaInput');
  if (slaEl) slaEl.addEventListener('change', () => renderSiteOverview(who));
});

// Controller's tiles reset at each shift boundary, and the alert-related ones count
// down in real time as the controller clears them — separate from the admin's
// lifetime scan tiles in renderStats() above.
function renderControllerStats(){
  const totalEl = document.getElementById('ctrlStatTotal');
  if (!totalEl) return;
  const now = nowMs();
  const shiftStart = currentShiftStart(now);
  const shiftScans = scans.filter(s => s.timestamp >= shiftStart);
  const total = shiftScans.length;
  const accepted = shiftScans.filter(s => s.result === 'ACCEPTED').length;
  const activeRejected = notifications.filter(n =>
    !n.cleared_at && (n.severity === 'red' || n.severity === 'orange') && new Date(n.occurred_at).getTime() >= shiftStart
  ).length;
  const activeAlerts = notifications.filter(n =>
    !n.cleared_at && n.kind === 'radius_alert' && new Date(n.occurred_at).getTime() >= shiftStart
  ).length;
  setTextIf('ctrlStatTotal', total);
  setTextIf('ctrlStatAccepted', accepted);
  setTextIf('ctrlStatRejected', activeRejected);
  setTextIf('ctrlStatAlerts', activeAlerts);
  paintKpis();

  const label = document.getElementById('ctrlShiftLabel');
  if (label){
    const shiftName = isDayShift(now) ? 'Day shift' : 'Night shift';
    const resetsAt = isDayShift(now) ? '18:00' : '06:00';
    label.innerHTML = `<b>${shiftName}</b> · resets at ${resetsAt} · counters cover this shift only`;
  }
}

function renderLog(){
  // Shift-scoped, same as the controller's counter tiles — day shift 06:00–18:00,
  // night shift 18:00–06:00 — so the feed only ever shows the shift underway.
  const shiftStart = currentShiftStart(nowMs());
  const shiftScans = scans.filter(s => s.timestamp >= shiftStart);
  const html = shiftScans.length === 0
    ? '<div class="empty">No scans yet this shift.</div>'
    : shiftScans.slice().reverse().slice(0, 200).map(s => {
      const cls = s.result === 'ACCEPTED' ? 'accepted' : s.result === 'SKIPPED' ? 'skipped' : 'rejected';
      const time = new Date(s.timestamp).toLocaleTimeString([], { hour12: false });
      const site = sites.find(x => x.id === s.siteId);
      return `
        <div class="log-entry feed-row">
          <div class="feed-time">${time}</div>
          <div class="log-bar ${cls}"></div>
          <div class="log-main">
            <div class="log-top">
              <span class="feed-title">${escapeHtmlForPrint(site ? site.name : 'Unknown site')} <span class="feed-sep">·</span> ${escapeHtmlForPrint(s.cpName || 'unknown')}</span>
              <span class="badge ${cls}">${uiScanResultLabel(s.result)}</span>
            </div>
            <div class="log-sub">${escapeHtmlForPrint(s.qrId)}${s.result === 'SKIPPED' ? ' · ' + escapeHtmlForPrint(skipReasonLabel(s.skipReason)) : ''}${s.distance != null ? ' · ' + s.distance.toFixed(0) + 'm from checkpoint' : ''}${s.result === 'REJECTED_OUT_OF_ORDER' && s.expectedQrId ? ` · expected ${escapeHtmlForPrint(s.expectedQrId)} next` : ''}</div>
          </div>
        </div>
      `;
    }).join('');
  ['logWrap','ctrlLogWrap'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  });
  uiAfterScans();
}

function renderGuardSiteName(){
  const el = document.getElementById('guardSiteName');
  if (!el) return;
  const s = sites.find(s => s.id === (activeDutySiteId || guardSiteId));
  el.textContent = s ? s.name : '—';
}

function renderRouteBuilder(){
  const avail = document.getElementById('routeCpAvailable');
  const scoped = checkpoints.filter(c => c.siteId === activeSiteId);
  avail.innerHTML = scoped.map(c => `
    <button type="button" class="btn" data-add-order-cp="${c.qrId}" style="width:auto; padding:6px 10px; font-size:11px; ${routeBuilderOrder.includes(c.qrId) ? 'opacity:0.35; pointer-events:none;' : ''}">+ ${c.qrId} — ${c.name}</button>
  `).join('') || '<span style="font-size:12px; color:var(--muted); font-family:var(--sans);">No checkpoints at this site yet.</span>';
  avail.querySelectorAll('[data-add-order-cp]').forEach(btn => {
    btn.addEventListener('click', () => {
      routeBuilderOrder.push(btn.dataset.addOrderCp);
      renderRouteBuilder();
    });
  });

  const listEl = document.getElementById('routeCpOrderList');
  listEl.innerHTML = routeBuilderOrder.length ? routeBuilderOrder.map((id, i) => {
    const cp = checkpoints.find(c => c.qrId === id);
    return `
      <div style="display:flex; align-items:center; gap:8px; background:var(--panel-2); border:1px solid var(--border); border-radius:8px; padding:6px 10px; font-size:12px; font-family:var(--mono);">
        <span style="color:var(--accent); font-weight:700;">${i+1}.</span>
        <span style="flex:1;">${id} — ${cp ? cp.name : '?'}</span>
        <button type="button" class="del-btn" data-order-up="${i}" title="Move earlier" ${i===0?'disabled':''}>↑</button>
        <button type="button" class="del-btn" data-order-down="${i}" title="Move later" ${i===routeBuilderOrder.length-1?'disabled':''}>↓</button>
        <button type="button" class="del-btn" data-order-remove="${i}" title="Remove">&times;</button>
      </div>
    `;
  }).join('') : '<span style="font-size:12px; color:var(--muted); font-family:var(--sans);">Tap checkpoints above to build the route, in order.</span>';

  listEl.querySelectorAll('[data-order-up]').forEach(btn => btn.addEventListener('click', () => {
    const i = parseInt(btn.dataset.orderUp);
    if (i > 0){ [routeBuilderOrder[i-1], routeBuilderOrder[i]] = [routeBuilderOrder[i], routeBuilderOrder[i-1]]; renderRouteBuilder(); }
  }));
  listEl.querySelectorAll('[data-order-down]').forEach(btn => btn.addEventListener('click', () => {
    const i = parseInt(btn.dataset.orderDown);
    if (i < routeBuilderOrder.length - 1){ [routeBuilderOrder[i+1], routeBuilderOrder[i]] = [routeBuilderOrder[i], routeBuilderOrder[i+1]]; renderRouteBuilder(); }
  }));
  listEl.querySelectorAll('[data-order-remove]').forEach(btn => btn.addEventListener('click', () => {
    routeBuilderOrder.splice(parseInt(btn.dataset.orderRemove), 1);
    renderRouteBuilder();
  }));
}

async function persistRouteOrder(route){
  const checkpointIds = route.cpIds.map(qrId => {
    const cp = checkpoints.find(c => c.qrId === qrId);
    return cp ? cp.id : null;
  }).filter(Boolean);
  const { error } = await sb.rpc('reorder_route_checkpoints', { p_route_id: route.id, p_checkpoint_ids: checkpointIds });
  if (error) showToast('Could not save new order', error.message, 'danger');
  else showToast('Order saved', `${route.name} checkpoint order updated.`, 'success');
}

function renderRouteTable(){
  const body = document.getElementById('routeTableBody');
  const scoped = routes.filter(r => r.siteId === activeSiteId);
  if (scoped.length === 0){
    body.innerHTML = '<tr><td colspan="4" style="font-family:var(--sans); color:var(--muted);">No routes yet.</td></tr>';
    return;
  }
  body.innerHTML = scoped.map(r => `
    <tr${r.active === false ? ' style="opacity:0.55;"' : ''}>
      <td style="font-family:var(--sans);">${r.name}${r.active === false ? ' <span class="result-meta">(off)</span>' : ''}</td>
      <td>
        <div style="display:flex; flex-direction:column; gap:4px;">
        ${r.cpIds.map((id,i) => `
          <span style="display:flex; align-items:center; gap:4px;">
            <b style="color:var(--accent);">${i+1}.</b> ${id}
            <button type="button" class="del-btn" data-route-cp-up="${r.id}:${i}" title="Move earlier" ${i===0?'disabled':''} style="font-size:11px;">↑</button>
            <button type="button" class="del-btn" data-route-cp-down="${r.id}:${i}" title="Move later" ${i===r.cpIds.length-1?'disabled':''} style="font-size:11px;">↓</button>
          </span>
        `).join('') || '—'}
        </div>
      </td>
      <td>
        <label class="switch" title="${r.strictOrder ? 'Strict order' : 'Flexible order'}">
          <input type="checkbox" class="route-order-toggle" data-route-order="${r.id}" ${r.strictOrder ? 'checked' : ''}>
          <span class="slider-tog"></span>
        </label>
        <div class="result-meta" style="margin-top:2px;">${r.strictOrder ? 'Strict' : 'Flexible'}</div>
      </td>
      <td>
        <label class="switch" title="${r.active === false ? 'Route is off — no patrols expected' : 'Route is on'}">
          <input type="checkbox" class="route-active-toggle" data-route-active="${r.id}" ${r.active !== false ? 'checked' : ''}>
          <span class="slider-tog"></span>
        </label>
        <div class="result-meta" style="margin-top:2px;">${r.active === false ? 'Off' : 'On'}</div>
      </td>
      <td><button class="del-btn" data-del-route="${r.id}" aria-label="Delete route"><i>&times;</i></button></td>
    </tr>
  `).join('');
  body.querySelectorAll('[data-route-cp-up]').forEach(btn => btn.addEventListener('click', () => {
    const [routeId, idxStr] = btn.dataset.routeCpUp.split(':');
    const idx = parseInt(idxStr);
    const r = routes.find(rt => rt.id === routeId);
    if (r && idx > 0){
      [r.cpIds[idx-1], r.cpIds[idx]] = [r.cpIds[idx], r.cpIds[idx-1]];
      renderAll();
      persistRouteOrder(r);
    }
  }));
  body.querySelectorAll('[data-route-cp-down]').forEach(btn => btn.addEventListener('click', () => {
    const [routeId, idxStr] = btn.dataset.routeCpDown.split(':');
    const idx = parseInt(idxStr);
    const r = routes.find(rt => rt.id === routeId);
    if (r && idx < r.cpIds.length - 1){
      [r.cpIds[idx+1], r.cpIds[idx]] = [r.cpIds[idx], r.cpIds[idx+1]];
      renderAll();
      persistRouteOrder(r);
    }
  }));
  body.querySelectorAll('.route-order-toggle').forEach(tog => tog.addEventListener('change', async e => {
    const r = routes.find(rt => rt.id === e.target.dataset.routeOrder);
    if (!r) return;
    const prev = r.strictOrder;
    r.strictOrder = e.target.checked;
    const { error } = await sb.from('routes').update({ strict_order: e.target.checked }).eq('id', r.id);
    if (error){ r.strictOrder = prev; e.target.checked = prev; showToast('Could not update order mode', error.message, 'danger'); }
    else showToast('Route updated', `${r.name} now ${e.target.checked ? 'requires' : "doesn't require"} checkpoints in strict order.`, 'success');
  }));
  body.querySelectorAll('.route-active-toggle').forEach(tog => tog.addEventListener('change', async e => {
    const r = routes.find(rt => rt.id === e.target.dataset.routeActive);
    if (!r) return;
    const prev = r.active;
    r.active = e.target.checked;
    const { error } = await sb.from('routes').update({ active: e.target.checked }).eq('id', r.id);
    if (error){
      r.active = prev; e.target.checked = prev;
      showToast('Could not update route', error.message, 'danger');
      return;
    }
    showToast('Route updated', e.target.checked ? `${r.name} is on — its schedules resume.` : `${r.name} is off — no patrols expected while it's off.`, 'success');
    renderRouteTable();
    renderAll();
  }));
  body.querySelectorAll('[data-del-route]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const r = routes.find(rt => rt.id === btn.dataset.delRoute);
      if (!confirm(`Delete route "${r ? r.name : ''}"? Any schedules using this route will also stop working. This can't be undone.`)) return;
      const { error } = await sb.from('routes').delete().eq('id', btn.dataset.delRoute);
      if (error){ showToast('Could not delete route', error.message, 'danger'); return; }
      showToast('Route deleted', r ? `${r.name} was removed.` : '', 'success');
      await loadAllData();
      renderAll();
    });
  });
}

function renderSiteSwitchers(){
  const opts = sites.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
  ['siteQuickSwitchCp','siteQuickSwitchManage','siteQuickSwitchPatrols','siteQuickSwitchAlerts','ctrlSiteSwitch'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = opts;
    el.value = activeSiteId;
  });
}

function renderTeamTable(){
  const body = document.getElementById('teamTableBody');
  if (!body) return;
  populateFilterSiteSelect('teamSiteFilter', teamSiteFilterVal);
  const q = (document.getElementById('teamSearch').value || '').toLowerCase().trim();
  const siteFilter = document.getElementById('teamSiteFilter').value;
  const roleFilter = document.getElementById('teamRoleFilter').value;

  let rows = teamDirectory.slice();
  if (siteFilter) rows = rows.filter(p => p.site_id === siteFilter);
  if (roleFilter) rows = rows.filter(p => p.role === roleFilter);
  if (q) rows = rows.filter(p =>
    (p.full_name || '').toLowerCase().includes(q) || (p.employee_number || '').toLowerCase().includes(q)
  );

  if (!rows.length){
    body.innerHTML = `<tr><td colspan="5" style="font-family:var(--sans); color:var(--muted);">${teamDirectory.length ? 'No one matches this search/filter.' : 'No team members yet.'}</td></tr>`;
    return;
  }
  body.innerHTML = rows.map(p => {
    const site = sites.find(s => s.id === p.site_id);
    return `
      <tr>
        <td style="font-family:var(--sans); font-weight:600;">${escapeHtmlForPrint(p.full_name || '—')}</td>
        <td><span class="role-pill">${escapeHtmlForPrint(p.role)}</span></td>
        <td>${escapeHtmlForPrint(site ? site.name : '—')}</td>
        <td>${escapeHtmlForPrint(p.phone || '—')}</td>
        <td>${escapeHtmlForPrint(p.employee_number || '—')}</td>
      </tr>
    `;
  }).join('');
}

let teamSiteFilterVal = '';
document.getElementById('teamSearch').addEventListener('input', renderTeamTable);
document.getElementById('teamSiteFilter').addEventListener('change', e => { teamSiteFilterVal = e.target.value; renderTeamTable(); });
document.getElementById('teamRoleFilter').addEventListener('change', renderTeamTable);

