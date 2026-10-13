// Android-only device capabilities that the WebView lacks: a local voice, a speech
// recognizer and, only after explicit opt-in, reading the screen of other apps.
// In a browser this file defines nothing and the web paths are used unchanged.
(function (win) {
  'use strict';
  const cap = win.Capacitor;
  if (!cap || !cap.isNativePlatform() || cap.getPlatform() !== 'android') return;
  const plugin = cap.Plugins?.AsthaNative;
  if (!plugin || typeof plugin.speak !== 'function') return;
  const quiet = promise => { try { Promise.resolve(promise).catch(() => {}); } catch {} };
  const failure = error => Object.assign(new Error('native_request_failed'), { code: typeof error?.code === 'string' ? error.code : 'failed' });
  async function screen(method, options) {
    try { return await plugin[method](options || {}); }
    catch (error) { throw failure(error); }
  }
  win.AsthaNative = Object.freeze({
    canSpeak: true, canListen: true,
    // Resolves true only when the whole sentence was spoken.
    async speak(text, lang, rate) {
      const value = String(text || '').slice(0, 4000);
      if (!value.trim()) return false;
      try { return (await plugin.speak({ text: value, lang: lang === 'bn' ? 'bn' : 'en', rate: Number(rate) || 1 })).completed === true; }
      catch { return false; }
    },
    stopSpeaking() { quiet(plugin.stopSpeaking()); },
    // Resolves the heard text ('' when nothing was heard); rejects with a code otherwise.
    async listen(language) {
      try {
        const reply = await plugin.listen({ language: /^[a-z]{2}-[A-Z]{2}$/.test(language || '') ? language : 'bn-BD' });
        return typeof reply?.text === 'string' ? reply.text.slice(0, 500) : '';
      } catch (error) { throw failure(error); }
    },
    stopListening() { quiet(plugin.stopListening()); },
    // Ordinary Android intents. The app never picks a recipient or presses send.
    apps: Object.freeze({
      async find(name) {
        const reply = await screen('findApps', { name: String(name || '').slice(0, 60) });
        return (Array.isArray(reply?.apps) ? reply.apps : [])
          .filter(app => typeof app?.id === 'string' && typeof app?.label === 'string' && /^[A-Za-z0-9_.]{1,200}$/.test(app.id))
          .slice(0, 5).map(app => ({ id: app.id, label: app.label.slice(0, 60) }));
      },
      open: id => screen('openApp', { id: String(id || '') }),
      share: text => screen('shareText', { text: String(text || '').slice(0, 2000) }),
    }),
    screen: Object.freeze({
      async status() {
        const reply = await screen('screenAccessStatus');
        return { consent: reply?.consent === true, serviceEnabled: reply?.serviceEnabled === true };
      },
      setConsent: granted => screen('setScreenAccessConsent', { granted: granted === true }),
      openSettings: () => screen('openAccessibilitySettings'),
      async read() {
        const reply = await screen('readScreen');
        return { app: typeof reply?.app === 'string' ? reply.app.slice(0, 120) : '', text: typeof reply?.text === 'string' ? reply.text.slice(0, 6000) : '', truncated: reply?.truncated === true };
      },
      async action(name) { return (await screen('globalAction', { action: name === 'home' ? 'home' : 'back' }))?.performed === true; },
    }),
  });
})(window);
