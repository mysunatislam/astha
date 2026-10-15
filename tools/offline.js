
/* =====================================================================
   19. Offline companion: local memory, search & guidance, on-device
       voice input, and the "works without internet" pack
       Nothing in this file needs the Astha server or a cloud key. The
       server, when reachable, is only a backup copy of what the phone
       already remembers.
   ===================================================================== */

// ---- Local, persistent memory (this phone) -----------------------------------
const LocalStore = {
  get KEY() {
    const account = window.ASTHA_LOCAL_ACCOUNT_ID || window.ASTHA_ACCOUNT_ID;
    return 'astha.local.v2.' + (typeof account === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(account) ? account : 'device');
  },
  timer: null, deletions: [], loadedKey: null, revision: 0,
  load() {
    try {
      const d = JSON.parse(localStorage.getItem(this.KEY) || '{}');
      this.deletions = Array.isArray(d.deletions) ? d.deletions.filter(p => typeof p === 'string' && /^\/api\/(memories|rooms|log)(\/[A-Za-z0-9_-]{1,128})?$/.test(p)) : [];
      this.loadedKey = this.KEY;
      const mem = Array.isArray(d.memory) ? d.memory.filter(m => m && typeof m.item === 'string' && typeof m.location === 'string' && m.uid) : [];
      const rooms = Array.isArray(d.rooms) ? d.rooms.filter(r => r && typeof r.name === 'string') : [];
      return { memory: mem, rooms };
    } catch (e) { this.deletions = []; this.loadedKey = this.KEY; return { memory: [], rooms: [] }; }
  },
  save() {
    if (typeof privacyMode !== 'undefined' && privacyMode) return;
    if (this.loadedKey !== this.KEY) this.load();
    try { localStorage.setItem(this.KEY, JSON.stringify({ memory: state.memory.slice(0, 80), rooms: state.spatialHome.slice(0, 30), deletions: this.deletions, saved: Date.now() })); } catch (e) {}
  },
  scheduleSave() { clearTimeout(this.timer); const key = this.KEY; this.timer = setTimeout(() => { if (key === this.KEY) this.save(); }, 250); },
  queueDelete(path) {
    if (this.loadedKey !== this.KEY) this.load();
    if (!this.deletions.includes(path)) this.deletions.push(path);
    this.revision += 1;
    this.save();
  },
  hides(kind, id) { return this.deletions.includes('/api/' + kind) || this.deletions.includes('/api/' + kind + '/' + id); },
  async flushDeletions() {
    if (this.loadedKey !== this.KEY) this.load();
    const key = this.KEY;
    for (const path of [...this.deletions]) {
      try {
        await apiSend('DELETE', path);
        if (key !== this.KEY) return false;
        this.deletions = this.deletions.filter(p => p !== path); this.save();
      } catch (e) { return false; }
    }
    return true;
  },
  clear() { clearTimeout(this.timer); this.deletions = []; this.loadedKey = this.KEY; try { localStorage.removeItem(this.KEY); } catch (e) {} },
};
// One note can be saved directly while a refresh also retries pending notes.
// Share the in-flight create so those paths cannot create duplicate server records.
const memoryUploads = new WeakMap();
function uploadLocalMemory(entry, accountKey) {
  if (memoryUploads.has(entry)) return memoryUploads.get(entry);
  const upload = (async () => {
    if (!entry.pending) return;
    const result = await apiSend('POST', '/api/memories', { item: entry.item, location: entry.location, source: entry.source, score: entry.score });
    if (accountKey !== LocalStore.KEY) return;
    entry.pending = false;
    if (result && result.id) {
      entry.uid = String(result.id);
      if (!state.memory.includes(entry)) LocalStore.queueDelete('/api/memories/' + encodeURIComponent(entry.uid));
    }
    LocalStore.save(); renderMemory();
  })().finally(() => { if (memoryUploads.get(entry) === upload) memoryUploads.delete(entry); });
  memoryUploads.set(entry, upload);
  return upload;
}
function bnDigits(n) { return String(n).replace(/\d/g, d => '০১২৩৪৫৬৭৮৯'[d]); }
function newUid() { return (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : 'mem_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7); }
function relativeTime(iso) {
  const d = new Date(iso), now = Date.now(), min = Math.round((now - d.getTime()) / 60000);
  if (!Number.isFinite(min)) return { en: '', bn: '' };
  if (min < 2) return { en: 'just now', bn: 'এইমাত্র' };
  if (min < 60) return { en: `${min} minutes ago`, bn: `${bnDigits(min)} মিনিট আগে` };
  const hrs = Math.round(min / 60);
  if (hrs < 6) return { en: `about ${hrs} hour${hrs > 1 ? 's' : ''} ago`, bn: `প্রায় ${bnDigits(hrs)} ঘণ্টা আগে` };
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const timeBn = d.toLocaleTimeString('bn-BD', { hour: 'numeric', minute: '2-digit' });
  const today = new Date().toDateString() === d.toDateString();
  const yest = new Date(now - 86400000).toDateString() === d.toDateString();
  if (today) return { en: `today at ${time}`, bn: `আজ ${timeBn}-এ` };
  if (yest) return { en: `yesterday at ${time}`, bn: `গতকাল ${timeBn}-এ` };
  return { en: `on ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })} at ${time}`, bn: `${d.toLocaleDateString('bn-BD', { day: 'numeric', month: 'long' })} ${timeBn}-এ` };
}

// Memory: local first, server as backup. Overrides the server-only versions in the module.
async function refreshMemory() {
  if (privacyMode || privacyTransition) return;
  const accountKey = LocalStore.KEY;
  if (LocalStore.loadedKey !== accountKey) LocalStore.load();
  if (!state.memory.length) {
    const d = LocalStore.load();
    if (d.memory.length) state.memory = d.memory;
    if (!state.spatialHome.length && d.rooms.length) state.spatialHome = d.rooms;
  }
  renderMemory();
  try {
    await LocalStore.flushDeletions();
    const revision = LocalStore.revision;
    const d = await apiGet('/api/memories');
    if (accountKey !== LocalStore.KEY || privacyMode || privacyTransition || revision !== LocalStore.revision) return;
    const server = (d.memories || []).filter(m => !LocalStore.hides('memories', String(m.id))).map(m => ({ uid: String(m.id), id: m.obj_id || undefined, item: m.item, location: m.location, source: m.source, score: m.score, time: new Date(m.created_at).toISOString() }));
    for (const m of state.memory.filter(x => x.pending)) {
      try {
        await uploadLocalMemory(m, accountKey);
        if (accountKey !== LocalStore.KEY) return;
        if (!m.pending && state.memory.includes(m)) server.push(m);
      } catch (e) { break; }
    }
    const key = m => (m.item + '|' + m.location).toLowerCase();
    const merged = new Map(); server.forEach(m => merged.set(key(m), m));
    state.memory.forEach(m => { const k = key(m); if (m.pending || merged.has(k)) merged.set(k, Object.assign({}, merged.get(k) || {}, m)); });
    if (accountKey !== LocalStore.KEY || privacyMode || privacyTransition || revision !== LocalStore.revision) return;
    state.memory = [...merged.values()].filter(m => !LocalStore.hides('memories', m.uid)).sort((a, b) => new Date(b.time) - new Date(a.time)).slice(0, 80);
  } catch (e) { if (!e.quiet) console.warn('memory fetch failed', e); }
  renderMemory(); LocalStore.save();
}
async function refreshRooms() {
  if (privacyMode || privacyTransition) return;
  const accountKey = LocalStore.KEY;
  if (LocalStore.loadedKey !== accountKey) LocalStore.load();
  if (!state.spatialHome.length) { const d = LocalStore.load(); if (d.rooms.length) state.spatialHome = d.rooms; }
  renderSpatialLayout();
  try {
    await LocalStore.flushDeletions();
    const revision = LocalStore.revision;
    const d = await apiGet('/api/rooms');
    if (accountKey !== LocalStore.KEY || privacyMode || privacyTransition || revision !== LocalStore.revision) return;
    const server = (d.rooms || []).filter(r => !LocalStore.hides('rooms', String(r.id))).map(r => ({ id: String(r.id), name: r.name, notes: r.notes, updated: new Date(r.updated_at).toISOString() }));
    const byName = new Map(); server.forEach(r => byName.set(r.name.toLowerCase(), r));
    state.spatialHome.forEach(r => { if (!byName.has(r.name.toLowerCase())) byName.set(r.name.toLowerCase(), r); });
    state.spatialHome = [...byName.values()].sort((a, b) => new Date(b.updated) - new Date(a.updated)).slice(0, 30);
  } catch (e) { if (!e.quiet) console.warn('rooms fetch failed', e); }
  renderSpatialLayout(); LocalStore.save();
}
function renderMemory() {
  const q = ($('memory-search')?.value || '').trim().toLocaleLowerCase();
  const records = state.memory.filter(m => (m.item + ' ' + m.location).toLocaleLowerCase().includes(q));
  $('memory-list').innerHTML = records.length ? records.map(m => '<div class="list-row"><div><strong>' + esc(m.item) + '</strong><div>' + esc(m.location) + '</div><div class="meta">' + esc(memoryDate(m.time)) + ' · ' + esc(m.source || '') + (m.score != null ? ' · model score ' + Math.round(m.score * 100) + '% (not certainty)' : '') + (m.pending ? ' · saved on this phone' : '') + '</div></div><button class="btn small" data-delete-memory="' + esc(m.uid) + '" aria-label="Delete ' + esc(m.item) + ' memory">Delete</button></div>').join('') : '<p class="empty-note">' + (q ? 'No matching memories.' : t('memory_empty')) + '</p>';
  LocalStore.scheduleSave();
}
function renderSpatialLayout() {
  const el = $('spatial-list'); if (!el) return;
  el.innerHTML = state.spatialHome.length ? state.spatialHome.map(r => `
    <div class="room-notes" style="margin-bottom: 0.75rem; padding: 0.75rem; border-radius: 8px; background: var(--surface); border: 1px solid var(--border);">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 4px;">
        <strong style="font-size: 1.05rem;">🏠 ${esc(r.name)}</strong>
        <span class="meta">${esc(memoryDate(r.updated))}</span>
      </div>
      <p style="margin: 0.35rem 0; font-size: 0.95rem; color: var(--fg);">${esc(r.notes || '')}</p>
      <div class="utility-row" style="margin-top: 0.5rem; gap: 0.5rem;">
        <button class="btn small accent" onclick="recalibrateRoom('${esc(r.id)}')" aria-label="Recalibrate ${esc(r.name)}">🔄 Recalibrate</button>
        <button class="btn small" data-delete-room="${esc(r.id)}" aria-label="Delete ${esc(r.name)} room">Delete</button>
      </div>
    </div>`).join('') : '<p class="empty-note">No calibrated rooms yet. Tap "Home layout calibration" to map your rooms with video.</p>';
  LocalStore.scheduleSave();
}
function addLocalMemory({ item, location, locationBn = null, source = 'Your note', score = null, id = undefined }) {
  const accountKey = LocalStore.KEY;
  const entry = { uid: newUid(), id, item: String(item).trim().slice(0, 80), location: String(location).trim().slice(0, 160), locationBn: locationBn ? String(locationBn).slice(0, 160) : null, source: String(source).slice(0, 80), score: typeof score === 'number' ? score : null, time: new Date().toISOString(), pending: true };
  state.memory = [entry, ...state.memory.filter(m => m.item.toLowerCase() !== entry.item.toLowerCase())].slice(0, 80);
  renderMemory(); LocalStore.save();
  uploadLocalMemory(entry, accountKey).catch(() => { /* stays in this account's local namespace */ });
  return entry;
}
let _recentMemoryDedupe2 = [];
async function autoRecordMemory({ item, location, locationBn = null, source = 'Camera observation', score = null, room = null, furniture = null, approved = false }) {
  if (!approved || privacyMode || privacyTransition) return;
  if (!item || !String(item).trim()) return;
  const cleanItem = String(item).trim().slice(0, 80), now = Date.now();
  _recentMemoryDedupe2 = _recentMemoryDedupe2.filter(m => now - m.time < 45000);
  if (_recentMemoryDedupe2.some(m => m.item.toLowerCase() === cleanItem.toLowerCase())) return;
  _recentMemoryDedupe2.push({ item: cleanItem, time: now });
  let resolved = location || 'in front of the camera';
  const curRoom = room || state.currentRoom || null;
  if (furniture && curRoom) resolved = `on the ${furniture} in the ${curRoom}`;
  else if (furniture) resolved = `on the ${furniture}`;
  else if (curRoom && !resolved.toLowerCase().includes(curRoom.toLowerCase())) resolved = `${resolved} in the ${curRoom}`;
  const entry = addLocalMemory({ item: cleanItem, location: resolved, locationBn, source, score });
  logEvent(`Memory saved: ${cleanItem} (${resolved})`);
  return entry;
}
async function saveManualMemory() {
  if (privacyTransition) return;
  if (privacyMode) return announce('Memory is off in privacy mode.', 'গোপনীয়তা মোডে মেমরি বন্ধ।');
  const item = $('memory-item').value.trim(), location = $('memory-location').value.trim();
  if (!item || !location) return;
  $('memory-item').value = ''; $('memory-location').value = '';
  addLocalMemory({ item, location, source: 'Your note' });
  announce('Remembered ' + item + ': ' + location + '.', item + ' এর স্থান মনে রাখা হয়েছে: ' + location + '।', 'memory');
}
async function remember(id, pos) {
  if (privacyTransition) return;
  if (privacyMode) return announce('Memory is off in privacy mode.', 'গোপনীয়তা মোডে মেমরি বন্ধ।');
  if (!state.source || state.source === 'scene') return announce('Demo scenes are not saved as personal memories.', 'ডেমো দৃশ্য ব্যক্তিগত স্মৃতিতে সংরক্ষিত হয় না।');
  const observation = state.world.get(id); if (!observation) return;
  const position = 'In the ' + (pos === 'ahead' ? 'centre' : pos) + ' of the image; physical location unconfirmed';
  addLocalMemory({ item: objLabel(observation), location: position, source: state.source === 'camera' ? 'Camera observation' : 'Uploaded photo', score: observation.score, id });
  announce('Saved a possible ' + objLabel(observation) + ' from this image. Say where it is kept for a useful note.', 'ছবি থেকে সম্ভাব্য ' + objLabelBn(observation) + ' সংরক্ষিত। কোথায় রাখা আছে বললে নোটটি কাজে লাগবে।', 'memory');
}
async function deleteMemory(uid) {
  if (privacyTransition) return;
  state.memory = state.memory.filter(m => m.uid !== uid); renderMemory(); LocalStore.save();
  LocalStore.queueDelete('/api/memories/' + encodeURIComponent(uid));
  const synced = await LocalStore.flushDeletions();
  if (!synced) announce('Deleted from this phone. Account deletion will retry when connected.', 'এই ফোন থেকে মুছে ফেলা হয়েছে। সংযোগ পেলে অ্যাকাউন্ট থেকে মুছে ফেলার চেষ্টা হবে।', 'system');
  $('memory-search')?.focus();
}
async function clearMemory() {
  if (!confirm(t('memory_clear_confirm'))) return;
  state.memory = []; state.spatialHome = []; state.log = []; LocalStore.clear();
  renderMemory(); renderSpatialLayout(); renderLog();
  ['/api/memories', '/api/rooms', '/api/log'].forEach(path => LocalStore.queueDelete(path));
  const synced = await LocalStore.flushDeletions();
  announce(synced ? 'Personal memories and room notes deleted from this phone and account.' : 'Deleted from this phone. Account deletion is pending and will retry when connected.', synced ? 'এই ফোন ও অ্যাকাউন্ট থেকে ব্যক্তিগত স্মৃতি ও ঘরের নোট মুছে ফেলা হয়েছে।' : 'এই ফোন থেকে মুছে ফেলা হয়েছে। সংযোগ পেলে অ্যাকাউন্ট থেকে মুছে ফেলার চেষ্টা হবে।', 'system');
}
async function deleteCalibratedRoom(id) {
  if (privacyTransition) return;
  state.spatialHome = state.spatialHome.filter(r => r.id !== id); renderSpatialLayout(); LocalStore.save();
  LocalStore.queueDelete('/api/rooms/' + encodeURIComponent(id));
  if (!await LocalStore.flushDeletions()) announce('Deleted from this phone. Account deletion will retry when connected.', 'এই ফোন থেকে মুছে ফেলা হয়েছে। সংযোগ পেলে অ্যাকাউন্ট থেকে মুছে ফেলার চেষ্টা হবে।', 'system');
}

// ---- "I am keeping my wallet here": honest placement notes ----------------------
const PLACE_WORDS = {
  table: ['table', 'টেবিল'], desk: ['desk', 'ডেস্ক'], bed: ['bed', 'বিছানা'], drawer: ['drawer', 'ড্রয়ার'], bag: ['bag', 'ব্যাগ'], pocket: ['pocket', 'পকেট'], shelf: ['shelf', 'তাক'],
  cupboard: ['cupboard', 'আলমারি'], wardrobe: ['wardrobe', 'আলমারি'], almirah: ['almirah', 'আলমারি'], sofa: ['sofa', 'সোফা'], couch: ['sofa', 'সোফা'], chair: ['chair', 'চেয়ার'], kitchen: ['kitchen', 'রান্নাঘর'],
  fridge: ['fridge', 'ফ্রিজ'], box: ['box', 'বাক্স'], pillow: ['pillow', 'বালিশ'], window: ['window', 'জানালা'], door: ['door', 'দরজা'], rack: ['rack', 'র‍্যাক'], counter: ['counter', 'কাউন্টার'], 'dressing table': ['dressing table', 'ড্রেসিং টেবিল'], 'reading table': ['reading table', 'পড়ার টেবিল'], 'bedside table': ['bedside table', 'বিছানার পাশের টেবিল'], 'side table': ['side table', 'সাইড টেবিল'], wall: ['wall', 'দেয়াল'], floor: ['floor', 'মেঝে'], car: ['car', 'গাড়ি'], purse: ['purse', 'পার্স'],
};
const BN_PLACE = { 'টেবিল': 'table', 'ডেস্ক': 'desk', 'বিছানা': 'bed', 'খাট': 'bed', 'ড্রয়ার': 'drawer', 'ব্যাগ': 'bag', 'পকেট': 'pocket', 'তাক': 'shelf', 'আলমারি': 'cupboard', 'সোফা': 'sofa', 'চেয়ার': 'chair', 'রান্নাঘর': 'kitchen', 'ফ্রিজ': 'fridge', 'বাক্স': 'box', 'বালিশ': 'pillow', 'জানালা': 'window', 'দরজা': 'door', 'র‍্যাক': 'rack' };
const PREP_BN = { on: '-এর ওপর', in: '-এর ভেতরে', inside: '-এর ভেতরে', under: '-এর নিচে', behind: '-এর পেছনে', near: '-এর কাছে', beside: '-এর পাশে', 'next to': '-এর পাশে', by: '-এর পাশে', at: '-এ' };
function parseSpokenPlace(query) {
  const q = (query || '').toLowerCase();
  const m = q.match(/\b(on|in|inside|under|behind|beside|next to|near|by|at)\s+(?:the |my |a |an )?([a-z][a-z ]{1,30}?)(?=\s*(?:$|[.,!?]|\bhere\b|\bnow\b|\bin the\b|\bof the\b|\bin my\b))/);
  if (m) {
    let prep = m[1], place = m[2].trim().replace(/\s+(here|now)$/, '');
    const known = PLACE_WORDS[place] || PLACE_WORDS[place.replace(/s$/, '')];
    const vm = !known && typeof findVocabMatch === 'function' ? findVocabMatch(place) : null;
    const en = known ? known[0] : vm ? vm.en : place, bn = known ? known[1] : vm ? vm.bn : place;
    if (!known && !vm && /^(it|this|that|here|there|front|hand|me|you)$/.test(place)) return null;
    return { en: `${prep} the ${en}`, bn: bn + (PREP_BN[prep] || '-এ') };
  }
  const mb = (query || '').match(/([ঀ-৿]{2,}?)(?:ের|র)?\s*(ওপরে|ওপর|উপরে|ভিতরে|ভেতরে|নিচে|পাশে|কাছে|পেছনে|মধ্যে)/);
  if (mb) { const base = mb[1]; const en = BN_PLACE[base] || base; const prepEn = { 'ওপরে': 'on', 'ওপর': 'on', 'উপরে': 'on', 'ভিতরে': 'in', 'ভেতরে': 'in', 'মধ্যে': 'in', 'নিচে': 'under', 'পাশে': 'beside', 'কাছে': 'near', 'পেছনে': 'behind' }[mb[2]] || 'at'; return { en: `${prepEn} the ${en}`, bn: `${base}-এর ${mb[2]}` }; }
  const ms = (query || '').match(/([ঀ-৿]{2,}(?:ে|য়|তে))\s+(?:রাখছি|রাখলাম|রেখেছি|রাখি|আছে)/);
  if (ms) { const w = ms[1]; const base = w.replace(/(তে|য়|ে)$/, ''); const en = BN_PLACE[base] || BN_PLACE[base + 'া'] || base; if (/^(এখান|ওখান|এই|ওই)/.test(w)) return null; return { en: `at the ${en}`, bn: w }; }
  return null;
}
async function handleOnDevicePlacement(query, statedItem) {
  const stillWanted = captureLocalActionGuard();
  return withBusy('Remembering…', async () => {
    const accountKey = LocalStore.KEY;
    if (!stillWanted() || privacyMode || privacyTransition) return;
    const frame = captureFrame(640); if (!frame) return;
    heartSet({ x: 0.5, y: 0.5, mode: 'seek', label: 'Looking…' });
    let cocoObjs;
    try {
      await ensureVisionModels();
      if (!stillWanted()) return;
      cocoObjs = await runCoco(frame);
    } catch (e) { if (!stillWanted() || e.cancelled) return; throw e; }
    if (!stillWanted()) return;
    state.lastCocoPreds = cocoObjs;
    if (typeof perceptionHook === 'function') perceptionHook(cocoObjs, frame, { noDepthKick: true });
    let item = statedItem ? statedItem.trim() : '', itemBn = null, targetId = null, seen = false;
    const vm = item && typeof findVocabMatch === 'function' ? findVocabMatch(item) : null;
    if (vm) { item = vm.en; itemBn = vm.bn; targetId = vm.id; }
    if (targetId) seen = cocoObjs.some(o => o.id === targetId || o.origId === targetId);
    if (!seen && engine.clip.status === 'ready') {
      try {
        const [emb] = await clipEmbedCrops(frame, [centerRect(frame, 0.6)]);
        if (!stillWanted()) return;
        const ranked = scoreEmbedding(emb).filter(r => r.id !== '_bg' && !(VOCAB_BY_ID[r.id] || {}).quiet);
        if (targetId) seen = ranked.slice(0, 3).some(r => r.id === targetId && r.p >= 0.12);
        else if (!item && ranked[0] && ranked[0].p >= 0.15 && (VOCAB_BY_ID[ranked[0].id] || {}).personal) { item = label(ranked[0].id); itemBn = labelBn(ranked[0].id); targetId = ranked[0].id; seen = true; }
      } catch (e) { if (!stillWanted() || e.cancelled) return; console.warn('placement clip', e); }
    }
    if (!item) {
      const central = cocoObjs.filter(o => (VOCAB_BY_ID[o.id] || {}).personal).sort((a, b) => (a.bbox[2] * a.bbox[3]) - (b.bbox[2] * b.bbox[3]))[0];
      if (central) { item = objLabel(central); itemBn = objLabelBn(central); targetId = central.id; seen = true; }
    }
    if (!stillWanted()) return;
    if (!item) { heartHide(); return announce('Tell me what you are keeping, for example: I am keeping my wallet here.', 'কী রাখছেন বলুন, যেমন: আমার মানিব্যাগ এখানে রাখছি।', 'memory'); }
    // Only the user's named place confirms a physical location. An image alone cannot
    // establish that an item rests on a detected surface or belongs to the current room.
    const spoken = parseSpokenPlace(query);
    if (!stillWanted() || privacyMode || privacyTransition || LocalStore.KEY !== accountKey) return;
    if (!spoken) {
      heartHide();
      return announce('Tell me the place to save, for example: my wallet is on the table. The image does not confirm its physical location.', 'কোথায় রাখছেন বলুন, যেমন: আমার মানিব্যাগ টেবিলের ওপর। শুধু ছবি থেকে প্রকৃত স্থান নিশ্চিত করা যায় না।', 'memory');
    }
    const locEn = spoken.en, locBn = spoken.bn;
    addLocalMemory({ item, location: locEn, locationBn: locBn, source: 'Voice placement', score: null, id: targetId || undefined });
    const seenEn = seen ? `I see your ${item}.` : `I did not clearly see the ${item}, but I noted the place.`;
    const seenBn = seen ? `আপনার ${itemBn || item} দেখতে পাচ্ছি।` : `${itemBn || item} স্পষ্ট দেখিনি, তবে জায়গাটা লিখে রাখলাম।`;
    const isAre = (VOCAB_BY_ID[targetId] || {}).pl ? 'are' : 'is';
    announce(`Got it. ${seenEn} Remembered: your ${item} ${isAre} ${locEn}.`, `বুঝেছি। ${seenBn} মনে রাখলাম: আপনার ${itemBn || item} ${locBn}।`, 'memory');
    playEarcon('confirm'); haptic('CONFIRM'); heartFlash({ x: 0.5, y: 0.5, mode: 'lock', label: item });
    logEvent(`Remembered placement: ${item} ${locEn}`);
  });
}

// ---- Search & guidance: "find my charger", "guide me to the switch" ----------------
const SEEK_TEXT = {
  start_mem: ['A past note for {item} reports {loc}, saved {when}. Its current location is not confirmed. Point the camera there to check.', '{item}-এর আগের নোটে {loc} লেখা আছে, সংরক্ষিত {when}। বর্তমান অবস্থান নিশ্চিত নয়। যাচাই করতে ক্যামেরা সেদিকে ধরুন।'],
  start: ['Looking for your {item}. Move the phone slowly from left to right.', 'আপনার {item} খুঁজছি। ফোনটা ধীরে ধীরে বাম থেকে ডানে ঘোরান।'],
  start_guide: ['I will guide you to the {item}. Move the phone slowly from left to right so I can find it.', 'আমি আপনাকে {item}-এর কাছে নিয়ে যাব। প্রথমে ফোনটা ধীরে ধীরে বাম থেকে ডানে ঘোরান।'],
  no_clip: ['The recogniser is still loading. I will start looking as soon as it is ready.', 'শনাক্তকারী এখনো লোড হচ্ছে। প্রস্তুত হলেই খুঁজতে শুরু করব।'],
  turn_left: ['It is on your left. Turn the phone a little to the left.', 'এটা আপনার বাম দিকে। ফোনটা একটু বাঁয়ে ঘোরান।'],
  turn_right: ['It is on your right. Turn the phone a little to the right.', 'এটা আপনার ডান দিকে। ফোনটা একটু ডানে ঘোরান।'],
  tilt_down: ['It is lower down. Tilt the phone down a little.', 'এটা একটু নিচে। ফোনটা একটু নিচে নামান।'],
  tilt_up: ['It is higher up. Tilt the phone up a little.', 'এটা একটু উপরে। ফোনটা একটু উপরে তুলুন।'],
  found: ['Found it. Your {item} is straight ahead, {dist}. {next}', 'পেয়েছি। আপনার {item} ঠিক সামনে, {dist}। {next}'],
  found_nodist: ['Found it. Your {item} is straight ahead. {next}', 'পেয়েছি। আপনার {item} ঠিক সামনে। {next}'],
  next_reach: ['Reach forward slowly.', 'ধীরে হাত বাড়ান।'],
  next_walk: ['The target appears ahead. Verify the route with your usual mobility aid before moving.', 'লক্ষ্যটি সামনে দেখা যাচ্ছে। চলার আগে আপনার চলাচলের সহায়ক উপায় দিয়ে পথ যাচাই করুন।'],
  next_obstacle: ['There may be {obs} between you and it. Verify the route before moving.', 'মাঝখানে {obs} থাকতে পারে। চলার আগে পথ যাচাই করুন।'],
  closer: ['The target appears larger. Physical distance is uncertain.', 'লক্ষ্যটি বড় দেখা যাচ্ছে। প্রকৃত দূরত্ব অনিশ্চিত।'],
  stop_here: ['The target appears ahead. Verify its position before reaching.', 'লক্ষ্যটি সামনে দেখা যাচ্ছে। হাত বাড়ানোর আগে অবস্থান যাচাই করুন।'],
  lost: ['I lost sight of it. Move the phone back slowly.', 'এটা আর দেখছি না। ফোনটা ধীরে পেছনে আনুন।'],
  not_yet_1: ['Not seen yet. Keep turning slowly.', 'এখনো দেখছি না। ধীরে ঘুরতে থাকুন।'],
  not_yet_2: ['Try pointing the camera lower, at the table or the floor.', 'ক্যামেরা একটু নিচে, টেবিল বা মেঝের দিকে ধরুন।'],
  not_yet_3: ['Still looking. Try the other side of the room.', 'এখনো খুঁজছি। ঘরের অন্য পাশে দেখুন।'],
  give_up: ['I could not find your {item} here. Try another place, or ask me again.', 'এখানে আপনার {item} পাইনি। অন্য জায়গায় দেখুন, বা আবার বলুন।'],
  stopped: ['Okay, I stopped looking.', 'ঠিক আছে, খোঁজা থামালাম।'],
  what: ['What should I look for? For example: find my glasses.', 'কী খুঁজব? যেমন: আমার চশমা খোঁজো।'],
};
const Seeker = {
  active: false, mode: 'find', target: null, timer: null, startedAt: 0, lastSaidKey: '', lastSaidAt: 0, centerStreak: 0, missStreak: 0, phase: 'search', hintIdx: 0, textEmbeds: null, distractors: null, lastCand: null, ticks: 0,
  fill(s, p) { return s.replace(/\{(\w+)\}/g, (_, k) => (p && p[k] != null) ? p[k] : ''); },
  say(key, p = {}, force) {
    const now = Date.now();
    if (!force && ((key === this.lastSaidKey && now - this.lastSaidAt < 3500) || now - this.lastSaidAt < 1500 || asthaSpeaking())) return false;
    const it = this.target || {};
    const params = Object.assign({ item: it.en, dist: '', next: '', obs: '', side: '', loc: '', when: '' }, p);
    const paramsBn = Object.assign({}, params, { item: it.bn || it.en }, p.bn || {});
    const en = this.fill(SEEK_TEXT[key][0], params).replace(/\s+\./g, '.').replace(/\s{2,}/g, ' ').trim();
    const bn = this.fill(SEEK_TEXT[key][1], paramsBn).replace(/\s{2,}/g, ' ').trim();
    this.lastSaidKey = key; this.lastSaidAt = now;
    setCaption(this.mode === 'guide' ? 'Guiding' : 'Searching', en, 'guidance', this.phase === 'search' ? 'busy' : null, bn);
    speak(en, bn);
    return true;
  },
  resolveTarget(noun) {
    let n = (noun || '').trim().toLowerCase().replace(/^(my|the|a|an)\s+/, '').replace(/^(আমার|আমাদের)\s+/, '');
    if (!n) return null;
    let vm = typeof findVocabMatch === 'function' ? findVocabMatch(n) : null;
    // Bangla genitive ("দরজার কাছে") and compound nouns ("fan switch") still resolve to the vocabulary.
    if (!vm && /[ঀ-৿]/.test(n)) { const alt = n.replace(/(ের|র|টা|টি)$/, ''); const v2 = findVocabMatch(alt); if (v2) { n = alt; vm = v2; } }
    if (!vm && n.includes(' ')) { const words = n.split(/\s+/); const v2 = findVocabMatch(words[words.length - 1]); if (v2 && words.length <= 3) return { en: n, bn: v2.bn, ids: [v2.id], coco: !!v2.coco, free: false }; }
    if (vm) {
      const ids = [vm.id];
      if (n === 'charger' || n === 'চার্জার') ids.push('laptop charger', 'phone charger');
      if (vm.id === 'table') ids.push('table');
      const uniq = [...new Set(ids)];
      return { en: vm.en, bn: vm.bn, ids: uniq, coco: uniq.some(id => (VOCAB_BY_ID[id] || {}).coco), free: false };
    }
    return { en: n, bn: n, ids: [], coco: false, free: true, prompts: [`a photo of ${withArticle(n)}`, `${withArticle(n)} on a table`, `${withArticle(n)} held in a hand`, `a close-up photo of ${withArticle(n)}`] };
  },
  async start(noun, mode = 'find', opts = {}) {
    const target = this.resolveTarget(noun);
    if (!target) return announce(SEEK_TEXT.what[0], SEEK_TEXT.what[1], 'guidance');
    if (withCamera(() => this.start(noun, mode, opts))) return;
    this.stop('restart');
    Object.assign(this, { active: true, mode, target, startedAt: Date.now(), lastSaidKey: '', lastSaidAt: 0, centerStreak: 0, missStreak: 0, phase: 'search', hintIdx: 0, textEmbeds: null, lastCand: null, ticks: 0 });
    state.seeking = true;
    if (typeof VoiceEngine !== 'undefined') VoiceEngine.stop();
    logEvent(`${mode === 'guide' ? 'Guiding to' : 'Searching for'}: ${target.en}`);
    if (!opts.quietStart) this.say(mode === 'guide' ? 'start_guide' : 'start', {}, true);
    heartSet({ x: 0.5, y: 0.5, mode: 'seek', label: target.en });
    ensureVisionModels().catch(() => {});
    if (engine.clip.status === 'idle') loadClip().catch(() => {});
    if (typeof DepthEngine !== 'undefined' && DepthEngine.status === 'idle' && DepthEngine.wanted()) DepthEngine.load().catch(() => {});
    if (target.free) this.prepareFreeText().catch(e => console.warn('seek text', e));
    this.schedule(400);
  },
  schedule(ms) { clearTimeout(this.timer); if (this.active) this.timer = setTimeout(() => this.tick().catch(e => { console.warn('seek tick', e); this.schedule(900); }), ms); },
  stop(reason) {
    const was = this.active;
    this.active = false; state.seeking = false; clearTimeout(this.timer); this.timer = null;
    if (!was) return;
    heartTicks(0); heartHide();
    if (reason === 'user') this.say('stopped', {}, true);
    if (reason === 'found') { playEarcon('confirm'); haptic('CONFIRM'); }
    if (reason !== 'restart') logEvent('Search ended: ' + reason);
  },
  async prepareFreeText() {
    if (engine.clip.status !== 'ready') { await loadClip(); }
    const { tokenizer, textModel } = engine.clip;
    const embed = async texts => { const inputs = tokenizer(texts, { padding: true, truncation: true }); const out = await textModel(inputs); return out.text_embeds.tolist().map(normalize); };
    this.textEmbeds = await embed(this.target.prompts);
  },
  tileRects(frame) {
    const w = frame.width, h = frame.height, s = Math.round(Math.min(w, h) * 0.5);
    const xs = [0, Math.round((w - s) / 2), w - s], ys = [0, Math.round((h - s) / 2), h - s];
    const rects = []; ys.forEach(y => xs.forEach(x => rects.push({ x, y, s })));
    return rects;
  },
  // A free-text target competes with the WHOLE vocabulary (not a handful of generic distractors),
  // so a pen cannot pass for a toothbrush just because "toothbrush" beat "a wall".
  scoreTile(emb) {
    const dot = (a, b) => { let d = 0; for (let k = 0; k < a.length; k++) d += a[k] * b[k]; return d; };
    if (this.target.free) {
      if (!this.textEmbeds) return 0;
      const te = engine.clip.textEmbeds, best = {};
      for (let i = 0; i < te.length; i++) { const d = dot(te[i], emb); const id = PROMPTS[i].id; if (best[id] == null || d > best[id]) best[id] = d; }
      const tgt = Math.max(...this.textEmbeds.map(e => dot(e, emb)));
      const logits = [tgt * 100, ...Object.values(best).map(v => v * 100)];
      const max = Math.max(...logits); let sum = 0; const ex = logits.map(l => { const v = Math.exp(l - max); sum += v; return v; });
      const p = ex[0] / sum, rank = logits.filter(l => l > logits[0]).length;
      return rank <= 2 ? p : 0;
    }
    const ranked = scoreEmbedding(emb);
    let p = 0; for (const r of ranked) if (this.target.ids.includes(r.id)) p = Math.max(p, r.p);
    return p;
  },
  async locate(frame) {
    let best = null;
    // 1. Boxes from the fast detector for classes it knows.
    if (this.target.coco && engine.coco.status === 'ready') {
      const objs = await runCoco(frame);
      if (typeof perceptionHook === 'function') perceptionHook(objs, frame, { noDepthKick: true });
      state.lastCocoPreds = objs;
      const hit = objs.filter(o => this.target.ids.includes(o.id) && o.score >= 0.45 && !(o.flags && (o.flags.onScreen || o.flags.picture))).sort((a, b) => b.score - a.score)[0];
      if (hit) best = { cx: (hit.bbox[0] + hit.bbox[2] / 2) / frame.width, cy: (hit.bbox[1] + hit.bbox[3] / 2) / frame.height, conf: hit.score, obj: hit, distM: hit.distM, distLower: hit.distLower, near01: hit.near01, areaFrac: (hit.bbox[2] * hit.bbox[3]) / (frame.width * frame.height), src: 'coco' };
    }
    // 2. Open-vocabulary tiles for everything else (and as a second opinion).
    if (!best && engine.clip.status === 'ready' && (!this.target.free || this.textEmbeds)) {
      const rects = this.tileRects(frame);
      const embs = await clipEmbedCrops(frame, rects);
      const thr = this.target.free ? 0.22 : 0.14;
      const ps = embs.map(emb => this.scoreTile(emb));
      const bp = Math.max(...ps), bi = ps.indexOf(bp);
      const med = ps.slice().sort((a, b) => a - b)[Math.floor(ps.length / 2)];
      // One real object lights up one to three tiles; a score spread evenly across the frame is noise.
      if (bi >= 0 && bp >= thr && bp >= 1.5 * med) {
        const r = rects[bi];
        const depth = typeof DepthEngine !== 'undefined' ? DepthEngine.fresh(Math.max(6000, DepthEngine.lastMs * 3)) : null;
        const near01 = depth ? DepthEngine.nearnessInBox(depth, [r.x, r.y, r.s, r.s], frame.width, frame.height) : null;
        best = { cx: (r.x + r.s / 2) / frame.width, cy: (r.y + r.s / 2) / frame.height, conf: bp, obj: null, distM: null, near01, areaFrac: null, src: 'clip' };
      }
    }
    return best;
  },
  async tick() {
    if (!this.active) return;
    if (!state.source) { this.stop('camera_off'); return; }
    this.ticks++;
    const frame = captureFrame(640);
    if (!frame || state.busy) return this.schedule(500);
    if (typeof DepthEngine !== 'undefined' && DepthEngine.status === 'ready' && !DepthEngine.busy && DepthEngine.due(1500)) { if (state.source !== 'camera' && !DepthEngine.last) await DepthEngine.run(frame); else DepthEngine.run(frame); }
    const now = Date.now();
    if (engine.clip.status !== 'ready' && !this.target.coco) { if (now - this.lastSaidAt > 8000) this.say('no_clip'); return this.schedule(1200); }
    const cand = await this.locate(frame);
    if (!this.active) return;
    if (!cand) {
      this.missStreak++;
      if (this.phase !== 'search' && this.missStreak >= 4) { this.phase = 'search'; this.centerStreak = 0; this.say('lost'); }
      else if (this.phase === 'search') {
        heartSet({ x: 0.5, y: 0.5, mode: 'seek', label: this.target.en }); heartTicks(0);
        if (now - this.startedAt > 75000) { this.say('give_up', {}, true); this.stop('give_up'); return; }
        if (now - this.lastSaidAt > 7000) { this.say(['not_yet_1', 'not_yet_2', 'not_yet_3'][this.hintIdx++ % 3]); }
      }
      return this.schedule(state.source === 'camera' ? 650 : 1500);
    }
    this.missStreak = 0; this.lastCand = cand;
    const dx = cand.cx - 0.5, dy = cand.cy - 0.5;
    const off = Math.hypot(dx, dy);
    heartSet({ x: cand.cx, y: cand.cy, mode: off < 0.2 ? 'lock' : 'seek', label: this.target.en });
    heartTicks(Math.round(900 - 650 * (1 - Math.min(1, off / 0.5))));
    let key;
    if (Math.abs(dx) > 0.22) key = dx < 0 ? 'turn_left' : 'turn_right';
    else if (Math.abs(dy) > 0.24) key = dy < 0 ? 'tilt_up' : 'tilt_down';
    else key = 'center';
    if (key === 'center') this.centerStreak++; else this.centerStreak = 0;
    const distObj = cand.obj || { distM: null, near01: cand.near01 };
    const dEn = distPhrase(distObj, false), dBn = distPhrase(distObj, true);
    if (this.phase === 'search') {
      if (key === 'center' && this.centerStreak >= 2) {
        this.phase = 'found';
        const within = (cand.distM != null && cand.distM <= 0.9) || (cand.near01 != null && cand.near01 >= 0.8) || (cand.areaFrac != null && cand.areaFrac > 0.18);
        let nextEn = SEEK_TEXT[within ? 'next_reach' : 'next_walk'][0], nextBn = SEEK_TEXT[within ? 'next_reach' : 'next_walk'][1];
        const obs = pathObstacles(cand.obj ? cand.obj.id : null).find(o => (o.near01 != null && cand.near01 != null ? o.near01 > cand.near01 + 0.08 : (o.distM != null && cand.distM != null ? o.distM < cand.distM - 0.3 : o.prox === 'very_close')));
        if (obs && !within) {
          const side = obs.cx < 0.5 ? 'right' : 'left';
          nextEn = this.fill(SEEK_TEXT.next_obstacle[0], { obs: objLabelWithArticle(obs), side });
          nextBn = this.fill(SEEK_TEXT.next_obstacle[1], { obs: 'একটি ' + objLabelBn(obs), side: side === 'right' ? 'ডানে' : 'বাঁয়ে' });
        }
        this.say(dEn ? 'found' : 'found_nodist', { dist: dEn, next: nextEn, bn: { dist: dBn, next: nextBn } }, true);
        playEarcon('confirm'); haptic('CONFIRM');
        if (typeof autoRecordMemory === 'function' && state.source === 'camera') autoRecordMemory({ item: this.target.en, location: 'in front of you' + (state.currentRoom ? ' in the ' + state.currentRoom : '') + ' (seen by the camera)', locationBn: (state.currentRoom ? state.currentRoom + '-এ, ' : '') + 'ক্যামেরায় সামনে দেখা গেছে', source: 'Found with camera', score: cand.conf });
        if (this.mode === 'find' && within) { this.stop('found'); return; }
      } else if (key !== 'center') { this.say(key); if (key === 'turn_left') haptic('LEFT'); else if (key === 'turn_right') haptic('RIGHT'); }
      return this.schedule(state.source === 'camera' ? 550 : 1500);
    }
    // Found: walk the user in, watching for the moment to stop.
    if (key !== 'center') { this.say(key); return this.schedule(600); }
    const arrived = (cand.distM != null && !cand.distWeak && cand.distM <= 0.45) || (cand.near01 != null && cand.near01 >= 0.88) || (cand.areaFrac != null && cand.areaFrac > 0.32);
    if (arrived) { this.say('stop_here', {}, true); this.stop('found'); return; }
    if (now - this.lastSaidAt > 3500) this.say('closer', { dist: dEn, bn: { dist: dBn } });
    this.schedule(state.source === 'camera' ? 550 : 1500);
  },
};

// "Where is my X?" now answers from memory, then offers to look with the camera.
function scoreMemoriesFor(q) {
  const cleanQ = q.replace(/[?!.,।]/g, '').trim(); if (!cleanQ) return state.memory.slice();
  const terms = cleanQ.split(/\s+/).filter(w => w.length >= 2);
  const vm = typeof findVocabMatch === 'function' ? findVocabMatch(cleanQ) : null;
  if (vm) { terms.push(vm.en.toLowerCase(), vm.bn); (vm.al || []).forEach(a => terms.push(a.toLowerCase())); }
  return state.memory.map(m => {
    const itemLower = m.item.toLowerCase(), target = (m.item + ' ' + m.location).toLowerCase();
    let score = 0;
    if (itemLower === cleanQ) score += 100; else if (itemLower.includes(cleanQ)) score += 70; else if (target.includes(cleanQ)) score += 40;
    for (const t of terms) { if (itemLower === t) score += 50; else if (itemLower.includes(t)) score += 25; else if (target.includes(t)) score += 10; }
    return { m, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score ||
    (new Date(b.m.time).getTime() || 0) - (new Date(a.m.time).getTime() || 0)).map(x => x.m);
}
function banglaLocation(m) {
  if (m.locationBn) return m.locationBn;
  return m.location.replace(/\bon the\b/gi, '').replace(/\bin the\b/gi, '').replace(/\bat\b/gi, '').replace(/\bnear the\b/gi, '')
    .replace(/dressing table/gi, 'ড্রেসিং টেবিলে').replace(/reading table/gi, 'পড়ার টেবিলে').replace(/table/gi, 'টেবিলে').replace(/bed/gi, 'বিছানায়').replace(/reading room/gi, 'রিডিং রুমে').replace(/bedroom/gi, 'শোবার ঘরে').replace(/living room/gi, 'বসার ঘরে').replace(/in front of the camera/gi, 'ক্যামেরার সামনে').replace(/in front of you/gi, 'আপনার সামনে').replace(/\(seen by the camera\)/gi, '').replace(/\s+/g, ' ').trim();
}
function memoryRecallText(memory) {
  const source = String(memory.source || '').trim();
  const photo = /photo|uploaded/i.test(source);
  const note = /^(your note|manual|voice placement|approved agent note|voice note|user-confirmed)/i.test(source);
  const camera = !photo && !note && /camera|observation|identified|ocr|visual/i.test(source);
  const provenance = photo ? ['Photo observation', 'ছবির পর্যবেক্ষণ'] : note ? ['Your note', 'আপনার নোট'] :
    camera ? ['Camera observation', 'ক্যামেরার পর্যবেক্ষণ'] : ['Saved record', 'সংরক্ষিত তথ্য'];
  const timestamp = memory.time === null || memory.time === undefined || memory.time === '' ? NaN : new Date(memory.time).getTime();
  const when = Number.isFinite(timestamp) && timestamp <= Date.now() + 60000 ? relativeTime(memory.time) : { en: '', bn: '' };
  const enTime = when.en || 'at an unknown time', bnTime = when.bn || 'সময় জানা নেই';
  return {
    en: `${provenance[0]} for ${memory.item}, saved ${enTime}, reports: ${memory.location}. Its current location is not confirmed.`,
    bn: `${memory.item}-এর ${provenance[1]}, সংরক্ষিত ${bnTime}, বলছে: ${banglaLocation(memory)}। বর্তমান অবস্থান নিশ্চিত নয়।`
  };
}
function findItems(query) {
  const raw = (query || '').toLowerCase().replace(/^(?:hey\s+)?(?:astha|asta|ashtha)[,.!\s]*/i, '').trim();
  const targetQuery = raw.replace(/[?!.,।]/g, '').replace(/^where did i (put|leave|keep)( my| the)?\s+/, 'find ')
    .replace(/^(search for|look for|locate|khojo|khuje dao)\s+/, 'find ');
  let q = typeof extractTargetItemFromQuery === 'function' ? extractTargetItemFromQuery(targetQuery) : null;
  if (!q) q = raw.replace(/^(where('s| is| are)?( my| the)?|where did i (put|leave|keep)( my| the)?|find( my| the)?|locate( my| the)?|search for( my| the)?|look for( my| the)?|আমার|কোথায়|কোথাই|কই)\s*/i, '').replace(/(কোথায়|কই|খোঁজো|খুঁজো|খুঁজে দাও|আছে)/g, '').replace(/[?!.,।]/g, '').trim();
  if (!q || /^(it|this|that|something|things)$/.test(q)) return announce(SEEK_TEXT.what[0], SEEK_TEXT.what[1], 'guidance');
  const vm = typeof findVocabMatch === 'function' ? findVocabMatch(q) : null;
  const itemEn = vm ? vm.en : q, itemBn = vm ? vm.bn : q;
  const records = scoreMemoriesFor(q);
  if (records.length) {
    const { en, bn } = memoryRecallText(records[0]);
    playEarcon('confirm');
    if (privacyMode) return announce(en, bn, 'memory');
    return askYesNo(en + ' Do you want me to look for it with the camera now?', bn + ' এখন ক্যামেরা দিয়ে খুঁজে দেখব?', () => Seeker.start(q, 'find'), () => announce('Okay.', 'ঠিক আছে।', 'voice'));
  }
  announce(`I have no note about your ${itemEn}. Let me look with the camera.`, `আপনার ${itemBn} সম্পর্কে কোনো নোট নেই। ক্যামেরা দিয়ে খুঁজে দেখি।`, 'memory');
  setTimeout(() => Seeker.start(q, 'find', { quietStart: true }), 400);
}

// ---- On-device speech recognition (Whisper tiny, ~41 MB) -------------------------
// Used automatically when there is no internet (the browser's own recogniser needs one),
// or always, if the user prefers. Push-to-talk: it records until you pause, then transcribes.
const OfflineEar = {
  id: 'onnx-community/whisper-tiny', asr: null, loading: null,
  get status() { return (engine.ear && engine.ear.status) || 'idle'; }, active: false, cancelFlag: false,
  wanted() { if (typeof remoteProcessingAllowed === 'function' && !remoteProcessingAllowed()) return true; try { if (localStorage.getItem('astha.offline_voice') === '1') return true; } catch (e) {} return navigator.onLine === false; },
  async load() {
    if (this.status === 'ready') return true;
    if (this.loading) return this.loading;
    setEngineState('ear', 'loading');
    this.loading = (async () => {
      try {
        const TF = engine.clip.lib || await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js');
        TF.env.allowLocalModels = false; engine.clip.lib = engine.clip.lib || TF;
        const files = {};
        const progress = p => { if (p.status === 'progress' && p.file) files[p.file] = (p.loaded || 0) / (p.total || 1); const vals = Object.values(files); if (vals.length) setProgress('ear', vals.reduce((a, b) => a + b, 0) / Math.max(vals.length, 3)); };
        this.asr = await TF.pipeline('automatic-speech-recognition', this.id, { dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' }, progress_callback: progress });
        setProgress('ear', 1); setEngineState('ear', 'ready'); logEvent('Offline voice model ready');
        return true;
      } catch (e) { console.warn('whisper load failed', e); setEngineState('ear', 'error'); setProgress('ear', null); this.loading = null; return false; }
    })();
    return this.loading;
  },
  async record(maxMs = 9000) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    let ctx; try { ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 }); } catch (e) { ctx = new (window.AudioContext || window.webkitAudioContext)(); }
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) {} }
    const src = ctx.createMediaStreamSource(stream), proc = ctx.createScriptProcessor(4096, 1, 1);
    const chunks = []; let speech = false, silentMs = 0, speechMs = 0, floor = 0.004, done = false; const t0 = Date.now();
    return new Promise(resolve => {
      const finish = () => {
        if (done) return; done = true;
        try { proc.disconnect(); src.disconnect(); } catch (e) {}
        stream.getTracks().forEach(tr => tr.stop()); ctx.close().catch(() => {});
        const total = chunks.reduce((n, c) => n + c.length, 0);
        let data = new Float32Array(total); let off = 0; chunks.forEach(c => { data.set(c, off); off += c.length; });
        if (ctx.sampleRate !== 16000) { // linear resample
          const ratio = ctx.sampleRate / 16000, out = new Float32Array(Math.floor(data.length / ratio));
          for (let i = 0; i < out.length; i++) { const p = i * ratio, j = Math.floor(p), f = p - j; out[i] = data[j] * (1 - f) + (data[j + 1] || 0) * f; }
          data = out;
        }
        resolve({ data, speech, ms: Date.now() - t0 });
      };
      proc.onaudioprocess = e => {
        if (this.cancelFlag) return finish();
        const d = e.inputBuffer.getChannelData(0); chunks.push(new Float32Array(d));
        let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] * d[i]; const rms = Math.sqrt(s / (d.length / 4));
        const chunkMs = d.length / ctx.sampleRate * 1000;
        const thr = Math.max(0.01, floor * 3.5);
        if (rms > thr) { speech = true; speechMs += chunkMs; silentMs = 0; } else { if (speech) silentMs += chunkMs; floor = 0.9 * floor + 0.1 * rms; }
        if ((speech && speechMs > 250 && silentMs > 1200) || Date.now() - t0 > maxMs || (!speech && Date.now() - t0 > 6500)) finish();
      };
      src.connect(proc); proc.connect(ctx.destination);
    });
  },
  langName() { const l = typeof sttLang === 'function' ? sttLang() : 'en-US'; return /^bn/i.test(l) ? 'bengali' : 'english'; },
  async transcribe(data) {
    const out = await this.asr(data, { language: this.langName(), task: 'transcribe' });
    let text = (out && out.text || '').trim();
    if (/^(thank you\.?|thanks for watching\.?|you\.?|bye\.?|\.+)$/i.test(text)) text = '';
    return text;
  },
  cancel() { this.cancelFlag = true; },
  uiOn() { $('mic')?.classList.add('listening'); $('mic')?.setAttribute('aria-pressed', 'true'); if ($('mic-label')) $('mic-label').textContent = 'Listening on this phone…'; },
  uiOff() { $('mic')?.classList.remove('listening'); $('mic')?.setAttribute('aria-pressed', 'false'); if ($('mic-label')) $('mic-label').textContent = t('mic_idle') || 'Microphone idle'; if (typeof SiriVoice !== 'undefined' && SiriVoice.enabled && navigator.onLine !== false) setTimeout(() => SiriVoice.start(), 200); },
  async listenAndHandle(reason) {
    if (this.active) { this.cancel(); return; }
    if (privacyMode || privacyTransition) return announce('Voice input is off in privacy mode. Type your request.', 'গোপনীয়তা মোডে কণ্ঠ শনাক্তকরণ বন্ধ। অনুরোধ লিখুন।');
    this.active = true; this.cancelFlag = false;
    if (typeof SiriVoice !== 'undefined' && SiriVoice.active) SiriVoice.stop(true);
    if (typeof VoiceEngine !== 'undefined') VoiceEngine.stop();
    this.uiOn();
    try {
      const loadP = this.load();
      if (reason === 'network' && !this._explained) { this._explained = true; setCaption(t('agent_voice'), 'No internet for the online recogniser. Listening on this phone instead.', 'voice', 'busy', 'ইন্টারনেট নেই, তাই এই ফোনেই শুনছি।'); }
      else setCaption(t('agent_voice'), this.status === 'ready' ? 'Listening on this phone… speak after the chime.' : 'Listening… the offline voice model is loading in the background (first time only).', 'voice', 'busy', 'এই ফোনেই শুনছি… শব্দের পরে বলুন।');
      playEarcon('confirm');
      const audio = await this.record(9000);
      if (this.cancelFlag) return;
      if (!audio.speech) { announce('I did not hear anything. Tap the microphone and speak after the chime.', 'কিছু শুনতে পাইনি। মাইক্রোফোন চেপে শব্দের পরে বলুন।', 'voice'); return; }
      setCaption(t('agent_voice'), 'Understanding…', 'voice', 'busy', 'বুঝছি…');
      const ok = await loadP;
      if (!ok) { announce('The offline voice model could not load. Connect once to download it, or type your request.', 'অফলাইন ভয়েস মডেল লোড হয়নি। একবার ইন্টারনেটে যুক্ত হয়ে ডাউনলোড করুন, বা লিখে বলুন।', 'voice'); return; }
      const text = await this.transcribe(audio.data);
      if (this.cancelFlag) return;
      if (!text) { announce('I could not make that out. Please say it again.', 'বুঝতে পারিনি। আবার বলুন।', 'voice'); return; }
      setCaption(t('agent_voice'), 'Heard: ' + text, 'voice');
      logEvent('Heard (offline): ' + text);
      handleQuery(text);
    } catch (e) { console.warn('offline ear', e); announce('The microphone could not be used. Check the permission.', 'মাইক্রোফোন ব্যবহার করা যায়নি। অনুমতি দেখুন।', 'voice'); }
    finally { this.active = false; this.uiOff(); }
  },
};

// One-tap listening: the browser recogniser when online, Whisper on the phone otherwise.
// The Android app has no browser speech recognition, so one request uses the device recognizer.
async function listenOnDevice() {
  if (privacyMode || privacyTransition) return announce('Voice recognition is off in privacy mode. Type your request.', 'গোপনীয়তা মোডে কণ্ঠ শনাক্তকরণ বন্ধ। অনুরোধ লিখে দিন।', 'voice');
  if (reader.active) pauseReader(); else VoiceEngine.stop();
  state.listening = true;
  $('mic').setAttribute('aria-label', 'Stop listening'); $('mic').setAttribute('aria-pressed', 'true'); $('mic').classList.add('listening');
  $('mic-label').textContent = t('mic_listening');
  setCaption(t('agent_voice'), 'Listening… take your time.', 'voice', 'busy', 'শুনছি… ধীরে বলুন।');
  playEarcon('confirm');
  let text = '', failure = null;
  const onDeviceOnly = !remoteProcessingAllowed() || OfflineEar.wanted();
  try { text = (await window.AsthaNative.listen(sttLang(), { onDeviceOnly })).trim(); } catch (error) { failure = error && error.code; }
  if (!state.listening) return;   // the user tapped again to cancel
  stopListening();
  if (failure === 'permission') return announce('Microphone access was denied.', 'মাইক্রোফোনের অনুমতি নেই।', 'voice');
  if (failure === 'on_device_unavailable' || failure === 'language_unavailable') return OfflineEar.listenAndHandle('native_unavailable');
  if (failure === 'recognizer_unavailable') return announce('This phone has no speech recognizer installed. Type your request instead.', 'এই ফোনে কণ্ঠ শনাক্ত করার ব্যবস্থা নেই। অনুরোধ লিখে দিন।', 'voice');
  if (text) return handleQuery(text);
  setCaption(t('agent_voice'), 'I did not hear anything. Tap the microphone and speak after the chime.', 'voice', null, 'কিছু শুনতে পাইনি। মাইক্রোফোন চেপে শব্দের পরে বলুন।');
}
function toggleListening() {
  const device = window.AsthaNative && window.AsthaNative.canListen ? window.AsthaNative : null;
  if (state.listening) { if (device) device.stopListening(); stopListening(); return; }
  if (OfflineEar.active) { OfflineEar.cancel(); return; }
  if (device) { listenOnDevice(); return; }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR || OfflineEar.wanted()) return OfflineEar.listenAndHandle(!SR ? 'nosr' : (navigator.onLine === false ? 'network' : 'pref'));
  if (privacyMode || privacyTransition) return announce('Voice recognition is off in privacy mode. Type your request.', 'গোপনীয়তা মোডে অনলাইন কণ্ঠ শনাক্তকরণ বন্ধ। অনুরোধ লিখুন।');
  if (reader.active) pauseReader(); else VoiceEngine.stop();
  if (typeof SiriVoice !== 'undefined' && SiriVoice.active) SiriVoice.stop(true);
  state.listening = true;
  $('mic').setAttribute('aria-label', 'Stop listening'); $('mic').setAttribute('aria-pressed', 'true'); $('mic').classList.add('listening');
  $('mic-label').textContent = t('mic_listening');
  setCaption(t('agent_voice'), 'Listening… take your time.', 'voice', 'busy', 'শুনছি… ধীরে বলুন।');
  playEarcon('confirm');
  let finalText = '', gotSpeech = false, handedOff = false;
  const finish = () => {
    clearTimeout(listenTimer);
    const text = finalText.trim();
    stopListening();
    if (handedOff) return;
    if (text) handleQuery(text);
    else { setCaption(t('agent_voice'), 'I did not hear anything. Tap the microphone and speak after the chime.', 'voice', null, 'কিছু শুনতে পাইনি। মাইক্রোফোন চেপে শব্দের পরে বলুন।'); speak('I did not hear anything. Tap the microphone and speak after the chime.', 'কিছু শুনতে পাইনি। মাইক্রোফোন চেপে শব্দের পরে বলুন।'); }
  };
  try {
    recognizer = new SR();
    recognizer.lang = sttLang(); recognizer.continuous = true; recognizer.interimResults = true; recognizer.maxAlternatives = 1;
    recognizer.onresult = e => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) { const tr = e.results[i][0].transcript; if (e.results[i].isFinal) finalText += ' ' + tr; else interim += tr; }
      gotSpeech = true;
      setCaption(t('agent_voice'), 'Heard: ' + (finalText + ' ' + interim).trim(), 'voice', 'busy');
      clearTimeout(listenTimer);
      listenTimer = setTimeout(finish, finalText.trim() ? 2200 : 3500);
    };
    recognizer.onerror = ev => {
      if (ev.error === 'no-speech') return;
      console.warn('speech', ev.error);
      if (ev.error === 'not-allowed') { stopListening(); announce('Microphone access was denied.', 'মাইক্রোফোনের অনুমতি নেই।', 'voice'); return; }
      if (ev.error === 'network' || ev.error === 'service-not-allowed') { handedOff = true; clearTimeout(listenTimer); stopListening(); OfflineEar.listenAndHandle('network'); }
    };
    recognizer.onend = () => { if (state.listening) { if (finalText.trim()) finish(); else if (!gotSpeech && Date.now() - listenStart < 11000) { try { recognizer.start(); } catch (e) {} } else finish(); } };
    const listenStart = Date.now();
    recognizer.start();
    listenTimer = setTimeout(finish, 12000);
  } catch (e) { console.warn(e); stopListening(); }
}
function stopAllSpeech() {
  // Drop answers that have not been spoken yet, and end a hazard alert as well.
  if (typeof AsthaExperience !== 'undefined') AsthaExperience.cancelPending();
  if (typeof AsthaCancellation !== 'undefined') AsthaCancellation.cancel();
  state.pendingAction = null; state.pendingRead = false;
  state.busyToken = null; state.busy = false;
  $('companion-main')?.setAttribute('aria-busy', 'false');
  if (typeof AsthaAgent !== 'undefined') AsthaAgent.cancel?.();
  if (typeof reading !== 'undefined' && reading.active) stopReading(true);
  stopReader(); stopListening(); VoiceEngine.stop(true);
  if (typeof VideoRoomCalib !== 'undefined' && VideoRoomCalib.active) {
    VideoRoomCalib.active = false; clearInterval(VideoRoomCalib.timer); VideoRoomCalib.timer = null;
    if ($('calib-start-btn')) $('calib-start-btn').textContent = t('calib_resume');
  }
  if (typeof Seeker !== 'undefined' && Seeker.active) Seeker.stop('user');
  if (OfflineEar.active) OfflineEar.cancel();
  $('reader-progress').textContent = t('reader_stopped');
}

// ---- "Works without internet": download everything once, then never need it ------
const OfflinePack = {
  running: false,
  parts: [
    { key: 'coco', en: 'object detector', bn: 'বস্তু শনাক্তকারী', ready: () => engine.coco.status === 'ready', run: () => loadCoco() },
    { key: 'clip', en: 'object recogniser', bn: 'বস্তু চেনার মডেল', ready: () => engine.clip.status === 'ready', run: () => loadClip() },
    { key: 'ocr', en: 'text reader', bn: 'লেখা পড়ার মডেল', ready: () => engine.ocr.status === 'ready', run: () => ensureOcr() },
    { key: 'depth', en: 'distance model', bn: 'দূরত্ব মাপার মডেল', ready: () => DepthEngine.status === 'ready', run: () => DepthEngine.load() },
    { key: 'ear', en: 'offline voice input', bn: 'অফলাইন কণ্ঠ শনাক্তকরণ', ready: () => OfflineEar.status === 'ready', run: () => OfflineEar.load() },
  ],
  done() { try { return JSON.parse(localStorage.getItem('astha.offline.parts') || '[]'); } catch (e) { return []; } },
  markDone(key) { const d = new Set(this.done()); d.add(key); try { localStorage.setItem('astha.offline.parts', JSON.stringify([...d])); localStorage.setItem('astha.offline.at', new Date().toISOString()); } catch (e) {} this.renderStatus(); },
  renderStatus() {
    const pill = $('offline-pill'), status = $('offline-status'); if (!pill) return;
    const n = this.parts.filter(p => p.ready()).length;
    const online = navigator.onLine !== false;
    pill.textContent = n >= this.parts.length ? 'Models loaded' : n ? `${n} of ${this.parts.length} models loaded` : 'Models not verified';
    pill.className = 'pill ' + (n >= this.parts.length ? 'ok' : n ? 'warn' : '');
    if (status) status.textContent = (online ? 'Connected. ' : 'No internet right now. ') + (n >= this.parts.length ? 'Models initialized in this session. Test again after reopening with the internet off; browser storage can be cleared or evicted.' : 'Tap Prepare to initialize the models (about 260 MB). Previous downloads do not guarantee availability after storage is cleared.');
  },
  async prepare() {
    if (this.running) return announce('Still preparing. I will tell you when it is done.', 'এখনো প্রস্তুত করছি। শেষ হলে বলব।', 'system');
    this.running = true;
    const btn = $('offline-prepare-btn'); if (btn) btn.disabled = true;
    announce('Preparing Astha for offline use. This downloads the models once; keep the app open.', 'অফলাইনে চালানোর জন্য আস্থাকে প্রস্তুত করছি। মডেলগুলো একবার ডাউনলোড হবে; অ্যাপটি খোলা রাখুন।', 'system');
    let ok = 0;
    for (const p of this.parts) {
      try {
        if (!p.ready()) { setCaption('Preparing offline', `Downloading the ${p.en}…`, 'system', 'busy', `${p.bn} ডাউনলোড হচ্ছে…`); await p.run(); }
        if (p.ready()) { ok++; this.markDone(p.key); }
      } catch (e) { console.warn('offline pack', p.key, e); }
    }
    this.running = false; if (btn) btn.disabled = false;
    this.renderStatus();
    if (ok >= this.parts.length) announce('Models loaded. Reopen with the internet off to check that the downloads are available.', 'মডেল লোড হয়েছে। ডাউনলোডগুলো পাওয়া যাচ্ছে কি না যাচাই করতে ইন্টারনেট বন্ধ করে অ্যাপটি আবার খুলুন।', 'system');
    else announce(`${ok} of ${this.parts.length} parts are ready. The rest could not download; try again later.`, `${bnDigits(ok)}টির মধ্যে ${bnDigits(this.parts.length)}টি অংশ প্রস্তুত। বাকিগুলো ডাউনলোড হয়নি; পরে আবার চেষ্টা করুন।`, 'system');
  },
};

// ---- Voice routing for the new abilities ----
function nounAfter(q, re) { const m = q.match(re); if (!m) return ''; return q.slice(m.index + m[0].length).replace(/[?!.,।]/g, '').replace(/\b(please|now|for me|quickly)\b/g, '').trim(); }
function offlineRoute(query, q) {
  // If Gemini Online AI is active and ready, DO NOT intercept visual questions,
  // scene descriptions, room reasoning, blackboard reading, or searches with rigid offline logic!
  // Route them to Gemini and the main agentic loop!
  if (typeof cloudReady === 'function' && cloudReady()) {
    if (Seeker.active && /\b(found it|got it|i have it|i got it|i see it|thanks|thank you)\b|পেয়েছি|পেয়ে গেছি|হয়েছে|peyechi/.test(q)) { Seeker.stop('found'); announce('Great.', 'বাহ, ভালো।', 'voice'); return true; }
    if (Seeker.active && /\b(stop (looking|searching|guiding)|cancel|never mind|forget it)\b|খোঁজা বন্ধ|থাক/.test(q)) { Seeker.stop('user'); return true; }
    // The Pi's distance sensor and the depth model are on this phone; the online assistant cannot use them.
    if (/\b(which way (should|can|do) i (go|walk|turn)|where can i (walk|go)|what('s| is) on (each|either|both) sides?|how far .* on (each|either|both) sides?|spatial (view|layout|map))\b|কোন দিকে (ফাঁকা|যাব|জায়গা)|চারদিকে কত দূরে|দুই পাশে কী|দুপাশে কী/.test(q)) { answerSpatial(); return true; }
    if (/how far|কত ?দূরে|koto dure/.test(q) && state.source === 'pi' && typeof AsthaSensors !== 'undefined' && AsthaSensors.measured('front')) { answerHowFar(query); return true; }
    if (/prepare (for |me for )?offline|download (the |all )?models|work offline|go offline|make (it|astha) work without internet|অফলাইন/.test(q)) { OfflinePack.prepare(); return true; }
    if (/\b(am i|are we|are you) (online|offline|connected)\b|is there internet|do (i|we) have internet|ইন্টারনেট আছে|নেট আছে/.test(q)) { announce('Internet is connected. Cloud mode has permission and credentials; a successful model response has not yet been confirmed.', 'ইন্টারনেট সংযোগ আছে। ক্লাউড মোডে অনুমতি ও পরিচয়পত্র আছে; মডেলের সফল উত্তর এখনো নিশ্চিত করা হয়নি।', 'system'); return true; }
    return false;
  }
  if (Seeker.active && /\b(found it|got it|i have it|i got it|i see it|thanks|thank you)\b|পেয়েছি|পেয়ে গেছি|হয়েছে|peyechi/.test(q)) { Seeker.stop('found'); announce('Great.', 'বাহ, ভালো।', 'voice'); return true; }
  if (Seeker.active && /\b(stop (looking|searching|guiding)|cancel|never mind|forget it)\b|খোঁজা বন্ধ|থাক/.test(q)) { Seeker.stop('user'); return true; }
  const guide = q.match(/\b(guide me to|take me to|lead me to|walk me to|navigate (me )?to|bring me to|how do i get to|help me reach)\s+(the |my |a |an )?/);
  if (guide) { Seeker.start(nounAfter(q, guide[0]), 'guide'); return true; }
  const guideBn = q.match(/([ঀ-৿\s]+?)(?:-?এর| এর)?\s*(কাছে নিয়ে (?:চলো|যাও)|পথ দেখাও|দিকে নিয়ে (?:চলো|যাও))/);
  if (guideBn) { Seeker.start(guideBn[1].replace(/আমাকে|আমায়/g, '').trim(), 'guide'); return true; }
  if (/how far|কত ?দূরে|koto dure/.test(q)) { answerHowFar(query); return true; }
  if (/\b(which way (should|can|do) i (go|walk|turn)|where can i (walk|go)|what('s| is) on (each|either|both) sides?|how far .* on (each|either|both) sides?|spatial (view|layout|map))\b|কোন দিকে (ফাঁকা|যাব|জায়গা)|চারদিকে কত দূরে|দুই পাশে কী|দুপাশে কী/.test(q)) { answerSpatial(); return true; }
  if (/(which|what) room|what kind of (room|place)|what place is this|কোন ঘর|কোন রুম|kon ghor/.test(q)) { answerWhichRoom(); return true; }
  if (/describe (it |everything )?in detail|in detail|full description|বিস্তারিত/.test(q)) { describeScene(undefined, true); return true; }
  if (/what('s| is) (happening|going on)|whats (happening|going on)|what is around me|summari[sz]e|give me a summary|কী হচ্ছে|কি হচ্ছে|সারাংশ|ki hocche|ki hochche/.test(q)) { describeScene(); return true; }
  if (/prepare (for |me for )?offline|download (the |all )?models|work offline|offline mode|go offline|make (it|astha) work without internet|অফলাইন/.test(q)) { OfflinePack.prepare(); return true; }
  if (/\b(am i|are we|are you) (online|offline|connected)\b|is there internet|do (i|we) have internet|ইন্টারনেট আছে|নেট আছে/.test(q)) { announce(navigator.onLine === false ? 'No internet right now. I keep working on this phone.' : 'You are connected to the internet.', navigator.onLine === false ? 'এখন ইন্টারনেট নেই। আমি এই ফোনেই কাজ চালিয়ে যাচ্ছি।' : 'আপনি ইন্টারনেটে যুক্ত আছেন।', 'system'); return true; }
  if (/^(search for|look for|find|locate)\s+(my |the |a |an )?\S/.test(q) && !/\band\b/.test(q)) { findItems(query); return true; }
  return false;
}
try {
  INTENTS.unshift(
    { id: 'seek', run: q => offlineRoute(q, q.toLowerCase()), kw: ['guide me to', 'take me to', 'lead me to', 'navigate to', 'how far', 'which room', 'what room', 'in detail', 'what is happening', "what's happening", 'going on', 'prepare offline', 'work offline', 'which way', 'each side', 'both sides', 'where can i walk', 'spatial', 'কোন দিকে', 'দুই পাশে', 'দুপাশে', 'পথ দেখাও', 'নিয়ে চলো', 'কত দূরে', 'কোন ঘর', 'বিস্তারিত', 'কী হচ্ছে', 'অফলাইন', 'koto dure', 'kon ghor'] },
  );
} catch (e) {}

// Engine status changes update the offline pill and remember which parts are on this phone.
function setEngineState(key, status) {
  if (!engine[key]) engine[key] = { status: 'idle' };
  engine[key].status = status;
  const pill = $('state-' + key);
  if (pill) { pill.textContent = t('state_' + status); pill.className = 'pill ' + ({ idle: '', loading: 'warn', ready: 'ok', error: 'danger' }[status] || ''); }
  if (status === 'ready' && typeof OfflinePack !== 'undefined' && OfflinePack.parts.some(p => p.key === key)) OfflinePack.markDone(key);
}

// ---- UI: engine rows, preferences, the offline card ----
function setDepthPref(v) { try { localStorage.setItem('astha.depth', v); } catch (e) {} if (v === '1' && DepthEngine.status === 'idle') DepthEngine.load().catch(() => {}); announce(v === '1' ? 'Distance sensing on.' : 'Distance sensing off. I will still judge distance from size.', v === '1' ? 'দূরত্ব মাপা চালু।' : 'দূরত্ব মাপার মডেল বন্ধ। আকার দেখে আন্দাজ করব।', 'system'); }
function setOfflineVoicePref(v) { try { localStorage.setItem('astha.offline_voice', v); } catch (e) {} if (v === '1') OfflineEar.load().catch(() => {}); announce(v === '1' ? 'Voice input now stays on this phone.' : 'Voice input uses the online recogniser when connected.', v === '1' ? 'কণ্ঠ শনাক্তকরণ এখন এই ফোনেই হবে।' : 'সংযোগ থাকলে অনলাইন শনাক্তকারী ব্যবহার হবে।', 'system'); }
function offlineBoot() {
  engine.depth = engine.depth || { status: 'idle' }; engine.ear = engine.ear || { status: 'idle' };
  // Engine rows
  const ocrRow = $('state-ocr') && $('state-ocr').closest('.engine-row');
  if (ocrRow && !$('state-depth')) {
    ocrRow.insertAdjacentHTML('afterend',
      '<div class="engine-row"><div><div class="name">Distance model</div><div class="sub">Depth Anything V2 small · relative depth · 27 MB</div><div class="progress" id="prog-depth-wrap" hidden><i id="prog-depth"></i></div></div><span class="pill" id="state-depth">Not loaded</span></div>' +
      '<div class="engine-row"><div><div class="name">Offline voice input</div><div class="sub">Whisper tiny · English + Bangla · 41 MB</div><div class="progress" id="prog-ear-wrap" hidden><i id="prog-ear"></i></div></div><span class="pill" id="state-ear">Not loaded</span></div>');
  }
  // Offline card above the model diagnostics
  const details = ocrRow && ocrRow.closest('details');
  if (details && !$('offline-card')) {
    const card = document.createElement('div'); card.className = 'card'; card.id = 'offline-card';
    card.innerHTML = '<div class="card-head"><h2>Works without internet</h2><span class="pill" id="offline-pill">Checking…</span></div>' +
      '<p class="help">Download models for on-device detection, reading and voice input. Select offline mode to keep requests on this phone. Distance estimates are approximate; test after reopening without internet.</p>' +
      '<div class="utility-row"><button class="btn accent" id="offline-prepare-btn" onclick="OfflinePack.prepare()">Prepare for offline use</button></div>' +
      '<p class="help" id="offline-status" role="status"></p>';
    details.parentElement.insertBefore(card, details);
  }
  // Preferences
  const ds = $('description-style') && $('description-style').closest('label');
  if (ds && !$('depth-pref')) {
    let depthPref = '1', voicePref = '0';
    try { depthPref = localStorage.getItem('astha.depth') || '1'; voicePref = localStorage.getItem('astha.offline_voice') || '0'; } catch (e) {}
    ds.insertAdjacentHTML('afterend',
      `<label class="field" for="depth-pref">Distance sensing<select class="select-dropdown" id="depth-pref" onchange="setDepthPref(this.value)"><option value="1"${depthPref === '1' ? ' selected' : ''}>On (depth model, downloads once)</option><option value="0"${depthPref === '0' ? ' selected' : ''}>Off (save battery; size-based only)</option></select></label>` +
      `<label class="field" for="offline-voice-pref">Voice input<select class="select-dropdown" id="offline-voice-pref" onchange="setOfflineVoicePref(this.value)"><option value="0"${voicePref === '0' ? ' selected' : ''}>Online recogniser when connected, this phone when offline</option><option value="1"${voicePref === '1' ? ' selected' : ''}>Always on this phone (Whisper, a little slower)</option></select></label>`);
  }
  OfflinePack.renderStatus();
  let lastNet = navigator.onLine;
  const onNet = () => { if (navigator.onLine === lastNet) return; lastNet = navigator.onLine; OfflinePack.renderStatus(); announce(navigator.onLine ? 'Internet is back.' : 'Internet connection lost. I keep working on this phone; tap the microphone to talk to me.', navigator.onLine ? 'ইন্টারনেট ফিরে এসেছে।' : 'ইন্টারনেট সংযোগ নেই। আমি এই ফোনেই কাজ চালিয়ে যাচ্ছি; কথা বলতে মাইক্রোফোন চাপুন।', 'system'); };
  window.addEventListener('online', onNet); window.addEventListener('offline', onNet);
  // Camera stopping ends any search.
  document.addEventListener('visibilitychange', () => { if (document.hidden && Seeker.active) Seeker.stop('hidden'); });
  // Preferred offline voice: warm the model in the background.
  try { if (localStorage.getItem('astha.offline_voice') === '1') setTimeout(() => OfflineEar.load().catch(() => {}), 4000); } catch (e) {}
  // Help text now mentions the new abilities.
  logEvent('Offline companion ready');
}
function showCommandHelp() {
  announce('Tap the microphone, then say: describe my surroundings. What is happening around me? How far is the chair? Read this. Find my charger. Guide me to the door. I am keeping my wallet on the table. Where is my wallet? Is anything moving? Prepare for offline use. Stop.',
    'মাইক্রোফোন চাপুন, তারপর বলুন: চারপাশ বলো। কী হচ্ছে? চেয়ার কত দূরে? এটা পড়ো। আমার চার্জার খোঁজো। দরজার কাছে নিয়ে চলো। আমার মানিব্যাগ টেবিলে রাখছি। আমার মানিব্যাগ কোথায়? কিছু নড়ছে? অফলাইন প্রস্তুত করো। থামো।');
}
