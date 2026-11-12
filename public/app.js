// Promptathon client: app shell, reading & accessibility tools, and the student journey.
// The admin dashboard lives in admin.js and is loaded only for hosts.
//
// Who is playing is remembered per browser TAB (sessionStorage), never in a cookie, so many children can share one
// computer or browser profile without ever becoming each other. Every student request carries that tab's player token.

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const fmt = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const main = $('#main');
let cfg, me = { signedIn: false }, endedNote = ''; // endedNote: shown on the join page after a host logs this window out

// ---------------------------------------------------------------- per-tab storage and identity
const tabStore = {
  get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  del(k) { try { sessionStorage.removeItem(k); } catch { /* ignore */ } },
};
const shared = { // this browser (shared by every tab): only the answer backup (keyed by attempt) and the cookie notice
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full or private */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const newId = () => crypto.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
const player = () => tabStore.get('pt-player'); // { token, id, name, code, grade }
const setPlayer = (p) => (p ? tabStore.set('pt-player', p) : tabStore.del('pt-player'));

// The tab id tells the server which window is playing. A duplicated tab copies sessionStorage, so on start-up each
// tab asks the others whether its id is taken (BroadcastChannel) and picks a new one if it is.
const INSTANCE = newId();
let TAB = tabStore.get('pt-tab') || newId();
tabStore.set('pt-tab', TAB);
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('pt-tabs') : null;
channel?.addEventListener('message', (e) => {
  if (e.data?.ask === TAB && e.data.from !== INSTANCE) channel.postMessage({ taken: TAB, from: INSTANCE });
  if (e.data?.taken === TAB && e.data.from !== INSTANCE) { TAB = newId(); tabStore.set('pt-tab', TAB); }
});
channel?.postMessage({ ask: TAB, from: INSTANCE });

// Round lengths for wording: the student's own schedule while a test is open, otherwise the event's current setting.
const minutesNow = () => (p.active && p.state?.roundSeconds
  ? Object.fromEntries([1, 2, 3].map((r) => [r, Math.max(1, Math.round(p.state.roundSeconds[r] / 60))])) : cfg.roundMinutes);
const minuteText = (m) => `${m} minute${m === 1 ? '' : 's'}`;
const minutesPhrase = () => { const m = minutesNow(); return m[1] === m[2] && m[2] === m[3] ? `${minuteText(m[1])}` : `${m[1]}, ${m[2]} and ${m[3]} minutes`; };

export async function api(url, body, method, timeoutMs = 0) {
  const pl = player();
  const res = await fetch(url, { method: method || (body ? 'POST' : 'GET'), signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(pl?.token ? { 'x-player': pl.token } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : {};
  if (!res.ok) {
    const e = Object.assign(new Error(data.error || 'Something went wrong.'), { status: res.status, code: data.code, missing: data.missing });
    if (e.code === 'closed') onClosed();
    if ((e.code === 'no-student' || e.code === 'logged-out') && pl) { setPlayer(null); endedNote = e.code === 'logged-out' ? 'Your host logged you out of this window. To come back, log in with your player code.' : ''; }
    throw e;
  }
  return data;
}
async function apiBlob(url) { // downloads that need the player header (an <a href> can't send it)
  const res = await fetch(url, { headers: { 'x-player': player()?.token || '' } });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Not available yet.');
  return res.blob();
}

let toastTimer;
export function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}
const announce = (msg) => { $('#sr-live').textContent = msg; };

// Modal dialog. Resolves with the value of the button that closed it ('' / 'cancel' when dismissed).
// A dialog opened right after another one (or over it) is safe: the first ends as dismissed, and the browser's late "close" event
// from the first is ignored because the new dialog is open when it arrives (a real close always arrives with the dialog shut).
let endDialog = null;
export function dialog({ title, body, actions = [], wide = false }) {
  const d = $('#dlg');
  endDialog?.('');
  if (d.open) d.close();
  d.classList.toggle('wide', wide);
  $('#dlg-title').textContent = title;
  $('#dlg-body').innerHTML = body;
  $('#dlg-foot').innerHTML = actions.map((a) => `<button class="btn ${a.kind || ''}" value="${esc(a.value)}">${esc(a.label)}</button>`).join('');
  d.returnValue = '';
  d.showModal();
  return new Promise((resolve) => {
    const finish = (value) => { d.removeEventListener('close', onClose); if (endDialog === finish) endDialog = null; speech.stop(); resolve(value); };
    const onClose = () => { if (!d.open) finish(d.returnValue); };
    endDialog = finish;
    d.addEventListener('close', onClose);
  });
}

// ---------------------------------------------------------------- reading preferences (per tab, so each child sets their own)
const PREFS_KEY = 'pt-prefs';
const DEFAULTS = { theme: 'orange', font: 'standard', scale: 100, letter: 0, word: 0, line: 1.6, reading: false, ruler: false, a11y: false, rate: 0.95, narration: true };
let prefs = { ...DEFAULTS, ...(tabStore.get(PREFS_KEY) || {}) };

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
      ${toggle('a11y', 'Accessible mode', 'Bigger buttons and a stronger focus outline.')}
      ${toggle('reading', 'Reading mode', 'Calm paper background and shorter lines.')}
      ${toggle('ruler', 'Reading ruler', 'A band that follows your pointer and dims the rest of the page.')}
      ${toggle('narration', 'Spoken briefings', 'The instructions before each round are read out loud.')}
      ${range('rate', 'Read-aloud speed', 0.6, 1.4, 0.05, '×')}
      <div class="preview measure" id="pref-preview"><b>Preview:</b> AI can sound confident and still be wrong. Check the source before you share it.
        <button type="button" class="speak" style="display:inline-flex" data-act="speak" data-target="#pref-preview" aria-pressed="false">${ICON_SPEAKER} Read aloud</button></div>
    </div>`,
    actions: [{ label: 'Reset to default', value: 'reset', kind: 'ghost' }, { label: 'Done', value: 'done' }],
  }).then((v) => { if (v === 'reset') { prefs = { ...DEFAULTS }; tabStore.set(PREFS_KEY, prefs); applyPrefs(); toast('Reading settings reset.'); } });
}

document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-pref]');
  if (!el) return;
  const k = el.dataset.pref;
  prefs[k] = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value;
  const v = $(`#v-${k}`);
  if (v) v.textContent = `${prefs[k]}${el.dataset.unit || ''}`;
  tabStore.set(PREFS_KEY, prefs);
  applyPrefs();
});

// Reading ruler follows the pointer and keyboard focus.
document.addEventListener('pointermove', (e) => { if (prefs.ruler) $('#ruler').style.top = `${e.clientY - $('#ruler').offsetHeight / 2}px`; });
document.addEventListener('focusin', (e) => {
  if (!prefs.ruler || !e.target.getBoundingClientRect) return;
  const r = e.target.getBoundingClientRect();
  $('#ruler').style.top = `${r.top + Math.min(r.height, 40) / 2 - $('#ruler').offsetHeight / 2}px`;
});

// ---------------------------------------------------------------- read aloud (word highlighting) and speak-to-type
const ICON_SPEAKER = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/><path d="M19 6a8.5 8.5 0 0 1 0 12"/></svg>';
const ICON_MIC = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg>';
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
    u.lang = 'en-IN';
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
  const skip = '.speak, .mic, script, style, [aria-hidden="true"], .sr-only, textarea, select, .lifelines, .qnav, .stepdots, .actionbar, button';
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => {
    const par = n.parentElement;
    return n.data.trim() && par && !par.closest(skip) && par.getClientRects().length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
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

// Speak-to-type: a microphone button next to every writing box (Chrome / Edge / Safari). Words are added to the box.
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const micBtn = () => ''; // the Speak (microphone) option is removed
const mic = { rec: null, btn: null };
function stopMic() {
  try { mic.rec?.stop(); } catch { /* already stopped */ }
  mic.btn?.setAttribute('aria-pressed', 'false');
  if (mic.btn) mic.btn.querySelector('span').textContent = 'Speak';
  mic.rec = null; mic.btn = null;
}
function startMic(btn) {
  const box = $(btn.dataset.target);
  if (!box || box.disabled) return;
  stopMic();
  const rec = new Recognition();
  rec.lang = 'en-IN'; rec.interimResults = false; rec.continuous = true;
  p.micUntil = Date.now() + 120000; // the browser may ask for the microphone: that is not leaving the test
  rec.onresult = (e) => {
    let said = '';
    for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) said += e.results[i][0].transcript;
    said = said.trim();
    if (!said) return;
    box.value = `${box.value.replace(/\s+$/, '')}${box.value.trim() ? ' ' : ''}${said.charAt(0).toUpperCase()}${said.slice(1)}`;
    box.dispatchEvent(new Event('input', { bubbles: true }));
  };
  rec.onerror = (e) => { if (e.error === 'not-allowed') toast('The microphone is blocked. Ask your host, or type instead.'); stopMic(); };
  rec.onend = () => { if (mic.rec === rec) stopMic(); p.micUntil = Date.now() + 3000; };
  mic.rec = rec; mic.btn = btn;
  btn.setAttribute('aria-pressed', 'true');
  btn.querySelector('span').textContent = 'Listening… tap to stop';
  try { rec.start(); } catch { stopMic(); }
}

// ---------------------------------------------------------------- shell
const narration = (script) => `<div class="bubble" id="narr-text"><b>Briefing</b>${esc(script)}</div>`;

const syncTopH = () => { const r = document.documentElement.style; r.setProperty('--top-h', `${$('#top').offsetHeight}px`); r.setProperty('--foot-h', `${$('.foot').offsetHeight}px`); };
new ResizeObserver(syncTopH).observe($('#top'));
addEventListener('resize', syncTopH);

function renderShell() {
  syncTopH();
  const nav = $('#nav'), acct = $('#account');
  const here = location.hash.split('?')[0];
  const link = (href, label) => `<a href="${href}" ${here.startsWith(href) ? 'aria-current="page"' : ''}>${label}</a>`;
  const isAdminRoute = here.startsWith('#/admin');
  if (isAdminRoute && me.signedIn) {
    nav.innerHTML = link('#/admin', 'Dashboard');
    const initials = (me.name || me.email).split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
    acct.innerHTML = `<div class="account"><button class="icon-btn avatar" data-act="account" aria-expanded="false" aria-label="Account menu">
        ${me.picture ? `<img src="${esc(me.picture)}" alt="" referrerpolicy="no-referrer">` : esc(initials)}</button>
      <div class="account-menu" id="account-menu" hidden><b>${esc(me.name)}</b><div class="muted small">${esc(me.email)}</div>
        <div class="small" style="margin:6px 0 12px">Signed in as <b>host</b></div>
        <button class="btn ghost sm" data-act="logout">Sign out</button></div></div>`;
    return;
  }
  const pl = player();
  if (!pl || isAdminRoute) { nav.innerHTML = ''; acct.innerHTML = ''; return; }
  nav.innerHTML = `${link('#/play', 'My test')}${link('#/leaderboard', 'Leaderboard')}`;
  acct.innerHTML = `<div class="account"><button class="player-chip" data-act="account" aria-expanded="false" aria-label="Player: ${esc(pl.name)}">
      <span class="pc-name">${esc(pl.name.split(' ')[0])}</span><span class="pc-code">${esc(pl.code)}</span></button>
    <div class="account-menu" id="account-menu" hidden><b>${esc(pl.name)}</b><div class="muted small">Grade ${esc(pl.grade)} · code ${esc(pl.code)}</div>
      <p class="small" style="margin:8px 0 0">This window belongs to ${esc(pl.name.split(' ')[0])} and can’t be switched. Wrong player? Ask your host to log you out.</p></div></div>`;
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

// ---------------------------------------------------------------- closed (the host decides when Promptathon is open)
let closedPoll;
function onClosed() {
  if (cfg) cfg.open = false;
  if (location.hash.startsWith('#/admin') || location.hash.startsWith('#/legal')) return;
  if (p.active && p.state && ['running', 'paused'].includes(p.state.status)) { closedOverlay(true); }
  else if (!$('.closed-page')) closedPage();
  clearInterval(closedPoll);
  closedPoll = setInterval(async () => {
    try {
      const c = await api('/api/config');
      if (c.open) { cfg = c; clearInterval(closedPoll); closedOverlay(false); route(); }
    } catch { /* keep waiting */ }
  }, 5000);
}
function closedOverlay(on) {
  let ov = $('#closed-ov');
  if (!on) { ov?.remove(); main.inert = false; return; }
  if (ov) return;
  ov = document.createElement('div');
  ov.id = 'closed-ov'; ov.className = 'overlay';
  ov.innerHTML = `<div class="card" role="alertdialog" aria-labelledby="cl-t">${mascot('sm')}<h2 id="cl-t">Promptathon is paused for a moment</h2>
    <p>Your host has closed Promptathon for now. Your clock is stopped and your answers are saved.</p><p class="muted small">Stay on this page — it continues by itself when your host opens it again.</p></div>`;
  document.body.append(ov);
  main.inert = true;
  startMascot(ov);
  announce('Promptathon is paused by your host. Your answers are saved.');
}
function closedPage() {
  stopPlay();
  main.innerHTML = `<div class="wrap"><section class="home closed-page">${portal(`${sprite()}<span class="z">z</span><span class="z">z</span><span class="z">Z</span>`, 'nap')}<div class="home-text">
    <h1 class="fx-title" aria-label="Promptathon">${letters('Promptathon')}</h1><p class="home-lead">Promptathon is closed right now.</p>
    <p class="muted" style="max-width:44ch">Your host will open it soon. Keep this page open — it opens by itself when Promptathon starts.</p>
    <div class="waiting" style="margin-top:20px"><span class="pulse" aria-hidden="true"></span><span>Waiting for your host<span class="dots"></span></span></div>
    <p class="host-entry" id="closed-host"><a class="btn ghost" href="#/admin">Host sign-in</a></p></div></section></div>`;
  startMascot(main);
  scene('closed');
  api('/api/me').then((m) => { // a host who is already signed in goes straight to the dashboard
    if (m.signedIn && $('#closed-host')) $('#closed-host').innerHTML = '<a class="btn" href="#/admin/live">Open the host dashboard →</a>';
  }).catch(() => {});
}

// ---------------------------------------------------------------- router
async function route() {
  speech.stop();
  stopMic();
  stopPlay();
  $$('.overlay:not(#closed-ov)').forEach((o) => o.remove());
  main.inert = false;
  const [name = '', sub = ''] = location.hash.replace(/^#\/?/, '').split('?')[0].split('/');
  scene(name === 'admin' ? 'admin' : name === 'legal' ? 'legal' : 'page');
  if (name === 'admin') {
    try { me = await api('/api/me'); } catch { me = { signedIn: false }; }
    renderShell();
    if (!me.signedIn) return adminSignIn();
    const m = await import('/admin.js');
    return m.renderAdmin(main, sub || 'live', { cfg, me });
  }
  renderShell();
  if (name === 'legal') return (await import('/legal.js')).renderLegal(main, sub || 'privacy', { cfg, api, toast, esc });
  try { cfg = { ...cfg, ...(await api('/api/config')) }; } catch { /* keep the last copy */ }
  if (!cfg.open) return onClosed();
  if (!player()) return name === 'join' || name === 'lobby' ? joinPage() : name === 'login' ? loginPage() : landing();
  if (['join', 'lobby', 'login'].includes(name)) { location.hash = '#/play'; return; } // already in: this window stays this player's
  if (name === 'leaderboard') return leaderboardPage();
  if (name === 'welcome') return welcomePage();
  return playPage();
}

function focusMain() { main.focus({ preventScroll: true }); window.scrollTo(0, 0); }

// ---------------------------------------------------------------- host sign-in (Google, hosts only)
const GOOGLE_G = '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';
function adminSignIn() {
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  const err = q.get('error');
  main.innerHTML = `<div class="wrap"><section class="card host-signin">
    <img src="/the-ai-club-logo.png" alt="The AI Club" width="120" height="66">
    <h1>Host sign-in</h1><p class="muted">For teachers and organisers who run Promptathon. Players don’t sign in — they just type their name.</p>
    ${err === 'notadmin' ? `<p class="note bad">${esc(q.get('who') || 'That account')} isn’t a host. Ask an existing host to add you in Setup.</p>` : err ? '<p class="note bad">Sign-in didn’t work. Please try again.</p>' : ''}
    ${cfg.googleReady ? `<a class="btn lg g-btn" href="/auth/google">${GOOGLE_G} Sign in with Google</a>` : '<p class="note bad">Google sign-in isn’t set up on this server (GOOGLE_CLIENT_ID).</p>'}
    <p class="small"><a href="#/">← Back to Promptathon</a></p></section></div>`;
  focusMain();
}

// ---------------------------------------------------------------- landing
// Foldling, our mascot: the celebration clip with its "Congratulations!" bubble cropped off (see .mascot in styles.css).
const mascot = (cls = '') => `<div class="mascot ${cls}" aria-hidden="true"><video src="/star_congratulations.webm" muted playsinline preload="auto"></video></div>`;
function startMascot(root = document, loopsMax = Infinity) {
  for (const v of root.querySelectorAll('.mascot video')) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { v.currentTime = 0.01; continue; }
    v.loop = loopsMax === Infinity;
    let loops = 0;
    v.addEventListener('ended', () => { if (++loops < loopsMax) v.play().catch(() => {}); });
    v.addEventListener('pause', () => { if (v.loop && !v.ended && !document.hidden && v.isConnected) v.play().catch(() => {}); });
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
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `${mascot('sm')}<p class="guide-say">${esc(text)}</p>`;
  document.body.append(el);
  announce(text);
  startMascot(el, 1);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 500); }, 6500);
}
const TIPS = { half: 'You’re halfway there. Keep going!', near: 'Almost there! Take a moment to check your answers.' };
const roundPills = () => `<ul class="pills">${[1, 2, 3].map((r) => `<li class="tint-${r}"><span aria-hidden="true">${cfg.rounds[r].icon}</span> ${esc(cfg.rounds[r].name)}</li>`).join('')}</ul>`;

function landing() {
  main.innerHTML = `<div class="wrap">
    <section class="home">
      ${portal(mascot())}
      <div class="home-text">
        <h1 class="fx-title" aria-label="Promptathon">${letters('Promptathon')}</h1>
        <p class="home-lead">Three fun AI challenges. Are you ready?</p>
        ${roundPills()}
        <div class="row" style="margin-top:28px"><a class="btn xl glow" href="#/lobby">Let’s start <span aria-hidden="true">→</span></a>
          <a class="btn lg ghost" href="#/login">🔑 I have a player code</a></div>
        <div class="row" style="margin-top:12px"><button class="btn quiet" data-act="rules">How to play</button></div>
        <p class="small muted" style="margin-top:8px;max-width:46ch">New here? Press <b>Let’s start</b>. Played before and your host logged you out? Use your <b>player code</b> to come back.</p>
      </div>
    </section>
    <section class="comic-band" aria-label="A little comic from Foldling"><h2 class="center">A quick story with Foldling</h2>${comic('rain')}</section>
  </div>`;
  focusMain();
  startMascot();
  scene('home');
}

// ---------------------------------------------------------------- registration: two short steps
const join = { step: 1, data: {}, error: '' };
function joinPage() {
  const d = join.data;
  const schools = cfg.schools || [];
  const step1 = `<form class="card join-card" id="join-1" novalidate autocomplete="off">
      <div class="kicker">Lobby · Step 1 of 2</div><h1>Who’s playing?</h1>
      ${endedNote ? `<p class="note warn" role="status">${esc(endedNote)} <a href="#/login">Log in with your player code →</a></p>` : ''}
      <p class="small" style="margin:0">Played before? <a href="#/login">Log in with your player code</a> instead — joining again makes a brand-new player.</p>
      <div class="field"><label for="j-name">Your full name</label>
        <input id="j-name" name="name" type="text" autocomplete="off" autocapitalize="words" spellcheck="false" maxlength="60" required value="${esc(d.name || '')}" placeholder="For example: Riya Sharma">
        <span class="field-err" id="e-name" role="alert"></span></div>
      <fieldset class="field"><legend>Your grade</legend>
        <div class="grade-pick" role="radiogroup">${cfg.grades.map((g) => `<label class="grade-opt"><input type="radio" name="grade" value="${g}" ${String(d.grade) === String(g) ? 'checked' : ''} required><span><small>Grade</small>${g}</span></label>`).join('')}</div>
        <span class="field-err" id="e-grade" role="alert"></span></fieldset>
      <div class="field"><label for="j-school">Your school</label>
        ${schools.length ? `<select id="j-school" name="schoolId" required><option value="">Choose your school</option>${schools.map((s) => `<option value="${s.id}" ${d.schoolId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`
          : '<p class="note">Your host hasn’t added any schools yet. Please wait a moment and reload.</p>'}
        <span class="field-err" id="e-school" role="alert"></span></div>
      <div class="actionbar static"><a class="btn ghost lg" href="#/">← Back</a><button class="btn lg" ${schools.length ? '' : 'disabled'}>Next →</button></div>
    </form>`;
  const step2 = `<form class="card join-card" id="join-2" novalidate autocomplete="off">
      <div class="kicker">Lobby · Step 2 of 2</div><h1>A grown-up’s contact</h1>
      <p class="muted" style="margin-top:0">Ask your parent, guardian or teacher. We only use it to send your score card and to contact your school about Promptathon.</p>
      <div class="field"><label for="j-phone">Phone number <span class="req">required</span></label>
        <input id="j-phone" name="phone" type="tel" inputmode="tel" autocomplete="off" maxlength="20" required value="${esc(d.phone || '')}" placeholder="e.g. 98765 43210">
        <span class="field-err" id="e-phone" role="alert"></span></div>
      <div class="field"><label for="j-email">Email <span class="hint">(optional — your score card can be emailed here)</span></label>
        <input id="j-email" name="email" type="email" inputmode="email" autocomplete="off" maxlength="120" value="${esc(d.email || '')}" placeholder="name@example.com">
        <span class="field-err" id="e-email" role="alert"></span></div>
      <label class="check consent"><input type="checkbox" name="consent" ${d.consent ? 'checked' : ''} required><span>A parent, guardian or teacher said I can take part. They agree to the
        <a href="#/legal/privacy" target="_blank" rel="noopener">Privacy Policy</a> and <a href="#/legal/terms" target="_blank" rel="noopener">Terms</a>.</span></label>
      <span class="field-err" id="e-consent" role="alert"></span>
      ${join.error ? `<p class="note bad" role="alert">${esc(join.error)}</p>` : ''}
      <p class="small muted" style="margin:0">Once you join, this window is yours: you can fix your details in the lobby, but you can’t switch to another player. Only your host can log you out.</p>
      <div class="review-me"><b>${esc(d.name || '')}</b> · Grade ${esc(d.grade || '')} · ${esc(schools.find((s) => s.id === d.schoolId)?.name || '')} <button type="button" class="btn quiet sm" data-act="join-back">Change</button></div>
      <div class="actionbar static"><button type="button" class="btn ghost lg" data-act="join-back">← Back</button><button class="btn lg" id="join-go">Join Promptathon →</button></div>
    </form>`;
  main.innerHTML = `<div class="wrap narrow"><div class="join">${mascot('sm')}${join.step === 1 ? step1 : step2}</div></div>`;
  focusMain();
  startMascot(main);
  scene('join');
  $(join.step === 1 ? '#j-name' : '#j-phone')?.focus();
}

// ---------------------------------------------------------------- log back in with a player code
function loginPage(error = '') {
  main.innerHTML = `<div class="wrap narrow"><div class="join">${mascot('sm')}
    <form class="card join-card" id="login-form" novalidate autocomplete="off">
      <div class="kicker">Lobby · Come back</div><h1>Your player code</h1>
      ${endedNote ? `<p class="note warn" role="status">${esc(endedNote)}</p>` : ''}
      <p class="muted" style="margin:0">It’s on your welcome screen and at the top of your test, like <b class="code">BZ-ABCDE</b>. Don’t know it? Your host can see it.</p>
      <div class="field"><label for="l-code">Player code</label>
        <div class="code-input"><span aria-hidden="true">BZ-</span><input id="l-code" name="code" type="text" inputmode="text" autocapitalize="characters" spellcheck="false" maxlength="9" required placeholder="ABCDE" aria-describedby="e-code"></div>
        <span class="field-err" id="e-code" role="alert">${esc(error)}</span></div>
      <div class="actionbar static"><a class="btn ghost lg" href="#/">← Back</a><button class="btn lg" id="login-go">Log in →</button></div>
      <p class="small muted" style="margin:0">New player? <a href="#/lobby">Join here</a>.</p>
    </form></div></div>`;
  focusMain(); startMascot(main); scene('join');
  $('#l-code').focus();
}

function fieldError(id, msg) { const el = $(`#e-${id}`); if (el) el.textContent = msg || ''; return !msg; }
// a message disappears as soon as the field is fixed
for (const t of ['input', 'change']) document.addEventListener(t, (e) => {
  const form = e.target.closest?.('#join-1, #join-2');
  if (!form) return;
  const id = { name: 'name', grade: 'grade', schoolId: 'school', phone: 'phone', email: 'email', consent: 'consent' }[e.target.name];
  if (id) fieldError(id, '');
});

document.addEventListener('submit', async (e) => {
  if (e.target.id === 'login-form') {
    e.preventDefault();
    const code = String(new FormData(e.target).get('code') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^BZ(?=.{5}$)/, '');
    if (code.length !== 5) { fieldError('code', 'A player code has 5 letters and numbers after BZ-.'); return; }
    const btn = $('#login-go'); btn.disabled = true; btn.textContent = 'Checking…';
    try {
      const r = await api('/api/login', { code: `BZ-${code}` });
      setPlayer({ token: r.token, id: r.student.id, name: r.student.name, code: r.student.code, grade: r.student.grade });
      endedNote = '';
      renderShell();
      await playerCard(r.student, true);
      toast(`Welcome back, ${r.student.name.split(' ')[0]}!`);
      location.hash = '#/play';
    } catch (err) { btn.disabled = false; btn.textContent = 'Log in →'; fieldError('code', err.message); }
    return;
  }
  if (e.target.id === 'join-1') {
    e.preventDefault();
    const f = new FormData(e.target);
    const name = String(f.get('name') || '').replace(/\s+/g, ' ').trim();
    const ok = [fieldError('name', name.length < 2 ? 'Please type your full name.' : ''),
      fieldError('grade', f.get('grade') ? '' : 'Please choose your grade.'),
      fieldError('school', f.get('schoolId') ? '' : 'Please choose your school.')].every(Boolean);
    if (!ok) { $('.field-err:not(:empty)')?.closest('.field')?.querySelector('input,select')?.focus(); return; }
    Object.assign(join.data, { name, grade: Number(f.get('grade')), schoolId: f.get('schoolId') });
    join.step = 2;
    joinPage();
  }
  if (e.target.id === 'join-2') {
    e.preventDefault();
    const f = new FormData(e.target);
    const phone = String(f.get('phone') || '').trim(), email = String(f.get('email') || '').trim();
    Object.assign(join.data, { phone, email, consent: f.get('consent') === 'on' });
    const ok = [fieldError('phone', /^\+?[\d\s().-]{6,20}$/.test(phone) && phone.replace(/\D/g, '').length >= 6 ? '' : 'Please type a phone number (digits only).'),
      fieldError('email', !email || /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? '' : 'That email doesn’t look right. Check it, or leave it empty.'),
      fieldError('consent', join.data.consent ? '' : 'Please tick this box first.')].every(Boolean);
    if (!ok) return;
    const btn = $('#join-go');
    btn.disabled = true; btn.textContent = 'Joining…';
    try {
      const r = await api('/api/register', join.data);
      setPlayer({ token: r.token, id: r.student.id, name: r.student.name, code: r.student.code, grade: r.student.grade });
      join.step = 1; join.data = {}; join.error = ''; endedNote = '';
      renderShell();
      await playerCard(r.student, r.returning);
      toast(r.returning ? `Welcome back, ${r.student.name.split(' ')[0]}! We found your test.` : `Welcome, ${r.student.name.split(' ')[0]}! Your player code is ${r.student.code}.`);
      location.hash = r.returning ? '#/play' : '#/welcome';
    } catch (err) {
      btn.disabled = false; btn.textContent = 'Join Promptathon →';
      toast(err.message);
    }
  }
});

// ---------------------------------------------------------------- edit my details (lobby only)
async function editProfile() {
  const s = p.state.student, locked = Boolean(s.gradeLocked);
  let v = { name: s.name, grade: s.grade, schoolId: s.schoolId, phone: s.phone, email: s.email };
  for (;;) {
    const body = `<div class="stack">
      <div class="field"><label for="ep-name">Your full name</label><input id="ep-name" type="text" required maxlength="60" autocomplete="off" value="${esc(v.name)}"></div>
      <fieldset class="field"><legend>Your grade${locked ? ' (locked — you have played already)' : ''}</legend>
        <div class="grade-pick">${cfg.grades.map((g) => `<label class="grade-opt"><input type="radio" name="ep-grade" value="${g}" ${Number(v.grade) === g ? 'checked' : ''} ${locked ? 'disabled' : 'required'}><span><small>Grade</small>${g}</span></label>`).join('')}</div></fieldset>
      <div class="field"><label for="ep-school">Your school</label><select id="ep-school" required>${(cfg.schools || []).map((x) => `<option value="${x.id}" ${v.schoolId === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="ep-phone">Phone number <span class="req">required</span></label><input id="ep-phone" type="tel" inputmode="tel" required maxlength="20" autocomplete="off" value="${esc(v.phone)}"></div>
      <div class="field"><label for="ep-email">Email <span class="hint">(optional)</span></label><input id="ep-email" type="email" inputmode="email" maxlength="120" autocomplete="off" value="${esc(v.email)}"></div></div>`;
    const choice = await dialog({ title: 'Edit my details', body, actions: [{ label: 'Cancel', value: 'no', kind: 'ghost' }, { label: 'Save', value: 'save' }] });
    if (choice !== 'save') return;
    v = { name: $('#ep-name').value, grade: locked ? s.grade : Number($('input[name=ep-grade]:checked')?.value) || '', schoolId: $('#ep-school').value, phone: $('#ep-phone').value, email: $('#ep-email').value };
    try {
      const st = await api('/api/play/profile', v);
      setPlayer({ ...player(), name: st.student.name, grade: st.student.grade });
      p.lastKey = ''; applyState(st); renderShell();
      toast('Your details are saved.');
      return;
    } catch (err) { toast(err.message); if (['locked'].includes(err.code)) { p.lastKey = ''; syncTick(); return; } } // otherwise reopen with what was typed
  }
}

// ---------------------------------------------------------------- welcome (after joining, before the lobby)
function welcomePage() {
  const pl = player();
  main.innerHTML = `<div class="wrap">
    <section class="welcome" id="welcome-text">
      <div class="welcome-guide">
        ${mascot('lg')}
        <p class="guide-say">Hi! I’m <b>Foldling</b>, your guide. Get ready for three fun challenges!</p>
      </div>
      <h1>${esc(pl.name.split(' ')[0])}, welcome to Promptathon!</h1>
      <p class="motto"><span class="tint-1">Think fast.</span> <span class="tint-2">Check carefully.</span> <span class="tint-3">Make smart choices with AI.</span></p>
      <ol class="round-cards">${[1, 2, 3].map((r) => `<li class="tint-${r}" style="--i:${r - 1}"><span class="rc-icon" aria-hidden="true">${cfg.rounds[r].icon}</span>
        <span class="rc-num">Round ${r}</span><b>${esc(cfg.rounds[r].name)}</b><span class="rc-blurb">${esc(cfg.rounds[r].blurb)}</span></li>`).join('')}</ol>
      <p class="muted" style="margin:0">${minutesPhrase()} per round · a practice question before each round · 60 points in total</p>
      <p class="your-code">Your player code: <b class="code">${esc(pl.code)}</b></p>
      <p class="choice">How would you like to get ready?</p>
      <div class="row welcome-go">
        <a class="btn lg" href="#/play">Go to the lobby <span aria-hidden="true">→</span></a>
        <a class="btn lg ghost" href="/guide.html">📖 Take Foldling’s guide first</a>
        ${speakBtn('#welcome-text', 'Read aloud')}
      </div>
    </section>
  </div>`;
  focusMain();
  startMascot();
  scene('welcome');
}

// ---------------------------------------------------------------- leaderboard (shared with admin)
export function leaderboardHTML(lb, { meCode, bands, fx = false } = {}) {
  const v = (x) => (x == null ? '—' : x);
  return `<div class="row between" style="margin-bottom:12px"><div><b>${esc(lb.event)}</b> · ${esc(bands?.find((b) => b.id === lb.band)?.label || lb.band)}</div>
      ${lb.final ? '<span class="chip ok">Final results</span>' : '<span class="chip warn">Provisional — scores are being checked</span>'}</div>
    <div class="awards" style="margin-bottom:16px">${lb.awards.map((a) => `<div class="award"><b>${esc(a.title)}</b>
      <span class="${a.winners.length ? '' : 'muted'}">${a.winners.length ? esc(a.winners.join(', ')) : 'To be decided'}</span></div>`).join('')}</div>
    <div class="table-wrap"><table class="t ${fx ? 'lb' : ''}"><caption class="sr-only">Leaderboard</caption>
      <thead><tr><th>Rank</th><th>Player</th><th>School</th><th class="num">R1</th><th class="num">R2</th><th class="num">R3</th><th class="num">Total /60</th></tr></thead>
      <tbody>${lb.rows.length ? lb.rows.map((r, i) => `<tr class="${r.me || (r.code && r.code === meCode) ? 'me' : ''}" style="--i:${Math.min(i, 20)}">
        <td class="rank">${r.rank ?? '<span class="chip">Scoring…</span>'}${fx && r.rank >= 1 && r.rank <= 3 ? ` <span class="medal" style="--i:${i}" aria-hidden="true">${['🥇', '🥈', '🥉'][r.rank - 1]}</span>` : ''}</td>
        <td><b>${esc(r.name)}</b>${r.me ? ' <span class="chip brand">you</span>' : ''} ${r.code ? `<span class="muted small">${esc(r.code)}</span>` : ''}</td><td>${esc(r.school)}</td>
        <td class="num">${v(r.r1)}</td><td class="num">${v(r.r2)}</td><td class="num">${v(r.r3)}</td><td class="num"><b>${v(r.total)}</b></td></tr>`).join('')
        : '<tr><td colspan="7" class="muted center">No scores yet.</td></tr>'}</tbody></table></div>
    <p class="small muted" style="margin-top:8px">Ties are split by Round 2, then Round 3 details. Equal scores share a rank.</p>`;
}

async function leaderboardPage() {
  main.innerHTML = '<div class="wrap"><div class="page-head"><h1>Leaderboard</h1><p>Loading…</p></div></div>';
  try {
    const lb = await api('/api/leaderboard');
    main.innerHTML = `<div class="wrap"><div class="page-head"><h1>Leaderboard</h1>
        <p>${lb.scope === 'all' ? 'Players from all schools in your grade band' : 'Players from your school in your grade band'} — everyone here answered the same questions.</p></div>
      ${leaderboardHTML(lb, { bands: cfg.bands, fx: true })}
      <div class="row" style="margin-top:20px"><a class="btn ghost" href="#/play">← Back to my test</a></div></div>`;
  } catch (err) {
    if (err.code === 'no-student' || err.code === 'logged-out') return sessionEnded();
    if (err.code !== 'closed') main.innerHTML = `<div class="wrap"><p class="note bad">${esc(err.message)}</p></div>`;
  }
  focusMain();
}

// ---------------------------------------------------------------- the test
const p = {};
function stopPlay() { clearTimeout(p.syncTimer); clearInterval(p.clockInt); p.active = false; document.documentElement.classList.remove('guard', 'in-round'); watermark(''); }

async function playPage() {
  Object.assign(p, { active: true, state: null, content: null, draft: {}, ver: 0, ackVer: 0, lastKey: '', conflict: false, busy: false,
    qi: 0, offline: false, savedAt: null, saveError: '', announced: {}, preflight: { sound: false, save: false, tools: false }, item: null, justDone: null, review: false });
  main.innerHTML = '<div class="wrap"><p class="page-head">Loading your test…</p></div>';
  try {
    applyState(await api('/api/play'));
  } catch (err) {
    if (err.code === 'no-student' || err.code === 'logged-out') { sessionEnded(); return; }
    if (err.code === 'closed') return;
    main.innerHTML = `<div class="wrap"><p class="note bad">${esc(err.message)}</p><button class="btn" onclick="location.reload()">Try again</button></div>`;
    return;
  }
  p.clockInt = setInterval(updateClock, 250);
  syncLoop();
}

const localKey = (round) => `pt-draft-${p.state?.attemptId}-${round}`;
const inRound = () => p.state?.phase?.type === 'round' && p.content && !p.content.submitted && !p.state.round?.submitted;

// One request at a time: every second in a round (autosave), every two seconds otherwise.
function syncLoop() {
  clearTimeout(p.syncTimer);
  if (!p.active) return;
  syncTick().finally(() => { if (p.active) p.syncTimer = setTimeout(syncLoop, inRound() ? 1000 : 2000); });
}

async function syncTick() {
  if (!p.active || p.busy || p.conflict) return;
  p.busy = true;
  stampItem();
  const body = { deviceId: TAB };
  if (p.pendingAck) body.ack = p.pendingAck;
  if (p.metaChanged && Date.now() - (p.draftSentAt || 0) > 10000) { p.ver++; p.metaChanged = false; } // time on each question, every 10 s at most
  const ver = p.ver;
  const sendDraft = p.content && !p.content.submitted && ver !== p.ackVer && p.state?.status === 'running';
  if (sendDraft) { body.round = p.content.round; body.draft = p.draft; p.draftSentAt = Date.now(); p.metaChanged = false; }
  try {
    const st = await api('/api/play/sync', body, undefined, 8000);
    p.offline = false;
    if (cfg.open === false) { cfg.open = true; closedOverlay(false); }
    if (!p.preflight.save) { p.preflight.save = true; p.lastKey = ''; }
    if (body.ack === p.pendingAck) p.pendingAck = null;
    if (st.saved) {
      p.ackVer = ver;
      if (st.saved.ok) { p.savedAt = st.saved.savedAt; p.saveError = ''; } else p.saveError = st.saved.reason;
    }
    applyState(st);
  } catch (err) {
    if (err.code === 'device') { p.conflict = true; renderPlay(); }
    else if (err.code === 'no-student' || err.code === 'logged-out') sessionEnded();
    else if (err.code !== 'closed') p.offline = true;
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
    else if (round && ph.key !== prev.phase.key && left > 5000 && st.status === 'running' && !p.submittedHere) toast('Your host ended the round early.');
  }
  // the round just ended (submitted here, or by the timer): show the "Round done" screen before the next instructions
  if (prev?.phase.type === 'round' && st.phase.key !== prev.phase.key && st.status !== 'stopped') {
    p.justDone = prev.phase.round; p.review = false; p.content = null; p.submittedHere = false;
    celebrate(`r${prev.phase.round}`);
  }
  if (prev?.status === 'waiting' && st.status === 'running' && st.phase.round) gameOn(st.phase.round);
  if (prev?.phase.type === 'round' && ['finish', 'done'].includes(st.phase.type) && st.status !== 'stopped') finale(st);
  p.state = st;
  p.base = { ms: st.phase.remainingMs ?? 0, at: performance.now() };
  const ph = st.phase;
  if (ph.type === 'finish' || ph.type === 'done') celebrate('final');
  const key = [st.status, ph.key || ph.type, st.round?.submitted, Object.keys(st.acks).sort().join(','), st.results.rounds.map((r) => `${r.state}${r.total}`).join(','),
    st.final, st.request?.status, st.scorecard, st.feedback, p.justDone].join('|');
  if (key !== p.lastKey) {
    const phaseChanged = !prev || (prev.phase.key || prev.phase.type) !== (ph.key || ph.type) || prev.status !== st.status;
    p.lastKey = key;
    if (phaseChanged) onPhaseChange(st);
    renderPlay();
  }
  pauseOverlay(st.paused && !st.closedPause, st.lock);
  if (st.closedPause && st.paused) closedOverlay(true); else if (st.open) closedOverlay(false);
  const live = ['running', 'paused'].includes(st.status);
  document.documentElement.classList.toggle('guard', live);
  watermark(live ? st.student?.code : '');
}

// Congratulations star: pops up bottom-left when a round (or the whole test) is finished.
function celebrate(key) {
  p.celebrated ??= {};
  if (p.celebrated[key]) return;
  p.celebrated[key] = true;
  $('#star-pop')?.remove();
  const el = document.createElement('div');
  el.id = 'star-pop';
  el.className = 'star-pop';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<video src="/star_congratulations.webm" autoplay muted loop playsinline></video>';
  document.body.append(el);
  el.querySelector('video').play?.().catch(() => {});
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 500); }, 6000);
}

function onPhaseChange(st) {
  speech.stop();
  stopMic();
  const ph = st.phase;
  if (ph.type === 'round' && p.content?.round !== ph.round) { p.content = null; p.qi = 0; p.review = false; }
  if (ph.title) announce(`${ph.title}.`);
  if (ph.type === 'brief' && ph.script && prefs.narration && p.audioOn && briefStep(ph.round) === 'how') setTimeout(() => speech.speak(ph.script), 600);
}

function pauseOverlay(paused, lock) {
  let ov = $('#pause-ov');
  main.inert = Boolean(paused) || Boolean($('#closed-ov'));
  const key = paused ? (lock ? `lock-${lock.requested}` : 'host') : '';
  if (ov && ov.dataset.key !== key) { ov.remove(); ov = null; }
  if (paused && !ov) {
    ov = document.createElement('div');
    ov.id = 'pause-ov';
    ov.dataset.key = key;
    ov.className = 'overlay';
    const back = lock?.reason === 'logout';
    ov.innerHTML = lock
      ? `<div class="card" role="alertdialog" aria-labelledby="pv-t">${back ? `<img class="ov-foldling" src="/foldling-happy.webp" alt="" aria-hidden="true">` : ''}<h2 id="pv-t">${back ? 'Welcome back!' : 'You left the test window'}</h2>
          <p>${back ? 'Your test is paused and your answers are saved. Ask your host to let you continue from where you stopped.' : 'Your clock is paused and your answers are saved. Your host has to let you continue.'}</p>
          ${lock.requested ? '<p><span class="chip ok">✓ Request sent</span></p><p class="muted small">Please wait here. The test continues on this screen once your host says yes.</p>'
            : `<div class="field" style="text-align:left"><label for="lock-note">${back ? 'Anything to tell your host?' : 'Why did you need to leave?'} <span class="hint">(optional)</span></label><textarea id="lock-note" maxlength="300" style="min-height:70px"></textarea></div>
               <button class="btn lg" data-act="lock-request">Ask my host to let me continue</button>`}</div>`
      : '<div class="card" role="alertdialog" aria-labelledby="pv-t"><h2 id="pv-t">Paused by your host</h2><p>Your clock is frozen and your answers are saved. Please wait — the test will continue here.</p></div>';
    document.body.append(ov);
    announce(back ? 'Welcome back. Your test is paused. Ask your host to let you continue.' : lock ? 'You left the test window. Ask your host to let you continue.' : 'The test is paused by your host.');
  } else if (!paused && ov) { ov.remove(); announce('The test has resumed.'); }
}

function updateClock() {
  if (!p.state?.phase) return;
  const ph = p.state.phase;
  const left = p.state.paused ? p.base.ms : p.base.ms - (performance.now() - p.base.at);
  $$('[data-clock]').forEach((el) => { el.textContent = fmt(left); });
  const t = $('#clock');
  if (t) t.classList.toggle('low', ph.type === 'round' && left < 60000);
  const sec = Math.ceil(left / 1000);
  if (t && ph.type === 'round' && !p.state.paused && sec > 0 && sec <= 10 && t.dataset.s !== String(sec)) {
    t.dataset.s = sec; t.classList.remove('tick'); void t.offsetWidth; t.classList.add('tick');
  }
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
    const c = p.content, q = `${ph.key}-q${p.qi}`;
    if (p.onQ?.key !== q) p.onQ = { key: q, at: performance.now() };
    else if (c?.round === ph.round && performance.now() - p.onQ.at > 60000 && !p.announced[q] && c.lifelines.used.length < cfg.lifelinesPerRound) {
      p.announced[q] = true; mascotTip('Stuck? That’s okay! Try a lifeline — the buttons are at the top.');
    }
  }
  if (ph.remainingMs != null && left < -1500 && !p.busy) syncTick();
}

function updateStatus() {
  const el = $('#saved');
  if (!el) return;
  const pending = p.ver !== p.ackVer;
  let text, warn = false;
  if (p.offline) { text = 'Offline — your answers are kept on this computer, retrying…'; warn = true; }
  else if (p.saveError) { text = p.saveError; warn = true; }
  else if (pending) text = 'Saving…';
  else if (p.savedAt) text = `Saved ${new Date(p.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  else text = 'Autosave on';
  el.classList.toggle('warn', warn);
  el.innerHTML = `<i class="dot" aria-hidden="true"></i><span>${esc(text)}</span>`;
}

// ---------- time on each question and questions passed over (saved with the answers) ----------
function itemKeyOf(i = p.qi) {
  const c = p.content;
  if (!c) return null;
  if (c.round === 1) return [...c.view.items, c.view.boss][i]?.id;
  if (c.round === 2) return `s${i + 1}`;
  return i === 0 ? 'prompt' : 'reasons';
}
function stampItem() { // adds the time since the last stamp to the current question
  if (!inRound() || p.state.paused || document.hidden || p.review) { p.item = null; return; }
  const key = itemKeyOf(), t = performance.now();
  if (p.item?.key === key) {
    const meta = (p.draft._meta ||= { t: {}, s: [] });
    meta.t[key] = Math.round((meta.t[key] || 0) + (t - p.item.at));
    p.metaChanged = true; // sent with the next answer change, or within 10 s (see syncTick)
  }
  p.item = { key, at: t };
}
function leaveItem() { // moving on without answering = "passed over"
  stampItem();
  const key = itemKeyOf();
  if (key && !answered(p.qi)) { const meta = (p.draft._meta ||= { t: {}, s: [] }); if (!meta.s.includes(key)) { meta.s.push(key); p.ver++; } }
  p.item = null;
}

// ---------- views ----------
function renderPlay() {
  if (!p.active) return;
  const st = p.state, ph = st.phase;
  if (p.conflict) return view(takeoverView());
  if (st.status === 'waiting') return view(lobbyView());
  if (ph.type === 'done' || ph.type === 'finish') return view(finishView());
  if (ph.type === 'brief') {
    if (p.justDone && p.justDone === ph.round - 1) return view(roundDoneView(p.justDone));
    return view(briefView(ph.round));
  }
  if (ph.type === 'round') {
    if (!st.acks[`r${ph.round}`]) return view(lateStartView(ph.round));
    if (st.round?.submitted || p.content?.submitted) return view(submittedView(ph.round));
    if (!p.content || p.content.round !== ph.round) { loadContent(); return view('<div class="wrap play"><p class="page-head">Opening the round…</p></div>'); }
    return view(roundView());
  }
  return null;
}

function playScene() {
  const st = p.state, ph = st?.phase;
  if (!st || p.conflict) return 'page';
  if (st.status === 'waiting') return 'lobby';
  if (ph.type === 'finish' || ph.type === 'done') return 'finish';
  if (ph.type === 'brief') return p.justDone && p.justDone === ph.round - 1 ? 'done' : 'brief';
  return ph.type === 'round' ? 'round' : 'page';
}
function view(html) {
  const keepScroll = p.content && main.querySelector('.gamebar') && html.includes('gamebar');
  const y = window.scrollY;
  main.innerHTML = html;
  startMascot(main);
  scene(playScene());
  runFx(main);
  const gb = $('.gamebar');
  document.documentElement.classList.toggle('in-round', !!gb);
  syncTopH();
  document.documentElement.style.setProperty('--game-h', `${gb ? gb.offsetHeight : 0}px`);
  updateStatus();
  updateClock();
  const cur = $('.stepdots [aria-current]'); // on a phone the dots scroll sideways: keep the current one in view
  if (cur) { const box = cur.closest('.stepdots'); box.scrollLeft = cur.parentElement.offsetLeft - box.clientWidth / 2 + 18; }
  if (keepScroll) window.scrollTo(0, y); else focusMain();
}

async function loadContent() {
  if (p.loading) return;
  p.loading = true;
  try {
    const c = await api(`/api/play/round?deviceId=${encodeURIComponent(TAB)}`);
    const local = shared.get(localKey(c.round));
    p.content = c;
    p.qi = 0; p.review = false;
    p.draft = c.draft || {};
    if (local && local.at > (c.savedAt || 0) && !c.submitted) { p.draft = local.draft; p.ver++; } // this computer has newer answers (e.g. after going offline)
    p.draft._meta ||= { t: {}, s: [] };
    p.item = null;
    renderPlay();
  } catch (err) {
    if (err.code === 'device') { p.conflict = true; renderPlay(); } else if (err.code !== 'closed') toast(err.message);
  } finally { p.loading = false; }
}

function lobbyView() {
  const s = p.state.student, pf = p.preflight;
  const item = (on, title, text, btn) => `<li><span class="tick ${on ? 'on' : ''}" aria-hidden="true">${on ? '✓' : ''}</span>
    <div><b>${title}</b><div class="muted small">${text}</div></div>${btn || ''}</li>`;
  return `<div class="wrap">
    <div class="page-head"><div class="kicker">Lobby</div><h1>Hi ${esc(s.name.split(' ')[0])}!</h1>
      <p>You’re in. Get set up while you wait — your host starts Promptathon for everyone.</p>
      ${p.state.redoRound ? `<p class="note">Your host reopened <b>Round ${p.state.redoRound} · ${esc(cfg.rounds[p.state.redoRound].name)}</b> for you. You’ll play just that round — your other rounds are kept.</p>` : ''}
      ${p.state.request?.status === 'approved' ? `<p class="note">Your host approved your reattempt.${p.state.request.reply ? ` “${esc(p.state.request.reply)}”` : ''}</p>` : ''}</div>
    <div class="two">
      <div class="card stack">
        <h2>Your details</h2>
        <div><span class="muted">Name</span><br><b style="font-size:1.3rem">${esc(s.name)}</b></div>
        <div class="row"><div><span class="muted">Grade</span><br><b>${s.grade}</b> <span class="muted">(${esc(cfg.bands.find((b) => b.id === s.band)?.label)})</span></div>
          <div><span class="muted">Player code</span><br><b class="code">${esc(s.code)}</b></div></div>
        <div><span class="muted">School</span><br><b>${esc(s.school)}</b></div>
        <div class="small"><span class="muted">Phone</span> <b>${esc(s.phone || '—')}</b>${s.email ? ` · <span class="muted">Email</span> <b>${esc(s.email)}</b>` : ''}</div>
        <button class="btn ghost" data-act="edit-profile">✎ Edit my details</button>
        <p class="small muted" style="margin:0">Fix anything that’s wrong before the test starts. This window is yours and can’t be switched — if it’s the wrong player, ask your host to log you out.</p>
      </div>
      <div class="card stack">
        <h2>Get ready</h2>
        <ul class="checklist">
          ${item(pf.sound, 'Sound', 'The instructions can be read aloud. The words are always on screen too.', `<button class="btn ghost sm" data-act="sound">${pf.sound ? 'Test again' : 'Turn on'}</button>`)}
          ${item(pf.save, 'Saving', pf.save ? 'Connected — your answers save every second.' : 'Checking your connection…')}
          ${item(pf.tools, 'Reading tools', 'Bigger text, dyslexia-friendly font, spacing, read aloud, black & white.', '<button class="btn ghost sm" data-act="settings" data-preflight="1">Adjust</button>')}
        </ul>
        <div class="waiting"><span class="hover-pad" aria-hidden="true"><i class="base"></i><i></i><i class="r2"></i><img src="/foldling.webp" alt=""></span><span>Waiting for your host to start<span class="dots"></span></span></div>
      </div>
    </div>
    <section class="comic-band" aria-label="Comics to read while you wait"><h2 class="center">While you wait — more stories with Foldling</h2>${comic('tiger')}${comic('dog')}</section></div>`;
}

// ---------- before each round: instructions → practice → feedback → Start Round ----------
// Foldling's two comic pages for each round (images in /rounds).
const SLIDES = {
  1: ['Round 1, AI Blitz: a quick quiz round. Read the question, choose your answer, and move to the next one. Answer as many as you can in the given time.',
    'Round 1 example: three sample questions, each with picture options. Read the question and choose the best answer.'],
  2: ['Round 2, Crack the AI Case: an AI answer has a mistake and your mission is to find it. Read the answer, check the clues on the evidence cards, and fix the mistake.',
    'Round 2 example: the AI says a plant died from too much water, but the evidence cards show the soil was dry. Always use evidence.'],
  3: ['Round 3, Match the Output: the answer comes first. Look carefully at the picture, notice the important details, and write a clear prompt that could make something like it.',
    'Round 3 example: a purple octopus in a chef’s hat making pizza in a kitchen. Put the clues together into one prompt. More useful details make a better matching prompt.'],
};
function slides(r) {
  const at = (p.slide ||= {})[r] || 0, n = SLIDES[r].length;
  return `<div class="slides"><div class="slide-page"><img id="slide-img" src="/rounds/${r}-${at + 1}.jpg" alt="${esc(SLIDES[r][at])}"></div>
    <div class="book-nav"><button class="btn ghost" data-act="slide" data-r="${r}" data-d="-1" ${at === 0 ? 'disabled' : ''}>← Previous</button>
      <span class="chip" aria-live="polite">${at + 1} of ${n}</span>
      <button class="btn ghost" data-act="slide" data-r="${r}" data-d="1" ${at === n - 1 ? 'disabled' : ''}>Next →</button></div></div>`;
}
const briefKey = (r) => `pt-brief-${p.state?.attemptId}-${r}`;
const briefStep = (r) => tabStore.get(briefKey(r))?.step || 'how';
const setBrief = (r, patch) => tabStore.set(briefKey(r), { ...(tabStore.get(briefKey(r)) || {}), ...patch });
const isWritten = () => (p.state?.student?.grade || 5) >= 5; // Round 2 step 3: Grades 5–8 write the fix

function briefShell(r, stepNo, inner, aside = '') {
  const R = cfg.rounds[r], minutes = Math.round((p.state.roundSeconds?.[r] || 480) / 60);
  const steps = ['How it works', 'Practice', 'Ready'];
  const clock = `<p class="clock-line"><span aria-hidden="true">⏱</span> Your round clock starts when you press <b>Start Round ${r}</b> — or by itself in <b data-clock>0:00</b>.</p>`;
  const head = `<div class="kicker">Round ${r} of 3 · ${minuteText(minutes)} · ${R.max} points</div>
      <div class="round-title"><h1><span class="round-ico tint-${r}" aria-hidden="true">${R.icon}</span> Round ${r} — ${esc(R.name)}</h1></div>
      <ol class="stepper" aria-label="Getting ready">${steps.map((s, i) => `<li class="${i + 1 < stepNo ? 'done' : i + 1 === stepNo ? 'now' : ''}" ${i + 1 === stepNo ? 'aria-current="step"' : ''}><span>${i + 1 < stepNo ? '✓' : i + 1}</span>${s}</li>`).join('')}</ol>`;
  if (stepNo > 1) return `<div class="wrap"><div class="brief single"><div class="brief-main">${head}${clock}${inner}</div></div></div>`;
  return `<div class="wrap"><div class="brief">
    <div class="brief-main">${head}${inner}</div>
    <aside class="stack">${aside}
      <div class="card paper small-clock"><div class="muted small">Your round clock starts when you press <b>Start Round ${r}</b>.</div>
        <div class="muted small" style="margin-top:6px">If you don’t, it starts by itself in <b data-clock>0:00</b>.</div></div>
    </aside></div></div>`;
}

function briefView(r) {
  const step = briefStep(r), R = cfg.rounds[r], ph = p.state.phase;
  if (step === 'practice' || step === 'feedback') return briefShell(r, 2, practiceView(r, step === 'feedback'));
  if (step === 'ready') {
    return briefShell(r, 3, `<div class="card ready-card">
      <h2>Ready for Round ${r}?</h2>
      <ul class="ready-list"><li>⏱ You have <b>${minuteText(Math.round((p.state.roundSeconds?.[r] || 480) / 60))}</b>. The clock starts when you press the button.</li>
        <li>✅ Answer every question. You can finish early only when everything is answered.</li>
        <li>🛟 Lifelines: ${R.lifelines.map((l) => `<b>${esc(l.name)}</b>`).join(' and ')} — each once, no points lost.</li></ul>
      <p class="note warn" role="note"><b>⚠ Stay in this window.</b> If you switch tabs or open another app during the round, your test is paused until your host lets you back in.</p>
      <label class="check warn-box"><input type="checkbox" id="warn-ok"><span>I understand. I will stay in this window.</span></label>
      <div class="actionbar static"><button class="btn ghost lg" data-act="brief-step" data-r="${r}" data-step="how">← Instructions</button>
        <button class="btn xl" id="ack-btn" data-act="start-round" data-r="${r}" disabled>Start Round ${r} →</button></div></div>`);
  }
  const prev = r > 1 ? p.state.results?.rounds?.[r - 2] : null;
  return briefShell(r, 1, `<div id="rules-text" class="measure">
      ${slides(r)}
      <div class="row between" style="margin-top:4px"><h2 style="margin:0">How it works</h2>${speakBtn('#rules-text', 'Read aloud')}</div>
      ${R.intro.map((t) => `<p class="lead-p">${esc(t)}</p>`).join('')}
      <ol class="rules">${cfg.rules[r].map((x, i) => `<li style="--i:${i}"><span>${esc(x)}</span></li>`).join('')}</ol>
      ${prev?.state === 'scored' ? `<p class="note">Round ${r - 1} is saved — provisional score <b>${prev.total}/${prev.max}</b>.</p>` : ''}
    </div>
    <div class="actionbar static"><span></span><button class="btn xl" data-act="brief-step" data-r="${r}" data-step="practice">Next: try a practice question →</button></div>`,
  ph.script ? `<div class="guide-brief">${mascot('sm')}${narration(ph.script)}</div>` : '');
}

// The practice question (from the demo document). Not scored; the answer is shown after "Check".
function practiceView(r, showing) {
  const P = cfg.practice[r], saved = tabStore.get(briefKey(r)) || {}, a = saved.answer || {};
  const choice = (name, opts, value, disabled, key) => `<div class="opts" role="radiogroup">${opts.map((o) => {
    const mark = showing ? (o.id === key ? ' right' : o.id === value ? ' wrong' : '') : '';
    return `<label class="opt${mark}"><input type="radio" name="${name}" value="${o.id}" data-practice="${name}" ${value === o.id ? 'checked' : ''} ${disabled ? 'disabled' : ''}>
      <span class="key" aria-hidden="true">${o.id}</span><span class="txt">${esc(o.text)}</span>${mark === ' right' ? '<span class="verdict">✓ Correct answer</span>' : mark === ' wrong' ? '<span class="verdict">Your answer</span>' : ''}</label>`;
  }).join('')}</div>`;
  let body = '', result = '';
  if (r === 1) {
    body = `<div class="practice-grid"><figure class="practice-img"><img src="${P.image}" alt="${esc(P.alt)}"></figure>
      <div><p class="qtext">${esc(P.question)}</p>${choice('q', P.options, a.q, showing, P.key)}</div></div>`;
    const right = P.options.find((o) => o.id === P.key);
    if (showing) result = verdict(a.q === P.key, a.q === P.key ? P.feedback : `The clearer prompt is ${P.key}: “${right.text}” ${P.feedback}`);
  } else if (r === 2) {
    const written = isWritten();
    body = `<div class="practice-grid r2"><div><figure class="practice-img"><img src="${P.image}" alt="${esc(P.alt)}"><figcaption>The AI picture</figcaption></figure>
        <div class="cards-row">${P.cards.map((c) => `<div class="fact"><span class="tag">Card ${c.id}</span>${esc(c.text)}</div>`).join('')}</div></div>
      <div class="stack">${P.steps.map((s, i) => {
        const writes = s.id === 'fix' && written;
        return `<div class="pstep"><p class="qtext sm"><span class="n">${i + 1}</span> ${esc(s.label)} — ${esc(writes ? s.written : s.question)}</p>
          ${writes ? `<div class="field"><label for="pr-fix" class="sr-only">Your fix prompt</label><textarea id="pr-fix" data-practice="fix" maxlength="400" rows="3" ${showing ? 'disabled' : ''} placeholder="Edit the kite picture…">${esc(a.fix || '')}</textarea>${showing ? '' : micBtn('#pr-fix')}</div>
            ${showing ? `<p class="note small"><b>Example:</b> “${esc(s.example)}”</p>` : ''}` : choice(s.id, s.options, a[s.id], showing, s.answer)}</div>`;
      }).join('')}</div></div>`;
    if (showing) result = verdict(P.steps.filter((s) => !(s.id === 'fix' && written)).every((s) => a[s.id] === s.answer), P.feedback);
  } else {
    body = `<div class="practice-grid"><figure class="practice-img"><img src="${P.image}" alt="${esc(P.alt)}"></figure>
      <div><p class="qtext">${esc(P.question)}</p><div class="field"><label for="pr-prompt" class="sr-only">Your practice prompt</label>
        <textarea id="pr-prompt" data-practice="prompt" maxlength="800" rows="5" ${showing ? 'disabled' : ''} placeholder="Act as…">${esc(a.prompt || '')}</textarea></div></div></div>`;
    if (showing) {
      const text = String(a.prompt || '').toLowerCase();
      const checks = P.checks.map((c) => ({ ...c, ok: c.any.some((w) => text.includes(w)) }));
      const great = checks.filter((c) => c.ok).length >= 3;
      result = `<div class="feedback-card ${checks.every((c) => c.ok) ? 'good' : ''}" role="status" ${great ? `data-fx="burst" data-fx-key="pr-${p.state?.attemptId}-3"` : ''}>${sprite(great, 'fb-fold')}<h3>${checks.filter((c) => c.ok).length >= 3 ? 'Great prompt! 🎉' : 'Nice try! Here’s how to make it even better.'}</h3>
        <ul class="checks">${checks.map((c) => `<li class="${c.ok ? 'ok' : ''}"><span aria-hidden="true">${c.ok ? '✓' : '•'}</span> ${esc(c.ok ? c.label : c.tip)}</li>`).join('')}</ul>
        <p><b>Example answer:</b> “${esc(P.example)}”</p><p class="muted">${esc(P.feedback)}</p></div>`;
    }
  }
  const ready = practiceAnswered(r, a);
  return `<div class="card practice" id="practice-card">
      <div class="row between"><span class="chip brand">Practice · not scored</span>${speakBtn('#practice-card')}</div>
      ${body}${result}
    </div>
    <div class="actionbar static">
      <button class="btn ghost lg" data-act="brief-step" data-r="${r}" data-step="how">← Instructions</button>
      ${showing ? `<button class="btn xl" data-act="brief-step" data-r="${r}" data-step="ready">I’m ready →</button>`
        : `<button class="btn xl" data-act="practice-check" data-r="${r}" ${ready ? '' : 'disabled'}>Check my answer</button>`}
    </div>`;
}
const verdict = (ok, text) => `<div class="feedback-card ${ok ? 'good' : ''}" role="status" ${ok ? `data-fx="burst" data-fx-key="pr-${p.state?.attemptId}-${p.state?.phase?.round}"` : ''}>${sprite(ok, 'fb-fold')}<h3>${ok ? 'Correct! 🎉' : 'Not quite — that’s okay!'}</h3><p>${esc(text)}</p></div>`;
function practiceAnswered(r, a) {
  if (r === 1) return Boolean(a.q);
  if (r === 2) return Boolean(a.spot && a.evidence && (isWritten() ? String(a.fix || '').trim().length >= 3 : a.fix));
  return String(a.prompt || '').trim().length >= 3;
}

function lateStartView(r) {
  return `<div class="wrap"><div class="card late-card">
    <div class="kicker">Round ${r} · ${esc(cfg.rounds[r].name)}</div><h1>Round ${r} has started</h1>
    <p>Your round clock is running: <b data-clock>0:00</b> left. Press the button when you’re ready.</p>
    <p class="note warn" role="note"><b>⚠ Stay in this window.</b> If you switch tabs or open another app, your test is paused until your host lets you back in.</p>
    <label class="check warn-box"><input type="checkbox" id="warn-ok"><span>I understand. I will stay in this window.</span></label>
    <div class="actionbar static"><span></span><button class="btn xl" id="ack-btn" data-act="start-round" data-r="${r}" disabled>Go to Round ${r} →</button></div></div></div>`;
}

function scoreCards(rounds, { total = null, final = false } = {}) {
  const cell = (r, i) => `<div class="score-card tint-${r.round}" style="--i:${i}"><div class="muted small">Round ${r.round} · ${esc(r.name)}</div>
    <div class="big">${r.state === 'scored' ? `${r.total}<span class="muted small">/${r.max}</span>` : r.state === 'pending' ? '<span class="small">Scoring…</span>' : '—'}</div>
    <div class="small muted">${r.state === 'scored' ? (final ? 'Final' : 'Provisional') : r.state === 'pending' ? 'Checking written answers' : 'Not played'}</div></div>`;
  return `<div class="score-cards">${rounds.map(cell).join('')}${total != null ? `<div class="score-card total" style="--i:${rounds.length}"><div class="muted small">Total</div>
    <div class="big"><span data-fx="count" data-to="${total}" data-fx-key="tot-${p.state?.attemptId}-${total}">${total}</span><span class="muted small">/60</span></div><div class="small muted">${final ? 'Final' : 'Provisional'}</div></div>` : ''}</div>`;
}

// The round's score fills a ring and counts up (once); "Scoring…" spins while written answers are checked.
function scoreRing(res, key, big = false) {
  if (res.state === 'pending') return `<div class="score-ring pending ${big ? 'big' : ''}"><b class="small" style="font-size:1rem">Scoring…</b></div><p class="small muted">Checking written answers</p>`;
  if (res.state !== 'scored') return '';
  const pct = Math.round((res.total / (res.max || 1)) * 100), n = pct >= 80 ? 3 : pct >= 50 ? 2 : 1; // a star for finishing, more for a strong round
  return `<div class="stars" data-fx="stars" data-fx-key="st-${key}" role="img" aria-label="${n} of 3 stars">${[0, 1, 2].map((i) => `<span class="star ${i < n ? 'on' : ''}" style="--i:${i}" aria-hidden="true">★</span>`).join('')}</div>
    <div class="score-ring ${big ? 'big' : ''}" style="--to:${pct}" role="img" aria-label="${res.total} out of ${res.max} points">
      <b data-fx="count" data-to="${res.total}" data-fx-key="n-${key}" aria-hidden="true">0</b><span aria-hidden="true">/${res.max}</span></div>
    <p class="small muted" style="margin:0">${p.state?.final ? 'Final' : 'Provisional'} score</p>`;
}
function roundDoneView(r) {
  const res = p.state.results.rounds[r - 1], next = cfg.rounds[r + 1];
  return `<div class="wrap"><div class="page-head center done-head">
    <div class="card done-card" data-fx="cannon" data-fx-key="done-${p.state.attemptId}-${r}">${sprite(true, 'clear-fold')}
    <div class="kicker">Round ${r} · ${esc(cfg.rounds[r].name)}</div><div class="clear-stamp" aria-hidden="true">Round ${r} clear!</div><h1>Round ${r} done! 🎉</h1>
    <p style="margin:0 auto">Your answers are saved.${res.skipped ? ` ${res.skipped} question${res.skipped === 1 ? ' was' : 's were'} left empty when the time ran out.` : ''}</p>
    ${scoreRing(res, `done-${p.state.attemptId}-${r}`)}</div>
    ${next ? `<div class="row" style="justify-content:center;margin-top:24px"><button class="btn xl" data-act="continue-next">Next: Round ${r + 1} · ${esc(next.name)} →</button></div>
      <p class="small muted" style="margin-top:12px">Take a breath. Round ${r + 1} starts when you press Start — or by itself in <b data-clock>0:00</b>.</p>` : ''}
  </div></div>`;
}

function submittedView(r) {
  return `<div class="wrap"><div class="page-head center done-head">
    <div class="kicker">Round ${r} · ${esc(cfg.rounds[r].name)}</div><h1>Submitted ✓</h1>
    <p>Your answers are locked. Moving on…</p></div></div>`;
}

const FACES = () => cfg.ratings || [];
function feedbackCard(st) {
  if (st.feedback) return `<div class="card feedback-done" role="status"><span class="big-face" aria-hidden="true">💛</span><div><h3 style="margin:0">Thank you for your feedback!</h3><p class="muted" style="margin:0">It helps us make Promptathon better.</p></div></div>`;
  const pick = p.rating || 0;
  return `<form class="card smiley-card" id="feedback-form">
    <h2 id="fb-q">How did you like Promptathon?</h2>
    <div class="faces" role="radiogroup" aria-labelledby="fb-q">${FACES().map((f) => `<label class="face ${pick === f.value ? 'on' : ''}"><input type="radio" name="rating" value="${f.value}" ${pick === f.value ? 'checked' : ''}>
      <span class="emoji" aria-hidden="true">${f.face}</span><span class="face-label">${esc(f.label)}</span></label>`).join('')}</div>
    <div class="field"><label for="fb-text">Tell us more <span class="hint">(optional)</span></label>
      <textarea id="fb-text" name="text" maxlength="1000" rows="3" placeholder="What did you enjoy? What was hard?">${esc(p.feedbackText || '')}</textarea></div>
    <div class="row"><button class="btn lg" ${pick ? '' : 'disabled'} id="fb-send">Send feedback</button></div>
  </form>`;
}

function finishView() {
  const st = p.state, s = st.student;
  const stopped = st.status === 'stopped';
  return `<div class="wrap"><div class="page-head finish-hero" ${stopped ? '' : `data-fx="cannon" data-fx-key="fin-${st.attemptId}"`}>${stopped ? '' : sprite(true, 'dance')}<div>
      <div class="kicker">${stopped ? 'Test ended by host' : 'All three rounds done'}</div>
      <h1>${stopped ? 'Your test has ended' : `You did it, ${esc(s.name.split(' ')[0])}! 🎉`}</h1>
      <p>Your work is saved. ${st.final ? 'These are the final results.' : 'Scores are provisional — final rankings appear after the answers are reviewed.'}</p></div></div>
    ${feedbackCard(st)}
    <h2 style="margin-top:28px">Your scores</h2>
    ${scoreCards(st.results.rounds, { total: st.results.total, final: st.final })}
    ${scorecardBlock(st)}
    <div class="card paper" style="margin-top:20px"><h3>Receipt</h3>
      <p class="small" style="margin:0">${esc(s.name)} · Grade ${s.grade} · ${esc(s.school)} · Code <b class="code">${esc(s.code)}</b></p></div>
    ${reattemptCard(st)}
    <div class="row" style="margin-top:24px"><a class="btn lg" href="#/leaderboard">See the leaderboard</a>
    </div>
    <p class="small muted" style="margin-top:14px">All done! Your host will log you out of this window so the next player can join.</p></div>`;
}

function scorecardBlock(st) {
  if (!['finished', 'stopped'].includes(st.status)) return '';
  if (!st.scorecard) return '<p class="note" style="margin-top:20px">Your score card will appear here once your host has checked and approved it.</p>';
  return `<div class="card paper" style="margin-top:20px"><h3>Your score card is ready</h3>
    <p class="muted" style="margin-top:0">A snapshot of your thinking skills in this challenge.</p>
    <div class="row"><button class="btn" data-act="card-view">View score card</button><button class="btn ghost" data-act="card-pdf">Download PDF</button></div></div>`;
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
    <h1>This test is open in another window</h1>
    <p>To keep things fair, a test runs in one window at a time. Your saved answers are safe and the clock keeps running.</p>
    <button class="btn lg" data-act="takeover">Continue in this window</button>
    <p class="small muted" style="margin-top:14px">This is ${esc(player()?.name || 'your')} test. Only a host can log a player out.</p></div></div>`;
}

// ---------- round screens: one task per screen, big Back / Next, review before submitting ----------
function gamebar(r, progressText, progressPct) {
  const R = cfg.rounds[r], used = p.content.lifelines.used;
  const full = used.length >= cfg.lifelinesPerRound;
  const lifelines = p.review ? '' : R.lifelines.map((l) => {
    const isUsed = used.includes(l.id);
    return `<button class="lifeline ${isUsed ? 'used' : ''}" data-act="lifeline" data-id="${l.id}" ${isUsed || full ? 'disabled' : ''}
      title="${esc(l.desc)}" aria-label="Lifeline: ${esc(l.name)}${isUsed ? ' (used)' : full ? ' (not available)' : ''}">🛟 ${isUsed ? '✓ ' : ''}${esc(l.name)}</button>`;
  }).join('');
  return `<div class="gamebar"><div class="wrap">
      <div class="gb-round"><b>${R.icon} Round ${r}<span class="gb-name"> · ${esc(R.name)}</span></b><span id="gb-progress">${esc(progressText)}</span></div>
      <div id="clock" class="timer" data-clock role="timer" aria-label="Time left in this round">0:00</div>
      <div id="saved" class="saved" aria-live="off"></div>
      <div class="lifelines" role="group" aria-label="Lifelines">${lifelines}</div>
    </div><div class="progress" aria-hidden="true"><i id="gb-bar" style="width:${progressPct}%"></i><img id="gb-rider" class="rider" src="/foldling.webp" alt="" style="left:clamp(12px, ${progressPct}%, calc(100% - 12px))"></div></div>`;
}

function stepsOf() {
  const c = p.content;
  if (c.round === 1) return [...c.view.items, c.view.boss].map((q, i, all) => ({ label: i === all.length - 1 ? 'Final boss' : `Question ${i + 1}`, short: i === all.length - 1 ? 'B' : String(i + 1) }));
  if (c.round === 2) return c.view.steps.map((s) => ({ label: `Step ${s.n} · ${{ spot: 'Spot the mistake', evidence: 'Choose the evidence', fix: 'Fix it' }[s.kind]}`, short: String(s.n) }));
  return c.view.needsReasons ? [{ label: 'Your prompt', short: '1' }, { label: 'Two reasons', short: '2' }] : [{ label: 'Your prompt', short: '1' }];
}
const filled = (v, n = 3) => String(v ?? '').trim().length >= n;
function answered(i) {
  const c = p.content, d = p.draft;
  if (c.round === 1) {
    const all = [...c.view.items, c.view.boss], q = all[i];
    return Boolean(d.answers?.[q.id]) && (i < all.length - 1 || filled(d.bossWhy));
  }
  if (c.round === 2) { const s = c.view.steps[i]; return s.written ? filled(d.fix) : Boolean(d.answers?.[s.n]); }
  return i === 0 ? filled(d.prompt) : filled(d.reasons);
}
function progress() {
  const n = stepsOf().length, done = stepsOf().filter((_, i) => answered(i)).length;
  return [`${done} of ${n} answered`, (done / n) * 100];
}
const missingSteps = () => stepsOf().map((s, i) => ({ ...s, i })).filter((s) => !answered(s.i));

function roundView() {
  const [text, pct] = progress(), c = p.content;
  if (p.review) return `${gamebar(c.round, text, pct)}<div class="wrap play">${reviewView()}</div>`;
  const body = c.round === 1 ? r1View() : c.round === 2 ? r2View() : r3View();
  const steps = stepsOf(), last = p.qi === steps.length - 1;
  return `${gamebar(c.round, text, pct)}<div class="wrap play">${body}</div>
    <nav class="actionbar round-nav" aria-label="Move between questions">
      <button class="btn ghost lg" data-act="goto" data-i="${p.qi - 1}" ${p.qi === 0 ? 'disabled' : ''}>← Back</button>
      <ol class="stepdots">${steps.map((s, i) => `<li><button data-act="goto" data-i="${i}" class="${answered(i) ? 'done' : (p.draft._meta?.s || []).includes(itemKeyOf(i)) ? 'skipped' : ''}" ${i === p.qi ? 'aria-current="step"' : ''}
        aria-label="${esc(s.label)}${answered(i) ? ', answered' : ', not answered'}">${esc(s.short)}</button></li>`).join('')}</ol>
      ${last ? '<button class="btn xl" data-act="review">Check & finish →</button>' : `<button class="btn xl" data-act="goto" data-i="${p.qi + 1}">Next →</button>`}
    </nav>`;
}

function reviewView() {
  const steps = stepsOf(), miss = missingSteps(), r = p.content.round;
  return `<section class="card review-card ${miss.length ? '' : 'all-done'}" aria-labelledby="rv-h">
    <h2 id="rv-h" ${miss.length ? '' : `data-fx="burst" data-fx-key="rv-${p.state.attemptId}-${r}"`}>${miss.length ? 'Almost there!' : 'All done — ready to finish?'}</h2>
    <p class="muted">${miss.length ? `You still have <b>${miss.length}</b> to answer. You can finish the round once every question is answered — or when the time runs out, your answers are submitted for you.`
      : `Every question is answered. Once you finish, you can’t change your answers.`}</p>
    <ul class="review-list">${steps.map((s, i) => `<li class="${answered(i) ? 'ok' : 'todo'}" style="--i:${i}"><span class="rv-mark" aria-hidden="true">${answered(i) ? '✓' : '!'}</span>
      <span class="grow">${esc(s.label)}</span><span class="rv-state">${answered(i) ? 'Answered' : 'Not answered yet'}</span>
      <button class="btn ${answered(i) ? 'ghost' : ''} sm" data-act="goto" data-i="${i}">${answered(i) ? 'Look again' : 'Answer it'}</button></li>`).join('')}</ul>
    <div class="actionbar static">
      <button class="btn ghost lg" data-act="goto" data-i="${miss[0]?.i ?? steps.length - 1}">← ${miss.length ? 'Answer the rest' : 'Back'}</button>
      <button class="btn xl" data-act="submit" ${miss.length ? 'disabled aria-disabled="true"' : ''}>Finish Round ${r} ✓</button>
    </div></section>`;
}

const lifelineNote = (data, label) => (data ? `<p class="note clue" role="note"><b>${esc(label)}:</b> ${esc(data.text)}</p>` : '');
const opts = (q, field, value, hidden = []) => `<div class="opts big" role="radiogroup" aria-labelledby="q-text">${q.options.map((o) => {
  const removed = hidden.includes(o.id);
  return `<label class="opt ${removed ? 'removed' : ''}"><input type="radio" name="q-${esc(field)}" value="${o.id}" data-field="${esc(field)}"
    ${value === o.id ? 'checked' : ''} ${removed ? 'disabled' : ''}><span class="key" aria-hidden="true">${o.id}</span>
    <span class="txt">${esc(o.text)}${removed ? ' <span class="sr-only">(removed by a lifeline)</span>' : ''}</span></label>`;
}).join('')}</div>`;

function r1View() {
  const c = p.content, d = p.draft, items = [...c.view.items, c.view.boss];
  const q = items[p.qi], boss = p.qi === items.length - 1, ll = c.lifelines.data;
  const hidden = ll.fifty?.target === q.id ? ll.fifty.hide : [];
  return `<section class="card qcard" id="q-card" aria-labelledby="q-text">
      <div class="qtype"><span class="chip ${boss ? 'brand' : ''}">${boss ? 'Final boss · 4 points' : `Question ${p.qi + 1} of ${items.length - 1} · ${esc(q.type)}`}</span>${speakBtn('#q-card')}</div>
      <h2 class="qtext" id="q-text" tabindex="-1">${esc(q.question)}</h2>
      ${opts(q, `answers.${q.id}`, d.answers?.[q.id], hidden)}
      ${ll.clue?.target === q.id ? lifelineNote(ll.clue, 'Clue Flash') : ''}
      ${boss ? `<div class="field" style="margin-top:18px"><label for="boss-why">In one sentence, say why this is the best choice <span class="hint">(2 points)</span></label>
        <textarea id="boss-why" data-field="bossWhy" maxlength="1500" rows="3">${esc(d.bossWhy || '')}</textarea>${micBtn('#boss-why')}</div>` : ''}
    </section>`;
}

const pictureBox = (src, alt, label) => `<figure class="target-img"><img src="${esc(src)}" alt="${esc(alt)}">
  <figcaption class="small muted">${esc(label)} <button class="btn ghost sm" data-act="zoom" data-src="${esc(src)}" data-alt="${esc(alt)}">⤢ Make it bigger</button></figcaption></figure>`;

function r2View() {
  const v = p.content.view, d = p.draft, ll = p.content.lifelines.data;
  const i = Math.min(Math.max(p.qi, 0), v.steps.length - 1), s = v.steps[i];
  const hidden = ll.compass?.target === s.n && ll.compass.hide ? ll.compass.hide : [];
  const clue = [ll.compass?.target === s.n && ll.compass.text ? lifelineNote(ll.compass, 'Case Compass') : '', ll.unlock?.target === s.n ? lifelineNote(ll.unlock, 'Unlocked clue') : ''].join('');
  const KIND = { spot: 'Spot the mistake', evidence: 'Choose the evidence', fix: 'Fix it' };
  return `<div class="split">
    <section class="card paper case-file" aria-label="The case">
      <h2 class="case-title">${esc(v.title)}</h2>
      ${pictureBox(v.image, `AI picture: ${v.title}`, 'The AI picture — it has one mistake.')}
      <h3 class="cards-h">Fact cards <span class="muted small">(always right)</span></h3>
      <div class="cards-row">${v.cards.map((c) => `<div class="fact"><span class="tag">Card ${esc(c.id)}</span>${esc(c.text)}</div>`).join('')}</div>
    </section>
    <section class="card qcard step-card" id="q-card" aria-labelledby="q-text">
      <div class="qtype"><span class="chip brand">Step ${s.n} of 3 · ${KIND[s.kind]} · ${s.max} points</span>${speakBtn('#q-card')}</div>
      <h2 class="qtext" id="q-text" tabindex="-1">${esc(s.question)}</h2>
      ${s.written ? `<div class="field"><label for="fix-text" class="sr-only">Your correction prompt</label>
          <textarea id="fix-text" data-field="fix" maxlength="1500" rows="5" placeholder="Edit the picture. Change … to …">${esc(d.fix || '')}</textarea>${micBtn('#fix-text')}
          <span class="hint">Say what to change, and give the correct detail from the fact card.</span></div>`
        : opts(s, `answers.${s.n}`, d.answers?.[s.n], hidden)}
      ${clue}
    </section></div>`;
}

function r3View() {
  const c = p.content, v = c.view, d = p.draft, ll = c.lifelines.data;
  const second = v.needsReasons && p.qi === 1;
  return `<div class="split">
    <section class="card paper case-file" aria-label="The picture">
      <h2 class="case-title">${esc(v.title)}</h2>
      ${pictureBox(v.image, `AI picture: ${v.title}`, 'The AI made this picture.')}
      ${lifelineNote(ll.goal, 'Goal Lens')}${lifelineNote(ll.structure, 'Structure Scan')}
    </section>
    <section class="card qcard step-card" id="q-card" aria-labelledby="q-text">
      <div class="qtype"><span class="chip brand">${second ? 'Step 2 of 2 · Two reasons' : v.needsReasons ? 'Step 1 of 2 · Your prompt' : 'Your prompt · 20 points'}</span>${speakBtn('#q-card')}</div>
      ${second ? `<h2 class="qtext" id="q-text" tabindex="-1">Give two short reasons: how does your prompt match the picture?</h2>
          <details class="your-prompt"><summary>See your prompt</summary><p>${esc(d.prompt || '—')}</p></details>
          <div class="field"><label for="r3-reasons" class="sr-only">Your two reasons</label>
          <textarea id="r3-reasons" data-field="reasons" data-nopaste maxlength="1500" rows="5" placeholder="1. My prompt says … because the picture shows …&#10;2. …">${esc(d.reasons || '')}</textarea></div>`
        : `<h2 class="qtext" id="q-text" tabindex="-1">${esc(v.question)}</h2>
          <div class="field"><label for="r3-prompt" class="sr-only">Your prompt</label>
          <textarea id="r3-prompt" data-field="prompt" data-nopaste rows="8" maxlength="3000" placeholder="Act as a … Create a picture for … Show …">${esc(d.prompt || '')}</textarea>
          <span class="hint">Tip: a role (“Act as…”), who it’s for, the main things, colours, layout and style. Typing only — pasting is off.</span></div>`}
    </section></div>`;
}

// Round 3 answers must be typed (or spoken): no pasting, dropping, cutting or copying in those boxes.
for (const t of ['paste', 'drop', 'copy', 'cut']) document.addEventListener(t, (e) => {
  if (!e.target.closest?.('[data-nopaste]')) return;
  e.preventDefault();
  if (t === 'paste' || t === 'drop') toast('Pasting is switched off in Round 3 — please type your answer.');
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('.zoom')) actions['zoom-close'](); });
document.addEventListener('keydown', (e) => { if (e.shiftKey && e.key === 'Insert' && e.target.closest?.('[data-nopaste]')) e.preventDefault(); });

// draft editing
document.addEventListener('input', (e) => onField(e.target));
document.addEventListener('change', (e) => onField(e.target));
function onField(el) {
  if (el.dataset?.practice) return onPractice(el);
  const field = el.dataset?.field;
  if (!field || !p.active || !p.content) return;
  const [a, b] = field.split(/\.(.+)/);
  if (b) { p.draft[a] = { ...(p.draft[a] || {}) }; p.draft[a][b] = el.value; } else p.draft[a] = el.value;
  p.ver++;
  shared.set(localKey(p.content.round), { at: Date.now(), draft: p.draft });
  const [text, pct] = progress();
  const gp = $('#gb-progress');
  if (gp) gp.textContent = text;
  const bar = $('#gb-bar'), before = parseFloat(bar?.style.width) || 0;
  if (bar) bar.style.width = `${pct}%`;
  moveRider(pct, pct > before);
  $$('.stepdots button')[p.qi]?.classList.toggle('done', answered(p.qi));
  if (answered(p.qi)) $$('.stepdots button')[p.qi]?.classList.remove('skipped');
  updateStatus();
}
function onPractice(el) {
  const r = p.state?.phase?.round;
  if (!r) return;
  const saved = tabStore.get(briefKey(r)) || {};
  const answer = { ...(saved.answer || {}), [el.dataset.practice]: el.value };
  setBrief(r, { answer });
  const btn = $('[data-act="practice-check"]');
  if (btn) btn.disabled = !practiceAnswered(r, answer);
}

// ---------------------------------------------------------------- actions
const actions = {
  rules: rulesDialog,
  settings: (el) => { if (el.dataset.preflight && p.active) { p.preflight.tools = true; p.lastKey = ''; renderPlay(); } settingsDialog(); },
  speak: (el) => {
    if (el.getAttribute('aria-pressed') === 'true') { speech.stop(); return; }
    const t = $(el.dataset.target);
    if (t) speech.speak(t, el);
  },
  mic: (el) => (el.getAttribute('aria-pressed') === 'true' ? stopMic() : startMic(el)),
  account: (el) => {
    const m = $('#account-menu');
    m.hidden = !m.hidden;
    el.setAttribute('aria-expanded', String(!m.hidden));
  },
  logout: async () => {
    await api('/auth/logout', {});
    me = { signedIn: false };
    location.hash = '#/';
  },
  'join-back': () => { // step 2 → step 1, keeping what was typed
    const f = $('#join-2');
    if (f) Object.assign(join.data, { phone: String(new FormData(f).get('phone') || ''), email: String(new FormData(f).get('email') || ''), consent: new FormData(f).get('consent') === 'on' });
    join.step = 1; join.error = '';
    joinPage();
  },
  'edit-profile': () => editProfile(),
  'cookie-ok': () => { shared.set('pt-cookie-notice', '1'); $('#cookie-bar')?.remove(); },
  'lock-request': async () => {
    try { applyState(await api('/api/play/lock-request', { note: $('#lock-note')?.value || '' })); } catch (err) { toast(err.message); }
  },
  sound: () => {
    p.audioOn = true;
    p.preflight.sound = true;
    prefs.narration = true;
    tabStore.set(PREFS_KEY, prefs);
    speech.speak('Sound is on. The instructions can be read aloud. Good luck!');
    p.lastKey = '';
    renderPlay();
  },
  slide: (el) => {
    const r = el.dataset.r, d = Number(el.dataset.d);
    p.slide[r] = Math.min(SLIDES[r].length - 1, Math.max(0, (p.slide[r] || 0) + d));
    $('.slides').outerHTML = slides(r);
    $(`.slides [data-d="${d}"]:not([disabled])`)?.focus();
  },
  zoom: (el) => { // the picture opens over the test, in this tab: a new tab would count as leaving the window
    const ov = document.createElement('div');
    ov.className = 'overlay zoom';
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-label', 'Picture, full size');
    ov.innerHTML = `<button class="zoom-x" data-act="zoom-close" aria-label="Close the picture and go back to the test">✕</button><img src="${esc(el.dataset.src)}" alt="${esc(el.dataset.alt)}">`;
    document.body.append(ov);
    ov.querySelector('button').focus();
  },
  'zoom-close': () => { $('.zoom')?.remove(); $('[data-act="zoom"]')?.focus(); },
  'brief-step': (el) => {
    const r = Number(el.dataset.r), step = el.dataset.step;
    setBrief(r, { step });
    speech.stop(); stopMic();
    p.lastKey = ''; renderPlay();
    $('h1, h2')?.focus?.();
  },
  'practice-check': (el) => {
    const r = Number(el.dataset.r), saved = tabStore.get(briefKey(r)) || {}, a = saved.answer || {}, P = cfg.practice[r];
    const correct = r === 1 ? a.q === P.key : r === 2 ? P.steps.filter((s) => !(s.id === 'fix' && isWritten())).every((s) => a[s.id] === s.answer) : null;
    setBrief(r, { step: 'feedback' });
    api('/api/play/practice', { round: r, answer: a, correct }).catch(() => {});
    p.lastKey = ''; renderPlay();
    announce(correct === false ? 'Not quite. Read the feedback.' : 'Read the feedback.');
    $('#practice-card .feedback-card')?.scrollIntoView({ block: 'center', behavior: reduced() ? 'auto' : 'smooth' });
  },
  'start-round': async (el) => {
    const r = Number(el.dataset.r);
    el.disabled = true; el.textContent = 'Starting…';
    if (p.state?.phase?.type === 'brief') await countdown(r);
    try {
      const st = await api('/api/play/start-round', { deviceId: TAB, round: r });
      p.justDone = null; p.qi = 0; p.review = false; p.lastKey = '';
      applyState(st);
      syncLoop();
    } catch (err) { toast(err.message); el.disabled = false; el.textContent = `Start Round ${r} →`; }
  },
  'continue-next': () => { p.justDone = null; p.lastKey = ''; renderPlay(); },
  takeover: async () => {
    try {
      const st = await api('/api/play/takeover', { deviceId: TAB });
      p.conflict = false; p.content = null; p.lastKey = '';
      applyState(st);
      syncLoop();
    } catch (err) { toast(err.message); }
  },
  goto: (el) => {
    const i = Number(el.dataset.i), n = stepsOf().length;
    if (i < 0 || i >= n) return;
    if (!p.review && i !== p.qi) leaveItem();
    const from = p.review ? -1 : p.qi;
    p.qi = i; p.review = false;
    speech.stop(); stopMic();
    view(roundView());
    if (i !== from) $('.qcard')?.classList.add(i > from ? 'enter-fwd' : 'enter-back');
    stampItem();
    $('#q-text')?.focus?.();
  },
  review: () => {
    leaveItem();
    p.review = true;
    speech.stop(); stopMic();
    view(roundView());
    $('#rv-h')?.focus?.();
    syncTick();
  },
  lifeline: async (el) => {
    const c = p.content, R = cfg.rounds[c.round], l = R.lifelines.find((x) => x.id === el.dataset.id);
    let target = null, body = `<p>${esc(l.desc)}</p>`;
    if (c.round === 1) {
      const items = [...c.view.items, c.view.boss];
      target = items[p.qi].id;
      body += `<p>It will be used on <b>${p.qi === items.length - 1 ? 'the final boss' : `question ${p.qi + 1}`}</b>.</p>`;
    } else if (c.round === 2) {
      target = c.view.steps[p.qi].n;
      body += `<p>It will be used on <b>Step ${target}</b>.</p>`;
    }
    body += '<p class="muted small">Each lifeline can be used once in this round. It costs no points.</p>';
    if (await dialog({ title: `Use ${l.name}?`, body, actions: [{ label: 'Not now', value: 'no', kind: 'ghost' }, { label: `Use ${l.name}`, value: 'yes' }] }) !== 'yes') return;
    try {
      c.lifelines = await api('/api/play/lifeline', { deviceId: TAB, id: l.id, target });
      view(roundView());
      $('.qcard')?.classList.add('zap');
      const btn = $(`.lifeline[data-id="${l.id}"]`);
      btn?.classList.add('just-used');
      burstAt(btn, { n: 26, speed: 7, gravity: 0.12, life: 60, size: 7, shapes: ['star'], colors: ['#ffd23f', '#e8682a', '#fff1c1'] });
      announce(`${l.name} used.`);
    } catch (err) { toast(err.message); }
  },
  submit: async (el) => {
    const c = p.content, miss = missingSteps();
    if (miss.length) { toast(`Answer every question first: ${miss.map((m) => m.label).join(', ')}.`); return; }
    const ok = await dialog({ title: `Finish Round ${c.round}?`,
      body: `<p>Your answers will be locked. ${c.round < 3 ? `Next comes Round ${c.round + 1}.` : 'Then you’re done!'}</p>`,
      actions: [{ label: 'Keep checking', value: 'no', kind: 'ghost' }, { label: `Finish Round ${c.round}`, value: 'yes' }] });
    if (ok !== 'yes') return;
    el.disabled = true;
    try {
      p.submittedHere = true;
      const st = await api('/api/play/submit', { deviceId: TAB, round: c.round, draft: p.draft });
      shared.del(localKey(c.round));
      c.submitted = true;
      p.ackVer = p.ver;
      p.lastKey = '';
      applyState(st);
    } catch (err) {
      p.submittedHere = false;
      el.disabled = false;
      if (err.code === 'incomplete' && err.missing?.length) { p.review = true; view(roundView()); }
      toast(err.message);
    }
  },
  'request-reattempt': async () => {
    const ok = await dialog({ title: 'Request a reattempt', body: `<p>Your host will review your request. You will see their answer on this page.</p>
      <div class="field"><label for="rq-note">Why do you need another try? <span class="hint">(optional)</span></label>
      <textarea id="rq-note" maxlength="500" placeholder="For example: my internet dropped during Round 2."></textarea></div>`,
      actions: [{ label: 'Cancel', value: 'no', kind: 'ghost' }, { label: 'Send request', value: 'yes' }] });
    if (ok !== 'yes') return;
    try {
      const st = await api('/api/play/reattempt-request', { note: $('#rq-note').value });
      p.lastKey = '';
      applyState(st);
      toast('Request sent to your host.');
    } catch (err) { toast(err.message); }
  },
  'card-view': async () => {
    try { const url = URL.createObjectURL(await apiBlob('/api/play/scorecard')); window.open(url, '_blank', 'noopener'); } catch (err) { toast(err.message); }
  },
  'card-pdf': async (el) => {
    el.disabled = true; el.textContent = 'Preparing…';
    try {
      const url = URL.createObjectURL(await apiBlob('/api/play/scorecard.pdf'));
      const a = Object.assign(document.createElement('a'), { href: url, download: `Promptathon score card - ${player()?.name || 'player'}.pdf` });
      document.body.append(a); a.click(); a.remove();
    } catch (err) { toast(err.message); } finally { el.disabled = false; el.textContent = 'Download PDF'; }
  },
};

// A host logged this window out (or its login is gone): clear everything of this player and show the join page again.
function sessionEnded() {
  stopPlay();
  stopMic();
  for (const r of [1, 2, 3]) tabStore.del(`pt-brief-${p.state?.attemptId}-${r}`);
  setPlayer(null);
  prefs = { ...DEFAULTS }; tabStore.del(PREFS_KEY); applyPrefs();
  Object.assign(p, { state: null, content: null, celebrated: {} });
  $$('.overlay').forEach((o) => o.remove());
  main.inert = false;
  renderShell();
  if (location.hash === '#/lobby') route(); else location.hash = '#/lobby';
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!e.target.closest('.account')) { const m = $('#account-menu'); if (m) m.hidden = true; }
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el); }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'warn-ok') $('#ack-btn').disabled = !e.target.checked;
  if (e.target.name === 'rating' && e.target.closest('#feedback-form')) {
    p.rating = Number(e.target.value);
    $$('#feedback-form .face').forEach((f) => f.classList.toggle('on', f.querySelector('input').checked));
    $('#fb-send').disabled = false;
  }
});
document.addEventListener('input', (e) => { if (e.target.id === 'fb-text') p.feedbackText = e.target.value; });
document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'feedback-form') return;
  e.preventDefault();
  const btn = $('#fb-send');
  btn.disabled = true; btn.textContent = 'Sending…';
  try {
    const st = await api('/api/play/feedback', { rating: p.rating, text: $('#fb-text').value });
    p.lastKey = ''; applyState(st);
    burstAt($('.feedback-done'), { n: 40, speed: 9, gravity: 0.18, shapes: ['heart'], colors: ['#e8682a', '#ff7a8a', '#ffd23f', '#f4a26b'] });
    toast('Thank you for your feedback!');
  } catch (err) { toast(err.message); btn.disabled = false; btn.textContent = 'Send feedback'; }
});

window.addEventListener('hashchange', route);

// ---------------------------------------------------------------- test guard (proctoring)
// While a test is live: no copying, cutting, pasting, dragging, printing or right-click menus, the page hides itself when the window
// loses focus or a screenshot key is pressed, and leaving the window during a round pauses the clock until the host lets the student back in.
// A browser cannot stop a screenshot taken by the operating system or another device; these are deterrents, and every page carries the student's code.
const guarding = () => document.documentElement.classList.contains('guard');
for (const t of ['copy', 'cut', 'paste', 'drop', 'dragstart', 'contextmenu']) document.addEventListener(t, (e) => {
  if (!guarding()) return;
  e.preventDefault();
  if (t === 'paste' || t === 'drop') toast('Pasting is switched off during the test — please type or speak your answer.');
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
  if (!p.active || p.leaving || st?.status !== 'running' || st.phase?.type !== 'round' || st.round?.submitted) return;
  if (!document.hidden && (document.hasFocus() || Date.now() < (p.micUntil || 0))) return; // a microphone prompt is not leaving
  p.leaving = true;
  try { applyState(await api('/api/play/leave', { deviceId: TAB })); } catch { /* the next sync will show the real state */ } finally { p.leaving = false; }
}
document.addEventListener('visibilitychange', () => { clearTimeout(leaveTimer); stampItem(); if (document.hidden) leaveTimer = setTimeout(checkLeave, 300); });
addEventListener('blur', () => { if (guarding() && Date.now() >= (p.micUntil || 0)) document.documentElement.classList.add('shield'); clearTimeout(leaveTimer); leaveTimer = setTimeout(checkLeave, 900); });
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
// Players get no cookies at all; hosts get one to stay signed in. The browser remembers reading settings per window.
function cookieNotice() {
  if (shared.get('pt-cookie-notice') || $('#cookie-bar')) return;
  const bar = document.createElement('div');
  bar.id = 'cookie-bar'; bar.className = 'cookie-bar'; bar.setAttribute('role', 'region'); bar.setAttribute('aria-label', 'Cookie notice');
  bar.innerHTML = `<p>🍪 Players get no cookies. Hosts get one small cookie to stay signed in. Your browser keeps your answers as a backup while you play. No ads, no tracking. <a href="#/legal/cookies">Cookie policy</a> · <a href="#/legal/privacy">Privacy policy</a></p>
    <button class="btn sm" data-act="cookie-ok">Got it</button>`;
  document.body.append(bar);
}

// ---------------------------------------------------------------- Foldling FX: origami meets hologram
// A sky of paper shards behind every page, Foldling moments (player card, "let's go", 3-2-1 countdown), paper confetti, a progress-bar
// rider and small sparkles on every pick. Canvas confetti and full-screen moments are skipped for prefers-reduced-motion;
// CSS animations stop there too (see styles.css). Nothing here ever blocks the test: moments are short and a tap skips them.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const FX_COLORS = ['#e8682a', '#f4a26b', '#ffd23f', '#bf4b11', '#ffe1c4', '#0f5a8a', '#1b6f45'];
const sprite = (happy = false, cls = 'sprite') => `<img class="${cls}" src="/foldling${happy ? '-happy' : ''}.webp" alt="" aria-hidden="true" draggable="false">`;
const portal = (inner, cls = '') => `<div class="portal ${cls}" aria-hidden="true"><i class="ring r1"></i><i class="ring r2"></i><i class="orbit"><b></b><b></b><b></b></i>${inner}<i class="pad"></i></div>`;
const letters = (word, splitAt = 6) => [word.slice(0, splitAt), word.slice(splitAt)].map((part, k) => `<span class="nw">${[...part].map((ch, i) => `<span class="l" style="--i:${i + k * splitAt}">${ch}</span>`).join('')}</span>`).join('&shy;');
const scene = (name) => { document.documentElement.dataset.scene = name; };

function sky() {
  if ($('#fx-sky')) return;
  const el = document.createElement('div');
  el.id = 'fx-sky';
  el.setAttribute('aria-hidden', 'true');
  const shards = Array.from({ length: 14 }, (_, i) => { const d = 16 + ((i * 7) % 15); return `<i class="shard s${i % 4}" style="--x:${(i * 71 + 7) % 100}%;--d:${d}s;--s:${10 + ((i * 9) % 26)}px;--delay:-${((i * 3.7) % d).toFixed(1)}s;--r:${(i * 47) % 360}deg"></i>`; }).join('');
  el.innerHTML = `<div class="aurora a1"></div><div class="aurora a2"></div><div class="aurora a3"></div><div class="grid-floor"></div>${shards}`;
  document.body.prepend(el);
}

// Paper confetti: triangles that flip in the air like folded paper, little stars and hearts.
const fxc = { canvas: null, ctx: null, parts: [], raf: 0 };
function fxCanvas() {
  if (fxc.canvas?.isConnected) return fxc;
  const c = document.createElement('canvas');
  c.id = 'fx-canvas';
  c.setAttribute('aria-hidden', 'true');
  document.body.append(c);
  fxc.canvas = c; fxc.ctx = c.getContext('2d');
  const size = () => { const r = Math.min(2, devicePixelRatio || 1); c.width = innerWidth * r; c.height = innerHeight * r; fxc.ctx.setTransform(r, 0, 0, r, 0, 0); };
  size();
  addEventListener('resize', size);
  return fxc;
}
function burst(x, y, { n = 50, speed = 11, spread = Math.PI * 2, angle = -Math.PI / 2, gravity = 0.3, shapes = ['tri', 'tri', 'tri', 'sq', 'star'], colors = FX_COLORS, life = 95, size = 9 } = {}) {
  return; // confetti is switched off
  const f = fxCanvas(), bw = document.documentElement.dataset.theme === 'bw';
  for (let i = 0; i < n && f.parts.length < 600; i++) {
    const a = angle + (Math.random() - 0.5) * spread, v = speed * (0.45 + Math.random() * 0.8);
    f.parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, g: gravity, rot: Math.random() * 6.3, vr: (Math.random() - 0.5) * 0.3, flip: Math.random() * 6.3,
      vf: 0.08 + Math.random() * 0.16, s: size * (0.6 + Math.random() * 0.8), c: bw ? ['#111', '#666', '#aaa'][i % 3] : colors[(Math.random() * colors.length) | 0],
      shape: shapes[(Math.random() * shapes.length) | 0], t: 0, life: life * (0.7 + Math.random() * 0.6) });
  }
  if (!f.raf) f.raf = requestAnimationFrame(fxTick);
}
function fxTick() {
  const f = fxc, g = f.ctx;
  g.clearRect(0, 0, innerWidth, innerHeight);
  f.parts = f.parts.filter((q) => q.t < q.life);
  for (const q of f.parts) {
    q.t++; q.vy += q.g; q.vx *= 0.985; q.vy *= 0.985; q.x += q.vx; q.y += q.vy; q.rot += q.vr; q.flip += q.vf;
    const s = q.s;
    g.save();
    g.globalAlpha = Math.min(1, (q.life - q.t) / 25);
    g.translate(q.x, q.y); g.rotate(q.rot); g.scale(Math.cos(q.flip), 1);
    g.fillStyle = q.c;
    g.beginPath();
    if (q.shape === 'tri') { // a folded paper triangle: two tones, split down the fold
      g.moveTo(0, -s); g.lineTo(s * 0.9, s * 0.7); g.lineTo(-s * 0.9, s * 0.7); g.closePath(); g.fill();
      g.fillStyle = 'rgba(255,255,255,.38)'; g.beginPath(); g.moveTo(0, -s); g.lineTo(s * 0.9, s * 0.7); g.lineTo(0, s * 0.7); g.closePath();
    } else if (q.shape === 'star') {
      for (let k = 0; k < 8; k++) { const r = k % 2 ? s * 0.38 : s; g.lineTo(Math.cos((k * Math.PI) / 4) * r, Math.sin((k * Math.PI) / 4) * r); }
      g.closePath();
    } else if (q.shape === 'heart') {
      g.moveTo(0, s * 0.35); g.bezierCurveTo(-s, -s * 0.3, -s * 0.45, -s, 0, -s * 0.45); g.bezierCurveTo(s * 0.45, -s, s, -s * 0.3, 0, s * 0.35);
    } else g.rect(-s / 2, -s * 0.3, s, s * 0.6);
    g.fill();
    g.restore();
  }
  if (f.parts.length) f.raf = requestAnimationFrame(fxTick);
  else { g.clearRect(0, 0, innerWidth, innerHeight); f.raf = 0; }
}
const burstAt = (el, opts) => { // from the element's centre, kept on screen
  const r = el?.getBoundingClientRect?.();
  if (r) burst(Math.min(innerWidth - 40, Math.max(40, r.left + r.width / 2)), Math.min(innerHeight - 60, Math.max(60, r.top + r.height / 2)), opts);
};
function cannon() { // two waves from the bottom corners
  const go = (k) => {
    burst(0, innerHeight, { n: 70, speed: 22, angle: -Math.PI / 3, spread: 0.7, gravity: 0.38, life: 130 });
    burst(innerWidth, innerHeight, { n: 70, speed: 22, angle: (-2 * Math.PI) / 3, spread: 0.7, gravity: 0.38, life: 130 });
    if (k) setTimeout(() => burst(innerWidth / 2, innerHeight * 0.3, { n: 60, speed: 12, life: 110 }), 350);
  };
  go(0); setTimeout(() => go(1), 650);
}
function countUp(el, to, ms = 1200) {
  to = Number(to) || 0;
  if (reduced() || !to) { el.textContent = to; return; }
  const t0 = performance.now();
  const step = (t) => { const k = Math.min(1, (t - t0) / ms); el.textContent = Math.round(to * (1 - (1 - k) ** 3)); if (k < 1 && el.isConnected) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
// Effects declared in the markup: data-fx="burst | cannon | count", once per data-fx-key.
function runFx(root = main) {
  p.fxDone ||= new Set();
  for (const el of root.querySelectorAll('[data-fx]')) {
    const key = el.dataset.fxKey, kind = el.dataset.fx;
    if (key && p.fxDone.has(key)) { if (kind === 'count') el.textContent = el.dataset.to; continue; }
    if (key) p.fxDone.add(key);
    if (kind === 'count') countUp(el, el.dataset.to);
    else if (kind === 'cannon') setTimeout(cannon, Number(el.dataset.delay) || 300);
    else if (kind === 'burst') setTimeout(() => burstAt(el, { n: 60, speed: 12 }), Number(el.dataset.delay) || 300);
    else if (kind === 'stars') el.querySelectorAll('.star.on').forEach((st, i) => setTimeout(() => burstAt(st, { n: 22, speed: 7, gravity: 0.15, life: 55, size: 8, shapes: ['star'], colors: ['#ffc531', '#ffe08a', '#e8682a'] }), 1700 + i * 350));
  }
}

// Full-screen moments. Resolve when finished; a tap or Esc skips.
function moment(html, { ms = 2200, cls = '' } = {}) {
  if (reduced()) return Promise.resolve();
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = `fx-moment ${cls}`;
    ov.setAttribute('role', 'status');
    ov.innerHTML = `<div class="fx-rays" aria-hidden="true"></div>${html}`;
    document.body.append(ov);
    let done = false;
    const end = () => { if (done) return; done = true; ov.classList.add('out'); setTimeout(() => { ov.remove(); resolve(); }, 380); };
    ov.addEventListener('click', end);
    ov.end = end;
    setTimeout(end, ms);
  });
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $$('.fx-moment').forEach((m) => m.end?.()); });
// Sci-fi read-out: each letter flickers through random ones, then locks in, left to right.
function decode(el, delay = 0) {
  const text = el.textContent, pool = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const t0 = performance.now() + delay;
  const step = (t) => {
    if (!el.isConnected) return;
    const k = t - t0;
    el.textContent = [...text].map((ch, i) => (ch === '-' || k > 260 + i * 110 ? ch : k < 0 && i > 2 ? '·' : pool[(Math.random() * pool.length) | 0])).join('');
    if (k < 260 + text.length * 110) requestAnimationFrame(step); else el.textContent = text;
  };
  requestAnimationFrame(step);
}
function playerCard(st, back = false) {
  setTimeout(() => burst(innerWidth / 2, innerHeight / 2, { n: 110, speed: 16 }), 1700); // as the stamp lands
  const shown = moment(`<div class="fx-card-wrap"><div class="fx-card"><div class="fx-card-shine"></div>
      <div class="kicker">${back ? 'Welcome back, player' : 'New player unlocked'}</div><b class="fx-card-name">${esc(st.name)}</b><span class="fx-card-grade">Grade ${esc(st.grade)}</span>
      <div class="fx-card-code">${esc(st.code)}</div><small>${back ? 'Good to see you again!' : 'This is your player code — remember it!'}</small>
      <div class="fx-stamp">${back ? 'BACK!' : 'READY!'}</div></div>${sprite(true, 'fx-fly')}</div>`, { ms: back ? 3000 : 3800, cls: 'fx-player' });
  const code = $('.fx-player .fx-card-code');
  if (code) decode(code, 650);
  return shown;
}
function gameOn(r = 1) {
  setTimeout(() => burst(innerWidth / 2, innerHeight * 0.42, { n: 100, speed: 16 }), 700);
  return moment(`<div class="fx-warp" aria-hidden="true"></div><div class="fx-go">${sprite(true, 'fx-zoom')}<h2 class="fx-big">Promptathon is starting!</h2><p>First up: Round ${r} · ${esc(cfg.rounds[r].name)}</p></div>`, { ms: 2600, cls: 'fx-gameon' });
}
// The last round is in: fireworks, Foldling zooms in and the total counts up.
function finale(st) {
  if (reduced()) return Promise.resolve();
  const scored = st.results.rounds.every((r) => r.state === 'scored');
  for (let i = 0; i < 7; i++) setTimeout(() => burst(innerWidth * (0.12 + Math.random() * 0.76), innerHeight * (0.12 + Math.random() * 0.3), { n: 70, speed: 9, gravity: 0.1, life: 95, shapes: ['star', 'tri', 'sq'] }), 350 + i * 400);
  const shown = moment(`<div class="fx-warp" aria-hidden="true"></div><div class="fx-go">${sprite(true, 'fx-zoom')}<div class="kicker">Mission complete</div><h2 class="fx-big">All 3 rounds done!</h2>
    ${scored ? `<p class="fx-total"><b>0</b><span>/60</span></p>` : '<p>Your answers are in — great work!</p>'}</div>`, { ms: 4200, cls: 'fx-gameon fx-finale' });
  const n = $('.fx-finale .fx-total b');
  if (n) setTimeout(() => countUp(n, st.results.total, 1600), 900);
  return shown;
}
async function countdown(r) {
  if (reduced()) return;
  const R = cfg.rounds[r];
  const ov = document.createElement('div');
  ov.className = 'fx-moment fx-count';
  ov.setAttribute('role', 'status');
  ov.innerHTML = `<div class="fx-rays" aria-hidden="true"></div><div class="fx-count-top"><span class="round-ico tint-${r}" aria-hidden="true">${R.icon}</span> Round ${r} · ${esc(R.name)}</div>
    <i class="fx-dial" aria-hidden="true"></i><b class="fx-num" aria-live="assertive"></b>${sprite(false, 'fx-fold')}<p class="fx-count-sub">Your clock starts on GO!</p>`;
  document.body.append(ov);
  const num = ov.querySelector('.fx-num'), fold = ov.querySelector('.fx-fold'), dial = ov.querySelector('.fx-dial');
  for (const n of ['3', '2', '1', 'GO!']) {
    num.textContent = n;
    num.classList.remove('pop'); fold.classList.remove('hop'); dial.classList.remove('run'); void num.offsetWidth;
    num.classList.add('pop'); fold.classList.add('hop'); num.classList.toggle('go', n === 'GO!');
    if (n === 'GO!') { dial.classList.add('full'); ov.insertAdjacentHTML('afterbegin', '<div class="fx-warp" aria-hidden="true"></div>'); } else dial.classList.add('run');
    const ring = document.createElement('i'); ring.className = 'fx-ring'; ov.append(ring); setTimeout(() => ring.remove(), 900);
    if (n === 'GO!') { fold.src = '/foldling-happy.webp'; burst(innerWidth / 2, innerHeight * 0.46, { n: 110, speed: 19, life: 48, gravity: 0.2 }); } // gone before the question shows
    await sleep(n === 'GO!' ? 700 : 640);
  }
  ov.classList.add('out');
  setTimeout(() => ov.remove(), 380);
}

// Tap Foldling and he jumps; tap him five times quickly for a secret somersault.
const POKE = '.portal, .hover-pad, .clear-fold, .finish-hero .dance, .fb-fold, .join .mascot, .welcome-guide .mascot, .guide-brief .mascot';
let pokes = { n: 0, at: 0 };
document.addEventListener('pointerdown', (e) => {
  const host = e.target.closest?.(POKE);
  if (!host || guarding() && document.documentElement.classList.contains('in-round')) return;
  const el = host.matches('.portal, .hover-pad') ? host.querySelector('.mascot, .sprite, img') : host;
  if (!el) return;
  pokes = Date.now() - pokes.at < 900 ? { n: pokes.n + 1, at: Date.now() } : { n: 1, at: Date.now() };
  const big = pokes.n >= 5;
  if (big) pokes.n = 0;
  el.classList.remove('poked', 'flip'); void el.offsetWidth; el.classList.add(big ? 'flip' : 'poked');
  setTimeout(() => el.classList.remove('poked', 'flip'), 1200);
  burst(e.clientX, e.clientY, big ? { n: 80, speed: 13 } : { n: 14, speed: 6, gravity: 0.15, life: 55, size: 7, shapes: ['star', 'tri'] });
});

// A ripple and a few sparkles on every pick (answers, grade tiles, smileys).
let lastPtr = null;
document.addEventListener('pointerdown', (e) => { lastPtr = { x: e.clientX, y: e.clientY, t: Date.now() }; }, true);
document.addEventListener('change', (e) => {
  const opt = e.target.closest?.('.opt, .grade-opt, .face');
  if (!opt || e.target.type !== 'radio' || !e.target.checked) return;
  const host = opt.matches('.grade-opt') ? opt.querySelector('span') : opt, r = host.getBoundingClientRect();
  const pt = lastPtr && Date.now() - lastPtr.t < 800 ? lastPtr : { x: r.left + Math.min(40, r.width / 2), y: r.top + r.height / 2 };
  const rip = document.createElement('span');
  rip.className = 'ripple';
  rip.style.left = `${pt.x - r.left}px`; rip.style.top = `${pt.y - r.top}px`;
  host.append(rip);
  setTimeout(() => rip.remove(), 700);
  const face = opt.matches('.face');
  burst(pt.x, pt.y, { n: face ? 16 : 12, speed: 5.5, gravity: 0.12, life: 50, size: face ? 8 : 6, shapes: face ? ['heart'] : ['tri', 'star'], colors: face ? ['#e8682a', '#ff7a8a', '#ffd23f'] : FX_COLORS });
});

// Foldling rides the round's progress bar and hops when another question is answered.
function moveRider(pct, hop) {
  const rider = $('#gb-rider');
  if (!rider) return;
  rider.style.left = `clamp(12px, ${pct}%, calc(100% - 12px))`;
  if (hop) { rider.classList.remove('hop'); void rider.offsetWidth; rider.classList.add('hop'); const r = rider.getBoundingClientRect(); burst(r.left + r.width / 2, r.top + 8, { n: 10, speed: 4, gravity: 0.15, life: 40, size: 6, shapes: ['star'] }); }
}

// ---------------------------------------------------------------- boot
applyPrefs();
sky();
try {
  cfg = await api('/api/config');
  route();
  cookieNotice();
} catch {
  main.innerHTML = '<div class="wrap"><p class="note bad" style="margin-top:32px">Promptathon can’t reach the server right now. Please refresh in a moment.</p></div>';
}
export const getCtx = () => ({ cfg, me });
