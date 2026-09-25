// ---------------- Sound notifications ----------------
let soundOn = true;
let audioCtx = null;
function beep(freq, duration, type, vol, force){
  if (!soundOn && !force) return;
  try{
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type || 'sine';
    osc.frequency.value = freq;
    gain.gain.value = vol != null ? vol : 0.16;
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + duration/1000);
  } catch(e){ /* audio unavailable — fail silently */ }
}
function playTone(seq, force){
  let t = 0;
  seq.forEach(s => {
    setTimeout(() => beep(s.freq, s.duration, s.type, s.vol, force), t);
    t += s.delay != null ? s.delay : s.duration + 50;
  });
  return t;
}
function ring(seq, totalMs, force){
  if (!soundOn && !force) return;
  const cycle = seq.reduce((acc, s) => acc + (s.delay != null ? s.delay : s.duration + 50), 0) + 350;
  let elapsed = 0;
  playTone(seq, force);
  const timer = setInterval(() => {
    elapsed += cycle;
    if (elapsed >= totalMs || (!soundOn && !force)){ clearInterval(timer); return; }
    playTone(seq, force);
  }, cycle);
}
const SOUND = {
  fiveMinWarning: () => playTone([{freq:660,duration:140},{freq:660,duration:140}]),
  patrolStart:    () => ring([{freq:520,duration:150},{freq:820,duration:250}], 15000),
  tagScan:        () => playTone([{freq:1000,duration:60}]),
  tagAccepted:    () => playTone([{freq:880,duration:110},{freq:1180,duration:170}]),
  // Declined tag: a harsher low buzz, distinct from the accept chime, plus a haptic
  // buzz on devices that support it — makes a rejection unmistakable even if the
  // guard isn't looking at the screen.
  tagRejected:    () => {
    playTone([{freq:300,duration:160},{freq:180,duration:160},{freq:180,duration:220}]);
    if (navigator.vibrate) navigator.vibrate([120,70,120]);
  },
  lateReminder:   () => ring([{freq:420,duration:200},{freq:420,duration:200},{freq:420,duration:200}], 30000),
  // Deliberately harsh and impossible to mistake for anything else — rings for
  // a full 6 seconds (comfortably over the 5s minimum) so it can't be missed
  // by a controller who glanced away, and pairs with a strong vibration
  // pattern on the guard's own device as confirmation the alert went out.
  panic: () => {
    ring([{freq:1000,duration:180},{freq:700,duration:180}], 6000, true);
    if (navigator.vibrate) navigator.vibrate([300,150,300,150,300,150,300]);
  }
};

function showToast(title, sub, kind){
  const wrap = document.getElementById('toastWrap');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' ' + kind : '');
  // Escaped here once, centrally — title/sub often carry guard names, error
  // messages, or other text that ultimately originates from user input
  // (a guard's own full name, a typed comment, a server error string), and
  // this was being inserted into innerHTML completely unescaped everywhere
  // this function is called.
  el.innerHTML = `<div class="toast-title">${escapeHtmlForPrint(title)}</div><div class="toast-sub">${escapeHtmlForPrint(sub || '')}</div>`;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

// ---------------- Patrol scheduling engine (pure — operates on local state) ----------------
function parseHM(hm){
  const [h,m] = hm.split(':').map(Number);
  return { h, m };
}
// A schedule only actually runs while both it and its route are switched
// on — turning a route off should pause every schedule built on it without
// having to also flip each schedule individually.
function isScheduleLive(sched){
  if (sched.active === false) return false;
  const r = routes.find(rt => rt.id === sched.routeId);
  return !!r && r.active !== false;
}
// A patrol can't have been expected before the thing that schedules it existed.
// The floor is the newest of: the site, its route, and the schedule itself — so a
// site created minutes ago never shows "missed" rounds from days (or hours) earlier.
function patrolCreationFloor(sched){
  const r = routes.find(x => x.id === sched.routeId);
  const site = r ? sites.find(x => x.id === r.siteId) : null;
  return Math.max((site && site.createdAt) || 0, (r && r.createdAt) || 0, sched.createdAt || 0);
}
function generateInstances(sched, winStart, winEnd){
  const out = [];
  const floorMs = patrolCreationFloor(sched);
  const start = parseHM(sched.shiftStart);
  const end = parseHM(sched.shiftEnd);
  const dayMs = 24*60*60*1000;
  const firstDay = new Date(winStart - dayMs);
  firstDay.setHours(0,0,0,0);
  for (let dayStart = firstDay.getTime(); dayStart <= winEnd + dayMs; dayStart += dayMs){
    const shiftStart = dayStart + (start.h*60+start.m)*60000;
    let shiftEnd = dayStart + (end.h*60+end.m)*60000;
    if (shiftEnd <= shiftStart) shiftEnd += dayMs;
    const stepMs = sched.intervalMinutes * 60000;
    for (let t = shiftStart; t < shiftEnd; t += stepMs){
      if (t >= winStart && t <= winEnd && t >= floorMs){
        out.push({ id: sched.id + '-' + t, scheduleId: sched.id, routeId: sched.routeId, expectedTime: t, intervalMinutes: sched.intervalMinutes, durationMinutes: sched.durationMinutes, graceMinutes: sched.graceMinutes });
      }
    }
  }
  out.sort((a,b) => a.expectedTime - b.expectedTime);
  return out;
}
function routeCheckpoints(routeId){
  const r = routes.find(r => r.id === routeId);
  return r ? r.cpIds : [];
}
// Scans indexed by tag (accepted only, oldest first), rebuilt only when the scan list
// actually changes. Every patrol round looks its scans up here by time window instead of
// re-reading the whole scan history — that keeps big companies (dozens of sites, tens of
// thousands of scans) fast. Same results as filtering the full list.
let scanIndexRef = null, scanIndexKey = '', scanIndexMap = null;
function acceptedScansByTag(){
  const n = scans.length, last = n ? scans[n - 1] : null, first = n ? scans[0] : null;
  const key = n + '|' + (last ? last.id + ':' + last.timestamp : '') + '|' + (first ? first.id : '');
  if (scanIndexMap && scanIndexRef === scans && scanIndexKey === key) return scanIndexMap;
  const map = new Map();
  for (const s of scans){
    if (s.result !== 'ACCEPTED' && s.result !== 'SKIPPED') continue;   // a skipped tag is excused, so it counts as done
    let arr = map.get(s.qrId);
    if (!arr){ arr = []; map.set(s.qrId, arr); }
    arr.push(s);
  }
  map.forEach(arr => arr.sort((a, b) => a.timestamp - b.timestamp));
  scanIndexRef = scans; scanIndexKey = key; scanIndexMap = map;
  return map;
}
function scansForInstance(inst){
  const cpIds = routeCheckpoints(inst.routeId);
  const winStart = inst.expectedTime - 5*60000;
  const winEnd = inst.expectedTime + inst.intervalMinutes*60000;
  const idx = acceptedScansByTag();
  const out = [];
  for (const id of cpIds){
    const arr = idx.get(id);
    if (!arr) continue;
    // first scan at/after winStart (binary search), then walk until winEnd
    let lo = 0, hi = arr.length;
    while (lo < hi){ const mid = (lo + hi) >> 1; if (arr[mid].timestamp < winStart) lo = mid + 1; else hi = mid; }
    for (let i = lo; i < arr.length && arr[i].timestamp < winEnd; i++) out.push(arr[i]);
  }
  return out;
}
// The moment a patrol's last required checkpoint was actually scanned — i.e. when
// the guard finished, not "now". Returns null if not every checkpoint has a scan yet.
function patrolCompletionTime(found, cpIds){
  const firstScanAt = {};
  found.forEach(s => {
    if (!(s.qrId in firstScanAt) || s.timestamp < firstScanAt[s.qrId]) firstScanAt[s.qrId] = s.timestamp;
  });
  const times = cpIds.map(id => firstScanAt[id]);
  if (times.some(t => t === undefined)) return null;
  return Math.max(...times);
}
function instanceStatus(inst, at){
  const cpIds = routeCheckpoints(inst.routeId);
  const found = scansForInstance(inst);
  const doneCps = [...new Set(found.map(s => s.qrId))];
  // Tags that are done only because the guard skipped them (no real scan).
  const skippedCps = doneCps.filter(id => !found.some(s => s.qrId === id && s.result === 'ACCEPTED'));
  const totalCps = cpIds.length;
  const complete = totalCps > 0 && doneCps.length >= totalCps;
  // Expected finish (start + duration), then the grace buffer on top of that before
  // the round is concluded/closed out. Everything up to concludeAt counts as on
  // time; anything scanned after concludeAt is late.
  const durationEnd = inst.expectedTime + inst.durationMinutes*60000;
  const concludeAt = durationEnd + inst.graceMinutes*60000;
  const windowEnd = inst.expectedTime + inst.intervalMinutes*60000;

  let status;
  if (complete){
    // Duration is the actual patrol window — finishing within it is on time. The
    // grace period is a catch-up buffer on top: a guard delayed by something (an
    // incident, etc.) can still complete the round during it, but that finish
    // counts as late, not on time. Only after concludeAt does the round stop
    // accepting scans altogether (see `scannable` below).
    const finishedAt = patrolCompletionTime(found, cpIds);
    status = finishedAt <= durationEnd ? 'completed' : 'completed_late';
  } else if (at < inst.expectedTime - 5*60000){
    status = 'upcoming';
  } else if (at < inst.expectedTime){
    status = 'due_soon';
  } else if (at < durationEnd){
    status = 'active';
  } else if (at < concludeAt){
    status = 'grace';
  } else {
    status = doneCps.length > 0 ? 'completed_late' : 'missed';
  }
  // Scanning itself stays open on a time basis, separate from the display status:
  // from the patrol's start until the outer window closes (same cap used to
  // attribute scans to this instance), as long as it isn't already complete. That
  // means a guard who's past the grace period can still finish the round — those
  // tags land as a late completion instead of being silently rejected. Once truly
  // complete, or once windowEnd passes, scanning stops.
  const scannable = !complete && at >= inst.expectedTime && at < windowEnd;
  return { status, doneCps, skippedCps, totalCps, cpIds, durationEnd, concludeAt, windowEnd, scannable };
}
function nextExpectedCheckpoint(inst){
  const st = instanceStatus(inst, nowMs());
  return st.cpIds.find(id => !st.doneCps.includes(id)) || null;
}
function statusLabel(s){
  return { upcoming:'Upcoming', due_soon:'Due soon', active:'In progress', grace:'Grace period', late:'Late', completed:'Completed', completed_late:'Completed (late)', missed:'Missed' }[s] || s;
}
// Why a guard may skip a checkpoint they can't scan (stored on the scan as skip_reason).
const SKIP_REASONS = [
  { id: 'damaged',        label: 'Tag damaged' },
  { id: 'missing',        label: 'Tag missing' },
  { id: 'obstruction',    label: 'Tag obstruction' },
  { id: 'not_responding', label: 'Tag not responding' }
];
function skipReasonLabel(id){ const r = SKIP_REASONS.find(x => x.id === id); return r ? r.label : 'Skipped'; }
function fmtCountdown(ms){
  const sign = ms < 0 ? -1 : 1;
  ms = Math.abs(ms);
  const totalMin = Math.floor(ms/60000);
  const h = Math.floor(totalMin/60), m = totalMin%60, s = Math.floor((ms%60000)/1000);
  const core = h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`;
  return sign < 0 ? `overdue by ${core}` : `in ${core}`;
}

// ---------------- Utility: haversine distance in meters ----------------
function distMeters(lat1, lng1, lat2, lng2){
  const R = 6371000;
  const toRad = d => d * Math.PI/180;
  const dLat = toRad(lat2-lat1), dLng = toRad(lng2-lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
function pointAtDistance(cp, meters){
  const metersPerDegLat = 111320;
  const dLat = meters / metersPerDegLat;
  return { lat: cp.lat + dLat, lng: cp.lng };
}

// ---------------- Data loading (DB -> local state) ----------------
function rowToScan(row){
  const cp = checkpoints.find(c => c.qrId === row.raw_qr_id);
  return {
    id: row.id,
    qrId: row.raw_qr_id,
    cpName: cp ? cp.name : null,
    siteId: row.site_id,
    distance: row.distance_m != null ? Number(row.distance_m) : null,
    result: row.result,
    expectedQrId: row.expected_qr_id,
    timestamp: new Date(row.created_at).getTime(),
    guardId: row.guard_id,
    isLate: !!row.is_late,
    skipReason: row.skip_reason || null
  };
}

async function loadSites(){
  const { data, error } = await sb.from('sites').select('*').order('created_at');
  if (error){ showToast('Could not load sites', error.message, 'danger'); return; }
  sites = (data || []).map(s => ({ id: s.id, name: s.name, address: s.address || '—', siteCode: s.site_code, phone: s.phone || '', lat: s.lat, lng: s.lng, perimeter: s.perimeter || null, createdAt: s.created_at ? new Date(s.created_at).getTime() : null }));
  if (!activeSiteId || !sites.some(s => s.id === activeSiteId)){
    activeSiteId = sites[0] ? sites[0].id : null;
  }
}
let teamDirectory = [];
async function loadTeamDirectory(){
  const { data, error } = await sb.from('profiles').select('id, full_name, phone, role, site_id, employee_number').order('full_name');
  if (error){ showToast('Could not load team', error.message, 'danger'); return; }
  teamDirectory = data || [];
}
async function loadCheckpoints(){
  const { data, error } = await sb.from('checkpoints').select('*').order('created_at');
  if (error){ showToast('Could not load checkpoints', error.message, 'danger'); return; }
  checkpoints = (data || []).map(c => ({ id: c.id, qrId: c.qr_id, name: c.name, lat: Number(c.lat), lng: Number(c.lng), radius: Number(c.radius_m), siteId: c.site_id }));
}
async function loadRoutes(){
  const { data: routeRows, error } = await sb.from('routes').select('*').order('created_at');
  if (error){ showToast('Could not load routes', error.message, 'danger'); return; }
  const { data: rcRows, error: rcError } = await sb.from('route_checkpoints').select('route_id, position, checkpoints(qr_id)').order('position');
  if (rcError){ showToast('Could not load route checkpoints', rcError.message, 'danger'); return; }
  routes = (routeRows || []).map(r => ({
    id: r.id,
    name: r.name,
    siteId: r.site_id,
    strictOrder: r.strict_order,
    active: r.active !== false,
    createdAt: r.created_at ? new Date(r.created_at).getTime() : null,
    cpIds: (rcRows || [])
      .filter(rc => rc.route_id === r.id)
      .sort((a,b) => a.position - b.position)
      .map(rc => rc.checkpoints ? rc.checkpoints.qr_id : null)
      .filter(Boolean)
  }));
}
async function loadSchedules(){
  const { data, error } = await sb.from('schedules').select('*').order('created_at');
  if (error){ showToast('Could not load schedules', error.message, 'danger'); return; }
  schedules = (data || []).map(s => ({
    id: s.id, routeId: s.route_id, intervalMinutes: s.interval_minutes,
    shiftStart: (s.shift_start || '00:00:00').slice(0,5), shiftEnd: (s.shift_end || '00:00:00').slice(0,5),
    durationMinutes: s.duration_minutes, graceMinutes: s.grace_minutes, active: s.active,
    createdAt: s.created_at ? new Date(s.created_at).getTime() : null
  }));
}
// ---- Scan loading (built for many sites) ----
// The API returns at most ~1000 rows per request, and a busy company writes thousands
// of scans a day. So scans are pulled page by page, NEWEST FIRST, until the window is
// covered — the current shift can never be the part that gets cut off.
//  * Guard phones only load their own site(s): the one they're assigned to plus the one
//    they're clocked in at when relieving. 70 phones must not each download the estate.
//  * Controllers/admins load the last 14h straight away (covers the current shift and the
//    patrol windows around it) and fill in the rest of the 48h in the background.
const SCAN_PAGE = 1000;
const SCAN_HOT_MS = 14 * 60 * 60 * 1000;
const SCAN_HISTORY_MS = 48 * 60 * 60 * 1000;
let scanLoadToken = 0;
async function fetchScansPaged({ since, until, siteIds, maxRows = 80000 }){
  const rows = [], seen = new Set();
  let from = 0;
  while (rows.length < maxRows){
    let q = sb.from('scans').select('*').gte('created_at', since);
    if (until) q = q.lt('created_at', until);
    if (siteIds && siteIds.length) q = siteIds.length === 1 ? q.eq('site_id', siteIds[0]) : q.in('site_id', siteIds);
    q = q.order('created_at', { ascending: false }).order('id', { ascending: false }).range(from, from + SCAN_PAGE - 1);
    const { data, error } = await q;
    if (error) return { rows, error };
    if (!data || !data.length) break;
    // rows written while we page shift the offsets; de-dupe by id so nothing is counted twice
    data.forEach(r => { if (!seen.has(r.id)){ seen.add(r.id); rows.push(r); } });
    from += data.length;
  }
  return { rows, error: null };
}
function scanScopeSiteIds(){
  if (profile && profile.role === 'guard') return [...new Set([guardSiteId, activeDutySiteId].filter(Boolean))];
  return null;   // controllers / admins see every site
}
async function loadScans(){
  if (OFFLINE_ENABLED && profile && profile.role === 'guard' && offlineKnownDown()) return;   // keep what the phone already has
  const siteIds = scanScopeSiteIds();
  const token = ++scanLoadToken;
  if (siteIds && !siteIds.length){ scans = []; return; }
  const now = Date.now();
  const { rows, error } = await fetchScansPaged({ since: new Date(now - SCAN_HOT_MS).toISOString(), siteIds });
  if (error){ showToast('Could not load scan history', error.message, 'danger'); return; }
  if (token !== scanLoadToken) return;   // a newer load has superseded this one
  scans = rows.map(rowToScan).sort((a, b) => a.timestamp - b.timestamp);
  await offlineApplyQueueToState();   // scans still waiting to be sent stay visible
  offlineSnapshotSoon();
  if (!siteIds) backfillOlderScans(token, now);
}
async function backfillOlderScans(token, now){
  try{
    const { rows, error } = await fetchScansPaged({
      since: new Date(now - SCAN_HISTORY_MS).toISOString(),
      until: new Date(now - SCAN_HOT_MS).toISOString()
    });
    if (error || token !== scanLoadToken || !rows.length) return;
    const have = new Set(scans.map(x => x.id));
    const older = rows.filter(r => !have.has(r.id)).map(rowToScan);
    if (!older.length) return;
    scans = older.concat(scans).sort((a, b) => a.timestamp - b.timestamp);
    renderStats(); renderLog(); renderPatrolsAdmin();
  }catch(e){ console.warn('scan backfill', e); }
}
async function loadSiteShifts(){
  const { data, error } = await sb.from('site_shifts').select('*').order('start_time');
  if (error){ showToast('Could not load shifts', error.message, 'danger'); return; }
  siteShifts = (data || []).map(s => ({
    id: s.id, siteId: s.site_id, name: s.name,
    startTime: (s.start_time || '00:00:00').slice(0,5), endTime: (s.end_time || '00:00:00').slice(0,5),
    required: s.required_guards, active: s.active
  }));
}
function rowToAttendance(r){
  return {
    id: r.id, siteId: r.site_id, shiftId: r.shift_id, shiftDate: r.shift_date, guardId: r.guard_id,
    isReliever: r.is_reliever, coveringGuardId: r.covering_guard_id,
    clockInAt: new Date(r.clock_in_at).getTime(),
    clockOutAt: r.clock_out_at ? new Date(r.clock_out_at).getTime() : null,
    status: r.status
  };
}
// Attendance/absences are loaded on a rolling 30h window so an overnight shift that
// started "yesterday" is still visible in today's coverage tiles.
async function loadAttendanceRecent(){
  if (OFFLINE_ENABLED && profile && profile.role === 'guard' && offlineKnownDown()) return;
  const since = new Date(Date.now() - 30*60*60*1000).toISOString();
  const { data, error } = await sb.from('attendance').select('*').gte('clock_in_at', since);
  if (error){ showToast('Could not load attendance', error.message, 'danger'); return; }
  attendance = (data || []).map(rowToAttendance);
  await offlineApplyQueueToState();   // clock-ins / clock-outs still waiting to be sent stay visible
  offlineSnapshotSoon();
  myAttendance = (session && attendance.find(a => a.guardId === session.user.id && a.status === 'on_duty')) || null;
}
async function loadAbsencesRecent(){
  if (OFFLINE_ENABLED && profile && profile.role === 'guard' && offlineKnownDown()) return;
  const since = new Date(Date.now() - 30*60*60*1000).toISOString();
  const { data, error } = await sb.from('absences').select('*').gte('marked_at', since);
  if (error){ showToast('Could not load absences', error.message, 'danger'); return; }
  absences = (data || []).map(a => ({
    id: a.id, siteId: a.site_id, shiftId: a.shift_id, shiftDate: a.shift_date,
    guardId: a.guard_id, markedBy: a.marked_by, coveredByAttendanceId: a.covered_by_attendance_id
  }));
}
// Guard names + employee numbers (never face_descriptor) for a site, via the
// SECURITY DEFINER function so controllers/admins can see any site and a guard can
// see their own site's roster. Cached per site for the session.
async function loadGuardDirectory(siteId){
  if (guardDirectoryCache[siteId]) return guardDirectoryCache[siteId];
  const { data, error } = await sb.rpc('list_site_guards', { p_site_id: siteId });
  if (error){ showToast('Could not load guard roster', error.message, 'danger'); return []; }
  guardDirectoryCache[siteId] = data || [];
  return guardDirectoryCache[siteId];
}
function guardLabel(siteId, guardId){
  const dir = guardDirectoryCache[siteId] || [];
  const g = dir.find(x => x.id === guardId);
  if (!g) return 'Guard';
  const label = g.full_name ? `${g.full_name}${g.employee_number ? ' · #' + g.employee_number : ''}` : (g.employee_number || 'Guard');
  return escapeHtmlForPrint(label);
}
// Which calendar date "bucket" a shift instance covering `atMs` belongs to — the
// date the shift STARTED, so an overnight shift (e.g. 18:00-06:00) checked at
// 02:00 still resolves to the previous day's instance, not a fresh one.
function ymd(d){ return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); }
function currentShiftDateFor(shift, atMs){
  const at = new Date(atMs);
  const [sh, sm] = shift.startTime.split(':').map(Number);
  const [eh, em] = shift.endTime.split(':').map(Number);
  const crossesMidnight = (eh*60 + em) <= (sh*60 + sm);
  const todayStart = new Date(at); todayStart.setHours(sh, sm, 0, 0);
  const todayEnd = new Date(at); todayEnd.setHours(eh, em, 0, 0);
  if (crossesMidnight) todayEnd.setDate(todayEnd.getDate() + 1);
  if (at >= todayStart && at < todayEnd) return ymd(todayStart);
  const yStart = new Date(todayStart); yStart.setDate(yStart.getDate() - 1);
  const yEnd = new Date(todayEnd); yEnd.setDate(yEnd.getDate() - 1);
  if (at >= yStart && at < yEnd) return ymd(yStart);
  return ymd(todayStart);
}
// Is "now" actually inside this shift's own window (handles shifts that
// cross midnight, like Night Shift 18:00-06:00)? Used so Day Shift and Night
// Shift tiles don't both show around the clock — each only appears while
// its own hours are running.
function isShiftActiveAt(shift, atMs){
  const at = new Date(atMs);
  const [sh, sm] = shift.startTime.split(':').map(Number);
  const [eh, em] = shift.endTime.split(':').map(Number);
  const crossesMidnight = (eh*60 + em) <= (sh*60 + sm);
  const todayStart = new Date(at); todayStart.setHours(sh, sm, 0, 0);
  const todayEnd = new Date(at); todayEnd.setHours(eh, em, 0, 0);
  if (crossesMidnight) todayEnd.setDate(todayEnd.getDate() + 1);
  if (at >= todayStart && at < todayEnd) return true;
  const yStart = new Date(todayStart); yStart.setDate(yStart.getDate() - 1);
  const yEnd = new Date(todayEnd); yEnd.setDate(yEnd.getDate() - 1);
  return at >= yStart && at < yEnd;
}
// How early a guard can clock in before their shift officially starts — someone
// arriving for handover/prep shouldn't be blocked, but clocking into a shift whose
// window isn't anywhere near now (e.g. selecting a 23:00 night shift at 11am)
// should be. Checks yesterday/today/tomorrow's occurrence of the shift so the
// overnight-wrap case (like a 23:00–06:00 shift) is handled the same way
// isShiftActiveAt() handles it elsewhere.
const SHIFT_CLOCK_IN_EARLY_GRACE_MS = 60 * 60000;
function canClockInToShift(shift, atMs){
  if (!shift) return false;
  const [sh, sm] = shift.startTime.split(':').map(Number);
  const [eh, em] = shift.endTime.split(':').map(Number);
  const crossesMidnight = (eh*60 + em) <= (sh*60 + sm);
  for (const dayOffset of [-1, 0, 1]){
    const start = new Date(atMs); start.setDate(start.getDate() + dayOffset); start.setHours(sh, sm, 0, 0);
    const end = new Date(start); end.setHours(eh, em, 0, 0);
    if (crossesMidnight) end.setDate(end.getDate() + 1);
    if (atMs >= start.getTime() - SHIFT_CLOCK_IN_EARLY_GRACE_MS && atMs < end.getTime()) return true;
  }
  return false;
}
function shiftEndMsFor(shift, shiftDate){
  const [y,m,d] = shiftDate.split('-').map(Number);
  const [sh, sm] = shift.startTime.split(':').map(Number);
  const [eh, em] = shift.endTime.split(':').map(Number);
  const crossesMidnight = (eh*60 + em) <= (sh*60 + sm);
  const end = new Date(y, m-1, d, eh, em, 0, 0);
  if (crossesMidnight) end.setDate(end.getDate() + 1);
  return end.getTime();
}
async function loadAlertSettingsForActiveSite(){
  if (!activeSiteId) return;
  const { data, error } = await sb.from('alert_settings').select('*').eq('site_id', activeSiteId).maybeSingle();
  if (error){ showToast('Could not load alert settings', error.message, 'danger'); return; }
  alertSettings = data
    ? { dashboard: data.notify_dashboard, sms: data.notify_sms, email: data.notify_email, escalation: data.escalation_threshold }
    : { dashboard: true, sms: false, email: false, escalation: 3 };
  renderAlertsForm();
}
async function loadInviteCodes(){
  const { data, error } = await sb.from('admin_invite_codes').select('*').order('created_at', { ascending: false });
  if (error){ showToast('Could not load invite codes', error.message, 'danger'); return; }
  const body = document.getElementById('inviteCodesBody');
  if (!data || !data.length){
    body.innerHTML = '<tr><td colspan="3" class="empty">No invite codes yet.</td></tr>';
    return;
  }
  body.innerHTML = data.map(row => `
    <tr>
      <td>${row.code}</td>
      <td>${new Date(row.created_at).toLocaleString([], { hour12: false })}</td>
      <td>${row.used_by ? `<span class="badge rejected">Used</span>` : `<span class="badge accepted">Unused</span>`}</td>
    </tr>
  `).join('');
}

function generateInviteCode(){
  const bytes = new Uint8Array(15);
  crypto.getRandomValues(bytes);
  const b32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid ambiguity
  let out = '';
  for (const b of bytes) out += b32[b % b32.length];
  return out.match(/.{1,4}/g).join('-');
}

document.getElementById('generateInviteBtn').addEventListener('click', async () => {
  const btn = document.getElementById('generateInviteBtn');
  const msg = document.getElementById('generateInviteMsg');
  btn.disabled = true;
  const code = generateInviteCode();
  const { error } = await sb.from('admin_invite_codes').insert({ code });
  if (error){
    msg.textContent = 'Could not generate code — ' + error.message;
    msg.style.color = 'var(--danger)';
  } else {
    msg.textContent = 'New code: ' + code + ' — copy it now and share it privately.';
    msg.style.color = 'var(--success)';
  }
  msg.style.display = 'block';
  btn.disabled = false;
  await loadInviteCodes();
});

async function loadControllerInviteCodes(){
  const { data, error } = await sb.from('controller_invite_codes').select('*').order('created_at', { ascending: false });
  if (error){ showToast('Could not load controller invite codes', error.message, 'danger'); return; }
  const body = document.getElementById('controllerInviteCodesBody');
  if (!body) return;
  if (!data || !data.length){
    body.innerHTML = '<tr><td colspan="3" class="empty">No invite codes yet.</td></tr>';
    return;
  }
  body.innerHTML = data.map(row => `
    <tr>
      <td>${row.code}</td>
      <td>${new Date(row.created_at).toLocaleString([], { hour12: false })}</td>
      <td>${row.used_by ? `<span class="badge rejected">Used</span>` : `<span class="badge accepted">Unused</span>`}</td>
    </tr>
  `).join('');
}

document.getElementById('generateControllerInviteBtn').addEventListener('click', async () => {
  const btn = document.getElementById('generateControllerInviteBtn');
  const msg = document.getElementById('generateControllerInviteMsg');
  btn.disabled = true;
  const code = generateInviteCode();
  const { error } = await sb.from('controller_invite_codes').insert({ code });
  if (error){
    msg.textContent = 'Could not generate code — ' + error.message;
    msg.style.color = 'var(--danger)';
  } else {
    msg.textContent = 'New code: ' + code + ' — copy it now and share it privately.';
    msg.style.color = 'var(--success)';
  }
  msg.style.display = 'block';
  btn.disabled = false;
  await loadControllerInviteCodes();
});

async function loadAllData(){
  if (OFFLINE_ENABLED && offlineMode){
    // Server unreachable at start-up: run from the copy saved on this phone.
    if (await offlineRestoreSnapshot()) return;
  }
  await loadSites();
  await loadCheckpoints();
  await loadRoutes();
  await loadSchedules();
  await loadScans();
  await loadSiteShifts();
  await loadAttendanceRecent();
  await loadAbsencesRecent();
  // Warm the guard-directory cache for every site the current user can see shifts
  // for, so coverage tiles and the reliever/covering-for pickers render names
  // immediately rather than one lazy RPC per tile.
  await Promise.all([...new Set(siteShifts.map(s => s.siteId))].map(id => loadGuardDirectory(id)));
  await loadAlertSettingsForActiveSite();
  if (profile && profile.role === 'admin'){
    await loadInviteCodes();
    await loadControllerInviteCodes();
    await loadUsersAdmin();
  }
  if (profile && (profile.role === 'admin' || profile.role === 'controller')){
    await loadNotifications();
    renderCoverageGrid('coverageGridAdmin');
    renderCoverageGrid('coverageGridCtrl');
    renderSiteShiftsTable();
  }
  if (profile && profile.role === 'guard'){
    const prevDutySite = activeDutySiteId;
    activeDutySiteId = (myAttendance && myAttendance.siteId) || guardSiteId;
    if (activeDutySiteId !== guardSiteId && activeDutySiteId !== prevDutySite){
      // clocked in somewhere other than home (relieving): bring in that site's scans too
      await loadScans();
      subscribeRealtime();
    }
    renderAttendanceCard();
    renderTeammatesCard();
    renderPanicActingAsSelector();
  }
  if (OFFLINE_ENABLED && profile && profile.role === 'guard'){
    offlineSnapshotSoon();
    offlineRefreshFaceRoster();
    setTimeout(() => { ensureFaceModels().catch(() => {}); }, 4000);   // warm the face models so they are saved for offline use
    offlineSyncSoon(2000);
    offlineRefreshCounts();
  }
}

