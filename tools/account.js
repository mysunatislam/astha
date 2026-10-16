/* =====================================================================
   20. Your data: download it, forget face and voice, delete the account
       Everything the server holds comes from /api/account/export; what
       exists only on this phone is added to the same file. Deletion is
       never a single spoken command: the panel has to be confirmed.
   ===================================================================== */
const ACCOUNT_DELETE_CONFIRMATION = 'delete_my_account';
let deleteAccountState = null, deleteAccountBusy = false;

function dataStatus(en, bn) {
  const el = $('data-status'); if (el) el.textContent = uiLang === 'bn' ? bn : en;
  announce(en, bn, 'system');
}
function readStored(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; } }

// Records that exist only in this browser for the current profile.
function localAccountSnapshot() {
  const ownerKey = ownerNamespace();
  return {
    notes: readStored(LocalStore.KEY),
    automatic_memory: typeof AsthaObservationMemory === 'undefined' ? { enabled: false } : AsthaObservationMemory.exportPreference(),
    face_template: readStored(ownerKey + '.face'),
    voice_template: readStored(ownerKey + '.voice'),
    preferences: readStored('astha.preferences'),
  };
}

// A browser saves the file. Inside the installed app there is no download manager, so the
// text goes to the clipboard, or to the reading box where it can be heard and copied.
async function deliverExport(text) {
  const native = Boolean(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
  if (!native) {
    try {
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url; link.download = 'astha-my-data.json';
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return 'file';
    } catch (e) { /* Fall through to the copies that need no file access. */ }
  }
  try { await navigator.clipboard.writeText(text); return 'clipboard'; } catch (e) {}
  const box = $('reader-text');
  if (box) { box.value = text; if (typeof readerTextChanged === 'function') readerTextChanged(); return 'reader'; }
  return null;
}
async function exportMyData() {
  let account = null, reached = !window.ASTHA_ACCOUNT_ID;
  if (window.ASTHA_ACCOUNT_ID) {
    try { account = await apiGet('/api/account/export'); reached = true; } catch (e) { account = null; }
  }
  const text = JSON.stringify({ format: 'astha-device-export-v1', exported_at: new Date().toISOString(), account, this_phone: localAccountSnapshot() }, null, 2);
  const how = await deliverExport(text);
  if (!how) return dataStatus('I could not prepare your data on this device.', 'এই ডিভাইসে আপনার তথ্য প্রস্তুত করা যায়নি।');
  const where = {
    file: ['saved as the file astha-my-data.json', 'astha-my-data.json ফাইল হিসেবে সংরক্ষিত হয়েছে'],
    clipboard: ['copied to the clipboard', 'ক্লিপবোর্ডে কপি করা হয়েছে'],
    reader: ['placed in the reading box', 'পড়ার বাক্সে রাখা হয়েছে'],
  }[how];
  if (reached) dataStatus(`Your data is ${where[0]}.`, `আপনার তথ্য ${where[1]}।`);
  else dataStatus(`I could not reach your account. Only the data on this phone is ${where[0]}.`, `আপনার অ্যাকাউন্টে পৌঁছানো যায়নি। শুধু এই ফোনের তথ্য ${where[1]}।`);
  logEvent('Data export');
}

async function forgetOwnerBiometrics() {
  const key = refreshOwnerContext();
  let removed = true;
  for (const part of ['.face', '.voice', '.lock']) { try { localStorage.removeItem(key + part); } catch (e) { removed = false; } }
  owner.face = null; owner.voice = null; owner.lock = false; owner.verifiedAt = 0;
  renderOwner();
  if (!removed) return dataStatus('Browser storage could not be cleared. Try again in browser settings.', 'ব্রাউজারের সংরক্ষণ মোছা যায়নি। ব্রাউজারের সেটিংস থেকে আবার চেষ্টা করুন।');
  // An earlier version could keep a face template with the account; clear that copy as well.
  let accountCleared = !window.ASTHA_ACCOUNT_ID;
  if (!accountCleared) { try { await apiSend('PUT', '/api/settings', { face_descriptor: null }); accountCleared = true; } catch (e) {} }
  if (accountCleared) dataStatus('Your face and voice templates are removed from this phone.', 'আপনার মুখ ও কণ্ঠের নমুনা এই ফোন থেকে মুছে ফেলা হয়েছে।');
  else dataStatus('Your face and voice templates are removed from this phone. I could not reach your account to clear any copy there; try again when connected.', 'আপনার মুখ ও কণ্ঠের নমুনা এই ফোন থেকে মুছে ফেলা হয়েছে। অ্যাকাউন্টে থাকা কপি মুছতে পৌঁছানো যায়নি; সংযোগ পেলে আবার চেষ্টা করুন।');
}

// Everything this profile keeps in the browser. Unscoped records from older versions have
// no reliable owner, so a full deletion removes them too. Interface preferences stay.
function purgeLocalAccountData() {
  if (typeof AsthaObservationMemory !== 'undefined') AsthaObservationMemory.clear();
  const ownerKey = ownerNamespace();
  clearTimeout(LocalStore.timer);
  let ok = true;
  for (const key of [LocalStore.KEY, ownerKey + '.face', ownerKey + '.voice', ownerKey + '.lock',
    'astha.memory.v1.encrypted', 'astha.spatial_home', 'astha.gemini']) {
    try { localStorage.removeItem(key); } catch (e) { ok = false; }
  }
  LocalStore.deletions = [];
  state.memory = []; state.spatialHome = []; state.log = [];
  owner.face = null; owner.voice = null; owner.lock = false; owner.verifiedAt = 0;
  if (typeof cloud !== 'undefined') cloud.key = '';
  renderMemory(); renderSpatialLayout(); renderLog(); renderOwner();
  return ok;
}

function closeDeleteAccount() {
  const panel = $('delete-account-panel'); if (!panel || panel.hidden) return;
  panel.hidden = true; deleteAccountState = null;
  $('delete-account-pin').value = '';
  const button = $('delete-account-btn'); button.setAttribute('aria-expanded', 'false'); button.focus();
}
async function openDeleteAccount(keepOpen) {
  const panel = $('delete-account-panel'); if (!panel) return;
  if (!panel.hidden) { if (!keepOpen) closeDeleteAccount(); return; }
  const connected = Boolean(window.ASTHA_ACCOUNT_ID);
  let registered = false;
  if (connected) {
    try { const me = await apiGet('/api/auth/me'); registered = typeof me.phone === 'string' && me.phone.length > 0; }
    catch (e) { return dataStatus('I could not reach your account, so nothing was deleted. Check the connection and try again.', 'আপনার অ্যাকাউন্টে পৌঁছানো যায়নি, তাই কিছুই মোছা হয়নি। সংযোগ দেখে আবার চেষ্টা করুন।'); }
  }
  deleteAccountState = { connected, registered };
  $('delete-account-pin-field').hidden = !registered; $('delete-account-pin').value = '';
  const note = $('delete-account-note');
  note.hidden = registered; note.textContent = registered ? '' : t(connected ? 'data_delete_guest' : 'data_delete_local');
  if (typeof AsthaExperience !== 'undefined') AsthaExperience.showPage('settings', { speakTitle: false });
  for (let ancestor = panel.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.tagName === 'DETAILS') ancestor.open = true;
  }
  panel.hidden = false; $('delete-account-btn').setAttribute('aria-expanded', 'true');
  (registered ? $('delete-account-pin') : $('delete-account-confirm')).focus();
  announce(I18N.en.data_delete_warn, I18N.bn.data_delete_warn, 'system');
}
async function confirmDeleteAccount() {
  const pending = deleteAccountState;
  if (!pending || deleteAccountBusy) return;
  const passcode = $('delete-account-pin').value.trim();
  if (pending.registered && passcode.length < 4) {
    $('delete-account-pin').focus();
    return dataStatus('Enter your passcode to confirm.', 'নিশ্চিত করতে আপনার পাসকোড দিন।');
  }
  deleteAccountBusy = true; $('delete-account-confirm').disabled = true;
  try {
    if (pending.connected) {
      let reply;
      try {
        reply = await fetch(apiUrl('/api/account/delete'), {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(pending.registered ? { confirm: ACCOUNT_DELETE_CONFIRMATION, passcode } : { confirm: ACCOUNT_DELETE_CONFIRMATION }),
          signal: deadlineSignal(10000),
        });
      } catch (e) {
        return dataStatus('I could not reach your account, so nothing was deleted. Check the connection and try again.', 'আপনার অ্যাকাউন্টে পৌঁছানো যায়নি, তাই কিছুই মোছা হয়নি। সংযোগ দেখে আবার চেষ্টা করুন।');
      }
      if (reply.status === 403) {
        $('delete-account-pin').value = ''; $('delete-account-pin').focus();
        return dataStatus('That passcode is not right. Nothing was deleted.', 'পাসকোড ঠিক নয়। কিছুই মোছা হয়নি।');
      }
      if (reply.status === 429) return dataStatus('Too many attempts. Nothing was deleted. Please try again later.', 'অনেকবার চেষ্টা করা হয়েছে। কিছুই মোছা হয়নি। পরে আবার চেষ্টা করুন।');
      if (!reply.ok) return dataStatus('Your account could not be deleted. Nothing was removed. Please try again.', 'অ্যাকাউন্ট মোছা যায়নি। কিছুই সরানো হয়নি। আবার চেষ্টা করুন।');
    }
    const cleared = purgeLocalAccountData();
    $('delete-account-panel').hidden = true; deleteAccountState = null;
    if (pending.connected) {
      dataStatus(cleared ? 'Your account and everything saved with it are deleted.' : 'Your account is deleted. Some copies on this phone could not be cleared; clear this site in browser settings.',
        cleared ? 'আপনার অ্যাকাউন্ট ও এর সঙ্গে সংরক্ষিত সবকিছু মুছে ফেলা হয়েছে।' : 'আপনার অ্যাকাউন্ট মুছে ফেলা হয়েছে। এই ফোনের কিছু কপি মোছা যায়নি; ব্রাউজারের সেটিংস থেকে এই সাইটের তথ্য মুছুন।');
      // The session no longer exists. Leave time for the confirmation to be heard, then restart clean.
      if (typeof window.ASTHA_CLEAR_ACCOUNT === 'function') window.ASTHA_CLEAR_ACCOUNT({ logout: true });
      setTimeout(() => location.reload(), 3500);
    } else {
      dataStatus(cleared ? 'The notes and templates saved on this phone are deleted.' : 'Browser storage could not be cleared. Try again in browser settings.',
        cleared ? 'এই ফোনে সংরক্ষিত নোট ও নমুনা মুছে ফেলা হয়েছে।' : 'ব্রাউজারের সংরক্ষণ মোছা যায়নি। ব্রাউজারের সেটিংস থেকে আবার চেষ্টা করুন।');
    }
  } finally { deleteAccountBusy = false; $('delete-account-confirm').disabled = false; }
}

// A guest account has no phone number or known passcode, so signing out would strand its
// records where nobody can reach them. Guests are pointed to the two real choices instead.
async function signOut() {
  if (window.ASTHA_ACCOUNT_ID && window.ASTHA_ACCOUNT_REGISTERED === false) {
    return dataStatus('You are using a guest account. Create an account to keep your notes, or choose Delete my account to remove them.',
      'আপনি অতিথি অ্যাকাউন্ট ব্যবহার করছেন। নোট রাখতে অ্যাকাউন্ট তৈরি করুন, অথবা মুছে ফেলতে “আমার অ্যাকাউন্ট মুছুন” বেছে নিন।');
  }
  if (typeof window.ASTHA_CLEAR_ACCOUNT === 'function') window.ASTHA_CLEAR_ACCOUNT({ logout: true });
  if (typeof stopAllSpeech === 'function') stopAllSpeech();
  try { await apiSend('POST', '/api/auth/logout', {}); } catch (e) {}
  location.reload();
}
