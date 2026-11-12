// Load + chaos test: N simulated students play the whole Promptathon against a running server, while an admin
// pauses, closes and reopens the event, adds time, and some students close their tab, open a second one or leave the window.
// Every response is checked: a student must only ever see their own identity and their own grade band's questions.
//
//   node scripts/stress.mjs --base http://localhost:3999 --key <TEST_ADMIN_KEY> --users 100 --round-min 2 [--pid <server pid>] [--out report.json]
// The server must run with TEST_ADMIN_KEY set (and, for a safe run, DATA_STORE=memory or GOOGLE_API_BASE pointing at scripts/mock-google.mjs).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', 'http://localhost:3999'), KEY = arg('key', 'test'), N = Number(arg('users', 100)), ROUND_MIN = Number(arg('round-min', 2));
const PID = arg('pid', ''), OUT = arg('out', ''), TOKENS_OUT = arg('tokens-out', ''), PRACTICE_SEC = Number(arg('practice-sec', 90));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const t0 = Date.now(), at = () => ((Date.now() - t0) / 1000).toFixed(1);
const log = (...x) => console.log(`[${at()}s]`, ...x);

// ---------- metrics ----------
const lat = new Map(), errors = new Map(), failures = [], events = [];
let requests = 0;
const note = (k, ms) => { if (!lat.has(k)) lat.set(k, []); lat.get(k).push(ms); };
const bad = (k) => errors.set(k, (errors.get(k) || 0) + 1);
const violation = (msg) => { failures.push(`[${at()}s] ${msg}`); console.error('✗', msg); };
const pct = (xs, p) => { const v = [...xs].sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))] : null; };
const samples = [];

// Plain http(s) with keep-alive connections, like a browser (Node's fetch adds artificial delays on some systems).
const agents = { 'http:': new http.Agent({ keepAlive: true, maxSockets: 512 }), 'https:': new https.Agent({ keepAlive: true, maxSockets: 512 }) };
function request(path, { method, headers, body }) {
  const u = new URL(BASE + path), lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(u, { method, headers, agent: agents[u.protocol], timeout: 20000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function call(path, { method, body, player, cookie, name, expect, hold } = {}) {
  if (hold) { while (hold.frozen) await sleep(100); player = hold.token; } // a bot whose window is being replaced waits, then uses its new login
  const t = performance.now();
  requests++;
  const label = name || path.split('?')[0].replace(/\/(st_|at_)[\w-]+/, '/:id').replace(/\/api\/img\/[^?]+/, '/api/img/:id');
  let res, data;
  try {
    const payload = body ? JSON.stringify(body) : undefined;
    res = await request(path, { method: method || (body ? 'POST' : 'GET'), body: payload,
      headers: { ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...(player ? { 'x-player': player } : {}), ...(cookie ? { cookie } : {}) } });
    data = String(res.headers['content-type'] || '').includes('json') ? JSON.parse(res.buf.toString() || '{}') : { bytes: res.buf.length };
  } catch (err) {
    note(label, performance.now() - t); bad(`${label} network:${err.message}`);
    return { ok: false, status: 0, data: { error: err.message } };
  }
  note(label, performance.now() - t);
  const ok = res.status >= 200 && res.status < 300;
  if (!ok && !(expect || []).includes(res.status)) bad(`${label} ${res.status}${data?.code ? `:${data.code}` : ''}`);
  return { ok, status: res.status, data, headers: { get: (k) => [].concat(res.headers[k.toLowerCase()] || []).join(', ') } };
}

// ---------- admin ----------
let adminCookie = '';
async function admin(path, body, method) { return call(path, { body, method, cookie: adminCookie, name: `admin ${path.split('?')[0]}` }); }

// ---------- a student ----------
const BAND = (g) => (g <= 4 ? 'G3-4' : g <= 6 ? 'G5-6' : 'G7-8');
const PREFIX = { 'G3-4': 'G34', 'G5-6': 'G56', 'G7-8': 'G78' };
const FIRST = ['Aarav', 'Diya', 'Kabir', 'Ira', 'Vihaan', 'Anaya', 'Reyansh', 'Myra', 'Arjun', 'Sara', 'Advik', 'Kiara', 'Ishaan', 'Aadhya', 'Rohan', 'Meera', 'Dev', 'Tara', 'Neel', 'Zoya'];
const LAST = ['Sharma', 'Reddy', 'Iyer', 'Khan', 'Patel', 'Rao', 'Das', 'Nair', 'Gupta', 'Singh'];

class Bot {
  constructor(i, schools) {
    this.i = i; this.grade = 3 + (i % 6); this.band = BAND(this.grade);
    this.name = `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]} ${i}`;
    this.school = schools[i % schools.length]; this.phone = `98${String(10000000 + i).padStart(8, '0')}`;
    this.tab = `tab-${i}-${Math.random().toString(36).slice(2, 8)}`;
    this.slow = i % 10 === 0; // ~10% think slowly and are cut off by the timer
    this.draft = {}; this.round = 0; this.done = false; this.stats = { syncs: 0, submits: 0, incompleteRejected: 0, lifelines: 0, codeLogins: 0, takeovers: 0 };
  }
  async register() {
    const r = await call('/api/register', { body: { name: this.name, grade: this.grade, schoolId: this.school, phone: this.phone, email: this.i % 3 ? `p${this.i}@example.com` : '', consent: true } });
    if (!r.ok) throw new Error(`register failed ${r.status} ${r.data.error}`);
    this.token = r.data.token; this.id = r.data.student.id; this.code = r.data.student.code;
    return r.data;
  }
  async login(code = this.code) { // coming back after a host logout: just the player code (any capitals, with or without "BZ-")
    const r = await call('/api/login', { body: { code } });
    if (!r.ok) throw new Error(`login failed ${r.status} ${r.data.error}`);
    if (r.data.student.id !== this.id || r.data.student.code !== this.code) violation(`${this.name}: logging in with the code gave another player (${r.data.student.code})`);
    this.token = r.data.token;
    this.stats.codeLogins++;
    return r.data;
  }
  check(st, where) { // the response must be about this student and their own grade band
    if (!st?.student) return;
    if (st.student.id !== this.id) violation(`${this.name}: ${where} returned another student (${st.student.name})`);
    if (st.student.band !== this.band) violation(`${this.name}: ${where} band ${st.student.band} ≠ ${this.band}`);
  }
  async sync(extra = {}) {
    const body = { deviceId: this.tab, ...extra };
    const r = await call('/api/play/sync', { body, hold: this, expect: [423, 409] });
    this.stats.syncs++;
    if (r.status === 423) { this.closedSeen = true; return null; }
    if (r.status === 409 && r.data.code === 'device') { // another tab took over: this tab takes it back (like pressing "Continue here")
      const t = await call('/api/play/takeover', { body: { deviceId: this.tab }, hold: this });
      this.stats.takeovers++;
      return t.ok ? t.data : null;
    }
    if (r.ok) { this.check(r.data, 'sync'); this.state = r.data; }
    return r.ok ? r.data : null;
  }
  async content() {
    const r = await call(`/api/play/round?deviceId=${encodeURIComponent(this.tab)}`, { hold: this, expect: [409, 423] });
    if (!r.ok) return null;
    const c = r.data;
    if (c.band !== this.band) violation(`${this.name}: round ${c.round} content band ${c.band} ≠ ${this.band}`);
    const ids = c.round === 1 ? [...c.view.items, c.view.boss].map((q) => q.id) : [];
    for (const id of ids) if (!id.startsWith(PREFIX[this.band])) violation(`${this.name}: got question ${id} from another grade band`);
    if (c.view.image) {
      const img = await call(c.view.image, { name: '/api/img/:id' });
      if (!img.ok || !img.data.bytes) violation(`${this.name}: picture for round ${c.round} did not load (${img.status})`);
    }
    return c;
  }
  // Answers one item, keeps track of time per item, saves through sync (like the browser does every second).
  async answerRound(c) {
    const r = c.round, think = () => sleep(this.slow ? rnd(9000, 16000) : rnd(1500, 6000));
    const d = this.draft = { _meta: { t: {}, s: [] } };
    const touch = (key, ms) => { d._meta.t[key] = (d._meta.t[key] || 0) + ms; };
    const items = r === 1 ? [...c.view.items.map((q) => ({ key: q.id, q })), { key: c.view.boss.id, q: c.view.boss, boss: true }]
      : r === 2 ? c.view.steps.map((s) => ({ key: `s${s.n}`, s })) : [{ key: 'prompt' }, ...(c.view.needsReasons ? [{ key: 'reasons' }] : [])];
    // a few students skip the second item first and come back to it (recorded as "passed over")
    const order = this.i % 7 === 0 && items.length > 2 ? [items[0], items[2], items[1], ...items.slice(3)] : items;
    if (order !== items) d._meta.s.push(items[1].key);
    let tried = false;
    for (const it of order) {
      if (this.state?.round?.submitted || this.cut) return;
      const s = Date.now();
      await think();
      if (r === 1) { (d.answers ||= {})[it.key] = pick(it.q.options).id; if (it.boss) d.bossWhy = 'Because it keeps the good part and fixes the problem for the reader.'; }
      if (r === 2) { if (it.s.written) d.fix = 'Edit the poster. Change the wrong detail so it matches the fact card exactly.'; else (d.answers ||= {})[it.s.n] = pick(it.s.options).id; }
      if (r === 3) { if (it.key === 'prompt') d.prompt = 'Act as a cartoon illustrator. Create a bright poster for Grade 5 students showing the main objects in the centre, blue sky background, simple style, no extra words.'; else d.reasons = 'My prompt matches because it names the same objects and the same colours as the picture.'; }
      touch(it.key, Date.now() - s);
      const st = await this.sync({ round: r, draft: d });
      if (st?.saved && !st.saved.ok && !/paused|not running|submitted|Time is up/i.test(st.saved.reason)) violation(`${this.name}: autosave refused: ${st.saved.reason}`);
      // try lifelines sometimes
      if (Math.random() < 0.15) {
        const id = pick(c.view && r === 1 ? ['fifty', 'clue'] : r === 2 ? ['compass', 'unlock'] : ['goal', 'structure']);
        const lr = await call('/api/play/lifeline', { body: { deviceId: this.tab, id, target: r === 1 ? it.key : r === 2 ? it.s.n : null }, hold: this, expect: [400, 409, 423] });
        if (lr.ok) this.stats.lifelines++;
      }
      // early submit while unfinished must be refused
      if (!tried && it !== order.at(-1) && Math.random() < 0.3) {
        tried = true;
        const sr = await call('/api/play/submit', { body: { deviceId: this.tab, round: r, draft: d }, hold: this, expect: [409, 423] });
        if (sr.ok) violation(`${this.name}: round ${r} was accepted while unfinished`);
        else if (sr.data.code === 'incomplete') this.stats.incompleteRejected++;
      }
    }
    if (this.slow) return; // slow students let the timer submit for them
    for (let k = 0; k < 5; k++) {
      const sr = await call('/api/play/submit', { body: { deviceId: this.tab, round: r, draft: d }, hold: this, expect: [409, 423] });
      if (sr.ok) { this.stats.submits++; this.check(sr.data, 'submit'); this.state = sr.data; return; }
      if (sr.status === 423 || sr.data.code === 'device') { await sleep(3000); continue; }
      if (sr.data.code === 'incomplete') { violation(`${this.name}: complete round ${r} refused: ${sr.data.error}`); return; }
      if (/no longer open|No round is open/i.test(sr.data.error || '')) return; // the timer got there first
      await sleep(1500);
    }
  }
  async play() {
    // lobby
    while (!this.done) {
      const st = await this.sync();
      if (st && st.status !== 'waiting') break;
      await sleep(2000);
    }
    let lastPhase = '';
    while (!this.done) {
      const st = this.state;
      const ph = st?.phase || {};
      const key = `${st?.status}|${ph.key || ph.type}`;
      if (key !== lastPhase) { lastPhase = key; }
      if (!st || st.status === 'paused' || this.closedSeen) {
        if (st?.lock && !st.lock.requested) await call('/api/play/lock-request', { body: { note: 'My little brother closed the window' }, hold: this, expect: [423] });
        this.closedSeen = false; await sleep(1500); await this.sync(); continue;
      }
      if (['finished', 'stopped'].includes(st.status) || ph.type === 'done' || ph.type === 'finish') {
        await sleep(rnd(1000, 4000));
        const fb = await call('/api/play/feedback', { body: { rating: 1 + (this.i % 5), text: this.i % 2 ? 'It was fun! The pictures were cool.' : '' }, hold: this, expect: [409, 423] });
        if (!fb.ok && fb.status !== 423) violation(`${this.name}: feedback refused ${fb.status} ${fb.data.error}`);
        const lb = await call('/api/leaderboard', { hold: this, expect: [423] });
        if (lb.ok) { // a player sees the board of their own band only, never other players' codes, and at most one row marked as themselves
          if (lb.data.rows.some((r) => 'code' in r)) violation(`${this.name}: the leaderboard showed other players' codes`);
          if (lb.data.rows.some((r) => BAND(r.grade) !== this.band)) violation(`${this.name}: the leaderboard showed another grade band`);
          if (lb.data.rows.filter((r) => r.me).length > 1) violation(`${this.name}: more than one leaderboard row marked as me`);
        }
        this.done = true; this.finishedAt = Date.now();
        break;
      }
      if (ph.type === 'brief') {
        await sleep(rnd(4000, 15000)); // reads the instructions, tries the practice question
        await call('/api/play/practice', { body: { round: ph.round, answer: 'B', correct: Math.random() < 0.7 }, hold: this, expect: [423] });
        const r = await call('/api/play/start-round', { body: { deviceId: this.tab, round: ph.round }, hold: this, expect: [409, 423] });
        if (r.ok) { this.check(r.data, 'start-round'); this.state = r.data; } else await this.sync();
        continue;
      }
      if (ph.type === 'round') {
        if (!st.acks?.[`r${ph.round}`]) await call('/api/play/start-round', { body: { deviceId: this.tab, round: ph.round }, hold: this, expect: [409, 423] });
        if (!st.round?.submitted) {
          const c = await this.content();
          if (c && !c.submitted) {
            this.round = c.round;
            const ticker = setInterval(() => { this.sync({ round: c.round, draft: this.draft }).catch(() => {}); }, 1000); // autosave heartbeat
            try { await this.answerRound(c); } finally { clearInterval(ticker); }
          }
        }
        await sleep(this.slow ? 2000 : 1000);
        await this.sync();
        continue;
      }
      await sleep(1000); await this.sync();
    }
  }
}

// ---------- server resource sampling ----------
function sampleServer() {
  if (!PID) return null;
  try {
    const [cpu, rss] = execFileSync('ps', ['-o', '%cpu=,rss=', '-p', PID]).toString().trim().split(/\s+/).map(Number);
    return { cpu, rssMb: Math.round(rss / 1024) };
  } catch { return null; }
}

// ---------- the run ----------
async function main() {
  log(`Stress test: ${N} students against ${BASE}, rounds of ${ROUND_MIN} min`);
  const login = await call('/auth/test-admin', { body: { key: KEY } });
  if (!login.ok) throw new Error('Admin test sign-in failed — start the server with TEST_ADMIN_KEY.');
  adminCookie = login.headers.get('set-cookie').split(';')[0];

  // set up: close, timing, schools
  await admin('/api/admin/gate', { open: false });
  await admin('/api/admin/timing', { minutes: { 1: ROUND_MIN, 2: ROUND_MIN, 3: ROUND_MIN }, seconds: { brief: PRACTICE_SEC, finish: 10 } });
  let ov = (await admin('/api/admin/overview')).data;
  for (const name of ['Green Valley School', 'Sunrise Public School', 'Lakeview Academy']) if (!ov.schools.some((s) => s.name === name)) await admin('/api/admin/schools', { name });
  ov = (await admin('/api/admin/overview')).data;
  const schools = ov.schools.map((s) => s.id);

  // closed means closed — for every student API, called directly
  const fake = 'st_fake.sig';
  for (const [path, body] of [['/api/register', { name: 'X' }], ['/api/play', null], ['/api/play/sync', { deviceId: 'x' }], ['/api/play/start-round', { round: 1 }],
    ['/api/play/round?deviceId=x', null], ['/api/play/submit', { round: 1 }], ['/api/play/feedback', { rating: 5 }], ['/api/leaderboard', null], ['/api/img/x?e=1&s=1', null]]) {
    const r = await call(path, { body, player: fake, expect: [423], name: `closed ${path.split('?')[0]}` });
    if (r.status !== 423 || r.data.code !== 'closed') violation(`closed gate: ${path} answered ${r.status}`);
  }
  log('Closed gate: every student API answered 423 closed ✓');
  await admin('/api/admin/gate', { open: true });

  // registration wave (everyone within ~20 s, like a lab full of children)
  const bots = Array.from({ length: N }, (_, i) => new Bot(i, schools));
  const regStart = Date.now();
  await Promise.all(bots.map(async (b) => { await sleep(rnd(0, 20000)); await b.register(); }));
  log(`Registered ${N} in ${((Date.now() - regStart) / 1000).toFixed(1)} s`);
  // Joining is always a brand-new player: typing someone's exact details makes a new player with a new code — it never opens their seat.
  const extras = [];
  for (const b of bots.slice(0, 5)) {
    const again = await call('/api/register', { body: { name: b.name, grade: b.grade, schoolId: b.school, phone: b.phone, email: b.i % 3 ? `p${b.i}@example.com` : '', consent: true } });
    if (!again.ok || again.data.student?.id === b.id || again.data.student?.code === b.code || again.data.returning) violation(`retyping ${b.name}'s details did not make a new player (${again.status})`);
    else extras.push(again.data.student.id);
    const still = await call('/api/play', { player: b.token });
    if (still.data.student?.id !== b.id) violation(`${b.name}: the original player was disturbed by a same-details join`);
  }
  log(`Same details typed again by 5 players → ${extras.length} new players, new codes ✓`);
  // A player code only opens a free seat, and wrong codes get nowhere.
  const busy = await call('/api/login', { body: { code: bots[5].code }, expect: [409] });
  if (busy.status !== 409 || busy.data.code !== 'already-in' || busy.data.token) violation(`logging in with the code of a player who is still in was not refused (${busy.status})`);
  for (const bad of ['BZ-ZZZZZ', 'hello', '']) {
    const r = await call('/api/login', { body: { code: bad }, expect: [400, 404] });
    if (![400, 404].includes(r.status) || r.data.token) violation(`bad code "${bad}" answered ${r.status}`);
  }
  const another = await call('/api/play', { player: bots[0].token });          // a token only ever answers for its own player
  if (another.data.student?.id !== bots[0].id) violation('a token answered for another player');
  const forged = await call('/api/play', { player: `${bots[1].id}.${999}.forgedsignature`, expect: [401] });
  if (forged.status !== 401) violation(`a forged token was accepted (${forged.status})`);
  const asAdmin = await call('/api/admin/overview', { player: bots[0].token, expect: [401] });
  if (asAdmin.status !== 401) violation(`a player token opened the host dashboard (${asAdmin.status})`);
  // Lobby edits: a player fixes their own details; they can't take another player's details; the host sees the change.
  for (const b of bots.slice(6, 9)) {
    await call('/api/play', { hold: b });
    const e = await call('/api/play/profile', { hold: b, body: { name: `${b.name} Jr`, grade: b.grade, schoolId: b.school, phone: b.phone, email: `edited${b.i}@example.com` } });
    if (!e.ok || e.data.student?.name !== `${b.name} Jr`) violation(`${b.name}: lobby edit failed (${e.status} ${e.data.error})`);
    else b.name = `${b.name} Jr`;
  }
  // Details are just details: a player whose details match someone else's is still only themselves.
  const twin = await call('/api/play/profile', { hold: bots[6], body: { name: bots[9].name, grade: bots[9].grade, schoolId: bots[9].school, phone: bots[9].phone } });
  if (!twin.ok || twin.data.student?.id !== bots[6].id || twin.data.student?.code !== bots[6].code) violation(`editing into matching details changed who the player is (${twin.status})`);
  else Object.assign(bots[6], { name: bots[9].name, grade: bots[9].grade, band: BAND(bots[9].grade), school: bots[9].school, phone: bots[9].phone });
  // The host logs a few waiting players out; each comes back with their player code (typed in different ways): same player, new login.
  const lobbyOut = bots.slice(0, 5), oldTokens = lobbyOut.map((b) => b.token);
  const lo = await admin('/api/admin/logout', { studentIds: lobbyOut.map((b) => b.id) });
  if (lo.data.done !== 5) violation(`host logout of 5 waiting players did ${lo.data.done}`);
  const typed = (c, i) => [c, c.toLowerCase(), c.slice(3), ` ${c.replace('-', ' ')} `, c.slice(3).toLowerCase()][i % 5];
  for (const [i, b] of lobbyOut.entries()) {
    const dead = await call('/api/play', { player: oldTokens[i], expect: [401] });
    if (dead.status !== 401 || dead.data.code !== 'logged-out') violation(`${b.name}: old login still worked after host logout (${dead.status})`);
    await b.login(typed(b.code, i));
    const again = await call('/api/login', { body: { code: b.code }, expect: [409] }); // a second window can't use the code while they're in
    if (again.status !== 409) violation(`${b.name}: their code worked twice (${again.status})`);
    const back = await call('/api/play', { player: b.token });
    if (back.data.student?.id !== b.id || back.data.status !== 'waiting') violation(`${b.name}: back in the lobby check failed (${back.data.status})`);
  }
  log('Host logout → code login (5 players, 5 ways of typing the code) → same player, back in the lobby ✓');

  const playing = bots.map((b) => b.play().catch((err) => violation(`${b.name} crashed: ${err.stack}`)));
  await sleep(5000);
  ov = (await admin('/api/admin/overview')).data;
  const inLobby = ov.students.filter((s) => s.status === 'waiting').length;
  log(`In lobby: ${inLobby}/${N}`);
  const start = await admin('/api/admin/control', { action: 'start', studentIds: bots.map((b) => b.id), questions: 'new' });
  log(`Admin pressed Start: ${start.data.done} started, ${start.data.skipped} skipped ${start.data.errors?.join('; ') || ''}`);
  const startedAt = Date.now();

  // chaos timeline (seconds after Start)
  const chaos = [
    [35, 'Leave window: 3 students switch tabs mid-round', async () => { for (const b of bots.slice(10, 13)) await call('/api/play/leave', { body: { deviceId: b.tab }, player: b.token }); await sleep(8000);
      const o = (await admin('/api/admin/overview')).data; const locked = o.students.filter((s) => s.lock).map((s) => s.id);
      await admin('/api/admin/control', { action: 'resume', studentIds: locked }); events.push(`resumed ${locked.length} locked students`); }],
    [50, 'Duplicate tab: 3 students open a second tab', async () => { for (const b of bots.slice(20, 23)) { const r = await call('/api/play/sync', { body: { deviceId: `${b.tab}-copy` }, player: b.token, expect: [409] }); if (r.status !== 409 || r.data.code !== 'device') violation(`second tab for ${b.name} was not stopped (${r.status})`); } }],
    [70, 'Admin pauses everyone for 10 s', async () => { await admin('/api/admin/control', { action: 'pause', studentIds: bots.map((b) => b.id) }); await sleep(10000); await admin('/api/admin/control', { action: 'resume', studentIds: bots.map((b) => b.id) }); }],
    [45, 'Edits are locked once the test has started', async () => { for (const b of bots.slice(6, 9)) { const e = await call('/api/play/profile', { hold: b, body: { name: 'Sneaky Change', grade: b.grade, schoolId: b.school, phone: b.phone }, expect: [409] }); if (e.status !== 409 || e.data.code !== 'locked') violation(`${b.name}: an edit after the start was allowed (${e.status})`); } }],
    [100, 'Window lost: 4 players are logged out by the host mid-round and come back with their player code', async () => {
      // four players who are really in the middle of a round (the quick ones may already be finished by now)
      const now = (await admin('/api/admin/overview')).data.students;
      const midRound = (x) => x?.status === 'running' && ['round', 'brief'].includes(x.phase?.type) && x.phase.remainingMs > 15000; // not about to finish
      const lost = bots.slice(30, 70).filter((b) => midRound(now.find((x) => x.id === b.id))).slice(0, 4);
      if (lost.length < 4) violation(`only ${lost.length} players were mid-round to log out`);
      lost.forEach((b) => { b.frozen = true; }); await sleep(500);          // their windows are gone
      const old = lost.map((b) => b.token);
      for (const b of lost) { const t = await call('/api/login', { body: { code: b.code }, expect: [409] }); if (t.status !== 409 || t.data.code !== 'already-in') violation(`${b.name}: their code worked while still logged in (${t.status})`); }
      const lo = await admin('/api/admin/logout', { studentIds: lost.map((b) => b.id) }); events.push(`host logout: ${lo.data.done} out, ${lo.data.paused} tests paused`);
      if (lo.data.done !== lost.length || lo.data.paused !== lost.length) violation(`mid-round logout: ${lo.data.done} out, ${lo.data.paused} paused, expected ${lost.length} of each`);
      const r0 = await admin('/api/admin/control', { action: 'resume', studentIds: lost.map((b) => b.id) });
      if (r0.data.done !== 0) violation(`resume restarted ${r0.data.done} logged-out players`);
      for (const [i, b] of lost.entries()) {
        const dead = await call('/api/play/sync', { player: old[i], body: { deviceId: b.tab }, expect: [401] });
        if (dead.status !== 401 || dead.data.code !== 'logged-out') violation(`${b.name}: old login still worked (${dead.status})`);
        b.tab = `tab-${b.i}-new`; await b.login();
        const st = await call('/api/play', { player: b.token });   // back on their test: paused, "Welcome back", answers kept
        if (st.data.status !== 'paused' || st.data.lock?.reason !== 'logout') violation(`${b.name}: after the code login the test was ${st.data.status} / ${st.data.lock?.reason}`);
        const ask = await call('/api/play/lock-request', { player: b.token, body: { note: 'My window closed, can I continue?' } });
        if (!ask.ok) violation(`${b.name}: asking to continue failed (${ask.status})`);
      }
      const asked = (await admin('/api/admin/overview')).data.students.filter((x) => lost.some((b) => b.id === x.id) && x.lock?.requested).length;
      events.push(`${asked} asked to continue`);
      if (asked !== lost.length) violation(`only ${asked} of ${lost.length} requests to continue reached the host`);
      const r1 = await admin('/api/admin/control', { action: 'resume', studentIds: lost.map((b) => b.id) }); events.push(`resumed ${r1.data.done} after they logged in with their code`);
      if (r1.data.done !== lost.length) violation(`only ${r1.data.done} of ${lost.length} resumed`);
      lost.forEach((b) => { b.frozen = false; }); }],
    [130, 'Admin CLOSES Promptathon for 15 s mid-test', async () => {
      const r = await admin('/api/admin/gate', { open: false }); events.push(`closing paused ${r.data.paused} running tests`);
      const probe = await call('/api/play/sync', { body: { deviceId: bots[0].tab }, player: bots[0].token, expect: [423] });
      if (probe.status !== 423) violation('a student API worked while closed');
      await sleep(15000);
      const o = await admin('/api/admin/gate', { open: true }); events.push(`reopening resumed ${o.data.resumed} tests`);
      if (o.data.resumed !== r.data.paused) violation(`closing paused ${r.data.paused} but reopening resumed ${o.data.resumed}`); }],
    [170, 'Admin adds 1 minute for 10 students', async () => { const r = await admin('/api/admin/phase-time', { action: 'extend', target: 'current', seconds: 60, studentIds: bots.slice(40, 50).map((b) => b.id) }); events.push(`added time for ${r.data.done}`); }],
  ];
  const chaosRuns = chaos.map(async ([sec, label, fn]) => { await sleep(sec * 1000 - (Date.now() - startedAt)); log(`CHAOS: ${label}`); events.push(`${at()}s ${label}`); try { await fn(); } catch (err) { violation(`chaos "${label}" failed: ${err.message}`); } });

  // admin keeps its dashboard open (polls every 2 s), like a real host
  let adminPolling = true;
  const adminLoop = (async () => { while (adminPolling) { await admin('/api/admin/overview'); const s = sampleServer(); if (s) samples.push({ t: Number(at()), ...s }); await sleep(2000); } })();

  await Promise.all([...playing, ...chaosRuns]);
  const playSeconds = (Date.now() - startedAt) / 1000;
  log(`All ${N} students finished in ${playSeconds.toFixed(0)} s`);

  // end-state checks
  for (let i = 0; i < 30; i++) { // the last players may still be on the 10-second finish screen: wait for the server to mark them finished
    await sleep(1000);
    ov = (await admin('/api/admin/overview')).data;
    if (ov.students.filter((s) => bots.some((b) => b.id === s.id)).every((s) => ['finished', 'stopped'].includes(s.status))) break;
  }
  await sleep(2000);
  ov = (await admin('/api/admin/overview')).data;
  const mine = ov.students.filter((s) => bots.some((b) => b.id === s.id));
  const notDone = mine.filter((s) => !['finished', 'stopped'].includes(s.status));
  if (notDone.length) violation(`${notDone.length} students did not finish: ${notDone.map((s) => `${s.name}:${s.status}`).join(', ')}`);
  const unscored = mine.filter((s) => !s.scores || s.scores.some((x) => !x));
  if (unscored.length) violation(`${unscored.length} students are missing a round score`);
  const noFeedback = mine.filter((s) => !s.feedback);
  if (noFeedback.length) violation(`${noFeedback.length} students have no feedback saved`);
  const details = await Promise.all(bots.slice(0, 12).map((b) => admin(`/api/admin/students/${b.id}`)));
  let timed = 0, skippedRecorded = 0;
  for (const d of details) for (const a of d.data.attempts) for (const x of a.answers) { if (x.timeSec != null) timed++; if (x.skipped) skippedRecorded++; }
  const slowSkips = bots.filter((b) => b.slow).length;
  // score cards: every finished student's card has a skill profile that includes Rounds 2 and 3
  const cardList = (await admin('/api/admin/scorecards')).data.rows.filter((c) => bots.some((b) => b.id === c.studentId));
  let cardsChecked = 0;
  for (const c of cardList.slice(0, 20)) {
    const d = (await admin(`/api/admin/scorecard/${c.attemptId}/data`)).data;
    const ev = Object.fromEntries(d.card.skills.map((k) => [k.id, k.evidence]));
    if (!(ev.S04 && ev.S05 && ev.S06 && ev.S02 && ev.S03)) violation(`${c.name}: score card is missing Round 2/3 skills (${JSON.stringify(ev)})`);
    cardsChecked++;
  }
  if (cardList.length < N) violation(`only ${cardList.length} score cards for ${N} students`);
  // a host corrects a Round 2 and a Round 3 mark: the totals follow
  const fixMe = (await admin(`/api/admin/students/${bots[1].id}`)).data.attempts[0];
  for (const r of [2, 3]) {
    const parts = Object.fromEntries((fixMe.parts[r] || []).map((p) => [p.key, p.max]));
    if (!Object.keys(parts).length || Object.keys(parts).some((k) => k === 'undefined')) { violation(`round ${r} has no editable parts`); continue; }
    const r2 = await admin('/api/admin/scores', { attemptId: fixMe.id, round: r, parts });
    if (!r2.ok) violation(`saving round ${r} marks failed`);
  }
  const fixed = (await admin(`/api/admin/students/${bots[1].id}`)).data.attempts[0];
  for (const r of [2, 3]) { const t = Object.values(fixed.scores[r].parts).reduce((s, p) => s + (p.points || 0), 0); if (t !== 20) violation(`round ${r} total after full marks is ${t}, not 20`); }
  const timing = {};
  for (const [label, path] of [['analytics', '/api/admin/analytics'], ['Excel report (all schools)', '/api/admin/export.xlsx'], ['students CSV', '/api/admin/students.csv'], ['score cards list', '/api/admin/scorecards'], ['feedback list', '/api/admin/feedback']]) {
    const s = performance.now(); const r = await admin(path); timing[label] = { ms: Math.round(performance.now() - s), status: r.status, bytes: r.data.bytes };
    if (!r.ok) violation(`${label} failed: ${r.status}`);
  }
  adminPolling = false; await adminLoop;

  // ---------- report ----------
  const endpoints = [...lat].map(([k, v]) => ({ endpoint: k, count: v.length, p50: Math.round(pct(v, 50)), p95: Math.round(pct(v, 95)), p99: Math.round(pct(v, 99)), max: Math.round(Math.max(...v)) }))
    .sort((a, b) => b.count - a.count);
  const totalSec = (Date.now() - t0) / 1000;
  const report = {
    users: N, roundMinutes: ROUND_MIN, durationSec: Math.round(totalSec), playSec: Math.round(playSeconds), requests, avgRps: Math.round(requests / totalSec),
    violations: failures, unexpectedErrors: Object.fromEntries(errors), events,
    students: { finished: mine.length - notDone.length, slowCutByTimer: slowSkips, incompleteSubmitsRefused: bots.reduce((s, b) => s + b.stats.incompleteRejected, 0),
      lifelinesUsed: bots.reduce((s, b) => s + b.stats.lifelines, 0), codeLogins: bots.reduce((s, b) => s + b.stats.codeLogins, 0), sameDetailJoins: extras.length, takeovers: bots.reduce((s, b) => s + b.stats.takeovers, 0),
      answersWithTime: timed, skippedRecorded, scoreCardsChecked: cardsChecked },
    adminDownloads: timing, endpoints,
    server: samples.length ? { peakCpu: Math.max(...samples.map((s) => s.cpu)), avgCpu: Math.round(samples.reduce((t, s) => t + s.cpu, 0) / samples.length), peakRssMb: Math.max(...samples.map((s) => s.rssMb)), samples: samples.length } : null,
  };
  console.log('\n===== RESULT =====');
  console.log(JSON.stringify({ ...report, endpoints: endpoints.slice(0, 14) }, null, 2));
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
  if (TOKENS_OUT) fs.writeFileSync(TOKENS_OUT, JSON.stringify(bots.slice(40, 44).map((b) => ({ id: b.id, token: b.token, code: b.code, name: b.name, grade: b.grade, schoolId: b.school, phone: b.phone }))));
  process.exit(failures.length ? 1 : 0);
}
main().catch((err) => { console.error(err); process.exit(2); });
