// ============================================================
// OnPatrol — Supabase-backed client
// ============================================================
// (qr-scanner auto-loads its Web Worker file from the same CDN path it was loaded
// from — no manual WORKER_PATH needed as of this version.)

const SUPABASE_URL = 'https://apesgglcqczyohykelup.supabase.co';
const SUPABASE_KEY = 'sb_publishable_BqKUmCs6Eu-AbP6uKXZh0w_lsBDgJnT';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let session = null, profile = null;
const INCIDENT_TYPES = [
  { value: 'theft', label: 'Theft' },
  { value: 'break_in', label: 'Break-in' },
  { value: 'fire', label: 'Fire' },
  { value: 'medical', label: 'Medical' },
  { value: 'assault', label: 'Assault' },
  { value: 'suspicious_person', label: 'Suspicious person' },
  { value: 'property_damage', label: 'Property damage' },
  { value: 'access_violation', label: 'Access violation' },
  { value: 'other', label: 'Other' }
];
const INCIDENT_SEVERITIES = [
  { value: 'low', label: 'Low', emoji: '🟢' },
  { value: 'medium', label: 'Medium', emoji: '🟡' },
  { value: 'high', label: 'High', emoji: '🟠' },
  { value: 'critical', label: 'Critical', emoji: '🔴' }
];

// ---------------- Local state (mirrors the DB; loaded async) ----------------
let sites = [];
let checkpoints = [];
let routes = [];
let schedules = [];
let scans = [];
let siteShifts = [];
let attendance = [];
let absences = [];
let myAttendance = null;           // guard's own current on_duty attendance row, if any
let activeDutySiteId = null;       // site the guard is actually clocked in/patrolling at (may differ from home site if relieving)
let guardDirectoryCache = {};      // siteId -> [{id, full_name, employee_number, site_id}], via list_site_guards()
let activeSiteId = null;
let guardSiteId = null;
// Checkpoints tapped (in order) while building a new route in the admin UI.
let routeBuilderOrder = [];
let alertSettings = { dashboard: true, sms: false, email: false, escalation: 3 };

// Central place to change which site the admin is managing — also clears
// the in-progress route builder and refreshes that site's alert settings.
function setActiveSite(id){
  activeSiteId = id;
  routeBuilderOrder = [];
  loadAlertSettingsForActiveSite();
  if (typeof renderSiteShiftsTable === 'function') renderSiteShiftsTable();
}

function nowMs(){ return Date.now(); }

// ============================================================
// Offline mode for guard phones
// ------------------------------------------------------------
// Rule: always talk to the server when there is a connection. Only when the
// server cannot be reached does the phone fall back to the copy of the site's
// data it saved earlier (schedules, checkpoints, roster, face data). Everything
// the guard does while offline is kept in a queue on the phone, stamped with
// the real time it happened, and sent automatically when signal returns.
//
// What works offline: scanning tags, clocking in/out (with a face check done on
// the phone), choosing who is on patrol, and the panic button (it keeps trying
// until it gets through).
// What still needs a connection: incident reports with photos, first-time face
// enrolment, and anything for a guard who has never signed in on this phone.
// ============================================================
const OFFLINE_ENABLED = true;                          // master switch: false turns every offline behaviour off
const OFFLINE_FACE_ENABLED = true;                     // false = clock-in needs a connection (no face data is kept on the phone)
const OFFLINE_FACE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;   // saved face data expires if it hasn't been refreshed for 7 days
const OFFLINE_SERVER_TIMEOUT_MS = 9000;                // how long to wait for the server before treating the connection as down

let offlineMode = false;              // true while the app is running from the saved copy (server unreachable at start-up)
let serverReachable = true;
let offlineQueueCount = 0, offlineQueueFailed = 0;
let offlineSnapSavedAt = Date.now();  // when the saved copy (incl. this guard's own face data) was last refreshed
let offlineLastSnap = 0, offlineLastRoster = 0;
let offlineSyncing = false, offlineBackBusy = false, offlineSentPanic = false;
let offlineSyncTimer = null, offlineSnapTimer = null;

// ---- tiny IndexedDB wrapper (survives closing the app and restarting the phone) ----
const OFF = (function(){
  let dbp = null;
  function open(){
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      if (!window.indexedDB){ reject(new Error('no indexedDB')); return; }
      const req = indexedDB.open('onpatrol-offline', 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('queue')) d.createObjectStore('queue', { keyPath: 'qid', autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  async function run(store, mode, fn){
    const d = await open();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      let req;
      try { req = fn(t.objectStore(store)); } catch(e){ reject(e); return; }
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  return {
    get: k => run('kv', 'readonly', s => s.get(k)).catch(() => undefined),
    set: (k, v) => run('kv', 'readwrite', s => s.put(v, k)).catch(e => console.warn('offline store', e)),
    del: k => run('kv', 'readwrite', s => s.delete(k)).catch(() => {}),
    qAdd: item => run('queue', 'readwrite', s => s.add(item)),
    qAll: () => run('queue', 'readonly', s => s.getAll()).catch(() => []),
    qGet: qid => run('queue', 'readonly', s => s.get(qid)).catch(() => undefined),
    qPut: item => run('queue', 'readwrite', s => s.put(item)).catch(() => {}),
    qDel: qid => run('queue', 'readwrite', s => s.delete(qid)).catch(() => {})
  };
})();

// ---- small helpers ----
function offlineNewId(){
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16); crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
// True when an error means "could not reach the server" (as opposed to the server
// answering with a refusal such as a wrong face or a permissions error).
function isNetworkFailure(err){
  if (!err) return false;
  const name = String(err.name || '');
  const msg = String(err.message || err).toLowerCase();
  return name === 'FunctionsFetchError' || name === 'AbortError' || name === 'TypeError' ||
    /failed to fetch|networkerror|network request failed|load failed|fetch failed|timed out|timeout|err_internet|offline/.test(msg);
}
function withTimeout(promise, ms){
  return new Promise(resolve => {
    const t = setTimeout(() => resolve({ data: null, error: { name: 'AbortError', message: 'timed out' } }), ms);
    Promise.resolve(promise).then(r => { clearTimeout(t); resolve(r); }, e => { clearTimeout(t); resolve({ data: null, error: e }); });
  });
}
function offlineKnownDown(){ return !!OFFLINE_ENABLED && (navigator.onLine === false || !serverReachable); }
function offlineMarkServerDown(){ if (serverReachable){ serverReachable = false; offlineRenderBanner(); } }
function offlineMarkServerUp(){ if (!serverReachable){ serverReachable = true; offlineRenderBanner(); offlineOnBackOnline(); } }
function offlineFaceDistance(a, b){
  let sum = 0; const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++){ const d = a[i] - b[i]; sum += d * d; }
  return Math.sqrt(sum);   // same measure and threshold (0.55) the server uses
}
async function offlinePing(){
  try{
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(SUPABASE_URL + '/auth/v1/health', { headers: { apikey: SUPABASE_KEY }, signal: ctl.signal, cache: 'no-store' });
    clearTimeout(t);
    return r.status < 500;   // any answer at all means the server can be reached
  }catch(e){ return false; }
}

// ---- the saved copy of the site's data ----
function offlineSnapshotSoon(){
  if (!OFFLINE_ENABLED || offlineSnapTimer) return;
  offlineSnapTimer = setTimeout(() => { offlineSnapTimer = null; offlineSaveSnapshot(); }, 1500);
}
async function offlineSaveSnapshot(){
  if (!OFFLINE_ENABLED || !profile || profile.role !== 'guard' || !session || session.offline || offlineMode) return;
  offlineSnapSavedAt = Date.now(); offlineLastSnap = offlineSnapSavedAt;
  await OFF.set('snapshot', {
    v: 1, savedAt: offlineSnapSavedAt,
    userId: session.user.id, email: session.user.email || null,
    profile, guardSiteId, activeDutySiteId,
    sites, checkpoints, routes, schedules, siteShifts, attendance, absences, scans,
    guardDirectoryCache, alertSettings, companyName
  });
}
async function offlineCachedProfile(){
  if (!OFFLINE_ENABLED || !session) return null;
  const snap = await OFF.get('snapshot');
  if (!snap || snap.v !== 1 || !snap.profile || snap.userId !== session.user.id) return null;
  if (snap.profile.role !== 'guard') return null;   // offline mode is for guard phones only
  offlineSnapSavedAt = snap.savedAt || 0;
  return snap.profile;
}
async function offlineRestoreSnapshot(){
  const snap = await OFF.get('snapshot');
  if (!snap || snap.v !== 1) return false;
  sites = snap.sites || []; checkpoints = snap.checkpoints || []; routes = snap.routes || [];
  schedules = snap.schedules || []; siteShifts = snap.siteShifts || []; attendance = snap.attendance || [];
  absences = snap.absences || []; scans = snap.scans || [];
  guardDirectoryCache = snap.guardDirectoryCache || {};
  alertSettings = snap.alertSettings || alertSettings;
  companyName = snap.companyName || companyName;
  guardSiteId = snap.guardSiteId || guardSiteId;
  activeDutySiteId = snap.activeDutySiteId || null;
  if (!activeSiteId || !sites.some(s => s.id === activeSiteId)) activeSiteId = guardSiteId || (sites[0] ? sites[0].id : null);
  await offlineApplyQueueToState();
  myAttendance = (session && attendance.find(a => a.guardId === session.user.id && a.status === 'on_duty')) || null;
  if (myAttendance && myAttendance.siteId) activeDutySiteId = myAttendance.siteId;
  return true;
}
// Puts everything still waiting in the queue back into the on-screen state, so a
// scan or clock-in made offline stays visible (and counts toward the patrol)
// even after the app is reopened or refreshed before it has been sent.
async function offlineApplyQueueToState(){
  if (!OFFLINE_ENABLED || !profile || profile.role !== 'guard') return false;
  const items = await OFF.qAll();
  let changed = false;
  for (const it of items){
    const p = it.payload || {};
    if (it.type === 'scan' && p.row){
      if (!scans.some(s => s.id === p.row.id)){ scans.push(rowToScan(p.row)); changed = true; }
    } else if (it.type === 'clock_in' && p.body){
      const b = p.body;
      if (!attendance.some(a => a.id === b.client_attendance_id)){
        attendance.push({ id: b.client_attendance_id, siteId: b.site_id, shiftId: b.shift_id, shiftDate: b.shift_date, guardId: b.target_guard_id, isReliever: !!b.is_reliever, coveringGuardId: null, clockInAt: Date.parse(b.clock_in_at), clockOutAt: null, status: 'on_duty', pending: true });
        changed = true;
      }
    } else if (it.type === 'clock_out' && p.patch){
      const a = attendance.find(x => x.id === p.id);
      if (a && a.status !== 'clocked_out'){ a.status = 'clocked_out'; a.clockOutAt = Date.parse(p.patch.clock_out_at); changed = true; }
    } else if (it.type === 'assign' && p.instId && p.row){
      if (!patrolAssignmentsCache[p.instId]) patrolAssignmentsCache[p.instId] = { guardId: p.row.guard_id, guardName: p.guardName || 'A guard' };
    }
  }
  if (changed) scans.sort((a, b) => a.timestamp - b.timestamp);
  return changed;
}

// ---- the queue ----
async function offlineEnqueue(type, payload){
  const qid = await OFF.qAdd({ type, payload, at: Date.now(), attempts: 0, failed: false, lastError: null });
  await offlineRefreshCounts();
  offlineSyncSoon(type === 'panic' ? 1500 : 4000);
  return qid;
}
async function offlineRefreshCounts(){
  const all = await OFF.qAll();
  // A waiting panic alert is never counted or mentioned on screen (see the panic button note).
  offlineQueueCount = all.filter(i => !i.failed && i.type !== 'panic').length;
  offlineQueueFailed = all.filter(i => i.failed && i.type !== 'panic').length;
  offlineRenderBanner();
}
function offlineSyncSoon(ms){
  clearTimeout(offlineSyncTimer);
  offlineSyncTimer = setTimeout(offlineSync, ms == null ? 1500 : ms);
}
async function offlineRemapAttendanceId(oldId, newId){
  const items = await OFF.qAll();
  for (const it of items){
    const p = it.payload || {};
    if (it.type === 'scan' && p.row && p.row.attendance_id === oldId){ p.row.attendance_id = newId; await OFF.qPut(it); }
    if (it.type === 'clock_out' && p.id === oldId){ p.id = newId; await OFF.qPut(it); }
  }
  attendance.forEach(a => { if (a.id === oldId) a.id = newId; });
}
// Sends one queued item. Returns 'done', 'retry' (try again later, keep order) or 'failed'.
async function offlineSendOne(item){
  const p = item.payload || {};
  let res = null;
  if (item.type === 'scan') res = await withTimeout(sb.from('scans').insert(p.row), 20000);
  else if (item.type === 'notification') res = await withTimeout(sb.from('patrol_notifications').insert(p.row), 20000);
  else if (item.type === 'assign') res = await withTimeout(sb.from('patrol_assignments').insert(p.row), 20000);
  else if (item.type === 'clock_out') res = await withTimeout(sb.from('attendance').update(p.patch).eq('id', p.id), 20000);
  else if (item.type === 'panic') res = await withTimeout(sb.rpc('trigger_panic', p.args), 15000);
  else if (item.type === 'clock_in'){
    res = await withTimeout(sb.functions.invoke('clock-in-offline', { body: p.body }), 30000);
    if (res.error && !isNetworkFailure(res.error)){
      const msg = await functionErrorMessage(res.data, res.error, 'Could not sync clock-in.');
      res = { data: null, error: { message: msg, code: 'fn' } };
    } else if (!res.error && res.data && res.data.error){
      res = { data: null, error: { message: res.data.error, code: 'fn' } };
    } else if (!res.error && res.data && res.data.attendance && res.data.attendance.id !== p.body.client_attendance_id){
      await offlineRemapAttendanceId(p.body.client_attendance_id, res.data.attendance.id);
    }
  } else return 'failed';

  const err = res && res.error;
  if (!err){ if (item.type === 'panic') offlineSentPanic = true; return 'done'; }
  if (isNetworkFailure(err)){ offlineMarkServerDown(); return 'retry'; }
  const msg = String(err.message || '');
  // Already stored (a retry after a reply that got lost) counts as success.
  if (err.code === '23505' || /duplicate key|unique constraint/i.test(msg)) return 'done';
  if (err.status === 401 || /jwt|not authenticated|invalid token/i.test(msg)) return 'retry';
  item.attempts = (item.attempts || 0) + 1;
  item.lastError = msg.slice(0, 300);
  await OFF.qPut(item);
  return (item.attempts >= 5 && item.type !== 'panic') ? 'failed' : 'retry';   // a panic alert is never given up on
}
async function offlineSync(){
  if (!OFFLINE_ENABLED || offlineSyncing || !session || session.offline) return;
  if (navigator.onLine === false) return;
  offlineSyncing = true;
  let sent = 0;
  try{
    const ids = (await OFF.qAll()).filter(i => !i.failed).map(i => i.qid);
    for (const qid of ids){
      const item = await OFF.qGet(qid);                // read fresh: an earlier item may have re-pointed this one
      if (!item || item.failed) continue;
      const r = await offlineSendOne(item);
      if (r === 'done'){ await OFF.qDel(item.qid); if (item.type !== 'panic') sent++; }
      else if (r === 'retry'){ if (item.type === 'panic') continue; break; }   // panic never holds the rest of the queue up; otherwise stop, keep the order, try again soon
      else { item.failed = true; await OFF.qPut(item); }
    }
  } finally {
    offlineSyncing = false;
    await offlineRefreshCounts();
  }
  if (offlineSentPanic){
    // A panic alert that was waiting has now been delivered: one long buzz, nothing on screen.
    offlineSentPanic = false; lastPanicDelivered = true;
    offlineMarkServerUp();
    panicHaptic(true);
    guardTrackingCheck();
  }
  if (sent){
    offlineMarkServerUp();
    await offlineAfterSync(sent);
  }
  const left = (await OFF.qAll()).filter(i => !i.failed);
  if (left.length) offlineSyncSoon(left.some(i => i.type === 'panic') ? 5000 : 20000);
}
async function offlineAfterSync(sent){
  try{
    await loadAttendanceRecent(); await loadAbsencesRecent(); await loadScans();
    renderStats(); renderLog(); renderGuardPatrolCard(); renderAttendanceCard(); renderTeammatesCard(); renderPanicActingAsSelector();
  }catch(e){ console.warn('after sync', e); }
  showToast('Back online', `${sent} saved item${sent === 1 ? '' : 's'} sent.`, 'success');
}
async function offlineOnBackOnline(){
  if (!OFFLINE_ENABLED || !profile || profile.role !== 'guard' || offlineBackBusy) return;
  offlineBackBusy = true;
  try{
    serverReachable = true;
    const r = await sb.auth.getSession().catch(() => ({ data: null }));
    const s = r && r.data && r.data.session;
    if (!s) return;                       // no valid login yet — the auth library keeps retrying in the background
    if (session && session.offline) session = s;
    await offlineSync();
    if (offlineMode){
      offlineMode = false;
      await loadAllData(); renderAll(); subscribeRealtime();
    } else offlineRefreshFaceRoster();
  } finally { offlineBackBusy = false; offlineRenderBanner(); }
}

// ---- helpers used by the guard actions ----
async function offlineInsertNotification(row){
  if (!offlineKnownDown()){
    const r = await withTimeout(sb.from('patrol_notifications').insert(row), OFFLINE_SERVER_TIMEOUT_MS);
    if (!r.error) return;
    if (!(OFFLINE_ENABLED && isNetworkFailure(r.error))){ console.warn('alert not saved', r.error); return; }
    offlineMarkServerDown();
  }
  if (OFFLINE_ENABLED) await offlineEnqueue('notification', { row });
}
async function offlineClockOut(attendanceId, extra){
  const patch = Object.assign({ status: 'clocked_out', clock_out_at: new Date().toISOString() }, extra || {});
  if (!offlineKnownDown()){
    const r = await withTimeout(sb.from('attendance').update(patch).eq('id', attendanceId), OFFLINE_SERVER_TIMEOUT_MS);
    if (!r.error){ offlineMarkServerUp(); return { ok: true, queued: false }; }
    if (!(OFFLINE_ENABLED && isNetworkFailure(r.error))) return { ok: false, message: r.error.message };
    offlineMarkServerDown();
  }
  if (!OFFLINE_ENABLED) return { ok: false, message: 'No connection.' };
  await offlineEnqueue('clock_out', { id: attendanceId, patch });
  await offlineApplyQueueToState();
  myAttendance = (session && attendance.find(a => a.guardId === session.user.id && a.status === 'on_duty')) || null;
  offlineSnapshotSoon();
  showToast('Saved on this phone', 'No connection — the clock-out will send automatically.', 'warn');
  return { ok: true, queued: true };
}
// Face check done on the phone, used only when the server cannot be reached.
// The server checks the same face again when the clock-in is sent.
async function offlineClockIn({ guardId, siteId, shiftId, shiftDate, isReliever, coveringAbsenceId, descriptor, byId }){
  if (!OFFLINE_FACE_ENABLED) return { error: 'No connection — clock-in needs a connection on this phone.' };
  if (Date.now() - offlineSnapSavedAt > OFFLINE_FACE_MAX_AGE_MS) return { error: 'No connection, and the face data saved on this phone is over 7 days old. Connect once to refresh it.' };
  const isSelf = guardId === session.user.id;
  let reference = null, whose = 'your';
  if (isSelf){
    reference = Array.isArray(profile.face_descriptor) && profile.face_descriptor.length ? profile.face_descriptor : null;
    if (!reference) return { error: 'No connection — your first face enrolment needs a connection. Try again when you have signal.' };
  } else {
    const roster = await OFF.get('faceRoster');
    const fresh = roster && roster.siteId === siteId && (Date.now() - roster.savedAt) <= OFFLINE_FACE_MAX_AGE_MS;
    if (!fresh) return { error: 'No connection, and this phone has no up-to-date face data for this site. Connect once to refresh it.' };
    const entry = (roster.guards || []).find(g => g.id === guardId);
    if (!entry || !Array.isArray(entry.descriptor)) return { error: "No connection, and this guard isn't in the face data saved on this phone. They can clock in once signal returns." };
    reference = entry.descriptor; whose = "this guard's";
  }
  const dist = offlineFaceDistance(reference, descriptor);
  if (dist > FACE_MATCH_THRESHOLD) return { error: `Face didn't match ${whose} enrolled profile. Try again with better lighting.` };
  if (attendance.some(a => a.guardId === guardId && a.status === 'on_duty')) return { error: 'Already clocked in — clock out first.' };
  const id = offlineNewId();
  const nowIso = new Date().toISOString();
  await offlineEnqueue('clock_in', { body: {
    client_attendance_id: id, target_guard_id: guardId, site_id: siteId, shift_id: shiftId, shift_date: shiftDate,
    is_reliever: !!isReliever, covering_absence_id: coveringAbsenceId || null,
    descriptor, clock_in_at: nowIso, local_face_score: dist, clocked_in_by: byId || null
  }});
  const rec = { id, siteId, shiftId, shiftDate, guardId, isReliever: !!isReliever, coveringGuardId: null, clockInAt: Date.parse(nowIso), clockOutAt: null, status: 'on_duty', pending: true };
  attendance.push(rec);
  if (isSelf) myAttendance = rec;
  offlineSnapshotSoon();
  return { attendance: rec, score: dist };
}
// Keeps a copy of this site's guards' face data on the phone (needed to clock teammates in offline).
async function offlineRefreshFaceRoster(){
  if (!OFFLINE_ENABLED || !OFFLINE_FACE_ENABLED || !profile || profile.role !== 'guard' || offlineKnownDown()) return;
  const siteId = activeDutySiteId || guardSiteId;
  if (!siteId) return;
  offlineLastRoster = Date.now();
  const r = await withTimeout(sb.functions.invoke('get-site-face-roster', { body: { site_id: siteId } }), 15000);
  if (r.error || !r.data || !Array.isArray(r.data.guards)) return;   // not available yet — offline clock-in for teammates simply stays off
  await OFF.set('faceRoster', { siteId, savedAt: Date.now(), guards: r.data.guards });
}

// ---- status banner + heartbeat ----
function offlineRenderBanner(){
  const el = document.getElementById('offlineBanner');
  if (!el) return;
  const guard = OFFLINE_ENABLED && profile && profile.role === 'guard';
  let msg = '', kind = '';
  if (guard){
    const n = offlineQueueCount, f = offlineQueueFailed;
    if (offlineKnownDown()){
      kind = 'down';
      msg = n ? `No connection — ${n} saved on this phone. Sending when signal returns.`
              : 'No connection — working from saved site data. Scans, clock-ins and panic alerts are kept and sent when signal returns.';
    } else if (f){
      kind = 'fail';
      msg = `${f} saved item${f === 1 ? '' : 's'} could not be sent — tell your controller.`;
    } else if (n){
      kind = 'sync';
      msg = `Sending ${n} saved item${n === 1 ? '' : 's'}…`;
    }
  }
  if (el.textContent !== msg) el.textContent = msg;
  document.body.classList.toggle('has-offline-banner', !!msg);
  el.dataset.kind = kind;
  el.style.display = msg ? 'block' : 'none';
}
async function offlineHeartbeat(force){
  if (!OFFLINE_ENABLED || !profile || profile.role !== 'guard') return;
  if (navigator.onLine === false){ serverReachable = false; offlineRenderBanner(); return; }
  if (serverReachable && !offlineMode && offlineQueueCount === 0 && !force){
    const now = Date.now();
    if (now - offlineLastSnap > 10 * 60 * 1000) offlineSnapshotSoon();
    if (now - offlineLastRoster > 6 * 60 * 60 * 1000) offlineRefreshFaceRoster();
    return;
  }
  const ok = await offlinePing();
  if (ok) await offlineOnBackOnline(); else serverReachable = false;
  offlineRenderBanner();
}
window.addEventListener('online', () => { offlineHeartbeat(true); });
window.addEventListener('offline', () => { offlineRenderBanner(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) offlineHeartbeat(true); });
setInterval(offlineHeartbeat, 20000);
if (OFFLINE_ENABLED && 'serviceWorker' in navigator){
  // Lets the app itself (page, libraries, face models) open with no signal. sw.js must sit next to index.html.
  window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(e => console.warn('service worker', e)); });
}

// Alerts change in bursts (the server writes a batch at once). Reload the alert list once
// per burst instead of once per row, so controllers' screens stay responsive.
let notifReloadTimer = null;
function scheduleNotifReload(){
  if (notifReloadTimer) return;
  notifReloadTimer = setTimeout(() => { notifReloadTimer = null; loadNotifications().then(renderNotifications); }, 1200);
}

