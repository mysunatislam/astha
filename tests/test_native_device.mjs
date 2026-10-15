// Android device bridge: voice, recognizer and opt-in screen reading. The JavaScript runs
// here against a stand-in plugin; the Java side is checked for its guardrails as source.
// None of this proves behaviour on a phone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const bridgeSource = read('web/native-device.js');
const screenSource = read('tools/screen-access.js');
const moduleSource = read('tools/module.js');
const offlineSource = read('tools/offline.js');
const strings = JSON.parse(read('tools/i18n.json')).strings;
const between = (source, start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert(a >= 0 && b > a, 'missing source boundary: ' + start);
  return source.slice(a, b);
};
const coded = code => Object.assign(new Error('native'), { code });

function bridge(plugin, { platform = 'android', native = true } = {}) {
  const window = plugin === null ? {} : { Capacitor: { isNativePlatform: () => native, getPlatform: () => platform, Plugins: { AsthaNative: plugin } } };
  vm.runInNewContext(bridgeSource, { window, Promise, Object, String, Number, Error });
  return window.AsthaNative;
}

test('a browser, iOS and an app without the plugin get no native bridge', () => {
  const plugin = { speak: async () => ({ completed: true }) };
  assert.equal(bridge(null), undefined);
  assert.equal(bridge(plugin, { native: false }), undefined);
  assert.equal(bridge(plugin, { platform: 'ios' }), undefined);
  assert.equal(bridge({}), undefined);
  assert.equal(bridge(plugin).canSpeak, true);
});

test('device voice and recognizer calls are bounded and report plain results', async () => {
  const calls = [];
  const device = bridge({
    speak: async options => { calls.push(['speak', options]); if (options.text === 'fail') throw coded('voice_unavailable'); return { completed: options.text !== 'cut' }; },
    stopSpeaking: async () => { calls.push(['stopSpeaking']); }, stopListening: async () => { throw new Error('ignored'); },
    listen: async options => { calls.push(['listen', options]); if (options.language === 'en-US') throw coded('permission'); return { text: 'x'.repeat(900) }; },
  });
  assert.equal(await device.speak('হ্যালো', 'bn', 1.2), true);
  assert.deepEqual([calls[0][0], { ...calls[0][1] }], ['speak', { text: 'হ্যালো', lang: 'bn', rate: 1.2, onDeviceOnly: true }]);
  assert.equal(await device.speak('y'.repeat(9000), 'fr', 'fast'), true);
  assert.equal(calls[1][1].text.length, 4000); assert.equal(calls[1][1].lang, 'en'); assert.equal(calls[1][1].rate, 1);
  assert.equal(await device.speak('cut', 'en'), false); assert.equal(await device.speak('fail', 'en'), false);
  assert.equal(await device.speak('   ', 'en'), false, 'nothing to say is not sent to the device');
  assert.equal((await device.listen('bn-BD')).length, 500);
  await device.listen('not a language tag'); assert.equal(calls.at(-1)[1].language, 'bn-BD');
  await assert.rejects(device.listen('en-US'), { code: 'permission' });
  device.stopSpeaking(); device.stopListening();   // neither may throw or leave an unhandled rejection
  await new Promise(resolve => setImmediate(resolve));
});

test('native speech defaults to on-device processing and only explicit false permits an online engine', async () => {
  const calls = [];
  const device = bridge({
    speak: async options => { calls.push(['speak', options]); return { completed: true }; },
    listen: async options => { calls.push(['listen', options]); if (options.onDeviceOnly) throw coded('on_device_unavailable'); return { text: 'hello' }; },
  });
  for (const options of [undefined, null, {}, { onDeviceOnly: true }, { onDeviceOnly: 'false' }, { onDeviceOnly: 0 }]) {
    await assert.rejects(device.listen('bn-BD', options), { code: 'on_device_unavailable' });
    assert.equal(calls.at(-1)[1].onDeviceOnly, true);
    assert.equal(await device.speak('hello', 'en', 1, options), true);
    assert.equal(calls.at(-1)[1].onDeviceOnly, true);
  }
  assert.equal(await device.listen('en-US', { onDeviceOnly: false }), 'hello');
  assert.equal(calls.at(-1)[1].onDeviceOnly, false);
  await device.speak('hello', 'en', 1, { onDeviceOnly: false });
  assert.equal(calls.at(-1)[1].onDeviceOnly, false);
  const unavailable = bridge({ speak: async () => { throw coded('voice_language_unavailable'); }, listen: async () => { throw coded('language_unavailable'); } });
  assert.equal(await unavailable.speak('বাংলা', 'bn', 1), false);
  await assert.rejects(unavailable.listen('bn-BD'), { code: 'language_unavailable' });
});

test('Android local speech requires the on-device recognizer and a non-network installed voice', () => {
  const plugin = read('android/app/src/main/java/com/astha/companion/AsthaNativePlugin.java');
  const assistant = read('android/app/src/main/java/com/astha/companion/AsthaMessageAssistant.java');
  const localVoice = between(plugin, 'static Voice installedLocalVoice', '\n    @PluginMethod');
  assert.match(localVoice, /candidate\.isNetworkConnectionRequired\(\)/);
  assert.match(localVoice, /KEY_FEATURE_NOT_INSTALLED/);
  const speak = between(plugin, 'public void speak(PluginCall call)', '\n    @PluginMethod');
  assert.match(speak, /call\.getBoolean\("onDeviceOnly", true\)/);
  assert.match(speak, /if \(onDeviceOnly\) \{\s*Voice chosen = installedLocalVoice\(voice, wanted\)/);
  assert.match(speak, /voice\.setVoice\(chosen\) != TextToSpeech\.SUCCESS/);
  const listen = between(plugin, 'private void startRecognition(SpeechInputRequests.Request<PluginCall> request)', '\n    @PluginMethod');
  assert.match(listen, /call\.getBoolean\("onDeviceOnly", true\)/);
  assert.match(listen, /onDeviceOnly && \(Build\.VERSION\.SDK_INT < Build\.VERSION_CODES\.S \|\| !SpeechRecognizer\.isOnDeviceRecognitionAvailable/);
  assert.match(listen, /if \(onDeviceOnly\) \{\s*if \(Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.S\) requestRecognizer = SpeechRecognizer\.createOnDeviceSpeechRecognizer\(context\);\s*else \{ finishListening\(request, null, "on_device_unavailable"\); return; \}\s*\} else requestRecognizer = SpeechRecognizer\.createSpeechRecognizer\(context\)/);
  assert.match(listen, /checkRecognitionSupport/); assert.match(listen, /getInstalledOnDeviceLanguages/);
  assert.match(listen, /"language_unavailable"/); assert.match(listen, /"recognition_timeout"/);
  assert.match(listen, /!speechRequests\.mayStart\(request, foregroundForSpeech\(\)\) \|\| recognizer != requestRecognizer/);
  assert.doesNotMatch(listen, /triggerModelDownload|EXTRA_PREFER_OFFLINE/);
  const background = between(assistant, 'private void listen()', '\n    private void stopListening()');
  assert.match(background, /Build\.VERSION\.SDK_INT < Build\.VERSION_CODES\.S/);
  assert.match(background, /SpeechRecognizer\.isOnDeviceRecognitionAvailable/);
  assert.match(background, /SpeechRecognizer\.createOnDeviceSpeechRecognizer\(this\)/);
  assert.doesNotMatch(assistant, /SpeechRecognizer\.createSpeechRecognizer|voice\.setLanguage/);
  assert.match(assistant, /AsthaNativePlugin\.installedLocalVoice/);
  assert.match(assistant, /voiceReady = chosen != null && voice\.setVoice\(chosen\) == TextToSpeech\.SUCCESS/);
  assert.match(background, /onDeviceInputUnavailable\(\)/);
  assert.match(background, /draft = ""/);
});

test('Android pending permissions and queued recognition use a cancellable request identity', () => {
  const plugin = read('android/app/src/main/java/com/astha/companion/AsthaNativePlugin.java');
  const start = between(plugin, 'public void listen(PluginCall call)', '\n    @PermissionCallback');
  assert(start.indexOf('speechRequests.begin(call)') < start.indexOf('recognitionHandler.post'), 'identity exists before queuing or prompting');
  assert.match(start, /speechRequests\.awaitPermission\(change\.request\)/);
  const permission = between(plugin, 'private void microphoneResult', '\n    private boolean foregroundForSpeech');
  assert.match(permission, /speechRequests\.permissionResult\(call\)/);
  assert.match(permission, /if \(request == null\) return/);
  assert.match(permission, /speechRequests\.mayStart\(request, foregroundForSpeech\(\)\)\)/);
  const cancel = between(plugin, 'private void cancelSpeechInput()', '\n    private void releaseRecognizer');
  assert(cancel.indexOf('speechRequests.cancel()') < cancel.indexOf('recognitionHandler.post'), 'invalidation precedes queued cleanup');
  for (const method of ['handleOnPause()', 'handleOnDestroy()', 'stopListening(PluginCall call)']) assert.match(between(plugin, method, '\n    }'), /cancelSpeechInput\(\)/);
  assert.match(between(plugin, 'private boolean foregroundForSpeech()', '\n    }'), /AsthaMessageAssistant\.appVisible[\s\S]*!getActivity\(\)\.isFinishing\(\)[\s\S]*!getActivity\(\)\.isDestroyed\(\)/);
  assert(fs.existsSync(new URL('../android/app/src/test/java/com/astha/companion/SpeechInputRequestsTest.java', import.meta.url)), 'request lifecycle has executable JVM tests');
});

function screenHarness({ consent = false, serviceEnabled = false, text = 'Inbox\nRahim: See you at 5', truncated = false, native = true } = {}) {
  const state = { consent, serviceEnabled }, calls = [], spoken = [], elements = new Map(), listeners = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, { id, hidden: true, textContent: '', attributes: {}, listeners: {}, setAttribute(key, value) { this.attributes[key] = value; }, addEventListener(name, fn) { this.listeners[name] = fn; } }); return elements.get(id); };
  for (const id of ['screen-access', 'screen-access-toggle', 'screen-access-status']) element(id);
  const screen = {
    status: async () => ({ ...state }),
    setConsent: async granted => { calls.push('consent:' + granted); state.consent = granted; if (!granted) state.serviceEnabled = false; },
    openSettings: async () => { calls.push('settings'); if (!state.consent) throw coded('consent_required'); },
    read: async () => { calls.push('read'); if (!state.consent || !state.serviceEnabled) throw coded('service_disabled'); return { app: 'com.example.mail', text, truncated }; },
    action: async name => { calls.push('action:' + name); return true; },
  };
  const installed = [{ id: 'com.whatsapp', label: 'WhatsApp' }, { id: 'com.whatsapp.w4b', label: 'WhatsApp Business' }, { id: 'com.example.maps', label: 'Maps' }];
  const apps = {
    find: async name => { calls.push('find:' + name); const wanted = name.toLowerCase(); const exact = installed.filter(app => app.label.toLowerCase() === wanted); return exact.length ? exact : installed.filter(app => app.label.toLowerCase().includes(wanted)); },
    open: async id => { calls.push('open:' + id); }, share: async text => { calls.push('share:' + text); },
  };
  const confirmations = [];
  const context = vm.createContext({ Promise, String, RegExp, uiLang: 'en', announce: (en, bn) => spoken.push([en, bn]),
    askYesNo: (en, bn, onYes, onNo) => confirmations.push({ en, bn, onYes, onNo }),
    document: { hidden: false, getElementById: id => elements.get(id) || null, addEventListener: (name, fn) => listeners.set(name, fn) },
    window: native ? { AsthaNative: { screen, apps } } : {} });
  context.t = key => strings[key][context.uiLang === 'bn' ? 1 : 0];
  vm.runInContext(screenSource + '\nglobalThis.access = AsthaScreenAccess;', context);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return { access: context.access, state, calls, spoken, elements, listeners, settle, confirmations };
}

test('in a browser the screen-reading controls stay hidden and voice requests fall through', () => {
  const h = screenHarness({ native: false }); h.access.boot();
  assert.equal(h.elements.get('screen-access').hidden, true);
  assert.equal(h.access.route('What is on my screen?'), false);
});

test('turning screen reading on explains first, records consent, then hands over to Android settings', async () => {
  const h = screenHarness(); h.access.boot(); await h.settle();
  assert.equal(h.elements.get('screen-access').hidden, false); assert.equal(h.access.status, 'off');
  assert.equal(h.elements.get('screen-access-toggle').attributes['aria-pressed'], 'false');
  await h.elements.get('screen-access-toggle').listeners.click();
  assert.deepEqual(h.calls, ['consent:true', 'settings'], 'ASTHA never opens settings before the user agreed');
  assert.match(h.spoken[0][0], /Android will show its own warning/);
  assert.equal(h.access.status, 'waiting'); assert.equal(h.elements.get('screen-access-status').textContent, strings.screen_status_waiting[0]);
  // The user switches the service on in Android and comes back.
  h.state.serviceEnabled = true; h.listeners.get('visibilitychange')(); await h.settle();
  assert.equal(h.access.status, 'on'); assert.equal(h.elements.get('screen-access-toggle').textContent, strings.screen_access_off[0]);
  await h.elements.get('screen-access-toggle').listeners.click();
  assert.equal(h.calls.at(-1), 'consent:false'); assert.equal(h.access.status, 'off'); assert.equal(h.state.serviceEnabled, false);
  assert.match(h.spoken.at(-1)[0], /can no longer read other apps/);
});

test('the screen is read only when it is fully enabled, and only when asked', async () => {
  for (const state of [{ consent: false, serviceEnabled: false }, { consent: true, serviceEnabled: false }, { consent: false, serviceEnabled: true }]) {
    const off = screenHarness(state);
    assert.equal(off.access.route('Astha, what is on my screen?'), true); await off.settle();
    assert.equal(off.calls.includes('read'), false, JSON.stringify(state)); assert.match(off.spoken[0][0], /turned off/);
  }
  const h = screenHarness({ consent: true, serviceEnabled: true, truncated: true });
  for (const query of ['Where is my pen?', 'read this', 'go home', 'press back']) assert.equal(h.access.route(query), false, query);
  assert.deepEqual(h.calls, [], 'nothing is read for unrelated requests');
  assert.equal(h.access.route('স্ক্রিনে কী আছে?'), true); await h.settle();
  assert.deepEqual(h.calls, ['read']);
  assert.equal(h.spoken[0][0], 'On the screen: Inbox\nRahim: See you at 5 There is more that I did not read.');
  assert.equal(h.access.route('press back on my phone'), true); await h.settle();
  assert.equal(h.calls.at(-1), 'action:back');
  const empty = screenHarness({ consent: true, serviceEnabled: true, text: '   ' });
  empty.access.route('read my screen'); await empty.settle();
  assert.match(empty.spoken[0][0], /could not find any readable text/);
});

test('opening an app or preparing a message always asks first, and declining does nothing', async () => {
  const h = screenHarness();
  for (const query of ['open devices', 'open the camera', 'start camera', 'ক্যামেরা চালু করো', 'send it', 'what is a message']) assert.equal(h.access.route(query), false, query);
  assert.deepEqual(h.calls, []);
  // One exact match: confirm, then open only on yes.
  assert.equal(h.access.route('Astha, open the WhatsApp app.'), true); await h.settle();
  assert.deepEqual(h.calls, ['find:WhatsApp']); assert.equal(h.confirmations.length, 1); assert.equal(h.confirmations[0].en, 'Open WhatsApp?');
  h.confirmations[0].onNo(); assert.deepEqual(h.calls, ['find:WhatsApp'], 'declining opens nothing');
  assert.match(h.spoken.at(-1)[0], /nothing was opened/);
  h.confirmations[0].onYes(); await h.settle(); assert.equal(h.calls.at(-1), 'open:com.whatsapp');
  // No match and several matches are spoken, never guessed.
  h.access.route('launch the Telegram app'); await h.settle();
  assert.match(h.spoken.at(-1)[0], /could not find an app called Telegram/);
  h.access.route('open the whats app'); await h.settle();
  assert.match(h.spoken.at(-1)[0], /more than one: WhatsApp, WhatsApp Business/); assert.equal(h.confirmations.length, 1);
  assert.equal(h.access.route('হোয়াটসঅ্যাপ অ্যাপ খোলো'), true); await h.settle();
  assert.equal(h.calls.at(-1), 'find:হোয়াটসঅ্যাপ');
  // A message goes to Android's share menu; ASTHA says who presses send.
  assert.equal(h.access.route('Write a message saying I will be ten minutes late'), true); await h.settle();
  const message = h.confirmations.at(-1);
  assert.match(message.en, /share menu with this message: I will be ten minutes late\. You choose the app and the person, and you press send/);
  assert.equal(h.calls.some(call => call.startsWith('share:')), false);
  message.onYes(); await h.settle(); assert.equal(h.calls.at(-1), 'share:I will be ten minutes late');
  assert.equal(h.access.route('বার্তা লেখো, আমার দেরি হবে'), true); await h.settle();
  h.confirmations.at(-1).onNo(); assert.equal(h.calls.filter(call => call.startsWith('share:')).length, 1);
});

test('app names from the phone are bounded and malformed entries are dropped', async () => {
  const calls = [];
  const device = bridge({ speak: async () => ({ completed: true }),
    findApps: async options => { calls.push(options); return { apps: [{ id: 'com.whatsapp', label: 'W'.repeat(200) }, { id: 'bad id; rm', label: 'Evil' }, { id: 7, label: 'N' }, { label: 'no id' }, ...Array.from({ length: 9 }, (_, i) => ({ id: 'com.app' + i, label: 'App ' + i }))] }; },
    openApp: async options => { calls.push(options); }, shareText: async options => { calls.push(options); } });
  const found = await device.apps.find('x'.repeat(500));
  assert.equal(calls[0].name.length, 60);
  assert.deepEqual(JSON.parse(JSON.stringify(found.map(app => app.id))), ['com.whatsapp', 'com.app0', 'com.app1', 'com.app2', 'com.app3']);
  assert.equal(found[0].label.length, 60);
  await device.apps.share('y'.repeat(5000)); assert.equal(calls.at(-1).text.length, 2000);
  await device.apps.open('com.whatsapp'); assert.deepEqual({ ...calls.at(-1) }, { id: 'com.whatsapp' });
});

test('without browser speech synthesis ASTHA speaks through the device voice and Stop reaches it', async () => {
  const spoken = [], stops = [], fetches = []; let finish;
  const context = vm.createContext({ console, Promise, Date, AbortController, state: { audio: true }, voiceLang: 'en',
    VoiceEchoFilter: { recordMachineSpeech() {} }, remoteProcessingAllowed: () => true, backendReachable: () => true,
    offlineError: () => new Error('offline'), apiUrl: path => path, deadlineSignal: () => undefined,
    fetch: async (...args) => { fetches.push(args); return { ok: false }; },
    makeUtterance: () => { throw new Error('speechSynthesis must not be used'); }, sanitizeForSpeech: text => text,
    $: () => ({ value: '1.2' }), setTimeout, clearTimeout, playEarcon() {}, haptic() {}, setCaption() {}, showHazard() {}, t: key => key, stopReader() {},
    window: { AsthaNative: { canSpeak: true, speak: (text, lang, rate) => { spoken.push([text, lang, rate]); return new Promise(resolve => { finish = resolve; }); }, stopSpeaking: () => stops.push(true) } } });
  vm.runInContext(between(moduleSource, 'const VoiceEngine = {', 'function startReader(') + '\nglobalThis.engine = VoiceEngine;', context);
  const { engine } = context;
  const answer = engine.speak('Your tea is on the left.', 'en');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetches.length, 1, 'the server voice is still tried first');
  assert.deepEqual(spoken, [['Your tea is on the left.', 'en', 1.2]]); assert.equal(engine.speaking, true);
  engine.stop(true); assert.deepEqual(stops, [true]); assert.equal(engine.speaking, false);
  finish(false); assert.equal(await answer, false);
  // An alert cannot wait for the network, so it goes straight to the device voice.
  engine.emergencyAlert('Warning! Stairs directly ahead!', '', 'stairs', 'critical');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetches.length, 1); assert.equal(spoken.at(-1)[0], 'Warning! Stairs directly ahead!');
});

test('in the Android app one tap listens through the device recognizer and handles the result', async () => {
  // The slice ends inside toggleListening, so close it for the test.
  const source = between(offlineSource, '// The Android app has no browser speech recognition', '  const SR = window.SpeechRecognition') + '}';
  const run = listen => {
    const queries = [], spoken = [], captions = [], stops = [], fallbacks = [], requests = [];
    const context = vm.createContext({ console, Promise, state: { listening: false }, privacyMode: false, privacyTransition: false,
      remoteProcessingAllowed: () => true,
      reader: { active: false }, OfflineEar: { active: false, wanted: () => false, listenAndHandle: reason => fallbacks.push(reason) }, VoiceEngine: { stop() {} }, pauseReader() {}, playEarcon() {}, sttLang: () => 'bn-BD', t: key => key,
      $: () => ({ setAttribute() {}, classList: { add() {}, remove() {} }, textContent: '' }),
      setCaption: (...args) => captions.push(args), announce: (en, bn) => spoken.push([en, bn]), handleQuery: text => queries.push(text),
      window: { AsthaNative: { canListen: true, listen: (...args) => { requests.push(args); return listen(...args); }, stopListening: () => stops.push(true) } } });
    context.stopListening = () => { context.state.listening = false; };
    vm.runInContext(source + '\nglobalThis.toggle = toggleListening;', context);
    return { context, queries, spoken, captions, stops, fallbacks, requests };
  };
  const settle = () => new Promise(resolve => setImmediate(resolve));

  const heard = run(async language => { assert.equal(language, 'bn-BD'); return '  আমার চশমা কোথায়  '; });
  heard.context.toggle(); assert.equal(heard.context.state.listening, true);
  await settle(); assert.deepEqual(heard.queries, ['আমার চশমা কোথায়']); assert.equal(heard.context.state.listening, false);
  assert.equal(heard.requests[0][1].onDeviceOnly, false, 'online recognition requires permitted online processing');

  for (const code of ['on_device_unavailable', 'language_unavailable']) {
    const local = run(async () => { throw coded(code); });
    local.context.remoteProcessingAllowed = () => false;
    local.context.toggle(); await settle();
    assert.equal(local.requests[0][1].onDeviceOnly, true);
    assert.deepEqual(local.fallbacks, ['native_unavailable']);
    assert.deepEqual(local.queries, []);
  }
  const preferred = run(async () => 'hello');
  preferred.context.OfflineEar.wanted = () => true;
  preferred.context.toggle(); await settle();
  assert.equal(preferred.requests[0][1].onDeviceOnly, true, 'the local voice preference applies even after online consent');

  const silent = run(async () => ''); silent.context.toggle(); await settle();
  assert.deepEqual(silent.queries, []); assert.match(silent.captions.at(-1)[1], /did not hear anything/);

  const denied = run(async () => { throw coded('permission'); }); denied.context.toggle(); await settle();
  assert.match(denied.spoken[0][0], /Microphone access was denied/);
  const missing = run(async () => { throw coded('recognizer_unavailable'); }); missing.context.toggle(); await settle();
  assert.match(missing.spoken[0][0], /no speech recognizer/);

  let release;
  const cancelled = run(() => new Promise(resolve => { release = resolve; }));
  cancelled.context.toggle(); cancelled.context.toggle();
  assert.deepEqual(cancelled.stops, [true]); assert.equal(cancelled.context.state.listening, false);
  release('late words'); await settle();
  assert.deepEqual(cancelled.queries, [], 'words that arrive after the user cancelled are ignored');

  const privacy = run(async () => { throw new Error('the recognizer must not start in privacy mode'); });
  privacy.context.privacyMode = true; privacy.context.toggle(); await settle();
  assert.match(privacy.spoken[0][0], /privacy mode/); assert.equal(privacy.context.state.listening, false);
});

test('Android guardrails: screen reading is opt-in, read-only, bound by the system and unable to act for the user', () => {
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  const config = read('android/app/src/main/res/xml/astha_accessibility_service.xml');
  const service = read('android/app/src/main/java/com/astha/companion/AsthaAccessibilityService.java');
  const plugin = read('android/app/src/main/java/com/astha/companion/AsthaNativePlugin.java');
  const activity = read('android/app/src/main/java/com/astha/companion/MainActivity.java');
  assert.match(manifest, /<service[^>]*android:name="\.AsthaAccessibilityService"[^>]*android:permission="android\.permission\.BIND_ACCESSIBILITY_SERVICE"/s);
  for (const permission of ['SYSTEM_ALERT_WINDOW', 'READ_SMS', 'SEND_SMS', 'READ_CONTACTS', 'RECEIVE_BOOT_COMPLETED', 'ACCESS_FINE_LOCATION', 'ACCESS_BACKGROUND_LOCATION', 'QUERY_ALL_PACKAGES', 'WAKE_LOCK']) {
    assert.doesNotMatch(manifest, new RegExp(permission), permission + ' is not needed and must not be requested');
  }
  // The one background service is the message assistant, and its only special access is the microphone.
  assert.deepEqual([...manifest.matchAll(/android\.permission\.(FOREGROUND_SERVICE\w*)/g)].map(match => match[1]).sort(), ['FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_MICROPHONE']);
  assert.match(config, /android:canRetrieveWindowContent="true"/);
  for (const power of ['canPerformGestures', 'canRequestFilterKeyEvents', 'canRequestTouchExplorationMode', 'canTakeScreenshot', 'flagRetrieveInteractiveWindows', 'flagRequestFilterKeyEvents', 'typeAllMask', 'typeViewTextChanged', 'typeNotificationStateChanged']) {
    assert.doesNotMatch(config, new RegExp(power), power);
  }
  // Nothing is observed in the background, stored, logged, tapped or typed.
  assert.match(service, /public void onAccessibilityEvent\(AccessibilityEvent event\) \{\s*\/\/[^\n]*\n\s*\}/);
  assert.match(service, /isPassword\(\)/);
  for (const source of [service, plugin]) {
    for (const forbidden of ['ACTION_CLICK', 'ACTION_SET_TEXT', 'ACTION_PASTE', 'dispatchGesture', 'takeScreenshot', 'Log\\.', 'System\\.out', 'openFileOutput', 'HttpURLConnection']) {
      assert.doesNotMatch(source, new RegExp(forbidden), forbidden);
    }
  }
  // Every use of the service passes the in-app consent check, and consent off disables it.
  for (const method of ['readScreen', 'globalAction']) {
    assert.match(between(plugin, 'public void ' + method + '(PluginCall call)', '\n    }\n'), /permittedService\(call\)/, method);
  }
  assert.match(between(plugin, 'private AsthaAccessibilityService permittedService', '\n    }\n'), /if \(!screenConsent\(\)\)/);
  assert.match(between(plugin, 'public void openAccessibilitySettings', '\n    }\n'), /if \(!screenConsent\(\)\)/);
  assert.match(between(plugin, 'public void setScreenAccessConsent', '\n    }\n'), /disableSelf\(\)/);
  assert.deepEqual([...plugin.matchAll(/GLOBAL_ACTION_[A-Z_]+/g)].map(match => match[0]).sort(), ['GLOBAL_ACTION_BACK', 'GLOBAL_ACTION_HOME']);
  // Messages go through Android's chooser. ASTHA cannot address, send, call or text.
  for (const forbidden of ['ACTION_SENDTO', 'ACTION_CALL', 'ACTION_DIAL', 'SmsManager', 'smsto:', 'tel:', 'EXTRA_EMAIL', 'EXTRA_PHONE_NUMBER', 'setPackage']) assert.doesNotMatch(plugin, new RegExp(forbidden), forbidden);
  assert.match(between(plugin, 'public void shareText(PluginCall call)', '\n    }\n'), /Intent\.createChooser\(send, null\)/);
  assert.match(between(plugin, 'protected void handleOnPause()', '\n    }\n'), /cancelSpeechInput/, 'the recognizer stops when the app leaves the foreground');
  // App lookup uses launcher visibility, not blanket package access.
  assert.match(manifest, /<action android:name="android\.intent\.action\.MAIN" \/>\s*<category android:name="android\.intent\.category\.LAUNCHER" \/>/);
  assert.match(activity, /registerPlugin\(AsthaNativePlugin\.class\);\s*super\.onCreate/);
  // Only debug builds may trust a tester-installed certificate (for a Pi camera on a private CA).
  const network = read('android/app/src/main/res/xml/network_security_config.xml');
  assert.match(manifest, /android:networkSecurityConfig="@xml\/network_security_config"/);
  const base = between(network, '<base-config', '</base-config>');
  assert.match(base, /cleartextTrafficPermitted="false"/); assert.match(base, /src="system"/); assert.doesNotMatch(base, /src="user"/);
  assert.match(between(network, '<debug-overrides>', '</debug-overrides>'), /src="user"/);
  assert.doesNotMatch(network, /<domain-config|cleartextTrafficPermitted="true"/);
  // Bangla and English descriptions exist for the Android settings screen.
  for (const file of ['values', 'values-bn']) {
    const text = read('android/app/src/main/res/' + file + '/strings.xml');
    for (const name of ['astha_accessibility_label', 'astha_accessibility_summary', 'astha_accessibility_description']) assert.match(text, new RegExp('name="' + name + '"'), file + ' ' + name);
  }
});

test('Android guardrails: messages need consent, and the locked-phone assistant a separate choice and a spoken yes', () => {
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  const plugin = read('android/app/src/main/java/com/astha/companion/AsthaNativePlugin.java');
  const listener = read('android/app/src/main/java/com/astha/companion/AsthaNotificationListener.java');
  const assistant = read('android/app/src/main/java/com/astha/companion/AsthaMessageAssistant.java');
  const commands = read('android/app/src/main/java/com/astha/companion/MessageCommands.java');
  assert.match(manifest, /<service[^>]*android:name="\.AsthaNotificationListener"[^>]*android:permission="android\.permission\.BIND_NOTIFICATION_LISTENER_SERVICE"/s);
  const service = between(manifest, 'android:name=".AsthaMessageAssistant"', '/>');
  assert.match(service, /android:exported="false"/); assert.match(service, /android:foregroundServiceType="microphone"/);
  // Nothing is stored, logged or sent anywhere else; no app is tapped or typed into.
  for (const source of [listener, assistant, commands]) {
    for (const forbidden of ['Log\\.', 'System\\.out', 'openFileOutput', 'HttpURLConnection', 'SmsManager', 'ACTION_CLICK', 'ACTION_SET_TEXT', 'dispatchGesture', 'START_STICKY\\b', 'BOOT_COMPLETED']) {
      assert.doesNotMatch(source, new RegExp(forbidden), forbidden);
    }
  }
  // Every way to answer requires the in-app consent; withdrawing it stops the assistant and forgets.
  for (const method of ['openNotificationAccessSettings', 'replyToMessage', 'setBackgroundMessages']) {
    assert.match(between(plugin, 'public void ' + method + '(PluginCall call)', '\n    }\n'), /if \(!messageConsent\(\)\)/, method);
  }
  const revoke = between(plugin, 'public void setMessageAccessConsent', '\n    }\n');
  assert.match(revoke, /AsthaMessageAssistant\.stop\(getContext\(\)\)/); assert.match(revoke, /AsthaNotificationListener\.clear\(\)/);
  assert.match(between(plugin, 'public void load()', '\n    }\n'), /messageConsent\(\) && backgroundWanted\(\)/, 'it restarts only if the user left it on');
  // A notification goes to the page while ASTHA is in front, else to the assistant, else nowhere.
  const posted = between(listener, 'public void onNotificationPosted', '\n    }\n');
  assert.match(posted, /AsthaMessageAssistant\.appVisible \? null : AsthaMessageAssistant\.running\(\)/);
  assert.match(posted, /assistant == null && AsthaMessageAssistant\.appVisible \? receiver : null/);
  assert.match(posted, /if \(\(assistant == null && target == null\) \|\| posted == null\) return;/);
  // The assistant shows it is running, can be turned off from the notification, and sends only
  // in the confirm step after a yes. Its microphone closes on a timer and it waits during calls.
  assert.match(assistant, /\.addAction\(0, getString\(R\.string\.astha_messages_turn_off\), turnOff\)/);
  assert.match(assistant, /return START_NOT_STICKY;/); assert.match(assistant, /main\.postDelayed\(listenLimit, LISTEN_LIMIT_MS\)/);
  assert.match(assistant, /if \(inCall\(\)\)/);
  assert.match(between(plugin, 'protected void handleOnResume()', '\n    }'), /AsthaMessageAssistant\.pauseForForeground\(\)/);
  const drop = between(assistant, 'private void dropPending()', '\n    }');
  for (const required of ['++turn', 'stopListening()', 'queue.clear()', 'current = null', 'draft = ""', 'voice.stop()', 'releaseAudio()']) assert.ok(drop.includes(required), required);
  assert.match(between(assistant, 'private void answered(int heardFor, String heard)', '\n    }'), /MessageCommands\.mayAnswer\(appVisible, heardFor, turn, current != null\)/);
  assert.match(between(assistant, 'private void send()', '\n    }'), /if \(appVisible/);
  assert.match(between(assistant, 'public void onError(String id)', '\n            }'), /spoken\(id, false\)/);
  assert.match(between(assistant, 'private void spoken(String id, boolean completed)', '\n    }'), /MessageCommands\.shouldListen\(id, turn, current != null, completed\)/);
  assert.match(listener, /recent\.take\(revisionToken\)/);
  assert.match(listener, /sameInputs\(action\.getRemoteInputs\(\), currentAction\.getRemoteInputs\(\)\)/);
  assert.equal(assistant.match(/listener\.reply\(/g).length, 1); assert.equal(assistant.match(/\bsend\(\);/g).length, 1);
  assert.match(between(assistant, 'case YES:', 'break;'), /if \(MessageCommands\.CONFIRM\.equals\(stage\)\) \{\s*send\(\);/);
  assert.match(between(commands, 'if (CONFIRM.equals(stage)) {', '\n        }\n'), /return new Command\(Kind\.NO, ""\);/, 'anything but yes or change is a no');
  assert(fs.existsSync(new URL('../android/app/src/test/java/com/astha/companion/MessageCommandsTest.java', import.meta.url)), 'the spoken commands have JVM unit tests');
  for (const file of ['values', 'values-bn']) {
    const text = read('android/app/src/main/res/' + file + '/strings.xml');
    for (const name of ['astha_messages_label', 'astha_messages_running', 'astha_messages_turn_off']) assert.match(text, new RegExp('name="' + name + '"'), file + ' ' + name);
  }
});
