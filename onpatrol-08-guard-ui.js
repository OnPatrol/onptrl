// ---------------- Skip a checkpoint (tag damaged / missing / blocked / not responding) ----------------
// A skip is saved like a scan (result SKIPPED + the reason), so it works offline too and every patrol
// calculation treats the tag as excused. The database raises the orange "tag skipped" alert for the
// control room (it clears itself after an hour, like the green ones).
let skipModalState = { qrId: null, reason: null, busy: false };

function skipCandidates(){
  const gate = guardPatrolGate();
  if (!myAttendance || !gate.inProgress || !gate.instSt) return null;
  const remaining = gate.instSt.cpIds.filter(id => !gate.instSt.doneCps.includes(id));
  if (!remaining.length) return null;
  // Strict-order routes can only move forward, so only the next tag can be skipped.
  const strict = !!(gate.dutyRoute && gate.dutyRoute.strictOrder);
  return { gate, remaining: strict ? [remaining[0]] : remaining };
}
function skipCpName(qrId){ const cp = checkpoints.find(c => c.qrId === qrId); return cp ? cp.name : qrId; }

function openSkipModal(){
  const cand = skipCandidates();
  if (!cand){
    showToast('Nothing to skip', 'You can skip a checkpoint while a patrol is in progress and has checkpoints left.', 'warn');
    return;
  }
  skipModalState = { qrId: cand.remaining[0], reason: null, busy: false };
  const lineEl = document.getElementById('skipTagCheckpoint');
  const wrap = document.getElementById('skipTagSelectWrap');
  const sel = document.getElementById('skipTagSelect');
  if (cand.remaining.length > 1){
    sel.innerHTML = cand.remaining.map(id => `<option value="${escapeHtmlForPrint(id)}">${escapeHtmlForPrint(skipCpName(id))}</option>`).join('');
    sel.value = skipModalState.qrId;
    wrap.style.display = ''; lineEl.style.display = 'none';
  } else {
    wrap.style.display = 'none'; lineEl.style.display = ''; lineEl.textContent = skipCpName(cand.remaining[0]);
  }
  document.getElementById('skipTagReasons').innerHTML = SKIP_REASONS.map(r =>
    `<button type="button" class="skip-option" data-skip-reason="${r.id}"><span class="skip-radio"></span>${r.label}</button>`).join('');
  document.querySelectorAll('#skipTagReasons [data-skip-reason]').forEach(btn => {
    btn.addEventListener('click', () => {
      skipModalState.reason = btn.dataset.skipReason;
      document.querySelectorAll('#skipTagReasons .skip-option').forEach(b => b.classList.toggle('selected', b === btn));
      document.getElementById('skipTagConfirmBtn').disabled = false;
      document.getElementById('skipTagError').style.display = 'none';
    });
  });
  document.getElementById('skipTagConfirmBtn').disabled = true;
  document.getElementById('skipTagCancelBtn').disabled = false;
  document.getElementById('skipTagError').style.display = 'none';
  document.getElementById('skipTagModalBg').classList.add('show');
}
function closeSkipModal(){ document.getElementById('skipTagModalBg').classList.remove('show'); }

// Same save path as a normal scan: server first; if there is no signal it is kept on the phone and sent later.
async function recordSkip(qrId, reason){
  const dutySiteId = activeDutySiteId || guardSiteId;
  const cp = checkpoints.find(c => c.qrId === qrId && c.siteId === dutySiteId);
  if (!cp) return { error: 'That checkpoint could not be found.' };
  const { dutyInfo, instSt } = guardPatrolGate();
  if (!dutyInfo || !instSt) return { error: 'No patrol is in progress any more.' };
  // Attributed to whoever is locked in as "on patrol" for this round, same as a scan.
  const lockedAssignment = patrolAssignmentsCache[dutyInfo.inst.id];
  const actingGuardId = lockedAssignment ? lockedAssignment.guardId : session.user.id;
  const actingAttendance = actingGuardId === session.user.id
    ? myAttendance
    : attendance.find(a => a.guardId === actingGuardId && a.status === 'on_duty' && a.siteId === dutySiteId) || myAttendance;
  if (!actingAttendance) return { error: "You're not clocked in." };

  const payload = {
    id: offlineNewId(),
    site_id: cp.siteId,
    checkpoint_id: cp.id,
    raw_qr_id: qrId,
    route_id: dutyInfo.inst.routeId,
    guard_id: actingGuardId,
    attendance_id: actingAttendance.id,
    result: 'SKIPPED',
    skip_reason: reason,
    distance_m: null,
    is_mock: false,
    is_late: Date.now() >= instSt.durationEnd,
    expected_qr_id: null
  };
  let row = null, error = null, queued = false;
  if (OFFLINE_ENABLED && navigator.onLine === false){
    error = { name: 'AbortError', message: 'offline' };
  } else {
    const r = await withTimeout(sb.from('scans').insert(payload).select().single(), offlineKnownDown() ? 4000 : OFFLINE_SERVER_TIMEOUT_MS);
    row = r.data; error = r.error;
    if (!error) offlineMarkServerUp();
  }
  if (error && OFFLINE_ENABLED && isNetworkFailure(error)){
    offlineMarkServerDown();
    row = Object.assign({}, payload, { created_at: new Date().toISOString() });
    await offlineEnqueue('scan', { row });
    queued = true;
    error = null;
  }
  if (error) return { error: error.message || 'Could not save the skip.' };

  const record = rowToScan(row);
  if (!scans.some(s => s.id === record.id)) scans.push(record);
  scans.sort((a, b) => a.timestamp - b.timestamp);
  return { record, queued, cpName: cp.name };
}

async function confirmSkip(){
  if (skipModalState.busy || !skipModalState.reason) return;
  const sel = document.getElementById('skipTagSelect');
  if (document.getElementById('skipTagSelectWrap').style.display !== 'none' && sel.value) skipModalState.qrId = sel.value;
  const errEl = document.getElementById('skipTagError');
  const cand = skipCandidates();
  if (!cand || !cand.remaining.includes(skipModalState.qrId)){
    errEl.textContent = 'This checkpoint can no longer be skipped — the patrol may have moved on.';
    errEl.style.display = 'block';
    return;
  }
  skipModalState.busy = true;
  const confirmBtn = document.getElementById('skipTagConfirmBtn');
  const cancelBtn = document.getElementById('skipTagCancelBtn');
  confirmBtn.disabled = true; cancelBtn.disabled = true;
  const res = await recordSkip(skipModalState.qrId, skipModalState.reason);
  skipModalState.busy = false;
  cancelBtn.disabled = false;
  if (res.error){
    errEl.textContent = res.error;
    errEl.style.display = 'block';
    confirmBtn.disabled = false;
    return;
  }
  closeSkipModal();
  showToast('Checkpoint skipped',
    res.queued ? `${res.cpName} — ${skipReasonLabel(skipModalState.reason)}. No connection: saved on this phone, the control room is alerted when it sends.`
               : `${res.cpName} — ${skipReasonLabel(skipModalState.reason)}. The control room has been alerted.`, 'warn');
  renderStats(); renderLog(); renderGuardPatrolCard();
}
document.getElementById('skipTagBtn').addEventListener('click', openSkipModal);
document.getElementById('skipTagCancelBtn').addEventListener('click', closeSkipModal);
document.getElementById('skipTagConfirmBtn').addEventListener('click', confirmSkip);

let resultCardHideTimer = null;
function showResult(record){
  const card = document.getElementById('resultCard');
  const title = document.getElementById('resultTitle');
  const meta = document.getElementById('resultMeta');
  card.classList.remove('accepted','rejected');
  card.classList.add('show', record.result === 'ACCEPTED' ? 'accepted' : 'rejected');

  // Hovering on top of the camera feed, it needs to get out of the way on its own —
  // otherwise it'd sit there blocking the next scan until something else replaces it.
  if (resultCardHideTimer) clearTimeout(resultCardHideTimer);
  resultCardHideTimer = setTimeout(() => { card.classList.remove('show'); resultCardHideTimer = null; }, 30000);

  if (record.result === 'ACCEPTED'){
    title.textContent = `Verified — ${record.cpName}`;
  } else {
    const expectedCp = record.expectedQrId ? checkpoints.find(c => c.qrId === record.expectedQrId) : null;
    const reasons = {
      REJECTED_UNKNOWN_QR: 'No tag found — this code doesn\'t match any checkpoint',
      REJECTED_WRONG_SITE: 'This tag isn\'t one of your site\'s checkpoints',
      REJECTED_NO_LOCATION: 'Could not confirm your location — enable location services and try again',
      REJECTED_OUT_OF_RANGE: 'Guard is outside the checkpoint radius',
      REJECTED_OUT_OF_ORDER: `Wrong checkpoint — this route requires checkpoints in order, expected ${expectedCp ? expectedCp.name : record.expectedQrId} next`,
      REJECTED_ALREADY_SCANNED: 'Tag already scanned — already checked in on this tag for the current patrol',
      REJECTED_NO_PATROL: 'No patrol in progress — scanning is disabled until your patrol starts',
      REJECTED_NOT_CLOCKED_IN: 'You\'re not clocked in — clock in above before scanning checkpoints'
    };
    title.textContent = `Rejected — ${reasons[record.result] || (record.saveFailed ? 'Could not save scan' : record.result)}`;
  }
  const site = sites.find(x => x.id === record.siteId);
  meta.innerHTML = `site: ${escapeHtmlForPrint(site ? site.name : 'n/a')}<br>qrId: ${escapeHtmlForPrint(record.qrId)}<br>distance: ${record.distance != null ? record.distance.toFixed(1)+'m' : 'n/a'}<br>time: ${new Date(record.timestamp).toLocaleTimeString([], { hour12: false })}`;
}

// ---------------- Guard view interactions ----------------
let manualStatusHideTimer = null;
function setManualScanStatus(text, isError){
  const statusEl = document.getElementById('manualScanStatus');
  statusEl.textContent = text;
  statusEl.classList.toggle('error-text', !!isError);
  statusEl.classList.toggle('show', !!text);
  if (manualStatusHideTimer){ clearTimeout(manualStatusHideTimer); manualStatusHideTimer = null; }
  // These sit over the camera where the guard is already looking, so — like the
  // scan-result card — they get out of the way on their own after 30s instead of
  // sitting there until the next tap.
  if (text){
    manualStatusHideTimer = setTimeout(() => {
      statusEl.classList.remove('show');
      manualStatusHideTimer = null;
    }, 30000);
  }
}

// ---------------- Panic button ----------------
// Hold-to-confirm rather than a single tap: a brush against a pocket or
// camera strap shouldn't be able to fire this. Holding for the full
// duration is still fast enough in a genuine emergency, and a partial
// hold cancels cleanly with no side effects.
// Everyone currently on duty at a given site, self first — shared by the
// panic "who's pressing this" selector and the per-patrol "who's on patrol"
// lock below, so both agree on the same roster.
function onDutyGuardsAtSite(siteId){
  const onDutyHere = [{ id: session.user.id, full_name: profile.full_name || 'You' }];
  const dir = guardDirectoryCache[siteId] || [];
  attendance.forEach(a => {
    if (a.status === 'on_duty' && a.siteId === siteId && a.guardId !== session.user.id){
      const g = dir.find(x => x.id === a.guardId);
      if (g && !onDutyHere.some(o => o.id === g.id)) onDutyHere.push({ id: g.id, full_name: g.full_name });
    }
  });
  return onDutyHere;
}

// Who's actually pressing the panic button, on a shared device with more than
// one guard on duty. Defaults to whoever's logged in; only shown at all when
// there's someone else on duty at the same site to pick from, so the normal
// one-guard case has zero added friction. Remembers the last pick for the
// rest of the session — you don't have to reselect yourself every time.
// Superseded automatically by the per-patrol "who's on patrol" lock whenever
// one is active — see renderPanicActingAsSelector below.
let panicActingAsGuardId = null;
function renderPanicActingAsSelector(){
  const wrap = document.getElementById('panicActingAsWrap');
  const sel = document.getElementById('panicActingAsSelect');
  if (!wrap || !sel || profile.role !== 'guard') return;
  const dutySiteId = activeDutySiteId || guardSiteId;
  const onDutyHere = onDutyGuardsAtSite(dutySiteId);

  // A locked-in "who's on patrol" answer for the current round takes over
  // completely — the server already prefers it regardless, so showing a
  // separate editable dropdown here would just be confusing.
  const dutyInfo = currentDutyRouteNextInstance();
  const lockedAssignment = dutyInfo ? patrolAssignmentsCache[dutyInfo.inst.id] : null;
  if (lockedAssignment){
    wrap.style.display = 'block';
    sel.innerHTML = `<option value="${lockedAssignment.guardId}">${escapeHtmlForPrint(lockedAssignment.guardName)} (locked in for this patrol)</option>`;
    sel.disabled = true;
    panicActingAsGuardId = lockedAssignment.guardId;
    return;
  }
  sel.disabled = false;

  if (onDutyHere.length < 2){
    wrap.style.display = 'none';
    panicActingAsGuardId = session.user.id;
    return;
  }
  wrap.style.display = 'block';
  if (!onDutyHere.some(o => o.id === panicActingAsGuardId)) panicActingAsGuardId = session.user.id;
  sel.innerHTML = onDutyHere.map(o => `<option value="${o.id}" ${o.id === panicActingAsGuardId ? 'selected' : ''}>${o.id === session.user.id ? escapeHtmlForPrint(o.full_name) + ' (you, logged in)' : escapeHtmlForPrint(o.full_name)}</option>`).join('');
}
document.getElementById('panicActingAsSelect').addEventListener('change', e => { panicActingAsGuardId = e.target.value; });

// ---------------- "Who's on patrol?" per-round lock ----------------
// On sites with more than one guard, each new scheduled patrol round needs an
// answer to "who's actually walking this one" before any tag can be accepted -
// once answered, it's never editable again for that round (enforced by the
// database, not just the UI: patrol_assignments has no update/delete policy).
// This is what makes checkpoint scans and panic alerts attribute correctly to
// whichever guard is physically on patrol, not just whoever's session is
// logged in on a shared device.
let patrolAssignmentsCache = {};   // inst.id -> {guardId, guardName}
let patrolAssignmentPromptInstId = null; // inst.id currently showing the modal, if any

async function ensurePatrolAssignment(){
  if (!profile || profile.role !== 'guard' || !myAttendance) return;
  const dutyInfo = currentDutyRouteNextInstance();
  if (!dutyInfo) return;
  const inst = dutyInfo.inst;
  const st = instanceStatus(inst, nowMs());
  // No need to ask before the round is actually starting - "upcoming" (more
  // than the due-soon window away) doesn't need an answer yet.
  if (st.status === 'upcoming') return;
  if (patrolAssignmentsCache[inst.id]) return;
  if (patrolAssignmentPromptInstId === inst.id) return; // modal already up for this exact round

  const dutySiteId = activeDutySiteId || guardSiteId;
  const onDutyHere = onDutyGuardsAtSite(dutySiteId);
  if (onDutyHere.length < 2) return; // single-guard site - nothing to disambiguate

  // Someone else on this device (or a previous load) may have already
  // answered for this exact round - check before prompting again.
  const { data: existing, error: existingErr } = await sb
    .from('patrol_assignments')
    .select('guard_id')
    .eq('route_id', inst.routeId)
    .eq('expected_time', new Date(inst.expectedTime).toISOString())
    .maybeSingle();
  if (!existingErr && existing){
    const g = onDutyHere.find(o => o.id === existing.guard_id);
    patrolAssignmentsCache[inst.id] = { guardId: existing.guard_id, guardName: g ? g.full_name : 'A guard' };
    renderGuardPatrolCard();
    renderPanicActingAsSelector();
    return;
  }

  showPatrolAssignmentModal(inst, onDutyHere);
}

function showPatrolAssignmentModal(inst, onDutyHere){
  patrolAssignmentPromptInstId = inst.id;
  const modal = document.getElementById('patrolAssignmentModalBg');
  const list = document.getElementById('patrolAssignmentList');
  const errEl = document.getElementById('patrolAssignmentError');
  errEl.style.display = 'none';
  list.innerHTML = onDutyHere.map(o => `<button type="button" class="btn btn-primary" style="width:100%; margin-bottom:8px;" data-assign-guard="${o.id}">${o.id === session.user.id ? escapeHtmlForPrint(o.full_name) + ' (you)' : escapeHtmlForPrint(o.full_name)}</button>`).join('');
  list.querySelectorAll('[data-assign-guard]').forEach(btn => {
    btn.addEventListener('click', () => confirmPatrolAssignment(inst, btn.dataset.assignGuard, onDutyHere));
  });
  modal.classList.add('show');
}

async function confirmPatrolAssignment(inst, guardId, onDutyHere){
  const errEl = document.getElementById('patrolAssignmentError');
  errEl.style.display = 'none';
  const dutySiteId = activeDutySiteId || guardSiteId;
  const assignRow = {
    route_id: inst.routeId,
    expected_time: new Date(inst.expectedTime).toISOString(),
    site_id: dutySiteId,
    guard_id: guardId
  };
  let error = null;
  if (OFFLINE_ENABLED && navigator.onLine === false) error = { name: 'AbortError', message: 'offline' };
  else { const r = await withTimeout(sb.from('patrol_assignments').insert(assignRow), OFFLINE_SERVER_TIMEOUT_MS); error = r.error; }
  if (error && OFFLINE_ENABLED && isNetworkFailure(error)){
    offlineMarkServerDown();
    const g0 = onDutyHere.find(o => o.id === guardId);
    await offlineEnqueue('assign', { row: assignRow, instId: inst.id, guardName: g0 ? g0.full_name : 'A guard' });
    patrolAssignmentsCache[inst.id] = { guardId, guardName: g0 ? g0.full_name : 'A guard' };
    patrolAssignmentPromptInstId = null;
    document.getElementById('patrolAssignmentModalBg').classList.remove('show');
    renderGuardPatrolCard();
    renderPanicActingAsSelector();
    return;
  }
  // A unique-constraint conflict just means someone else answered this exact
  // round a moment before us - that's fine, go read back their answer.
  if (error && !/duplicate key|unique constraint/i.test(error.message)){
    errEl.textContent = 'Could not save — ' + error.message;
    errEl.style.display = 'block';
    return;
  }
  const { data: row } = await sb
    .from('patrol_assignments')
    .select('guard_id')
    .eq('route_id', inst.routeId)
    .eq('expected_time', new Date(inst.expectedTime).toISOString())
    .maybeSingle();
  const finalGuardId = row ? row.guard_id : guardId;
  const g = onDutyHere.find(o => o.id === finalGuardId);
  patrolAssignmentsCache[inst.id] = { guardId: finalGuardId, guardName: g ? g.full_name : 'A guard' };
  patrolAssignmentPromptInstId = null;
  document.getElementById('patrolAssignmentModalBg').classList.remove('show');
  renderGuardPatrolCard();
  renderPanicActingAsSelector();
}

// ---------------- Incident reporting (guard) ----------------
let incidentSelectedType = null;
let incidentSelectedSeverity = null;
let incidentStagedPhotos = [];   // File[]
let incidentGpsPos = null;       // {lat,lng} or null
let incidentReportingAsGuardId = null;

function incidentDeviceLabel(){
  const ua = navigator.userAgent || '';
  const platform = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'Unknown device';
  const browser = /Chrome/.test(ua) ? 'Chrome' : /Firefox/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : '';
  return [platform, browser].filter(Boolean).join(' · ');
}

async function openIncidentModal(){
  incidentSelectedType = null;
  incidentSelectedSeverity = null;
  incidentStagedPhotos = [];
  incidentGpsPos = null;
  document.getElementById('incidentFormError').style.display = 'none';
  document.getElementById('incidentDescription').value = '';
  document.getElementById('incidentActionsTaken').value = '';
  document.getElementById('incidentResolution').value = '';
  document.getElementById('incidentPhotoInput').value = '';
  document.getElementById('incidentPhotoPreviews').innerHTML = '';

  const dutySiteId = activeDutySiteId || guardSiteId;
  const dutyInfo = currentDutyRouteNextInstance();
  const lockedAssignment = dutyInfo ? patrolAssignmentsCache[dutyInfo.inst.id] : null;
  const onDutyHere = onDutyGuardsAtSite(dutySiteId);
  const reportingWrap = document.getElementById('incidentReportingAsWrap');
  const reportingSel = document.getElementById('incidentReportingAsSelect');
  if (lockedAssignment){
    incidentReportingAsGuardId = lockedAssignment.guardId;
    reportingWrap.style.display = 'block';
    reportingSel.innerHTML = `<option value="${lockedAssignment.guardId}">${escapeHtmlForPrint(lockedAssignment.guardName)} (locked in for this patrol)</option>`;
    reportingSel.disabled = true;
  } else if (onDutyHere.length >= 2){
    incidentReportingAsGuardId = session.user.id;
    reportingWrap.style.display = 'block';
    reportingSel.disabled = false;
    reportingSel.innerHTML = onDutyHere.map(o => `<option value="${o.id}" ${o.id === session.user.id ? 'selected' : ''}>${o.id === session.user.id ? escapeHtmlForPrint(o.full_name) + ' (you, logged in)' : escapeHtmlForPrint(o.full_name)}</option>`).join('');
  } else {
    incidentReportingAsGuardId = session.user.id;
    reportingWrap.style.display = 'none';
  }

  document.getElementById('incidentTypeGrid').innerHTML = INCIDENT_TYPES.map(t =>
    `<button type="button" class="btn" data-incident-type="${t.value}" style="padding:9px 6px; font-size:12.5px;">${t.label}</button>`
  ).join('');
  document.getElementById('incidentSeverityGrid').innerHTML = INCIDENT_SEVERITIES.map(s =>
    `<button type="button" class="btn" data-incident-severity="${s.value}" style="padding:9px 4px; font-size:12px;">${s.emoji} ${s.label}</button>`
  ).join('');

  renderIncidentAutoInfo();
  document.getElementById('incidentModalBg').classList.add('show');

  const pos = await getGuardPosition();
  if (pos){ incidentGpsPos = { lat: pos.lat, lng: pos.lng }; renderIncidentAutoInfo(); }
}

function renderIncidentAutoInfo(){
  const el = document.getElementById('incidentAutoInfo');
  const dutySiteId = activeDutySiteId || guardSiteId;
  const site = sites.find(s => s.id === dutySiteId);
  const dutyInfo = currentDutyRouteNextInstance();
  const route = dutyInfo ? routes.find(r => r.id === dutyInfo.inst.routeId) : null;
  const lastScan = scans.filter(s => s.siteId === dutySiteId && s.result === 'ACCEPTED').sort((a,b) => b.timestamp - a.timestamp)[0];
  const lastCp = lastScan ? checkpoints.find(c => c.qrId === lastScan.qrId) : null;

  el.innerHTML = [
    `Site: ${site ? site.name : '—'}`,
    `GPS: ${incidentGpsPos ? incidentGpsPos.lat.toFixed(5) + ', ' + incidentGpsPos.lng.toFixed(5) : 'Getting location…'}`,
    `Time: ${new Date().toLocaleString([], { hour12: false })}`,
    `Device: ${incidentDeviceLabel()}`,
    `Patrol: ${route ? route.name : 'No scheduled patrol right now'}`,
    `Checkpoint: ${lastCp ? lastCp.name + ' (last scanned)' : 'None scanned yet this shift'}`
  ].join('<br>');
}

document.getElementById('incidentTypeGrid').addEventListener('click', e => {
  const btn = e.target.closest('[data-incident-type]');
  if (!btn) return;
  incidentSelectedType = btn.dataset.incidentType;
  document.querySelectorAll('#incidentTypeGrid [data-incident-type]').forEach(b => b.classList.toggle('btn-primary', b === btn));
});
document.getElementById('incidentSeverityGrid').addEventListener('click', e => {
  const btn = e.target.closest('[data-incident-severity]');
  if (!btn) return;
  incidentSelectedSeverity = btn.dataset.incidentSeverity;
  document.querySelectorAll('#incidentSeverityGrid [data-incident-severity]').forEach(b => b.classList.toggle('btn-primary', b === btn));
});
document.getElementById('incidentReportingAsSelect').addEventListener('change', e => { incidentReportingAsGuardId = e.target.value; });

document.getElementById('incidentPhotoInput').addEventListener('change', e => {
  incidentStagedPhotos = incidentStagedPhotos.concat(Array.from(e.target.files || []));
  renderIncidentPhotoPreviews();
});
function renderIncidentPhotoPreviews(){
  const wrap = document.getElementById('incidentPhotoPreviews');
  wrap.innerHTML = incidentStagedPhotos.map((f, i) => `
    <div style="position:relative; width:64px; height:64px;">
      <img src="${URL.createObjectURL(f)}" style="width:100%; height:100%; object-fit:cover; border-radius:6px; border:1px solid var(--border);">
      <button type="button" data-remove-photo="${i}" style="position:absolute; top:-6px; right:-6px; background:var(--danger); color:#fff; border:none; border-radius:50%; width:20px; height:20px; font-size:12px; line-height:1;">×</button>
    </div>
  `).join('');
  wrap.querySelectorAll('[data-remove-photo]').forEach(btn => {
    btn.addEventListener('click', () => {
      incidentStagedPhotos.splice(Number(btn.dataset.removePhoto), 1);
      renderIncidentPhotoPreviews();
    });
  });
}

document.getElementById('incidentCancelBtn').addEventListener('click', () => {
  document.getElementById('incidentModalBg').classList.remove('show');
});

document.getElementById('reportIncidentBtn').addEventListener('click', openIncidentModal);

document.getElementById('incidentSubmitBtn').addEventListener('click', async () => {
  const errEl = document.getElementById('incidentFormError');
  errEl.style.display = 'none';
  if (!incidentSelectedType){ errEl.textContent = 'Select an incident type.'; errEl.style.display = 'block'; return; }
  if (!incidentSelectedSeverity){ errEl.textContent = 'Select a severity.'; errEl.style.display = 'block'; return; }
  const description = document.getElementById('incidentDescription').value.trim();
  if (!description){ errEl.textContent = 'Add a description of what happened.'; errEl.style.display = 'block'; return; }

  const btn = document.getElementById('incidentSubmitBtn');
  btn.disabled = true;
  btn.textContent = 'Submitting…';
  try{
    const dutySiteId = activeDutySiteId || guardSiteId;
    const dutyInfo = currentDutyRouteNextInstance();
    const lastScan = scans.filter(s => s.siteId === dutySiteId && s.result === 'ACCEPTED').sort((a,b) => b.timestamp - a.timestamp)[0];
    const lastCp = lastScan ? checkpoints.find(c => c.qrId === lastScan.qrId) : null;
    const actingAttendance = incidentReportingAsGuardId === session.user.id
      ? myAttendance
      : attendance.find(a => a.guardId === incidentReportingAsGuardId && a.status === 'on_duty' && a.siteId === dutySiteId) || myAttendance;

    const incidentId = crypto.randomUUID();
    const photoPaths = [];
    for (let i = 0; i < incidentStagedPhotos.length; i++){
      const file = incidentStagedPhotos[i];
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase();
      const path = `${profile.org_id}/${incidentId}/${Date.now()}-${i}.${ext}`;
      const { error: upErr } = await sb.storage.from('incident-photos').upload(path, file);
      if (upErr){ throw new Error('Photo upload failed: ' + upErr.message); }
      photoPaths.push(path);
    }

    const { error } = await sb.from('incidents').insert({
      id: incidentId,
      site_id: dutySiteId,
      guard_id: incidentReportingAsGuardId,
      incident_type: incidentSelectedType,
      severity: incidentSelectedSeverity,
      description,
      actions_taken: document.getElementById('incidentActionsTaken').value.trim(),
      resolution: document.getElementById('incidentResolution').value.trim(),
      photo_paths: photoPaths,
      lat: incidentGpsPos ? incidentGpsPos.lat : null,
      lng: incidentGpsPos ? incidentGpsPos.lng : null,
      device_info: incidentDeviceLabel(),
      route_id: dutyInfo ? dutyInfo.inst.routeId : null,
      checkpoint_id: lastCp ? lastCp.id : null,
      attendance_id: actingAttendance ? actingAttendance.id : null
    });
    if (error) throw error;

    document.getElementById('incidentModalBg').classList.remove('show');
    showToast('Incident report submitted', 'Admins and controllers can see it now.', 'success');
  } catch(err){
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Submit report';
  }
});

const PANIC_HOLD_MS = 900;
let panicHoldTimer = null, panicHoldStart = 0, panicHoldRaf = null;
let lastPanicAt = 0;
const PANIC_COOLDOWN_MS = 20000; // avoid literal double-fires from two quick holds; doesn't block a genuinely repeated press after this

function panicHoldTick(){
  const fillEl = document.getElementById('panicBtnFill');
  const elapsed = Date.now() - panicHoldStart;
  const pct = Math.min(100, (elapsed / PANIC_HOLD_MS) * 100);
  if (fillEl) fillEl.style.width = pct + '%';
  if (pct < 100) panicHoldRaf = requestAnimationFrame(panicHoldTick);
}

function startPanicHold(){
  if (panicHoldTimer) return;
  if (Date.now() - lastPanicAt < PANIC_COOLDOWN_MS){
    // Nothing on screen: just repeat the vibration for the last alert's outcome (no duplicate alert is sent).
    panicHaptic(lastPanicDelivered);
    return;
  }
  panicHoldStart = Date.now();
  panicHoldRaf = requestAnimationFrame(panicHoldTick);
  panicHoldTimer = setTimeout(() => {
    cancelPanicHold(true);
    triggerPanic();
  }, PANIC_HOLD_MS);
}

function cancelPanicHold(completed){
  if (panicHoldTimer){ clearTimeout(panicHoldTimer); panicHoldTimer = null; }
  if (panicHoldRaf){ cancelAnimationFrame(panicHoldRaf); panicHoldRaf = null; }
  const fillEl = document.getElementById('panicBtnFill');
  const labelEl = document.getElementById('panicBtnLabel');
  if (fillEl) fillEl.style.width = '0%';
  if (labelEl) labelEl.textContent = 'Hold for panic alert';   // the button always looks the same afterwards
}

// The panic button is deliberately covert: after it is pressed the button, its text and the screen look exactly
// as before - no sound, no message, no pop-up - so a guard who was told not to press it is not put at risk.
// The only feedback is vibration: one long buzz = the alert was delivered; fast short pulses = it was NOT
// delivered yet (an undelivered alert is kept on the phone and retried until it gets through, then buzzes long).
let lastPanicDelivered = false;
function panicHaptic(delivered){
  if (!navigator.vibrate) return;
  navigator.vibrate(delivered ? 1200 : [70,50,70,50,70,50,70,50,70,50,70,50,70,50,70]);
}

async function triggerPanic(){
  lastPanicAt = Date.now();
  lastPanicDelivered = false;

  let lat = null, lng = null;
  try{
    const pos = await new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('no geolocation'));
      navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 5000, maximumAge: 3000 });
    });
    lat = pos.coords.latitude;
    lng = pos.coords.longitude;
  } catch(e){ /* send without location rather than block the alert on it */ }

  try{
    const panicArgs = { p_lat: lat, p_lng: lng, p_acting_as_guard_id: panicActingAsGuardId || session.user.id };
    let error = null;
    if (OFFLINE_ENABLED && navigator.onLine === false) error = { name: 'AbortError', message: 'offline' };
    else { const r = await withTimeout(sb.rpc('trigger_panic', panicArgs), 8000); error = r.error; if (!error) offlineMarkServerUp(); }
    if (error && OFFLINE_ENABLED && isNetworkFailure(error)){
      // No signal: kept on the phone and retried every few seconds until it gets through.
      offlineMarkServerDown();
      await offlineEnqueue('panic', { args: panicArgs, at: new Date().toISOString() });
      panicHaptic(false);
      return;
    }
    if (error){ console.warn('panic not delivered', error.message); panicHaptic(false); return; }
    lastPanicDelivered = true;
    panicHaptic(true);
    guardTrackingCheck();   // the control room's live tracking (started by the alert) begins straight away, silently
  } catch(err){
    console.warn('panic not delivered', err);
    panicHaptic(false);
  }
}

const panicBtnEl = document.getElementById('panicBtn');
panicBtnEl.addEventListener('pointerdown', startPanicHold);
panicBtnEl.addEventListener('pointerup', () => cancelPanicHold(false));
panicBtnEl.addEventListener('pointerleave', () => cancelPanicHold(false));
panicBtnEl.addEventListener('pointercancel', () => cancelPanicHold(false));
panicBtnEl.addEventListener('contextmenu', e => e.preventDefault()); // long-press shouldn't open a context menu on mobile

document.getElementById('manualScanBtn').addEventListener('click', async () => {
  const btn = document.getElementById('manualScanBtn');
  setManualScanStatus('', false);

  if (!scanning){
    setManualScanStatus('Start the camera first, then point it at the tag.', true);
    return;
  }
  if (!(video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth > 0 && video.videoHeight > 0)){
    setManualScanStatus('Camera is still starting up — try again in a moment.', true);
    return;
  }
  // Don't even attempt to read a tag if there's no patrol in progress — surface the
  // same rejection feedback (message, red text, sound) without touching the camera decode.
  const gate = guardPatrolGate();
  if (!gate.inProgress){
    setManualScanStatus(gate.needsAssignment
      ? "Select who's on patrol above before scanning."
      : 'No patrol in progress — scanning is disabled until your patrol starts.', true);
    SOUND.tagRejected();
    return;
  }

  btn.disabled = true;
  decodeLocked = true; // hold off the background auto-scan loop while we handle this tap
  let qrId = null;
  try {
    const result = await QrScanner.scanImage(video, { returnDetailedScanResult: true });
    qrId = result && result.data ? result.data.trim() : null;
  } catch (err){
    qrId = null; // "No QR code found" rejects the promise — that's the expected empty case
  }
  if (!qrId){
    setManualScanStatus('No tag detected — point the camera at a QR tag and try again.', true);
    btn.disabled = false;
    decodeLocked = false;
    return;
  }

  setManualScanStatus('Getting your location…', false);
  SOUND.tagScan();
  const record = await processScan(qrId);
  lastDecodedAtByQr[qrId] = Date.now();
  decodeLocked = false;
  btn.disabled = false;
  setManualScanStatus('', false);
  SOUND[record.result === 'ACCEPTED' ? 'tagAccepted' : 'tagRejected']();
  showResult(record);
  renderGuardPatrolCard();
});

// ---------------- Real camera + QR decode ----------------
// =================== Attendance / clock-in (facial recognition) ===================
// Face capture uses face-api.js entirely client-side: a 128-float descriptor is
// captured once at enrollment (a guard's first-ever clock-in) and stored on their
// profile; every later clock-in captures a fresh descriptor and compares it against
// the enrolled one. This stops casual buddy-punching (a different face won't match)
// but isn't liveness-proof — a good photo of the enrolled guard could still fool it.
let faceModelsLoaded = false;
let faceStream = null;
let faceDetectTimer = null;
let lastFaceDescriptor = null;
let faceModalResolve = null;
const FACE_MATCH_THRESHOLD = 0.55; // faceapi.euclideanDistance — lower is a closer match. Kept for reference; the actual match now happens server-side in clock-in-self/clock-in-teammate using the same value.

async function ensureFaceModels(){
  if (faceModelsLoaded) return;
  const MODEL_URL = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js/weights';
  await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
  await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
  await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
  faceModelsLoaded = true;
}

// Opens the face modal and resolves with { descriptor: number[] } once the guard
// captures a face, or null if they cancel. Caller decides what to do with it
// (enroll vs. compare against an existing enrollment).
function openFaceModal(title){
  document.getElementById('faceModalTitle').textContent = title;
  document.getElementById('faceModalStatus').textContent = 'Loading face recognition…';
  document.getElementById('faceCaptureBtn').style.display = 'none';
  document.getElementById('faceVideoBox').className = 'face-video-box';
  document.getElementById('faceModalBg').classList.add('show');
  return new Promise((resolve) => {
    faceModalResolve = resolve;
    startFaceCapture();
  });
}

function closeFaceModal(result){
  document.getElementById('faceModalBg').classList.remove('show');
  if (faceStream){ faceStream.getTracks().forEach(t => t.stop()); faceStream = null; }
  if (faceDetectTimer){ clearTimeout(faceDetectTimer); faceDetectTimer = null; }
  lastFaceDescriptor = null;
  if (faceModalResolve){ const r = faceModalResolve; faceModalResolve = null; r(result); }
}
document.getElementById('faceModalCloseBtn').addEventListener('click', () => closeFaceModal(null));

async function startFaceCapture(){
  const statusEl = document.getElementById('faceModalStatus');
  try {
    await ensureFaceModels();
    faceStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
    const video = document.getElementById('faceVideo');
    video.srcObject = faceStream;
    await video.play();
    statusEl.textContent = 'Position your face in frame…';
    document.getElementById('faceCaptureBtn').style.display = 'block';
    detectFaceLoop();
  } catch (err){
    statusEl.textContent = 'Could not access the front camera — ' + err.message;
  }
}

async function detectFaceLoop(){
  if (!faceStream) return; // modal was closed mid-loop
  const video = document.getElementById('faceVideo');
  const box = document.getElementById('faceVideoBox');
  try {
    const det = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions())
      .withFaceLandmarks().withFaceDescriptor();
    if (det){
      lastFaceDescriptor = Array.from(det.descriptor);
      box.classList.add('match');
      document.getElementById('faceModalStatus').textContent = 'Face detected — tap Capture.';
    } else {
      lastFaceDescriptor = null;
      box.classList.remove('match');
      document.getElementById('faceModalStatus').textContent = 'Position your face in frame…';
    }
  } catch (e){ /* transient detection error — just retry on the next tick */ }
  if (faceStream) faceDetectTimer = setTimeout(detectFaceLoop, 350);
}

document.getElementById('faceCaptureBtn').addEventListener('click', () => {
  if (!lastFaceDescriptor) return;
  closeFaceModal({ descriptor: lastFaceDescriptor });
});

