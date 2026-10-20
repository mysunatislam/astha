// Which AI produced what. The boxes on the picture always come from the detector on this
// device; spoken descriptions come from the online service only when it is allowed and
// answers. This records what actually happened to each online request, in memory only:
// no image, prompt, answer text, key or address is kept.
const AsthaAiStatus = (() => {
  let online = { state: 'idle', at: 0, ms: null, reason: null }, fallbackAt = 0, booted = false, started = 0;
  const element = id => $(id);
  const REASONS = { busy: 'ai_reason_busy', unavailable: 'ai_reason_unavailable', error: 'ai_reason_error' };
  const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  const language = () => typeof uiLang !== 'undefined' && uiLang === 'bn' ? 'bn' : 'en';
  function tr(lang, key, params = {}) {
    let text = I18N[lang]?.[key] ?? I18N.en[key] ?? key;
    for (const name in params) text = text.split('{' + name + '}').join(params[name]);
    return text;
  }
  const digits = (lang, text) => lang === 'bn' ? String(text).replace(/\d/g, digit => '০১২৩৪৫৬৭৮৯'[digit]) : String(text);
  const time = (lang, at) => new Date(at).toLocaleTimeString(lang === 'bn' ? 'bn-BD' : 'en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const seconds = (lang, ms) => digits(lang, (Math.round(ms / 100) / 10).toFixed(1));
  function reasonOf(error) {
    if (/rate limit/.test(String(error?.message || error))) return 'busy';
    return error?.noCloud ? 'unavailable' : 'error';
  }
  // Called by gemini() when a request is actually sent, and when it settles.
  function onlineStarted() { online = { state: 'running', at: Date.now(), ms: null, reason: null }; started = nowMs(); render(); }
  function onlineFinished(outcome, error) {
    const state = outcome === 'success' ? 'answered' : outcome === 'cancel' ? 'cancelled' : 'failed';
    online = { state, at: Date.now(), ms: Math.max(0, nowMs() - started), reason: state === 'failed' ? reasonOf(error) : null };
    render();
  }
  // A request that could not even be sent (no online service configured or reachable).
  function onlineSkipped(error) { online = { state: 'failed', at: Date.now(), ms: null, reason: reasonOf(error) }; render(); }
  function fallbackUsed() { fallbackAt = Date.now(); render(); }
  function cameraKey() {
    const source = typeof state !== 'undefined' ? state.source : null;
    if (source === 'pi') return typeof PiCamera !== 'undefined' && PiCamera.active() ? 'ai_camera_pi_live' : 'ai_camera_pi_waiting';
    if (source === 'camera') return 'ai_camera_phone';
    if (source === 'photo') return 'ai_camera_photo';
    if (source === 'scene') return 'ai_camera_demo';
    return 'ai_camera_none';
  }
  function boxesKey() {
    const coco = typeof engine !== 'undefined' ? engine.coco : null;
    if (coco?.status !== 'ready') return 'ai_boxes_off';
    return typeof state !== 'undefined' && state.liveLoop?.active ? 'ai_boxes_running' : 'ai_boxes_ready';
  }
  function onlineText(lang) {
    const mode = typeof Subscription !== 'undefined' ? Subscription.getMode() : 'offline';
    if (mode === 'offline') return tr(lang, 'ai_online_offline_mode');
    if (typeof remoteProcessingAllowed === 'function' && !remoteProcessingAllowed()) return tr(lang, 'ai_online_consent');
    if (typeof serverCloud === 'undefined' || !serverCloud.checked) return tr(lang, 'ai_online_unchecked');
    if (!serverCloud.available) return tr(lang, 'ai_online_unavailable');
    const name = serverCloud.provider === 'maira' ? 'ai_provider_maira' : serverCloud.provider === 'gemini' ? 'ai_provider_gemini' : 'ai_provider_cloud';
    return tr(lang, 'ai_online_allowed', { provider: tr(lang, name) });
  }
  function lastText(lang) {
    if (online.state === 'running') return tr(lang, 'ai_last_running');
    if (fallbackAt && fallbackAt >= online.at) return tr(lang, 'ai_last_fallback', { time: time(lang, fallbackAt) });
    if (online.state === 'answered') return tr(lang, 'ai_last_online', { time: time(lang, online.at), seconds: seconds(lang, online.ms) });
    if (online.state === 'cancelled') return tr(lang, 'ai_last_cancelled', { time: time(lang, online.at) });
    if (online.state === 'failed') return tr(lang, 'ai_last_failed', { time: time(lang, online.at), reason: tr(lang, REASONS[online.reason] || 'ai_reason_error') });
    return tr(lang, 'ai_last_none');
  }
  function render() {
    const lang = language();
    const put = (id, text) => { const node = element(id); if (node && node.textContent !== text) node.textContent = text; };
    put('ai-status-camera', tr(lang, cameraKey()));
    put('ai-status-boxes', tr(lang, boxesKey()));
    put('ai-status-online', onlineText(lang));
    put('ai-status-last', lastText(lang));
  }
  const summary = () => ({ en: [onlineText('en'), lastText('en'), tr('en', 'ai_voice_boxes')].join(' '),
    bn: [onlineText('bn'), lastText('bn'), tr('bn', 'ai_voice_boxes')].join(' ') });
  const ASK = /^(?:which|what) (?:ai|model)(?: (?:are you|is) (?:using|working|answering))?$|^are you (?:using (?:gemini|the internet|online ai|ai)|online|offline)$|^is (?:the )?(?:online ai|gemini|online mode) (?:on|working|being used)$|^(?:online or offline|ai status)$|কোন এআই|অনলাইন না অফলাইন|জেমিনি (?:ব্যবহার|চালু)|অনলাইনে আছ/;
  function route(query) {
    const q = String(query || '').normalize('NFC').toLowerCase().replace(/^(?:hey\s+|হেই\s+|হে\s+)?(?:luneyra|luneira|লুনেইরা|লুনেয়রা|astha|আস্থা)[,!.।\s]*/i, '').replace(/[.!?।\s]+$/, '').trim();
    if (!ASK.test(q)) return false;
    const said = summary();
    if (typeof announce === 'function') announce(said.en, said.bn, 'system');
    return true;
  }
  function boot() {
    if (booted) return;
    booted = true;
    render();
    // Cheap text-only refresh while LUNEYRA is on screen; nothing is measured or sent.
    setInterval(() => { if (!document.hidden) render(); }, 2000);
  }
  return { boot, render, route, summary, onlineStarted, onlineFinished, onlineSkipped, fallbackUsed,
    get online() { return { ...online }; } };
})();
