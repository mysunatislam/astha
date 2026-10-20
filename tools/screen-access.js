// Reading other apps aloud in the Android app. Everything here is opt-in: LUNEYRA asks first,
// Android asks again in its own settings, and either side can switch it off. In a browser
// there is no native bridge and these controls stay hidden.
const AsthaScreenAccess = (() => {
  const STATUS_KEYS = { off: 'screen_status_off', waiting: 'screen_status_waiting', on: 'screen_status_on' };
  let current = 'off';
  const native = () => typeof window !== 'undefined' && window.AsthaNative ? window.AsthaNative.screen : null;
  const element = id => document.getElementById(id);
  const say = (en, bn) => announce(en, bn, 'system');
  function render() {
    const button = element('screen-access-toggle');
    if (button) { button.setAttribute('aria-pressed', String(current !== 'off')); button.textContent = t(current === 'off' ? 'screen_access_on' : 'screen_access_off'); }
    const status = element('screen-access-status'); if (status) status.textContent = t(STATUS_KEYS[current]);
  }
  async function refresh() {
    const bridge = native(); if (!bridge) return current;
    try {
      const { consent, serviceEnabled } = await bridge.status();
      current = !consent ? 'off' : serviceEnabled ? 'on' : 'waiting';
    } catch { current = 'off'; }
    render();
    return current;
  }
  // The explanation is on screen and spoken before Android's settings open.
  async function toggle() {
    const bridge = native(); if (!bridge) return;
    if (await refresh() !== 'off') {
      await bridge.setConsent(false);
      await refresh();
      say('LUNEYRA can no longer read other apps.', 'লুনেইরা আর অন্য অ্যাপ পড়তে পারবে না।');
      return;
    }
    await bridge.setConsent(true);
    say('Android will now open its Accessibility settings. Choose LUNEYRA screen reading and turn it on. Android will show its own warning first.',
      'এখন অ্যান্ড্রয়েডের অ্যাক্সেসিবিলিটি সেটিংস খুলবে। লুনেইরার স্ক্রিন পড়া বেছে চালু করুন। অ্যান্ড্রয়েড আগে নিজের সতর্কবার্তা দেখাবে।');
    await refresh();
    try { await bridge.openSettings(); } catch { /* The status line already says it is waiting. */ }
  }
  // Voice requests. Returns false when this build cannot read other apps at all.
  function route(query) {
    const bridge = native(); if (!bridge) return false;
    const q = String(query || '').toLowerCase();
    const read = /what(?:'s| is) on (?:my|the) (?:phone )?screen|read (?:my|the|this) (?:phone )?screen|স্ক্রিনে কী আছে|স্ক্রিন পড়ো/.test(q);
    const move = /^(?:(?:luneyra|luneira|astha)[,\s]*)?(?:press|go) (back|home) on (?:my|the) phone[.!\s]*$/.exec(q);
    if (!read && !move) return false;
    (async () => {
      if (await refresh() !== 'on') {
        say('Reading other apps is turned off. You can turn it on under Devices.', 'অন্য অ্যাপ পড়া বন্ধ আছে। ডিভাইস পৃষ্ঠা থেকে চালু করতে পারেন।');
        return;
      }
      try {
        if (move) { await bridge.action(move[1]); return; }
        const screen = await bridge.read();
        const text = screen.text.trim();
        if (!text) { say('I could not find any readable text on the screen.', 'পর্দায় পড়ার মতো কোনো লেখা পাইনি।'); return; }
        const more = screen.truncated ? [' There is more that I did not read.', ' আরও লেখা আছে যা পড়িনি।'] : ['', ''];
        say('On the screen: ' + text + more[0], 'পর্দায় আছে: ' + text + more[1]);
      } catch { say('I could not read the screen just now.', 'এই মুহূর্তে পর্দা পড়তে পারিনি।'); }
    })();
    return true;
  }
  // Opening an app or preparing a message uses ordinary Android intents, not the screen
  // reader. LUNEYRA asks first every time, and never chooses a recipient or presses send.
  function routeAction(query) {
    const apps = typeof window !== 'undefined' && window.AsthaNative ? window.AsthaNative.apps : null;
    if (!apps) return false;
    const q = String(query || '').trim().replace(/^(?:hey\s+|হেই\s+|হে\s+)?(?:luneyra|luneira|লুনেইরা|লুনেয়রা|astha|আস্থা)[,!।\s]*/i, '').replace(/[.!?।\s]+$/, '');
    const open = /^(?:open|launch|start) (?:the |my )?(.{2,40}?) app$/i.exec(q) || /^(.{2,40}?) অ্যাপ(?:টি|টা)? (?:খোলো|খুলুন|খুলো|চালু করো)$/.exec(q);
    const message = /^(?:send|write|compose) (?:a |the )?message(?: saying| that says|:|,)?\s+(.{1,500})$/i.exec(q) || /^(?:বার্তা|মেসেজ) (?:লেখো|লিখো|পাঠাও)[:,]?\s+(.{1,500})$/.exec(q);
    if (!open && !message) return false;
    (async () => {
      try {
        if (message) {
          const text = message[1].trim();
          askYesNo('I will open the share menu with this message: ' + text + '. You choose the app and the person, and you press send. Shall I open it?',
            'এই বার্তাটি নিয়ে শেয়ার মেনু খুলব: ' + text + '। অ্যাপ ও ব্যক্তি আপনি বেছে নেবেন, পাঠানোর বোতামও আপনি চাপবেন। খুলব?',
            () => apps.share(text).catch(() => say('I could not open the share menu.', 'শেয়ার মেনু খুলতে পারিনি।')),
            () => say('Okay, nothing was opened.', 'ঠিক আছে, কিছু খোলা হয়নি।'));
          return;
        }
        const found = await apps.find(open[1].trim());
        if (!found.length) { say('I could not find an app called ' + open[1].trim() + ' on this phone.', 'এই ফোনে ' + open[1].trim() + ' নামে কোনো অ্যাপ পাইনি।'); return; }
        if (found.length > 1) { const names = found.map(app => app.label).join(', '); say('I found more than one: ' + names + '. Say the full name.', 'একাধিক অ্যাপ পেয়েছি: ' + names + '। পুরো নাম বলুন।'); return; }
        askYesNo('Open ' + found[0].label + '?', found[0].label + ' খুলব?',
          () => apps.open(found[0].id).catch(() => say('I could not open it.', 'খুলতে পারিনি।')),
          () => say('Okay, nothing was opened.', 'ঠিক আছে, কিছু খোলা হয়নি।'));
      } catch { say('I could not do that just now.', 'এই মুহূর্তে করতে পারিনি।'); }
    })();
    return true;
  }
  function boot() {
    const panel = element('screen-access'); if (!panel) return;
    panel.hidden = !native();
    if (!native()) return;
    element('screen-access-toggle')?.addEventListener('click', toggle);
    // The user returns here from Android settings; show what they chose.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    refresh();
  }
  return { boot, toggle, refresh, route: query => route(query) || routeAction(query), refreshLabels: render, get status() { return current; } };
})();
