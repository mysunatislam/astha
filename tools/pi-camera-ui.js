// The paired transport owns ImageBitmaps; this adapter owns the pairing form, the optional
// preview for sighted helpers, and the spoken connection feedback.
const AsthaPiCamera = (() => {
  const STATUS_KEYS = { stopped: 'pi_stopped', connecting: 'pi_connecting', connected: 'pi_connected', reconnecting: 'pi_reconnecting',
    reconnected: 'pi_reconnected', paused: 'pi_paused', pairing_rejected: 'pi_pairing_rejected', stale_frame: 'pi_stale_frame',
    frame_timeout: 'pi_frame_timeout', connection_lost: 'pi_connection_lost', invalid_origin: 'pi_invalid_origin',
    invalid_pairing_token: 'pi_invalid_pairing_token', models: 'pi_models', error: 'pi_error' };
  let generation = 0, currentStatus = 'stopped', booted = false, deviceLine = '';
  const element = id => document.getElementById(id);
  const key = status => STATUS_KEYS[Object.hasOwn(STATUS_KEYS, status) ? status : 'error'];
  const label = status => t(key(status));
  // Connection changes are spoken: a blind user cannot see the status line change.
  function speakStatus(status, important) {
    if (typeof announce !== 'function' || typeof I18N === 'undefined') return;
    if (!important && typeof AsthaExperience !== 'undefined' && !AsthaExperience.admit('medium', 'pi:' + status, 5000)) return;
    announce(I18N.en[key(status)], I18N.bn[key(status)], 'system');
  }
  function refreshLabels() {
    const status = element('pi-camera-status'); if (status) status.textContent = label(currentStatus);
    const pending = currentStatus === 'connecting';
    const paired = typeof PiCamera !== 'undefined' && PiCamera.paired();
    const form = element('pi-camera-form'); if (form) form.setAttribute('aria-busy', String(pending));
    if (element('pi-camera-connect')) element('pi-camera-connect').disabled = pending;
    if (element('pi-camera-stop')) element('pi-camera-stop').disabled = !pending && !paired;
    if (element('pi-camera-origin')) element('pi-camera-origin').readOnly = pending;
    const device = element('pi-camera-device'); if (device) { device.textContent = deviceLine; device.hidden = !deviceLine; }
  }
  function setStatus(next) { currentStatus = Object.hasOwn(STATUS_KEYS, next) ? next : 'error'; refreshLabels(); }
  function stop({ clearSource = true } = {}) {
    const owned = currentStatus === 'connecting' || typeof state !== 'undefined' && state.source === 'pi';
    generation++;
    if (typeof PiCamera !== 'undefined') PiCamera.stop();
    // A distance from a camera that is no longer connected says nothing about now.
    if (typeof AsthaSensors !== 'undefined') AsthaSensors.clear();
    const token = element('pi-camera-token'); if (token) token.value = '';
    const preview = element('pi-preview');
    if (preview) { preview.getContext('2d')?.clearRect(0, 0, preview.width, preview.height); preview.hidden = true; }
    deviceLine = '';
    if (owned) {
      stopLiveLoop();
      state.pendingAction = null;
      if (typeof AsthaExperience !== 'undefined') AsthaExperience.invalidate();
      if (typeof AsthaAgent !== 'undefined') AsthaAgent.cancel?.();
      if (typeof stopAllSpeech === 'function') stopAllSpeech();
      if (clearSource && state.source === 'pi') showSource(null);
      if (typeof setCaption === 'function') setCaption(t('pi_title'), label('stopped'), 'system');
    }
    setStatus('stopped');
  }
  async function connect(event) {
    event?.preventDefault();
    if (currentStatus === 'connecting') return;
    const origin = element('pi-camera-origin')?.value.trim();
    let token = element('pi-camera-token')?.value.trim();
    if (element('pi-camera-token')) element('pi-camera-token').value = '';
    const interval = element('pi-camera-saver')?.checked ? 1000 : 250;
    // Stop the previous source first. A new frame is the only way to activate Pi mode.
    if (typeof stopCamera === 'function') stopCamera();
    stop();
    const mine = ++generation;
    setStatus('connecting');
    let initialized = false, wasLost = false;
    try {
      if (typeof PiCamera === 'undefined') throw new Error('transport unavailable');
      await PiCamera.connect({ origin, token, interval,
        onFrame(bitmap) {
          if (mine !== generation) return;
          const preview = element('pi-preview');
          if (!preview) throw new Error('preview unavailable');
          if (preview.width !== bitmap.width || preview.height !== bitmap.height) { preview.width = bitmap.width; preview.height = bitmap.height; }
          preview.getContext('2d').drawImage(bitmap, 0, 0);
          if (!initialized) {
            initialized = true;
            state.sceneKey = null;
            showSource('pi'); preview.hidden = false;
            // The existing detector/CLIP loops consume the same captureFrame path.
            Promise.resolve(ensureVisionModels()).then(ready => {
              if (mine !== generation || state.source !== 'pi' || !PiCamera.active()) return;
              if (ready) startLiveLoop(); else setStatus('models');
            }).catch(() => { if (mine === generation) setStatus('models'); });
          }
        },
        // The ultrasonic sensor beside the Pi camera. Its reading is dated by its own age.
        onTelemetry(reading) {
          if (mine !== generation || typeof AsthaSensors === 'undefined' || reading?.distanceM == null) return;
          AsthaSensors.report('front', reading.distanceM, 'ultrasonic', Date.now() - reading.ageMs);
        },
        onStatus(status) {
          if (mine !== generation) return;
          if (status.state === 'connected') {
            setStatus('connected'); speakStatus(wasLost ? 'reconnected' : 'connected', true); wasLost = false;
            if (!deviceLine && typeof PiCamera.describe === 'function') PiCamera.describe().then(info => {
              if (mine !== generation || !info) return;
              deviceLine = [info.model, info.backend, info.width && info.height ? info.width + '×' + info.height : '',
                info.telemetry ? t('pi_distance_sensor') : ''].filter(Boolean).join(' · ');
              refreshLabels();
            });
          } else if (status.state === 'reconnecting') {
            // A picture taken before the link dropped must not answer a question asked now.
            if (typeof AsthaExperience !== 'undefined') AsthaExperience.invalidate();
            setStatus('reconnecting'); if (!wasLost && status.code !== 'resumed') speakStatus('reconnecting', false); wasLost = true;
          } else if (status.state === 'paused') {
            if (typeof AsthaExperience !== 'undefined') AsthaExperience.invalidate();
            setStatus('paused');
          } else if (status.state === 'error') { stop(); setStatus(status.code); speakStatus(status.code, true); }
        },
      });
    } catch (error) {
      if (mine !== generation) return;
      const code = typeof error.code === 'string' ? error.code : 'error';
      stop(); setStatus(code); speakStatus(code, true);
    } finally { token = ''; }
  }
  function boot() {
    if (booted) return;
    booted = true;
    const preview = element('pi-preview'), viewport = element('viewport');
    if (preview && viewport) viewport.insertBefore(preview, element('overlay'));
    element('pi-camera-form')?.addEventListener('submit', connect);
    element('pi-camera-stop')?.addEventListener('click', () => { stop(); element('pi-camera-connect')?.focus(); });
    window.addEventListener('pagehide', () => stop());
    refreshLabels();
  }
  return { boot, connect, stop, refreshLabels, frame: () => typeof PiCamera !== 'undefined' ? PiCamera.getFrame() : null,
    sourceLabel: () => t('pi_source'), get status() { return currentStatus; } };
})();
