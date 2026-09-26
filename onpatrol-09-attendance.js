// ---------------- Guard-side clock in / clock out ----------------
function siteShiftsFor(siteId){
  return siteShifts.filter(s => s.siteId === siteId && s.active);
}

function populateAttendanceSiteSelect(){
  const sel = document.getElementById('attendanceSiteSelect');
  if (!sel) return;
  const homeSite = sites.find(s => s.id === guardSiteId);
  const others = sites.filter(s => s.id !== guardSiteId);
  sel.innerHTML =
    (homeSite ? `<option value="${homeSite.id}">${homeSite.name} (your site)</option>` : '') +
    others.map(s => `<option value="${s.id}">Relieving at ${s.name}</option>`).join('');
  populateAttendanceShiftSelect();
}

function populateAttendanceShiftSelect(){
  const siteSel = document.getElementById('attendanceSiteSelect');
  const shiftSel = document.getElementById('attendanceShiftSelect');
  if (!siteSel || !shiftSel) return;
  const siteId = siteSel.value;
  const isReliever = siteId !== guardSiteId;
  const shifts = siteShiftsFor(siteId);
  shiftSel.innerHTML = shifts.length
    ? shifts.map(s => `<option value="${s.id}">${s.name} (${s.startTime}–${s.endTime})</option>`).join('')
    : '<option value="">No shifts configured for this site</option>';
  document.getElementById('attendanceCoveringWrap').style.display = isReliever ? 'block' : 'none';
  populateAttendanceCoveringSelect();
}

function populateAttendanceCoveringSelect(){
  const siteSel = document.getElementById('attendanceSiteSelect');
  const shiftSel = document.getElementById('attendanceShiftSelect');
  const coverSel = document.getElementById('attendanceCoveringSelect');
  if (!siteSel || !shiftSel || !coverSel) return;
  const siteId = siteSel.value;
  const shift = siteShifts.find(s => s.id === shiftSel.value);
  if (!shift){ coverSel.innerHTML = '<option value="">Not covering anyone specific</option>'; return; }
  const shiftDate = currentShiftDateFor(shift, nowMs());
  const openAbsences = absences.filter(a => a.siteId === siteId && a.shiftId === shift.id && a.shiftDate === shiftDate && !a.coveredByAttendanceId);
  const dir = guardDirectoryCache[siteId] || [];
  coverSel.innerHTML = '<option value="">Not covering anyone specific</option>' +
    openAbsences.map(a => {
      const g = dir.find(x => x.id === a.guardId);
      return `<option value="${a.id}">${escapeHtmlForPrint(g ? (g.full_name || 'Guard') : 'Guard')}${g && g.employee_number ? ' · #' + escapeHtmlForPrint(g.employee_number) : ''}</option>`;
    }).join('');
}

document.getElementById('attendanceSiteSelect').addEventListener('change', async () => {
  await loadGuardDirectory(document.getElementById('attendanceSiteSelect').value);
  populateAttendanceShiftSelect();
});
document.getElementById('attendanceShiftSelect').addEventListener('change', populateAttendanceCoveringSelect);

function renderAttendanceCard(){
  const cardEl = document.getElementById('attendanceCard');
  if (!cardEl || profile.role !== 'guard') return;
  cardEl.style.display = guardSiteId ? 'block' : 'none';
  if (!guardSiteId) return;

  const pill = document.getElementById('attendanceStatusPill');
  const detail = document.getElementById('attendanceDetail');
  const clockInWrap = document.getElementById('attendanceClockInWrap');
  const clockOutWrap = document.getElementById('attendanceClockOutWrap');

  if (myAttendance){
    const site = sites.find(s => s.id === myAttendance.siteId);
    const shift = siteShifts.find(s => s.id === myAttendance.shiftId);
    pill.className = 'attendance-status-pill ' + (myAttendance.isReliever ? 'reliever' : 'on');
    pill.textContent = myAttendance.isReliever ? 'On duty (reliever)' : 'On duty';
    detail.textContent = `${site ? site.name : '—'} · ${shift ? shift.name : '—'} · since ${new Date(myAttendance.clockInAt).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', hour12: false})}`;
    clockInWrap.style.display = 'none';
    clockOutWrap.style.display = 'block';
    const shiftEnd = shift ? shiftEndMsFor(shift, myAttendance.shiftDate) : 0;
    const canClockOut = nowMs() >= shiftEnd;
    document.getElementById('attendanceClockOutBtn').disabled = !canClockOut;
    document.getElementById('attendanceClockOutNote').textContent = canClockOut
      ? 'Shift has ended — you can clock out.'
      : `Clock-out unlocks at ${new Date(shiftEnd).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', hour12: false})} (end of shift).`;
  } else {
    pill.className = 'attendance-status-pill off';
    pill.textContent = 'Not clocked in';
    detail.textContent = '';
    clockInWrap.style.display = 'block';
    clockOutWrap.style.display = 'none';
    if (!document.getElementById('attendanceSiteSelect').options.length) populateAttendanceSiteSelect();
  }
}

// ---------------- Shared-device teammate clock-in/out ----------------
// Lets whoever is already logged in on a site's shared device clock a teammate
// in or out without that teammate needing their own login. Clock-in for a
// teammate always goes through the clock-in-teammate edge function, which does
// the face match server-side (their enrolled face_descriptor never reaches this
// client). Clock-out doesn't need a face check, so it's a normal table update.
async function renderTeammatesCard(){
  const sectionEl = document.getElementById('teammatesSection');
  if (!sectionEl || profile.role !== 'guard') return;
  // Use wherever the guard is actually on duty right now, not their home
  // site — a reliever working away from home should see (and be able to
  // clock in/out) the colleagues physically at that site, not the ones back
  // at their own home site.
  const dutySiteId = activeDutySiteId || guardSiteId;
  sectionEl.style.display = dutySiteId ? 'block' : 'none';
  if (!dutySiteId) return;

  const dir = await loadGuardDirectory(dutySiteId);
  const listEl = document.getElementById('teammatesList');
  const homeSiteShifts = siteShifts.filter(s => s.siteId === dutySiteId);
  const teammates = dir.filter(g => g.id !== session.user.id);

  if (!teammates.length){
    listEl.innerHTML = '<div class="result-meta">No other guards assigned to this site yet.</div>';
    return;
  }

  listEl.innerHTML = teammates.map(g => {
    const att = attendance.find(a => a.guardId === g.id && a.status === 'on_duty');
    if (att && att.siteId === dutySiteId){
      const shift = siteShifts.find(s => s.id === att.shiftId);
      return `
        <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 0; border-bottom:1px solid var(--border);">
          <div>
            <div style="font-family:var(--sans); font-weight:600; font-size:12.5px;">${escapeHtmlForPrint(g.full_name)}</div>
            <div class="result-meta">On duty · ${escapeHtmlForPrint(shift ? shift.name : '—')} · since ${new Date(att.clockInAt).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', hour12: false})}</div>
          </div>
          <button class="btn" style="width:auto; padding:5px 10px; font-size:11px;" data-teammate-clockout="${att.id}" data-teammate-shift="${att.shiftId}" data-teammate-shiftdate="${att.shiftDate}">Clock out</button>
        </div>`;
    }
    if (att){
      const site = sites.find(s => s.id === att.siteId);
      return `
        <div style="padding:6px 0; border-bottom:1px solid var(--border);">
          <div style="font-family:var(--sans); font-weight:600; font-size:12.5px;">${escapeHtmlForPrint(g.full_name)}</div>
          <div class="result-meta">On duty at ${escapeHtmlForPrint(site ? site.name : 'another site')}</div>
        </div>`;
    }
    if (!homeSiteShifts.length){
      return `
        <div style="padding:6px 0; border-bottom:1px solid var(--border);">
          <div style="font-family:var(--sans); font-weight:600; font-size:12.5px;">${escapeHtmlForPrint(g.full_name)}</div>
          <div class="result-meta">Not clocked in · no shifts configured for this site</div>
        </div>`;
    }
    const shiftOptions = homeSiteShifts.map(s => `<option value="${s.id}">${escapeHtmlForPrint(s.name)}</option>`).join('');
    return `
      <div style="padding:6px 0; border-bottom:1px solid var(--border);">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
          <div style="font-family:var(--sans); font-weight:600; font-size:12.5px;">${escapeHtmlForPrint(g.full_name)}</div>
          <button class="btn btn-primary" style="width:auto; padding:5px 10px; font-size:11px;" data-teammate-clockin="${g.id}">Clock in</button>
        </div>
        <select data-teammate-shift-select="${g.id}" style="margin-top:6px; font-size:12px; width:100%;">${shiftOptions}</select>
      </div>`;
  }).join('');

  listEl.querySelectorAll('[data-teammate-clockin]').forEach(btn => {
    btn.addEventListener('click', () => clockInTeammate(btn.dataset.teammateClockin));
  });
  listEl.querySelectorAll('[data-teammate-clockout]').forEach(btn => {
    btn.addEventListener('click', () => clockOutTeammate(btn.dataset.teammateClockout, btn.dataset.teammateShift, btn.dataset.teammateShiftdate));
  });
}

async function clockInTeammate(guardId){
  const errEl = document.getElementById('teammatesError');
  errEl.style.display = 'none';
  const dutySiteId = activeDutySiteId || guardSiteId;
  const shiftSel = document.querySelector(`[data-teammate-shift-select="${guardId}"]`);
  const shiftId = shiftSel ? shiftSel.value : null;
  if (!shiftId){ errEl.textContent = 'No shift available to clock into at this site.'; errEl.style.display = 'block'; return; }
  const shift = siteShifts.find(s => s.id === shiftId);
  if (!canClockInToShift(shift, nowMs())){
    errEl.textContent = `${shift ? shift.name : 'This shift'} runs ${shift.startTime}–${shift.endTime} — it's not time for that shift yet.`;
    errEl.style.display = 'block';
    return;
  }
  const shiftDate = currentShiftDateFor(shift, nowMs());
  const dir = guardDirectoryCache[dutySiteId] || [];
  const guard = dir.find(g => g.id === guardId);

  const faceResult = await openFaceModal(`Face scan for ${guard ? guard.full_name : 'teammate'}`);
  if (!faceResult){ errEl.textContent = 'Face scan cancelled.'; errEl.style.display = 'block'; return; }

  const teammateReliever = !!(guard && guard.site_id !== dutySiteId);
  let data = null, error = null, wentOffline = false;
  if (OFFLINE_ENABLED && navigator.onLine === false){
    error = { name: 'FunctionsFetchError', message: 'offline' };
  } else {
    const r = await withTimeout(sb.functions.invoke('clock-in-teammate', {
      body: {
        target_guard_id: guardId, site_id: dutySiteId, shift_id: shiftId, shift_date: shiftDate,
        is_reliever: teammateReliever, descriptor: faceResult.descriptor
      }
    }), OFFLINE_SERVER_TIMEOUT_MS + 6000);
    data = r.data; error = r.error;
    if (!error && !(data && data.error)) offlineMarkServerUp();
  }
  if (error && OFFLINE_ENABLED && isNetworkFailure(error)){
    offlineMarkServerDown();
    const off = await offlineClockIn({ guardId, siteId: dutySiteId, shiftId, shiftDate, isReliever: teammateReliever, coveringAbsenceId: null, descriptor: faceResult.descriptor, byId: session.user.id });
    if (off.error){ errEl.textContent = off.error; errEl.style.display = 'block'; return; }
    wentOffline = true;
    data = {};
  } else if (error || (data && data.error)){
    errEl.textContent = await functionErrorMessage(data, error, 'Could not clock in.');
    errEl.style.display = 'block';
    return;
  }
  const result = data;

  if (!wentOffline) await loadAttendanceRecent();
  renderTeammatesCard();
  renderPanicActingAsSelector();
  renderAttendanceCard();
  if (wentOffline) showToast('Clocked in — saved on this phone', `${guard ? guard.full_name : 'Guard'}'s face was checked on this phone. It will send when signal returns.`, 'warn');
  else showToast('Clocked in', result.newly_enrolled ? `${guard ? guard.full_name : 'Guard'} enrolled their face and is now on duty.` : `${guard ? guard.full_name : 'Guard'} is now on duty.`, 'success');
}

async function clockOutTeammate(attendanceId, shiftId, shiftDate){
  const errEl = document.getElementById('teammatesError');
  errEl.style.display = 'none';
  const shift = siteShifts.find(s => s.id === shiftId);
  const shiftEnd = shift ? shiftEndMsFor(shift, shiftDate) : 0;
  if (nowMs() < shiftEnd){
    errEl.textContent = `Clock-out unlocks at ${new Date(shiftEnd).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', hour12: false})} (end of shift).`;
    errEl.style.display = 'block';
    return;
  }
  const outRes = await offlineClockOut(attendanceId, { clocked_out_by: session.user.id });
  if (!outRes.ok){ errEl.textContent = 'Could not clock out — ' + outRes.message; errEl.style.display = 'block'; return; }
  if (!outRes.queued) await loadAttendanceRecent();
  renderTeammatesCard();
  renderPanicActingAsSelector();
  renderAttendanceCard();
  showToast('Clocked out', '', 'success');
}

document.getElementById('attendanceClockInBtn').addEventListener('click', async () => {
  const errEl = document.getElementById('attendanceClockInError');
  errEl.style.display = 'none';
  const siteId = document.getElementById('attendanceSiteSelect').value;
  const shiftId = document.getElementById('attendanceShiftSelect').value;
  const coveringAbsenceId = document.getElementById('attendanceCoveringSelect').value || null;
  if (!siteId || !shiftId){ errEl.textContent = 'Pick a site and shift first.'; errEl.style.display = 'block'; return; }

  // A guard (home or reliever) can only be on duty in one place at a time.
  if (!offlineKnownDown()) await loadAttendanceRecent();
  const existingElsewhere = attendance.find(a => a.guardId === session.user.id && a.status === 'on_duty');
  if (existingElsewhere){
    const elsewhereSite = sites.find(s => s.id === existingElsewhere.siteId);
    errEl.textContent = `You're already clocked in at ${elsewhereSite ? elsewhereSite.name : 'another site'} — clock out there first.`;
    errEl.style.display = 'block';
    return;
  }

  const shift = siteShifts.find(s => s.id === shiftId);
  // Fast client-side check for instant feedback — the edge function below is
  // the actual enforcement (and re-checks this itself), so this can't be
  // bypassed by skipping straight to the API the way a client-only check could.
  if (!canClockInToShift(shift, nowMs())){
    errEl.textContent = `${shift ? shift.name : 'This shift'} runs ${shift.startTime}–${shift.endTime} — it's not time for that shift yet. Pick the right one, or check back closer to its start.`;
    errEl.style.display = 'block';
    return;
  }
  const shiftDate = currentShiftDateFor(shift, nowMs());
  const isReliever = siteId !== guardSiteId;

  const hasEnrolled = Array.isArray(profile.face_descriptor) && profile.face_descriptor.length > 0;
  const faceResult = await openFaceModal(hasEnrolled ? 'Verify your face to clock in' : 'Enroll your face — this becomes your reference for every future clock-in');
  if (!faceResult){ errEl.textContent = 'Face scan cancelled.'; errEl.style.display = 'block'; return; }

  const covering = coveringAbsenceId ? absences.find(a => a.id === coveringAbsenceId) : null;
  // Always ask the server first. Only if it cannot be reached is the face checked on the phone.
  let data = null, error = null, wentOffline = false;
  if (OFFLINE_ENABLED && navigator.onLine === false){
    error = { name: 'FunctionsFetchError', message: 'offline' };
  } else {
    const r = await withTimeout(sb.functions.invoke('clock-in-self', {
      body: {
        site_id: siteId, shift_id: shiftId, shift_date: shiftDate,
        covering_absence_id: covering ? covering.id : null,
        descriptor: faceResult.descriptor
      }
    }), OFFLINE_SERVER_TIMEOUT_MS + 6000);
    data = r.data; error = r.error;
    if (!error && !(data && data.error)) offlineMarkServerUp();
  }
  if (error && OFFLINE_ENABLED && isNetworkFailure(error)){
    offlineMarkServerDown();
    const off = await offlineClockIn({ guardId: session.user.id, siteId, shiftId, shiftDate, isReliever, coveringAbsenceId: covering ? covering.id : null, descriptor: faceResult.descriptor, byId: null });
    if (off.error){ errEl.textContent = off.error; errEl.style.display = 'block'; return; }
    wentOffline = true;
    data = {};
  } else if (error || data?.error){
    errEl.textContent = await functionErrorMessage(data, error, 'Could not clock in.');
    errEl.style.display = 'block';
    return;
  }
  if (data.newly_enrolled) profile.face_descriptor = faceResult.descriptor;

  if (!wentOffline){ await loadAttendanceRecent(); await loadAbsencesRecent(); }
  activeDutySiteId = siteId;
  if (profile.role === 'guard' && !wentOffline){ await loadScans(); subscribeRealtime(); }
  renderGuardSiteName();
  renderAttendanceCard();
  renderTeammatesCard();
  renderPanicActingAsSelector();
  renderGuardPatrolCard();
  if (wentOffline) showToast('Clocked in — saved on this phone', 'Your face was checked on this phone. It will send when signal returns.', 'warn');
  else showToast('Clocked in', isReliever ? `Relieving at ${sites.find(s=>s.id===siteId)?.name || 'site'}` : '', 'success');
});

document.getElementById('attendanceClockOutBtn').addEventListener('click', async () => {
  if (!myAttendance) return;
  if (!confirm('Clock out now?')) return;
  const outRes = await offlineClockOut(myAttendance.id, null);
  if (!outRes.ok){ showToast('Could not clock out', outRes.message, 'danger'); return; }
  if (!outRes.queued) await loadAttendanceRecent();
  activeDutySiteId = guardSiteId;
  if (profile.role === 'guard' && !outRes.queued){ await loadScans(); subscribeRealtime(); }
  renderGuardSiteName();
  renderAttendanceCard();
  renderTeammatesCard();
  renderPanicActingAsSelector();
  renderGuardPatrolCard();
  showToast('Clocked out', '', 'success');
});

// ---------------- Admin: shift staffing config ----------------
function renderSiteShiftsTable(){
  const body = document.getElementById('siteShiftsTableBody');
  const label = document.getElementById('attShiftSiteLabel');
  if (!body) return;
  const site = sites.find(s => s.id === activeSiteId);
  if (label) label.textContent = site ? site.name : 'this site';
  const rows = siteShifts.filter(s => s.siteId === activeSiteId);
  body.innerHTML = rows.length ? rows.map(s => `
    <tr${s.active === false ? ' style="opacity:0.55;"' : ''}>
      <td style="font-family:var(--sans); font-weight:600;">${s.name}${s.active === false ? ' <span class="result-meta">(off)</span>' : ''}</td>
      <td>${s.startTime}–${s.endTime}</td>
      <td>${s.required}</td>
      <td>
        <label class="switch" title="${s.active === false ? 'Shift is off — no coverage expected' : 'Shift is on'}">
          <input type="checkbox" class="shift-active-toggle" data-shift-active="${s.id}" ${s.active !== false ? 'checked' : ''}>
          <span class="slider-tog"></span>
        </label>
      </td>
      <td><button class="del-btn" data-del-shift="${s.id}" aria-label="Delete shift"><i>&times;</i></button></td>
    </tr>
  `).join('') : '<tr><td colspan="5" style="font-family:var(--sans); color:var(--muted);">No shifts configured for this site yet.</td></tr>';
  body.querySelectorAll('.shift-active-toggle').forEach(tog => tog.addEventListener('change', async e => {
    const s = siteShifts.find(sh => sh.id === e.target.dataset.shiftActive);
    if (!s) return;
    const prev = s.active;
    s.active = e.target.checked;
    const { error } = await sb.from('site_shifts').update({ active: e.target.checked }).eq('id', s.id);
    if (error){
      s.active = prev; e.target.checked = prev;
      showToast('Could not update shift', error.message, 'danger');
      return;
    }
    showToast('Shift updated', e.target.checked ? `${s.name} is on again.` : `${s.name} is off — no coverage expected while it's off.`, 'success');
    renderSiteShiftsTable();
    renderCoverageGrid('coverageGridAdmin');
    renderCoverageGrid('coverageGridCtrl');
  }));
  body.querySelectorAll('[data-del-shift]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this shift definition? Past attendance records are kept.')) return;
      const { error } = await sb.from('site_shifts').delete().eq('id', btn.dataset.delShift);
      if (error){ showToast('Could not delete shift', error.message, 'danger'); return; }
      await loadSiteShifts();
      renderSiteShiftsTable();
      renderCoverageGrid('coverageGridAdmin');
      renderCoverageGrid('coverageGridCtrl');
    });
  });
}

document.getElementById('addShiftBtn').addEventListener('click', async () => {
  if (!activeSiteId){ showToast('Pick a site first', '', 'warn'); return; }
  const name = document.getElementById('newShiftName').value.trim() || 'Shift';
  const start = document.getElementById('newShiftStart').value || '18:00';
  const end = document.getElementById('newShiftEnd').value || '06:00';
  const required = parseInt(document.getElementById('newShiftRequired').value) || 1;
  const { error } = await sb.from('site_shifts').insert({ site_id: activeSiteId, name, start_time: start, end_time: end, required_guards: required, active: true });
  if (error){ showToast('Could not add shift', error.message, 'danger'); return; }
  document.getElementById('newShiftName').value = '';
  await loadSiteShifts();
  await Promise.all([...new Set(siteShifts.map(s => s.siteId))].map(id => loadGuardDirectory(id)));
  renderSiteShiftsTable();
  renderCoverageGrid('coverageGridAdmin');
  renderCoverageGrid('coverageGridCtrl');
  showToast('Shift added', '', 'success');
});

// ---------------- Coverage tiles (who's on duty per site/shift) ----------------
function shiftInstancesForRender(){
  const now = nowMs();
  return siteShifts.filter(s => s.active).map(shift => {
    const shiftDate = currentShiftDateFor(shift, now);
    const onDuty = attendance.filter(a => a.shiftId === shift.id && a.shiftDate === shiftDate && a.status === 'on_duty');
    const openAbsences = absences.filter(a => a.shiftId === shift.id && a.shiftDate === shiftDate && !a.coveredByAttendanceId);
    return { shift, shiftDate, onDuty, openAbsences };
  }).filter(r =>
    // Only show a shift's tile while its own hours are actually running —
    // Day Shift (06:00-18:00) and Night Shift (18:00-06:00) coexist without
    // stepping on each other. Exception: if someone is still clocked in past
    // their shift's end (running over), keep showing it so they don't get
    // lost until they're clocked out.
    isShiftActiveAt(r.shift, now) || r.onDuty.length > 0
  ).sort((a,b) => {
    const sa = sites.find(s => s.id === a.shift.siteId), sb2 = sites.find(s => s.id === b.shift.siteId);
    return (sa ? sa.name : '').localeCompare(sb2 ? sb2.name : '');
  });
}

function renderCoverageGrid(containerId){
  const el = document.getElementById(containerId);
  if (!el) return;
  const rows = shiftInstancesForRender();
  if (!rows.length){
    const anyShifts = siteShifts.some(s => s.active);
    el.innerHTML = `<div class="result-meta">${anyShifts ? 'No shift is currently running — check back when a shift starts.' : 'No shifts configured yet — set up shift staffing first.'}</div>`;
    return;
  }
  el.innerHTML = rows.map(r => {
    const site = sites.find(s => s.id === r.shift.siteId);
    const covered = r.onDuty.length >= r.shift.required;
    const guardRows = r.onDuty.map(a => {
      const badge = a.isReliever ? '<span class="badge">reliever</span>' : '';
      // Admins can end a shift here directly - e.g. someone forgot to clock out, or their phone died,
      // and it's blocking them from clocking in again anywhere else.
      const clockOutBtn = profile && profile.role === 'admin'
        ? `<button class="btn" data-force-clock-out="${a.id}" data-guard-label="${guardLabel(r.shift.siteId, a.guardId)}" style="width:auto; padding:2px 8px; font-size:10.5px; margin-left:auto;">Clock out</button>`
        : '';
      return `<div class="coverage-guard-row present"><span class="dot"></span>${guardLabel(r.shift.siteId, a.guardId)}${badge}${clockOutBtn}</div>`;
    }).join('');
    const absentRows = r.openAbsences.map(a =>
      `<div class="coverage-guard-row absent"><span class="dot"></span>${guardLabel(r.shift.siteId, a.guardId)} — absent</div>`
    ).join('');
    return `
      <div class="coverage-tile ${covered ? 'covered' : 'short'}">
        <div class="coverage-tile-head">
          <span class="coverage-tile-site">${site ? site.name : '—'}</span>
          <span style="display:inline-flex; align-items:center; gap:4px; font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:0.3px; color:${covered ? 'var(--success)' : 'var(--danger)'};">
            ${covered ? '<svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>Staffed' : '<svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>Short'}
          </span>
        </div>
        <div class="coverage-tile-shift">${r.shift.name} · ${r.shift.startTime}–${r.shift.endTime}</div>
        <div class="coverage-tile-count">${r.onDuty.length} / ${r.shift.required} on duty</div>
        ${guardRows || '<div class="result-meta">No one clocked in yet.</div>'}
        ${absentRows}
        <div class="btn-row" style="margin-top:8px;">
          <button class="btn" data-mark-absent="${r.shift.siteId}|${r.shift.id}|${r.shiftDate}" style="width:auto; padding:5px 10px; font-size:11px;">+ Mark absent</button>
        </div>
      </div>`;
  }).join('');
  el.querySelectorAll('[data-mark-absent]').forEach(btn => {
    btn.addEventListener('click', () => {
      const [siteId, shiftId, shiftDate] = btn.dataset.markAbsent.split('|');
      openMarkAbsentModal(siteId, shiftId, shiftDate);
    });
  });
  el.querySelectorAll('[data-force-clock-out]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const label = btn.dataset.guardLabel || 'this guard';
      if (!confirm(`Clock ${label} out? Use this when someone forgot to clock out, or their phone is unreachable, and it's stopping them clocking in elsewhere.`)) return;
      btn.disabled = true;
      const { error } = await sb.from('attendance').update({
        status: 'clocked_out', clock_out_at: new Date().toISOString(), clocked_out_by: session.user.id
      }).eq('id', btn.dataset.forceClockOut).eq('status', 'on_duty');
      if (error){ showToast('Could not clock out', error.message, 'danger'); btn.disabled = false; return; }
      showToast('Clocked out', `${label} is now off duty.`, 'success');
      await loadAttendanceRecent();
      renderCoverageGrid('coverageGridAdmin');
    });
  });
}

document.getElementById('refreshCoverageBtnAdmin').addEventListener('click', async () => {
  await loadAttendanceRecent(); await loadAbsencesRecent();
  renderCoverageGrid('coverageGridAdmin');
});
document.getElementById('refreshCoverageBtnCtrl').addEventListener('click', async () => {
  await loadAttendanceRecent(); await loadAbsencesRecent();
  renderCoverageGrid('coverageGridCtrl');
});

// ---------------- Mark absent ----------------
let markAbsentContext = null;
async function openMarkAbsentModal(siteId, shiftId, shiftDate){
  markAbsentContext = { siteId, shiftId, shiftDate };
  const dir = await loadGuardDirectory(siteId);
  const onDutyIds = new Set(attendance.filter(a => a.shiftId === shiftId && a.shiftDate === shiftDate && a.status === 'on_duty').map(a => a.guardId));
  const absentIds = new Set(absences.filter(a => a.shiftId === shiftId && a.shiftDate === shiftDate).map(a => a.guardId));
  const site = sites.find(s => s.id === siteId);
  document.getElementById('markAbsentTitle').textContent = `Mark absent — ${site ? site.name : 'site'}`;
  const options = dir.filter(g => !onDutyIds.has(g.id) && !absentIds.has(g.id));
  const sel = document.getElementById('markAbsentGuardSelect');
  sel.innerHTML = options.length
    ? options.map(g => `<option value="${g.id}">${escapeHtmlForPrint(g.full_name || 'Guard')}${g.employee_number ? ' · #' + escapeHtmlForPrint(g.employee_number) : ''}</option>`).join('')
    : '<option value="">No eligible guards at this site</option>';
  document.getElementById('markAbsentModalBg').classList.add('show');
}
document.getElementById('markAbsentCancelBtn').addEventListener('click', () => {
  document.getElementById('markAbsentModalBg').classList.remove('show');
});
document.getElementById('markAbsentConfirmBtn').addEventListener('click', async () => {
  const guardId = document.getElementById('markAbsentGuardSelect').value;
  if (!guardId || !markAbsentContext) return;
  const { error } = await sb.from('absences').insert({
    site_id: markAbsentContext.siteId, shift_id: markAbsentContext.shiftId, shift_date: markAbsentContext.shiftDate,
    guard_id: guardId, marked_by: session.user.id
  });
  if (error){ showToast('Could not mark absent', error.message, 'danger'); return; }
  document.getElementById('markAbsentModalBg').classList.remove('show');
  await loadAbsencesRecent();
  renderCoverageGrid('coverageGridAdmin');
  renderCoverageGrid('coverageGridCtrl');
  showToast('Marked absent', '', 'success');
});

// ---------------- CSV export (attendance -> EasyRoster-style import) ----------------
async function exportAttendanceCsv(fromStr, toStr, statusElId, btn){
  const statusEl = document.getElementById(statusElId);
  if (!fromStr || !toStr){ statusEl.textContent = 'Pick a from and to date.'; return; }
  if (btn) btn.disabled = true;
  statusEl.textContent = 'Generating…';
  try {
    const fromDate = new Date(fromStr + 'T00:00:00');
    const toDate = new Date(toStr + 'T23:59:59');
    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())){
      statusEl.textContent = 'Invalid date range.';
      return;
    }
    const fromIso = fromDate.toISOString();
    const toIso = toDate.toISOString();
    const { data, error } = await sb.from('attendance').select('*').gte('clock_in_at', fromIso).lte('clock_in_at', toIso).order('clock_in_at');
    if (error){ statusEl.textContent = 'Could not export — ' + error.message; return; }
    const rows = data || [];
    if (!rows.length){
      statusEl.textContent = 'No attendance records in that range.';
      return;
    }
    // Filter out null/undefined site_ids before warming the guard-directory
    // cache — a stray RPC call with no site id can reject and silently abort
    // the whole export.
    const siteIds = [...new Set(rows.map(r => r.site_id).filter(Boolean))];
    await Promise.all(siteIds.map(id => loadGuardDirectory(id)));

    // Guard names are self-provided at signup - a leading =, +, -, or @ gets
    // interpreted as a live formula by Excel/Sheets when the CSV is opened,
    // regardless of the CSV-level quoting below (that only protects the CSV
    // structure itself, not what a spreadsheet app does with a cell's
    // content). A leading apostrophe is the standard mitigation - it forces
    // the cell to be read as plain text.
    const csvSafe = v => /^[=+\-@]/.test(String(v)) ? "'" + v : v;
    const csvRows = [['Employee Number','Full Name','Site','Shift','Shift Date','Clock In','Clock Out','Reliever','Covering For']];
    rows.forEach(r => {
      const dir = guardDirectoryCache[r.site_id] || [];
      const g = dir.find(x => x.id === r.guard_id);
      const site = sites.find(s => s.id === r.site_id);
      const shift = siteShifts.find(s => s.id === r.shift_id);
      const coveringG = r.covering_guard_id ? dir.find(x => x.id === r.covering_guard_id) : null;
      csvRows.push([
        g?.employee_number || '', g?.full_name || '', site ? site.name : '', shift ? shift.name : '',
        r.shift_date, new Date(r.clock_in_at).toLocaleString([], { hour12: false }), r.clock_out_at ? new Date(r.clock_out_at).toLocaleString([], { hour12: false }) : '',
        r.is_reliever ? 'Yes' : 'No', coveringG ? (coveringG.full_name || '') : ''
      ].map(csvSafe));
    });
    const csv = csvRows.map(row => row.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `attendance_${fromStr}_${toStr}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    statusEl.textContent = `Exported ${rows.length} record${rows.length === 1 ? '' : 's'}.`;
    logAudit('export', 'attendance', null, null, `Exported attendance as CSV (${rows.length} records) - ${fromStr} to ${toStr}`, { format: 'csv', records: rows.length, from: fromStr, to: toStr });
  } catch (err) {
    console.error('Attendance export failed:', err);
    statusEl.textContent = 'Could not export — ' + (err?.message || 'unexpected error, see console.');
  } finally {
    if (btn) btn.disabled = false;
  }
}
document.getElementById('exportAttendanceBtn').addEventListener('click', (e) => {
  exportAttendanceCsv(document.getElementById('attExportFrom').value, document.getElementById('attExportTo').value, 'attExportStatus', e.currentTarget);
});

// qr-scanner (nimiq): decodes in a Web Worker, prefers the native BarcodeDetector when
// genuinely available and falls back to its own bundled decoder otherwise — unlike our
// old hand-rolled fallback, it doesn't get stuck silently returning "nothing found"
// when the native detector exists but has no working backend.
let scanning = false;
const video = document.getElementById('video');
const camPlaceholder = document.getElementById('camPlaceholder');
const scanFrame = document.getElementById('scanFrame');
const camToggleBtn = document.getElementById('camToggleBtn');

let lastDecodedAtByQr = {}, decodeLocked = false;
const AUTO_SCAN_COOLDOWN_MS = 3000;

function handleDecoded(qrId){
  if (decodeLocked) return;
  const now = Date.now();
  // Auto-scan fires on every video frame with a readable code in it, so without a
  // cooldown the same physical tap could trigger two scans a fraction of a second
  // apart — the second one landing as a spurious rejection since the checkpoint's
  // already done. The cooldown is keyed per tag, not global: a repeat of the SAME
  // tag within 3s is ignored (that's the duplicate this guards against), but a
  // DIFFERENT tag scanned a moment later - a guard moving quickly between two
  // nearby checkpoints - fires immediately instead of being dropped for up to 3s
  // and then possibly re-firing once the guard's already moved past it.
  // (The manual "Scan now" button below is a deliberate one-off tap and isn't
  // subject to this at all.)
  if (now - (lastDecodedAtByQr[qrId] || 0) < AUTO_SCAN_COOLDOWN_MS) return;
  lastDecodedAtByQr[qrId] = now;
  decodeLocked = true;
  SOUND.tagScan();
  processScan(qrId).then(record => {
    SOUND[record.result === 'ACCEPTED' ? 'tagAccepted' : 'tagRejected']();
    showResult(record);
    renderGuardPatrolCard();
    decodeLocked = false;
  }).catch(err => {
    console.error('processScan error:', err);
    decodeLocked = false;
  });
}

const qrScanner = new QrScanner(
  video,
  result => handleDecoded(result.data.trim()),
  {
    onDecodeError: () => {}, // fires on every frame with no code in view — expected, not a bug
    highlightScanRegion: false,
    highlightCodeOutline: false,
    preferredCamera: 'environment',
    maxScansPerSecond: 10
  }
);

// ---------------- Auto flashlight ----------------
// Samples the live video for average brightness and toggles the rear camera's torch
// on/off automatically — the guard never has to reach for a switch in a dark stairwell.
// Two thresholds (with a gap between them) avoid flicker right at the boundary, and a
// minimum hold time keeps it from flapping: the torch itself brightens the frame, so
// without a hold time it would see its own light and immediately shut back off.
const torchIndicator = document.getElementById('torchIndicator');
const sampleCanvas = document.getElementById('canvas');
let torchSampleInterval = null;
let torchOn = false;
let torchOnSince = 0;
const TORCH_DARK_THRESHOLD = 60;    // 0-255 average luma — below this, turn the torch on
const TORCH_BRIGHT_THRESHOLD = 95;  // above this, allow it to turn back off
const TORCH_MIN_HOLD_MS = 5000;     // once on, stays on at least this long before it can turn off

function sampleVideoBrightness(){
  if (!video.videoWidth || !video.videoHeight) return null;
  const w = 24, h = 24; // tiny sample is plenty for an average-brightness read and keeps this cheap
  sampleCanvas.width = w; sampleCanvas.height = h;
  try{
    const ctx = sampleCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    let sum = 0;
    for (let i = 0; i < data.length; i += 4){
      sum += 0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2]; // perceived luminance
    }
    return sum / (data.length / 4);
  } catch(e){
    return null; // camera frame not readable this tick — just skip, try again next tick
  }
}

async function setTorch(on){
  if (typeof qrScanner.hasFlash !== 'function') return;
  try{
    const has = await qrScanner.hasFlash();
    if (!has) return; // this camera/device has no controllable torch — nothing to do
    if (on && !torchOn){
      await qrScanner.turnFlashOn();
      torchOn = true;
      torchOnSince = Date.now();
      if (torchIndicator) torchIndicator.classList.add('on');
    } else if (!on && torchOn){
      await qrScanner.turnFlashOff();
      torchOn = false;
      if (torchIndicator) torchIndicator.classList.remove('on');
    }
  } catch(e){ /* flash unsupported or blocked — fail silently, scanning still works without it */ }
}

function startTorchAutoSensing(){
  if (torchSampleInterval) return;
  torchSampleInterval = setInterval(() => {
    const brightness = sampleVideoBrightness();
    if (brightness == null) return;
    if (!torchOn){
      if (brightness < TORCH_DARK_THRESHOLD) setTorch(true);
    } else if (brightness > TORCH_BRIGHT_THRESHOLD && Date.now() - torchOnSince >= TORCH_MIN_HOLD_MS){
      setTorch(false);
    }
  }, 1200);
}

function stopTorchAutoSensing(){
  if (torchSampleInterval){ clearInterval(torchSampleInterval); torchSampleInterval = null; }
  setTorch(false);
}

camToggleBtn.addEventListener('click', async () => {
  if (scanning){ stopCamera(); return; }
  try{
    camPlaceholder.style.display = 'none';
    camPlaceholder.classList.remove('error-text');
    scanFrame.style.display = 'block';
    await qrScanner.start();
    scanning = true;
    camToggleBtn.textContent = 'Stop camera';
    startTorchAutoSensing();
  } catch(err){
    scanFrame.style.display = 'none';
    camPlaceholder.style.display = 'flex';
    camPlaceholder.classList.add('error-text');
    camPlaceholder.textContent = 'Camera unavailable in this environment (' + (err && (err.message || err.name) || err) + '). Pick the checkpoint from the list below instead.';
  }
});

function stopCamera(){
  scanning = false;
  qrScanner.stop();
  stopTorchAutoSensing();
  scanFrame.style.display = 'none';
  camPlaceholder.style.display = 'flex';
  camPlaceholder.classList.remove('error-text');
  camPlaceholder.textContent = 'Camera off. Tap "Start camera", then "Scan checkpoint" to read a QR tag.';
  camToggleBtn.textContent = 'Start camera';
}

