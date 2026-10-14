
/* =====================================================================
   15. Astha's eye on your screen
       The heart is Astha's eye. With screen sharing (one permission dialog) Astha
       watches the whole screen, recognises the app you are in, finds buttons and
       text, guides you by voice, confirms when something worked, and opens apps
       or sites herself where the browser allows it.
   ===================================================================== */
const SCREEN_APPS = [
  { id: 'facebook', en: 'Facebook', bn: 'ফেসবুক', words: /facebook|\bfb\.com|news feed|marketplace|what's on your mind/i, url: 'https://www.facebook.com', prompts: ['the Facebook website open in a browser', 'a social media news feed with a blue header'] },
  { id: 'youtube', en: 'YouTube', bn: 'ইউটিউব', words: /youtube|subscriptions|shorts/i, url: 'https://www.youtube.com', prompts: ['the YouTube website with video thumbnails'] },
  { id: 'gmail', en: 'Gmail', bn: 'জিমেইল', words: /gmail|\binbox\b|compose/i, url: 'https://mail.google.com', prompts: ['the Gmail inbox with a list of emails'] },
  { id: 'whatsapp', en: 'WhatsApp', bn: 'হোয়াটসঅ্যাপ', words: /whatsapp/i, url: 'https://web.whatsapp.com', prompts: ['WhatsApp web with a chat list'] },
  { id: 'vscode', en: 'VS Code', bn: 'ভিএস কোড', words: /visual studio code|vs code|\bexplorer\b.*\boutline\b|problems\s+output\s+debug console|\.py\b|\.js\b|\.ts\b|\.html\b/i, url: 'vscode://', prompts: ['the Visual Studio Code editor with a dark theme and code', 'a code editor with a file explorer sidebar'] },
  { id: 'terminal', en: 'the terminal', bn: 'টার্মিনাল', words: /powershell|command prompt|cmd\.exe|windows terminal|\bbash\b|PS [A-Z]:\\/i, prompts: ['a black terminal window with white text', 'a command prompt window'] },
  { id: 'explorer', en: 'File Explorer', bn: 'ফাইল এক্সপ্লোরার', words: /file explorer|this pc|quick access|\bdownloads\b.*\bdocuments\b/i, prompts: ['the Windows File Explorer with folders'] },
  { id: 'word', en: 'Microsoft Word', bn: 'মাইক্রোসফট ওয়ার্ড', words: /microsoft word|\.docx|\bword\b.*\bhome\s+insert\b/i, prompts: ['a Microsoft Word document'] },
  { id: 'settings', en: 'Windows Settings', bn: 'উইন্ডোজ সেটিংস', words: /bluetooth & devices|network & internet|personalization|find a setting/i, prompts: ['the Windows Settings app'] },
  { id: 'astha', en: 'Astha', bn: 'আস্থা', words: /astha vision|voice-first visual companion/i, prompts: [] },
  { id: 'google', en: 'Google search', bn: 'গুগল সার্চ', words: /search google or type a url|google search|i'm feeling lucky/i, url: 'https://www.google.com', prompts: ['a web browser showing the Google search page', 'an empty browser new tab'] },
  { id: 'desktop', en: 'the desktop', bn: 'ডেস্কটপ', words: /recycle bin/i, prompts: ['the Windows desktop with icons and wallpaper and a taskbar'] },
];
const SCREEN_APP_BY_ID = Object.fromEntries(SCREEN_APPS.map(a => [a.id, a]));
const APP_ALIASES = { 'vs code': 'vscode', vscode: 'vscode', code: 'vscode', 'visual studio': 'vscode', facebook: 'facebook', fb: 'facebook', youtube: 'youtube', gmail: 'gmail', mail: 'gmail', email: 'gmail', whatsapp: 'whatsapp', terminal: 'terminal', powershell: 'terminal', cmd: 'terminal', explorer: 'explorer', 'file explorer': 'explorer', files: 'explorer', word: 'word', settings: 'settings', browser: 'google', chrome: 'google', google: 'google', 'ফেসবুক': 'facebook', 'ইউটিউব': 'youtube', 'জিমেইল': 'gmail', 'হোয়াটসঅ্যাপ': 'whatsapp', 'ভিএস কোড': 'vscode', 'টার্মিনাল': 'terminal', 'ব্রাউজার': 'google', 'গুগল': 'google' };
const DIALOG_BUTTONS = /^(cancel|close|ok|okay|allow|block|not now|dismiss|got it|accept|decline|skip|no thanks|later|বাতিল|ঠিক আছে)$/i;

const eye = { active: false, stream: null, timer: null, busy: false, app: null, appSince: 0, target: null, lastGuideAt: 0, dialog: null, words: [], lines: [], text: '', frameW: 0, frameH: 0, pendingCheck: null };

// Short, practical explanations for the errors blind developers hit most.
const ERROR_HINTS = [
  { re: /NameError: name '([^']+)' is not defined/i, en: m => `Python does not know the name ${m[1]}. Define it before this line, or check the spelling.`, bn: m => `পাইথন ${m[1]} নামটি চেনে না। এই লাইনের আগে এটি সংজ্ঞায়িত করুন, বা বানান দেখুন।` },
  { re: /ModuleNotFoundError: No module named '([^']+)'/i, en: m => `The module ${m[1]} is not installed. Run pip install ${m[1]}.`, bn: m => `${m[1]} মডিউলটি ইনস্টল নেই। pip install ${m[1]} চালান।` },
  { re: /SyntaxError[^\n]*\n?[\s\S]*?line (\d+)/i, en: m => `There is a syntax error near line ${m[1]}. Check brackets, quotes and colons on that line.`, bn: m => `লাইন ${m[1]}-এর কাছে সিনট্যাক্স ভুল আছে। ব্র্যাকেট, কোটেশন ও কোলন দেখুন।` },
  { re: /IndentationError/i, en: () => 'The indentation is wrong. Make sure the lines inside a block start with the same number of spaces.', bn: () => 'ইনডেন্টেশন ভুল। ব্লকের ভেতরের লাইনগুলো একই সংখ্যক স্পেস দিয়ে শুরু করুন।' },
  { re: /TypeError: ([^\n]+)/i, en: m => `A type error: ${m[1]}. A value is being used as the wrong kind of thing, for example text as a number.`, bn: m => `টাইপ ভুল: ${m[1]}। একটি মান ভুল ধরনের হিসেবে ব্যবহার হচ্ছে।` },
  { re: /EADDRINUSE|address already in use/i, en: () => 'The port is already in use. Stop the other server or choose a different port.', bn: () => 'পোর্টটি আগে থেকেই ব্যবহারে আছে। অন্য সার্ভারটি বন্ধ করুন বা অন্য পোর্ট নিন।' },
  { re: /ENOENT|No such file or directory/i, en: () => 'A file or folder was not found. Check the path and that you are in the right folder.', bn: () => 'ফাইল বা ফোল্ডার পাওয়া যায়নি। পাথ ও বর্তমান ফোল্ডার দেখুন।' },
  { re: /permission denied|EACCES/i, en: () => 'Permission denied. You may need administrator rights or a different folder.', bn: () => 'অনুমতি নেই। অ্যাডমিন অধিকার বা অন্য ফোল্ডার লাগতে পারে।' },
  { re: /command not found|is not recognized as an internal or external command|is not recognized as the name of a cmdlet/i, en: () => 'That command is not installed or not on your PATH.', bn: () => 'কমান্ডটি ইনস্টল নেই বা PATH-এ নেই।' },
  { re: /npm ERR!|ERR_MODULE_NOT_FOUND|Cannot find module '([^']+)'/i, en: m => m[1] ? `Node cannot find the module ${m[1]}. Run npm install.` : 'npm reported an error. Run npm install and read the last lines.', bn: m => m[1] ? `নোড ${m[1]} মডিউলটি পাচ্ছে না। npm install চালান।` : 'npm একটি ভুল জানিয়েছে। npm install চালান।' },
  { re: /\b404\b/, en: () => 'The address was not found, error 404. Check the URL.', bn: () => 'ঠিকানাটি পাওয়া যায়নি, ৪০৪ ভুল। ইউআরএল দেখুন।' },
];

function eyePill(text, cls) { const p = $('eye-pill'); if (p) { p.textContent = text; p.className = 'pill ' + (cls || ''); } }
function eyeSay(en, bn) { announce(en, bn, 'system'); }

async function eyeStart() {
  if (eye.active) return eyeSay('I am already watching your screen.', 'আমি আগে থেকেই আপনার স্ক্রিন দেখছি।');
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return eyeSay('Screen sharing is not available in this browser. Use Chrome or Edge on a computer.', 'এই ব্রাউজারে স্ক্রিন শেয়ার নেই। কম্পিউটারে Chrome বা Edge ব্যবহার করুন।');
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false });
    eye.stream = stream; eye.active = true;
    const v = $('eye-video'); v.srcObject = stream; v.hidden = false; await v.play();
    $('eye-empty').hidden = true; $('eye-heart').hidden = false;
    $('eye-start').textContent = t('eye_stop');
    stream.getVideoTracks()[0].addEventListener('ended', () => eyeStop(true));
    eyePill(t('eye_watching'), 'ok'); playEarcon('confirm');
    eyeSay('I can see your screen now. I will tell you which app you are in and guide you when you ask.', 'এখন আমি আপনার স্ক্রিন দেখতে পাচ্ছি। কোন অ্যাপে আছেন বলব, আর চাইলে পথ দেখাব।');
    logEvent('Screen eye on');
    ensureOcr().catch(() => {});
    eye.timer = setTimeout(eyeTick, 800);
    eye.prevGray = null; clearTimeout(eye.motionTimer); eye.motionTimer = setTimeout(eyeMotionLoop, 1000);
  } catch (e) {
    console.warn('screen share', e);
    // Playback can fail after the browser granted capture; never leave that stream running.
    if (eye.active) eyeStop(true);
    eyeSay('Screen sharing was not allowed. Choose “Entire screen” in the dialog and press Share.', 'স্ক্রিন শেয়ারের অনুমতি পাওয়া যায়নি। ডায়ালগে “Entire screen” বেছে Share চাপুন।');
  }
}
function eyeStop(silent) {
  if (!eye.active) return;
  eye.active = false; clearTimeout(eye.timer); eye.timer = null; clearTimeout(eye.motionTimer); eye.motionTimer = null;
  if (eye.stream) { eye.stream.getTracks().forEach(t => t.stop()); eye.stream = null; }
  const v = $('eye-video'); v.srcObject = null; v.hidden = true; $('eye-empty').hidden = false; $('eye-heart').hidden = true;
  $('eye-start').textContent = t('eye_start');
  eyePill(t('eye_idle'), ''); eye.app = null; eye.dialog = null; eye.target = null;
  if (!silent) eyeSay('I have stopped watching your screen.', 'আপনার স্ক্রিন দেখা বন্ধ করেছি।');
  logEvent('Screen eye off');
}
function toggleEye() { eye.active ? eyeStop() : eyeStart(); }
function eyeFrame(maxW = 1100) {
  const v = $('eye-video'); if (!eye.active || !v.videoWidth) return null;
  const scale = Math.min(1, maxW / v.videoWidth);
  const c = document.createElement('canvas'); c.width = Math.round(v.videoWidth * scale); c.height = Math.round(v.videoHeight * scale);
  c.getContext('2d', { willReadFrequently: true }).drawImage(v, 0, 0, c.width, c.height);
  return c;
}
function eyeHeart(o) {
  const h = $('eye-heart'); if (!h) return;
  h.hidden = false;
  if (o.x != null) h.style.left = (Math.min(Math.max(o.x, 0.04), 0.96) * 100) + '%';
  if (o.y != null) h.style.top = (Math.min(Math.max(o.y, 0.06), 0.9) * 100) + '%';
  if (o.mode) h.className = 'heart ' + o.mode;
  const lab = $('eye-heart-label'); lab.textContent = o.label || ''; lab.hidden = !o.label;
}
// "top right corner", "middle of the screen" — spoken positions for a normalised point.
function locationPhrase(x, y) {
  const row = y < 0.33 ? 'top' : y > 0.67 ? 'bottom' : 'middle';
  const col = x < 0.33 ? 'left' : x > 0.67 ? 'right' : 'center';
  const rowBn = { top: 'উপরে', bottom: 'নিচে', middle: 'মাঝে' }[row], colBn = { left: 'বাঁ দিকে', right: 'ডান দিকে', center: 'মাঝামাঝি' }[col];
  if (row === 'middle' && col === 'center') return { en: 'the middle of the screen', bn: 'স্ক্রিনের মাঝখানে' };
  if (row !== 'middle' && col !== 'center') return { en: `the ${row} ${col} corner`, bn: `${rowBn} ${colBn} কোণায়` };
  if (row === 'middle') return { en: `the ${col} side, halfway down`, bn: `${colBn}, মাঝ বরাবর` };
  return { en: `the ${row} ${col === 'center' ? 'center' : col}`, bn: `${rowBn} ${colBn}` };
}

async function eyeTick() {
  if (!eye.active) return;
  let next = 3000;
  try {
    if (!eye.busy && engine.ocr.status !== 'error') {
      eye.busy = true;
      const frame = eyeFrame(1100);
      if (frame) {
        eye.frameW = frame.width; eye.frameH = frame.height;
        const worker = await ensureOcr();
        const { data } = await worker.recognize(frame);
        const words = (data.words || []).filter(w => w.confidence >= 55 && /[\p{L}\p{N}]{2,}/u.test(w.text)).map(w => ({ text: w.text.trim(), x: (w.bbox.x0 + w.bbox.x1) / 2 / frame.width, y: (w.bbox.y0 + w.bbox.y1) / 2 / frame.height, w: (w.bbox.x1 - w.bbox.x0) / frame.width }));
        eye.words = words;
        eye.lines = (data.lines || []).filter(l => l.confidence >= 55).map(l => cleanOcrLine(l.text)).filter(l => l.replace(/[^\p{L}\p{N}]/gu, '').length >= 3);
        eye.text = eye.lines.join('\n');
        const titleText = words.filter(w => w.y < 0.12).map(w => w.text).join(' ');
        await eyeInterpret(frame, titleText, eye.text, words);
      }
    }
  } catch (e) { console.warn('eye tick', e); next = 4000; }
  finally { eye.busy = false; }
  if (eye.active) eye.timer = setTimeout(eyeTick, next);
}

async function eyeInterpret(frame, titleText, text, words) {
  const now = Date.now();
  // 1. Which app? Title bar words win, then any screen text, then how the screen looks.
  let app = SCREEN_APPS.find(a => a.words.test(titleText)) || SCREEN_APPS.find(a => a.words.test(text)) || null;
  if (!app && engine.clip.status === 'ready') {
    const set = await getPromptSet('screen_apps', SCREEN_APPS.filter(a => a.prompts.length).map(a => ({ id: a.id, prompts: a.prompts })));
    if (set) {
      const [emb] = await clipEmbedCrops(frame, [{ x: 0, y: 0, s: Math.min(frame.width, frame.height) }]);
      const r = rankAgainst(emb, set)[0];
      if (r && r.p >= 0.35) app = SCREEN_APP_BY_ID[r.id];
    }
  }
  if (app && (!eye.app || app.id !== eye.app.id)) {
    eye.app = app; eye.appSince = now;
    eyePill('In ' + app.en, 'ok');
    eyeHeart({ x: 0.5, y: 0.08, mode: 'lock', label: app.en });
    if (eye.target && app.id === eye.target) { eye.target = null; eyeSay(`Perfect. You are in ${app.en} now.`, `চমৎকার। আপনি এখন ${app.bn}-এ আছেন।`); playEarcon('confirm'); }
    else if (!speaking()) eyeSay(`You are on ${app.en} now.`, `আপনি এখন ${app.bn}-এ আছেন।`);
    logEvent('Screen: ' + app.en);
    // Editors and documents: offer to read what the user wrote (once per app switch).
    if (['vscode', 'word', 'gmail', 'terminal'].includes(app.id) && now - (eye.lastOffer || 0) > 30000) {
      eye.lastOffer = now;
      setTimeout(() => { if (eye.active && eye.app && eye.app.id === app.id) askYesNo('Do you want me to read aloud what is written there?', 'সেখানে যা লেখা আছে, পড়ে শোনাব?', () => eyeReadScreen()); }, 2500);
    }
  }
  // 2. Pop-ups: a dialog button near the middle of the screen.
  const button = words.find(w => DIALOG_BUTTONS.test(w.text) && w.x > 0.2 && w.x < 0.85 && w.y > 0.2 && w.y < 0.85);
  if (button && !eye.dialog) {
    eye.dialog = { text: button.text, x: button.x, y: button.y, since: now };
    const loc = locationPhrase(button.x, button.y);
    eye.heartHoldUntil = now + 8000;
    eyeHeart({ x: button.x, y: button.y, mode: 'seek', label: button.text });
    eyeSay(`There is a pop-up. Its “${button.text}” button is at ${loc.en}. Press Escape, or Tab to it and press Enter.`, `একটি পপ-আপ এসেছে। এর “${button.text}” বোতামটি ${loc.bn}। Escape চাপুন, অথবা Tab দিয়ে গিয়ে Enter চাপুন।`);
    playEarcon('hazard');
  } else if (!button && eye.dialog && now - eye.dialog.since > 2500) {
    eye.dialog = null;
    eyeSay('Yes, perfect. The pop-up is gone.', 'হ্যাঁ, চমৎকার। পপ-আপটি চলে গেছে।'); playEarcon('confirm');
    eyeHeart({ x: 0.5, y: 0.08, mode: 'lock', label: eye.app ? eye.app.en : '' });
  }
  // 3. Getting to the target app: remind gently, never nag.
  if (eye.target && (!eye.app || eye.app.id !== eye.target) && now - eye.lastGuideAt > 25000 && !speaking()) {
    eye.lastGuideAt = now; eyeGuideTo(eye.target, true);
  }
}
function speaking() { return asthaSpeaking(); }

// ---- The heart follows where you are working (frame-difference hot spot) --------
function eyeMotionLoop() {
  if (!eye.active) return;
  try {
    const v = $('eye-video');
    if (v.videoWidth) {
      const W = 64, H = 36; const c = eyeMotionLoop.c || (eyeMotionLoop.c = document.createElement('canvas')); c.width = W; c.height = H;
      const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(v, 0, 0, W, H);
      const d = ctx.getImageData(0, 0, W, H).data; const g = new Float32Array(W * H);
      for (let i = 0; i < W * H; i++) g[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3;
      if (eye.prevGray) {
        let best = 0, bi = -1;
        for (let i = 0; i < W * H; i++) { const df = Math.abs(g[i] - eye.prevGray[i]); if (df > best) { best = df; bi = i; } }
        // Ignore global changes (scrolling, app switch); follow small local changes such as typing.
        let changed = 0; for (let i = 0; i < W * H; i++) if (Math.abs(g[i] - eye.prevGray[i]) > 12) changed++;
        const now = Date.now();
        if (best > 10 && changed < W * H * 0.15 && bi >= 0 && now - (eye.heartHoldUntil || 0) > 0) {
          eye.workX = (bi % W + 0.5) / W; eye.workY = (Math.floor(bi / W) + 0.5) / H; eye.workAt = now;
          eyeHeart({ x: eye.workX, y: eye.workY, mode: 'lock', label: 'working here' });
        }
      }
      eye.prevGray = g;
    }
  } catch (e) {}
  eye.motionTimer = setTimeout(eyeMotionLoop, 400);
}
// Read the document, code or chat that is on screen (cloud transcription when available, OCR otherwise).
async function eyeReadScreen() {
  if (!eye.active) return eyeWhatsOnScreen();
  const frame = eyeFrame(1280); if (!frame) return;
  let text = '', summaryEn = '', summaryBn = '';
  if (cloudReady()) {
    try { const r = await cloudScreen(frame); text = (r.content || '').trim(); summaryEn = r.en || ''; summaryBn = r.bn || ''; eye.lastCloud = r; } catch (e) { cloudFail(e); }
  }
  if (!text) {
    // Editor area heuristic: skip the title/tab strip and the file sidebar.
    const words = eye.words.filter(w => w.y > 0.1 && w.x > 0.16);
    text = eye.lines.filter(l => words.some(w => l.includes(w.text))).join('\n') || eye.text;
  }
  if (!text) return eyeSay('I do not see any text to read on the screen.', 'স্ক্রিনে পড়ার মতো লেখা দেখছি না।');
  const app = eye.app ? eye.app.en : 'the screen';
  setCaption('Reading the screen', text.slice(0, 400) + (text.length > 400 ? '…' : ''), 'ocr');
  $('reader-text').value = text;
  reader.onFinish = () => { if (summaryEn) speak(summaryEn, summaryBn); };
  speak(`Reading from ${app}.`, `${eye.app ? eye.app.bn : 'স্ক্রিন'} থেকে পড়ছি।`);
  setTimeout(() => startReader(text), 1200);
  logEvent('Screen: read ' + text.length + ' characters');
}

// ---- Commands ------------------------------------------------------------
function eyeWhatsOnScreen() {
  if (!eye.active) return eyeSay('I cannot see your screen yet. Say “watch my screen” or press the button, then choose “Entire screen”.', 'এখনো আপনার স্ক্রিন দেখতে পাচ্ছি না। বলুন “স্ক্রিন দেখো”, তারপর “Entire screen” বেছে নিন।');
  if (cloudReady()) {
    const frame = eyeFrame(1280);
    if (frame) return cloudScreen(frame).then(r => {
      eye.lastCloud = r;
      let en = r.en || '', bn = r.bn || '';
      if (r.dialog && r.dialog.present) { en += ` There is a pop-up; its ${r.dialog.button || 'close'} button is at the ${r.dialog.location || 'center'}.`; bn += ` একটি পপ-আপ আছে; এর ${r.dialog.button || 'close'} বোতাম ${r.dialog.location || 'center'}-এ।`; }
      if (r.error && r.error.present) { en += ` An error says: ${r.error.line}. ${r.error.fix || ''}`; bn += ` একটি ভুল দেখাচ্ছে: ${r.error.line}। ${r.error.fix || ''}`; }
      eyeSay(en, bn);
      if ((r.content || '').trim()) askYesNo('Do you want me to read what is written there?', 'সেখানে যা লেখা আছে পড়ে শোনাব?', () => { $('reader-text').value = r.content; startReader(r.content); });
    }).catch(e => { cloudFail(e); eyeWhatsOnScreenLocal(); });
  }
  eyeWhatsOnScreenLocal();
}
function eyeWhatsOnScreenLocal() {
  const app = eye.app;
  const first = eye.lines.slice(0, 3).join('. ');
  let en = app ? `You are on ${app.en}.` : 'I am not sure which app this is yet.';
  let bn = app ? `আপনি ${app.bn}-এ আছেন।` : 'কোন অ্যাপ এটা এখনো নিশ্চিত নই।';
  if (eye.dialog) { const loc = locationPhrase(eye.dialog.x, eye.dialog.y); en += ` A pop-up is open; its ${eye.dialog.text} button is at ${loc.en}.`; bn += ` একটি পপ-আপ খোলা; এর ${eye.dialog.text} বোতাম ${loc.bn}।`; }
  if (first) { en += ` The screen says: ${first.slice(0, 220)}.`; bn += ` স্ক্রিনে লেখা: ${first.slice(0, 220)}।`; }
  eyeSay(en, bn);
}
function eyeFind(query) {
  if (!eye.active) return eyeWhatsOnScreen();
  const m = (query || '').toLowerCase().match(/(?:where(?:'s| is)?|find|locate|কোথায়)\s+(?:the\s+|is\s+the\s+)?([a-z0-9 ]{2,30}?)(?:\s+button|\s+icon|\s+link|\s+বোতাম)?\s*\??$/i);
  const term = m ? m[1].trim() : (query || '').replace(/where is|where's|find|locate|button|the/gi, '').trim();
  if (!term) return eyeWhatsOnScreen();
  const hit = eye.words.find(w => w.text.toLowerCase().includes(term)) || eye.words.find(w => term.includes(w.text.toLowerCase()) && w.text.length >= 3);
  if (!hit) return eyeSay(`I do not see “${term}” on the screen right now.`, `এখন স্ক্রিনে “${term}” দেখছি না।`);
  const loc = locationPhrase(hit.x, hit.y);
  eye.heartHoldUntil = Date.now() + 8000;
  eyeHeart({ x: hit.x, y: hit.y, mode: 'lock', label: hit.text });
  eyeSay(`“${hit.text}” is at ${loc.en}.`, `“${hit.text}” আছে ${loc.bn}।`); playEarcon('confirm');
}
function eyeReadError() {
  const pasted = ($('eye-paste') && $('eye-paste').value || '').trim();
  const text = pasted || eye.text;
  if (!text) return eyeSay('I do not see any text to read. Share your screen or paste the output into the box.', 'পড়ার মতো কোনো লেখা দেখছি না। স্ক্রিন শেয়ার করুন বা আউটপুট বক্সে দিন।');
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const errLine = [...lines].reverse().find(l => /error|exception|traceback|failed|not found|denied|not recognized|ERR!/i.test(l));
  if (!errLine) return eyeSay('I do not see an error on the screen. The last line says: ' + lines[lines.length - 1], 'স্ক্রিনে কোনো ভুল দেখছি না। শেষ লাইনে লেখা: ' + lines[lines.length - 1]);
  const hint = ERROR_HINTS.find(h => h.re.test(text)); const m = hint ? text.match(hint.re) : null;
  eyeSay(`The error says: “${errLine}”.` + (hint ? ' ' + hint.en(m) : ''), `ভুলটি বলছে: “${errLine}”।` + (hint ? ' ' + hint.bn(m) : ''));
  playEarcon('confirm'); logEvent('Screen: read error');
}
// Explain whatever is on the shared screen or pasted in: a slide, a document, a chat, a
// design, a form or code. Online it is understood as a whole; offline the text is read.
async function eyeExplain(query) {
  const pasted = ($('eye-paste') && $('eye-paste').value || '').trim();
  const frame = eye.active ? eyeFrame(1280) : null;
  if (!frame && !pasted && !eye.text) return eyeSay('Share your screen first, or paste the text into the box, and I will explain it.', 'আগে স্ক্রিন শেয়ার করুন, অথবা লেখাটি বাক্সে পেস্ট করুন, আমি বুঝিয়ে বলব।');
  if (typeof cloudReady === 'function' && cloudReady()) {
    try {
      const ask = String(query || '').trim().slice(0, 300);
      const r = await gemini('The user is blind and wants help with what is on their screen' + (ask ? '. They said: "' + ask + '"' : '') + '. ' +
        (pasted ? 'Text they pasted:\n' + pasted.slice(0, 6000) + '\n' : '') +
        'Say what kind of thing it is (a slide, a document, a message, a web page, a design, a form, a spreadsheet, code or something else), explain its main content plainly, and say what they could do next. Use only what is visible or pasted; do not invent anything. Return JSON {"en": string, "bn": string}.',
        frame, { maxW: 1280, maxTokens: 900 });
      if (r && (r.en || r.bn)) { eyeSay(r.en || r.bn, r.bn || r.en); playEarcon('confirm'); logEvent('Screen: explained'); return; }
    } catch (e) { if (typeof cloudFail === 'function') cloudFail(e); }
  }
  // Without online processing there is no explanation to give, only the words themselves.
  const text = pasted || eye.text;
  if (!text) return eyeSay('I can see the screen, but I need online processing to explain it.', 'পর্দা দেখতে পাচ্ছি, কিন্তু বুঝিয়ে বলতে অনলাইন প্রসেসিং দরকার।');
  eyeSay('I need online processing to explain it, so I will read it to you instead.', 'বুঝিয়ে বলতে অনলাইন প্রসেসিং দরকার, তাই লেখাটি পড়ে শোনাচ্ছি।');
  startReader(text);
}
function appFromText(q) {
  const s = (q || '').toLowerCase();
  const keys = Object.keys(APP_ALIASES).sort((a, b) => b.length - a.length);
  for (const k of keys) if (s.includes(k)) return APP_ALIASES[k];
  return null;
}
// "Open VS Code", "go to Facebook": open it herself when possible, otherwise guide the keys and watch for arrival.
function eyeOpen(query) {
  const id = appFromText(query) || eye.target;
  if (!id) return eyeSay('Which app? Say for example: open VS Code, or open Facebook.', 'কোন অ্যাপ? যেমন বলুন: ভিএস কোড খোলো, বা ফেসবুক খোলো।');
  const app = SCREEN_APP_BY_ID[id]; eye.target = id; eye.lastGuideAt = Date.now();
  if (app.url) {
    let win = null; try { win = window.open(app.url, '_blank'); } catch (e) {}
    if (win || app.url.startsWith('vscode://')) { eyeSay(`Opening ${app.en} for you. I will confirm when I see it.`, `${app.bn} খুলে দিচ্ছি। দেখতে পেলেই জানাব।`); playEarcon('confirm'); logEvent('Opened ' + app.en); return; }
  }
  eyeGuideTo(id, false);
}
function eyeGuideTo(id, reminder) {
  const app = SCREEN_APP_BY_ID[id]; if (!app) return;
  const cur = eye.app ? `You are on ${eye.app.en}. ` : '';
  const curBn = eye.app ? `আপনি ${eye.app.bn}-এ আছেন। ` : '';
  const how = { vscode: ['Press the Windows key, type code, and press Enter.', 'Windows কী চাপুন, code লিখুন, Enter চাপুন।'], terminal: ['Press the Windows key, type terminal, and press Enter.', 'Windows কী চাপুন, terminal লিখুন, Enter চাপুন।'], explorer: ['Press Windows and E together.', 'Windows আর E একসাথে চাপুন।'], settings: ['Press Windows and I together.', 'Windows আর I একসাথে চাপুন।'], word: ['Press the Windows key, type word, and press Enter.', 'Windows কী চাপুন, word লিখুন, Enter চাপুন।'] }[id]
    || [`Press Control and T for a new tab, type ${app.en.toLowerCase().replace('the ', '')}, and press Enter.`, `নতুন ট্যাবের জন্য Control আর T চাপুন, ${app.en} লিখুন, Enter চাপুন।`];
  eyeSay(`${cur}${reminder ? 'Still not in ' + app.en + '. ' : ''}${how[0]} I will tell you when you are there.`, `${curBn}${reminder ? 'এখনো ' + app.bn + '-এ পৌঁছাননি। ' : ''}${how[1]} পৌঁছালে আমি বলব।`);
  eyePill('Guiding to ' + app.en, 'warn');
}
function eyeSetTask(query) {
  const id = appFromText(query) || (/code|program|coding|কোড/i.test(query) ? 'vscode' : null);
  if (!id) return eyeWhatsOnScreen();
  eye.target = id;
  if (eye.app && eye.app.id === id) return eyeSay(`You are already in ${SCREEN_APP_BY_ID[id].en}. Go ahead.`, `আপনি আগে থেকেই ${SCREEN_APP_BY_ID[id].bn}-এ আছেন। শুরু করুন।`);
  eyeGuideTo(id, false);
}
function eyeCloseDialog() {
  if (!eye.dialog) return eyeSay('I do not see a pop-up right now.', 'এখন কোনো পপ-আপ দেখছি না।');
  const loc = locationPhrase(eye.dialog.x, eye.dialog.y);
  eyeSay(`Press Escape. If it stays, the ${eye.dialog.text} button is at ${loc.en}; press Tab until you hear it, then Enter.`, `Escape চাপুন। না গেলে ${eye.dialog.text} বোতামটি ${loc.bn}; Tab চাপতে থাকুন, তারপর Enter।`);
}

// ---- Keyboard guidance on this page ----------------------------------------
function accessibleName(el) {
  if (!el) return '';
  const aria = el.getAttribute && el.getAttribute('aria-label'); if (aria) return aria;
  if (el.id) { const lab = document.querySelector(`label[for="${el.id}"]`); if (lab) return lab.textContent.trim().split('\n')[0]; }
  const lab = el.closest && el.closest('label'); if (lab) return lab.textContent.trim().split('\n')[0];
  return (el.innerText || el.value || el.placeholder || el.tagName || '').trim().split('\n')[0].slice(0, 60);
}
let focusNarration = false;
function toggleFocusNarration() {
  focusNarration = !focusNarration;
  $('focus-switch').setAttribute('aria-checked', focusNarration);
  eyeSay(focusNarration ? 'Keyboard guidance is on. I will name each control as you move to it.' : 'Keyboard guidance is off.', focusNarration ? 'কীবোর্ড গাইড চালু। যেখানে যাবেন আমি নাম বলব।' : 'কীবোর্ড গাইড বন্ধ।');
}
function eyeBoot() {
  if (!$('eye-card')) return;
  document.addEventListener('focusin', e => {
    if (!focusNarration) return;
    const name = accessibleName(e.target); if (!name) return;
    const role = e.target.tagName === 'BUTTON' ? 'button' : e.target.tagName === 'SELECT' ? 'menu' : /INPUT|TEXTAREA/.test(e.target.tagName) ? 'text field' : '';
    VoiceEngine.speak(`${name}${role ? ', ' + role : ''}`, 'en');
  });
  window.addEventListener('pagehide', () => eyeStop(true));
}
