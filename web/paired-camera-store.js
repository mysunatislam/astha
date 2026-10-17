// Remembered camera credentials belong to this browser origin and one explicit profile.
// Nothing here is uploaded, exported, placed in a URL, or written to localStorage.
// In the Android app the record is sealed by an Android Keystore key instead (see
// CameraPairingVault.java); in a browser it is sealed by a non-extractable WebCrypto key
// kept in IndexedDB, which protects it from casual copying but not from code running in
// this origin or from someone with this browser profile's files.
(function (win) {
  'use strict';
  const DATABASE = 'astha-paired-camera-v1', STORE = 'profiles', VERSION = 1, MAX_FALLBACKS = 4;
  const CODES = new Set(['invalid_profile', 'invalid_pairing', 'unavailable', 'storage_blocked', 'storage_failed', 'invalid_record', 'decrypt_failed', 'cancelled']);
  let mutations = Promise.resolve();
  const failure = code => Object.assign(new Error(code), { code });
  const safeError = error => failure(CODES.has(error?.code) ? error.code : 'storage_failed');
  function guard(current) {
    let allowed = false;
    try { allowed = typeof current === 'function' && current() === true; } catch {}
    if (!allowed) throw failure('cancelled');
  }
  function profileId(profile) {
    if (typeof profile !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(profile)) throw failure('invalid_profile');
    return profile;
  }
  function originValue(origin) {
    if (typeof origin !== 'string' || origin.length > 2048) throw failure('invalid_pairing');
    let url;
    try { url = new URL(origin); } catch { throw failure('invalid_pairing'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
        ![url.origin, url.origin + '/'].includes(origin)) throw failure('invalid_pairing');
    return url.origin;
  }
  // Addresses that have actually worked, newest first, never repeating the main address.
  function fallbackValue(list, origin) {
    if (list == null) return [];
    if (!Array.isArray(list)) throw failure('invalid_pairing');
    const result = [];
    for (const item of list) {
      const value = originValue(item);
      if (value !== origin && !result.includes(value)) result.push(value);
    }
    return result.slice(0, MAX_FALLBACKS);
  }
  const validToken = token => typeof token === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(token);
  function deviceValue(device) {
    if (device == null) return null;
    if (typeof device !== 'object' || Array.isArray(device)) throw failure('invalid_pairing');
    const result = {};
    for (const name of ['model', 'backend']) if (typeof device[name] === 'string') result[name] = device[name].replace(/[^\x20-\x7e]/g, '').slice(0, 80);
    if (typeof device.id === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(device.id)) result.id = device.id;
    if (typeof device.name === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(device.name)) result.name = device.name;
    if (device.proof === true) result.proof = true;
    return result;
  }
  // Android's sealed store, when this page runs inside the ASTHA app.
  function native() {
    const pairing = win.AsthaNative?.pairing;
    return pairing && typeof pairing.save === 'function' && typeof pairing.load === 'function' ? pairing : null;
  }
  const kind = () => native() ? 'android-keystore' : (win.indexedDB?.open && win.crypto?.subtle ? 'browser' : null);
  function capabilities() {
    if (!win.indexedDB?.open || !win.crypto?.subtle || !win.crypto?.getRandomValues || typeof TextEncoder !== 'function' || typeof TextDecoder !== 'function') throw failure('unavailable');
  }
  const aad = (profile, origin) => new TextEncoder().encode(JSON.stringify(['astha.paired-camera.v1', profile, origin]));
  function validateRecord(record) {
    try {
      if (!record || record.version !== VERSION || typeof record.autoConnect !== 'boolean' || originValue(record.origin) !== record.origin ||
          !(record.iv instanceof Uint8Array) || record.iv.byteLength !== 12 || !(record.ciphertext instanceof Uint8Array) ||
          record.ciphertext.byteLength < 59 || record.ciphertext.byteLength > 144 || record.key?.type !== 'secret' ||
          record.key.extractable !== false || record.key.algorithm?.name !== 'AES-GCM' || record.key.algorithm.length !== 256 ||
          !record.key.usages?.includes('encrypt') || !record.key.usages?.includes('decrypt')) throw failure('invalid_record');
      deviceValue(record.device);
      if (JSON.stringify(fallbackValue(record.fallbacks, record.origin)) !== JSON.stringify(record.fallbacks || [])) throw failure('invalid_record');
    } catch { throw failure('invalid_record'); }
    return record;
  }
  const publicSummary = (record, storage = 'browser') => record ? { origin: record.origin, fallbacks: [...(record.fallbacks || [])],
    device: deviceValue(record.device), autoConnect: record.autoConnect, storage } : null;
  function open(current) {
    guard(current); capabilities();
    return new Promise((resolve, reject) => {
      let finished = false, request;
      const finish = (error, db) => {
        if (finished) { db?.close(); return; }
        finished = true; clearTimeout(timeout);
        if (error) reject(error); else resolve(db);
      };
      const timeout = setTimeout(() => finish(failure('storage_blocked')), 3000);
      try { request = win.indexedDB.open(DATABASE, VERSION); }
      catch { finish(failure('storage_failed')); return; }
      request.onblocked = () => finish(failure('storage_blocked'));
      request.onerror = () => finish(failure('storage_failed'));
      request.onupgradeneeded = () => {
        try {
          guard(current);
          if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
        } catch { try { request.transaction.abort(); } catch {} }
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        try { guard(current); finish(null, db); }
        catch (error) { db.close(); finish(error); }
      };
    });
  }
  // Keep every authorization check in the same task as the write. Recheck on the
  // request event too, so cancellation before commit aborts the whole transaction.
  function transaction(db, mode, current, action) {
    guard(current);
    return new Promise((resolve, reject) => {
      let tx, result, error, monitor;
      const abort = reason => { error = reason; try { tx.abort(); } catch {} };
      const check = () => { try { guard(current); return true; } catch (reason) { abort(reason); return false; } };
      try {
        tx = db.transaction(STORE, mode);
        tx.oncomplete = () => { clearInterval(monitor); try { guard(current); resolve(result); } catch (reason) { reason.committed = mode === 'readwrite'; reject(reason); } };
        tx.onabort = () => { clearInterval(monitor); reject(error || failure('storage_failed')); };
        tx.onerror = () => { error ||= failure('storage_failed'); };
        monitor = setInterval(check, 10);
        const watch = request => {
          request.onerror = () => { error ||= failure('storage_failed'); };
          request.onsuccess = () => check();
          return request;
        };
        action(tx.objectStore(STORE), value => { result = value; }, check, watch, abort);
      } catch (reason) {
        clearInterval(monitor);
        if (tx) abort(safeError(reason)); else reject(safeError(reason));
      }
    });
  }
  async function read(profile, current) {
    await mutations; guard(current);
    const db = await open(current);
    try {
      const record = await transaction(db, 'readonly', current, (store, done, check) => {
        const request = store.get(profile);
        request.onsuccess = () => { if (check()) done(request.result || null); };
      });
      guard(current);
      return record ? validateRecord(record) : null;
    } finally { db.close(); }
  }
  function mutate(current, work) {
    const result = mutations.then(async () => { guard(current); return work(); });
    mutations = result.then(() => {}, () => {});
    return result;
  }
  const writeId = () => Array.from(win.crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  // IndexedDB has committed before firing oncomplete. If permission changes in
  // that narrow window, undo only our own write before releasing the mutation
  // barrier. Another tab's newer record must never be removed by this rollback.
  async function writeRecord(db, profile, record, current) {
    let previous = null;
    try {
      await transaction(db, 'readwrite', current, (store, done, check, watch) => {
        const request = store.get(profile);
        request.onsuccess = () => {
          if (!check()) return;
          previous = request.result || null;
          if (check()) watch(store.put(record, profile));
        };
      });
    } catch (error) {
      if (error.committed) await transaction(db, 'readwrite', () => true, (store, done, check, watch) => {
        const request = store.get(profile);
        request.onsuccess = () => {
          if (request.result?.writeId !== record.writeId) return;
          if (previous) watch(store.put(previous, profile)); else watch(store.delete(profile));
        };
      });
      throw error;
    }
  }
  // Native answers are checked as strictly as browser records before anything uses them.
  function nativeSummary(reply, withToken) {
    if (reply == null) return null;
    try {
      const origin = originValue(reply.origin);
      const summary = { origin, fallbacks: fallbackValue(reply.fallbacks, origin), device: deviceValue(reply.device),
        autoConnect: reply.autoConnect !== false, storage: 'android-keystore' };
      if (!withToken) return summary;
      if (!validToken(reply.token)) throw failure('invalid_record');
      return { ...summary, token: reply.token };
    } catch { throw failure('invalid_record'); }
  }
  // A native bridge call may commit before JavaScript learns that the user disconnected,
  // hid the page or changed profile. Compensate before releasing the mutation barrier.
  // The vault compares encrypted write receipts, so another caller's newer save survives.
  async function nativeWrite(sealed, profile, work, current) {
    const reply = await work();
    try { guard(current); return nativeSummary(reply, false); }
    catch (error) {
      const receipt = reply?.rollback;
      if (!receipt || typeof receipt.after !== 'string' || !/^(?:[0-9a-f]{2}){1,4096}$/.test(receipt.after) ||
          receipt.before !== null && (typeof receipt.before !== 'string' || !/^(?:[0-9a-f]{2}){1,4096}$/.test(receipt.before)) ||
          typeof sealed.rollback !== 'function') throw failure('storage_failed');
      try { await sealed.rollback(profile, { before: receipt.before, after: receipt.after }); }
      catch { throw failure('storage_failed'); }
      throw error;
    }
  }
  async function save(profile, value, current = () => true) {
    try {
      profileId(profile); guard(current);
      const origin = originValue(value?.origin), token = value?.token, device = deviceValue(value?.device);
      const fallbacks = fallbackValue(value?.fallbacks, origin);
      if (!validToken(token)) throw failure('invalid_pairing');
      const sealed = native();
      if (sealed) return await mutate(current, async () => {
        return nativeWrite(sealed, profile, () => sealed.save(profile, { origin, token, device, fallbacks, autoConnect: true }), current);
      });
      capabilities();
      return await mutate(current, async () => {
        const key = await win.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        guard(current);
        const iv = win.crypto.getRandomValues(new Uint8Array(12));
        const bytes = new TextEncoder().encode(token);
        let ciphertext;
        try { ciphertext = new Uint8Array(await win.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(profile, origin) }, key, bytes)); }
        finally { bytes.fill(0); }
        guard(current);
        const record = { version: VERSION, origin, fallbacks, autoConnect: true, device, key, iv, ciphertext, writeId: writeId() };
        const db = await open(current);
        try {
          await writeRecord(db, profile, record, current);
          guard(current); return publicSummary(record);
        } finally { db.close(); }
      });
    } catch (error) { throw safeError(error); }
  }
  async function load(profile, current = () => true) {
    try {
      profileId(profile); guard(current);
      const sealed = native();
      if (sealed) { await mutations; const reply = await sealed.load(profile); guard(current); return nativeSummary(reply, true); }
      const record = await read(profile, current);
      if (!record) return null;
      let plaintext;
      try { plaintext = await win.crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv, additionalData: aad(profile, record.origin) }, record.key, record.ciphertext); }
      catch { guard(current); throw failure('decrypt_failed'); }
      try {
        guard(current);
        const token = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
        if (!validToken(token)) throw failure('invalid_record');
        return { ...publicSummary(record), token };
      } finally { new Uint8Array(plaintext).fill(0); }
    } catch (error) { throw safeError(error); }
  }
  async function summary(profile, current = () => true) {
    try {
      profileId(profile); guard(current);
      const sealed = native();
      if (sealed) { await mutations; const reply = await sealed.summary(profile); guard(current); return nativeSummary(reply, false); }
      return publicSummary(await read(profile, current));
    } catch (error) { throw safeError(error); }
  }
  // Address, identity and the automatic-connection choice change without touching the
  // sealed code. The main address moves into the fallbacks when a new one replaces it.
  async function update(profile, changes, current = () => true) {
    try {
      profileId(profile); guard(current);
      if (!changes || typeof changes !== 'object' || changes.autoConnect !== undefined && typeof changes.autoConnect !== 'boolean') throw failure('invalid_pairing');
      const next = old => {
        const origin = changes.origin === undefined ? old.origin : originValue(changes.origin);
        const fallbacks = fallbackValue([...(changes.fallbacks === undefined ? old.fallbacks || [] : changes.fallbacks), ...(origin !== old.origin ? [old.origin] : [])], origin);
        const device = changes.device === undefined ? deviceValue(old.device) : deviceValue(changes.device);
        return { origin, fallbacks, device, autoConnect: changes.autoConnect ?? old.autoConnect };
      };
      const sealed = native();
      if (sealed) return await mutate(current, async () => {
        const old = nativeSummary(await sealed.summary(profile), false);
        if (!old) return null;
        guard(current);
        return nativeWrite(sealed, profile, () => sealed.update(profile, next(old)), current);
      });
      return await mutate(current, async () => {
        const db = await open(current);
        try {
          let record;
          await transaction(db, 'readonly', current, (store, done, check, watch, abort) => {
            const request = store.get(profile);
            request.onsuccess = () => {
              if (!check()) return;
              try { record = request.result ? validateRecord(request.result) : null; } catch { abort(failure('invalid_record')); }
            };
          });
          if (!record) return null;
          guard(current);
          const values = next(record);
          // The sealed code is bound to its main address, so a new address re-seals it.
          let sealedPart = { key: record.key, iv: record.iv, ciphertext: record.ciphertext };
          if (values.origin !== record.origin) {
            const plaintext = new Uint8Array(await win.crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv, additionalData: aad(profile, record.origin) }, record.key, record.ciphertext).catch(() => { throw failure('decrypt_failed'); }));
            try {
              const iv = win.crypto.getRandomValues(new Uint8Array(12));
              sealedPart = { key: record.key, iv, ciphertext: new Uint8Array(await win.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(profile, values.origin) }, record.key, plaintext)) };
            } finally { plaintext.fill(0); }
          }
          guard(current);
          const updated = { ...record, ...values, ...sealedPart, writeId: writeId() };
          await writeRecord(db, profile, updated, current);
          guard(current);
          return publicSummary(updated);
        } finally { db.close(); }
      });
    } catch (error) { throw safeError(error); }
  }
  async function forget(profile, current = () => true) {
    try {
      profileId(profile); guard(current);
      const sealed = native();
      if (sealed) return await mutate(current, async () => { await sealed.forget(profile); return true; });
      return await mutate(current, async () => {
        const db = await open(current);
        try {
          await transaction(db, 'readwrite', current, (store, done, check, watch) => { if (check()) { watch(store.delete(profile)); done(true); } });
          guard(current); return true;
        } finally { db.close(); }
      });
    } catch (error) { throw safeError(error); }
  }
  win.AsthaPairingStore = Object.freeze({ save, load, summary, update, forget, kind });
})(window);
