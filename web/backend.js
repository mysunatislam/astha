// Sign-in gate: shown until the browser has a valid session; then the whole companion app
// (defined in the big inline <script> from index.html) is started via window.__asthaBoot().
// This file is a classic script, loaded after that one, so it shares the same top-level scope
// and can call the app's own functions (announce, apiSend, etc.) directly.
(function () {
  let mode = 'signup';

  function setAuthTab(next) {
    mode = next;
    document.getElementById('auth-tab-signup').setAttribute('aria-pressed', next === 'signup');
    document.getElementById('auth-tab-login').setAttribute('aria-pressed', next === 'login');
    document.getElementById('auth-name-field').hidden = next === 'login';
    document.getElementById('auth-name').required = next === 'signup';
    document.getElementById('auth-submit').textContent = next === 'signup' ? 'Create my account' : 'Log in';
    document.getElementById('auth-status').textContent = '';
  }
  window.setAuthTab = setAuthTab;

  async function submitAuth() {
    const name = document.getElementById('auth-name').value.trim();
    const phone = document.getElementById('auth-phone').value.trim();
    const passcode = document.getElementById('auth-passcode').value.trim();
    const status = document.getElementById('auth-status');
    const submitBtn = document.getElementById('auth-submit');
    if (!phone || passcode.length < 4) { status.textContent = 'Enter your phone number and a 4 to 8 digit passcode.'; return; }
    submitBtn.disabled = true;
    status.textContent = mode === 'signup' ? 'Creating your account…' : 'Signing in…';
    try {
      const res = await fetch(apiUrl('/api/auth/' + mode), {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === 'signup' ? { name, phone, passcode } : { phone, passcode }),
      });
      const data = await res.json();
      if (!res.ok) {
        status.textContent = {
          phone_taken: 'That phone number already has an account. Try Log in instead.',
          invalid_credentials: 'Phone number or passcode is not right.',
          name_phone_and_passcode_required: 'Please fill in every field.',
        }[data.error] || 'Something went wrong. Please try again.';
        return;
      }
      await enterApp();
    } catch (e) {
      status.textContent = 'Could not reach the Astha server. Check your connection and try again.';
    } finally { submitBtn.disabled = false; }
  }
  window.submitAuth = submitAuth;

  async function enterApp() {
    let me = null;
    try { const r = await fetch(apiUrl('/api/auth/me'), { credentials: 'include' }); if (r.ok) me = await r.json(); } catch (e) {}
    document.getElementById('auth-gate').hidden = true;
    if (typeof window.__asthaBoot === 'function') window.__asthaBoot();
    const row = document.getElementById('account-row');
    if (row && me) row.textContent = 'Signed in as ' + me.name + (me.phone ? ' · ' + me.phone : '') + '.';
  }

  async function boot() {
    try {
      const r = await fetch(apiUrl('/api/auth/me'), { credentials: 'include' });
      if (r.ok) { await enterApp(); return; }
      // Auto-authenticate as guest so the app works instantly without manual typing
      const g = await fetch(apiUrl('/api/auth/guest'), { method: 'POST', credentials: 'include' });
      if (g.ok) { await enterApp(); return; }
    } catch (e) {
      // Offline or standalone mode: boot immediately
    }
    await enterApp();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // Service worker: app-shell caching so Astha still opens with a weak connection.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => {}); });
  }
})();
