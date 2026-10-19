// Promptathon client: app shell, reading & accessibility tools, and the student journey.
// The admin dashboard lives in admin.js and is loaded only for admins.

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const fmt = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const main = $('#main');

// Round lengths for wording: the student's own schedule while a test is open, otherwise the event's current setting.
const minutesNow = () => (p.active && p.state?.roundSeconds
  ? Object.fromEntries([1, 2, 3].map((r) => [r, Math.max(1, Math.round(p.state.roundSeconds[r] / 60))])) : cfg.roundMinutes);
const minuteText = (m) => `${m} minute${m === 1 ? '' : 's'}`;
const roundsPhrase = (m) => (m[1] === m[2] && m[2] === m[3] ? `three rounds of ${minuteText(m[1])} each` : `three rounds of ${m[1]}, ${m[2]} and ${m[3]} minutes`);
const minutesPhrase = () => { const m = minutesNow(); return m[1] === m[2] && m[2] === m[3] ? `${minuteText(m[1])}` : `${m[1]}, ${m[2]} and ${m[3]} minutes`; };
const fillRule = (text, m, round) => text.replace('{rounds}', roundsPhrase(m)).replace('{r}', round ? minuteText(m[round]) : '');
let cfg, me;

export async function api(url, body, method, timeoutMs = 0) {
  const res = await fetch(url, { method: method || (body ? 'POST' : 'GET'), signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : {};
  if (!res.ok) { const e = new Error(data.error || 'Something went wrong.'); e.status = res.status; e.code = data.code; throw e; }
  return data;
}

let toastTimer;
export function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}
const announce = (msg) => { $('#sr-live').textContent = msg; };

// Modal dialog. Resolves with the value of the button that closed it ('' / 'cancel' when dismissed).
export function dialog({ title, body, actions = [], wide = false }) {
  const d = $('#dlg');
  d.classList.toggle('wide', wide);
  $('#dlg-title').textContent = title;
  $('#dlg-body').innerHTML = body;
  $('#dlg-foot').innerHTML = actions.map((a) => `<button class="btn ${a.kind || ''}" value="${esc(a.value)}">${esc(a.label)}</button>`).join('');
  d.returnValue = '';
  d.showModal();
  return new Promise((resolve) => d.addEventListener('close', () => { speech.stop(); resolve(d.returnValue); }, { once: true }));
}

// ---------------------------------------------------------------- reading preferences
const PREFS_KEY = 'pt-prefs';
const DEFAULTS = { theme: 'orange', font: 'standard', scale: 100, letter: 0, word: 0, line: 1.6, reading: false, ruler: false, a11y: false, rate: 1, narration: true };
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
let prefs = { ...DEFAULTS, ...(store.get(PREFS_KEY) || {}) };

function applyPrefs() {
  const h = document.documentElement;
  h.dataset.theme = prefs.theme;
  h.dataset.font = prefs.font;
  h.style.setProperty('--scale', prefs.scale / 100);
  h.style.setProperty('--ls', `${prefs.letter}em`);
  h.style.setProperty('--ws', `${prefs.word}em`);
  h.style.setProperty('--lh', prefs.line);
  h.classList.toggle('reading', prefs.reading);
  h.classList.toggle('a11y', prefs.a11y);
  $('#ruler').hidden = !prefs.ruler;
  $('meta[name=theme-color]').content = prefs.theme === 'bw' ? '#000000' : '#e8682a';
}

function settingsDialog() {
  const opt = (k, v, label) => `<option value="${v}" ${String(prefs[k]) === String(v) ? 'selected' : ''}>${label}</option>`;
  const range = (k, label, min, max, step, unit = '') => `<div class="field"><label for="p-${k}">${label} <span class="muted" id="v-${k}">${prefs[k]}${unit}</span></label>
    <input id="p-${k}" type="range" min="${min}" max="${max}" step="${step}" value="${prefs[k]}" data-pref="${k}" data-unit="${unit}"></div>`;
  const toggle = (k, label, hint) => `<label class="check"><input type="checkbox" data-pref="${k}" ${prefs[k] ? 'checked' : ''}><span>${label}<br><span class="muted small" style="font-weight:400">${hint}</span></span></label>`;
  dialog({
    title: 'Reading & display',
    body: `<div class="settings-grid">
      <div class="row">
        <div class="field"><label for="p-theme">Colours</label><select id="p-theme" data-pref="theme">${opt('theme', 'orange', 'Orange & white')}${opt('theme', 'bw', 'Black & white (high contrast)')}</select></div>
        <div class="field"><label for="p-font">Font</label><select id="p-font" data-pref="font">${opt('font', 'standard', 'Standard (Atkinson Hyperlegible)')}${opt('font', 'lexend', 'Easy reading (Lexend)')}${opt('font', 'dyslexic', 'Dyslexia friendly (OpenDyslexic)')}</select></div>
      </div>
      ${range('scale', 'Text size', 80, 180, 10, '%')}
      <div class="row">${range('letter', 'Letter spacing', 0, 0.2, 0.02, 'em')}${range('word', 'Word spacing', 0, 0.5, 0.05, 'em')}</div>
      ${range('line', 'Line spacing', 1.3, 2.4, 0.1)}
      ${toggle('a11y', 'Accessible mode', 'Read-aloud buttons on every question, bigger buttons, stronger focus outline.')}
      ${toggle('reading', 'Reading mode', 'Calm paper background and shorter lines.')}
      ${toggle('ruler', 'Reading ruler', 'A band that follows your pointer and dims the rest of the page.')}
      ${toggle('narration', 'Spoken briefings', 'Each round briefing is read out loud.')}
      ${range('rate', 'Read-aloud speed', 0.6, 1.4, 0.1, '×')}
      <div class="preview measure" id="pref-preview"><b>Preview:</b> AI can sound confident and still be wrong. Check the source before you share it.
        <button type="button" class="speak" style="display:inline-flex" data-act="speak" data-target="#pref-preview" aria-pressed="false">${ICON_SPEAKER} Read aloud</button></div>
    </div>`,
    actions: [{ label: 'Reset to default', value: 'reset', kind: 'ghost' }, { label: 'Done', value: 'done' }],
  }).then((v) => { if (v === 'reset') { prefs = { ...DEFAULTS }; store.set(PREFS_KEY, prefs); applyPrefs(); toast('Reading settings reset.'); } });
}

document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-pref]');
  if (!el) return;
  const k = el.dataset.pref;
  prefs[k] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value;
  const v = $(`#v-${k}`);
  if (v) v.textContent = `${prefs[k]}${el.dataset.unit || ''}`;
  store.set(PREFS_KEY, prefs);
  applyPrefs();
});

// Reading ruler follows the pointer and keyboard focus.
document.addEventListener('pointermove', (e) => { if (prefs.ruler) $('#ruler').style.top = `${e.clientY - $('#ruler').offsetHeight / 2}px`; });
document.addEventListener('focusin', (e) => {
  if (!prefs.ruler || !e.target.getBoundingClientRect) return;
  const r = e.target.getBoundingClientRect();
  $('#ruler').style.top = `${r.top + Math.min(r.height, 40) / 2 - $('#ruler').offsetHeight / 2}px`;
});

// ---------------------------------------------------------------- read aloud (word highlighting)
const ICON_SPEAKER = '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/><path d="M19 6a8.5 8.5 0 0 1 0 12"/></svg>';
export const speakBtn = (target, label = 'Read aloud') => `<button type="button" class="speak" data-act="speak" data-target="${target}" aria-pressed="false">${ICON_SPEAKER} ${label}</button>`;

export const speech = {
  ok: 'speechSynthesis' in window,
  stop() {
    if (!this.ok) return;
    speechSynthesis.cancel();
    if (window.CSS?.highlights) CSS.highlights.delete('speak');
    $$('.speak[aria-pressed="true"]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
  },
  speak(target, btn) {
    if (!this.ok) { toast('Read aloud is not available in this browser.'); return; }
    this.stop();
    let text = target, map = null;
    if (target instanceof Element) ({ text, map } = textMap(target));
    if (!text.trim()) return;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = prefs.rate;
    u.lang = document.documentElement.lang || 'en';
    if (map && window.Highlight && window.CSS?.highlights) {
      u.onboundary = (e) => {
        if (e.name !== 'word') return;
        const len = e.charLength || (text.slice(e.charIndex).match(/^\S+/) || [''])[0].length;
        const r = rangeAt(map, e.charIndex, len);
        if (r) CSS.highlights.set('speak', new Highlight(r));
      };
    }
    u.onend = u.onerror = () => { if (window.CSS?.highlights) CSS.highlights.delete('speak'); btn?.setAttribute('aria-pressed', 'false'); };
    btn?.setAttribute('aria-pressed', 'true');
    speechSynthesis.speak(u);
  },
};

function textMap(el) {
  const skip = '.speak, script, style, [aria-hidden="true"], .sr-only, textarea, select, .lifelines, .qnav';
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => {
    const p = n.parentElement;
    return n.data.trim() && p && !p.closest(skip) && p.getClientRects().length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
  } });
  const map = [];
  let text = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) { map.push({ node: n, start: text.length }); text += `${n.data} `; }
  return { text, map };
}
function rangeAt(map, idx, len) {
  for (let i = map.length - 1; i >= 0; i--) {
    if (map[i].start > idx) continue;
    const { node, start } = map[i], off = idx - start;
    if (off >= node.data.length) return null;
    const r = new Range();
    r.setStart(node, off);
    r.setEnd(node, Math.min(node.data.length, off + len));
    return r;
  }
  return null;
}

// ---------------------------------------------------------------- shell
const narration = (script) => `<div class="bubble" id="narr-text"><b>Briefing</b>${esc(script)}</div>`;

const syncTopH = () => { const r = document.documentElement.style; r.setProperty('--top-h', `${$('#top').offsetHeight}px`); r.setProperty('--foot-h', `${$('.foot').offsetHeight}px`); }; // sticky bars sit just under the header
new ResizeObserver(syncTopH).observe($('#top'));
addEventListener('resize', syncTopH);

function renderShell() {
  syncTopH();
  const nav = $('#nav'), acct = $('#account');
  const here = location.hash.split('?')[0];
  const link = (href, label) => `<a href="${href}" ${here.startsWith(href) ? 'aria-current="page"' : ''}>${label}</a>`;
  if (!me?.signedIn) { nav.innerHTML = ''; acct.innerHTML = ''; return; }
  nav.innerHTML = me.role === 'admin' ? link('#/admin', 'Dashboard')
    : `${me.studentId ? link('#/play', 'My test') : link('#/students', 'Students')}${me.studentId ? link('#/leaderboard', 'Leaderboard') : ''}`;
  const initials = me.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  acct.innerHTML = `<div class="account"><button class="icon-btn avatar" data-act="account" aria-expanded="false" aria-label="Account menu">
      ${me.picture ? `<img src="${esc(me.picture)}" alt="" referrerpolicy="no-referrer">` : esc(initials)}</button>
    <div class="account-menu" id="account-menu" hidden><b>${esc(me.name)}</b><div class="muted small">${esc(me.email)}</div>
      <div class="small" style="margin:6px 0 12px">Signed in as <b>${me.role}</b></div>
      <button class="btn ghost sm" data-act="logout">Sign out</button></div></div>`;
}

function rulesDialog() {
  const list = (items) => `<ol class="rules">${items.map((r) => `<li><span>${esc(r)}</span></li>`).join('')}</ol>`;
  const m = minutesNow();
  const rounds = [1, 2, 3].map((r) => {
    const R = cfg.rounds[r];
    return `<h3 style="margin-top:20px">${R.icon} Round ${r} · ${esc(R.name)} <span class="chip">${m[r]} min · ${R.max} pts</span></h3>
      ${R.intro.map((t) => `<p class="muted" style="margin:0 0 8px">${esc(t)}</p>`).join('')}${list(cfg.rules[r])}
      <p class="small muted" style="margin-top:8px">Lifelines: ${R.lifelines.map((l) => `<b>${esc(l.name)}</b> — ${esc(l.desc)}`).join(' · ')}</p>`;
  }).join('');
  dialog({ title: 'How to play', wide: true,
    body: `<div id="rules-all" class="measure">${speakBtn('#rules-all', 'Read the rules aloud')}<h3 style="margin-top:12px">Before you start</h3>${list(cfg.rules.start)}<h3 style="margin-top:20px">Play fair</h3>${list(cfg.rules.general)}${rounds}</div>`,
    actions: [{ label: 'Got it', value: 'ok' }] });
}

// ---------------------------------------------------------------- router
async function route() {
  speech.stop();
  stopPlay();
  $$('.overlay').forEach((o) => o.remove());
  main.inert = false;
  const [name = '', sub = ''] = location.hash.replace(/^#\/?/, '').split('?')[0].split('/');
  renderShell();
  if (!(me.signedIn && me.role === 'admin')) { try { cfg.roundMinutes = (await api('/api/config')).roundMinutes; } catch { /* keep the last values */ } }
  if (name === 'legal') return (await import('/legal.js')).renderLegal(main, sub || 'privacy', { cfg, api, toast, esc });
  if (!me.signedIn) return landing();
  if (name === 'admin' && me.role === 'admin') {
    const m = await import('/admin.js');
    return m.renderAdmin(main, sub || 'live', { cfg, me });
  }
  if (me.role === 'admin') { location.hash = '#/admin/live'; return; }
  if (name === 'students' || !me.studentId) {
    try { me = await api('/api/me'); } catch { /* keep the last copy */ } // statuses change (lobby, replay), so fetch them fresh
    return studentsPage();
  }
  if (name === 'leaderboard') return leaderboardPage();
  if (name === 'welcome') return welcomePage();
  return playPage();
}

function focusMain() { main.focus({ preventScroll: true }); window.scrollTo(0, 0); }

// ---------------------------------------------------------------- landing
const GOOGLE_G = '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';

// Foldling, our mascot: the celebration clip with its "Congratulations!" bubble cropped off (see .mascot in styles.css).
// On the main pages it loops for as long as the page is open; the pop-up tip plays once. Still for anyone who prefers reduced motion.
const mascot = (cls = '') => `<div class="mascot ${cls}" aria-hidden="true"><video src="/star_congratulations.webm" muted playsinline preload="auto"></video></div>`;
function startMascot(root = document, loopsMax = Infinity) {
  for (const v of root.querySelectorAll('.mascot video')) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { v.currentTime = 0.01; continue; }
    v.loop = loopsMax === Infinity;
    let loops = 0;
    v.addEventListener('ended', () => { if (++loops < loopsMax) v.play().catch(() => {}); });
    v.addEventListener('pause', () => { if (v.loop && !v.ended && !document.hidden && v.isConnected) v.play().catch(() => {}); }); // resumes if the browser pauses it
    v.play().catch(() => {});
  }
}

// A six-panel comic strip. Panels are plain images, so the page stays light and works with a screen reader.
const COMICS = { rain: 'Foldling and the rain', tiger: 'Foldling and the tiger', dog: 'Foldling and the dog' };
const comic = (name) => `<figure class="comic"><figcaption>${esc(COMICS[name])}</figcaption>
  <div class="comic-grid">${[1, 2, 3, 4, 5, 6].map((n) => `<img src="/comics/${name}-${n}.jpg" alt="${esc(COMICS[name])}, panel ${n} of 6" loading="lazy">`).join('')}</div></figure>`;

// Foldling pops up mid-round with a word of encouragement, then slides away.
function mascotTip(text) {
  $('#tip-pop')?.remove();
  const el = document.createElement('div');
  el.id = 'tip-pop';
  el.className = 'tip-pop';
  el.setAttribute('aria-hidden', 'true'); // the same words go to the screen-reader live region below
  el.innerHTML = `${mascot('sm')}<p class="guide-say">${esc(text)}</p>`;
  document.body.append(el);
  announce(text);
  startMascot(el, 1);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 500); }, 6500);
}
const TIPS = { half: 'You’re halfway there. Keep going!', near: 'Almost there! Take a moment to check your answers.' };
const roundPills = () => `<ul class="pills">${[1, 2, 3].map((r) => `<li class="tint-${r}"><span aria-hidden="true">${cfg.rounds[r].icon}</span> ${esc(cfg.rounds[r].name)}</li>`).join('')}</ul>`;

function landing() {
  const err = new URLSearchParams(location.search).get('error');
  main.innerHTML = `<div class="wrap">
    <section class="home">
      ${mascot()}
      <div class="home-text">
        <h1>Prompt&shy;athon</h1>
        <p class="home-lead">Three fun AI challenges. Are you ready?</p>
        ${roundPills()}
        ${err ? `<p class="note bad">Sign-in didn’t work. Please try again.</p>` : ''}
        <div class="row" style="margin-top:28px">
          <a class="btn lg g-btn" href="/auth/google">${GOOGLE_G} Sign in with Google</a>
        </div>
        <div class="row" style="margin-top:12px"><button class="btn quiet" data-act="rules">How to play</button></div>
        <p class="small muted" style="margin-top:8px;max-width:46ch">By signing in you agree to our <a href="#/legal/terms">Terms</a> and <a href="#/legal/privacy">Privacy Policy</a>. Players under 18 need a parent or guardian’s permission.</p>
      </div>
    </section>
    <section class="comic-band" aria-label="A little comic from Foldling"><h2 class="center">A quick story with Foldling</h2>${comic('rain')}</section>
  </div>`;
  focusMain();
  startMascot();
}

// ---------------------------------------------------------------- welcome (after choosing a student, before the lobby)
function welcomePage() {
  const s = me.students.find((x) => x.id === me.studentId);
  if (!s || !['new', 'waiting', 'away'].includes(s.status)) { location.hash = '#/play'; return; }
  main.innerHTML = `<div class="wrap">
    <section class="welcome" id="welcome-text">
      <div class="welcome-guide">
        ${mascot('lg')}
        <p class="guide-say">Hi! I’m <b>Foldling</b>, your guide. Get ready for three fun challenges!</p>
      </div>
      <h1>${esc(s.name.split(' ')[0])}, welcome to Bhanzu Promptothon!</h1>
      <p class="motto"><span class="tint-1">Think fast.</span> <span class="tint-2">Check carefully.</span> <span class="tint-3">Make smart choices with AI.</span></p>
      <ol class="round-cards">${[1, 2, 3].map((r) => `<li class="tint-${r}"><span class="rc-icon" aria-hidden="true">${cfg.rounds[r].icon}</span>
        <span class="rc-num">Round ${r}</span><b>${esc(cfg.rounds[r].name)}</b><span class="rc-blurb">${esc(cfg.rounds[r].blurb)}</span></li>`).join('')}</ol>
      <p class="muted" style="margin:0">${minutesPhrase()} per round · 60 points in total · you play on your own</p>
      <p class="choice">How would you like to get ready?</p>
      <div class="row welcome-go">
        <a class="btn lg" href="#/play">Go straight to the lobby <span aria-hidden="true">→</span></a>
        <a class="btn lg ghost" href="/guide.html">📖 Take Foldling’s guide first</a>
        ${speakBtn('#welcome-text', 'Read aloud')}
      </div>
      <p class="small muted">Not you? <a href="#/students">Choose a different student</a></p>
    </section>
  </div>`;
  focusMain();
  startMascot();
}

// ---------------------------------------------------------------- students
function studentsPage() {
  const live = me.students.find((s) => s.id === me.studentId && ['running', 'paused'].includes(s.status));
  // 'away' = picked before but not in the lobby right now (e.g. a sibling), so no "In lobby" chip for them
  const statusChip = (s) => (s.redoRound && ['waiting', 'away'].includes(s.status) ? `<span class="chip brand">Round ${s.redoRound} replay</span>` : '')
    + ({ new: '', away: '', waiting: '<span class="chip">In lobby</span>', running: '<span class="chip warn">Test in progress</span>',
      paused: '<span class="chip warn">Paused</span>', finished: '<span class="chip ok">Completed</span>', stopped: '<span class="chip ok">Ended</span>' })[s.status] || '';
  main.innerHTML = `<div class="wrap">
    <div class="page-head"><div class="kicker">Step 2 of 3</div>
      <div class="welcome-guide start">${mascot('sm')}<p class="guide-say">Who’s playing today? Pick your name, or add yourself.</p></div>
      <h1>Who is playing today?</h1>
      <p>One Google account can hold several students. Once the test starts, you can’t switch students.</p></div>
    ${live ? `<p class="note">${esc(live.name)}’s test is in progress on this account. <a href="#/play">Go back to the test</a>.</p>` : ''}
    <div class="grid-cards">
      ${me.students.map((s, i) => `<div class="card student-card tint-${(i % 3) + 1}" style="--i:${i}">
        <div class="row between"><h3 style="margin:0">${esc(s.name)}</h3>${statusChip(s)}</div>
        <div class="muted">Grade ${s.grade} · ${esc(cfg.bands.find((b) => b.id === s.band)?.label || '')}<br>${esc(s.school || '')}</div>
        <div>Code <span class="code">${esc(s.code)}</span></div>
        <button class="btn" data-act="pick" data-id="${s.id}" ${live && live.id !== s.id ? 'disabled' : ''}>${s.id === me.studentId ? 'Continue' : 'This is me'}</button>
      </div>`).join('')}
      <form class="card paper student-card" id="add-student">
        <h3 style="margin:0">${me.students.length ? 'Add another student' : 'Add yourself'}</h3>
        ${me.schools.length ? `
        <div class="field"><label for="ns-name">Full name</label><input id="ns-name" name="name" type="text" autocomplete="name" required maxlength="60"></div>
        <div class="row">
          <div class="field grow"><label for="ns-grade">Grade</label><select id="ns-grade" name="grade" required><option value="">Choose</option>${cfg.grades.map((g) => `<option value="${g}">Grade ${g}</option>`).join('')}</select></div>
        </div>
        <div class="field"><label for="ns-school">School</label><select id="ns-school" name="schoolId" required><option value="">Choose your school</option>${me.schools.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
        <fieldset class="field phones"><legend>Phone number <span class="hint">(optional — add as many as you like)</span></legend>
          <div id="ns-phones" class="stack">${phoneInput(1)}</div>
          <button type="button" class="btn quiet sm" data-act="add-phone">+ Add another number</button></fieldset>
        <p class="small muted" style="margin:0">Check the grade carefully — it can’t be changed once you start.</p>
        <label class="check"><input type="checkbox" name="consent" required><span class="small">I am the parent or legal guardian of this child, or I have the parent’s or guardian’s permission. I agree to the
          <a href="#/legal/privacy" target="_blank" rel="noopener">Privacy Policy</a> and <a href="#/legal/terms" target="_blank" rel="noopener">Terms of Service</a>, and I consent to Promptathon using this child’s name, grade, school and answers to run the event.</span></label>
        <button class="btn">Add student</button>` : '<p class="muted">Your host hasn’t added any schools yet. Please check back in a moment.</p>'}
      </form>
    </div></div>`;
  focusMain();
  startMascot();
}
const phoneInput = (n) => `<input type="tel" name="phone" inputmode="tel" autocomplete="${n === 1 ? 'tel' : 'off'}" maxlength="20" placeholder="e.g. +91 98765 43210" aria-label="Phone number ${n}">`;

document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'add-student') return;
  e.preventDefault();
  const fd = new FormData(e.target), f = Object.fromEntries(fd);
  f.phones = fd.getAll('phone').map((x) => x.trim()).filter(Boolean);
  delete f.phone;
  f.consent = fd.get('consent') === 'on';
  try {
    const s = await api('/api/students', f);
    me = await api('/api/me');
    toast(`${s.name} added. Student code ${s.code}.`);
    studentsPage();
  } catch (err) { toast(err.message); }
});

// ---------------------------------------------------------------- leaderboard (shared with admin)
export function leaderboardHTML(lb, { meCode, bands } = {}) {
  const v = (x) => (x == null ? '—' : x);
  return `<div class="row between" style="margin-bottom:12px"><div><b>${esc(lb.event)}</b> · ${esc(bands?.find((b) => b.id === lb.band)?.label || lb.band)}</div>
      ${lb.final ? '<span class="chip ok">Final results</span>' : '<span class="chip warn">Provisional — scores are being checked</span>'}</div>
    <div class="awards" style="margin-bottom:16px">${lb.awards.map((a) => `<div class="award"><b>${esc(a.title)}</b>
      <span class="${a.winners.length ? '' : 'muted'}">${a.winners.length ? esc(a.winners.join(', ')) : 'To be decided'}</span></div>`).join('')}</div>
    <div class="table-wrap"><table class="t"><caption class="sr-only">Leaderboard</caption>
      <thead><tr><th>Rank</th><th>Player</th><th>School</th><th class="num">R1</th><th class="num">R2</th><th class="num">R3</th><th class="num">Total /60</th></tr></thead>
      <tbody>${lb.rows.length ? lb.rows.map((r) => `<tr class="${r.code === meCode ? 'me' : ''}">
        <td class="rank">${r.rank ?? '<span class="chip">Scoring…</span>'}</td>
        <td><b>${esc(r.name)}</b> <span class="muted small">${esc(r.code)}</span></td><td>${esc(r.school)}</td>
        <td class="num">${v(r.r1)}</td><td class="num">${v(r.r2)}</td><td class="num">${v(r.r3)}</td><td class="num"><b>${v(r.total)}</b></td></tr>`).join('')
        : '<tr><td colspan="7" class="muted center">No scores yet.</td></tr>'}</tbody></table></div>
    <p class="small muted" style="margin-top:8px">Ties are split by Round 2, then Round 3 content. Equal scores share a rank.</p>`;
}

async function leaderboardPage() {
  main.innerHTML = '<div class="wrap"><div class="page-head"><h1>Leaderboard</h1><p>Loading…</p></div></div>';
  try {
    const lb = await api('/api/leaderboard');
    const st = await api('/api/play').catch(() => null);
    main.innerHTML = `<div class="wrap"><div class="page-head"><h1>Leaderboard</h1>
        <p>${lb.scope === 'all' ? 'Players from all schools in your grade band' : 'Players from your school in your grade band'} — everyone here answered the same questions.</p></div>
      ${leaderboardHTML(lb, { meCode: st?.student.code, bands: cfg.bands })}</div>`;
  } catch (err) { main.innerHTML = `<div class="wrap"><p class="note bad">${esc(err.message)}</p></div>`; }
  focusMain();
}

// ---------------------------------------------------------------- the test
const p = {};
function stopPlay() { clearInterval(p.syncInt); clearInterval(p.clockInt); p.active = false; document.documentElement.classList.remove('guard'); watermark(''); }

function deviceId() {
  let id = store.get('pt-device');
  if (!id) { id = crypto.randomUUID?.() || String(Math.random()).slice(2); store.set('pt-device', id); }
  return id;
}

async function playPage() {
  Object.assign(p, { active: true, state: null, content: null, draft: {}, ver: 0, ackVer: 0, lastKey: '', conflict: false, busy: false,
    qi: 0, sawBrief: {}, offline: false, savedAt: null, saveError: '', announced: {}, preflight: { sound: false, save: false, tools: false } });
  p.device = deviceId();
  main.innerHTML = '<div class="wrap"><p class="page-head">Loading your test…</p></div>';
  try {
    applyState(await api('/api/play'));
  } catch (err) {
    if (err.code === 'no-student') { me.studentId = null; location.hash = '#/students'; return; }
    main.innerHTML = `<div class="wrap"><p class="note bad">${esc(err.message)}</p></div>`;
    return;
  }
  p.syncInt = setInterval(syncTick, 1000);
  p.clockInt = setInterval(updateClock, 250);
  syncTick();
}

const localKey = (round) => `pt-draft-${p.state?.attemptId}-${round}`;

async function syncTick() {
  if (!p.active || p.busy || p.conflict) return;
  p.busy = true;
  const body = { deviceId: p.device };
  if (p.pendingAck) body.ack = p.pendingAck;
  const ver = p.ver;
  const sendDraft = p.content && !p.content.submitted && ver !== p.ackVer && p.state?.status === 'running';
  if (sendDraft) { body.round = p.content.round; body.draft = p.draft; }
  try {
    const st = await api('/api/play/sync', body, undefined, 8000); // a hung request must not freeze the screen (e.g. stuck on “Paused” after a stop)
    p.offline = false;
    if (!p.preflight.save) { p.preflight.save = true; p.lastKey = ''; }
    if (body.ack === p.pendingAck) p.pendingAck = null;
    if (st.saved) {
      if (st.saved.ok) { p.ackVer = ver; p.savedAt = st.saved.savedAt; p.saveError = ''; }
      else { p.ackVer = ver; p.saveError = st.saved.reason; }
    }
    applyState(st);
  } catch (err) {
    if (err.code === 'device') { p.conflict = true; renderPlay(); }
    else if (err.code === 'no-student') { me.studentId = null; location.hash = '#/students'; }
    else p.offline = true;
  } finally {
    p.busy = false;
    updateStatus();
  }
}

function applyState(st) {
  const prev = p.state;
  if (prev && p.base && prev.phase.remainingMs != null && !prev.paused) {
    const left = p.base.ms - (performance.now() - p.base.at), ph = st.phase, round = prev.phase.type === 'round';
    if (ph.key === prev.phase.key && ph.remainingMs > left + 5000) toast(round ? 'Your host added time to this round.' : 'Your host added time.');
    else if (ph.key !== prev.phase.key && left > 5000 && st.status === 'running') toast(round ? 'Your host ended the round early.' : 'Your host moved things along.');
  }
  p.state = st;
  p.base = { ms: st.phase.remainingMs ?? 0, at: performance.now() };
  const ph = st.phase;
  celebrateCheck(prev, st);
  const key = [st.status, ph.key || ph.type, st.round?.submitted, Object.keys(st.acks).sort().join(','),
    st.results.rounds.map((r) => `${r.state}${r.total}`).join(','), st.final, st.request?.status, st.scorecard].join('|');
  if (key !== p.lastKey) {
    const phaseChanged = !prev || (prev.phase.key || prev.phase.type) !== (ph.key || ph.type) || prev.status !== st.status;
    p.lastKey = key;
    if (phaseChanged) onPhaseChange(st);
    renderPlay();
  }
  pauseOverlay(st.paused, st.lock);
  document.documentElement.classList.toggle('guard', ['running', 'paused'].includes(st.status));
  watermark(st.student?.code);
}

// Congratulations star: pops up bottom-left when a round (or the whole test) is finished, drops away ~2s before the next round.
function celebrate(key, { until } = {}) {
  p.celebrated ??= {};
  if (p.celebrated[key]) return;
  p.celebrated[key] = true;
  hideStar(true);
  const el = document.createElement('div');
  el.id = 'star-pop';
  el.className = 'star-pop';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<video src="/star_congratulations.webm" autoplay muted loop playsinline></video>';
  document.body.append(el);
  el.querySelector('video').play?.().catch(() => {});
  p.star = el;
  p.starUntilPhase = until || null;
  if (!until) p.starTimer = setTimeout(hideStar, 6000);
}

function hideStar(instant) {
  clearTimeout(p.starTimer);
  const el = p.star;
  p.star = null;
  if (!el) return;
  if (instant) return el.remove();
  el.classList.add('out');
  setTimeout(() => el.remove(), 500);
}

function celebrateCheck(prev, st) {
  const ph = st.phase;
  if (st.status === 'stopped') return;
  if (ph.type === 'round' && st.round?.submitted && !prev?.round?.submitted) celebrate(`r${ph.round}`);
  else if (ph.type === 'transition') celebrate(`r${ph.round}`, { until: ph.key });
  else if (ph.type === 'finish' || ph.type === 'done') celebrate('final');
  if (p.star && p.starUntilPhase && ph.key !== p.starUntilPhase) hideStar();
}

function onPhaseChange(st) {
  speech.stop();
  const ph = st.phase;
  if (ph.type === 'round' && p.content?.round !== ph.round) p.content = null;
  if (ph.title) announce(`${ph.title}.`);
  if (['welcome', 'brief', 'transition', 'finish'].includes(ph.type) && ph.script && prefs.narration && p.audioOn) {
    setTimeout(() => speech.speak(ph.script), 400); // spoken inside its slot; subtitles always visible
  }
}

function pauseOverlay(paused, lock) {
  let ov = $('#pause-ov');
  main.inert = Boolean(paused);
  const key = paused ? (lock ? `lock-${lock.requested}` : 'host') : '';
  if (ov && ov.dataset.key !== key) { ov.remove(); ov = null; }
  if (paused && !ov) {
    ov = document.createElement('div');
    ov.id = 'pause-ov';
    ov.dataset.key = key;
    ov.className = 'overlay';
    ov.innerHTML = lock
      ? `<div class="card" role="alertdialog" aria-labelledby="pv-t"><h2 id="pv-t">You left the test window</h2>
          <p>Your clock is paused and your answers are saved. Your host has to let you continue.</p>
          ${lock.requested ? '<p><span class="chip ok">✓ Request sent</span></p><p class="muted small">Please wait here. The test continues on this screen once your host says yes.</p>'
            : `<div class="field" style="text-align:left"><label for="lock-note">Why did you need to leave? <span class="hint">(optional)</span></label><textarea id="lock-note" maxlength="300" style="min-height:70px"></textarea></div>
               <button class="btn" data-act="lock-request">Ask my host to let me continue</button>`}</div>`
      : '<div class="card" role="alertdialog" aria-labelledby="pv-t"><h2 id="pv-t">Paused by your host</h2><p>Your clock is frozen and your answers are saved. Please wait — the test will continue here.</p></div>';
    document.body.append(ov);
    announce(lock ? 'You left the test window. Ask your host to let you continue.' : 'The test is paused by your host.');
  } else if (!paused && ov) { ov.remove(); announce('The test has resumed.'); }
}

function updateClock() {
  if (!p.state?.phase) return;
  const ph = p.state.phase;
  const left = p.state.paused ? p.base.ms : p.base.ms - (performance.now() - p.base.at);
  $$('[data-clock]').forEach((el) => { el.textContent = fmt(left); });
  const t = $('#clock');
  if (t) t.classList.toggle('low', ph.type === 'round' && left < 60000);
  if (ph.type === 'round' && !p.state.paused) {
    for (const mark of [300000, 60000, 30000]) {
      const id = `${ph.key}-${mark}`;
      if (left <= mark && left > mark - 2000 && !p.announced[id]) { p.announced[id] = true; announce(`${fmt(mark)} left in this round.`); }
    }
  }
  if (ph.type === 'round' && !p.state.paused && !p.state.round?.submitted && ph.durationMs) {
    const f = left / ph.durationMs; // shown once each, as the clock passes halfway and the last fifth
    for (const [id, lo, hi] of [['half', 0.44, 0.5], ['near', 0.14, 0.2]]) {
      const k = `${ph.key}-${id}`;
      if (f <= hi && f > lo && !p.announced[k]) { p.announced[k] = true; mascotTip(TIPS[id]); }
    }
  }
  if (p.star && p.starUntilPhase && left <= 2000) hideStar();
  if (ph.remainingMs != null && left < -1200 && !p.busy) syncTick();
}

function updateStatus() {
  const el = $('#saved');
  if (!el) return;
  const pending = p.ver !== p.ackVer;
  let text, warn = false;
  if (p.offline) { text = 'Offline — retrying…'; warn = true; }
  else if (p.saveError) { text = p.saveError; warn = true; }
  else if (pending) text = 'Saving…';
  else if (p.savedAt) text = `Saved ${new Date(p.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  else text = 'Autosave on';
  el.classList.toggle('warn', warn);
  el.innerHTML = `<i class="dot" aria-hidden="true"></i><span>${esc(text)}</span>`;
}

// ---------- views ----------
function renderPlay() {
  if (!p.active) return;
  const st = p.state, ph = st.phase;
  if (p.conflict) return view(takeoverView());
  if (st.status === 'waiting') return view(lobbyView());
  if (ph.type === 'done' || ph.type === 'finish') return view(finishView());
  if (ph.type === 'welcome') return view(rulesView('welcome'));
  if (ph.type === 'brief') { (p.sawBrief ||= {})[ph.round] = true; return view(rulesView(ph.round)); }
  if (ph.type === 'transition') return view(transitionView(ph.round));
  if (ph.type === 'round') {
    if (!st.acks[`r${ph.round}`]) {
      if (!p.sawBrief?.[ph.round]) return view(rulesView(ph.round, true)); // joined late: they never saw the briefing
      p.pendingAck = `r${ph.round}`; st.acks[p.pendingAck] = Date.now(); p.lastKey = ''; syncTick(); // read it already — go straight in
    }
    if (st.round?.submitted || p.content?.submitted) return view(submittedView(ph.round));
    if (!p.content || p.content.round !== ph.round) { loadContent(); return view('<div class="wrap play"><p>Opening the round…</p></div>'); }
    return view(roundView());
  }
  return null;
}

function view(html) {
  const keepScroll = p.content && main.querySelector('.gamebar') && html.includes('gamebar');
  const y = window.scrollY, fileTop = $('#casefile')?.scrollTop;
  main.innerHTML = html;
  if (fileTop && $('#casefile')) $('#casefile').scrollTop = fileTop;
  startMascot(main);
  const gb = $('.gamebar'); document.documentElement.style.setProperty('--game-h', `${gb ? gb.offsetHeight : 0}px`); // round 2 fits the screen under the bars
  updateStatus();
  updateClock();
  if (keepScroll) window.scrollTo(0, y); else focusMain();
}

async function loadContent() {
  if (p.loading) return;
  p.loading = true;
  try {
    const c = await api(`/api/play/round?deviceId=${encodeURIComponent(p.device)}`);
    const local = store.get(localKey(c.round));
    p.content = c;
    p.qi = 0;
    p.draft = c.draft || {};
    if (local && local.at > (c.savedAt || 0) && !c.submitted) { p.draft = local.draft; p.ver++; }
    renderPlay();
  } catch (err) {
    if (err.code === 'device') { p.conflict = true; renderPlay(); } else toast(err.message);
  } finally { p.loading = false; }
}

const mask = (name) => {
  const [first, ...rest] = name.split(/\s+/);
  return `${first.slice(0, 2)}${'•'.repeat(Math.max(1, first.length - 2))}${rest.length ? ` ${rest.at(-1)[0]}.` : ''}`;
};

function lobbyView() {
  const s = p.state.student, pf = p.preflight;
  const item = (on, title, text, btn) => `<li><span class="tick ${on ? 'on' : ''}" aria-hidden="true">${on ? '✓' : ''}</span>
    <div><b>${title}</b><div class="muted small">${text}</div></div>${btn || ''}</li>`;
  return `<div class="wrap">
    <div class="page-head"><div class="kicker">Step 3 of 3 · Lobby</div><h1>Hi ${esc(s.name.split(' ')[0])}!</h1>
      <p>Check your details and get set up. Your host will start the test for everyone at the same time.</p>
      ${p.state.redoRound ? `<p class="note">Your host reopened <b>Round ${p.state.redoRound} · ${esc(cfg.rounds[p.state.redoRound].name)}</b> for you. You’ll play just that round — your other rounds are kept.</p>` : ''}
      ${p.state.request?.status === 'approved' ? `<p class="note">Your host approved your reattempt.${p.state.request.reply ? ` “${esc(p.state.request.reply)}”` : ''}</p>` : ''}</div>
    <div class="two">
      <div class="card stack">
        <h2>Is this you?</h2>
        <div><span class="muted">Name</span><br><b style="font-size:1.2rem">${esc(mask(s.name))}</b></div>
        <div class="row"><div><span class="muted">Grade</span><br><b>${s.grade}</b> <span class="muted">(${esc(cfg.bands.find((b) => b.id === s.band)?.label)})</span></div>
          <div><span class="muted">Student code</span><br><b class="code">${esc(s.code)}</b></div></div>
        <div><span class="muted">School</span><br><b>${esc(s.school)}</b></div>
        <button class="btn ghost sm" data-act="release">Not you? Switch student</button>
      </div>
      <div class="card stack">
        <h2>Get ready</h2>
        <ul class="checklist">
          ${item(pf.sound, 'Sound', 'Each briefing is read aloud. The words are always on screen too.', `<button class="btn ghost sm" data-act="sound">${pf.sound ? 'Test again' : 'Turn on'}</button>`)}
          ${item(pf.save, 'Saving', pf.save ? 'Connected — your answers will save every second.' : 'Checking your connection…')}
          ${item(pf.tools, 'Reading tools', 'Bigger text, dyslexia-friendly font, spacing, read aloud, black & white.', '<button class="btn ghost sm" data-act="settings" data-preflight="1">Adjust</button>')}
        </ul>
        <div class="waiting"><span class="pulse" aria-hidden="true"></span><span>Waiting for your host to start the test…</span></div>
      </div>
    </div>
    <section class="comic-band" aria-label="Comics to read while you wait"><h2 class="center">While you wait — more stories with Foldling</h2>${comic('tiger')}${comic('dog')}</section></div>`;
}

function rulesView(kind, late = false) {
  const st = p.state, ph = st.phase;
  const isWelcome = kind === 'welcome';
  const R = isWelcome ? null : cfg.rounds[kind];
  const ackKey = isWelcome ? 'welcome' : `r${kind}`;
  const acked = Boolean(st.acks[ackKey]);
  const list = (items, i0 = 0) => `<ol class="rules">${items.map((r, i) => `<li style="--i:${i + i0}"><span>${esc(r)}</span></li>`).join('')}</ol>`;
  const minutes = Math.round((st.roundSeconds?.[kind] || 480) / 60);
  const lifelines = R ? `<h3 style="margin-top:20px">Your lifelines</h3>
    <ul>${R.lifelines.map((l) => `<li><b>${esc(l.name)}</b> — ${esc(l.desc)}</li>`).join('')}</ul>
    <p class="muted">${esc(R.lifelineNote)} They cost no points and never add time.</p>
    <p><b>Time:</b> ${minuteText(minutes)} · <b>Points:</b> ${esc(R.points)}</p>
    <div class="guide-says">${mascot('sm')}<p class="guide-say">Foldling says: ${esc(R.says)}</p></div>` : '';
  const sideTitle = late ? `Round ${kind} is running` : isWelcome ? 'Round 1 briefing in' : `Round ${kind} starts in`;
  return `<div class="wrap"><div class="brief">
    <div id="rules-text" class="measure">
      <div class="kicker">${isWelcome ? 'Before we begin' : `Round ${kind} of 3 · ${minuteText(minutes)} · ${R.max} points`}</div>
      <div class="round-title"><h1>${isWelcome ? 'Before you start' : `<span class="round-ico tint-${kind}" aria-hidden="true">${R.icon}</span> Round ${kind} — ${esc(R.name)}`}</h1></div>
      ${R ? `<p style="font-size:1.2rem;font-family:var(--font-head);font-weight:800;margin-bottom:6px">${esc(R.tagline)}</p>${R.intro.map((t) => `<p class="muted" style="font-size:1.05rem">${esc(t)}</p>`).join('')}` : ''}
      <p class="note warn" role="note"><b>⚠ Stay in this window.</b> If you leave it or switch tabs once the round starts, your test is paused and your host has to say yes before you can continue.</p>
      ${speakBtn('#rules-text', 'Read the rules aloud')}
      ${isWelcome ? `${list(cfg.rules.start)}<h3 style="margin-top:20px">Play fair</h3>${list(cfg.rules.general, cfg.rules.start.length)}`
        : `<h3 style="margin-top:16px">How to play</h3>${list(cfg.rules[kind])}`}
      ${lifelines}
    </div>
    <aside class="stack">
      ${ph.script && !late ? `<div class="guide-brief">${mascot('sm')}${narration(ph.script)}</div>` : ''}
      <div class="card ${late ? '' : 'paper'}">
        <div class="muted">${sideTitle}</div>
        <div class="countdown" data-clock aria-hidden="true">0:00</div>
        ${late ? '<p class="small" style="margin-top:8px">The clock is already running — start when you’re ready.</p>' : ''}
        <div style="margin-top:14px">${acked
          ? `<span class="chip ok">${isWelcome ? '✓ Rules read — you’re ready' : '✓ Ready — the round begins when the clock reaches zero'}</span>`
          : `<label class="check warn-box"><input type="checkbox" id="warn-ok"><span class="small">I understand. If I leave this window or switch tabs, my test is paused until my host lets me back in.</span></label>
            <button class="btn ${late ? 'lg' : ''}" id="ack-btn" data-act="ack" data-key="${ackKey}" disabled style="margin-top:12px">${late ? `Start Round ${kind}` : isWelcome ? 'I’ve read the rules' : `Start Round ${kind}`}</button>`}</div>
      </div>
    </aside></div></div>`;
}

function scoreCards(rounds, { total = null, final = false } = {}) {
  const cell = (r) => `<div class="score-card tint-${r.round}"><div class="muted small">Round ${r.round} · ${esc(r.name)}</div>
    <div class="big">${r.state === 'scored' ? `${r.total}<span class="muted small">/${r.max}</span>` : r.state === 'pending' ? '<span class="small">Scoring…</span>' : '—'}</div>
    <div class="small muted">${r.state === 'scored' ? (final ? 'Final' : 'Provisional') : r.state === 'pending' ? 'Checking written answers' : 'Not played'}</div></div>`;
  return `<div class="score-cards">${rounds.map(cell).join('')}${total != null ? `<div class="score-card total"><div class="muted small">Total</div>
    <div class="big">${total}<span class="muted small">/60</span></div><div class="small muted">${final ? 'Final' : 'Provisional'}</div></div>` : ''}</div>`;
}

function submittedView(r) {
  const res = p.state.results.rounds[r - 1];
  return `<div class="wrap"><div class="page-head center" style="max-width:640px;margin:0 auto">
    <div class="kicker">Round ${r} · ${esc(cfg.rounds[r].name)}</div><h1>Submitted ✓</h1>
    <p style="margin:0 auto 20px">Your answers are locked. ${r < 3 ? 'The next round starts on schedule for everyone — no need to rush.' : 'Results appear when the arena closes.'}</p>
    ${scoreCards([res])}
    <p class="muted" style="margin-top:20px">Time left in this round: <b data-clock>0:00</b></p></div></div>`;
}

function transitionView(r) {
  const ph = p.state.phase, next = cfg.rounds[r + 1];
  return `<div class="wrap"><div class="brief">
    <div><div class="kicker">Round ${r} complete</div><h1>Round ${r} is saved</h1>
      <p class="muted">Here is your provisional score. Written answers are checked by the host before results are final.</p>
      ${scoreCards([p.state.results.rounds[r - 1]])}</div>
    <aside class="stack">${ph.script ? `<div class="guide-brief">${mascot('sm')}${narration(ph.script)}</div>` : ''}
      ${next ? `<div class="card paper"><div class="muted">Next up · ${next.icon} ${esc(next.name)}</div><div class="countdown" data-clock aria-hidden="true">0:00</div></div>` : ''}</aside>
  </div></div>`;
}

function finishView() {
  const st = p.state, s = st.student;
  const stopped = st.status === 'stopped';
  return `<div class="wrap"><div class="page-head"><div class="kicker">${stopped ? 'Test ended by host' : 'All three rounds done'}</div>
      <h1>${stopped ? 'Your test has ended' : 'You’ve completed the arena!'}</h1>
      <p>Your work is saved. ${st.final ? 'These are the final results.' : 'Scores are provisional — final rankings appear after the answers are reviewed.'}</p></div>
    ${st.phase.script && !stopped && st.phase.type === 'finish' ? `<div style="max-width:640px;margin-bottom:20px">${narration(st.phase.script)}</div>` : ''}
    ${scoreCards(st.results.rounds, { total: st.results.total, final: st.final })}
    <div class="card paper" style="margin-top:20px"><h3>Receipt</h3>
      <p class="small" style="margin:0">${esc(s.name)} · Grade ${s.grade} · ${esc(s.school)} · Code <b class="code">${esc(s.code)}</b></p></div>
    ${scorecardBlock(st)}
    ${reattemptCard(st)}
    <div class="row" style="margin-top:20px"><a class="btn" href="#/leaderboard">See the leaderboard</a>
      ${me.students.length > 1 ? '<button class="btn ghost" data-act="release">Play as another student</button>' : ''}</div></div>`;
}

function scorecardBlock(st) {
  if (!['finished', 'stopped'].includes(st.status)) return '';
  if (!st.scorecard) return '<p class="note" style="margin-top:20px">Your score card will appear here once your host has checked and approved it.</p>';
  return `<div class="card paper" style="margin-top:20px"><h3>Your score card is ready</h3>
    <p class="muted" style="margin-top:0">A snapshot of your thinking skills in this challenge.</p>
    <div class="row"><a class="btn" href="/api/play/scorecard" target="_blank" rel="noopener">View score card</a><a class="btn ghost" href="/api/play/scorecard.pdf" download>Download PDF</a></div></div>`;
}

function reattemptCard(st) {
  if (!['finished', 'stopped'].includes(st.status)) return '';
  const r = st.request;
  const when = (t) => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  if (r?.status === 'pending') return `<div class="card" style="margin-top:20px"><h3>Reattempt requested</h3>
    <p style="margin:0">Your request was sent on ${esc(when(r.createdAt))}. Your host will answer here.${r.note ? ` <br><span class="muted">Your note: “${esc(r.note)}”</span>` : ''}</p></div>`;
  return `<div class="card" style="margin-top:20px">
    ${r?.status === 'rejected' ? `<p class="note bad"><b>Your reattempt request was declined.</b>${r.reply ? ` Message from your host: “${esc(r.reply)}”` : ''}</p>` : ''}
    <h3>Need another try?</h3>
    <p class="muted" style="margin-top:0">If something went wrong — like a lost connection — you can ask your host for a reattempt. They decide, and you’ll see the answer here.</p>
    <button class="btn ghost" data-act="request-reattempt">${r?.status === 'rejected' ? 'Ask again' : 'Request a reattempt'}</button></div>`;
}

function takeoverView() {
  return `<div class="wrap"><div class="card" style="max-width:560px;margin:48px auto;text-align:center">
    <h1>This test is open on another device</h1>
    <p>To keep things fair, a test runs on one device at a time. Your saved answers are safe and the clock keeps running.</p>
    <button class="btn lg" data-act="takeover">Continue on this device</button></div></div>`;
}

// ---------- round screens ----------
function gamebar(r, progressText, progressPct) {
  const R = cfg.rounds[r], used = p.content.lifelines.used;
  const full = used.length >= cfg.lifelinesPerRound;
  const lifelines = R.lifelines.map((l) => {
    const isUsed = used.includes(l.id);
    return `<button class="lifeline ${isUsed ? 'used' : ''}" data-act="lifeline" data-id="${l.id}" ${isUsed || full ? 'disabled' : ''}
      title="${esc(l.desc)}" aria-label="Lifeline: ${esc(l.name)}${isUsed ? ' (used)' : full ? ' (not available)' : ''}">${isUsed ? '✓ ' : ''}${esc(l.name)}</button>`;
  }).join('');
  return `<div class="gamebar"><div class="wrap">
      <div class="gb-round"><b>${R.icon} Round ${r}<span class="gb-name"> · ${esc(R.name)}</span></b><span id="gb-progress">${esc(progressText)} · ${R.max} pts max</span></div>
      <div id="clock" class="timer" data-clock role="timer" aria-label="Time left in this round">0:00</div>
      <div id="saved" class="saved" aria-live="off"></div>
      <div class="lifelines" role="group" aria-label="Lifelines">${lifelines}</div>
      <button class="btn sm" data-act="submit">Submit round</button>
    </div><div class="progress" aria-hidden="true"><i id="gb-bar" style="width:${progressPct}%"></i></div></div>`;
}

function progress() {
  const c = p.content, d = p.draft;
  if (c.round === 1) {
    const all = [...c.view.items, c.view.boss];
    const n = all.filter((q) => d.answers?.[q.id]).length;
    return [`${n} of ${all.length} answered`, (n / all.length) * 100];
  }
  if (c.round === 2) {
    const done = [Object.values(d.rebuild || {}).filter(Boolean).length === 4, d.spot?.paragraph && d.spot?.why, d.match?.evidence && d.match?.why, d.repair?.text && d.repair?.why].filter(Boolean).length;
    return [`${done} of 4 puzzles done`, done * 25];
  }
  return d.prompt?.trim() ? ['Prompt written', 100] : ['Prompt not written yet', 0];
}

function roundView() {
  const [text, pct] = progress();
  const body = p.content.round === 1 ? r1View() : p.content.round === 2 ? r2View() : r3View();
  return `${gamebar(p.content.round, text, pct)}<div class="wrap play">${body}</div>`;
}

const lifelineNote = (data, label) => (data ? `<p class="note clue" role="note"><b>${esc(label)}:</b> ${esc(data.text)}</p>` : '');

function r1View() {
  const c = p.content, d = p.draft, items = [...c.view.items, c.view.boss];
  const q = items[p.qi], boss = p.qi === items.length - 1;
  const ll = c.lifelines.data;
  const hidden = ll.fifty?.target === q.id ? ll.fifty.hide : [];
  const nav = items.map((x, i) => `<button data-act="goto" data-i="${i}" class="${d.answers?.[x.id] ? 'done' : ''}" ${i === p.qi ? 'aria-current="step"' : ''}
    aria-label="${i === items.length - 1 ? 'Final boss' : `Question ${i + 1}`}${d.answers?.[x.id] ? ', answered' : ''}">${i === items.length - 1 ? 'B' : i + 1}</button>`).join('');
  return `<nav class="qnav" aria-label="Questions">${nav}</nav>
    <section class="card qcard" id="q-card" aria-labelledby="q-text">
      <div class="qtype"><span class="chip ${boss ? 'brand' : ''}">${boss ? 'Final boss · 4 points' : `Question ${p.qi + 1} of ${items.length - 1} · ${esc(q.type)}`}</span>${speakBtn('#q-card')}</div>
      <h2 class="qtext" id="q-text">${esc(q.question)}</h2>
      <div class="opts" role="radiogroup" aria-labelledby="q-text">
        ${q.options.map((o) => {
          const removed = hidden.includes(o.id);
          return `<label class="opt ${removed ? 'removed' : ''}"><input type="radio" name="q-${esc(q.id)}" value="${o.id}" data-field="answers.${esc(q.id)}"
            ${d.answers?.[q.id] === o.id ? 'checked' : ''} ${removed ? 'disabled' : ''}><span class="key" aria-hidden="true">${o.id}</span>
            <span class="txt">${esc(o.text)}${removed ? ' <span class="sr-only">(removed by 50–50)</span>' : ''}</span></label>`;
        }).join('')}
      </div>
      ${ll.clue?.target === q.id ? lifelineNote(ll.clue, 'Clue Flash') : ''}
      ${boss ? `<div class="field" style="margin-top:18px"><label for="boss-why">In one sentence, explain why this is the best choice <span class="hint">(2 points)</span></label>
        <textarea id="boss-why" data-field="bossWhy" maxlength="1500">${esc(d.bossWhy || '')}</textarea></div>` : ''}
    </section>
    <div class="actionbar qcard">
      <button class="btn ghost" data-act="goto" data-i="${p.qi - 1}" ${p.qi === 0 ? 'disabled' : ''}>← Previous</button>
      ${boss ? '<button class="btn" data-act="submit">Review & submit</button>'
        : `<button class="btn" data-act="goto" data-i="${p.qi + 1}">${p.qi === items.length - 2 ? 'Final boss →' : 'Next →'}</button>`}
    </div>`;
}

const R2_PUZZLES = [['rebuild', 'Rebuild the prompt'], ['spot', 'Spot the trap'], ['match', 'Match the evidence'], ['repair', 'Repair the claim']];

function r2View() {
  const v = p.content.view, d = p.draft, ll = p.content.lifelines.data;
  const blockOpts = (slot) => `<option value="">Choose a block</option>${v.blocks.map((b) => `<option value="${b.id}" ${d.rebuild?.[slot] === b.id ? 'selected' : ''}>${b.id}</option>`).join('')}`;
  const chosen = Object.values(d.rebuild || {}).filter(Boolean);
  const dupes = chosen.length !== new Set(chosen).size;
  const radios = (name, field, list, label) => `<div class="pick-list" role="radiogroup" aria-label="${label}">${list.map((x) => `<label class="opt">
    <input type="radio" name="${name}" value="${x.id}" data-field="${field}" ${field.split('.').reduce((o, k) => o?.[k], d) === x.id ? 'checked' : ''}>
    <span class="tag">${esc(x.label || x.id)}</span><span class="txt">${esc(x.text)}</span></label>`).join('')}</div>`;
  const inner = {
    rebuild: () => `<div class="blocks">${v.blocks.map((b) => `<div class="block"><span class="tag">${esc(b.id)}</span><span>${esc(b.text)}</span></div>`).join('')}</div>
      <div class="slots">${[['goal', 'Goal'], ['audience', 'Audience'], ['include', 'Must include'], ['format', 'Format']].map(([k, l], i) => `<div class="field">
        <label for="rb-${k}">${i + 1}. ${l}</label><select id="rb-${k}" data-field="rebuild.${k}">${blockOpts(k)}</select></div>`).join('')}</div>
      ${dupes ? '<p class="note bad small">You used the same block twice — each block goes in one slot.</p>' : ''}`,
    spot: () => `${radios('spot', 'spot.paragraph', v.output, 'Which paragraph has the trap?')}
      <div class="field"><label for="spot-why">Explain the problem in one sentence</label><textarea id="spot-why" data-field="spot.why" maxlength="1500">${esc(d.spot?.why || '')}</textarea></div>`,
    match: () => `${radios('match', 'match.evidence', v.evidence, 'Which evidence card?')}
      <div class="field"><label for="match-why">How does this card help?</label><textarea id="match-why" data-field="match.why" maxlength="1500">${esc(d.match?.why || '')}</textarea></div>`,
    repair: () => `<div class="field"><label for="rep-text">Your corrected claim</label><textarea id="rep-text" data-field="repair.text" maxlength="1500">${esc(d.repair?.text || '')}</textarea></div>
      <div class="field"><label for="rep-why">Why does your fix work?</label><textarea id="rep-why" data-field="repair.why" maxlength="1500">${esc(d.repair?.why || '')}</textarea></div>`,
  };
  const started = { rebuild: chosen.length, spot: d.spot?.paragraph || d.spot?.why, match: d.match?.evidence || d.match?.why, repair: d.repair?.text || d.repair?.why };
  const i = Math.min(Math.max(p.qi, 0), R2_PUZZLES.length - 1), [key, title] = R2_PUZZLES[i], last = i === R2_PUZZLES.length - 1;
  // One screen, no scrolling: the case sits on the left (answer + evidence), one puzzle at a time on the right.
  return `<div class="case2">
    <div class="c2-head"><b id="case-title">${esc(v.title)}</b> <span class="muted">${esc(v.context)}</span>${speakBtn('#case-all')}</div>
    ${lifelineNote(ll.compass, 'Case Compass')}
    <div class="c2-cols" id="case-all">
      <section class="card paper c2-col" aria-label="The AI’s answer"><h3>The AI’s answer</h3>
        ${v.output.map((o) => `<div class="para"><span class="tag">${esc(o.label)}</span><span>${esc(o.text)}</span></div>`).join('')}</section>
      <section class="card paper c2-col" aria-label="Evidence cards"><h3>Evidence cards</h3>
        <div class="stack">${v.evidence.map((e) => `<div class="evi"><span class="tag">${esc(e.id)}</span><span>${esc(e.text)}</span></div>`).join('')}</div></section>
      <section class="c2-work">
        <nav class="qnav" aria-label="Puzzles">${R2_PUZZLES.map(([k, t], n) => `<button data-act="goto" data-i="${n}" class="${started[k] ? 'done' : ''}" ${n === i ? 'aria-current="step"' : ''}
          aria-label="Puzzle ${n + 1}: ${t}${started[k] ? ', started' : ''}">${n + 1}</button>`).join('')}</nav>
        <div class="card puzzle stack" id="pz-${key}" aria-labelledby="pz-h">
          <div class="row between"><h3 id="pz-h"><span class="n">${i + 1}</span>${title}</h3><span class="chip">Puzzle ${i + 1} of 4 · 5 pts</span></div>
          <p>${esc(v.tasks[key])}</p>${ll.unlock?.target === key ? lifelineNote(ll.unlock, 'Unlocked clue') : ''}${inner[key]()}
        </div>
        <div class="actionbar">
          <button class="btn ghost" data-act="goto" data-i="${i - 1}" ${i === 0 ? 'disabled' : ''}>← Back</button>
          ${last ? '<button class="btn" data-act="submit">Review & submit</button>' : `<button class="btn" data-act="goto" data-i="${i + 1}">Next →</button>`}
        </div>
      </section>
    </div></div>`;
}

// Renders a target output: "a | b | c" lines become a table, the first line is the title.
function targetHTML(lines) {
  let out = '', table = [];
  const flush = () => {
    if (!table.length) return;
    const [head, ...rows] = table.map((l) => l.split('|').map((c) => c.trim()));
    out += `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    table = [];
  };
  lines.forEach((l, i) => {
    if (l.includes('|')) { table.push(l); return; }
    flush();
    out += i === 0 ? `<h4>${esc(l)}</h4>` : `<div>${esc(l)}</div>`;
  });
  flush();
  return out;
}

function r3View() {
  const c = p.content, v = c.view, d = p.draft, ll = c.lifelines.data;
  const gens = c.generations || [], image = v.image;
  return `<div class="case">
    <section class="card paper casefile" id="target-card" aria-labelledby="t-h">
      <div class="row between"><h2 id="t-h" style="margin:0">${image ? 'Target picture' : 'Target output'}</h2>${speakBtn('#target-card')}</div>
      <p class="muted" style="margin:6px 0 14px">${esc(v.title)} · <span class="chip">${esc(v.audience)}</span></p>
      ${image ? `<figure class="target-img"><img src="/api/play/image/${encodeURIComponent(image.id)}" alt="${esc(image.alt)}">
        <figcaption class="small muted">${esc(image.alt)} <a href="/api/play/image/${encodeURIComponent(image.id)}" target="_blank" rel="noopener">Open full size</a></figcaption></figure>`
        : `<div class="target card">${targetHTML(v.output)}</div>`}
      ${lifelineNote(ll.goal, 'Goal Lens')}${lifelineNote(ll.structure, 'Structure Scan')}
    </section>
    <div class="stack">
      <section class="card stack">
        <div class="field"><label for="r3-prompt">Your prompt</label><span class="hint">Say what to make, who it is for, what it must include and how it should be laid out.</span>
          <textarea id="r3-prompt" data-field="prompt" data-nopaste rows="8" maxlength="3000" placeholder="For example: Write a short, friendly notice for Grade 6 students about…">${esc(d.prompt || '')}</textarea>
          <span class="hint">Typing only — copy and paste are switched off in this round.</span></div>
        ${image ? '<p class="note small">This target is a picture, so there is no AI tool here. Describe what you see in your prompt.</p>' : cfg.aiTool ? `<div class="row between"><span class="muted small">${c.generationsLeft} of ${cfg.generations} AI tries left</span>
          <button class="btn ghost" data-act="generate" ${c.generationsLeft <= 0 ? 'disabled' : ''}>Try my prompt with AI</button></div>`
          : '<p class="note small">The AI tool isn’t switched on for this event — write your best prompt.</p>'}
        ${gens.map((g, i) => { const on = String(d.finalPick) === String(i); return `<div class="gen ${on ? 'chosen' : ''}"><div class="gen-head"><span>AI try ${i + 1}</span>
          <button class="btn ${on ? '' : 'ghost'} sm" data-act="pick-gen" data-i="${i}" aria-pressed="${on}">${on ? '✓ Chosen as my final creation' : 'Choose as my final creation'}</button></div>${esc(g.output)}</div>`; }).join('')}
        ${gens.length ? '<p class="small muted" style="margin:0">Your final creation is one of the AI results above. It can’t be typed, pasted or edited.</p>' : ''}
      </section>
      <div class="actionbar"><span class="muted small">Your answers save every second.</span><button class="btn" data-act="submit">Review & submit</button></div>
    </div></div>`;
}

// Round 3 answers must be typed by hand: no pasting, dropping, cutting or copying in those boxes.
for (const t of ['paste', 'drop', 'copy', 'cut']) document.addEventListener(t, (e) => {
  if (!e.target.closest?.('[data-nopaste]')) return;
  e.preventDefault();
  if (t === 'paste' || t === 'drop') toast('Pasting is switched off in Round 3 — please type your answer.');
});
document.addEventListener('keydown', (e) => { // Shift+Insert also pastes on some systems
  if (e.shiftKey && e.key === 'Insert' && e.target.closest?.('[data-nopaste]')) e.preventDefault();
});

// draft editing
document.addEventListener('input', (e) => onField(e.target));
document.addEventListener('change', (e) => onField(e.target));
function onField(el) {
  const field = el.dataset?.field;
  if (!field || !p.active || !p.content) return;
  const [a, b] = field.split('.');
  if (b) { p.draft[a] = { ...(p.draft[a] || {}) }; p.draft[a][b] = el.value; } else p.draft[a] = el.value;
  p.ver++;
  store.set(localKey(p.content.round), { at: Date.now(), draft: p.draft });
  const [text, pct] = progress();
  const gp = $('#gb-progress');
  if (gp) gp.textContent = `${text} · ${cfg.rounds[p.content.round].max} pts max`;
  const bar = $('#gb-bar');
  if (bar) bar.style.width = `${pct}%`;
  if (p.content.round === 1 && el.type === 'radio') $$('.qnav button')[p.qi]?.classList.add('done');
  if (p.content.round === 2 && field.startsWith('rebuild.')) {
    const y = window.scrollY; view(roundView()); window.scrollTo(0, y); $(`#${el.id}`)?.focus();
  }
  updateStatus();
}

// ---------------------------------------------------------------- actions
const actions = {
  rules: rulesDialog,
  settings: (el) => { if (el.dataset.preflight) { p.preflight.tools = true; renderPlay(); } settingsDialog(); },
  speak: (el) => {
    if (el.getAttribute('aria-pressed') === 'true') { speech.stop(); return; }
    const t = $(el.dataset.target);
    if (t) speech.speak(t, el);
  },
  account: (el) => {
    const m = $('#account-menu');
    m.hidden = !m.hidden;
    el.setAttribute('aria-expanded', String(!m.hidden));
  },
  logout: async () => {
    if (p.active && ['running', 'paused'].includes(p.state?.status)
      && await dialog({ title: 'Sign out?', body: '<p>Your test keeps running while you are signed out, and the clock does not stop.</p>', actions: [{ label: 'Stay', value: 'no', kind: 'ghost' }, { label: 'Sign out', value: 'yes' }] }) !== 'yes') return;
    await api('/auth/logout', {});
    me = { signedIn: false };
    location.hash = '#/';
    route();
  },
  'cookie-ok': () => { store.set('pt-cookie-notice', '1'); $('#cookie-bar')?.remove(); },
  'lock-request': async () => {
    try { applyState(await api('/api/play/lock-request', { note: $('#lock-note')?.value || '' })); } catch (err) { toast(err.message); }
  },
  'add-phone': (el) => {
    const box = $('#ns-phones'), n = box.querySelectorAll('input').length;
    if (n >= 5) { toast('You can add up to 5 phone numbers.'); return; }
    box.insertAdjacentHTML('beforeend', phoneInput(n + 1));
    box.lastElementChild.focus();
    if (n + 1 >= 5) el.hidden = true;
  },
  pick: async (el) => {
    try {
      await api('/api/students/select', { studentId: el.dataset.id });
      me = await api('/api/me');
      const chosen = me.students.find((x) => x.id === me.studentId);
      location.hash = ['new', 'waiting', 'away'].includes(chosen?.status) ? '#/welcome' : '#/play'; // a test already under way skips the welcome
    } catch (err) { toast(err.message); }
  },
  release: async () => {
    try {
      await api('/api/students/release', {});
      me = await api('/api/me');
      location.hash = '#/students';
    } catch (err) { toast(err.message); }
  },
  sound: () => {
    p.audioOn = true;
    p.preflight.sound = true;
    prefs.narration = true;
    store.set(PREFS_KEY, prefs);
    speech.speak('Sound is on. Each briefing will be read aloud. Good luck!');
    renderPlay();
  },
  ack: (el) => { p.pendingAck = el.dataset.key; p.state.acks[el.dataset.key] = Date.now(); p.lastKey = ''; applyState(p.state); syncTick(); },
  takeover: async () => {
    try {
      const st = await api('/api/play/takeover', { deviceId: p.device });
      p.conflict = false; p.content = null; p.lastKey = '';
      applyState(st);
    } catch (err) { toast(err.message); }
  },
  goto: (el) => {
    const i = Number(el.dataset.i), n = p.content.round === 2 ? R2_PUZZLES.length : p.content.view.items.length + 1;
    if (i < 0 || i >= n) return;
    p.qi = i;
    speech.stop();
    view(roundView());
    $('#q-text')?.focus?.();
  },
  lifeline: async (el) => {
    const c = p.content, R = cfg.rounds[c.round], l = R.lifelines.find((x) => x.id === el.dataset.id);
    let target = null, body = `<p>${esc(l.desc)}</p>`;
    if (c.round === 1) {
      const items = [...c.view.items, c.view.boss];
      target = items[p.qi].id;
      body += `<p>It will be used on <b>${p.qi === items.length - 1 ? 'the final boss' : `question ${p.qi + 1}`}</b>.</p>`;
    }
    if (c.round === 2 && l.id === 'unlock') {
      body += `<div class="field"><label for="ll-target">Which puzzle?</label><select id="ll-target">
        ${R2_PUZZLES.map(([k, t], i) => `<option value="${k}" ${i === p.qi ? 'selected' : ''}>${i + 1}. ${t}</option>`).join('')}</select></div>`;
    }
    body += `<p class="muted small">${cfg.lifelinesPerRound === 1 ? 'You can use only one lifeline in this round.' : 'Each lifeline can be used once in this round.'}</p>`;
    if (await dialog({ title: `Use ${l.name}?`, body, actions: [{ label: 'Not now', value: 'no', kind: 'ghost' }, { label: `Use ${l.name}`, value: 'yes' }] }) !== 'yes') return;
    if (c.round === 2 && l.id === 'unlock') target = $('#ll-target').value;
    try {
      c.lifelines = await api('/api/play/lifeline', { deviceId: p.device, id: l.id, target });
      view(roundView());
      announce(`${l.name} used.`);
    } catch (err) { toast(err.message); }
  },
  submit: async () => {
    const c = p.content, d = p.draft;
    let missing = '';
    if (c.round === 1) {
      const n = [...c.view.items, c.view.boss].filter((q) => !d.answers?.[q.id]).length;
      if (n) missing = `${n} question${n > 1 ? 's are' : ' is'} not answered yet.`;
      else if (!d.bossWhy?.trim()) missing = 'You haven’t explained your final boss answer.';
    } else if (progress()[1] < 100) missing = 'Some parts are still empty.';
    if (!missing && c.round === 3 && c.generations.length && !d.finalPick) missing = 'You haven’t chosen which AI result is your final creation.';
    const ok = await dialog({ title: `Submit Round ${c.round}?`,
      body: `${missing ? `<p class="note bad">${esc(missing)}</p>` : ''}<p>After submitting you can’t change your answers. ${c.round < 3 ? 'The next round still starts at its scheduled time.' : 'Your results appear when the arena closes.'}</p>`,
      actions: [{ label: 'Keep working', value: 'no', kind: 'ghost' }, { label: 'Submit round', value: 'yes' }] });
    if (ok !== 'yes') return;
    try {
      const st = await api('/api/play/submit', { deviceId: p.device, round: c.round, draft: d });
      store.del(localKey(c.round));
      c.submitted = true;
      p.ackVer = p.ver;
      p.lastKey = '';
      applyState(st);
      toast('Round submitted.');
    } catch (err) { toast(err.message); }
  },
  generate: async (el) => {
    const prompt = p.draft.prompt?.trim();
    if (!prompt) { toast('Write your prompt first.'); $('#r3-prompt')?.focus(); return; }
    el.disabled = true;
    el.textContent = 'Generating…';
    try {
      const res = await api('/api/play/generate', { deviceId: p.device, prompt });
      Object.assign(p.content, { generations: res.generations, generationsLeft: res.generationsLeft });
      const y = window.scrollY;
      view(roundView());
      window.scrollTo(0, y);
      announce('The AI has replied.');
    } catch (err) { toast(err.message); el.disabled = false; el.textContent = 'Try my prompt with AI'; }
  },
  'request-reattempt': async () => {
    const ok = await dialog({ title: 'Request a reattempt', body: `<p>Your host will review your request. You will see their answer on this page.</p>
      <div class="field"><label for="rq-note">Why do you need another try? <span class="hint">(optional)</span></label>
      <textarea id="rq-note" maxlength="500" placeholder="For example: my internet dropped during Round 2."></textarea></div>`,
      actions: [{ label: 'Cancel', value: 'no', kind: 'ghost' }, { label: 'Send request', value: 'yes' }] });
    if (ok !== 'yes') return;
    try {
      const st = await api('/api/students/reattempt-request', { note: $('#rq-note').value });
      p.lastKey = '';
      applyState(st);
      toast('Request sent to your host.');
    } catch (err) { toast(err.message); }
  },
  'pick-gen': (el) => {
    p.draft.finalPick = el.dataset.i;
    p.ver++;
    store.set(localKey(p.content.round), { at: Date.now(), draft: p.draft });
    const y = window.scrollY;
    view(roundView());
    window.scrollTo(0, y);
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!e.target.closest('.account')) { const m = $('#account-menu'); if (m) m.hidden = true; }
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el); }
});

document.addEventListener('change', (e) => { if (e.target.id === 'warn-ok') $('#ack-btn').disabled = !e.target.checked; });

window.addEventListener('hashchange', route);

// ---------------------------------------------------------------- test guard
// While a test is live: no copying, cutting, pasting, dragging, printing or right-click menus, the page hides itself when the window
// loses focus or a screenshot key is pressed, and leaving the window during a round pauses the clock until the host lets the student back in.
// A browser cannot stop a screenshot taken by the operating system or another device; these are deterrents, and every page carries the student's code.
const guarding = () => document.documentElement.classList.contains('guard');
for (const t of ['copy', 'cut', 'paste', 'drop', 'dragstart', 'contextmenu']) document.addEventListener(t, (e) => {
  if (!guarding()) return;
  e.preventDefault();
  if (t === 'paste' || t === 'drop') toast('Pasting is switched off during the test — please type your answer.');
}, true);
let shieldTimer;
const shield = () => { document.documentElement.classList.add('shield'); clearTimeout(shieldTimer); shieldTimer = setTimeout(() => document.documentElement.classList.remove('shield'), 2500); };
const guardKey = (e) => {
  if (!guarding()) return;
  const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
  if (e.key === 'PrintScreen' || (e.metaKey && e.shiftKey && ['3', '4', '5'].includes(e.key)) || (e.metaKey && e.shiftKey && ['3', '4', '5'].includes(e.code?.slice(-1)))) {
    shield(); navigator.clipboard?.writeText('').catch(() => {}); e.preventDefault();
  } else if (e.type === 'keydown' && ((mod && ['c', 'x', 'v', 'p', 's', 'u'].includes(k)) || (mod && k === 'a' && !e.target.closest?.('input, textarea')) || (e.shiftKey && e.key === 'Insert')
    || e.key === 'F12' || (mod && e.shiftKey && ['i', 'j', 'c'].includes(k)))) e.preventDefault();
};
document.addEventListener('keydown', guardKey, true);
document.addEventListener('keyup', guardKey, true);
let leaveTimer;
async function checkLeave() {
  const st = p.state;
  if (!p.active || p.leaving || st?.status !== 'running' || st.phase?.type !== 'round' || st.round?.submitted || (!document.hidden && document.hasFocus())) return;
  p.leaving = true;
  try { applyState(await api('/api/play/leave', { deviceId: p.device })); } catch { /* the next sync will show the real state */ } finally { p.leaving = false; }
}
document.addEventListener('visibilitychange', () => { clearTimeout(leaveTimer); if (document.hidden) leaveTimer = setTimeout(checkLeave, 300); });
addEventListener('blur', () => { if (guarding()) document.documentElement.classList.add('shield'); clearTimeout(leaveTimer); leaveTimer = setTimeout(checkLeave, 700); });
addEventListener('focus', () => document.documentElement.classList.remove('shield'));
// A faint tiled watermark with the student's code on every screen of a live test.
function watermark(code) {
  let w = $('#wm');
  if (!code) { w?.remove(); return; }
  if (!w) { w = document.createElement('div'); w.id = 'wm'; w.setAttribute('aria-hidden', 'true'); document.body.append(w); }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="260" height="170"><text x="20" y="100" transform="rotate(-24 130 85)" font-family="sans-serif" font-size="20" font-weight="700" fill="#000">${esc(code)}</text></svg>`;
  w.style.backgroundImage = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

// ---------------------------------------------------------------- cookie notice
// Promptathon sets only the cookie that keeps you signed in, so this is a notice with one button, not a choice between trackers.
function cookieNotice() {
  if (store.get('pt-cookie-notice') || $('#cookie-bar')) return;
  const bar = document.createElement('div');
  bar.id = 'cookie-bar'; bar.className = 'cookie-bar'; bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', 'Cookie notice');
  bar.innerHTML = `<p>🍪 We only use one small cookie to keep you signed in, and your browser remembers your reading settings. No ads, no tracking. <a href="#/legal/cookies">Cookie policy</a> · <a href="#/legal/privacy">Privacy policy</a></p>
    <button class="btn sm" data-act="cookie-ok">Got it</button>`;
  document.body.append(bar);
}

// ---------------------------------------------------------------- boot
applyPrefs();
try {
  [cfg, me] = await Promise.all([api('/api/config'), api('/api/me')]);
  route();
  cookieNotice();
} catch {
  main.innerHTML = '<div class="wrap"><p class="note bad" style="margin-top:32px">Promptathon can’t reach the server right now. Please refresh in a moment.</p></div>';
}
export const getCtx = () => ({ cfg, me });
