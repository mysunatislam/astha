// Authentication establishes the account namespace before companion memory can load/sync.
(function () {
  let mode = 'signup';
  let booted = false;
  let sessionGeneration = 0;
  let logoutPending = false;
  let currentAccount = null;
  let gateOpener = null;
  const LAST_ACCOUNT = 'astha.last_account.v2';
  const PENDING_LOGOUT = 'astha.logout_pending.v2';
  const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
  const text = (en, bn) => typeof uiLang !== 'undefined' && uiLang === 'bn' ? bn : en;
  window.ASTHA_ACCOUNT_ID = null;
  window.ASTHA_LOCAL_ACCOUNT_ID = null;
  // null: no verified session. false: a guest created on first start. true: phone and passcode.
  window.ASTHA_ACCOUNT_REGISTERED = null;
  function pendingLogout() {
    try { return logoutPending || localStorage.getItem(PENDING_LOGOUT) === '1'; } catch (e) { return logoutPending; }
  }

  async function authFetch(path, options = {}) {
    return fetch(apiUrl(path), { ...options, credentials: 'include', signal: deadlineSignal(5000) });
  }
  window.ASTHA_CLEAR_ACCOUNT = function ({ logout = false } = {}) {
    if (typeof AsthaObservationMemory !== 'undefined') AsthaObservationMemory.reset();
    // The next person to use this phone must not inherit a connected camera.
    if (typeof AsthaCameraKit !== 'undefined') AsthaCameraKit.accountCleared();
    sessionGeneration += 1;
    if (logout) logoutPending = true;
    try { localStorage.removeItem(LAST_ACCOUNT); if (logout) localStorage.setItem(PENDING_LOGOUT, '1'); } catch (e) {}
    window.ASTHA_ACCOUNT_ID = null;
    window.ASTHA_LOCAL_ACCOUNT_ID = null;
    if (typeof refreshOwnerContext === 'function') refreshOwnerContext();
    // The next person to use this phone must not inherit the setup answers.
    if (logout && typeof AsthaExperience !== 'undefined') AsthaExperience.accountCleared();
    if (typeof LocalStore !== 'undefined') { clearTimeout(LocalStore.timer); LocalStore.loadedKey = null; }
    if (typeof state !== 'undefined') {
      state.memory = []; state.spatialHome = []; state.log = [];
      if (typeof renderMemory === 'function') renderMemory();
      if (typeof renderSpatialLayout === 'function') renderSpatialLayout();
      if (typeof renderLog === 'function') renderLog();
    }
  };

  function setAuthTab(next) {
    mode = next === 'login' ? 'login' : 'signup';
    document.getElementById('auth-tab-signup').setAttribute('aria-pressed', mode === 'signup');
    document.getElementById('auth-tab-login').setAttribute('aria-pressed', mode === 'login');
    document.getElementById('auth-name-field').hidden = mode === 'login';
    document.getElementById('auth-name').required = mode === 'signup';
    document.getElementById('auth-passcode').setAttribute('autocomplete', mode === 'signup' ? 'new-password' : 'current-password');
    document.getElementById('auth-submit').textContent = mode === 'signup' ? text('Create my account', 'অ্যাকাউন্ট তৈরি করুন') : text('Log in', 'প্রবেশ করুন');
    document.getElementById('auth-status').textContent = '';
  }
  window.setAuthTab = setAuthTab;

  // The app starts as a guest so nobody has to type before using it. The same dialog is
  // opened from preferences to register that guest account or to sign in to an existing one.
  function setBackgroundInert(inert) {
    if (typeof document.querySelectorAll !== 'function') return;
    for (const el of document.querySelectorAll('body > header, body > main')) {
      if (inert) el.setAttribute('inert', ''); else el.removeAttribute('inert');
    }
  }
  function renderAccount() {
    const registered = Boolean(currentAccount && currentAccount.phone);
    window.ASTHA_ACCOUNT_REGISTERED = currentAccount ? registered : null;
    const row = document.getElementById('account-row');
    if (row) row.textContent = !currentAccount ? text('Local mode. Account sync is unavailable.', 'স্থানীয় মোড। অ্যাকাউন্টের সাথে সমন্বয় বন্ধ।') :
      registered ? text('Signed in as ', 'প্রবেশ করেছেন: ') + currentAccount.name + '.' :
      text('You are using a guest account on this phone. Create an account to keep your notes if this phone is lost.', 'আপনি এই ফোনে অতিথি অ্যাকাউন্ট ব্যবহার করছেন। ফোন হারালেও নোট রাখতে একটি অ্যাকাউন্ট তৈরি করুন।');
    const open = document.getElementById('account-open-btn'); if (open) open.hidden = registered;
    const out = document.getElementById('sign-out-btn'); if (out) out.hidden = !registered;
  }
  window.ASTHA_RENDER_ACCOUNT = renderAccount;
  function openAuthGate() {
    const gate = document.getElementById('auth-gate');
    if (!gate.hidden) return;
    gateOpener = document.activeElement || null;
    setAuthTab('signup');
    gate.hidden = false; setBackgroundInert(true);
    document.getElementById('auth-name').focus();
  }
  function closeAuthGate() {
    const gate = document.getElementById('auth-gate');
    if (gate.hidden) return;
    gate.hidden = true; setBackgroundInert(false);
    document.getElementById('auth-status').textContent = '';
    document.getElementById('auth-passcode').value = '';
    if (gateOpener && typeof gateOpener.focus === 'function') gateOpener.focus();
    gateOpener = null;
  }
  window.openAuthGate = openAuthGate;
  window.closeAuthGate = closeAuthGate;
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && booted) closeAuthGate();
  });

  async function submitAuth() {
    const name = document.getElementById('auth-name').value.trim();
    const phone = document.getElementById('auth-phone').value.trim();
    const passcode = document.getElementById('auth-passcode').value.trim();
    const status = document.getElementById('auth-status');
    const submitBtn = document.getElementById('auth-submit');
    const normalized = passcode.replace(/[০-৯]/g, digit => String(digit.charCodeAt(0) - '০'.charCodeAt(0))).replace(/\s/g, '');
    if (!phone || (mode === 'signup' ? !/^[0-9]{4,8}$/.test(normalized) : passcode.length < 4 || passcode.length > 128)) {
      status.textContent = text('Enter your phone number and passcode. New passcodes need 4 to 8 digits.', 'ফোন নম্বর ও পাসকোড দিন। নতুন পাসকোডে ৪ থেকে ৮টি সংখ্যা লাগবে।'); return;
    }
    submitBtn.disabled = true;
    const generation = ++sessionGeneration;
    status.textContent = text('Signing in…', 'প্রবেশ করা হচ্ছে…');
    try {
      const res = await authFetch('/api/auth/' + mode, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === 'signup' ? { name, phone, passcode } : { phone, passcode }),
      });
      const data = await res.json();
      if (generation !== sessionGeneration) return;
      if (!res.ok) {
        const errors = {
          phone_taken: text('That phone number already has an account. Try Log in.', 'এই নম্বরে অ্যাকাউন্ট আছে। প্রবেশ করুন।'),
          invalid_credentials: text('Phone number or passcode is not right.', 'ফোন নম্বর বা পাসকোড ঠিক নয়।'),
          invalid_auth_input: text('Check the name, phone number and passcode.', 'নাম, ফোন নম্বর ও পাসকোড যাচাই করুন।'),
          auth_rate_limit: text('Too many attempts. Please try again later.', 'অনেকবার চেষ্টা করা হয়েছে। পরে আবার চেষ্টা করুন।'),
        };
        status.textContent = errors[data.error] || text('Something went wrong. Try again.', 'সমস্যা হয়েছে। আবার চেষ্টা করুন।'); return;
      }
      const me = await authFetch('/api/auth/me');
      if (generation !== sessionGeneration) return;
      if (!me.ok) throw new Error('Session not confirmed');
      const verified = await me.json();
      if (generation !== sessionGeneration) return;
      logoutPending = false;
      try { localStorage.removeItem(PENDING_LOGOUT); } catch (e) {}
      await enterApp(verified, generation);
    } catch (e) {
      status.textContent = text('Could not confirm your session. Check your connection and try again.', 'প্রবেশ নিশ্চিত করা যায়নি। সংযোগ দেখে আবার চেষ্টা করুন।');
    } finally { submitBtn.disabled = false; }
  }
  window.submitAuth = submitAuth;

  async function enterApp(me = null, generation = sessionGeneration) {
    if (generation !== sessionGeneration) return;
    const pending = pendingLogout();
    if (pending && me) return;
    const verified = validId(me?.id) ? me.id : null;
    let localAccount = verified;
    if (!localAccount && !pending) {
      try { const last = localStorage.getItem(LAST_ACCOUNT); if (validId(last)) localAccount = last; } catch (e) {}
    }
    if (booted && localAccount !== window.ASTHA_LOCAL_ACCOUNT_ID) {
      if (verified) try { localStorage.setItem(LAST_ACCOUNT, verified); } catch (e) {}
      if (typeof stopAllSpeech === 'function') stopAllSpeech();
      location.reload(); return;
    }
    window.ASTHA_ACCOUNT_ID = verified;
    window.ASTHA_LOCAL_ACCOUNT_ID = localAccount;
    if (typeof refreshOwnerContext === 'function') refreshOwnerContext();
    if (verified) try { localStorage.setItem(LAST_ACCOUNT, verified); } catch (e) {}
    document.getElementById('auth-gate').hidden = true; setBackgroundInert(false);
    document.getElementById('auth-passcode').value = '';
    currentAccount = me;
    if (!booted && typeof window.__asthaBoot === 'function') { booted = true; window.__asthaBoot(); }
    else if (verified) {
      if (typeof refreshMemory === 'function') refreshMemory();
      if (typeof refreshRooms === 'function') refreshRooms();
    }
    renderAccount();
  }

  async function boot() {
    let generation = sessionGeneration;
    try {
      if (pendingLogout()) {
        const logout = await authFetch('/api/auth/logout', { method: 'POST' });
        if (generation !== sessionGeneration) return;
        if (!logout.ok) { await enterApp(null, generation); return; }
        logoutPending = false;
        try { localStorage.removeItem(PENDING_LOGOUT); } catch (e) {}
      }
      const r = await authFetch('/api/auth/me');
      if (generation !== sessionGeneration) return;
      if (r.ok) { await enterApp(await r.json(), generation); return; }
      if (r.status === 401) { window.ASTHA_CLEAR_ACCOUNT(); generation = sessionGeneration; }
      if (r.status === 401) {
        const guest = await authFetch('/api/auth/guest', { method: 'POST' });
        if (generation !== sessionGeneration) return;
        if (guest.ok) {
          const me = await authFetch('/api/auth/me');
          if (generation !== sessionGeneration) return;
          if (me.ok) { await enterApp(await me.json(), generation); return; }
        }
      }
    } catch (e) { /* Offline namespaces may load; they never count as verified accounts. */ }
    await enterApp(null, generation);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  window.ASTHA_REFRESH_SESSION = boot;
  window.addEventListener('online', () => {
    if (typeof remoteProcessingAllowed !== 'function' || remoteProcessingAllowed()) boot();
  });
  if ('serviceWorker' in navigator) window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
})();
