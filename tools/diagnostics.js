// Opt-in, local-only timing records. No DOM, persistence, networking or user content.
//
// API:
//   setEnabled(true)                         // disabled by default
//   setSourceEpoch(state.sourceEpoch)        // invalidates old-source records
//   start(stage, { sourceEpoch?, request? }) // opaque token, or null if rejected
//   finish(token, 'success'|'error'|'cancel') // false for stale/unknown tokens
//   snapshot(), reset(), subscribe(listener) // unsubscribe returned by subscribe
//
// Stage meanings are caller-owned: finish `speech` at the first actual audio event,
// not when fetch resolves or playback ends. To measure capture-to-first-audio, start
// `capture_to_audio` at that capture and finish its same token at actual first audio.
// Never finish it for a different task. `request` is a numeric task generation only.
const AsthaDiagnostics = (() => {
  const STAGES = Object.freeze(['perception', 'reasoning', 'speech', 'capture_to_audio']);
  const OUTCOMES = new Set(['success', 'error', 'cancel']);
  const MAX_SUBSCRIBERS = 16;
  const records = new Map(), active = new Map(), latestRequests = new Map(), listeners = new Set();
  let enabled = false, sourceEpoch = 0, lastClock = 0;
  const integer = value => Number.isSafeInteger(value) && value >= 0;

  function now() {
    const value = performance.now();
    if (!Number.isFinite(value) || value < 0) return null;
    lastClock = Math.max(lastClock, value);
    return lastClock;
  }
  function snapshot() {
    const stages = {};
    for (const stage of STAGES) {
      const record = records.get(stage);
      stages[stage] = record ? Object.freeze({ ...record }) : null;
    }
    return Object.freeze({ enabled, sourceEpoch, stages: Object.freeze(stages) });
  }
  function publish() {
    const value = snapshot();
    for (const listener of [...listeners]) {
      try { listener(value); } catch { /* Debug UI must never break assistance. */ }
    }
  }
  function reset() {
    records.clear(); active.clear(); latestRequests.clear(); publish();
  }
  function setEnabled(value) {
    if (typeof value !== 'boolean') return false;
    if (enabled === value) return true;
    enabled = value;
    reset();
    return true;
  }
  function setSourceEpoch(value) {
    if (!integer(value)) return false;
    if (sourceEpoch === value) return true;
    sourceEpoch = value;
    reset();
    return true;
  }
  function start(stage, options = {}) {
    if (!enabled || !STAGES.includes(stage) || !options || typeof options !== 'object' || Array.isArray(options) ||
        Object.keys(options).some(key => !['sourceEpoch', 'request'].includes(key))) return null;
    const epoch = options.sourceEpoch === undefined ? sourceEpoch : options.sourceEpoch;
    const request = options.request === undefined ? null : options.request;
    if (!integer(epoch) || epoch !== sourceEpoch || (request !== null && !integer(request))) return null;
    if (request !== null && latestRequests.has(stage) && request < latestRequests.get(stage)) return null;
    const startedAt = now();
    if (startedAt === null) return null;
    const token = Object.freeze({});
    if (request !== null) latestRequests.set(stage, request);
    // A newer measurement replaces the prior token; retained state is at most four records.
    active.set(stage, { token, startedAt });
    records.set(stage, { status: 'running', durationMs: null, request, sourceEpoch: epoch });
    publish();
    return token;
  }
  function finish(token, outcome = 'success') {
    if (!enabled || !token || !OUTCOMES.has(outcome)) return false;
    const stage = STAGES.find(name => active.get(name)?.token === token);
    if (!stage) return false;
    const endedAt = now();
    if (endedAt === null) return false;
    const current = active.get(stage);
    records.set(stage, { ...records.get(stage), status: outcome, durationMs: endedAt - current.startedAt });
    active.delete(stage);
    publish();
    return true;
  }
  function subscribe(listener) {
    if (typeof listener !== 'function' || listeners.size >= MAX_SUBSCRIBERS) return () => {};
    listeners.add(listener);
    try { listener(snapshot()); } catch { /* A failed debug subscriber is isolated. */ }
    return () => { listeners.delete(listener); };
  }
  return Object.freeze({ setEnabled, setSourceEpoch, start, finish, snapshot, reset, subscribe });
})();
