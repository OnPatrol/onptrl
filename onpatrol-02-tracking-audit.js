// ============================================================
// Site phone numbers + live tracking
// ============================================================
function cleanPhone(raw){ return String(raw || '').trim().replace(/\s+/g, ' '); }
function phoneDigits(raw){ return String(raw || '').replace(/[^\d]/g, ''); }
function isValidPhone(raw){
  const t = cleanPhone(raw), d = phoneDigits(t);
  return d.length >= 7 && d.length <= 15 && /^\+?[\d\s\-().]+$/.test(t);
}
function telHref(raw){ const t = cleanPhone(raw); return 'tel:' + (t.startsWith('+') ? '+' : '') + phoneDigits(t); }
function phoneLinkHtml(raw){ return `<a href="${telHref(raw)}" style="color:inherit; font-weight:600;">${escapeHtmlForPrint(cleanPhone(raw))}</a>`; }
function sitePhoneOf(siteId){ const s = sites.find(x => x.id === siteId); return s && s.phone ? s.phone : ''; }

// ---------------- Live tracking: control-room side (admin + controller) ----------------
const TRACK_MINUTES = 30;
const TRACK_FRESH_MS = 90 * 1000;   // a position older than this is shown as "no recent signal"
const trk = { prefix: null, siteId: null, map: null, layer: null, requests: [], devices: [], trails: new Map(), timer: null, channel: null, follow: true, fitted: false, wired: {} };
const trkEl = id => document.getElementById(id);

function trackingMarkup(p){
  return `
    <div class="track-grid">
      <div class="panel">
        <h2>Live tracking</h2>
        <div class="cp-row"><input type="text" id="${p}TrackSearch" placeholder="Search sites to live track…"></div>
        <div class="result-meta" style="margin:2px 0 12px;">Live tracking asks a site's phone to share where it is while the app is open on its screen. The phone shows a "Live tracking is on" notice, and it stops by itself after ${TRACK_MINUTES} minutes.</div>
        <div id="${p}TrackSiteList" class="track-site-list"></div>
      </div>
      <div class="panel" id="${p}TrackPanel" style="display:none;">
        <div class="track-head">
          <div style="min-width:0;">
            <div id="${p}TrackTitle" style="font-weight:700; font-size:15px;"></div>
            <div id="${p}TrackPhone" class="result-meta"></div>
          </div>
          <span class="st st-info" id="${p}TrackStatus"></span>
        </div>
        <div id="${p}TrackMap" class="track-map"></div>
        <div id="${p}TrackInfo" class="result-meta" style="margin-top:8px;"></div>
        <div class="btn-row" style="margin-top:10px; flex-wrap:wrap;">
          <button class="btn btn-primary" id="${p}TrackStartBtn" style="width:auto; padding:9px 14px;">Start tracking</button>
          <button class="btn" id="${p}TrackExtendBtn" style="width:auto; padding:9px 14px;">Extend ${TRACK_MINUTES} min</button>
          <button class="btn" id="${p}TrackStopBtn" style="width:auto; padding:9px 14px;">Stop</button>
          <button class="btn" id="${p}TrackFollowBtn" style="width:auto; padding:9px 14px;">Following</button>
        </div>
      </div>
    </div>`;
}
function initTrackingViews(){
  ['ctrl', 'admin'].forEach(p => { const el = trkEl(p + '-tracking'); if (el && !el.innerHTML.trim()) el.innerHTML = trackingMarkup(p); });
}
function trackingSiteState(siteId){
  const req = trk.requests.find(r => r.site_id === siteId);
  if (!req) return 'off';
  const fresh = trk.devices.some(d => d.site_id === siteId && Date.now() - new Date(d.updated_at).getTime() < TRACK_FRESH_MS);
  return fresh ? 'live' : 'waiting';
}
function trackingViewOpened(p){
  initTrackingViews();
  trk.prefix = p;
  if (!trk.wired[p]){
    trk.wired[p] = true;
    trkEl(p + 'TrackSearch').addEventListener('input', renderTrackingList);
    trkEl(p + 'TrackSiteList').addEventListener('click', e => {
      const b = e.target.closest('[data-track-open]');
      if (b) openTrackingSite(b.dataset.trackOpen, b.dataset.trackStart === '1');
    });
    trkEl(p + 'TrackStartBtn').addEventListener('click', () => trk.siteId && startTracking(trk.siteId));
    trkEl(p + 'TrackStopBtn').addEventListener('click', () => trk.siteId && stopTracking(trk.siteId));
    trkEl(p + 'TrackExtendBtn').addEventListener('click', () => trk.siteId && extendTracking(trk.siteId));
    trkEl(p + 'TrackFollowBtn').addEventListener('click', () => { trk.follow = !trk.follow; trackingPanelUi(); if (trk.follow) renderTrackingMap(true); });
  }
  if (!teamDirectory.length) loadTeamDirectory();
  renderTrackingList();
  trackingTick();
  if (!trk.timer) trk.timer = setInterval(trackingTick, 4000);
}
async function trackingTick(){
  const p = trk.prefix;
  if (!p) return;
  const listEl = trkEl(p + 'TrackSiteList');
  if (!listEl || listEl.offsetParent === null) return;    // the tracking screen is not showing
  const r = await withTimeout(sb.from('tracking_requests').select('*').is('stopped_at', null).gt('expires_at', new Date().toISOString()), 8000);
  if (!r.error) trk.requests = r.data || [];
  const siteIds = [...new Set(trk.requests.map(x => x.site_id))];
  if (siteIds.length){
    const d = await withTimeout(sb.from('device_locations').select('*').in('site_id', siteIds), 8000);
    if (!d.error) trk.devices = d.data || [];
  } else trk.devices = [];
  renderTrackingList();
  trackingPanelUi();
  renderTrackingMap(false);
}
function renderTrackingList(){
  const p = trk.prefix; if (!p) return;
  const el = trkEl(p + 'TrackSiteList'); if (!el) return;
  const q = (trkEl(p + 'TrackSearch').value || '').trim().toLowerCase();
  const list = sites.filter(s => !q || [s.name, s.address, s.phone, s.siteCode].some(v => String(v || '').toLowerCase().includes(q)));
  if (!list.length){ el.innerHTML = '<div class="result-meta">No sites match.</div>'; return; }
  el.innerHTML = list.map(s => {
    const st = trackingSiteState(s.id);
    const chip = st === 'live' ? '<span class="st st-success">Live</span>' : st === 'waiting' ? '<span class="st st-warn">Waiting for phone</span>' : '';
    return `
      <div class="site-contact-row track-site${trk.siteId === s.id ? ' selected' : ''}">
        <div style="flex:1; min-width:0;">
          <div class="site-contact-name">${escapeHtmlForPrint(s.name)}</div>
          <div class="result-meta">${escapeHtmlForPrint(s.address && s.address !== '—' ? s.address : '')}${s.phone ? ' · ' + escapeHtmlForPrint(s.phone) : ' · <span style="color:var(--warn);">no phone set</span>'}</div>
        </div>
        ${chip}
        <button class="btn ${st === 'off' ? 'btn-primary' : ''}" data-track-open="${s.id}" ${st === 'off' ? 'data-track-start="1"' : ''} style="width:auto; padding:6px 12px; font-size:12px;">${st === 'off' ? 'Track' : 'View'}</button>
      </div>`;
  }).join('');
}
function trackingPanelUi(){
  const p = trk.prefix; if (!p || !trk.siteId) return;
  const s = sites.find(x => x.id === trk.siteId);
  const st = trackingSiteState(trk.siteId);
  trkEl(p + 'TrackTitle').textContent = s ? s.name : 'Site';
  trkEl(p + 'TrackPhone').innerHTML = s && s.phone ? `Site phone: ${phoneLinkHtml(s.phone)}` : '<span style="color:var(--warn);">No site phone set</span>';
  const chip = trkEl(p + 'TrackStatus');
  chip.className = 'st ' + (st === 'live' ? 'st-success' : st === 'waiting' ? 'st-warn' : 'st-info');
  chip.textContent = st === 'live' ? 'Live' : st === 'waiting' ? 'Waiting for phone' : 'Not tracking';
  trkEl(p + 'TrackStartBtn').style.display = st === 'off' ? '' : 'none';
  trkEl(p + 'TrackExtendBtn').style.display = st === 'off' ? 'none' : '';
  trkEl(p + 'TrackStopBtn').style.display = st === 'off' ? 'none' : '';
  trkEl(p + 'TrackFollowBtn').textContent = trk.follow ? 'Following' : 'Follow';
  const req = trk.requests.find(r => r.site_id === trk.siteId);
  const devs = trk.devices.filter(d => d.site_id === trk.siteId);
  let info = '';
  if (st === 'off') info = 'Tracking is off for this site. Press Start tracking to ask its phone to share its location.';
  else {
    const mins = req ? Math.max(0, Math.round((new Date(req.expires_at).getTime() - Date.now()) / 60000)) : 0;
    info = devs.length
      ? devs.map(d => {
          const name = (teamDirectory.find(u => u.id === d.user_id) || {}).full_name || 'Phone';
          const age = Math.max(0, Math.round((Date.now() - new Date(d.updated_at).getTime()) / 1000));
          const bits = [`updated ${age < 60 ? age + 's' : Math.round(age / 60) + 'm'} ago`];
          if (d.accuracy_m != null) bits.push(`±${Math.round(d.accuracy_m)} m`);
          if (d.speed_mps != null && d.speed_mps > 0.5) bits.push(`${Math.round(d.speed_mps * 3.6)} km/h`);
          if (d.battery_pct != null) bits.push(`battery ${d.battery_pct}%`);
          return `<b>${escapeHtmlForPrint(name)}</b> · ${bits.join(' · ')}`;
        }).join('<br>')
      : 'Waiting for the phone. It must have the app open on its screen with a signal. It usually starts within 10 seconds.';
    info += `<br>${req && req.silent ? 'Started automatically by the panic alert. ' : ''}Tracking ends in ${mins} min.`;
  }
  trkEl(p + 'TrackInfo').innerHTML = info;
}
function initTrackingMap(){
  const p = trk.prefix;
  const box = trkEl(p + 'TrackMap');
  if (trk.map && trk.map.getContainer() !== box){ trk.map.remove(); trk.map = null; }
  if (!trk.map){
    trk.map = L.map(box).setView([-26.2, 28.05], 6);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(trk.map);
    trk.layer = L.layerGroup().addTo(trk.map);
    trk.map.on('dragstart', () => { if (trk.follow){ trk.follow = false; trackingPanelUi(); } });
  }
  setTimeout(() => trk.map && trk.map.invalidateSize(), 60);
}
function renderTrackingMap(refit){
  if (!trk.map || !trk.siteId) return;
  trk.layer.clearLayers();
  const s = sites.find(x => x.id === trk.siteId);
  const pts = [];
  if (s && s.lat != null && s.lng != null){
    const ll = [Number(s.lat), Number(s.lng)];
    pts.push(ll);
    L.circleMarker(ll, { radius: 6, color: '#9ca3af', weight: 2, fillOpacity: 0.25 }).bindTooltip(s.name, { direction: 'bottom' }).addTo(trk.layer);
    if (Array.isArray(s.perimeter) && s.perimeter.length >= 3){
      L.polygon(s.perimeter.map(q => [q.lat, q.lng]), { color: '#9ca3af', weight: 1.5, fillOpacity: 0.05, dashArray: '4 4' }).addTo(trk.layer);
    }
  }
  const devs = trk.devices.filter(d => d.site_id === trk.siteId);
  let latest = null;
  devs.forEach(d => {
    const ll = [d.lat, d.lng];
    const stale = Date.now() - new Date(d.updated_at).getTime() > TRACK_FRESH_MS;
    const trail = trk.trails.get(d.user_id) || [];
    const last = trail[trail.length - 1];
    if (!last || last[0] !== ll[0] || last[1] !== ll[1]){ trail.push(ll); if (trail.length > 100) trail.shift(); trk.trails.set(d.user_id, trail); }
    if (trail.length > 1) L.polyline(trail, { color: stale ? '#9ca3af' : '#2563eb', weight: 3, opacity: 0.6 }).addTo(trk.layer);
    if (d.accuracy_m) L.circle(ll, { radius: d.accuracy_m, color: '#2563eb', weight: 1, fillOpacity: 0.08 }).addTo(trk.layer);
    const name = (teamDirectory.find(u => u.id === d.user_id) || {}).full_name || 'Phone';
    L.circleMarker(ll, { radius: 9, color: '#fff', weight: 3, fillColor: stale ? '#9ca3af' : '#2563eb', fillOpacity: 1 })
      .bindTooltip(escapeHtmlForPrint(name) + (stale ? ' · no recent signal' : ''), { permanent: true, direction: 'top', offset: [0, -10] }).addTo(trk.layer);
    pts.push(ll);
    latest = ll;
  });
  if (latest && trk.follow){
    if (!trk.fitted || refit){ trk.map.setView(latest, Math.max(trk.map.getZoom(), 17)); trk.fitted = true; }
    else trk.map.panTo(latest, { animate: true });
  } else if (!trk.fitted && pts.length){
    trk.map.setView(pts[0], 16);
    trk.fitted = true;
  }
}
function trackingSubscribe(siteId){
  if (trk.channel){ sb.removeChannel(trk.channel); trk.channel = null; }
  trk.channel = sb.channel('track-' + siteId + '-' + Date.now())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'device_locations', filter: `site_id=eq.${siteId}` }, payload => {
      const row = payload.new && payload.new.user_id ? payload.new : null;
      if (payload.eventType === 'DELETE'){ trk.devices = trk.devices.filter(d => d.user_id !== (payload.old || {}).user_id); }
      else if (row){ trk.devices = trk.devices.filter(d => !(d.site_id === row.site_id && d.user_id === row.user_id)).concat([row]); }
      trackingPanelUi(); renderTrackingMap(false);
    })
    .subscribe();
}
async function openTrackingSite(siteId, start){
  const p = trk.prefix; if (!p) return;
  trk.siteId = siteId; trk.follow = true; trk.fitted = false; trk.trails = new Map();
  trkEl(p + 'TrackPanel').style.display = '';
  initTrackingMap();
  trackingSubscribe(siteId);
  if (start) await startTracking(siteId); else await trackingTick();
  renderTrackingList(); trackingPanelUi(); renderTrackingMap(true);
  trkEl(p + 'TrackPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
async function startTracking(siteId){
  if (trk.requests.some(r => r.site_id === siteId)){ await trackingTick(); return; }
  const { error } = await sb.from('tracking_requests').insert({
    site_id: siteId, requested_by: session.user.id, expires_at: new Date(Date.now() + TRACK_MINUTES * 60000).toISOString()
  });
  if (error){ showToast('Could not start tracking', error.message, 'danger'); return; }
  showToast('Tracking requested', 'The phone starts sharing its location within about 10 seconds.', 'success');
  await trackingTick();
}
async function stopTracking(siteId){
  const { error } = await sb.from('tracking_requests').update({ stopped_at: new Date().toISOString() }).eq('site_id', siteId).is('stopped_at', null);
  if (error){ showToast('Could not stop tracking', error.message, 'danger'); return; }
  await sb.from('device_locations').delete().eq('site_id', siteId);
  trk.devices = trk.devices.filter(d => d.site_id !== siteId);
  showToast('Tracking stopped', '', 'success');
  await trackingTick();
}
async function extendTracking(siteId){
  const { error } = await sb.from('tracking_requests').update({ expires_at: new Date(Date.now() + TRACK_MINUTES * 60000).toISOString() }).eq('site_id', siteId).is('stopped_at', null);
  if (error){ showToast('Could not extend tracking', error.message, 'danger'); return; }
  showToast('Tracking extended', `Another ${TRACK_MINUTES} minutes.`, 'success');
  await trackingTick();
}
// Jump straight to a site's live tracking (used by the panic alert's "Live track" button).
function goToLiveTracking(siteId){
  const ws = trkEl('view-admin').classList.contains('active') ? 'admin' : 'ctrl';
  const btn = document.querySelector(ws === 'admin' ? '[data-admin-view="tracking"]' : '[data-ctrl-view="tracking"]');
  if (!btn) return;
  btn.click();
  setTimeout(() => openTrackingSite(siteId, true), 200);
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-track-site]');
  if (b){ e.preventDefault(); goToLiveTracking(b.dataset.trackSite); }
});

// ---------------- Live tracking: guard phone ----------------
// The phone only shares its location while a controller/admin has asked for it (the database rejects
// location updates otherwise), it says so on screen the whole time, and it stops by itself.
const gtrk = { active: false, silent: false, watchId: null, siteId: null, expiresAt: 0, lastSent: 0, wake: null, checking: false };
function guardTrackingIndicator(text){
  const el = document.getElementById('trackingIndicator');
  if (!el) return;
  el.textContent = text || '';
  el.style.display = text ? 'block' : 'none';
}
async function guardTrackingCheck(){
  if (!OFFLINE_ENABLED || !profile || profile.role !== 'guard' || !session || session.offline || gtrk.checking) return;
  if (document.hidden || offlineKnownDown()) return;
  const siteId = activeDutySiteId || guardSiteId;
  if (!siteId) return;
  gtrk.checking = true;
  try{
    const r = await withTimeout(sb.from('tracking_requests').select('*').eq('site_id', siteId).is('stopped_at', null)
      .gt('expires_at', new Date().toISOString()).order('requested_at', { ascending: false }).limit(1), 8000);
    if (r.error) return;
    const req = r.data && r.data[0];
    if (req) guardTrackingStart(req, siteId);
    else if (gtrk.active) guardTrackingStop();
  } finally { gtrk.checking = false; }
}
function guardTrackingStart(req, siteId){
  gtrk.expiresAt = new Date(req.expires_at).getTime();
  gtrk.siteId = siteId;
  // A session started by a panic alert is silent on the phone (no notice), so the guard is not put at risk.
  gtrk.silent = !!req.silent;
  if (gtrk.active){ if (gtrk.silent) guardTrackingIndicator(''); return; }
  if (!navigator.geolocation){ if (!gtrk.silent) guardTrackingIndicator('Live tracking was requested, but this phone cannot share its location.'); return; }
  gtrk.active = true;
  if (!gtrk.silent) guardTrackingIndicator('Live tracking is on — the control room can see this phone\'s location.');
  gtrk.watchId = navigator.geolocation.watchPosition(guardTrackingFix, err => {
    if (gtrk.silent) return;
    guardTrackingIndicator(err && err.code === 1
      ? 'Live tracking was requested, but location is blocked on this phone. Allow location for this site.'
      : 'Live tracking is on — waiting for a location fix…');
  }, { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 });
  guardTrackingWakeLock();
}
async function guardTrackingWakeLock(){
  try{ if (navigator.wakeLock && gtrk.active && !gtrk.wake) gtrk.wake = await navigator.wakeLock.request('screen'); if (gtrk.wake) gtrk.wake.addEventListener('release', () => { gtrk.wake = null; }); }catch(e){}
}
async function guardTrackingFix(pos){
  const now = Date.now();
  if (!gtrk.active) return;
  if (now > gtrk.expiresAt){ guardTrackingStop(); return; }
  if (now - gtrk.lastSent < 4000) return;
  gtrk.lastSent = now;
  if (!gtrk.silent) guardTrackingIndicator('Live tracking is on — the control room can see this phone\'s location.');
  let battery = null;
  try{ if (navigator.getBattery){ const b = await navigator.getBattery(); battery = Math.round(b.level * 100); } }catch(e){}
  const c = pos.coords;
  await sb.from('device_locations').upsert({
    site_id: gtrk.siteId, user_id: session.user.id, lat: c.latitude, lng: c.longitude,
    accuracy_m: c.accuracy != null ? c.accuracy : null, speed_mps: c.speed != null ? c.speed : null,
    heading_deg: c.heading != null ? c.heading : null, battery_pct: battery, updated_at: new Date().toISOString()
  }, { onConflict: 'site_id,user_id' });
}
function guardTrackingStop(){
  if (gtrk.watchId != null){ navigator.geolocation.clearWatch(gtrk.watchId); gtrk.watchId = null; }
  if (gtrk.wake){ try{ gtrk.wake.release(); }catch(e){} gtrk.wake = null; }
  const siteId = gtrk.siteId;
  gtrk.active = false;
  guardTrackingIndicator('');
  if (siteId && session) sb.from('device_locations').delete().eq('site_id', siteId).eq('user_id', session.user.id).then(() => {}, () => {});
}
setInterval(guardTrackingCheck, 10000);
document.addEventListener('visibilitychange', () => { if (!document.hidden){ guardTrackingCheck(); guardTrackingWakeLock(); } });

// ============================================================
// Audit trail (admin always; controller only if the admin has switched it on for this company):
// who did what, when - viewable and downloadable
// ============================================================

function auditPanelMarkup(prefix, showControllerToggle){
  const toggle = showControllerToggle ? `
    <div class="site-contact-row" style="margin-bottom:12px;">
      <div style="flex:1;">
        <div class="site-contact-name">Let controllers view this audit trail</div>
        <div class="result-meta">Controllers can already see everything they need to do their job. This only controls whether they can also open this trail (read-only - they can never edit or delete it either).</div>
      </div>
      <label class="switch"><input type="checkbox" id="${prefix}AuditControllerAccess"><span class="slider"></span></label>
    </div>` : '';
  return `
    <div class="result-meta" style="margin-bottom:12px;">A permanent record of who did what, and when, across your company: changes to sites, routes and people, alerts and panic, incidents, attendance, downloads and sign-ins. Entries can't be edited or deleted, and each is chained to the one before it, so any tampering shows up.</div>
    ${toggle}
    <div class="inline-fields">
      <div class="f"><label>From</label><input type="date" id="${prefix}AuditFrom"></div>
      <div class="f"><label>To</label><input type="date" id="${prefix}AuditTo"></div>
      <div class="f"><label>Site</label><select id="${prefix}AuditSite"><option value="">All sites</option></select></div>
      <div class="f"><label>Person</label><select id="${prefix}AuditActor"><option value="">Everyone</option></select></div>
      <div class="f"><label>Type</label><select id="${prefix}AuditType"><option value="">Everything</option></select></div>
      <div class="f"><label>Search</label><input type="text" id="${prefix}AuditSearch" placeholder="e.g. phone, panic, a name"></div>
    </div>
    <div class="btn-row" style="margin-top:10px; flex-wrap:wrap;">
      <button class="btn btn-primary" id="${prefix}AuditShowBtn" style="width:auto; padding:9px 14px;">Show</button>
      <button class="btn" id="${prefix}AuditCsvBtn" style="width:auto; padding:9px 14px;"><svg class="icon" viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 19h16"/></svg> Download CSV</button>
      <button class="btn" id="${prefix}AuditPrintBtn" style="width:auto; padding:9px 14px;"><svg class="icon" viewBox="0 0 24 24"><path d="M6 9V3h12v6"/><rect x="4" y="9" width="16" height="8" rx="1.5"/><path d="M6 17v4h12v-4"/></svg> Print / PDF</button>
      <button class="btn" id="${prefix}AuditVerifyBtn" style="width:auto; padding:9px 14px;">Check integrity</button>
    </div>
    <div class="result-meta" id="${prefix}AuditIntegrity" style="margin-top:8px;"></div>
    <div class="result-meta" id="${prefix}AuditStatus" style="margin-top:4px;"></div>
    <div class="table-scroll" style="margin-top:10px;">
      <table>
        <thead><tr><th>When (SAST)</th><th>Who</th><th>What</th><th>Details</th><th>Site</th></tr></thead>
        <tbody id="${prefix}AuditBody"><tr><td colspan="5" style="font-family:var(--sans); color:var(--muted);">Open this page to load the trail.</td></tr></tbody>
      </table>
    </div>
    <div class="result-meta" id="${prefix}AuditCount" style="margin-top:6px;"></div>
    <div class="btn-row" style="margin-top:6px;"><button class="btn" id="${prefix}AuditMoreBtn" style="display:none; width:auto; padding:8px 14px;">Load more</button></div>`;
}
function auditFillPanel(prefix, showControllerToggle){
  const panel = document.getElementById(prefix + 'AuditPanel');
  if (panel && !panel.dataset.filled){ panel.dataset.filled = '1'; panel.innerHTML = auditPanelMarkup(prefix, showControllerToggle); }
}

const AUDIT_TZ = 'Africa/Johannesburg';
const AUDIT_PAGE = 200;
const AUDIT_TYPES = {
  setup:      { label: 'Sites, routes & schedules', entities: ['site', 'checkpoint', 'route', 'schedule', 'shift', 'contact', 'vehicle', 'alert settings'] },
  people:     { label: 'People & accounts',         entities: ['user', 'admin invite code', 'controller invite code', 'company', 'platform admin'], actions: ['password_reset'] },
  alerts:     { label: 'Alerts & panic',            entities: ['alert', 'alert comment'], actions: ['panic'] },
  incidents:  { label: 'Incidents',                 entities: ['incident', 'incident comment'], actions: ['email_incident'] },
  attendance: { label: 'Attendance & patrol assignments', entities: ['attendance', 'absence', 'patrol assignment'] },
  tracking:   { label: 'Live tracking',             entities: ['live tracking'] },
  scans:      { label: 'Scan changes & comments',   entities: ['scan', 'scan comment'] },
  exports:    { label: 'Downloads & printouts',     actions: ['export', 'print'] },
  signins:    { label: 'Sign-ins',                  actions: ['sign_in'] }
};
const auditState = { prefix: null, rows: [], done: false, loading: false, wired: {}, lastFilters: null };
const aEl = id => document.getElementById(auditState.prefix + id);
let controllerAuditAccess = false;   // this company's choice, set by the admin; fetched at sign-in

// Records something the database cannot see by itself (sign-ins, downloads, emails).
async function logAudit(action, entity, entityId, siteId, summary, details){
  try{
    await sb.rpc('audit_event', { p_action: action, p_entity: entity, p_entity_id: entityId ? String(entityId) : null, p_site: siteId || null, p_summary: summary, p_details: details || null });
  }catch(e){ console.warn('audit event not recorded', e); }
}
// One sign-in record per device per 8 hours (not one per page reload).
function auditSignIn(){
  try{
    if (!profile || offlineMode || (session && session.offline)) return;
    const key = 'onpatrol_audit_signin';
    const last = Number(localStorage.getItem(key) || 0);
    if (Date.now() - last < 8 * 60 * 60 * 1000) return;
    localStorage.setItem(key, String(Date.now()));
    logAudit('sign_in', 'session', session.user.id, profile.site_id || null, `Signed in (${profile.role}) on ${incidentDeviceLabel()}`, { device: incidentDeviceLabel() });
  }catch(e){}
}

function auditWhen(iso){
  return new Date(iso).toLocaleString('en-ZA', { timeZone: AUDIT_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}
function auditNextDay(ymd){ const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); }
function auditReadFilters(){
  return {
    from: aEl('auditFrom').value, to: aEl('auditTo').value, site: aEl('auditSite').value,
    actor: aEl('auditActor').value, type: aEl('auditType').value, q: aEl('auditSearch').value.trim()
  };
}
function auditFilterText(f){
  const bits = [];
  bits.push(`${f.from || 'the start'} to ${f.to || 'today'} (South African time)`);
  if (f.site){ const s = sites.find(x => x.id === f.site); bits.push('site: ' + (s ? s.name : f.site)); }
  if (f.actor){ bits.push('person: ' + (f.actor === 'system' ? 'System (automatic)' : ((teamDirectory.find(u => u.id === f.actor) || {}).full_name || f.actor))); }
  if (f.type) bits.push('type: ' + (AUDIT_TYPES[f.type] || {}).label);
  if (f.q) bits.push('search: "' + f.q + '"');
  return bits.join(' · ');
}
function auditQuery(f){
  let q = sb.from('audit_log').select('*').order('id', { ascending: false });
  if (f.from) q = q.gte('occurred_at', f.from + 'T00:00:00+02:00');
  if (f.to) q = q.lt('occurred_at', auditNextDay(f.to) + 'T00:00:00+02:00');
  if (f.site) q = q.eq('site_id', f.site);
  if (f.actor === 'system') q = q.is('actor_id', null); else if (f.actor) q = q.eq('actor_id', f.actor);
  if (f.type && AUDIT_TYPES[f.type]){
    const t = AUDIT_TYPES[f.type], parts = [];
    if (t.entities) parts.push(`entity.in.(${t.entities.map(e => '"' + e + '"').join(',')})`);
    if (t.actions) parts.push(`action.in.(${t.actions.map(a => '"' + a + '"').join(',')})`);
    q = q.or(parts.join(','));
  }
  if (f.q){
    const s = f.q.replace(/[%,()"*\\]/g, ' ').trim();
    if (s) q = q.or(`summary.ilike.%${s}%,entity_label.ilike.%${s}%,actor_name.ilike.%${s}%`);
  }
  return q;
}
function auditActionPill(a){
  const cls = { created: 'st-success', changed: 'st-info', deleted: 'st-crit', panic: 'st-crit', cleared: 'st-warn', resolved: 'st-success', scan_changed: 'st-crit' }[a] || 'st-info';
  return `<span class="st ${cls}">${escapeHtmlForPrint(String(a).replace(/_/g, ' '))}</span>`;
}
function auditRowHtml(r){
  const site = r.site_id ? (sites.find(s => s.id === r.site_id) || {}).name || '' : '';
  const who = r.actor_name
    ? `${escapeHtmlForPrint(r.actor_name)} <span class="result-meta">${escapeHtmlForPrint(r.actor_role || '')}</span>`
    : '<span class="result-meta">System (automatic)</span>';
  const details = r.details ? `<details style="margin-top:4px;"><summary class="result-meta" style="cursor:pointer;">details</summary><pre style="white-space:pre-wrap; font-size:11px; margin:4px 0 0;">${escapeHtmlForPrint(JSON.stringify(r.details, null, 1))}</pre></details>` : '';
  return `<tr>
    <td style="white-space:nowrap; font-family:var(--mono); font-size:12px;">${auditWhen(r.occurred_at)}</td>
    <td style="font-family:var(--sans);">${who}</td>
    <td>${auditActionPill(r.action)}</td>
    <td style="font-family:var(--sans);">${escapeHtmlForPrint(r.summary)}${details}</td>
    <td style="font-family:var(--sans); color:var(--muted);">${escapeHtmlForPrint(site)}</td>
  </tr>`;
}
function auditRenderTable(){
  const body = aEl('auditBody');
  body.innerHTML = auditState.rows.length
    ? auditState.rows.map(auditRowHtml).join('')
    : '<tr><td colspan="5" style="font-family:var(--sans); color:var(--muted);">Nothing recorded for these filters.</td></tr>';
  aEl('auditCount').textContent = auditState.rows.length
    ? `Showing ${auditState.rows.length} entr${auditState.rows.length === 1 ? 'y' : 'ies'}${auditState.done ? '' : ' (newest first) — more available'}.`
    : '';
  aEl('auditMoreBtn').style.display = auditState.rows.length && !auditState.done ? '' : 'none';
}
async function auditLoad(more){
  if (auditState.loading) return;
  auditState.loading = true;
  const status = aEl('auditStatus');
  status.textContent = 'Loading…';
  try{
    const f = more && auditState.lastFilters ? auditState.lastFilters : auditReadFilters();
    if (!more){ auditState.rows = []; auditState.done = false; auditState.lastFilters = f; }
    let q = auditQuery(f);
    if (more && auditState.rows.length) q = q.lt('id', auditState.rows[auditState.rows.length - 1].id);
    const { data, error } = await q.limit(AUDIT_PAGE);
    if (error) throw error;
    auditState.rows = auditState.rows.concat(data || []);
    if (!data || data.length < AUDIT_PAGE) auditState.done = true;
    status.textContent = '';
    auditRenderTable();
  }catch(e){ status.textContent = 'Could not load the audit trail — ' + (e.message || e); }
  finally{ auditState.loading = false; }
}
// Every entry matching the filters, oldest to newest, for a download or printout.
async function auditFetchAll(f, max){
  const out = []; let lastId = null;
  while (out.length < max){
    let q = auditQuery(f);
    if (lastId != null) q = q.lt('id', lastId);
    const { data, error } = await q.limit(1000);
    if (error) throw error;
    if (!data || !data.length) break;
    out.push(...data); lastId = data[data.length - 1].id;
    if (data.length < 1000) break;
  }
  return { rows: out.slice(0, max).reverse(), truncated: out.length >= max };
}
async function auditIntegrity(){
  const el = aEl('auditIntegrity');
  el.textContent = 'Checking…';
  const { data, error } = await sb.rpc('audit_verify');
  if (error || !data || !data[0]){ el.innerHTML = '<span style="color:var(--warn);">Could not check integrity — ' + escapeHtmlForPrint(error ? error.message : 'no answer') + '</span>'; return null; }
  const r = data[0];
  el.innerHTML = r.ok
    ? `<span style="color:var(--ok, #22c55e); font-weight:600;">✓ Intact</span> — ${r.rows_checked} entries checked; none altered or removed. Fingerprint <span style="font-family:var(--mono);">${escapeHtmlForPrint((r.last_hash || '').slice(0, 16))}</span>`
    : `<span style="color:var(--danger); font-weight:700;">✗ Tampering detected</span> — entry #${r.first_bad_id} does not match its fingerprint. Contact support.`;
  return r;
}
function auditCsvCell(v){
  let s = String(v == null ? '' : v);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
async function auditDownloadCsv(){
  const status = aEl('auditStatus'); status.textContent = 'Preparing…';
  try{
    const f = auditReadFilters();
    const { rows, truncated } = await auditFetchAll(f, 20000);
    const integ = await auditIntegrity();
    const lines = [
      ['OnPatrol audit trail'], ['Company', companyName || ''], ['Filters', auditFilterText(f)],
      ['Generated', auditWhen(new Date().toISOString()) + ' (SAST) by ' + ((profile && profile.full_name) || '')],
      ['Integrity', integ ? (integ.ok ? `Intact - ${integ.rows_checked} entries checked, fingerprint ${(integ.last_hash || '').slice(0, 16)}` : `TAMPERING DETECTED at entry #${integ.first_bad_id}`) : 'not checked'],
      truncated ? ['Note', 'Limited to the newest 20000 entries - narrow the dates for the rest'] : [], []
    ];
    lines.push(['Entry', 'Time (SAST)', 'Who', 'Role', 'What', 'Area', 'Item', 'Site', 'Summary', 'Details', 'Source', 'Entry fingerprint']);
    rows.forEach(r => lines.push([
      r.id, auditWhen(r.occurred_at), r.actor_name || 'System', r.actor_role || '', r.action, r.entity, r.entity_label || '',
      r.site_id ? ((sites.find(s => s.id === r.site_id) || {}).name || '') : '', r.summary, r.details ? JSON.stringify(r.details) : '', r.source, (r.row_hash || '').slice(0, 12)
    ]));
    const csv = '\ufeff' + lines.map(row => row.map(auditCsvCell).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `audit-trail_${f.from || 'start'}_to_${f.to || 'today'}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    status.textContent = `Downloaded ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}.`;
    logAudit('export', 'audit_trail', null, f.site || null, `Downloaded the audit trail as CSV (${rows.length} entries) - ${auditFilterText(f)}`, { format: 'csv', entries: rows.length });
  }catch(e){ status.textContent = 'Could not download — ' + (e.message || e); }
}
async function auditPrint(){
  const status = aEl('auditStatus'); status.textContent = 'Preparing…';
  try{
    const f = auditReadFilters();
    const { rows, truncated } = await auditFetchAll(f, 3000);
    const integ = await auditIntegrity();
    const logoEl = document.querySelector('.brand-logo');
    const logoSrc = logoEl ? logoEl.getAttribute('src') : null;
    const win = window.open('', '_blank');
    if (!win){ status.textContent = 'Your browser blocked the print window — allow popups for this site and try again.'; return; }
    const integText = integ ? (integ.ok ? `Intact — ${integ.rows_checked} entries checked, none altered or removed. Fingerprint ${(integ.last_hash || '').slice(0, 16)}` : `TAMPERING DETECTED at entry #${integ.first_bad_id}`) : 'not checked';
    const body = rows.map(r => `<tr><td>${auditWhen(r.occurred_at)}</td><td>${escapeHtmlForPrint(r.actor_name || 'System')}${r.actor_role ? ' (' + escapeHtmlForPrint(r.actor_role) + ')' : ''}</td><td>${escapeHtmlForPrint(String(r.action).replace(/_/g, ' '))}</td><td>${escapeHtmlForPrint(r.summary)}</td><td>${escapeHtmlForPrint(r.site_id ? ((sites.find(s => s.id === r.site_id) || {}).name || '') : '')}</td><td style="font-family:monospace;">#${r.id}</td></tr>`).join('') || '<tr><td colspan="6" class="empty-row">Nothing recorded for these filters.</td></tr>';
    win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>OnPatrol audit trail</title>
<style>
  @page { size: A4 landscape; margin: 1.2cm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin:0; color:#111; }
  .header { display:flex; align-items:center; gap:14px; background:#0b0f14; padding:14px 18px; border-radius:10px; }
  .header img { height:36px; width:auto; }
  .header h1 { color:#fff; font-size:19px; margin:0; }
  .header .meta { color:#b9c2cc; font-size:11px; margin-top:2px; }
  .box { border:1px solid #ddd; border-radius:8px; padding:8px 12px; margin-top:12px; font-size:11px; line-height:1.5; }
  table { width:100%; border-collapse:collapse; font-size:10px; margin-top:12px; }
  th, td { border:1px solid #ddd; padding:4px 6px; text-align:left; vertical-align:top; }
  th { background:#14314f; color:#fff; }
  tr:nth-child(even) td { background:#f7f9fb; }
  .empty-row { color:#888; text-align:center; }
  tr { page-break-inside:avoid; }
  footer { margin-top:14px; font-size:9px; color:#888; }
</style></head><body>
<div class="header">${logoSrc ? `<img src="${logoSrc}" alt="OnPatrol">` : ''}<div><h1>Audit trail</h1><div class="meta">${escapeHtmlForPrint(companyName || '')} · generated ${auditWhen(new Date().toISOString())} (SAST) by ${escapeHtmlForPrint((profile && profile.full_name) || '')}</div></div></div>
<div class="box"><b>Filters:</b> ${escapeHtmlForPrint(auditFilterText(f))}<br><b>Integrity:</b> ${escapeHtmlForPrint(integText)}<br><b>Entries:</b> ${rows.length}${truncated ? ' (limited to the newest 3000 — narrow the dates or use the CSV download for the rest)' : ''}. Entries are kept in order, cannot be edited or deleted, and each is chained to the one before it.</div>
<table><thead><tr><th>Time (SAST)</th><th>Who</th><th>What</th><th>Summary</th><th>Site</th><th>Entry</th></tr></thead><tbody>${body}</tbody></table>
<footer>OnPatrol audit trail · times are South African time · printed ${auditWhen(new Date().toISOString())}</footer>
<script>window.onload = function(){ setTimeout(function(){ window.print(); }, 300); };<\/script>
</body></html>`);
    win.document.close();
    status.textContent = `Opened ${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} for printing.`;
    logAudit('print', 'audit_trail', null, f.site || null, `Printed the audit trail (${rows.length} entries) - ${auditFilterText(f)}`, { format: 'pdf', entries: rows.length });
  }catch(e){ status.textContent = 'Could not prepare the printout — ' + (e.message || e); }
}
function auditInit(prefix){
  if (!profile || !(profile.role === 'admin' || (profile.role === 'controller' && controllerAuditAccess))) return;
  auditState.prefix = prefix;
  const siteSel = aEl('auditSite'), actorSel = aEl('auditActor'), typeSel = aEl('auditType');
  if (!auditState.wired[prefix]){
    auditState.wired[prefix] = true;
    typeSel.innerHTML = '<option value="">Everything</option>' + Object.keys(AUDIT_TYPES).map(k => `<option value="${k}">${AUDIT_TYPES[k].label}</option>`).join('');
    const today = new Date(), weekAgo = new Date(Date.now() - 6 * 86400000);
    const ymd = d => new Date(d.getTime() + 2 * 3600000).toISOString().slice(0, 10);   // South African date
    aEl('auditTo').value = ymd(today); aEl('auditFrom').value = ymd(weekAgo);
    aEl('auditShowBtn').addEventListener('click', () => auditLoad(false));
    aEl('auditMoreBtn').addEventListener('click', () => auditLoad(true));
    aEl('auditCsvBtn').addEventListener('click', auditDownloadCsv);
    aEl('auditPrintBtn').addEventListener('click', auditPrint);
    aEl('auditVerifyBtn').addEventListener('click', auditIntegrity);
    aEl('auditSearch').addEventListener('keydown', e => { if (e.key === 'Enter') auditLoad(false); });
  }
  const keepSite = siteSel.value, keepActor = actorSel.value;
  siteSel.innerHTML = '<option value="">All sites</option>' + sites.map(s => `<option value="${s.id}">${escapeHtmlForPrint(s.name)}</option>`).join('');
  siteSel.value = keepSite;
  actorSel.innerHTML = '<option value="">Everyone</option><option value="system">System (automatic)</option>' +
    teamDirectory.slice().sort((a, b) => String(a.full_name).localeCompare(String(b.full_name))).map(u => `<option value="${u.id}">${escapeHtmlForPrint(u.full_name || u.id)} (${escapeHtmlForPrint(u.role)})</option>`).join('');
  actorSel.value = keepActor;
  if (prefix === 'admin'){
    const toggle = document.getElementById('adminAuditControllerAccess');
    if (toggle && !toggle.dataset.wired){
      toggle.dataset.wired = '1';
      sb.from('organizations').select('controller_audit_access').eq('id', profile.org_id).single().then(({ data }) => { toggle.checked = !!(data && data.controller_audit_access); });
      toggle.addEventListener('change', async () => {
        toggle.disabled = true;
        const { error } = await sb.from('organizations').update({ controller_audit_access: toggle.checked }).eq('id', profile.org_id);
        toggle.disabled = false;
        if (error){ toggle.checked = !toggle.checked; showToast('Could not save', error.message, 'danger'); return; }
        controllerAuditAccess = toggle.checked;
        showToast(toggle.checked ? 'Controllers can now open the audit trail' : 'Controllers can no longer open the audit trail', '', 'success');
      });
    }
  }
  if (!teamDirectory.length) loadTeamDirectory().then(() => auditInit());
  auditLoad(false);
  auditIntegrity();
}
// sb.functions.invoke() only puts the real error message in `data` when the
// edge function returns 2xx. On a non-2xx response, `data` is null and
// `error.message` is just the generic "Edge Function returned a non-2xx
// status code" - the actual reason your function sent back (face mismatch,
// already clocked in, validation error, etc.) is sitting unread in
// `error.context`, a Response object. Every screen that calls an edge
// function should show the real reason, not this generic wrapper text.
async function functionErrorMessage(data, error, fallback){
  if (data && data.error) return data.error;
  if (error){
    try{
      if (error.context && typeof error.context.json === 'function'){
        const body = await error.context.json();
        if (body && body.error) return body.error;
      }
    } catch(e){ /* body wasn't JSON, or already consumed - fall through */ }
    return error.message || fallback;
  }
  return fallback;
}
// A "valid" phone number here just means enough digits to actually be
// reachable on — 9 is the shortest real mobile number length (SA numbers
// without a country code), and it still accepts +country-code formats,
// spaces, dashes, and parentheses.
function isValidPhone(val){
  const digits = (val || '').replace(/\D/g, '');
  return digits.length >= 9 && digits.length <= 15;
}

