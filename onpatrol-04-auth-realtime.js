// ---------------- User management (admin only, via Edge Function) ----------------
let allUsers = [];

async function loadUsersAdmin(){
  const { data, error } = await sb.functions.invoke('admin-users', { body: { action: 'list' } });
  if (error || !data || data.error){
    showToast('Could not load users', await functionErrorMessage(data, error, 'Unknown error'), 'danger');
    return;
  }
  allUsers = data.users || [];
}

function renderUsersTable(){
  const body = document.getElementById('usersTableBody');
  if (!body) return;
  if (!allUsers.length){
    body.innerHTML = '<tr><td colspan="7" style="font-family:var(--sans); color:var(--muted);">No users yet.</td></tr>';
    return;
  }
  const searchEl = document.getElementById('userSearch');
  const q = (searchEl ? searchEl.value : '').toLowerCase().trim();
  const filtered = q ? allUsers.filter(u => {
    const site = sites.find(s => s.id === u.site_id);
    return (u.full_name || '').toLowerCase().includes(q)
      || (u.email || '').toLowerCase().includes(q)
      || (u.employee_number || '').toLowerCase().includes(q)
      || (u.phone || '').toLowerCase().includes(q)
      || (u.role || '').toLowerCase().includes(q)
      || (site ? site.name.toLowerCase().includes(q) : false);
  }) : allUsers;
  if (!filtered.length){
    body.innerHTML = '<tr><td colspan="7" style="font-family:var(--sans); color:var(--muted);">No users match.</td></tr>';
    return;
  }
  const sorted = filtered.slice().sort((a,b) => (a.full_name || a.email).localeCompare(b.full_name || b.email));
  body.innerHTML = sorted.map(u => {
    const site = sites.find(s => s.id === u.site_id);
    const isSelf = session && u.id === session.user.id;
    const safeLabel = escapeHtmlForPrint(u.full_name || u.email);
    return `
      <tr>
        <td style="font-family:var(--sans); font-weight:600;">${escapeHtmlForPrint(u.full_name || '—')}</td>
        <td>${u.role === 'guard' ? `<input type="text" data-emp-num="${u.id}" value="${escapeHtmlForPrint(u.employee_number || '')}" placeholder="—" style="width:90px; padding:5px 7px; font-size:11px;">` : '<span class="result-meta">—</span>'}</td>
        <td><input type="tel" data-phone="${u.id}" value="${escapeHtmlForPrint(u.phone || '')}" placeholder="—" style="width:120px; padding:5px 7px; font-size:11px;"></td>
        <td style="font-family:var(--sans); color:var(--muted);">${escapeHtmlForPrint(u.email)}</td>
        <td>${escapeHtmlForPrint(u.role || '—')}${u.deactivated ? ' <span class="st st-warn" style="margin-left:4px;">Deactivated</span>' : ''}</td>
        <td style="font-family:var(--sans);">${escapeHtmlForPrint(site ? site.name : '—')}</td>
        <td>${u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}</td>
        <td style="display:flex; gap:6px; flex-wrap:wrap;">
          <button class="btn" data-reset-pw="${u.id}" data-user-label="${safeLabel}" style="width:auto; padding:5px 10px; font-size:11px;">Reset password</button>
          ${u.role === 'guard' ? `<button class="btn" data-reset-face="${u.id}" data-user-label="${safeLabel}" style="width:auto; padding:5px 10px; font-size:11px;">Reset face</button>` : ''}
          ${isSelf ? '' : u.deactivated
            ? `<button class="btn" data-reactivate-user="${u.id}" data-user-label="${safeLabel}" style="width:auto; padding:5px 10px; font-size:11px;">Reactivate</button>`
            : `<button class="btn" data-deactivate-user="${u.id}" data-user-label="${safeLabel}" style="width:auto; padding:5px 10px; font-size:11px;">Deactivate</button>`}
          ${isSelf ? '' : `<button class="del-btn" data-del-user="${u.id}" data-user-label="${safeLabel}" aria-label="Delete user"><i>&times;</i></button>`}
        </td>
      </tr>
    `;
  }).join('');

  body.querySelectorAll('[data-emp-num]').forEach(input => {
    input.addEventListener('change', async () => {
      const val = input.value.trim();
      const { error } = await sb.from('profiles').update({ employee_number: val || null }).eq('id', input.dataset.empNum);
      if (error){ showToast('Could not save employee number', error.message, 'danger'); return; }
      const u = allUsers.find(x => x.id === input.dataset.empNum);
      if (u) u.employee_number = val || null;
      showToast('Employee number saved', '', 'success');
    });
  });

  body.querySelectorAll('[data-phone]').forEach(input => {
    input.addEventListener('change', async () => {
      const val = input.value.trim();
      if (val && !isValidPhone(val)){
        showToast('Could not save phone number', 'Enter a valid phone number (at least 9 digits), or leave it blank.', 'danger');
        const u = allUsers.find(x => x.id === input.dataset.phone);
        input.value = (u && u.phone) || '';
        return;
      }
      const { error } = await sb.from('profiles').update({ phone: val || null }).eq('id', input.dataset.phone);
      if (error){ showToast('Could not save phone number', error.message, 'danger'); return; }
      const u = allUsers.find(x => x.id === input.dataset.phone);
      if (u) u.phone = val || null;
      showToast('Phone number saved', '', 'success');
    });
  });

  body.querySelectorAll('[data-reset-face]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const label = btn.dataset.userLabel;
      if (!confirm(`Clear ${label}'s enrolled face? They'll enroll a new one the next time they clock in.`)) return;
      const { error } = await sb.from('profiles').update({ face_descriptor: null }).eq('id', btn.dataset.resetFace);
      if (error){ showToast('Could not reset face enrollment', error.message, 'danger'); return; }
      showToast('Face enrollment cleared', '', 'success');
    });
  });

  body.querySelectorAll('[data-del-user]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const label = btn.dataset.userLabel;
      if (!confirm(`Delete the account for "${label}"? This permanently removes their login and profile. This can't be undone.`)) return;
      btn.disabled = true;
      const { data, error } = await sb.functions.invoke('admin-users', { body: { action: 'delete', user_id: btn.dataset.delUser } });
      if (error || !data || data.error){
        // A blocked delete comes back as a non-2xx response, so its JSON body lives on the
        // error, not on `data` - read it once, ourselves, so we can also see has_history
        // (functionErrorMessage reads the same body for its fallback path, so it must not
        // run first, or there'd be nothing left to read here).
        let body = data && data.error ? data : null;
        if (!body && error && error.context && typeof error.context.json === 'function'){
          try{ body = await error.context.json(); }catch(e){}
        }
        const msg = (body && body.error) || (error && error.message) || 'Unknown error';
        const hasHistory = !!(body && body.has_history);
        if (hasHistory && confirm(msg + '\n\nDeactivate them now instead?')){
          const r2 = await sb.functions.invoke('admin-users', { body: { action: 'deactivate', user_id: btn.dataset.delUser } });
          if (r2.error || !r2.data || r2.data.error){
            showToast('Could not deactivate user', await functionErrorMessage(r2.data, r2.error, 'Unknown error'), 'danger');
          } else {
            showToast('User deactivated', `${label} can no longer sign in. Their records are unchanged.`, 'success');
            await loadUsersAdmin(); renderUsersTable();
          }
        } else {
          showToast('Could not delete user', msg, 'danger');
        }
        btn.disabled = false;
        return;
      }
      showToast('User deleted', `${label} was removed.`, 'success');
      await loadUsersAdmin();
      renderUsersTable();
    });
  });

  body.querySelectorAll('[data-deactivate-user]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const label = btn.dataset.userLabel;
      if (!confirm(`Deactivate "${label}"? They won't be able to sign in until reactivated. Nothing else changes - their history stays exactly as it is.`)) return;
      btn.disabled = true;
      const { data, error } = await sb.functions.invoke('admin-users', { body: { action: 'deactivate', user_id: btn.dataset.deactivateUser } });
      btn.disabled = false;
      if (error || !data || data.error){
        showToast('Could not deactivate user', await functionErrorMessage(data, error, 'Unknown error'), 'danger');
        return;
      }
      showToast('User deactivated', `${label} can no longer sign in.`, 'success');
      await loadUsersAdmin();
      renderUsersTable();
    });
  });

  body.querySelectorAll('[data-reactivate-user]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const label = btn.dataset.userLabel;
      btn.disabled = true;
      const { data, error } = await sb.functions.invoke('admin-users', { body: { action: 'reactivate', user_id: btn.dataset.reactivateUser } });
      btn.disabled = false;
      if (error || !data || data.error){
        showToast('Could not reactivate user', await functionErrorMessage(data, error, 'Unknown error'), 'danger');
        return;
      }
      showToast('User reactivated', `${label} can sign in again.`, 'success');
      await loadUsersAdmin();
      renderUsersTable();
    });
  });

  body.querySelectorAll('[data-reset-pw]').forEach(btn => {
    btn.addEventListener('click', () => openResetPasswordModal(btn.dataset.resetPw, btn.dataset.userLabel));
  });
}

let resetPasswordUserId = null;

function openResetPasswordModal(userId, label){
  resetPasswordUserId = userId;
  document.getElementById('resetPasswordSub').textContent = `Setting a new password for ${label}.`;
  document.getElementById('resetPasswordError').style.display = 'none';
  document.getElementById('resetPasswordNew').value = '';
  document.getElementById('resetPasswordConfirm').value = '';
  document.getElementById('resetPasswordModalBg').classList.add('show');
}

document.getElementById('resetPasswordCancelBtn').addEventListener('click', () => {
  document.getElementById('resetPasswordModalBg').classList.remove('show');
});

document.getElementById('resetPasswordSubmitBtn').addEventListener('click', async () => {
  const pw = document.getElementById('resetPasswordNew').value;
  const confirmPw = document.getElementById('resetPasswordConfirm').value;
  const errEl = document.getElementById('resetPasswordError');
  errEl.style.display = 'none';
  if (pw.length < 6){
    errEl.textContent = 'Password must be at least 6 characters.';
    errEl.style.display = 'block';
    return;
  }
  if (pw !== confirmPw){
    errEl.textContent = 'Passwords do not match.';
    errEl.style.display = 'block';
    return;
  }
  const btn = document.getElementById('resetPasswordSubmitBtn');
  btn.disabled = true;
  const { data, error } = await sb.functions.invoke('admin-users', { body: { action: 'set_password', user_id: resetPasswordUserId, new_password: pw } });
  btn.disabled = false;
  if (error || !data || data.error){
    errEl.textContent = await functionErrorMessage(data, error, 'Unknown error');
    errEl.style.display = 'block';
    return;
  }
  document.getElementById('resetPasswordModalBg').classList.remove('show');
  showToast('Password updated', '', 'success');
});

// ---------------- Auth ----------------
let authMode = 'signin';
let authSignupRole = 'guard';

// ---- welcome page (where the email confirmation link lands) ----
const WELCOME_MODE = new URLSearchParams(window.location.search).get('welcome') === '1';
function welcomeRedirectUrl(){
  return window.location.origin + window.location.pathname.replace(/index\.html$/, '') + '?welcome=1';
}
async function showWelcomePage(){
  const gate = document.getElementById('welcomeGate');
  const logo = document.querySelector('.brand-logo');
  if (logo) document.getElementById('welcomeLogo').src = logo.getAttribute('src');
  const titleEl = document.getElementById('welcomeTitle');
  const companyEl = document.getElementById('welcomeCompany');
  const msgEl = document.getElementById('welcomeMsg');
  let msg = 'Your email is confirmed. Sign in to get started.';

  const linkError = /error=|error_description=/.test(window.location.hash);
  if (linkError){
    titleEl.textContent = 'This link has expired';
    msg = 'This confirmation link has expired or was already used. If you have already confirmed your email, just sign in.';
  } else {
    const r = await sb.auth.getSession().catch(() => ({ data: null }));
    const sess = r && r.data && r.data.session;
    const meta = (sess && sess.user && sess.user.user_metadata) || {};
    const orgName = String(meta.org_name || '').trim();
    if (sess && orgName){
      // First admin: the company they typed at sign-up is created now (safe to repeat: it does nothing if they already have one).
      const { data: prof } = await sb.from('profiles').select('org_id').eq('id', sess.user.id).single();
      let ready = !!(prof && prof.org_id);
      clearPendingCompany();   // first, so a second open tab of the app does not try to create it as well
      if (prof && !prof.org_id){
        const { data: newOrgId, error: coErr } = await sb.rpc('create_organization', { p_org_name: orgName });
        if (coErr) ready = false;
        else if (newOrgId) ready = true;
        else {
          // No new company came back: another tab may have just created it. Check.
          const { data: again } = await sb.from('profiles').select('org_id').eq('id', sess.user.id).single();
          ready = !!(again && again.org_id);
        }
      }
      companyEl.textContent = orgName;
      companyEl.style.display = 'block';
      msg = ready
        ? "Your email is confirmed and your company is set up. You're its first admin — sign in to invite your team."
        : 'Your email is confirmed, but we couldn\'t set up the company automatically. Sign in, tap "Have an admin code?", then "Create your company instead".';
    } else if (sess){
      const first = String(meta.full_name || '').trim().split(/\s+/)[0];
      if (first) companyEl.textContent = first, companyEl.style.display = 'block';
    }
  }
  msgEl.textContent = msg;
  gate.classList.add('show');
}
document.getElementById('welcomeBackBtn').addEventListener('click', async () => {
  try{ history.replaceState(null, '', window.location.pathname); }catch(e){}
  await sb.auth.signOut().catch(() => {});
  window.location.replace(window.location.pathname);
});

// ---- company creation that has to wait for email confirmation ----
const PENDING_COMPANY_KEY = 'onpatrol_pending_company';
function savePendingCompany(email, orgName){
  try{ localStorage.setItem(PENDING_COMPANY_KEY, JSON.stringify({ email: String(email).toLowerCase(), orgName, at: Date.now() })); }catch(e){}
}
function readPendingCompany(){
  try{
    const v = JSON.parse(localStorage.getItem(PENDING_COMPANY_KEY) || 'null');
    if (!v || !v.orgName || Date.now() - v.at > 14 * 24 * 60 * 60 * 1000) return null;
    return v;
  }catch(e){ return null; }
}
function clearPendingCompany(){ try{ localStorage.removeItem(PENDING_COMPANY_KEY); }catch(e){} }
let notificationInterval = null;
let notifSweepInterval = null;
let alertPollInterval = null;
let livePolling = false;
let notifChannelStatus = 'idle';

function showAuthGate(message){
  document.getElementById('authGate').classList.add('show');
  document.getElementById('userBadge').style.display = 'none';
  if (message){
    const errEl = document.getElementById('authError');
    errEl.textContent = message;
    errEl.style.color = 'var(--danger)';
    errEl.style.display = 'block';
  }
}

function setAuthSignupRole(role){
  authSignupRole = role;
  document.getElementById('authRoleGuardBtn').classList.toggle('active', role === 'guard');
  document.getElementById('authRoleAdminBtn').classList.toggle('active', role === 'admin');
  document.getElementById('authRoleControllerBtn').classList.toggle('active', role === 'controller');
  document.getElementById('authInviteWrap').style.display = (authMode === 'signup' && role === 'admin') ? 'block' : 'none';
  document.getElementById('authControllerCodeWrap').style.display = (authMode === 'signup' && role === 'controller') ? 'block' : 'none';
  document.getElementById('authSiteCodeWrap').style.display = (authMode === 'signup' && role === 'guard') ? 'block' : 'none';
  if (role !== 'admin') document.getElementById('authInviteCode').value = '';
  if (role !== 'controller') document.getElementById('authControllerCode').value = '';
  if (role !== 'guard') document.getElementById('authSiteCode').value = '';
}

// Two ways to sign up as an admin: redeem a code from an existing company,
// or — for the very first person at a brand-new client — create the company
// itself and become its first admin automatically.
let authCreatingOrg = false;
function setAuthAdminMode(creatingOrg){
  authCreatingOrg = creatingOrg;
  document.getElementById('authInviteCodeSub').style.display = creatingOrg ? 'none' : 'block';
  document.getElementById('authCreateOrgSub').style.display = creatingOrg ? 'block' : 'none';
  document.getElementById('authAdminModeToggle').textContent = creatingOrg
    ? 'Joining an existing company instead? Use an invite code'
    : 'First admin? Create your company instead';
  if (creatingOrg) document.getElementById('authInviteCode').value = '';
  else document.getElementById('authOrgName').value = '';
}
document.getElementById('authAdminModeToggle').addEventListener('click', e => {
  e.preventDefault();
  setAuthAdminMode(!authCreatingOrg);
});

function setAuthMode(mode){
  authMode = mode;
  document.getElementById('authFullNameWrap').style.display = mode === 'signup' ? 'block' : 'none';
  document.getElementById('authRoleWrap').style.display = mode === 'signup' ? 'block' : 'none';
  setAuthAdminMode(false);
  setAuthSignupRole('guard');
  document.getElementById('authSubmitBtn').textContent = mode === 'signup' ? 'Create account' : 'Sign in';
  document.getElementById('authModeToggle').textContent = mode === 'signup' ? 'Already have an account? Sign in' : 'Need an account? Sign up';
  document.getElementById('authError').style.display = 'none';
}

document.getElementById('authModeToggle').addEventListener('click', e => {
  e.preventDefault();
  setAuthMode(authMode === 'signin' ? 'signup' : 'signin');
});

document.getElementById('authRoleGuardBtn').addEventListener('click', () => setAuthSignupRole('guard'));
document.getElementById('authRoleAdminBtn').addEventListener('click', () => setAuthSignupRole('admin'));
document.getElementById('authRoleControllerBtn').addEventListener('click', () => setAuthSignupRole('controller'));

document.getElementById('authSubmitBtn').addEventListener('click', async () => {
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const errEl = document.getElementById('authError');
  errEl.style.display = 'none';
  if (!email || !password){
    errEl.textContent = 'Email and password are both required.';
    errEl.style.color = 'var(--danger)';
    errEl.style.display = 'block';
    return;
  }
  if (authMode === 'signup' && !document.getElementById('authPhone').value.trim()){
    errEl.textContent = 'A phone number is required so admins and controllers can reach you.';
    errEl.style.color = 'var(--danger)';
    errEl.style.display = 'block';
    return;
  }
  if (authMode === 'signup' && !isValidPhone(document.getElementById('authPhone').value)){
    errEl.textContent = 'Enter a valid phone number (at least 9 digits).';
    errEl.style.color = 'var(--danger)';
    errEl.style.display = 'block';
    return;
  }
  if (authMode === 'signup' && authSignupRole === 'admin' && !authCreatingOrg && !document.getElementById('authInviteCode').value.trim()){
    errEl.textContent = 'An admin invite code is required to sign up as an admin.';
    errEl.style.color = 'var(--danger)';
    errEl.style.display = 'block';
    return;
  }
  if (authMode === 'signup' && authSignupRole === 'admin' && authCreatingOrg && !document.getElementById('authOrgName').value.trim()){
    errEl.textContent = 'A company name is required to create your company.';
    errEl.style.color = 'var(--danger)';
    errEl.style.display = 'block';
    return;
  }
  if (authMode === 'signup' && authSignupRole === 'controller' && !document.getElementById('authControllerCode').value.trim()){
    errEl.textContent = 'A controller invite code is required to sign up as a controller.';
    errEl.style.color = 'var(--danger)';
    errEl.style.display = 'block';
    return;
  }
  if (authMode === 'signup' && authSignupRole === 'guard' && !document.getElementById('authSiteCode').value.trim()){
    errEl.textContent = 'A site code is required to sign up as a guard.';
    errEl.style.color = 'var(--danger)';
    errEl.style.display = 'block';
    return;
  }
  const btn = document.getElementById('authSubmitBtn');
  btn.disabled = true;
  try{
    if (authMode === 'signup'){
      const fullName = document.getElementById('authFullName').value.trim();
      const phone = document.getElementById('authPhone').value.trim();
      const wantsAdmin = authSignupRole === 'admin';
      const wantsController = authSignupRole === 'controller';
      const inviteCode = document.getElementById('authInviteCode').value.trim();
      const orgName = document.getElementById('authOrgName').value.trim();
      const controllerCode = document.getElementById('authControllerCode').value.trim();
      const siteCode = document.getElementById('authSiteCode').value.trim();
      const creatingCompany = wantsAdmin && authCreatingOrg;
      const { data, error } = await sb.auth.signUp({ email, password, options: {
        emailRedirectTo: welcomeRedirectUrl(),
        data: { full_name: fullName, phone, signup_role: authSignupRole, org_name: creatingCompany ? orgName : undefined }
      } });
      if (error) throw error;

      if (data.session){
        // Belt-and-suspenders: write phone straight to the profile row too, in case
        // the account-creation trigger only reads full_name from signup metadata.
        await sb.from('profiles').update({ phone }).eq('id', data.session.user.id);
      }

      if (wantsAdmin && authCreatingOrg && data.session){
        const { data: newOrgId, error: orgErr } = await sb.rpc('create_organization', { p_org_name: orgName });
        if (orgErr || !newOrgId){
          showToast('Signed up as guard', 'Could not create the company — your account was created with guard access instead.', 'warn');
        } else {
          showToast('Company created', "You're the first admin — invite your team from Admin invites.", 'success');
        }
      } else if (wantsAdmin && data.session){
        const { data: claimed, error: claimErr } = await sb.rpc('claim_admin', { p_code: inviteCode });
        if (claimErr || !claimed){
          showToast('Signed up as guard', 'That invite code was invalid or already used — your account was created with guard access instead.', 'warn');
        } else {
          showToast('Admin access granted', '', 'success');
        }
      } else if (wantsController && data.session){
        const { data: claimed, error: claimErr } = await sb.rpc('claim_controller', { p_code: controllerCode });
        if (claimErr || !claimed){
          showToast('Signed up as guard', 'That invite code was invalid or already used — your account was created with guard access instead.', 'warn');
        } else {
          showToast('Controller access granted', '', 'success');
        }
      } else if (!wantsAdmin && !wantsController && data.session){
        const { data: joinedSiteId, error: joinErr } = await sb.rpc('join_site', { p_site_code: siteCode });
        if (joinErr || !joinedSiteId){
          showToast('Account created', 'That site code was invalid — use "Join a site" after signing in to try again.', 'warn');
        } else {
          showToast('Joined site', '', 'success');
        }
      }
      if (!data.session){
        // Email confirmation is on, so there is no login yet and the company cannot be created yet.
        // Remember the company name; it is created automatically at the first sign-in on this device.
        if (wantsAdmin && authCreatingOrg) savePendingCompany(email, orgName);
        errEl.textContent = wantsAdmin && authCreatingOrg
          ? `Account created — tap the confirmation link in your email. "${orgName}" is set up when you confirm, then you can sign in.`
          : wantsAdmin
          ? 'Account created — check your email to confirm it, then sign in and use "Claim admin access" with your invite code.'
          : wantsController
          ? 'Account created — check your email to confirm it, then sign in and use "Claim controller access" with your invite code.'
          : 'Account created — check your email to confirm it, then sign in and use "Join a site" with your site code.';
        errEl.style.color = 'var(--text)';
        errEl.style.display = 'block';
        setAuthMode('signin');
      }
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
  } catch(err){
    errEl.textContent = err.message;
    errEl.style.color = 'var(--danger)';
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('signOutBtn').addEventListener('click', async () => {
  if (notificationInterval){ clearInterval(notificationInterval); notificationInterval = null; }
  if (notifSweepInterval){ clearInterval(notifSweepInterval); notifSweepInterval = null; }
  if (alertPollInterval){ clearInterval(alertPollInterval); alertPollInterval = null; }
  await sb.auth.signOut();
});

let claimAdminCreatingOrg = false;
function setClaimAdminMode(creatingOrg){
  claimAdminCreatingOrg = creatingOrg;
  document.getElementById('claimAdminCodeSub').style.display = creatingOrg ? 'none' : 'block';
  document.getElementById('claimAdminCreateOrgSub').style.display = creatingOrg ? 'block' : 'none';
  document.getElementById('claimAdminModeToggle').textContent = creatingOrg
    ? 'Joining an existing company instead? Use an invite code'
    : 'First admin? Create your company instead';
}
document.getElementById('claimAdminModeToggle').addEventListener('click', e => {
  e.preventDefault();
  setClaimAdminMode(!claimAdminCreatingOrg);
});

document.getElementById('claimAdminBtn').addEventListener('click', () => {
  document.getElementById('claimAdminError').style.display = 'none';
  document.getElementById('claimAdminCode').value = '';
  document.getElementById('claimAdminOrgName').value = '';
  setClaimAdminMode(false);
  document.getElementById('claimAdminModalBg').classList.add('show');
});

document.getElementById('claimAdminSubmitBtn').addEventListener('click', async () => {
  const errEl = document.getElementById('claimAdminError');
  errEl.style.display = 'none';
  const btn = document.getElementById('claimAdminSubmitBtn');
  if (claimAdminCreatingOrg){
    const orgName = document.getElementById('claimAdminOrgName').value.trim();
    if (!orgName){
      errEl.textContent = 'Enter a company name.';
      errEl.style.display = 'block';
      return;
    }
    btn.disabled = true;
    try{
      const { data: newOrgId, error } = await sb.rpc('create_organization', { p_org_name: orgName });
      if (error || !newOrgId){
        errEl.textContent = "Couldn't create the company — your account may already belong to one.";
        errEl.style.display = 'block';
        return;
      }
      document.getElementById('claimAdminModalBg').classList.remove('show');
      showToast('Company created', "You're the first admin — invite your team from Admin invites.", 'success');
      await loadProfileAndApp();
    } catch(err){
      errEl.textContent = err.message;
      errEl.style.display = 'block';
    } finally {
      btn.disabled = false;
    }
    return;
  }
  const code = document.getElementById('claimAdminCode').value.trim();
  if (!code){
    errEl.textContent = 'Enter an invite code.';
    errEl.style.display = 'block';
    return;
  }
  btn.disabled = true;
  try{
    const { data: claimed, error } = await sb.rpc('claim_admin', { p_code: code });
    if (error || !claimed){
      errEl.textContent = 'That invite code is invalid or already used.';
      errEl.style.display = 'block';
      return;
    }
    document.getElementById('claimAdminModalBg').classList.remove('show');
    showToast('Admin access granted', '', 'success');
    await loadProfileAndApp();
  } catch(err){
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('claimControllerBtn').addEventListener('click', () => {
  document.getElementById('claimControllerError').style.display = 'none';
  document.getElementById('claimControllerCode').value = '';
  document.getElementById('claimControllerModalBg').classList.add('show');
});
document.getElementById('claimControllerCancelBtn').addEventListener('click', () => {
  document.getElementById('claimControllerModalBg').classList.remove('show');
});

document.getElementById('claimControllerSubmitBtn').addEventListener('click', async () => {
  const code = document.getElementById('claimControllerCode').value.trim();
  const errEl = document.getElementById('claimControllerError');
  errEl.style.display = 'none';
  if (!code){
    errEl.textContent = 'Enter an invite code.';
    errEl.style.display = 'block';
    return;
  }
  const btn = document.getElementById('claimControllerSubmitBtn');
  btn.disabled = true;
  try{
    const { data: claimed, error } = await sb.rpc('claim_controller', { p_code: code });
    if (error || !claimed){
      errEl.textContent = 'That invite code is invalid or already used.';
      errEl.style.display = 'block';
      return;
    }
    document.getElementById('claimControllerModalBg').classList.remove('show');
    showToast('Controller access granted', '', 'success');
    await loadProfileAndApp();
  } catch(err){
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
  }
});

function openJoinSiteModal(){
  document.getElementById('joinSiteError').style.display = 'none';
  document.getElementById('joinSiteCode').value = '';
  document.getElementById('joinSiteModalBg').classList.add('show');
}

document.getElementById('joinSiteBtn').addEventListener('click', openJoinSiteModal);
document.getElementById('guardJoinSiteBtn').addEventListener('click', openJoinSiteModal);
document.getElementById('joinSiteCancelBtn').addEventListener('click', () => {
  document.getElementById('joinSiteModalBg').classList.remove('show');
});

document.getElementById('joinSiteSubmitBtn').addEventListener('click', async () => {
  const code = document.getElementById('joinSiteCode').value.trim();
  const errEl = document.getElementById('joinSiteError');
  errEl.style.display = 'none';
  if (!code){
    errEl.textContent = 'Enter a site code.';
    errEl.style.display = 'block';
    return;
  }
  const btn = document.getElementById('joinSiteSubmitBtn');
  btn.disabled = true;
  try{
    const { data: joinedSiteId, error } = await sb.rpc('join_site', { p_site_code: code });
    if (error || !joinedSiteId){
      errEl.textContent = 'That site code is invalid, or you already belong to a site.';
      errEl.style.display = 'block';
      return;
    }
    document.getElementById('joinSiteModalBg').classList.remove('show');
    showToast('Joined site', '', 'success');
    await loadProfileAndApp();
  } catch(err){
    errEl.textContent = err.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
  }
});

async function loadProfileAndApp(){
  let prof = null, error = null;
  if (session.offline){
    prof = await offlineCachedProfile();
    if (!prof){ showAuthGate('No connection, and this phone has no saved data for you yet. Sign in once with a connection.'); return; }
  } else {
    const r = await withTimeout(sb.from('profiles').select('*').eq('id', session.user.id).single(), 12000);
    prof = r.data; error = r.error;
    if ((error || !prof) && OFFLINE_ENABLED && isNetworkFailure(error)){
      prof = await offlineCachedProfile();
      if (prof){ offlineMode = true; serverReachable = false; }
    }
  }
  if (!prof){
    showAuthGate('Could not load your profile — try signing in again.');
    return;
  }
  profile = prof;
  if (!offlineMode) offlineSnapSavedAt = Date.now();

  // A first admin who had to confirm their email before signing in: create the company they asked for now.
  const pendingCo = readPendingCompany();
  if (pendingCo && !profile.org_id && !session.offline && session.user.email && pendingCo.email === session.user.email.toLowerCase()){
    clearPendingCompany();
    const { data: newOrgId, error: coErr } = await sb.rpc('create_organization', { p_org_name: pendingCo.orgName });
    if (!coErr){
      // newOrgId is empty when the company already exists (created a moment ago from another tab) - carry on quietly.
      const { data: fresh } = await sb.from('profiles').select('*').eq('id', session.user.id).single();
      if (fresh) profile = fresh;
      if (newOrgId) showToast('Company created', `${pendingCo.orgName} is set up and you are its first admin. Invite your team from Admin invites.`, 'success');
    } else {
      showToast('Could not create the company', 'Tap "Have an admin code?" then "Create your company instead".', 'warn');
    }
  }
  guardSiteId = profile.site_id || null;

  document.getElementById('authGate').classList.remove('show');
  document.getElementById('userBadge').style.display = 'flex';
  document.getElementById('userBadgeText').innerHTML =
    `${escapeHtmlForPrint(profile.full_name || session.user.email)} <span class="role-pill">${escapeHtmlForPrint(profile.role)}</span>`;

  const guardTabBtn = document.getElementById('guardTabBtn');
  const adminTabBtn = document.getElementById('adminTabBtn2');
  const controllerTabBtn = document.getElementById('controllerTabBtn');
  const claimAdminBtn = document.getElementById('claimAdminBtn');
  const claimControllerBtn = document.getElementById('claimControllerBtn');
  const joinSiteBtn = document.getElementById('joinSiteBtn');
  const signOutBtn = document.getElementById('signOutBtn');

  if (profile.role === 'admin'){
    guardTabBtn.style.display = '';
    adminTabBtn.style.display = '';
    controllerTabBtn.style.display = 'none';
    claimAdminBtn.style.display = 'none';
    claimControllerBtn.style.display = 'none';
    joinSiteBtn.style.display = 'none';
    signOutBtn.style.display = '';
  } else if (profile.role === 'controller'){
    guardTabBtn.style.display = 'none';
    adminTabBtn.style.display = 'none';
    controllerTabBtn.style.display = '';
    claimAdminBtn.style.display = 'none';
    claimControllerBtn.style.display = 'none';
    joinSiteBtn.style.display = 'none';
    signOutBtn.style.display = '';
    controllerTabBtn.click();
  } else {
    guardTabBtn.style.display = '';
    adminTabBtn.style.display = 'none';
    controllerTabBtn.style.display = 'none';
    // Guards work off a shared/kiosk-style device — no self-service admin/controller
    // claim codes and no sign-out control in their UI.
    claimAdminBtn.style.display = 'none';
    claimControllerBtn.style.display = 'none';
    joinSiteBtn.style.display = guardSiteId ? 'none' : '';
    signOutBtn.style.display = 'none';
    guardTabBtn.click();
  }

  const hasSite = profile.role !== 'guard' || !!guardSiteId;
  document.getElementById('guardNoSiteGate').style.display = hasSite ? 'none' : 'block';
  document.getElementById('guardMainContent').style.display = hasSite ? '' : 'none';   // '' lets the stylesheet decide (flex on a guard's phone)

  // Platform tab is separate from the role switch above — it's not a
  // client-facing role at all, just a hidden extra flag on top of whatever
  // role this account already has within its own org.
  const platformTabBtn = document.getElementById('platformTabBtn');
  try{
    const { data: isPlatformAdmin } = offlineMode ? { data: false } : await withTimeout(sb.rpc('is_platform_admin'), 8000);
    platformTabBtn.style.display = isPlatformAdmin ? '' : 'none';
  } catch(e){
    platformTabBtn.style.display = 'none';
  }

  await loadAllData();
  renderAll();
  subscribeRealtime();
  loadCompanyName();
  auditSignIn();
  loadControllerAuditAccess();
  if (!notificationInterval){
    notificationInterval = setInterval(() => {
      checkGuardNotifications();
      renderGuardPatrolCard();
      renderPatrolsAdmin();
    }, 1000);
  }
  if (!notifSweepInterval && (profile.role === 'admin' || profile.role === 'controller')){
    sweepPatrolInstanceNotifications();
    notifSweepInterval = setInterval(() => {
      sweepPatrolInstanceNotifications();
      sweepAutoClearGreens();
      renderNotifications();
      renderLog(); // re-filters to the current shift, in case the shift boundary just passed
      renderCoverageGrid('coverageGridAdmin'); // so Day/Night tiles swap automatically at shift boundaries
      renderCoverageGrid('coverageGridCtrl');
      if (document.getElementById('admin-siteoverview')?.classList.contains('active')) renderSiteOverview('admin');
      if (document.getElementById('ctrl-siteoverview')?.classList.contains('active')) renderSiteOverview('ctrl');
    }, 30000);
  }
  // Fast lane: every 5s raise due alerts and pull in anything new — controllers should
  // never have to refresh to see an alert.
  if (!alertPollInterval && (profile.role === 'admin' || profile.role === 'controller')){
    alertPollInterval = setInterval(pollLiveData, 5000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pollLiveData(); });
    window.addEventListener('online', pollLiveData);
  }
}

function initAuth(){
  sb.auth.getSession().then(async ({ data: { session: s } }) => {
    session = s;
    if (WELCOME_MODE){ showWelcomePage(); return; }
    if (!session && OFFLINE_ENABLED){
      // No valid login token AND no connection: let a guard who has used this phone before carry on from the saved copy.
      const snap = await OFF.get('snapshot');
      if (snap && snap.userId && (navigator.onLine === false || !(await offlinePing()))){
        session = { user: { id: snap.userId, email: snap.email }, offline: true };
        offlineMode = true; serverReachable = false;
      }
    }
    if (session) loadProfileAndApp();
    else showAuthGate();
  });
  sb.auth.onAuthStateChange((event, s2) => {
    if (s2 || !(session && session.offline)) session = s2;
    if (event === 'SIGNED_IN' && s2 && !WELCOME_MODE && (!profile || profile.id !== s2.user.id)) loadProfileAndApp();
    if (event === 'SIGNED_OUT'){
      profile = null;
      // Signing out removes the face data kept on the phone (anything still waiting to be sent is kept).
      Promise.all([OFF.del('snapshot'), OFF.del('faceRoster')]).then(() => window.location.reload(), () => window.location.reload());
    }
  });
}

// ---------------- Whether this company lets controllers see the audit trail ----------------
async function loadControllerAuditAccess(){
  const navBtn = document.getElementById('ctrlAuditNavBtn');
  if (!profile || !profile.org_id || profile.role !== 'controller'){ if (navBtn) navBtn.style.display = 'none'; return; }
  if (offlineKnownDown()) return;
  const r = await withTimeout(sb.from('organizations').select('controller_audit_access').eq('id', profile.org_id).single(), 8000);
  controllerAuditAccess = !!(r.data && r.data.controller_audit_access);
  if (navBtn) navBtn.style.display = controllerAuditAccess ? '' : 'none';
}

// ---------------- Company name shown next to the logo ----------------
let companyName = '';
async function loadCompanyName(){
  const el = document.getElementById('ghCompany');
  if (!el) return;
  if (!profile || !profile.org_id){ el.hidden = true; el.textContent = ''; return; }
  if (!offlineKnownDown()){
    const r = await withTimeout(sb.from('organizations').select('name').eq('id', profile.org_id).single(), 8000);
    if (r.data && r.data.name){ companyName = r.data.name; offlineSnapshotSoon(); }
  }
  el.textContent = companyName;
  el.title = companyName;
  el.hidden = !companyName;
}

// ---------------- Realtime ----------------
let realtimeChannel = null;
let notificationsChannel = null;
function subscribeRealtime(){
  if (realtimeChannel){ sb.removeChannel(realtimeChannel); realtimeChannel = null; }
  // Guards only subscribe to their own site(s) — otherwise every scan anywhere would be
  // pushed to (and permission-checked for) every phone on the estate.
  const scanFeed = { event: 'INSERT', schema: 'public', table: 'scans' };
  const scopeIds = scanScopeSiteIds();
  let listenToScans = true;
  if (scopeIds){
    if (!scopeIds.length) listenToScans = false;
    else scanFeed.filter = scopeIds.length === 1 ? `site_id=eq.${scopeIds[0]}` : `site_id=in.(${scopeIds.join(',')})`;
  }
  realtimeChannel = sb.channel('scans-live')
    .on('postgres_changes', scanFeed, payload => {
      if (!listenToScans) return;
      const record = rowToScan(payload.new);
      if (!scans.some(s => s.id === record.id)){
        scans.push(record);
        scans.sort((a,b) => a.timestamp - b.timestamp);
        renderStats();
        renderLog();
        renderGuardPatrolCard();
        renderPatrolsAdmin();
      }
    })
    .subscribe();

  if (notificationsChannel){ sb.removeChannel(notificationsChannel); notificationsChannel = null; }
  if (profile && (profile.role === 'admin' || profile.role === 'controller')){
    notificationsChannel = sb.channel('notifications-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'patrol_notifications' }, payload => {
        // A panic alert rings the dashboard the instant it arrives, before
        // even waiting on the reload below — this is the one alert type
        // that must not depend on someone happening to be looking at the
        // screen right when it comes in.
        if (payload.eventType === 'INSERT' && payload.new && payload.new.kind === 'panic' && !seenNotifIds.has(payload.new.id)){
          seenNotifIds.add(payload.new.id);
          SOUND.panic();
          showToast('Panic alert', payload.new.title + (sitePhoneOf(payload.new.site_id) ? ' · Site phone ' + cleanPhone(sitePhoneOf(payload.new.site_id)) : ''), 'danger');
        }
        scheduleNotifReload();
      })
      .subscribe(status => { notifChannelStatus = status; });
  }
}

