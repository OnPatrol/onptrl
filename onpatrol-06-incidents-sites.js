// ---------------- Incidents (admin + controller) ----------------
let incidents = [];
let incidentFilters = { admin: { site: '', type: '', severity: '' }, ctrl: { site: '', type: '', severity: '' } };
const INCIDENT_TYPE_LABELS = Object.fromEntries(INCIDENT_TYPES.map(t => [t.value, t.label]));
const INCIDENT_SEVERITY_META = Object.fromEntries(INCIDENT_SEVERITIES.map(s => [s.value, s]));

function populateIncidentTypeFilter(id, currentVal){
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = '<option value="">All types</option>' + INCIDENT_TYPES.map(t => `<option value="${t.value}">${t.label}</option>`).join('');
  el.value = currentVal || '';
}

async function loadAndRenderIncidents(who){
  const list = document.getElementById(who + 'IncidentsList');
  list.innerHTML = '<div class="result-meta">Loading...</div>';
  if (!teamDirectory.length) await loadTeamDirectory(); // guard names for the list/detail views
  const { data, error } = await sb.from('incidents').select('*').order('occurred_at', { ascending: false });
  if (error){ list.innerHTML = `<div class="result-meta" style="color:var(--danger);">${error.message}</div>`; return; }
  incidents = data || [];
  renderIncidentsList(who);
}

function renderIncidentsList(who){
  const list = document.getElementById(who + 'IncidentsList');
  if (!list) return;
  const f = incidentFilters[who];
  populateFilterSiteSelect(who + 'IncidentSiteFilter', f.site);
  populateIncidentTypeFilter(who + 'IncidentTypeFilter', f.type);
  document.getElementById(who + 'IncidentSiteFilter').value = f.site || '';
  document.getElementById(who + 'IncidentTypeFilter').value = f.type || '';
  document.getElementById(who + 'IncidentSeverityFilter').value = f.severity || '';

  let rows = incidents.slice();
  if (f.site) rows = rows.filter(i => i.site_id === f.site);
  if (f.type) rows = rows.filter(i => i.incident_type === f.type);
  if (f.severity) rows = rows.filter(i => i.severity === f.severity);

  if (!rows.length){
    list.innerHTML = `<div class="empty">${incidents.length ? 'No incidents match this filter.' : 'No incidents reported yet.'}</div>`;
    return;
  }
  list.innerHTML = rows.map(inc => uiIncidentCard(
    inc,
    sites.find(s => s.id === inc.site_id),
    teamDirectory.find(p => p.id === inc.guard_id)
  )).join('');

  list.querySelectorAll('[data-open-incident]').forEach(el => {
    el.addEventListener('click', () => openIncidentDetail(el.dataset.openIncident, who));
  });
}

['admin','ctrl'].forEach(who => {
  const siteEl = document.getElementById(who + 'IncidentSiteFilter');
  const typeEl = document.getElementById(who + 'IncidentTypeFilter');
  const sevEl = document.getElementById(who + 'IncidentSeverityFilter');
  if (siteEl) siteEl.addEventListener('change', () => { incidentFilters[who].site = siteEl.value; renderIncidentsList(who); });
  if (typeEl) typeEl.addEventListener('change', () => { incidentFilters[who].type = typeEl.value; renderIncidentsList(who); });
  if (sevEl) sevEl.addEventListener('change', () => { incidentFilters[who].severity = sevEl.value; renderIncidentsList(who); });
});

async function openIncidentDetail(incidentId, who){
  const inc = incidents.find(i => i.id === incidentId);
  if (!inc) return;
  const site = sites.find(s => s.id === inc.site_id);
  const guardEntry = teamDirectory.find(p => p.id === inc.guard_id);
  const route = routes.find(r => r.id === inc.route_id);
  const cp = checkpoints.find(c => c.id === inc.checkpoint_id);
  const sev = INCIDENT_SEVERITY_META[inc.severity] || { emoji: '', label: inc.severity };
  const resolverEntry = inc.resolved_by ? teamDirectory.find(p => p.id === inc.resolved_by) : null;

  let photoUrls = [];
  if (inc.photo_paths && inc.photo_paths.length){
    const results = await Promise.all(inc.photo_paths.map(p => sb.storage.from('incident-photos').createSignedUrl(p, 3600)));
    photoUrls = results.map(r => r.data ? r.data.signedUrl : null).filter(Boolean);
  }

  const { data: comments } = await sb.from('incident_comments').select('*').eq('incident_id', incidentId).order('created_at');
  const { data: incidentSiteContacts } = await sb.from('site_contacts').select('*').eq('site_id', inc.site_id);

  const body = document.getElementById('incidentDetailBody');
  body.innerHTML = `
    <h2 style="margin:0 0 4px; font-size:16px;">${sev.emoji} ${escapeHtmlForPrint(INCIDENT_TYPE_LABELS[inc.incident_type] || inc.incident_type)}</h2>
    <div class="result-meta" style="margin-bottom:10px;">${escapeHtmlForPrint(site ? site.name : '—')} · ${new Date(inc.occurred_at).toLocaleString([], { hour12: false })} · ${inc.status === 'reviewed' ? 'Reviewed' : 'Open'}</div>

    <div class="attendance-card" style="margin:0 0 12px;">
      <div class="result-meta" style="line-height:1.7;">
        Guard: ${escapeHtmlForPrint(guardEntry ? guardEntry.full_name : 'Unknown')}<br>
        GPS: ${inc.lat != null ? inc.lat.toFixed(5) + ', ' + inc.lng.toFixed(5) : 'Not available'}<br>
        Device: ${escapeHtmlForPrint(inc.device_info || '—')}<br>
        Patrol: ${escapeHtmlForPrint(route ? route.name : 'No scheduled patrol')}<br>
        Checkpoint: ${escapeHtmlForPrint(cp ? cp.name : 'None')}
      </div>
    </div>

    <div class="field-label" style="margin-top:0;">Description</div>
    <div class="result-meta" style="color:var(--text); margin-bottom:10px;">${escapeHtmlForPrint(inc.description || '—')}</div>
    <div class="field-label">Actions taken</div>
    <div class="result-meta" style="color:var(--text); margin-bottom:10px;">${escapeHtmlForPrint(inc.actions_taken || '—')}</div>
    <div class="field-label">Resolution</div>
    ${inc.resolution ? `
      <div class="result-meta" style="color:var(--text); margin-bottom:${resolverEntry ? '4px' : '10px'};">${escapeHtmlForPrint(inc.resolution)}</div>
      ${resolverEntry ? `<div class="result-meta" style="margin-bottom:10px;">Recorded by ${escapeHtmlForPrint(resolverEntry.full_name)} (${escapeHtmlForPrint(resolverEntry.role)}) on behalf of the guard${inc.resolved_at ? ' · ' + new Date(inc.resolved_at).toLocaleString([], { hour12: false }) : ''}</div>` : ''}
    ` : `
      <div class="attendance-card" style="margin:0 0 12px;">
        <div class="result-meta" style="margin-bottom:8px;">This report was submitted without a resolution. Record it on behalf of ${escapeHtmlForPrint(guardEntry ? guardEntry.full_name : 'the guard')} — it is saved under your name and can't be changed afterwards.</div>
        ${inc.actions_taken ? '' : `
          <div class="field-label" style="margin-top:0;">Actions taken <span class="result-meta">(optional)</span></div>
          <textarea id="incidentResolveActions" rows="2" placeholder="What was done about it?" style="margin-bottom:8px;"></textarea>`}
        <div class="field-label" style="margin-top:0;">Resolution</div>
        <textarea id="incidentResolveInput" rows="3" placeholder="How was it resolved?" style="margin-bottom:8px;"></textarea>
        <div id="incidentResolveError" class="result-meta" style="color:var(--danger); display:none; margin-bottom:8px; font-family:var(--sans);"></div>
        <button class="btn btn-primary" id="incidentSaveResolutionBtn" style="width:auto; padding:8px 14px;">Save resolution</button>
      </div>
    `}

    ${photoUrls.length ? `
      <div class="field-label">Photos</div>
      <div style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:10px;">
        ${photoUrls.map(u => `<a href="${u}" target="_blank" rel="noopener"><img src="${u}" style="width:72px; height:72px; object-fit:cover; border-radius:6px; border:1px solid var(--border);"></a>`).join('')}
      </div>
    ` : ''}

    <div class="field-label">Comments</div>
    <div id="incidentCommentsList" style="margin-bottom:10px;">
      ${(comments || []).length ? comments.map(c => {
        const author = teamDirectory.find(p => p.id === c.author_id);
        return `<div class="result-meta" style="margin-bottom:6px; padding-bottom:6px; border-bottom:1px solid var(--border);"><b style="color:var(--text);">${escapeHtmlForPrint(author ? author.full_name : 'Someone')}</b> · ${timeAgo(c.created_at)}<br>${escapeHtmlForPrint(c.comment)}</div>`;
      }).join('') : '<div class="result-meta">No comments yet.</div>'}
    </div>

    <input type="text" id="incidentCommentInput" placeholder="Add a comment — a correction or a revised account…" style="margin-bottom:8px;">
    <div class="btn-row">
      <button class="btn btn-primary" id="incidentAddCommentBtn" style="width:auto; padding:8px 14px;">Post comment</button>
      ${inc.status !== 'reviewed' ? `<button class="btn" id="incidentMarkReviewedBtn" style="width:auto; padding:8px 14px;">Mark reviewed</button>` : ''}
    </div>

    ${who === 'admin' ? renderIncidentClientEmailSection(inc, incidentSiteContacts || []) : ''}
  `;

  if (who === 'admin') wireIncidentClientEmailSection(inc, incidentId, who, incidentSiteContacts || []);

  const saveResolutionBtn = document.getElementById('incidentSaveResolutionBtn');
  if (saveResolutionBtn){
    saveResolutionBtn.addEventListener('click', async () => {
      const errEl = document.getElementById('incidentResolveError');
      errEl.style.display = 'none';
      const resolution = document.getElementById('incidentResolveInput').value.trim();
      const actionsEl = document.getElementById('incidentResolveActions');
      const actions = actionsEl ? actionsEl.value.trim() : '';
      if (!resolution){ errEl.textContent = 'Write the resolution first.'; errEl.style.display = 'block'; return; }
      saveResolutionBtn.disabled = true; saveResolutionBtn.textContent = 'Saving…';
      const patch = { resolution, resolved_by: session.user.id, resolved_at: new Date().toISOString() };
      if (actions) patch.actions_taken = actions;
      // Only fills in a blank resolution - it can never overwrite one that is already there.
      const { data: saved, error } = await sb.from('incidents').update(patch).eq('id', incidentId).eq('resolution', '').select();
      saveResolutionBtn.disabled = false; saveResolutionBtn.textContent = 'Save resolution';
      if (error){ errEl.textContent = 'Could not save — ' + error.message; errEl.style.display = 'block'; return; }
      if (!saved || !saved.length){
        errEl.textContent = 'Someone has already recorded a resolution for this report. Close and reopen it to see it.';
        errEl.style.display = 'block';
        return;
      }
      Object.assign(inc, saved[0]);
      showToast('Resolution saved', 'Recorded on behalf of the guard under your name.', 'success');
      renderIncidentsList(who);
      openIncidentDetail(incidentId, who);
    });
  }

  document.getElementById('incidentAddCommentBtn').addEventListener('click', async () => {
    const input = document.getElementById('incidentCommentInput');
    const text = input.value.trim();
    if (!text) return;
    const { error } = await sb.from('incident_comments').insert({ incident_id: incidentId, author_id: session.user.id, comment: text });
    if (error){ showToast('Could not post comment', error.message, 'danger'); return; }
    input.value = '';
    openIncidentDetail(incidentId, who);
  });

  const reviewBtn = document.getElementById('incidentMarkReviewedBtn');
  if (reviewBtn){
    reviewBtn.addEventListener('click', async () => {
      const { error } = await sb.from('incidents').update({ status: 'reviewed' }).eq('id', incidentId);
      if (error){ showToast('Could not update status', error.message, 'danger'); return; }
      inc.status = 'reviewed';
      showToast('Marked reviewed', '', 'success');
      document.getElementById('incidentDetailModalBg').classList.remove('show');
      renderIncidentsList(who);
    });
  }

  document.getElementById('incidentDetailModalBg').classList.add('show');
}

// Only relevant once there's actually something conclusive to tell the
// client — gated on the guard having filled in a resolution, and only for
// admins (controllers can read/comment but this is an admin-level action).
function renderIncidentClientEmailSection(inc, contacts){
  const emailable = contacts.filter(c => c.email);
  const alreadySent = inc.client_emailed_at
    ? `<div class="result-meta" style="margin-bottom:8px;">Last emailed to client on ${new Date(inc.client_emailed_at).toLocaleString([], { hour12: false })} — ${(inc.client_emailed_to || []).map(r => r.name).join(', ')}.</div>`
    : '';

  if (!inc.resolution){
    return `
      <div style="margin-top:16px; padding-top:14px; border-top:1px solid var(--border);">
        <div style="font-family:var(--sans); font-weight:700; font-size:12.5px; margin-bottom:4px;">Email to client</div>
        <div class="result-meta">Available once a resolution has been recorded — add it in the Resolution section above.</div>
      </div>
    `;
  }
  if (!emailable.length){
    return `
      <div style="margin-top:16px; padding-top:14px; border-top:1px solid var(--border);">
        <div style="font-family:var(--sans); font-weight:700; font-size:12.5px; margin-bottom:4px;">Email to client</div>
        ${alreadySent}
        <div class="result-meta">No contacts with an email address are on file for this site yet — add one under Manage site → Site contacts.</div>
      </div>
    `;
  }

  return `
    <div style="margin-top:16px; padding-top:14px; border-top:1px solid var(--border);">
      <div style="font-family:var(--sans); font-weight:700; font-size:12.5px; margin-bottom:4px;">Email to client</div>
      ${alreadySent}
      <div class="result-meta" style="margin-bottom:6px;">Send to:</div>
      ${emailable.map(c => `
        <label style="display:flex; align-items:center; gap:8px; font-size:13px; margin-bottom:6px; font-family:var(--sans);">
          <input type="checkbox" data-email-contact="${c.id}" ${c.incident_email_default ? 'checked' : ''}>
          ${escapeHtmlForPrint(c.name)} <span class="result-meta">(${CONTACT_ROLE_LABELS[c.role] || c.role})</span>
        </label>
      `).join('')}
      <label style="display:flex; align-items:center; gap:8px; font-size:13px; margin:10px 0 6px; font-family:var(--sans);">
        <input type="checkbox" id="incidentEmailIncludePhotos" ${inc.photo_paths && inc.photo_paths.length ? 'checked' : ''} ${inc.photo_paths && inc.photo_paths.length ? '' : 'disabled'}>
        Attach photos ${inc.photo_paths && inc.photo_paths.length ? '' : '<span class="result-meta">(none on this report)</span>'}
      </label>
      <label style="display:flex; align-items:center; gap:8px; font-size:13px; margin-bottom:10px; font-family:var(--sans);">
        <input type="checkbox" id="incidentEmailIncludeComments" checked>
        Include controller/admin comments
      </label>
      <div id="incidentEmailError" class="result-meta" style="color:var(--danger); display:none; margin-bottom:8px;"></div>
      <button class="btn btn-primary" id="incidentSendEmailBtn" style="width:auto; padding:8px 14px;">Send to client</button>
    </div>
  `;
}

function wireIncidentClientEmailSection(inc, incidentId, who, contacts){
  const btn = document.getElementById('incidentSendEmailBtn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const errEl = document.getElementById('incidentEmailError');
    errEl.style.display = 'none';
    const contactIds = Array.from(document.querySelectorAll('[data-email-contact]:checked')).map(el => el.dataset.emailContact);
    if (!contactIds.length){ errEl.textContent = 'Select at least one recipient.'; errEl.style.display = 'block'; return; }
    const includePhotos = document.getElementById('incidentEmailIncludePhotos').checked;
    const includeComments = document.getElementById('incidentEmailIncludeComments').checked;

    btn.disabled = true;
    btn.textContent = 'Sending…';
    try{
      const { data, error } = await sb.functions.invoke('send-incident-email', {
        body: { incident_id: incidentId, contact_ids: contactIds, include_photos: includePhotos, include_comments: includeComments }
      });
      if (error || data?.error){
        errEl.textContent = await functionErrorMessage(data, error, 'Could not send email.');
        errEl.style.display = 'block';
        return;
      }
      showToast('Email sent', `Sent to ${(data.sent_to || []).join(', ')}`, 'success');
      logAudit('email_incident', 'incident', incidentId, inc.site_id, `Emailed incident report to ${(data.sent_to || []).join(', ')}`, { to: data.sent_to || [], photos: includePhotos, comments: includeComments });
      inc.client_emailed_at = new Date().toISOString();
      inc.client_emailed_to = contacts.filter(c => contactIds.includes(c.id)).map(c => ({ name: c.name, email: c.email }));
      openIncidentDetail(incidentId, who);
    } catch(err){
      errEl.textContent = err.message;
      errEl.style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Send to client';
    }
  });
}

function renderSiteTable(){
  const body = document.getElementById('siteTableBody');
  const q = (document.getElementById('siteSearch').value || '').toLowerCase();
  const filtered = sites.filter(s => s.name.toLowerCase().includes(q) || s.address.toLowerCase().includes(q) || (s.phone || '').toLowerCase().includes(q));
  if (filtered.length === 0){
    body.innerHTML = '<tr><td colspan="8" style="font-family:var(--sans); color:var(--muted);">No sites match.</td></tr>';
    return;
  }
  body.innerHTML = filtered.map(s => {
    const cpCount = checkpoints.filter(c => c.siteId === s.id).length;
    const routeCount = routes.filter(r => r.siteId === s.id).length;
    return `
      <tr>
        <td style="font-family:var(--sans); font-weight:600;">${escapeHtmlForPrint(s.name)}</td>
        <td style="font-family:var(--sans); color:var(--muted);">${escapeHtmlForPrint(s.address)}</td>
        <td style="font-family:var(--sans);">${s.phone ? phoneLinkHtml(s.phone) : '<span style="color:var(--warn);">Not set</span>'}</td>
        <td style="letter-spacing:0.5px;">${s.siteCode || '—'}</td>
        <td>${cpCount}</td>
        <td>${routeCount}</td>
        <td style="display:flex; gap:6px;">
          <button class="btn" data-map-site="${s.id}" style="width:auto; padding:5px 10px; font-size:11px;"><svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M9 20 3 17V4l6 3 6-3 6 3v13l-6-3-6 3Z"/><path d="M9 4v13M15 7v13"/></svg> Map</button>
          <button class="btn" data-manage-site="${s.id}" style="width:auto; padding:5px 10px; font-size:11px;">Manage</button>
          <button class="del-btn" data-del-site="${s.id}" aria-label="Delete site"><i>&times;</i></button>
        </td>
      </tr>
    `;
  }).join('');
  body.querySelectorAll('[data-map-site]').forEach(btn => {
    btn.addEventListener('click', () => openSiteMapModal(btn.dataset.mapSite));
  });
  body.querySelectorAll('[data-manage-site]').forEach(btn => {
    btn.addEventListener('click', () => {
      setActiveSite(btn.dataset.manageSite);
      renderAll();
      document.querySelector('[data-admin-view="manage"]').click();
    });
  });
  body.querySelectorAll('[data-del-site]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.delSite;
      const s = sites.find(st => st.id === id);
      if (!confirm(`Delete site "${s ? s.name : ''}"? This permanently removes all of its checkpoints, routes, schedules, and scan history. This can't be undone.`)) return;
      const { error } = await sb.from('sites').delete().eq('id', id);
      if (error){ showToast('Could not delete site', error.message, 'danger'); return; }
      showToast('Site deleted', s ? `${s.name} and all its data were removed.` : '', 'success');
      await loadAllData();
      if (!sites.some(s => s.id === activeSiteId)) setActiveSite(sites[0] ? sites[0].id : null);
      renderAll();
    });
  });
}

function renderControllerSiteTable(){
  const body = document.getElementById('ctrlSiteTableBody');
  if (!body) return;
  if (sites.length === 0){
    body.innerHTML = '<tr><td colspan="6" style="font-family:var(--sans); color:var(--muted);">No sites yet.</td></tr>';
    return;
  }
  const searchEl = document.getElementById('ctrlSiteSearch');
  const q = searchEl ? searchEl.value.trim().toLowerCase() : '';
  const filtered = q
    ? sites.filter(s => (s.name || '').toLowerCase().includes(q) || (s.address || '').toLowerCase().includes(q) || (s.phone || '').toLowerCase().includes(q))
    : sites;
  if (filtered.length === 0){
    body.innerHTML = '<tr><td colspan="6" style="font-family:var(--sans); color:var(--muted);">No sites match your search.</td></tr>';
    return;
  }
  body.innerHTML = filtered.map(s => {
    const cpCount = checkpoints.filter(c => c.siteId === s.id).length;
    const routeCount = routes.filter(r => r.siteId === s.id).length;
    return `
      <tr>
        <td style="font-family:var(--sans); font-weight:600;">${escapeHtmlForPrint(s.name)}</td>
        <td style="font-family:var(--sans); color:var(--muted);">${escapeHtmlForPrint(s.address)}</td>
        <td style="font-family:var(--sans);">${s.phone ? phoneLinkHtml(s.phone) : '<span style="color:var(--warn);">Not set</span>'}</td>
        <td>${cpCount}</td>
        <td>${routeCount}</td>
        <td><div style="display:flex; gap:6px;">
          <button class="btn" data-map-site="${s.id}" style="width:auto; padding:5px 10px; font-size:11px;">${'<svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M9 20 3 17V4l6 3 6-3 6 3v13l-6-3-6 3Z"/><path d="M9 4v13M15 7v13"/></svg>'} Map</button>
          <button class="btn btn-primary" data-detail-site="${s.id}" style="width:auto; padding:5px 10px; font-size:11px;"><svg class="icon icon-sm" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg> Details</button>
        </div></td>
      </tr>
    `;
  }).join('');
  body.querySelectorAll('[data-map-site]').forEach(btn => {
    btn.addEventListener('click', () => openSiteMapModal(btn.dataset.mapSite));
  });
  body.querySelectorAll('[data-detail-site]').forEach(btn => {
    btn.addEventListener('click', () => openCtrlSiteDetailModal(btn.dataset.detailSite));
  });
}
document.getElementById('ctrlSiteSearch').addEventListener('input', renderControllerSiteTable);

// ---------------- Controller: site detail modal (contacts, home guards, vehicles) ----------------
async function openCtrlSiteDetailModal(siteId){
  const s = sites.find(x => x.id === siteId);
  document.getElementById('ctrlSiteDetailTitle').textContent = s ? s.name : 'Site';
  document.getElementById('ctrlSiteDetailAddress').textContent = s ? (s.address || '') : '';
  document.getElementById('ctrlSiteDetailPhone').innerHTML = s && s.phone
    ? `Site phone: ${phoneLinkHtml(s.phone)}`
    : '<span style="color:var(--warn);">No site phone number set</span>';

  const contactsEl = document.getElementById('ctrlSiteContactsList');
  const guardsEl = document.getElementById('ctrlSiteGuardsList');
  const vehiclesEl = document.getElementById('ctrlSiteVehiclesList');
  contactsEl.innerHTML = '<div class="result-meta">Loading…</div>';
  guardsEl.innerHTML = '<div class="result-meta">Loading…</div>';
  vehiclesEl.innerHTML = '<div class="result-meta">Loading…</div>';
  document.getElementById('ctrlSiteDetailModalBg').classList.add('show');

  const [contactsRes, vehiclesRes, guards] = await Promise.all([
    sb.from('site_contacts').select('*').eq('site_id', siteId).order('created_at'),
    sb.from('site_vehicles').select('*').eq('site_id', siteId).order('created_at'),
    loadGuardDirectory(siteId)
  ]);

  contactsEl.innerHTML = (contactsRes.data && contactsRes.data.length) ? contactsRes.data.map(c => `
    <div class="site-contact-row">
      <div style="flex:1; min-width:0;">
        <div class="site-contact-name">${escapeHtmlForPrint(c.name)} <span class="site-contact-role">· ${escapeHtmlForPrint(c.role)}</span></div>
        <div class="result-meta" style="margin-top:2px;">${[c.phone, c.email].filter(Boolean).map(escapeHtmlForPrint).join(' · ') || '—'}</div>
      </div>
    </div>`).join('') : '<div class="result-meta">No contacts added yet.</div>';

  guardsEl.innerHTML = (guards && guards.length) ? guards.map(g => `
    <div class="site-contact-row">
      <div style="flex:1; min-width:0;">
        <div class="site-contact-name">${escapeHtmlForPrint(g.full_name || 'Guard')}</div>
        <div class="result-meta">${escapeHtmlForPrint(g.employee_number ? '#' + g.employee_number : 'No employee number set')}${g.phone ? ' · ' + escapeHtmlForPrint(g.phone) : ''}</div>
      </div>
    </div>`).join('') : '<div class="result-meta">No guards assigned to this site yet.</div>';

  vehiclesEl.innerHTML = (vehiclesRes.data && vehiclesRes.data.length) ? vehiclesRes.data.map(v => `
    <div class="site-contact-row">
      <div style="flex:1; min-width:0;">
        <div class="site-contact-name">${v.label}${v.plate ? ' <span class="site-contact-role">· ' + v.plate + '</span>' : ''}</div>
        ${v.notes ? `<div class="result-meta" style="margin-top:2px;">${v.notes}</div>` : ''}
      </div>
    </div>`).join('') : '<div class="result-meta">No vehicles added yet.</div>';
}
document.getElementById('ctrlSiteDetailCloseBtn').addEventListener('click', () => {
  document.getElementById('ctrlSiteDetailModalBg').classList.remove('show');
});

// ---------------- Site map modal (Leaflet / OpenStreetMap) ----------------
let siteMapInstance = null;
let siteMapMarker = null;
let siteMapCurrentSiteId = null;
let siteMapMode = 'pin'; // 'pin' | 'perimeter'
let sitePerimeterPoints = [];       // working copy of [{lat,lng}, ...] while the modal is open
let sitePerimeterPolygon = null;
let sitePerimeterVertexMarkers = [];
let siteContacts = [];

async function openSiteMapModal(siteId){
  const s = sites.find(x => x.id === siteId);
  if (!s) return;
  const isAdmin = profile.role === 'admin';
  siteMapCurrentSiteId = siteId;
  siteMapMode = 'pin';
  sitePerimeterPoints = Array.isArray(s.perimeter) ? s.perimeter.map(p => ({ lat: p.lat, lng: p.lng })) : [];
  sitePerimeterPolygon = null;
  sitePerimeterVertexMarkers = [];

  document.getElementById('siteMapTitle').textContent = s.name;
  document.getElementById('siteMapSub').textContent = s.address || '';
  document.getElementById('siteMapEditWrap').style.display = isAdmin ? 'block' : 'none';
  document.getElementById('siteMapLat').value = s.lat != null ? s.lat : '';
  document.getElementById('siteMapLng').value = s.lng != null ? s.lng : '';
  document.getElementById('siteMapEditStatus').textContent = '';

  const hasLoc = s.lat != null && s.lng != null;
  document.getElementById('siteMapNoLocation').style.display = hasLoc ? 'none' : 'block';
  document.getElementById('siteMapBox').style.display = hasLoc ? 'block' : 'none';
  document.getElementById('siteMapModeRow').style.display = (hasLoc && isAdmin) ? 'flex' : 'none';
  document.getElementById('siteMapPinHint').style.display = (hasLoc && isAdmin) ? 'block' : 'none';
  document.getElementById('siteMapReadOnlyNote').style.display = (hasLoc && !isAdmin) ? 'block' : 'none';
  document.getElementById('sitePerimeterWrap').style.display = 'none';
  document.getElementById('sitePerimeterStatus').style.display = 'none';
  document.getElementById('siteMapModalBg').classList.add('show');

  if (hasLoc){
    setTimeout(() => {
      if (siteMapInstance){ siteMapInstance.remove(); siteMapInstance = null; }
      siteMapInstance = L.map('siteMapBox').setView([s.lat, s.lng], 16);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap contributors', maxZoom: 19
      }).addTo(siteMapInstance);
      siteMapMarker = L.marker([s.lat, s.lng], { draggable: isAdmin }).addTo(siteMapInstance).bindPopup(s.name);
      siteMapMarker.on('dragend', () => {
        const ll = siteMapMarker.getLatLng();
        document.getElementById('siteMapLat').value = ll.lat.toFixed(6);
        document.getElementById('siteMapLng').value = ll.lng.toFixed(6);
        document.getElementById('siteMapEditStatus').textContent = 'Pin moved — GPS can be a few metres off, so drag it to the exact spot, then tap "Save location" to confirm.';
      });
      // Clicking the map only adds perimeter points while in "Draw perimeter" mode —
      // it's a no-op in "Move pin" mode so a stray tap can't accidentally start a shape.
      siteMapInstance.on('click', (e) => {
        if (siteMapMode !== 'perimeter' || !isAdmin) return;
        sitePerimeterPoints.push({ lat: e.latlng.lat, lng: e.latlng.lng });
        redrawSitePerimeter();
      });
      redrawSitePerimeter();
      setSiteMapMode('pin');
    }, 50);
  }

  await loadSiteContactsFor(siteId);
  renderSiteContacts();
}

// Redraws the perimeter polygon and its draggable vertex handles from
// sitePerimeterPoints. Called after every add/undo/clear/drag so the shape and the
// status line always reflect the current working points.
function redrawSitePerimeter(){
  if (!siteMapInstance) return;
  if (sitePerimeterPolygon){ siteMapInstance.removeLayer(sitePerimeterPolygon); sitePerimeterPolygon = null; }
  sitePerimeterVertexMarkers.forEach(m => siteMapInstance.removeLayer(m));
  sitePerimeterVertexMarkers = [];

  if (sitePerimeterPoints.length){
    sitePerimeterPolygon = L.polygon(sitePerimeterPoints.map(p => [p.lat, p.lng]), {
      color: '#F5A623', weight: 2, fillOpacity: 0.12
    }).addTo(siteMapInstance);

    sitePerimeterPoints.forEach((p, i) => {
      const vm = L.marker([p.lat, p.lng], {
        draggable: true,
        icon: L.divIcon({ className: 'perimeter-vertex', iconSize: [12, 12], iconAnchor: [6, 6] })
      }).addTo(siteMapInstance);
      vm.on('drag', (e) => {
        const ll = e.target.getLatLng();
        sitePerimeterPoints[i] = { lat: ll.lat, lng: ll.lng };
        if (sitePerimeterPolygon) sitePerimeterPolygon.setLatLngs(sitePerimeterPoints.map(pt => [pt.lat, pt.lng]));
      });
      sitePerimeterVertexMarkers.push(vm);
    });
  }

  const statusEl = document.getElementById('sitePerimeterStatus');
  statusEl.textContent = sitePerimeterPoints.length
    ? `${sitePerimeterPoints.length} point${sitePerimeterPoints.length === 1 ? '' : 's'} — drag a point to adjust it, or tap the map to add more.`
    : 'Tap the map to start drawing the perimeter.';
}

function setSiteMapMode(mode){
  siteMapMode = mode;
  document.getElementById('siteMapModePinBtn').classList.toggle('btn-primary', mode === 'pin');
  document.getElementById('siteMapModePerimeterBtn').classList.toggle('btn-primary', mode === 'perimeter');
  document.getElementById('sitePerimeterWrap').style.display = mode === 'perimeter' ? 'flex' : 'none';
  document.getElementById('sitePerimeterStatus').style.display = mode === 'perimeter' ? 'block' : 'none';
  if (siteMapMarker){
    if (mode === 'pin') siteMapMarker.dragging.enable(); else siteMapMarker.dragging.disable();
  }
  if (mode === 'perimeter') redrawSitePerimeter();
}

document.getElementById('siteMapModePinBtn').addEventListener('click', () => setSiteMapMode('pin'));
document.getElementById('siteMapModePerimeterBtn').addEventListener('click', () => setSiteMapMode('perimeter'));

document.getElementById('sitePerimeterUndoBtn').addEventListener('click', () => {
  sitePerimeterPoints.pop();
  redrawSitePerimeter();
});
document.getElementById('sitePerimeterClearBtn').addEventListener('click', () => {
  if (!sitePerimeterPoints.length) return;
  if (!confirm('Clear all perimeter points?')) return;
  sitePerimeterPoints = [];
  redrawSitePerimeter();
});
document.getElementById('sitePerimeterSaveBtn').addEventListener('click', async () => {
  if (sitePerimeterPoints.length < 3){
    document.getElementById('sitePerimeterStatus').textContent = 'Add at least 3 points to form a perimeter.';
    return;
  }
  const { error } = await sb.from('sites').update({ perimeter: sitePerimeterPoints }).eq('id', siteMapCurrentSiteId);
  if (error){ showToast('Could not save perimeter', error.message, 'danger'); return; }
  const s = sites.find(x => x.id === siteMapCurrentSiteId);
  if (s) s.perimeter = sitePerimeterPoints;
  showToast('Perimeter saved', '', 'success');
});

document.getElementById('siteMapCloseBtn').addEventListener('click', () => {
  document.getElementById('siteMapModalBg').classList.remove('show');
  if (siteMapInstance){ siteMapInstance.remove(); siteMapInstance = null; }
  siteMapMarker = null;
  sitePerimeterPolygon = null;
  sitePerimeterVertexMarkers = [];
});

document.getElementById('siteMapUseLocBtn').addEventListener('click', () => {
  const status = document.getElementById('siteMapEditStatus');
  if (!navigator.geolocation){ status.textContent = 'Geolocation not available on this device.'; return; }
  status.textContent = 'Locating…';
  navigator.geolocation.getCurrentPosition(pos => {
    document.getElementById('siteMapLat').value = pos.coords.latitude.toFixed(6);
    document.getElementById('siteMapLng').value = pos.coords.longitude.toFixed(6);
    status.textContent = 'Location captured — GPS can be a little off, so once saved you can fine-tune it by dragging the pin. Tap "Save location" to confirm.';
  }, err => {
    status.textContent = 'Could not get location — ' + err.message;
  }, { enableHighAccuracy: true, timeout: 10000 });
});

document.getElementById('siteMapSaveBtn').addEventListener('click', async () => {
  const lat = parseFloat(document.getElementById('siteMapLat').value);
  const lng = parseFloat(document.getElementById('siteMapLng').value);
  const status = document.getElementById('siteMapEditStatus');
  if (isNaN(lat) || isNaN(lng)){
    status.textContent = 'Enter a valid latitude and longitude.';
    return;
  }
  const { error } = await sb.from('sites').update({ lat, lng }).eq('id', siteMapCurrentSiteId);
  if (error){
    status.textContent = 'Could not save — ' + error.message;
    return;
  }
  showToast('Location saved', '', 'success');
  await loadSites();
  renderAll();
  openSiteMapModal(siteMapCurrentSiteId);
});

// ---------------- Manage site: basic info, location summary, guards, vehicles ----------------
function renderManageSiteBasicInfo(){
  const nameEl = document.getElementById('manageSiteName');
  if (!nameEl) return;
  const s = sites.find(x => x.id === activeSiteId);
  const addrEl = document.getElementById('manageSiteAddress');
  const summaryEl = document.getElementById('manageSiteLocationSummary');
  const phoneEl = document.getElementById('manageSitePhone');
  if (!s){
    nameEl.value = ''; addrEl.value = ''; if (phoneEl) phoneEl.value = '';
    document.getElementById('manageSiteCode').textContent = '—';
    summaryEl.textContent = 'No site selected.';
    return;
  }
  // Don't stomp on text the admin is mid-typing when a background refresh runs.
  if (document.activeElement !== nameEl) nameEl.value = s.name || '';
  if (document.activeElement !== addrEl) addrEl.value = (s.address && s.address !== '—') ? s.address : '';
  if (phoneEl && document.activeElement !== phoneEl) phoneEl.value = s.phone || '';
  document.getElementById('manageSiteCode').textContent = s.siteCode || '—';

  const hasLoc = s.lat != null && s.lng != null;
  const perimeterCount = Array.isArray(s.perimeter) ? s.perimeter.length : 0;
  summaryEl.textContent = hasLoc
    ? `Pinned at ${Number(s.lat).toFixed(5)}, ${Number(s.lng).toFixed(5)}${perimeterCount >= 3 ? ` · perimeter drawn (${perimeterCount} points)` : ' · no perimeter drawn yet'}`
    : 'No location set yet — open the map to drop a pin.';
}

document.getElementById('manageSiteSaveBtn').addEventListener('click', async () => {
  if (!activeSiteId) return;
  const statusEl = document.getElementById('manageSiteSaveStatus');
  const name = document.getElementById('manageSiteName').value.trim();
  const address = document.getElementById('manageSiteAddress').value.trim();
  const phone = cleanPhone(document.getElementById('manageSitePhone').value);
  if (!name){ statusEl.textContent = 'Site name is required.'; return; }
  if (!isValidPhone(phone)){ statusEl.textContent = 'The site phone number is required (e.g. 082 123 4567 or +27 82 123 4567).'; return; }
  statusEl.textContent = 'Saving…';
  const { error } = await sb.from('sites').update({ name, address: address || null, phone }).eq('id', activeSiteId);
  if (error){ statusEl.textContent = 'Could not save — ' + error.message; return; }
  await loadSites();
  renderAll();
  statusEl.textContent = 'Saved.';
  showToast('Site updated', '', 'success');
});

document.getElementById('manageSiteOpenMapBtn').addEventListener('click', () => {
  if (activeSiteId) openSiteMapModal(activeSiteId);
});

// Guards roster is read-only here — editing names/employee numbers happens in Users,
// since that's where employee number + face-reset already live.
async function renderManageSiteGuards(){
  const el = document.getElementById('manageSiteGuardsList');
  if (!el || !activeSiteId) return;
  const dir = await loadGuardDirectory(activeSiteId);
  el.innerHTML = dir.length
    ? dir.map(g => `
        <div class="site-contact-row">
          <div style="flex:1; min-width:0;">
            <div class="site-contact-name">${escapeHtmlForPrint(g.full_name || 'Guard')}</div>
            <div class="result-meta">${escapeHtmlForPrint(g.employee_number ? '#' + g.employee_number : 'No employee number set')}${g.phone ? ' · ' + escapeHtmlForPrint(g.phone) : ''}</div>
          </div>
        </div>`).join('')
    : '<div class="result-meta">No guards assigned to this site yet.</div>';
}

// ---------------- Manage site: vehicles ----------------
let siteVehicles = [];
async function loadSiteVehicles(siteId){
  const { data, error } = await sb.from('site_vehicles').select('*').eq('site_id', siteId).order('created_at');
  if (error){ showToast('Could not load vehicles', error.message, 'danger'); siteVehicles = []; return; }
  siteVehicles = (data || []).map(v => ({ id: v.id, label: v.label, plate: v.plate, notes: v.notes }));
}
function renderSiteVehicles(){
  const el = document.getElementById('siteVehiclesList');
  if (!el) return;
  el.innerHTML = siteVehicles.length ? siteVehicles.map(v => `
    <div class="site-contact-row">
      <div style="flex:1; min-width:0;">
        <div class="site-contact-name">${v.label}${v.plate ? ' <span class="site-contact-role">· ' + v.plate + '</span>' : ''}</div>
        ${v.notes ? `<div class="result-meta" style="margin-top:2px;">${v.notes}</div>` : ''}
      </div>
      <button class="del-btn" data-del-vehicle="${v.id}" aria-label="Remove vehicle"><i>&times;</i></button>
    </div>
  `).join('') : '<div class="result-meta">No vehicles added yet.</div>';
  el.querySelectorAll('[data-del-vehicle]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this vehicle?')) return;
      const { error } = await sb.from('site_vehicles').delete().eq('id', btn.dataset.delVehicle);
      if (error){ showToast('Could not remove vehicle', error.message, 'danger'); return; }
      await loadSiteVehicles(activeSiteId);
      renderSiteVehicles();
    });
  });
}
document.getElementById('addVehicleBtn').addEventListener('click', async () => {
  if (!activeSiteId) return;
  const label = document.getElementById('newVehicleLabel').value.trim();
  const plate = document.getElementById('newVehiclePlate').value.trim();
  const notes = document.getElementById('newVehicleNotes').value.trim();
  if (!label){ showToast('Vehicle needs a name/label', '', 'warn'); return; }
  const { error } = await sb.from('site_vehicles').insert({ site_id: activeSiteId, label, plate: plate || null, notes: notes || null });
  if (error){ showToast('Could not add vehicle', error.message, 'danger'); return; }
  document.getElementById('newVehicleLabel').value = '';
  document.getElementById('newVehiclePlate').value = '';
  document.getElementById('newVehicleNotes').value = '';
  await loadSiteVehicles(activeSiteId);
  renderSiteVehicles();
  showToast('Vehicle added', '', 'success');
});

// Refreshes every section of Manage Site for whichever site is currently
// selected. Contacts/guards/vehicles aren't part of the eager global load (only
// fetched for the site actually being viewed), so this runs on tab-open and
// whenever this page's own site switcher changes.
async function refreshManageSitePanels(){
  if (!activeSiteId) return;
  renderManageSiteBasicInfo();
  await loadSiteContactsFor(activeSiteId);
  renderSiteContacts();
  await renderManageSiteGuards();
  await loadSiteVehicles(activeSiteId);
  renderSiteVehicles();
}

// ---------------- Site contacts (site management personnel) ----------------
const CONTACT_ROLE_LABELS = {
  site_manager: 'Site Manager', facilities_manager: 'Facilities Manager',
  security_supervisor: 'Security Supervisor', emergency_contact: 'Emergency Contact',
  building_owner: 'Building Owner', other: 'Other'
};
async function loadSiteContactsFor(siteId){
  const { data, error } = await sb.from('site_contacts').select('*').eq('site_id', siteId).order('created_at');
  if (error){ showToast('Could not load site contacts', error.message, 'danger'); siteContacts = []; return; }
  siteContacts = (data || []).map(c => ({ id: c.id, name: c.name, role: c.role, phone: c.phone, email: c.email, incidentEmailDefault: !!c.incident_email_default }));
}

function renderSiteContacts(){
  const listEl = document.getElementById('siteContactsList');
  const isAdmin = profile.role === 'admin';
  document.getElementById('siteContactsAddWrap').style.display = isAdmin ? 'block' : 'none';

  listEl.innerHTML = siteContacts.length ? siteContacts.map(c => `
    <div class="site-contact-row">
      <div style="flex:1; min-width:0;">
        <div class="site-contact-name">${escapeHtmlForPrint(c.name)} <span class="site-contact-role">· ${CONTACT_ROLE_LABELS[c.role] || c.role}</span></div>
        <div class="result-meta" style="margin-top:2px;">${[c.phone, c.email].filter(Boolean).map(escapeHtmlForPrint).join(' · ') || '—'}</div>
      </div>
      ${isAdmin ? `<button class="del-btn" data-del-contact="${c.id}" aria-label="Remove contact"><i>&times;</i></button>` : ''}
    </div>
  `).join('') : '<div class="result-meta">No contacts added yet.</div>';

  listEl.querySelectorAll('[data-del-contact]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.delContact;
      const c = siteContacts.find(x => x.id === id);
      if (!confirm(`Remove ${c ? c.name : 'this contact'}?`)) return;
      const { error } = await sb.from('site_contacts').delete().eq('id', id);
      if (error){ showToast('Could not remove contact', error.message, 'danger'); return; }
      await loadSiteContactsFor(activeSiteId);
      renderSiteContacts();
    });
  });
}

document.getElementById('addSiteContactBtn').addEventListener('click', async () => {
  const name = document.getElementById('newContactName').value.trim();
  const role = document.getElementById('newContactRole').value;
  const phone = document.getElementById('newContactPhone').value.trim();
  const email = document.getElementById('newContactEmail').value.trim();
  if (!name || !role){ showToast('Name and role are required', '', 'warn'); return; }
  if (!activeSiteId){ showToast('Select a site first', '', 'warn'); return; }
  const { error } = await sb.from('site_contacts').insert({
    site_id: activeSiteId, name, role, phone: phone || null, email: email || null
  });
  if (error){ showToast('Could not add contact', error.message, 'danger'); return; }
  document.getElementById('newContactName').value = '';
  document.getElementById('newContactPhone').value = '';
  document.getElementById('newContactEmail').value = '';
  await loadSiteContactsFor(activeSiteId);
  renderSiteContacts();
});

