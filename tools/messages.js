// Personal agent for messages, in the Android app: ASTHA announces a new message, and
// sends the reply its user dictates or accepts. It never sends without a spoken yes, never
// stores or logs what a message says, and only shows the words to the online assistant
// when the user asks it to suggest a reply. In a browser none of this exists.
const AsthaMessages = (() => {
  const STATUS_KEYS = { off: 'messages_status_off', waiting: 'messages_status_waiting', on: 'messages_status_on' };
  const KEEP_FOR = 120000;         // a message can be answered for two minutes after it is read out
  const CANCEL = /^(?:cancel|never mind|forget it|ignore|skip|stop|no|nope|বাতিল|থাক|বাদ দাও|থামো|না)(?![A-Za-z0-9_ঀ-৿])/;
  // Confirm the complete answer. An affirmative prefix followed by a refusal,
  // qualification or unrelated speech must never authorize sending a message.
  const YES = /^(?:(?:yes|yeah|yep|sure|ok|okay)(?:[,\s]+send it)?|send|send it|go ahead|do it|হ্যাঁ(?:[,\s]+(?:পাঠাও|পাঠিয়ে দাও))?|হুম|জি|জ্বি|পাঠাও|পাঠিয়ে দাও|ঠিক আছে)$/;
  let status = 'off', background = false, backgroundLang = null, current = null, stage = null, draft = '', waiting = [], timer = null;
  const native = () => typeof window !== 'undefined' && window.AsthaNative ? window.AsthaNative.messages : null;
  const speechLang = () => (typeof voiceLang !== 'undefined' ? voiceLang : typeof uiLang !== 'undefined' ? uiLang : 'en') === 'bn' ? 'bn' : 'en';
  const element = id => document.getElementById(id);
  const say = (en, bn) => announce(en, bn, 'system');
  const clean = (value, limit) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
  const alive = () => Boolean(current && Date.now() - current.at < KEEP_FOR);
  function forget() { current = null; stage = null; draft = ''; }

  function render() {
    const button = element('messages-toggle');
    if (button) { button.setAttribute('aria-pressed', String(status !== 'off')); button.textContent = t(status === 'off' ? 'messages_on' : 'messages_off'); }
    const line = element('messages-status'); if (line) line.textContent = t(STATUS_KEYS[status]);
    const area = element('messages-background-area'); if (area) area.hidden = status === 'off';
    const box = element('messages-background'); if (box) box.checked = background;
  }
  async function refresh() {
    const bridge = native(); if (!bridge) return status;
    try {
      const reply = await bridge.status();
      status = !reply.consent ? 'off' : reply.enabled ? 'on' : 'waiting';
      background = reply.background === true;
    } catch { status = 'off'; background = false; }
    render();
    return status;
  }
  // The locked-phone assistant is a separate choice: Android shows a notification while it runs.
  async function setBackground(on) {
    const bridge = native(); if (!bridge || !bridge.setBackground) return;
    try {
      await bridge.setBackground(on, speechLang());
      backgroundLang = on ? speechLang() : null;
      if (on) say('Astha will read new messages aloud even when the phone is locked. A notification shows while this is on, and she listens only right after reading a message.',
        'ফোন লক থাকলেও আস্থা নতুন বার্তা পড়ে শোনাবে। এটি চালু থাকলে একটি নোটিফিকেশন দেখা যাবে, আর সে শুধু বার্তা পড়ার ঠিক পরেই শোনে।');
      else say('Astha will only read messages while she is open.', 'আস্থা শুধু খোলা থাকলেই বার্তা পড়বে।');
    } catch {
      say('Android did not allow it. Astha needs the microphone to hear your answer.', 'অ্যান্ড্রয়েড অনুমতি দেয়নি। আপনার উত্তর শুনতে আস্থার মাইক্রোফোন লাগবে।');
    }
    await refresh();
  }
  function refreshLabels() {
    render();
    // A new voice language reaches the running assistant too.
    if (background && backgroundLang && backgroundLang !== speechLang() && native()?.setBackground) {
      backgroundLang = speechLang();
      native().setBackground(true, backgroundLang).catch(() => {});
    }
  }
  async function toggle() {
    const bridge = native(); if (!bridge) return;
    if (await refresh() !== 'off') {
      await bridge.setConsent(false); waiting = []; forget(); backgroundLang = null; await refresh();
      say('Astha will no longer read or answer your messages.', 'আস্থা আর আপনার বার্তা পড়বে বা উত্তর দেবে না।');
      return;
    }
    await bridge.setConsent(true);
    say('Android will now open its notification access settings. Turn on Astha there. Android will show its own warning first.',
      'এখন অ্যান্ড্রয়েডের নোটিফিকেশন অ্যাক্সেস সেটিংস খুলবে। সেখানে আস্থা চালু করুন। অ্যান্ড্রয়েড আগে নিজের সতর্কবার্তা দেখাবে।');
    await refresh();
    try { await bridge.openSettings(); } catch { /* the status line already says it is waiting */ }
  }

  // A message is a requested update: it waits for the user and for the current answer.
  function announceNext() {
    clearTimeout(timer); timer = null;
    if (document.hidden) { waiting = []; forget(); return; }
    if (!waiting.length || stage) return;
    if (typeof AsthaExperience !== 'undefined' && !AsthaExperience.admit('medium', null)) { timer = setTimeout(announceNext, 3000); return; }
    current = { ...waiting.shift(), at: Date.now() }; stage = null; draft = '';
    const from = current.app ? current.app + ', ' + current.sender : current.sender;
    const fromBn = current.app ? current.app + '-এ ' + current.sender : current.sender;
    say('New message from ' + from + ': ' + current.text + (current.canReply ? ' Say reply and your answer, say suggest a reply, or say ignore.' : ''),
      fromBn + ' নতুন বার্তা পাঠিয়েছেন: ' + current.text + (current.canReply ? ' উত্তর দিতে বলুন উত্তর দাও এবং আপনার কথা, অথবা বলুন উত্তর সাজিয়ে দাও, অথবা বাদ দাও।' : ''));
    if (waiting.length) timer = setTimeout(announceNext, 15000);
  }
  function receive(raw) {
    if (status !== 'on' || !raw || document.hidden) return;
    const message = { key: clean(raw.key, 300), conversation: clean(raw.conversation || raw.key, 300), app: clean(raw.app, 60), sender: clean(raw.sender, 80), text: clean(raw.text, 500), canReply: raw.canReply === true };
    if (!message.key || !message.sender || !message.text) return;
    // An edited or repeated notification for the same conversation replaces the one waiting.
    if (current && current.conversation === message.conversation && current.key !== message.key) {
      forget();
      say('The conversation changed. Nothing was sent. Listen to the new message before replying.', 'কথোপকথন বদলেছে। কিছু পাঠানো হয়নি। উত্তর দেওয়ার আগে নতুন বার্তাটি শুনুন।');
    }
    waiting = waiting.filter(item => item.conversation !== message.conversation).concat(message).slice(-5);
    if (!timer) announceNext();
  }

  function confirmDraft(leadEn, leadBn) {
    stage = 'confirm';
    say(leadEn + '“' + draft + '” to ' + current.sender + '. Say yes to send it, say change to say it again, or say cancel.',
      leadBn + current.sender + '-কে “' + draft + '”। পাঠাতে বলুন হ্যাঁ, বদলাতে বলুন বদলাও, অথবা বাতিল।');
  }
  async function suggest() {
    if (typeof cloudReady !== 'function' || !cloudReady()) {
      say('I can only suggest a reply when online processing is allowed. Tell me what to say instead.', 'অনলাইন প্রসেসিংয়ের অনুমতি থাকলেই আমি উত্তর সাজিয়ে দিতে পারি। কী বলব তা আপনি বলুন।');
      stage = 'compose'; return;
    }
    const asked = current;
    try {
      const reply = await gemini('A blind person received this message from ' + asked.sender + (asked.app ? ' in ' + asked.app : '') + ': "' + asked.text +
        '". Draft a short, natural reply in the same language as the message, as they might write it themselves. Do not invent facts, promises, times or places. If a real answer needs something only they know, write a brief, polite acknowledgement instead. Return JSON {"reply": string}.', null, { maxTokens: 200 });
      if (current !== asked) return;   // another message or a cancel arrived meanwhile
      draft = clean(reply && reply.reply, 500);
      if (!draft) throw new Error('empty');
      confirmDraft('I suggest sending ', 'আমার পরামর্শ, পাঠান ');
    } catch {
      if (current !== asked) return;
      stage = 'compose';
      say('I could not think of a reply. Tell me what to say.', 'উত্তর সাজাতে পারিনি। কী বলব তা বলুন।');
    }
  }
  async function send() {
    const bridge = native(), target = current, words = draft;
    forget();
    try {
      if (!bridge || !(await bridge.reply(target.key, words))) throw new Error('not sent');
      say('Sent to ' + target.sender + '.', target.sender + '-কে পাঠানো হয়েছে।');
    } catch {
      say('I could not send it. The conversation may have changed. Nothing was sent.', 'পাঠাতে পারিনি। কথোপকথনটি বদলে থাকতে পারে। কিছুই পাঠানো হয়নি।');
    }
    announceNext();
  }
  // Returns true when the request belongs to a message being answered.
  function route(query) {
    if (!native() || status !== 'on' || document.hidden) return false;
    const said = clean(query, 600).normalize('NFC').replace(/^(?:hey\s+)?astha[,!\s]*|^আস্থা[,।\s]*/i, '');
    const q = said.toLowerCase().replace(/[.!?।\s]+$/, '');
    if (stage && !alive()) { forget(); return false; }
    if (stage === 'confirm') {
      if (YES.test(q)) { send(); return true; }
      if (/^(?:change|again|edit|বদলাও|আবার)/.test(q)) { stage = 'compose'; say('What should I say?', 'কী বলব?'); return true; }
      forget(); say('Okay, nothing was sent.', 'ঠিক আছে, কিছুই পাঠানো হয়নি।'); announceNext(); return true;
    }
    if (stage === 'compose') {
      if (CANCEL.test(q)) { forget(); say('Okay, nothing was sent.', 'ঠিক আছে, কিছুই পাঠানো হয়নি।'); announceNext(); return true; }
      draft = clean(said, 500); confirmDraft('I will send ', 'পাঠাব '); return true;
    }
    if (!alive()) return false;
    if (/^(?:read (?:it|that|the message) again|repeat (?:it|the message)|what did (?:he|she|they) say|আবার পড়ো|বার্তাটা আবার)/.test(q)) {
      say('From ' + current.sender + ': ' + current.text, current.sender + ' লিখেছেন: ' + current.text); return true;
    }
    if (/^(?:ignore|skip|dismiss|leave it|বাদ দাও|থাক)/.test(q)) { forget(); say('Okay.', 'ঠিক আছে।'); announceNext(); return true; }
    if (!current.canReply) return false;
    if (/^(?:suggest|draft|write) (?:a |the |me a )?(?:reply|answer|response)|^what should i (?:say|reply)|উত্তর সাজিয়ে দাও|কী উত্তর দেব/.test(q)) { stage = 'thinking'; suggest(); return true; }
    const reply = /^(?:reply|answer|respond|tell (?:him|her|them))(?: (?:to (?:him|her|them|it)|with|saying|that|back))*[:,]?\s*(.*)$/i.exec(said) || /^(?:উত্তর দাও|রিপ্লাই দাও|উত্তর|রিপ্লাই|বলো)[:,]?\s*(.*)$/.exec(said);
    if (!reply) return false;
    draft = clean(reply[1], 500);
    if (draft) confirmDraft('I will send ', 'পাঠাব ');
    else { stage = 'compose'; say('What should I say to ' + current.sender + '?', current.sender + '-কে কী বলব?'); }
    return true;
  }
  function boot() {
    const panel = element('messages-access'); if (!panel) return;
    panel.hidden = !native();
    const web = element('messages-web'); if (web) web.hidden = Boolean(native());
    if (!native()) return;
    element('messages-toggle')?.addEventListener('click', toggle);
    element('messages-background')?.addEventListener('change', event => setBackground(event.target.checked));
    native().onMessage(receive);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refresh();
      else { clearTimeout(timer); timer = null; waiting = []; forget(); }
    });
    refresh().then(() => { if (background) backgroundLang = speechLang(); });
  }
  return { boot, toggle, refresh, route, receive, setBackground, refreshLabels, get status() { return status; }, get background() { return background; }, get stage() { return stage; }, get pending() { return waiting.length; } };
})();
