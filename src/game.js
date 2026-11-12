// Game engine: the open/closed gate, students, attempts, the server-side clock, admin controls, results and exports.
//
// Identity: students have no sign-in. Registering gives a player token that the browser keeps for that one tab only
// (sessionStorage), so many children on one shared computer or browser profile can never become each other.
// Every student function below takes the student (resolved from that token by server.js), never a cookie.
import crypto from 'node:crypto';
import { zipSync } from 'fflate';
import { env, POLICY_VERSION, BANDS, GRADES, bandOf, ROUNDS, SCORE_PARTS, LIFELINES_PER_ROUND, SAVE_GRACE_MS, R3_GENERATIONS,
  AWARDS, EVENT_NAME, ROUND_MINUTES_RANGE, PHASE_SECONDS_RANGE, TIME_ADJUST_RANGE, LOBBY_SEEN_MS, ONLINE_MS, MAX_PHONES, MAX_STUDENTS,
  APP_NAME, SKILL_LABELS, PRACTICE_SECONDS, IMAGE_LINK_HOURS, R2_HINTS, R3_LENS, RATINGS } from './config.js';
import { db, save, uid } from './store.js';
import { getFlow, drawRound, publicView, bandProblems, imageFor, getSkills as getSkillsList } from './bank.js';
import { scorecards, scorecard, baseCard, renderScorecard } from './scorecard.js';
import { scoreRound, generate, partsFor } from './scoring.js';

export class GameError extends Error {
  constructor(message, status = 400, code) { super(message); this.status = status; this.code = code; }
}
const fail = (msg, status, code) => { throw new GameError(msg, status, code); };
const now = () => Date.now();
const LIVE = ['running', 'paused'];
const ENDED = ['finished', 'stopped'];
const iso = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 19) : '');
const clip = (s, n = 1500) => String(s ?? '').slice(0, n);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const hmac = (v) => crypto.createHmac('sha256', env.sessionSecret).update(v).digest('base64url').slice(0, 32);
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// ---------- events, roles ----------
export function activeEvent() {
  let ev = db.events[0];
  if (!ev) {
    ev = { id: uid('ev_'), createdAt: now(), active: true, finalPublished: false };
    db.events.push(ev);
  }
  ev.name = EVENT_NAME;
  return ev;
}

export const isAdmin = (email) => email === env.defaultAdmin || db.admins.some((a) => a.email === email);

// ---------- the gate: Promptathon is open or closed until an admin changes it (saved in the sheet, so it survives restarts) ----------
export const gate = () => ({ open: Boolean(db.settings.gate?.open), changedAt: db.settings.gate?.at || null, by: db.settings.gate?.by || '' });
export const requireOpen = () => { if (!gate().open) fail('Promptathon is closed right now. Please wait for your host to open it.', 423, 'closed'); };

// Closing pauses every running test (their clocks stop); opening again resumes exactly those tests.
export function setGate(open, by) {
  const t = now();
  let paused = 0, resumed = 0;
  for (const a of db.attempts) {
    if (a.archived) continue;
    if (!open && a.status === 'running') { Object.assign(a, { status: 'paused', pausedAt: t, closedPause: true }); paused++; }
    if (open && a.status === 'paused' && a.closedPause) {
      Object.assign(a, { status: 'running', pausedMs: a.pausedMs + (t - a.pausedAt), pausedAt: null });
      delete a.closedPause;
      resumed++;
    }
  }
  db.settings.gate = { open: Boolean(open), at: t, by };
  save(true);
  return { ...gate(), paused, resumed };
}

// ---------- timing (admin-editable lengths) ----------
export const roundMinutes = () => Object.fromEntries([1, 2, 3].map((r) => [r, db.settings.roundMinutes?.[r] ?? ROUND_MINUTES_RANGE.default]));
const practiceSeconds = () => db.settings.practiceSeconds ?? PRACTICE_SECONDS.default;
export const phaseSeconds = () => ({ brief: practiceSeconds(), finish: db.settings.phaseSeconds?.finish ?? getFlow().find((p) => p.type === 'finish')?.sec ?? 45 });

// Applies to students who have not started yet; anyone already playing keeps their schedule (use phaseTime for them).
export function setTiming({ minutes = {}, seconds = {} } = {}) {
  const m = {};
  for (const r of [1, 2, 3]) {
    m[r] = Math.round(Number(minutes[r]));
    if (!(m[r] >= ROUND_MINUTES_RANGE.min && m[r] <= ROUND_MINUTES_RANGE.max)) fail(`Round ${r} must be between ${ROUND_MINUTES_RANGE.min} and ${ROUND_MINUTES_RANGE.max} minutes.`);
  }
  const brief = Math.round(Number(seconds.brief)), finish = Math.round(Number(seconds.finish));
  if (!(brief >= PRACTICE_SECONDS.min && brief <= PRACTICE_SECONDS.max)) fail(`Instructions and practice may last ${PRACTICE_SECONDS.min / 60}–${PRACTICE_SECONDS.max / 60} minutes.`);
  if (!(finish >= PHASE_SECONDS_RANGE.min && finish <= PHASE_SECONDS_RANGE.max)) fail(`The finish screen must last ${PHASE_SECONDS_RANGE.min}–${PHASE_SECONDS_RANGE.max} seconds.`);
  db.settings.roundMinutes = m;
  db.settings.practiceSeconds = brief;
  db.settings.phaseSeconds = { ...(db.settings.phaseSeconds || {}), finish };
  save(true);
}

const scheduleFor = (filter = () => true) => getFlow().filter(filter).map(({ key, type, round, sec, title, script }) => ({ key, type, round,
  sec: type === 'round' ? roundMinutes()[round] * 60 : type === 'brief' ? practiceSeconds() : type === 'finish' ? phaseSeconds().finish : sec, title, script }));

// ---------- students ----------
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  let c;
  do c = `BZ-${Array.from({ length: 5 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('')}`;
  while (db.students.some((s) => s.code === c));
  return c;
}

export const studentById = (id) => db.students.find((s) => s.id === id);
const schoolName = (id) => db.schools.find((s) => s.id === id)?.name || '—';
export const displayName = (s) => {
  const [first, ...rest] = s.name.trim().split(/\s+/);
  return rest.length ? `${first} ${rest.at(-1)[0].toUpperCase()}.` : first;
};

// Phone numbers: 6–15 digits with an optional leading +.
function cleanPhones(list) {
  const out = [];
  for (const raw of (Array.isArray(list) ? list : [list]).map((x) => clip(x, 30).trim()).filter(Boolean)) {
    const digits = raw.replace(/[\s().-]/g, '');
    if (!/^\+?\d{6,15}$/.test(digits)) fail(`“${raw}” doesn’t look like a phone number. Use digits only, with + for the country code if needed.`);
    if (!out.includes(digits)) out.push(digits);
  }
  if (out.length > MAX_PHONES) fail(`You can add up to ${MAX_PHONES} phone numbers.`);
  return out;
}
const last10 = (p) => String(p).replace(/\D/g, '').slice(-10);

// The player token a browser tab keeps: student, login epoch and a signature, so it can't be guessed or edited.
// A student's login is locked to that token until a host logs them out (which bumps the epoch and kills the token).
export const playerToken = (s) => `${s.id}.${s.epoch || 0}.${hmac(`player:${s.id}:${s.epoch || 0}`)}`;
export function studentFromToken(token) {
  const [id, epoch, sig] = String(token || '').split('.');
  if (!id || epoch === undefined || !sig || !safeEq(sig, hmac(`player:${id}:${epoch}`))) return { error: 'no-student' };
  const s = studentById(id);
  if (!s) return { error: 'no-student' };
  if (!s.loggedIn || (s.epoch || 0) !== Number(epoch)) return { error: 'logged-out' };
  return { student: s };
}

// One set of rules for joining and for editing yourself in the lobby.
function cleanDetails({ name, grade, schoolId, phone, email }) {
  name = clip(name, 60).replace(/\s+/g, ' ').trim();
  if (name.length < 2 || !/\p{L}/u.test(name)) fail('Please type your full name.');
  grade = Number(grade);
  if (!GRADES.includes(grade)) fail(`Please choose your grade (${GRADES[0]}–${GRADES.at(-1)}).`);
  if (!db.schools.some((x) => x.id === schoolId)) fail('Please choose your school.');
  const phones = cleanPhones([phone]);
  if (!phones.length) fail('Please type a phone number.');
  email = clip(email, 120).trim().toLowerCase();
  if (email && !EMAIL_RE.test(email)) fail('That email doesn’t look right. Check it, or leave it empty.');
  return { name, grade, schoolId, phones, email };
}
// Joining = taking a seat in the lobby: name, grade, school, phone (required), email (optional). Joining ALWAYS makes a new player,
// even with exactly the same details as someone else — the only way back into an existing player is their player code (loginWithCode).
export function register(input = {}) {
  requireOpen();
  const v = cleanDetails(input);
  if (input.consent !== true) fail('Please tick the box to show a parent, guardian or teacher said yes.');
  if (db.students.length >= MAX_STUDENTS) fail('Registrations are full. Please tell your host.', 503);
  const s = { id: uid('st_'), code: newCode(), email: v.email, name: v.name, grade: v.grade, schoolId: v.schoolId, phones: v.phones, createdAt: now(), lockedAt: null, epoch: 1, loggedIn: true };
  db.students.push(s);
  db.consents.push({ id: uid('cn_'), studentId: s.id, email: v.email, kind: 'guardian or teacher', version: POLICY_VERSION, at: now() });
  save(true);
  return { student: s, returning: false };
}

// Logging back in with a player code (BZ-XXXXX). Works only when the seat is free — i.e. a host logged that player out —
// so a code seen over someone's shoulder can't take over a window that is still playing.
export const normalCode = (c) => { const x = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return x.length === 7 && x.startsWith('BZ') ? `BZ-${x.slice(2)}` : x.length === 5 ? `BZ-${x}` : ''; };
export function loginWithCode(code) {
  requireOpen();
  const want = normalCode(code);
  if (!want) fail('Type your player code — it looks like BZ-ABCDE.', 400, 'bad-code');
  const s = db.students.find((x) => x.code === want);
  if (!s) fail('We couldn’t find that player code. Check it, or ask your host — they can see every code.', 404, 'bad-code');
  if (s.loggedIn) fail('This player is still logged in on another window. Ask your host to log that window out first.', 409, 'already-in');
  Object.assign(s, { epoch: (s.epoch || 0) + 1, loggedIn: true });
  save(true);
  return { student: s };
}

// A player fixes their own details in the lobby. Locked once the test starts (the grade decides which questions they get).
export function updateProfile(student, input = {}) {
  requireOpen();
  const a = currentAttempt(student.id);
  if (a && a.status !== 'waiting') fail('Your details are locked once the test has started. Ask your host if something is wrong.', 409, 'locked');
  const v = cleanDetails(input);
  if (v.grade !== student.grade && gradeLocked(student)) fail('Your grade can’t change after you have played. Ask your host.', 409, 'locked');
  Object.assign(student, { name: v.name, grade: v.grade, schoolId: v.schoolId, phones: [v.phones[0], ...(student.phones || []).slice(1).filter((p) => last10(p) !== last10(v.phones[0]))].slice(0, MAX_PHONES), email: v.email });
  save(true);
  return stateFor(ensureAttempt(student), student);
}
const gradeLocked = (s) => db.attempts.some((a) => a.studentId === s.id && a.startedAt);

// A host logs players out of their windows. Their old token stops working at once; a running test is paused (the clock stops)
// and stays paused until the player joins again and the host presses Resume.
export function logoutStudents(studentIds) {
  const out = { done: 0, skipped: 0, paused: 0 }, t = now();
  for (const id of new Set(studentIds)) {
    const s = studentById(id);
    if (!s || !s.loggedIn) { out.skipped++; continue; }
    Object.assign(s, { loggedIn: false, epoch: (s.epoch || 0) + 1 });
    const a = currentAttempt(s.id);
    if (a) {
      if (a.status === 'running') {
        Object.assign(a, { status: 'paused', pausedAt: t });
        a.acks._lock = { at: t, count: a.acks._lock?.count || 0, reason: 'logout', requested: false, note: '' }; // they can ask to continue once back
        out.paused++;
      }
      delete a.closedPause; // from now on only a host's Resume restarts the clock
      Object.assign(a, { deviceId: null, lastSeen: null });
    }
    out.done++;
  }
  save(true);
  return out;
}

// Removes a student who registered but never started (for duplicates or mistakes).
export function deleteStudent(id) {
  const s = studentById(id);
  if (!s) fail('Student not found.', 404);
  if (db.attempts.some((a) => a.studentId === id && (a.startedAt || a.archived))) fail('This student has already played, so they can’t be removed.');
  db.students = db.students.filter((x) => x.id !== id);
  db.attempts = db.attempts.filter((a) => a.studentId !== id);
  db.requests = db.requests.filter((r) => r.studentId !== id);
  save(true);
}

// ---------- attempts ----------
export const currentAttempt = (studentId, eventId = activeEvent().id) =>
  db.attempts.find((a) => a.studentId === studentId && a.eventId === eventId && !a.archived);

// A waiting attempt is only "in the lobby" while that student's lobby screen is open (it checks in every couple of seconds).
export const inLobby = (a) => a.status === 'waiting' && Boolean(a.lastSeen) && now() - a.lastSeen < LOBBY_SEEN_MS;
export const statusOf = (a) => (a.status === 'waiting' && !inLobby(a) ? 'away' : a.status);
const online = (a) => Boolean(a?.lastSeen) && now() - a.lastSeen < ONLINE_MS;

function ensureAttempt(student) {
  let a = currentAttempt(student.id);
  if (!a) {
    a = { id: uid('at_'), studentId: student.id, eventId: activeEvent().id, status: 'waiting', createdAt: now(),
      startedAt: null, pausedAt: null, pausedMs: 0, endedAt: null, deviceId: null, lastSeen: null, acks: {}, rounds: {} };
    db.attempts.push(a);
    student.lockedAt ??= now();
    save();
  }
  return a;
}

function mine(student) {
  if (!student) fail('Please register first.', 401, 'no-student');
  return { student, attempt: ensureAttempt(student) };
}

// ---------- clock ----------
const flowOf = (a) => a.flow || getFlow();
function elapsed(a, t = now()) {
  if (!a.startedAt) return 0;
  return (a.pausedAt ?? a.endedAt ?? t) - a.startedAt - a.pausedMs;
}
const offsetOf = (a, key) => {
  let t = 0;
  for (const p of flowOf(a)) { if (p.key === key) return { start: t, end: t + p.sec * 1000 }; t += p.sec * 1000; }
  return null;
};
const roundWindow = (a, r) => offsetOf(a, `r${r}`);

const minutesText = (sec) => { const m = Math.max(1, Math.round(sec / 60)); return `${m} minute${m === 1 ? '' : 's'}`; };

// The sheet's scripts say "eight minutes"; say the real length for this student instead.
function spoken(text, a, p) {
  if (!text) return '';
  const secs = [1, 2, 3].map((r) => flowOf(a).find((x) => x.key === `r${r}`)?.sec ?? ROUND_MINUTES_RANGE.default * 60);
  if (p.type === 'brief') return text.replace(/\beight minutes?\b/i, minutesText(secs[p.round - 1]));
  return text;
}

export function phaseOf(a, t = now()) {
  if (a.status === 'waiting') return { type: 'waiting' };
  if (ENDED.includes(a.status)) return { type: 'done', round: 3 };
  const e = elapsed(a, t);
  let start = 0;
  const flow = flowOf(a);
  for (let i = 0; i < flow.length; i++) {
    const p = flow[i], end = start + p.sec * 1000;
    if (e < end) {
      const live = getFlow().find((f) => f.key === p.key) || p;
      return { index: i, count: flow.length, key: p.key, type: p.type, round: p.round, title: live.title || p.title,
        script: spoken(live.script || p.script, a, p), remainingMs: end - e, durationMs: p.sec * 1000 };
    }
    start = end;
  }
  return { type: 'done', round: 3 };
}

// Ends the phase with this key right now (if it is the one running), so the next one starts.
function endPhaseNow(a, key) {
  a.flow ||= scheduleFor();
  const entry = a.flow.find((p) => p.key === key), w = offsetOf(a, key), e = elapsed(a);
  if (!entry || !w || e < w.start || e >= w.end) return false;
  entry.sec = Math.max(0, (e - w.start) / 1000);
  return true;
}

// ---------- question sets (shared by everyone in one run + grade band) ----------
const setById = (id) => db.sets.find((s) => s.id === id);

// A run is one group of students who were started together: they share one question set per band and round.
export const runOf = (x) => x.runId || x.eventId; // attempts and sets from before runs existed count as one run

export function runs() {
  const ev = activeEvent(), by = new Map();
  for (const a of db.attempts) {
    if (a.eventId !== ev.id || !a.startedAt) continue;
    const r = by.get(runOf(a)) || { id: runOf(a), students: new Set(), startedAt: a.startedAt, live: false };
    r.students.add(a.studentId); r.startedAt = Math.min(r.startedAt, a.startedAt); r.live ||= LIVE.includes(a.status);
    by.set(r.id, r);
  }
  return [...by.values()].sort((x, y) => x.startedAt - y.startedAt).map((r, i) => ({ id: r.id, number: i + 1, students: r.students.size, startedAt: r.startedAt, live: r.live }));
}

// How the run's own students did before `beforeRound` (0–1), which sets the difficulty of the next draw.
function bandPerformance(run, band, beforeRound) {
  let got = 0, max = 0;
  for (const a of db.attempts) {
    if (runOf(a) !== run || a.archived || bandOf(studentById(a.studentId)?.grade) !== band) continue;
    for (let r = 1; r < beforeRound; r++) {
      const rec = a.rounds[r], parts = rec?.score?.parts || {};
      for (const def of partsFor(r, setById(rec?.setId)?.content)) if (parts[def.key]?.points != null) { got += parts[def.key].points; max += def.max; }
    }
  }
  return max ? got / max : null;
}

function ensureSet(run, band, round) {
  let s = db.sets.find((x) => runOf(x) === run && x.band === band && x.round === round);
  if (!s) {
    s = { id: uid('set_'), eventId: activeEvent().id, runId: run, ...drawRound(round, band, round === 1 ? null : bandPerformance(run, band, round)) };
    db.sets.push(s);
    save(true);
  }
  return s;
}

function openRound(a, r) {
  if (a.rounds[r]) return a.rounds[r];
  for (let k = 1; k < r; k++) finalize(a, k, 'time'); // earlier rounds count towards the adaptive draw
  const student = studentById(a.studentId), band = bandOf(student.grade);
  const set = ensureSet(a.redo?.round === r && a.redo.run ? a.redo.run : runOf(a), band, r);
  if (set.band !== band) fail('These questions belong to another grade band.', 500); // never serve another band's questions
  a.rounds[r] = { setId: set.id, openedAt: now(), draft: {}, savedAt: null, submittedAt: null, lifelines: { used: [], data: {} }, generations: [], score: null };
  save(true);
  return a.rounds[r];
}

// ---------- answers: what counts as answered, cleaning, saving ----------
const filled = (v, n = 1) => String(v ?? '').trim().length >= n;

// Every question of a round that has no answer yet: [{ id, label, step }] (step = the screen index in the round).
export function missingOf(r, content, d = {}) {
  const out = [];
  if (r === 1) {
    const items = [...content.items, content.boss];
    items.forEach((q, i) => { if (!d.answers?.[q.id]) out.push({ id: q.id, label: i === items.length - 1 ? 'Final boss' : `Question ${i + 1}`, step: i }); });
    if (!filled(d.bossWhy, 3)) out.push({ id: `${content.boss.id}:why`, label: 'Final boss — your reason', step: items.length - 1 });
  } else if (r === 2 && content.v === 2) {
    for (const q of content.case.questions) {
      const ok = q.written ? filled(d.fix, 3) : Boolean(d.answers?.[q.n]);
      if (!ok) out.push({ id: `s${q.n}`, label: `Step ${q.n} · ${{ spot: 'Spot the mistake', evidence: 'Choose the evidence', fix: 'Fix it' }[q.kind]}`, step: q.n - 1 });
    }
  } else if (r === 3 && content.v === 2) {
    if (!filled(d.prompt, 3)) out.push({ id: 'prompt', label: 'Your prompt', step: 0 });
    if (content.target.needsReasons && !filled(d.reasons, 3)) out.push({ id: 'reasons', label: 'Your two reasons', step: 1 });
  }
  return out;
}

function cleanMeta(m = {}) {
  const ms = (v) => Math.max(0, Math.min(3_600_000, Math.round(Number(v) || 0)));
  const t = Object.fromEntries(Object.entries(m.t || {}).slice(0, 40).map(([k, v]) => [clip(k, 60), ms(v)]));
  const s = [...new Set((Array.isArray(m.s) ? m.s : []).slice(0, 40).map((k) => clip(k, 60)))];
  return { t, s };
}

function cleanDraft(r, d = {}) {
  const meta = cleanMeta(d._meta);
  if (r === 1) {
    return { answers: Object.fromEntries(Object.entries(d.answers || {}).slice(0, 20).map(([k, v]) => [clip(k, 60), clip(v, 2)])), bossWhy: clip(d.bossWhy), _meta: meta };
  }
  if (r === 2) {
    return { answers: Object.fromEntries(['1', '2', '3'].filter((k) => d.answers?.[k]).map((k) => [k, clip(d.answers[k], 2)])), fix: clip(d.fix), _meta: meta };
  }
  return { prompt: clip(d.prompt, 3000), reasons: clip(d.reasons), finalPick: clip(d.finalPick, 2), _meta: meta };
}

function saveDraft(a, r, draft) {
  const rec = a.rounds[r];
  if (!rec) return { ok: false, reason: 'This round is not open.' };
  if (rec.submittedAt) return { ok: false, reason: 'This round is already submitted.' };
  if (a.status !== 'running') return { ok: false, reason: a.status === 'paused' ? 'Paused by the host.' : 'The test is not running.' };
  if (elapsed(a) > roundWindow(a, r).end + SAVE_GRACE_MS) return { ok: false, reason: 'Time is up — changes after the deadline are not accepted.' };
  rec.draft = cleanDraft(r, draft);
  rec.savedAt = now();
  save();
  return { ok: true, savedAt: rec.savedAt };
}

// ---------- submitting & scoring ----------
const roundTotal = (rec) => (rec?.score ? Object.values(rec.score.parts).reduce((s, p) => s + (p.points || 0), 0) : null);

function finalize(a, r, reason) {
  const rec = a.rounds[r];
  if (!rec || rec.submittedAt) return;
  rec.submittedAt = now();
  rec.submitReason = reason;
  const set = setById(rec.setId);
  const grade = studentById(a.studentId).grade;
  const w = roundWindow(a, r);
  rec.meta = { takenMs: w ? Math.max(0, Math.min(w.end - w.start, elapsed(a) - w.start)) : null, time: rec.draft?._meta?.t || {},
    passed: rec.draft?._meta?.s || [], skipped: set?.content ? missingOf(r, set.content, rec.draft).map((m) => m.id) : [] };
  const res = scoreRound(r, set.content, rec.draft, grade, (later) => {
    for (const [k, v] of Object.entries(later)) if (rec.score.parts[k]?.by !== 'admin') rec.score.parts[k] = { ...v, by: v.note?.startsWith('AI') ? 'ai' : 'auto' };
    rec.score.pending = false;
    save(true);
  });
  rec.score = { parts: Object.fromEntries(Object.entries(res.parts).map(([k, v]) => [k, { ...v, by: 'auto' }])), pending: res.pending };
  save(true);
}

// Runs every second: closes rounds past their cutoff, opens rounds on schedule, finishes completed attempts.
export function tick() {
  const t = now();
  const live = db.attempts.filter((a) => a.status === 'running' && !a.archived);
  // Pass 1: close every round that is past its cutoff, so adaptive draws in pass 2 see all scores.
  for (const a of live) {
    for (const r of [1, 2, 3]) {
      const w = roundWindow(a, r); // a round reattempt's schedule holds only that round
      if (a.rounds[r] && !a.rounds[r].submittedAt && (!w || elapsed(a, t) >= w.end + SAVE_GRACE_MS)) finalize(a, r, 'time');
    }
  }
  for (const a of live) {
    const ph = phaseOf(a, t);
    try {
      if (ph.type === 'round') openRound(a, ph.round);
    } catch (err) { console.error('Could not open round', ph.round, err.message); }
    if (ph.type === 'done') { a.status = 'finished'; a.endedAt = t; save(true); }
  }
}

function summary(a) {
  const rounds = [1, 2, 3].map((r) => {
    const rec = a.rounds[r];
    if (!rec?.submittedAt) return { round: r, name: ROUNDS[r].name, state: rec ? 'open' : 'not started', total: null, max: ROUNDS[r].max };
    return { round: r, name: ROUNDS[r].name, state: rec.score?.pending ? 'pending' : 'scored', total: roundTotal(rec), max: ROUNDS[r].max,
      skipped: rec.meta?.skipped?.length || 0, takenMs: rec.meta?.takenMs ?? null };
  });
  return { rounds, total: rounds.reduce((s, r) => s + (r.total || 0), 0), pending: rounds.some((r) => r.state === 'pending') };
}

const feedbackOf = (a) => db.feedback.find((f) => f.attemptId === a.id);

function stateFor(a, student, extra = {}) {
  const ph = phaseOf(a);
  const rec = ph.round ? a.rounds[ph.round] : null;
  return {
    attemptId: a.id, scorecard: Boolean(approvedCardOf(student.id)), open: gate().open,
    student: { id: student.id, code: student.code, name: student.name, grade: student.grade, band: bandOf(student.grade), school: schoolName(student.schoolId),
      schoolId: student.schoolId, phone: student.phones?.[0] || '', email: student.email || '', gradeLocked: gradeLocked(student) },
    status: a.status, paused: Boolean(a.pausedAt), closedPause: Boolean(a.closedPause), lock: a.acks._lock || null, phase: ph, acks: a.acks,
    roundSeconds: Object.fromEntries([1, 2, 3].map((r) => [r, flowOf(a).find((p) => p.key === `r${r}`)?.sec])), request: requestFor(a, student.id),
    round: rec && { submitted: Boolean(rec.submittedAt), savedAt: rec.savedAt }, practice: a.practice || {},
    feedback: Boolean(feedbackOf(a)), results: summary(a), final: activeEvent().finalPublished, redoRound: a.redo?.round || null, ...extra,
  };
}

// ---------- student API ----------
export function playState(student) {
  requireOpen();
  const { attempt } = mine(student);
  return stateFor(attempt, student);
}

function checkDevice(a, deviceId) {
  if (!deviceId) fail('Missing device id.');
  if (a.deviceId && a.deviceId !== deviceId && LIVE.includes(a.status)) fail('This test is open in another window.', 409, 'device');
  a.deviceId = deviceId;
  a.lastSeen = now();
}

export function sync(student, { deviceId, round, draft, ack }) {
  requireOpen();
  const { attempt: a } = mine(student);
  checkDevice(a, String(deviceId || '').slice(0, 80));
  if (ack && /^[a-z0-9-]{1,20}$/.test(ack)) a.acks[ack] = a.acks[ack] || now();
  const ph = phaseOf(a);
  if (ph.type === 'round' && a.status === 'running') openRound(a, ph.round);
  const saved = round && draft ? saveDraft(a, Number(round), draft) : null;
  save();
  return stateFor(a, student, { saved });
}

// Pressing "Start Round N" after the instructions and practice: the round clock starts now.
export function startRound(student, { deviceId, round }) {
  requireOpen();
  const { attempt: a } = mine(student);
  checkDevice(a, deviceId);
  round = Number(round);
  const ph = phaseOf(a);
  if (a.status !== 'running') fail(a.status === 'paused' ? 'Your test is paused by your host.' : 'The test is not running.', 409);
  if (ph.type === 'brief' && ph.round === round) {
    a.acks[`r${round}`] ||= now();
    endPhaseNow(a, ph.key);
    openRound(a, round);
  } else if (ph.type === 'round' && ph.round === round) {
    a.acks[`r${round}`] ||= now(); // the round had already started by itself
  } else fail('That round can’t start now.', 409);
  save(true);
  return stateFor(a, student);
}

// The practice question before a round (not scored) — kept so hosts can see who tried it.
export function recordPractice(student, { round, answer, correct }) {
  requireOpen();
  const { attempt: a } = mine(student);
  round = Number(round);
  if (![1, 2, 3].includes(round)) fail('Unknown round.');
  a.practice = { ...(a.practice || {}), [round]: { at: now(), answer: clip(typeof answer === 'string' ? answer : JSON.stringify(answer ?? ''), 600), correct: typeof correct === 'boolean' ? correct : null } };
  save();
  return { ok: true };
}

// A student who leaves the test window during a round is paused until the host lets them back in.
// The record lives in `acks._lock` (the acks cell is already saved with the attempt).
export function leaveWindow(student, deviceId) {
  requireOpen();
  const { attempt: a } = mine(student);
  checkDevice(a, deviceId);
  const ph = phaseOf(a);
  if (a.status === 'running' && ph.type === 'round' && !a.rounds[ph.round]?.submittedAt) {
    const prev = a.acks._lock;
    Object.assign(a, { status: 'paused', pausedAt: now() });
    a.acks._lock = { at: now(), count: (prev?.count || 0) + 1, requested: false, note: '' };
    save(true);
  }
  return stateFor(a, student);
}

export function lockRequest(student, note) {
  requireOpen();
  const { attempt: a } = mine(student);
  if (!a.acks._lock) fail('Nothing to ask the host about.', 409);
  Object.assign(a.acks._lock, { requested: true, note: clip(note, 300).trim(), requestedAt: now() });
  save(true);
  return stateFor(a, student);
}

export const pendingLocks = () => db.attempts.filter((a) => a.status === 'paused' && a.acks?._lock?.requested && !a.archived).length;

export function requestDeletion(email, { name, contact, code, details }) {
  name = clip(name, 80).trim(); contact = clip(contact, 120).trim(); code = clip(code, 20).trim(); details = clip(details, 600).trim();
  if (name.length < 2) fail('Please enter your name.');
  if (!EMAIL_RE.test(contact)) fail('Please enter an email address we can reply to.');
  if (db.deletions.filter((d) => d.status === 'open' && d.email === contact.toLowerCase()).length >= 3) fail('We already have your requests. We will be in touch soon.', 429);
  const r = { id: uid('dl_'), name, email: contact.toLowerCase(), code, details, at: now(), status: 'open', by: '', doneAt: null, account: email || '' };
  db.deletions.push(r);
  save(true);
  return { ok: true };
}

export const listDeletions = () => [...db.deletions].sort((x, y) => (x.status === 'open' ? 0 : 1) - (y.status === 'open' ? 0 : 1) || y.at - x.at);
export function closeDeletion(id, adminEmail) {
  const r = db.deletions.find((x) => x.id === id);
  if (!r) fail('Request not found.', 404);
  Object.assign(r, { status: 'done', by: adminEmail, doneAt: now() });
  save(true);
}

export function takeover(student, deviceId) {
  requireOpen();
  const { attempt: a } = mine(student);
  a.deviceId = String(deviceId || '').slice(0, 80);
  a.lastSeen = now();
  save();
  return stateFor(a, student);
}

function liveRound(student, deviceId) {
  requireOpen();
  const { attempt: a } = mine(student);
  checkDevice(a, deviceId);
  const ph = phaseOf(a);
  if (ph.type !== 'round') fail('No round is open right now.', 409);
  const rec = openRound(a, ph.round);
  return { a, r: ph.round, rec, set: setById(rec.setId) };
}

// Question pictures are served through short-lived signed links, so only students who were given the question can load it.
const linkExp = () => Math.ceil((now() + IMAGE_LINK_HOURS * 3600e3) / 3600e3) * 3600e3; // whole hours: the browser can cache the link
export const imageLink = (id) => { const e = linkExp(); return `/api/img/${encodeURIComponent(id)}?e=${e}&s=${hmac(`img:${id}:${e}`)}`; };
export function signedImage(id, e, s) {
  if (!(Number(e) > now()) || !safeEq(String(s || ''), hmac(`img:${id}:${e}`))) return null;
  return imageFor(id) || null;
}

export function roundContent(student, deviceId) {
  const { r, rec, set } = liveRound(student, deviceId);
  if (set.band !== bandOf(student.grade)) fail('These questions belong to another grade band.', 500);
  const view = publicView(set);
  if (view.imageId) view.image = imageLink(view.imageId);
  delete view.imageId;
  return { round: r, band: set.band, view, draft: rec.draft, submitted: Boolean(rec.submittedAt), savedAt: rec.savedAt,
    lifelines: rec.lifelines, generations: rec.generations.filter((g) => g.output), generationsLeft: R3_GENERATIONS - rec.generations.length };
}

export function useLifeline(student, { deviceId, id, target }) {
  const { a, r, rec, set } = liveRound(student, deviceId);
  if (rec.submittedAt) fail('This round is already submitted.');
  if (a.status !== 'running') fail('The test is paused.');
  if (!ROUNDS[r].lifelines.some((l) => l.id === id)) fail('Unknown lifeline.');
  if (rec.lifelines.used.includes(id) || rec.lifelines.used.length >= LIFELINES_PER_ROUND) fail('You have already used this lifeline in this round.');
  const c = set.content;
  let data;
  if (r === 1) {
    const q = c.items.find((x) => x.id === target) || (c.boss.id === target ? c.boss : null);
    if (!q) fail('Choose a question first.');
    if (id === 'fifty') {
      if (q.options.length < 3) fail('50–50 works on questions with three or more choices.');
      let hide = q.hide.filter((h) => h !== q.key && q.options.some((o) => o.id === h));
      if (hide.length < 2) hide = q.options.map((o) => o.id).filter((o) => o !== q.key).sort(() => crypto.randomInt(3) - 1).slice(0, 2);
      data = { target, hide: hide.slice(0, Math.min(2, q.options.length - 2)) };
    } else data = { target, text: q.clue };
  } else if (r === 2) {
    const q = c.case.questions.find((x) => x.n === Number(target));
    if (!q) fail('Choose a step first.');
    if (id === 'compass') {
      if (q.options) {
        const wrong = q.options.map((o) => o.id).filter((o) => o !== q.key);
        data = { target: q.n, hide: [wrong[crypto.randomInt(wrong.length)]] };
      } else data = { target: q.n, text: R2_HINTS.fixWritten };
    } else data = { target: q.n, text: q.written ? R2_HINTS.fixWritten : R2_HINTS[q.kind] };
  } else data = { text: id === 'goal' ? c.target.goalLens || R3_LENS.goal : c.target.structureScan || R3_LENS.structure };
  rec.lifelines.used.push(id);
  rec.lifelines.data[id] = data;
  save();
  return rec.lifelines;
}

// Submitting early is allowed only when every question is answered; when the time runs out, whatever is saved is submitted.
export function submitRound(student, { deviceId, round, draft }) {
  const { a, r, rec, set } = liveRound(student, deviceId);
  if (Number(round) !== r) fail('That round is no longer open.', 409);
  if (rec.submittedAt) return stateFor(a, student);
  if (draft) {
    const res = saveDraft(a, r, draft);
    if (!res.ok) fail(res.reason, 409);
  }
  const missing = missingOf(r, set.content, rec.draft);
  const w = roundWindow(a, r);
  if (missing.length && w && elapsed(a) < w.end) {
    throw Object.assign(new GameError(`Answer every question before you submit. Still to do: ${missing.map((m) => m.label).join(', ')}.`, 409, 'incomplete'), { missing });
  }
  finalize(a, r, 'submitted');
  endPhaseNow(a, `r${r}`); // the student moves straight on to the next round's instructions
  save(true);
  return stateFor(a, student);
}

export async function generateR3(student, { deviceId, prompt }) {
  const { a, r, rec, set } = liveRound(student, deviceId);
  if (r !== 3 || rec.submittedAt || a.status !== 'running') fail('The AI tool is only available during Round 3.');
  if (set.content.target?.type === 'image') fail('This target is a picture, so there is no AI tool here. Write your prompt.');
  prompt = clip(prompt, 3000).trim();
  if (prompt.length < 5) fail('Write your prompt first.');
  if (rec.generations.length >= R3_GENERATIONS) fail('You have used both AI generations.');
  const g = { prompt, output: '', at: now() };
  rec.generations.push(g); // reserve the slot before the slow call
  try {
    g.output = await generate(prompt, student.grade);
  } catch (err) {
    rec.generations.splice(rec.generations.indexOf(g), 1);
    throw new GameError(err.message || 'The AI tool is unavailable right now.', 503);
  }
  save();
  return { generations: rec.generations, generationsLeft: R3_GENERATIONS - rec.generations.length };
}

// The smiley rating at the end (1–5) with an optional comment. One per attempt; sending again replaces it.
export function submitFeedback(student, { rating, text }) {
  requireOpen();
  const { attempt: a } = mine(student);
  if (!ENDED.includes(a.status) && !['finish', 'done'].includes(phaseOf(a).type)) fail('You can leave feedback when you have finished.', 409); // 'done' = finished, before the next clock tick marks it
  rating = Math.round(Number(rating));
  if (!RATINGS.some((x) => x.value === rating)) fail('Choose a face first.');
  const prev = feedbackOf(a);
  const rec = { id: prev?.id || uid('fb_'), studentId: student.id, attemptId: a.id, rating, text: clip(text, 1000).trim(), at: now() };
  if (prev) Object.assign(prev, rec); else db.feedback.push(rec);
  save(true);
  return stateFor(a, student);
}

// ---------- admin controls ----------
export function control(action, studentIds, { questions } = {}) {
  const ev = activeEvent();
  const out = { done: 0, skipped: 0, errors: [] };
  if (action === 'start' && !gate().open) fail('Promptathon is closed. Open it first (top of the dashboard), then start.', 409);
  let run = null; // everyone started by one press of Start shares this run
  const t = now();
  for (const id of new Set(studentIds)) {
    const s = studentById(id);
    const a = s && currentAttempt(s.id, ev.id);
    if (!a) { out.skipped++; continue; }
    if (action === 'start' && a.status === 'waiting' && a.redo && inLobby(a)) { // a round reattempt: just that round's briefing and round
      const r = a.redo.round;
      a.redo.run = questions === 'new' ? uid('run_') : null; // 'same' = the questions this student had before
      Object.assign(a, { status: 'running', startedAt: t, pausedAt: null, pausedMs: 0, flow: scheduleFor((p) => p.round === r && (p.type === 'brief' || p.type === 'round')) });
    } else if (action === 'start' && a.status === 'waiting' && inLobby(a)) {
      const band = bandOf(s.grade);
      const problems = bandProblems(band);
      if (problems.length) { out.errors.push(`${BANDS.find((b) => b.id === band).label}: ${problems.join(', ')}`); continue; }
      run ||= (questions === 'same' && runs().at(-1)?.id) || uid('run_');
      ensureSet(run, band, 1);
      Object.assign(a, { status: 'running', runId: run, startedAt: t, pausedAt: null, pausedMs: 0, flow: scheduleFor() });
    } else if (action === 'pause' && a.status === 'running') {
      Object.assign(a, { status: 'paused', pausedAt: t });
    } else if (action === 'resume' && a.status === 'paused') {
      if (!s.loggedIn) { out.skipped++; out.errors.push('Players who are logged out stay paused until they join again.'); continue; }
      Object.assign(a, { status: 'running', pausedMs: a.pausedMs + (t - a.pausedAt), pausedAt: null });
      delete a.acks._lock;
      delete a.closedPause;
    } else if (action === 'stop' && LIVE.includes(a.status)) {
      if (a.pausedAt) { a.pausedMs += t - a.pausedAt; a.pausedAt = null; }
      for (const r of [1, 2, 3]) finalize(a, r, 'stopped');
      delete a.closedPause;
      Object.assign(a, { status: 'stopped', endedAt: t });
    } else { out.skipped++; continue; }
    out.done++;
  }
  out.errors = [...new Set(out.errors)];
  save(true);
  return out;
}

// round 0 = the whole test again (the old attempt is archived with its scores). Round 1–3 = only that round again:
// the other rounds keep their answers and scores, the old round is kept in a.redo.history, and Start plays just that round.
export function enableReattempt(studentId, round = 0) {
  const a = currentAttempt(studentId);
  round = Number(round) || 0;
  if (a && LIVE.includes(a.status)) fail('Stop this student’s test before enabling a reattempt.');
  if (round) {
    if (![1, 2, 3].includes(round)) fail('Choose a round.');
    if (!a || !ENDED.includes(a.status)) fail('A round can be reopened only after the student’s test has ended.');
    const old = a.rounds[round];
    const history = [...(a.redo?.history || []), { round, at: now(), prev: old ? { setId: old.setId, submittedAt: old.submittedAt, draft: old.draft, score: old.score, meta: old.meta } : null }];
    delete a.rounds[round];
    delete a.acks[`r${round}`];
    a.redo = { round, run: null, history };
    Object.assign(a, { status: 'waiting', startedAt: null, pausedAt: null, pausedMs: 0, endedAt: null, deviceId: null, lastSeen: null });
    if (a.card) a.card.approved = false; // the score changes, so the score card needs checking again
  } else {
    if (a?.status === 'waiting' && !a.redo) fail('This student hasn’t played yet — there is nothing to reattempt.');
    if (a) { a.archived = true; a.archivedAt = now(); }
    const s = studentById(studentId);
    if (s) ensureAttempt(s);
  }
  for (const r of db.requests) if (r.studentId === studentId && r.status === 'pending') Object.assign(r, { status: 'approved', decidedAt: now(), decidedBy: 'admin' });
  save(true);
}

// The same for many students at once (Live control). Students it can't apply to are skipped with the reason.
export function enableReattempts(studentIds, round = 0) {
  const out = { done: 0, skipped: [] };
  for (const id of new Set(studentIds)) {
    try { enableReattempt(id, round); out.done++; } catch (err) { out.skipped.push(`${studentById(id)?.name || id}: ${err.message}`); }
  }
  return out;
}

// ---------- reattempt requests (the student asks, an admin decides) ----------
const latestRequest = (studentId, pred = () => true) => db.requests.filter((r) => r.studentId === studentId && pred(r)).sort((x, y) => y.createdAt - x.createdAt)[0];
const requestView = (r) => r && { status: r.status, note: r.note, reply: r.reply, createdAt: r.createdAt, decidedAt: r.decidedAt };

// Only the request that belongs to what the student is looking at: the finished attempt, or the fresh lobby after approval.
function requestFor(a, studentId) {
  return requestView(a.status === 'waiting'
    ? latestRequest(studentId, (r) => r.status === 'approved' && r.decidedAt >= a.createdAt)
    : latestRequest(studentId, (r) => r.attemptId === a.id));
}

export function requestReattempt(student, note) {
  requireOpen();
  const { attempt: a } = mine(student);
  if (!ENDED.includes(a.status)) fail('You can ask for another attempt once your test has ended.', 409);
  if (db.requests.some((r) => r.studentId === student.id && r.status === 'pending')) fail('Your request is already waiting for the host.', 409);
  db.requests.push({ id: uid('rq_'), studentId: student.id, attemptId: a.id, note: clip(note, 500).trim(), status: 'pending',
    createdAt: now(), decidedAt: null, decidedBy: '', reply: '' });
  save(true);
  return stateFor(a, student);
}

export const pendingRequests = () => db.requests.filter((r) => r.status === 'pending').length;

export function listRequests() {
  return db.requests.filter((r) => studentById(r.studentId)).map((r) => { // a request whose student was removed is skipped
    const s = studentById(r.studentId), a = db.attempts.find((x) => x.id === r.attemptId), sum = a && summary(a);
    return { id: r.id, status: r.status, note: r.note, reply: r.reply, createdAt: r.createdAt, decidedAt: r.decidedAt, decidedBy: r.decidedBy,
      student: { id: s.id, code: s.code, name: s.name, grade: s.grade, band: bandOf(s.grade), school: schoolName(s.schoolId) }, total: sum?.total ?? null };
  }).sort((x, y) => (x.status === 'pending' ? 0 : 1) - (y.status === 'pending' ? 0 : 1) || y.createdAt - x.createdAt);
}

export function decideRequest(id, approve, reply, adminEmail, round = 0) {
  const r = db.requests.find((x) => x.id === id);
  if (!r) fail('Request not found.', 404);
  if (r.status !== 'pending') fail('This request has already been answered.', 409);
  const current = currentAttempt(r.studentId);
  if (approve && current?.id === r.attemptId && ENDED.includes(current.status)) enableReattempt(r.studentId, round); // otherwise a reattempt was already opened for them
  Object.assign(r, { status: approve ? 'approved' : 'rejected', decidedAt: now(), decidedBy: adminEmail, reply: clip(reply, 500).trim() });
  save(true);
}

// ---------- add time to / end a round or the instructions (live students only) ----------
// target: 'current' (whatever each student is on now) or a round number 1–3.
export function phaseTime(action, studentIds, { target = 'current', seconds = 0 } = {}) {
  const ev = activeEvent();
  const secs = Math.round(Number(seconds));
  if (!['extend', 'end'].includes(action)) fail('Unknown action.');
  if (action === 'extend' && !(secs >= TIME_ADJUST_RANGE.min && secs <= TIME_ADJUST_RANGE.max)) fail(`Add between ${TIME_ADJUST_RANGE.min} seconds and ${TIME_ADJUST_RANGE.max / 60} minutes at a time.`);
  if (target !== 'current' && ![1, 2, 3].includes(Number(target))) fail('Choose a round.');
  const out = { done: 0, skipped: 0 };
  for (const id of new Set(studentIds)) {
    const a = currentAttempt(id, ev.id);
    if (!a || !LIVE.includes(a.status)) { out.skipped++; continue; }
    a.flow ||= scheduleFor();
    const ph = phaseOf(a);
    const entry = target === 'current' ? (ph.index != null ? a.flow[ph.index] : null) : a.flow.find((p) => p.key === `r${target}`);
    if (!entry) { out.skipped++; continue; }
    const w = offsetOf(a, entry.key), e = elapsed(a);
    if (action === 'extend') {
      if (e >= w.end) { out.skipped++; continue; } // already over for this student
      entry.sec += secs;
    } else {
      if (e < w.start || e >= w.end) { out.skipped++; continue; } // only what is running can be ended
      if (entry.type === 'round') openRound(a, entry.round);
      entry.sec = Math.max(0, (e - w.start) / 1000);
      if (entry.type === 'round') finalize(a, entry.round, 'ended by host');
    }
    out.done++;
  }
  save(true);
  return out;
}

export function setScores(attemptId, round, parts) {
  const a = db.attempts.find((x) => x.id === attemptId);
  const rec = a?.rounds[round];
  if (!rec?.score) fail('This round has not been submitted yet.');
  for (const def of partsFor(round, setById(rec.setId)?.content)) {
    if (parts[def.key] == null || parts[def.key] === '') continue;
    const points = Math.max(0, Math.min(def.max, Math.round(Number(parts[def.key]) || 0)));
    rec.score.parts[def.key] = { ...rec.score.parts[def.key], points, by: 'admin' };
  }
  rec.score.pending = false;
  rec.reviewedAt = now();
  save(true);
}

// ---------- score cards ----------
// A card is computed from the saved answers; the admin can edit any field, then approve it. Only approved cards reach students.
const attemptById = (id) => db.attempts.find((x) => x.id === id);
export const attemptCard = (attemptId) => { const a = attemptById(attemptId); return a && scorecard(a); };
export function cardHtml(attemptId) {
  const card = attemptCard(attemptId);
  if (!card) fail('There is no score card for this attempt yet — it needs at least one scored round.', 404);
  return renderScorecard(card);
}
export { scorecards };

const cleanNumber = (v, lo, hi) => { if (v === '' || v == null) return undefined; const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : undefined; };

// Keeps only the fields that differ from the computed card, so "edited" means something.
export function saveCardEdits(attemptId, input = {}) {
  const a = attemptById(attemptId), base = a && baseCard(a);
  if (!base) fail('There is no score card for this attempt yet.', 404);
  const e = {};
  for (const k of ['name', 'school', 'code', 'grade', 'strength', 'nextStep']) {
    const v = String(input[k] ?? '').trim();
    if (v && v !== String(base[k])) e[k] = clip(v, k === 'strength' || k === 'nextStep' ? 400 : 60);
  }
  const total = cleanNumber(input.total, 0, 60);
  if (total !== undefined && total !== base.total) e.total = total;
  const rounds = [0, 1, 2].map((i) => { const v = cleanNumber(input.rounds?.[i], 0, 20); return v === base.rounds[i] ? undefined : v; });
  if (rounds.some((v) => v !== undefined)) e.rounds = rounds;
  const skills = {};
  for (const [id, v] of Object.entries(input.skills || {})) {
    const n = cleanNumber(v, 0, 100), was = base.skills.find((k) => k.id === id)?.percent;
    if (n !== undefined && n !== was) skills[id] = n;
  }
  if (Object.keys(skills).length) e.skills = skills;
  (a.card ||= { approved: false }).edits = e;
  save(true);
  return scorecard(a);
}

export const cardEditorData = (attemptId) => { const a = attemptById(attemptId); return a && baseCard(a) && { computed: baseCard(a), card: scorecard(a), edits: a.card?.edits || {} }; };

export function setCardApproval(attemptIds, approved, by) {
  const out = { done: 0, skipped: 0, ids: [] };
  for (const id of attemptIds) {
    const a = attemptById(id), c = a && scorecard(a);
    if (!c || (approved && c.status === 'pending')) { out.skipped++; continue; } // scoring has to be complete first
    const state = (a.card ||= { approved: false });
    if (state.approved === approved) continue;
    Object.assign(state, { approved, approvedAt: approved ? now() : null, approvedBy: approved ? by : '' });
    out.done++; out.ids.push(id);
  }
  save(true);
  return out;
}

// Rows for the admin's Score cards tab (filters: school, grade, run/session, status).
export const cardRows = () => {
  const rs = runs();
  return scorecards().map((c) => ({ attemptId: c.attemptId, studentId: c.studentId, name: c.name, code: c.code, grade: c.grade, school: c.school,
    email: c.email, total: c.total, status: c.status, edited: c.edited, approved: c.approved, emailedAt: c.emailedAt, emailedTo: c.emailedTo, changedSinceEmailed: c.changedSinceEmailed,
    archived: c.archived, run: rs.find((r) => r.id === c.run)?.number ?? '' }));
};

const approvedCardOf = (studentId) => db.attempts.filter((x) => x.studentId === studentId).sort((x, y) => y.createdAt - x.createdAt).map(scorecard).find((c) => c?.approved) || null;
export const studentCard = (student) => (student ? approvedCardOf(student.id) : null);

// ---------- reporting ----------
const optText = (q, id) => (id ? `${id}. ${q.options?.find((o) => o.id === id)?.text || ''}` : '—');
const secs = (ms) => (ms == null ? null : Math.round(ms / 1000));

export function answerDetail(a) {
  const out = [];
  for (const r of [1, 2, 3]) {
    const rec = a.rounds[r];
    if (!rec) continue;
    const c = setById(rec.setId)?.content;
    if (!c) continue;
    const d = rec.draft || {}, p = rec.score?.parts || {}, meta = rec.meta || {};
    const pts = (k) => p[k]?.points ?? null;
    const row = (id, item, part, question, answer, correct, points, max, extra = {}) => out.push({ round: r, id, part, question, answer: answer || '—', correct, points, max,
      by: p[part]?.by || '', note: p[part]?.note || '', timeSec: item ? secs(meta.time?.[item] ?? d._meta?.t?.[item]) : null,
      skipped: item ? (meta.skipped || []).includes(item) : false, passed: item ? (meta.passed || d._meta?.s || []).includes(item) : false, ...extra });
    if (r === 1) {
      for (const q of c.items) row(q.id, q.id, 'quick', q.question, optText(q, d.answers?.[q.id]), optText(q, q.key), p.quick?.items?.[q.id] ?? null, 2,
        { lifeline: Object.values(rec.lifelines.data).some((l) => l.target === q.id) });
      row(c.boss.id, c.boss.id, 'bossChoice', c.boss.question, optText(c.boss, d.answers?.[c.boss.id]), optText(c.boss, c.boss.key), pts('bossChoice'), 2);
      row(`${c.boss.id} · why`, `${c.boss.id}:why`, 'bossWhy', 'Explain why it is the best choice', d.bossWhy, c.boss.explanation, pts('bossWhy'), 2);
    } else if (r === 2 && c.v === 2) {
      for (const q of c.case.questions) {
        row(`${c.case.id} · step ${q.n}`, `s${q.n}`, q.kind, `${c.case.title}: ${q.question}`, q.written ? d.fix : optText(q, d.answers?.[q.n]), q.written ? q.sample : optText(q, q.key), pts(q.kind), q.max,
          { lifeline: Object.values(rec.lifelines.data).some((l) => Number(l.target) === q.n) });
      }
    } else if (r === 2) { // a case from the earlier bank
      row(`${c.case.id}`, '', 'rebuild', c.case.title, '(earlier question format)', '', roundTotal(rec), 20);
    } else if (c.v === 2) {
      const t = c.target, promptPts = partsFor(3, c).filter((x) => x.key !== 'reasons').reduce((s, x) => (pts(x.key) == null ? s : (s ?? 0) + pts(x.key)), null);
      row(`${t.id} · prompt`, 'prompt', 'purpose', `${t.title}: ${t.question}`, d.prompt, t.reference, promptPts, t.needsReasons ? 16 : 20);
      if (t.needsReasons) row(`${t.id} · reasons`, 'reasons', 'reasons', 'Two short reasons', d.reasons, '', pts('reasons'), 4);
    } else {
      row(`${c.target.id} · prompt`, '', 'purpose', `Write a prompt for: ${c.target.title}`, d.prompt, c.target.example, roundTotal(rec), 20);
    }
  }
  return out;
}

function resultRows(ev = activeEvent()) {
  return db.attempts.filter((a) => a.eventId === ev.id && !a.archived && a.status !== 'waiting' && studentById(a.studentId)).map((a) => {
    const s = studentById(a.studentId), sum = summary(a);
    const [r1, r2, r3] = sum.rounds.map((x) => x.total);
    return { a, s, run: runOf(a), band: bandOf(s.grade), school: schoolName(s.schoolId), r1, r2, r3, total: sum.total, pending: sum.pending, sum,
      content: a.rounds[3]?.score?.parts?.content?.points ?? 0, reviewed: [1, 2, 3].every((r) => !a.rounds[r] || a.rounds[r].reviewedAt) };
  });
}

// Separate leaderboard per band. Ties: Round 2 total, then Round 3 content; otherwise joint rank.
export function leaderboard({ band, schoolId, runId } = {}) {
  const ev = activeEvent();
  const rows = resultRows(ev).filter((x) => x.band === band && (!schoolId || x.s.schoolId === schoolId) && (!runId || x.run === runId));
  const ranked = rows.filter((x) => !x.pending).sort((x, y) => y.total - x.total || (y.r2 || 0) - (x.r2 || 0) || y.content - x.content);
  ranked.forEach((x, i) => {
    const prev = ranked[i - 1];
    x.rank = prev && prev.total === x.total && (prev.r2 || 0) === (x.r2 || 0) && prev.content === x.content ? prev.rank : i + 1;
  });
  const top = (key) => {
    const best = Math.max(...ranked.map((x) => x[key] ?? 0));
    return best > 0 ? ranked.filter((x) => (x[key] ?? 0) === best).map((x) => displayName(x.s)) : [];
  };
  const awards = AWARDS.map((w) => ({ ...w, winners: w.round === 0 ? ranked.filter((x) => x.rank === 1).map((x) => displayName(x.s)) : top(`r${w.round}`) }));
  const shape = (x) => ({ rank: x.rank ?? null, code: x.s.code, name: displayName(x.s), school: x.school, grade: x.s.grade,
    r1: x.r1, r2: x.r2, r3: x.r3, total: x.total, pending: x.pending, status: x.a.status });
  return { band, run: runId || '', runs: runs(), event: ev.name, final: ev.finalPublished, rows: [...ranked, ...rows.filter((x) => x.pending)].map(shape), awards };
}

// ---------- the admin's student list (registrations: contact details, status, feedback) ----------
export function studentRows() {
  const ev = activeEvent();
  return db.students.map((s) => {
    const a = currentAttempt(s.id, ev.id), ph = a ? phaseOf(a) : null, fb = a && feedbackOf(a);
    return { id: s.id, code: s.code, name: s.name, email: s.email || '', phones: s.phones || [], grade: s.grade, band: bandOf(s.grade), schoolId: s.schoolId,
      createdAt: s.createdAt, loggedIn: Boolean(s.loggedIn), attemptId: a?.id, lock: a?.acks?._lock || null, closedPause: Boolean(a?.closedPause), online: online(a),
      status: a ? statusOf(a) : 'not joined', redoRound: a?.status === 'waiting' ? a.redo?.round || null : null,
      phase: ph && { type: ph.type, round: ph.round, title: ph.title, remainingMs: ph.remainingMs }, practice: Object.keys(a?.practice || {}).map(Number),
      scores: a && [1, 2, 3].map((r) => {
        const rec = a.rounds[r];
        return rec?.score ? { total: Object.values(rec.score.parts).reduce((t, p) => t + (p.points || 0), 0), pending: rec.score.pending, skipped: rec.meta?.skipped?.length || 0 } : null;
      }),
      feedback: fb ? { rating: fb.rating, text: fb.text } : null,
      reattempts: db.attempts.filter((x) => x.studentId === s.id && x.eventId === ev.id && x.archived).length };
  });
}

export function feedbackList() {
  return db.feedback.map((f) => {
    const s = studentById(f.studentId);
    return { id: f.id, rating: f.rating, text: f.text, at: f.at, student: s ? { id: s.id, name: s.name, code: s.code, grade: s.grade, school: schoolName(s.schoolId), schoolId: s.schoolId } : null };
  }).filter((f) => f.student).sort((x, y) => y.at - x.at);
}

export function analytics() {
  const ev = activeEvent();
  const attempts = db.attempts.filter((a) => a.eventId === ev.id && !a.archived);
  const rows = resultRows(ev);
  const done = rows.filter((x) => ENDED.includes(x.a.status) && !x.pending);
  const avg = (xs) => (xs.length ? Math.round((xs.reduce((s, v) => s + v, 0) / xs.length) * 10) / 10 : null);
  const items = [];
  for (const set of db.sets.filter((s) => s.eventId === ev.id && s.round === 1)) {
    for (const q of [...set.content.items, set.content.boss]) {
      const recs = attempts.map((a) => a.rounds[1]).filter((r) => r?.setId === set.id && r.submittedAt);
      const correct = recs.filter((r) => r.draft.answers?.[q.id] === q.key).length;
      items.push({ band: set.band, id: q.id, skill: q.skill || 'boss', difficulty: q.difficulty, attempts: recs.length, answered: recs.filter((r) => r.draft.answers?.[q.id]).length, correct,
        pctCorrect: recs.length ? Math.round((correct / recs.length) * 100) : null, lifelines: recs.filter((r) => Object.values(r.lifelines.data).some((l) => l.target === q.id)).length,
        avgSec: avg(recs.map((r) => secs(r.meta?.time?.[q.id])).filter((v) => v != null)) });
    }
  }
  const steps = [];
  for (const set of db.sets.filter((s) => s.eventId === ev.id && s.round === 2 && s.content.v === 2)) {
    const recs = attempts.map((a) => a.rounds[2]).filter((r) => r?.setId === set.id && r.submittedAt);
    if (!recs.length) continue;
    for (const q of set.content.case.questions) {
      const scored = recs.map((r) => r.score?.parts?.[q.kind]?.points).filter((v) => v != null);
      steps.push({ band: set.band, id: `${set.content.case.id} · ${q.n}`, kind: q.kind, written: q.written, attempts: recs.length,
        pct: scored.length ? Math.round((scored.reduce((s, v) => s + v, 0) / (scored.length * q.max)) * 100) : null,
        avgSec: avg(recs.map((r) => secs(r.meta?.time?.[`s${q.n}`])).filter((v) => v != null)) });
    }
  }
  const partAvgs = Object.fromEntries([1, 2, 3].map((r) => [r, SCORE_PARTS[r].map((def) => ({ ...def,
    avg: avg(attempts.filter((a) => setById(a.rounds[r]?.setId)?.content?.v === 2 || r === 1).map((a) => a.rounds[r]?.score?.parts?.[def.key]?.points).filter((v) => v != null)) }))]));
  const lifelineUse = {};
  for (const a of attempts) for (const r of [1, 2, 3]) for (const id of a.rounds[r]?.lifelines?.used || []) lifelineUse[id] = (lifelineUse[id] || 0) + 1;
  const fb = feedbackList();
  return {
    event: ev.name,
    kpis: { registered: db.students.length, lobby: attempts.filter(inLobby).length,
      live: attempts.filter((a) => LIVE.includes(a.status)).length, finished: rows.filter((x) => ENDED.includes(x.a.status)).length,
      avgTotal: avg(done.map((x) => x.total)), feedback: fb.length, avgRating: avg(fb.map((f) => f.rating)) },
    rounds: [1, 2, 3].map((r) => ({ round: r, name: ROUNDS[r].name, max: 20, avg: avg(rows.map((x) => x[`r${r}`]).filter((v) => v != null)),
      avgMinutes: avg(rows.map((x) => x.sum.rounds[r - 1].takenMs).filter((v) => v != null).map((v) => v / 60000)),
      skipped: rows.reduce((s, x) => s + (x.sum.rounds[r - 1].skipped || 0), 0) })),
    distribution: [0, 10, 20, 30, 40, 50].map((lo) => ({ label: `${lo}–${lo === 50 ? 60 : lo + 9}`, count: done.filter((x) => x.total >= lo && (lo === 50 ? x.total <= 60 : x.total < lo + 10)).length })),
    schools: db.schools.map((sc) => {
      const mineRows = done.filter((x) => x.s.schoolId === sc.id);
      return { name: sc.name, students: db.students.filter((s) => s.schoolId === sc.id).length, finished: mineRows.length, avg: avg(mineRows.map((x) => x.total)) };
    }),
    bands: BANDS.map((b) => ({ label: b.label, finished: done.filter((x) => x.band === b.id).length, avg: avg(done.filter((x) => x.band === b.id).map((x) => x.total)),
      levels: db.sets.filter((s) => s.eventId === ev.id && s.band === b.id).map((s) => `R${s.round}: ${s.level}`).join(', ') })),
    ratings: RATINGS.map((r) => ({ ...r, count: fb.filter((f) => f.rating === r.value).length })),
    parts: partAvgs, items, steps, lifelineUse,
  };
}

// Tabs used for the Google Sheet's readable Results / Answers tabs.
export function reportTabs() {
  const ev = activeEvent();
  const tabs = {
    Results: [['Event', 'Code', 'Name', 'School', 'Grade', 'Band', 'Status', 'Started', 'Ended', 'R1 AI Blitz', 'R2 AI Case', 'R3 Creator', 'Total /60', 'Scoring', 'Reviewed', 'Run',
      'R1 minutes', 'R2 minutes', 'R3 minutes', 'Skipped questions', 'Feedback (1–5)', 'Feedback comment']],
    Answers: [['Event', 'School', 'Band', 'Grade', 'Code', 'Name', 'Round', 'Question / part ID', 'Question', 'Student answer', 'Correct answer / reference', 'Points', 'Max', 'Marked by', 'Marker note',
      'Time on question (s)', 'Skipped', 'Passed over']],
  };
  const rs = runs();
  for (const x of resultRows(ev)) {
    const fb = feedbackOf(x.a), mins = x.sum.rounds.map((r) => (r.takenMs == null ? '' : Math.round(r.takenMs / 6000) / 10));
    tabs.Results.push([ev.name, x.s.code, x.s.name, x.school, x.s.grade, x.band, x.a.status, iso(x.a.startedAt), iso(x.a.endedAt),
      x.r1 ?? '', x.r2 ?? '', x.r3 ?? '', x.total, x.pending ? 'pending' : ev.finalPublished ? 'final' : 'provisional', x.reviewed ? 'yes' : 'no', rs.find((r) => r.id === x.run)?.number ?? '',
      ...mins, x.sum.rounds.reduce((s, r) => s + (r.skipped || 0), 0), fb?.rating ?? '', fb?.text ?? '']);
    for (const d of answerDetail(x.a)) {
      tabs.Answers.push([ev.name, x.school, x.band, x.s.grade, x.s.code, x.s.name, d.round, d.id, d.question, d.answer, d.correct, d.points ?? '', d.max ?? '', d.by, d.note,
        d.timeSec ?? '', d.skipped ? 'yes' : '', d.passed ? 'yes' : '']);
    }
  }
  return tabs;
}

// ---------- Excel reports (the admin's downloads): one for every school, or one school ----------
const XL = { ink: 'FF1D1A17', muted: 'FF5D554E', head: 'FFBF4B11', band: 'FFFFF6EE', line: 'FFE6D5C6', title: 'FFA9440F' };
const median = (xs) => { if (!xs.length) return null; const v = [...xs].sort((p, q) => p - q), m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
const mean = (xs) => (xs.length ? xs.reduce((t, v) => t + v, 0) / xs.length : null);

function sheetTitle(ws, title, sub, width) {
  ws.mergeCells(1, 1, 1, width); ws.mergeCells(2, 1, 2, width);
  Object.assign(ws.getCell(1, 1), { value: title, font: { name: 'Calibri', size: 16, bold: true, color: { argb: XL.title } } });
  Object.assign(ws.getCell(2, 1), { value: sub, font: { name: 'Calibri', size: 10, italic: true, color: { argb: XL.muted } }, alignment: { wrapText: true, vertical: 'top' } });
  ws.getRow(1).height = 24; ws.getRow(2).height = 30;
  return 4; // first row for content
}

// A formatted table: header row, banded body, borders, optional number formats per column. Returns the next free row.
function xlTable(ws, row, cols, rows, { filter = false, freeze = false, heading = '' } = {}) {
  if (heading) { Object.assign(ws.getCell(row, 1), { value: heading, font: { name: 'Calibri', bold: true, size: 12, color: { argb: XL.ink } } }); row++; }
  const top = row, border = { style: 'thin', color: { argb: XL.line } };
  const hr = ws.getRow(row);
  cols.forEach((c, i) => {
    Object.assign(hr.getCell(i + 1), { value: c.h, font: { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: XL.head } },
      alignment: { vertical: 'middle', horizontal: c.num ? 'center' : 'left', wrapText: true }, border: { top: border, bottom: border, left: border, right: border } });
  });
  hr.height = 30;
  rows.forEach((vals, r) => {
    const xr = ws.getRow(++row);
    cols.forEach((c, i) => {
      const cell = xr.getCell(i + 1), v = vals[i];
      cell.value = v === undefined || v === null || Number.isNaN(v) ? (c.num ? '—' : '') : v;
      cell.border = { top: border, bottom: border, left: border, right: border };
      cell.font = { name: 'Calibri', size: 11, color: { argb: XL.ink } };
      cell.alignment = { vertical: 'top', horizontal: c.num ? 'center' : 'left', wrapText: Boolean(c.wrap) };
      if (c.fmt && typeof v === 'number') cell.numFmt = c.fmt;
      if (r % 2) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: XL.band } };
    });
  });
  if (!rows.length) { ws.mergeCells(row + 1, 1, row + 1, cols.length); Object.assign(ws.getCell(row + 1, 1), { value: 'Nothing to show yet.', font: { italic: true, color: { argb: XL.muted } } }); row++; }
  if (filter && rows.length) ws.autoFilter = { from: { row: top, column: 1 }, to: { row, column: cols.length } };
  if (freeze) ws.views = [{ state: 'frozen', ySplit: top, xSplit: 0, showGridLines: false }];
  cols.forEach((c, i) => { const col = ws.getColumn(i + 1); col.width = Math.max(col.width || 0, c.w || 14); });
  return row + 2;
}

// Everything a report needs, for all schools or one school.
function reportData(schoolId = '') {
  const ev = activeEvent(), skills = getSkillsList();
  const students = db.students.filter((s) => !schoolId || s.schoolId === schoolId);
  const ids = new Set(students.map((s) => s.id));
  const results = resultRows(ev).filter((x) => ids.has(x.s.id));
  const done = results.filter((x) => ENDED.includes(x.a.status) && !x.pending);
  // rank within the grade band, across all schools (same tie-breaks as the leaderboard: Round 2, then Round 3 content)
  const ranks = new Map();
  for (const b of BANDS) {
    const ranked = resultRows(ev).filter((x) => x.band === b.id && ENDED.includes(x.a.status) && !x.pending)
      .sort((x, y) => y.total - x.total || (y.r2 || 0) - (x.r2 || 0) || y.content - x.content);
    ranked.forEach((x, i) => { const p = ranked[i - 1]; ranks.set(x.a.id, p && p.total === x.total && (p.r2 || 0) === (x.r2 || 0) && p.content === x.content ? ranks.get(p.a.id) : i + 1); });
  }
  const cards = new Map(results.map((x) => [x.a.id, baseCard(x.a)]));
  const statusText = (x) => ({ running: 'Playing', paused: 'Paused', finished: 'Finished', stopped: 'Ended by host' })[x.a.status] || x.a.status;
  const scoring = (x) => (x.pending ? 'Being marked' : ev.finalPublished ? 'Final' : 'Provisional');
  return { ev, skills, students, ids, results, done, ranks, cards, statusText, scoring, school: schoolId ? schoolName(schoolId) : '' };
}

export async function exportWorkbook(schoolId = '') {
  const { default: ExcelJS } = await import('exceljs');
  const D = reportData(schoolId), { ev, skills, results, done } = D;
  const scope = D.school || 'All schools';
  const stamp = `Generated ${new Date().toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' })} · Results are ${ev.finalPublished ? 'final' : 'provisional until published as final'}.`;
  const wb = new ExcelJS.Workbook();
  wb.creator = APP_NAME; wb.created = new Date();
  const add = (name, color) => wb.addWorksheet(name, { views: [{ showGridLines: false }], properties: { tabColor: { argb: color } }, pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  const pct = (v, max) => (v == null ? null : v / max);
  const totals = done.map((x) => x.total);
  const fbs = feedbackList().filter((f) => D.ids.has(f.student.id));

  // 1. Overview
  let ws = add('Overview', 'FFE8682A'), row = sheetTitle(ws, `${ev.name} — ${scope}`, `${stamp} Scores are out of 20 per round and 60 in total.`, 6);
  row = xlTable(ws, row, [{ h: 'At a glance', w: 34 }, { h: 'Value', num: true, w: 16 }], [
    ['Students registered', D.students.length],
    ['Students who started', results.length],
    ['Students finished (fully marked)', done.length],
    ['Still playing or being marked', results.length - done.length],
    ['Average total (out of 60)', mean(totals)], ['Median total (out of 60)', median(totals)],
    ['Highest total', totals.length ? Math.max(...totals) : null], ['Lowest total', totals.length ? Math.min(...totals) : null],
    ['Feedback given', fbs.length], ['Average feedback (1–5)', mean(fbs.map((f) => f.rating))],
  ].map(([k, v]) => [k, typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 10) / 10 : v]), { heading: 'Summary' });
  row = xlTable(ws, row, [{ h: 'Round', w: 34 }, { h: 'Average (out of 20)', num: true, fmt: '0.0', w: 16 }, { h: 'Average %', num: true, fmt: '0%', w: 14 }, { h: 'Highest', num: true, w: 12 },
    { h: 'Students scored', num: true, w: 16 }, { h: 'Average minutes', num: true, fmt: '0.0', w: 14 }, { h: 'Questions skipped', num: true, w: 14 }],
  [1, 2, 3].map((r) => { const v = results.map((x) => x[`r${r}`]).filter((n) => n != null), t = results.map((x) => x.sum.rounds[r - 1].takenMs).filter((n) => n != null).map((n) => n / 60000);
    return [`Round ${r} · ${ROUNDS[r].name}`, mean(v), pct(mean(v), 20), v.length ? Math.max(...v) : null, v.length, mean(t), results.reduce((s, x) => s + (x.sum.rounds[r - 1].skipped || 0), 0)]; }), { heading: 'Rounds' });
  row = xlTable(ws, row, [{ h: 'Grade band', w: 34 }, { h: 'Finished', num: true, w: 16 }, { h: 'Average (out of 60)', num: true, fmt: '0.0', w: 14 }, { h: 'Highest', num: true, w: 12 }],
    BANDS.map((b) => { const v = done.filter((x) => x.band === b.id).map((x) => x.total); return [b.label, v.length, mean(v), v.length ? Math.max(...v) : null]; }), { heading: 'Grade bands' });
  row = xlTable(ws, row, [{ h: 'Total score range', w: 34 }, { h: 'Students', num: true, w: 16 }, { h: 'Share', num: true, fmt: '0%', w: 14 }],
    [[0, 9], [10, 19], [20, 29], [30, 39], [40, 49], [50, 60]].map(([lo, hi]) => { const n = totals.filter((t) => t >= lo && t <= hi).length; return [`${lo}–${hi}`, n, totals.length ? n / totals.length : null]; }), { heading: 'How scores are spread' });

  // 2. School summary (all-schools report only)
  if (!schoolId) {
    ws = add('School Summary', 'FF0F5A8A'); row = sheetTitle(ws, 'School summary', `${stamp} One row per school. Averages use finished, fully marked students.`, 10);
    xlTable(ws, row, [{ h: 'School', w: 30 }, { h: 'Registered', num: true, w: 12 }, { h: 'Started', num: true, w: 11 }, { h: 'Finished', num: true, w: 11 },
      { h: 'Avg total /60', num: true, fmt: '0.0', w: 13 }, { h: 'Avg R1 /20', num: true, fmt: '0.0', w: 12 }, { h: 'Avg R2 /20', num: true, fmt: '0.0', w: 12 }, { h: 'Avg R3 /20', num: true, fmt: '0.0', w: 12 },
      { h: 'Highest', num: true, w: 10 }, { h: 'Top student(s)', w: 34, wrap: true }],
    db.schools.map((sc) => {
      const mine = done.filter((x) => x.s.schoolId === sc.id), t = mine.map((x) => x.total), best = t.length ? Math.max(...t) : null;
      return [sc.name, db.students.filter((s) => s.schoolId === sc.id).length, results.filter((x) => x.s.schoolId === sc.id).length, mine.length,
        mean(t), mean(mine.map((x) => x.r1).filter((v) => v != null)), mean(mine.map((x) => x.r2).filter((v) => v != null)), mean(mine.map((x) => x.r3).filter((v) => v != null)),
        best, best == null ? '' : mine.filter((x) => x.total === best).map((x) => x.s.name).join(', ')];
    }).sort((p, q) => (q[4] ?? -1) - (p[4] ?? -1)), { filter: true, freeze: true });
  }

  // 3. Results
  ws = add('Results', 'FF1B6F45'); row = sheetTitle(ws, `Results — ${scope}`, `${stamp} “Rank in band” compares students in the same grade band across all schools. Minutes = time taken in each round.`, 17);
  const order = [...results].sort((x, y) => x.school.localeCompare(y.school) || String(x.band).localeCompare(String(y.band)) || (D.ranks.get(x.a.id) ?? 1e9) - (D.ranks.get(y.a.id) ?? 1e9) || x.s.name.localeCompare(y.s.name));
  const resTop = row + 1;
  const mins = (x, r) => (x.sum.rounds[r].takenMs == null ? null : Math.round(x.sum.rounds[r].takenMs / 6000) / 10);
  row = xlTable(ws, row, [{ h: 'School', w: 26 }, { h: 'Grade band', w: 12 }, { h: 'Rank in band', num: true, w: 10 }, { h: 'Student code', w: 13 }, { h: 'Name', w: 24 }, { h: 'Grade', num: true, w: 8 },
    { h: 'R1 AI Blitz /20', num: true, w: 11 }, { h: 'R2 AI Case /20', num: true, w: 11 }, { h: 'R3 Creator /20', num: true, w: 11 }, { h: 'Total /60', num: true, w: 10 }, { h: 'Score %', num: true, fmt: '0%', w: 10 },
    { h: 'Status', w: 14 }, { h: 'Results', w: 13 }, { h: 'R1 min', num: true, w: 8 }, { h: 'R2 min', num: true, w: 8 }, { h: 'R3 min', num: true, w: 8 }, { h: 'Skipped', num: true, w: 9 }],
  order.map((x) => [x.school, BANDS.find((b) => b.id === x.band)?.label || x.band, D.ranks.get(x.a.id) ?? null, x.s.code, x.s.name, x.s.grade, x.r1, x.r2, x.r3, x.total, x.total / 60, D.statusText(x), D.scoring(x),
    mins(x, 0), mins(x, 1), mins(x, 2), x.sum.rounds.reduce((s, r) => s + (r.skipped || 0), 0)]),
  { filter: true, freeze: true });
  if (order.length) ws.addConditionalFormatting({ ref: `K${resTop}:K${resTop + order.length - 1}`, rules: [{ type: 'dataBar', cfvo: [{ type: 'num', value: 0 }, { type: 'num', value: 1 }], color: { argb: 'FFF4A26B' }, gradient: false }] });

  // 4. Skills: the 11-skill profile per student, with the group average on top
  ws = add('Skills', 'FF7A4FB5'); const ids = Object.keys(skills).sort();
  row = sheetTitle(ws, `Thinking skills — ${scope}`, `${stamp} Each skill % = points earned on the questions that test that skill ÷ points available on them. Blank = not tested yet.`, ids.length + 4);
  const skillRows = order.map((x) => { const c = D.cards.get(x.a.id); return [x.school, x.s.code, x.s.name, x.s.grade, ...ids.map((id) => { const p = c?.skills.find((k) => k.id === id)?.percent; return p == null ? null : p / 100; })]; });
  row = xlTable(ws, row, [{ h: 'Skill', w: 40 }, { h: 'Average', num: true, fmt: '0%', w: 12 }, { h: 'Students tested', num: true, w: 14 }],
    ids.map((id, i) => { const v = skillRows.map((r) => r[4 + i]).filter((n) => n != null); return [`${id} · ${skills[id].name}`, mean(v), v.length]; }), { heading: 'Group average' });
  xlTable(ws, row, [{ h: 'School', w: 26 }, { h: 'Student code', w: 13 }, { h: 'Name', w: 22 }, { h: 'Grade', num: true, w: 8 }, ...ids.map((id) => ({ h: `${id} ${skills[id].name}`, num: true, fmt: '0%', w: 14 }))],
    skillRows, { heading: 'Each student', filter: true });

  // 5. Score breakdown: how the group did on each scored part
  ws = add('Score Breakdown', 'FF8A5100'); row = sheetTitle(ws, `Score breakdown — ${scope}`, `${stamp} Average points on each scored part. A low % shows where students need the most practice.`, 5);
  xlTable(ws, row, [{ h: 'Round', w: 24 }, { h: 'Part', w: 40 }, { h: 'Max points', num: true, w: 11 }, { h: 'Average points', num: true, fmt: '0.0', w: 14 }, { h: 'Average %', num: true, fmt: '0%', w: 12 }],
    [1, 2, 3].flatMap((r) => SCORE_PARTS[r].map((p) => { const v = results.map((x) => x.a.rounds[r]?.score?.parts?.[p.key]?.points).filter((n) => n != null); return [`Round ${r} · ${ROUNDS[r].name}`, p.label, p.max, mean(v), mean(v) == null ? null : mean(v) / p.max]; })),
    { filter: true, freeze: true });

  // 6. Question analysis (Round 1 questions and Round 2 steps)
  ws = add('Question Analysis', 'FF5D554E'); row = sheetTitle(ws, `Question analysis — ${scope}`, `${stamp} One row per question. “% correct” is out of the students who were given that question. Seconds = average time spent on it.`, 10);
  const items = [];
  for (const set of db.sets.filter((x) => x.eventId === ev.id && x.round === 1)) {
    const recs = results.map((x) => x.a.rounds[1]).filter((r) => r?.setId === set.id && r.submittedAt);
    if (!recs.length) continue;
    for (const q of [...set.content.items, set.content.boss]) {
      const correct = recs.filter((r) => r.draft.answers?.[q.id] === q.key).length;
      items.push([BANDS.find((b) => b.id === set.band)?.label || set.band, 1, q.id, q === set.content.boss ? 'Final boss' : SKILL_LABELS[q.skill] || q.skill || '', q.difficulty || '', recs.length,
        recs.filter((r) => r.draft.answers?.[q.id]).length, correct / recs.length, recs.filter((r) => Object.values(r.lifelines.data).some((l) => l.target === q.id)).length,
        mean(recs.map((r) => r.meta?.time?.[q.id]).filter((v) => v != null).map((v) => v / 1000))]);
    }
  }
  for (const set of db.sets.filter((x) => x.eventId === ev.id && x.round === 2 && x.content.v === 2)) {
    const recs = results.map((x) => x.a.rounds[2]).filter((r) => r?.setId === set.id && r.submittedAt);
    if (!recs.length) continue;
    for (const q of set.content.case.questions) {
      const pts = recs.map((r) => r.score?.parts?.[q.kind]?.points).filter((v) => v != null);
      items.push([BANDS.find((b) => b.id === set.band)?.label || set.band, 2, `${set.content.case.id} · step ${q.n}`, `${{ spot: 'Spot the mistake', evidence: 'Choose the evidence', fix: 'Fix it' }[q.kind]}${q.written ? ' (written)' : ''}`,
        set.content.case.difficulty, recs.length, recs.filter((r) => (q.written ? (r.draft.fix || '').trim() : r.draft.answers?.[q.n])).length, pts.length ? mean(pts) / q.max : null,
        recs.filter((r) => Object.values(r.lifelines.data).some((l) => Number(l.target) === q.n)).length, mean(recs.map((r) => r.meta?.time?.[`s${q.n}`]).filter((v) => v != null).map((v) => v / 1000))]);
    }
  }
  xlTable(ws, row, [{ h: 'Grade band', w: 12 }, { h: 'Round', num: true, w: 8 }, { h: 'Question ID', w: 20 }, { h: 'Question type', w: 26 }, { h: 'Difficulty', w: 11 }, { h: 'Students', num: true, w: 10 },
    { h: 'Answered', num: true, w: 10 }, { h: '% correct', num: true, fmt: '0%', w: 11 }, { h: 'Lifeline used', num: true, w: 12 }, { h: 'Avg seconds', num: true, fmt: '0', w: 12 }], items, { filter: true, freeze: true });

  // 7. Answers (every answer, for checking)
  ws = add('Answers', 'FF0F5A8A'); row = sheetTitle(ws, `Every answer — ${scope}`, `${stamp} What each student answered, the reference answer, the points given, the time spent and whether the question was left empty.`, 14);
  xlTable(ws, row, [{ h: 'School', w: 22 }, { h: 'Student code', w: 13 }, { h: 'Name', w: 20 }, { h: 'Round', num: true, w: 8 }, { h: 'Question / part', w: 18 }, { h: 'Question', w: 42, wrap: true },
    { h: 'Student answer', w: 42, wrap: true }, { h: 'Correct answer / reference', w: 42, wrap: true }, { h: 'Points', num: true, w: 8 }, { h: 'Max', num: true, w: 7 }, { h: 'Marked by', w: 12 },
    { h: 'Seconds', num: true, w: 9 }, { h: 'Skipped', w: 9 }, { h: 'Passed over', w: 11 }],
  order.flatMap((x) => answerDetail(x.a).map((d) => [x.school, x.s.code, x.s.name, d.round, d.id, d.question, d.answer, d.correct, d.points, d.max, d.by, d.timeSec, d.skipped ? 'yes' : '', d.passed ? 'yes' : ''])), { filter: true, freeze: true });

  // 8. Students (registrations and contact details)
  ws = add('Students', 'FF1B6F45'); row = sheetTitle(ws, `Students — ${scope}`, `${stamp} Everyone registered, including students who haven’t played yet. Contains contact details — share with care.`, 9);
  const cur = (s) => currentAttempt(s.id, ev.id);
  xlTable(ws, row, [{ h: 'School', w: 26 }, { h: 'Student code', w: 13 }, { h: 'Name', w: 24 }, { h: 'Grade', num: true, w: 8 }, { h: 'Grade band', w: 12 }, { h: 'Phone', w: 18 }, { h: 'Email', w: 30 },
    { h: 'Registered', w: 18 }, { h: 'Test status', w: 16 }],
  [...D.students].sort((x, y) => schoolName(x.schoolId).localeCompare(schoolName(y.schoolId)) || x.name.localeCompare(y.name)).map((s) => {
    const a = cur(s), st = a ? statusOf(a) : 'not joined';
    return [schoolName(s.schoolId), s.code, s.name, s.grade, BANDS.find((b) => b.id === bandOf(s.grade))?.label || '', (s.phones || []).join(', '), s.email || '',
      s.createdAt ? new Date(s.createdAt).toLocaleString('en-GB') : '',
      ({ 'not joined': 'Not joined', away: 'Not in lobby', waiting: 'In lobby', running: 'Playing', paused: 'Paused', finished: 'Finished', stopped: 'Ended by host' })[st] || st];
  }), { filter: true, freeze: true });

  // 9. Feedback
  ws = add('Feedback', 'FFE8682A'); row = sheetTitle(ws, `Feedback — ${scope}`, `${stamp} The smiley each student chose at the end (1 = not fun, 5 = loved it) and their optional comment.`, 7);
  row = xlTable(ws, row, [{ h: 'Rating', w: 24 }, { h: 'Students', num: true, w: 12 }], RATINGS.map((r) => [`${r.value} · ${r.label}`, fbs.filter((f) => f.rating === r.value).length]), { heading: 'Summary' });
  xlTable(ws, row, [{ h: 'School', w: 24 }, { h: 'Student code', w: 13 }, { h: 'Name', w: 22 }, { h: 'Grade', num: true, w: 8 }, { h: 'Rating (1–5)', num: true, w: 12 }, { h: 'Comment', w: 60, wrap: true }, { h: 'Given', w: 18 }],
    fbs.map((f) => [f.student.school, f.student.code, f.student.name, f.student.grade, f.rating, f.text, new Date(f.at).toLocaleString('en-GB')]), { heading: 'Each student', filter: true });

  // 10. Reattempts
  ws = add('Reattempts', 'FF5D554E'); row = sheetTitle(ws, `Reattempt requests — ${scope}`, `${stamp} Requests students sent after their test ended, and the host’s answer.`, 8);
  xlTable(ws, row, [{ h: 'School', w: 24 }, { h: 'Student code', w: 13 }, { h: 'Name', w: 22 }, { h: 'Student note', w: 36, wrap: true }, { h: 'Status', w: 11 }, { h: 'Host reply', w: 30, wrap: true }, { h: 'Requested', w: 18 }, { h: 'Decided', w: 18 }],
    listRequests().filter((r) => D.ids.has(r.student.id)).map((r) => [r.student.school, r.student.code, r.student.name, r.note, { pending: 'Waiting', approved: 'Approved', rejected: 'Declined' }[r.status] || r.status, r.reply,
      r.createdAt ? new Date(r.createdAt).toLocaleString('en-GB') : '', r.decidedAt ? new Date(r.decidedAt).toLocaleString('en-GB') : '']), { filter: true, freeze: true });

  return Buffer.from(await wb.xlsx.writeBuffer());
}

// A ZIP with one school report per school.
export async function exportSchoolsZip() {
  const files = {};
  for (const sc of db.schools) files[`${reportFileName(sc.name)}`] = new Uint8Array(await exportWorkbook(sc.id));
  return Buffer.from(zipSync(files, { level: 6 }));
}
export const reportFileName = (scope = 'All schools') => `Promptathon report - ${scope.replace(/[^\w ]+/g, '').trim() || 'School'} - ${new Date().toISOString().slice(0, 10)}.xlsx`;

// Registrations as CSV (opens in Excel / Sheets).
export function studentsCsv() {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Code', 'Name', 'Grade', 'Band', 'School', 'Phone', 'Email', 'Registered', 'Status', 'Total /60', 'Feedback (1–5)', 'Feedback comment'];
  const rows = studentRows().map((s) => [s.code, s.name, s.grade, s.band, schoolName(s.schoolId), s.phones.join(' '), s.email, s.createdAt ? new Date(s.createdAt).toISOString() : '',
    s.status, s.scores?.some(Boolean) ? s.scores.reduce((t, x) => t + (x?.total || 0), 0) : '', s.feedback?.rating ?? '', s.feedback?.text ?? '']);
  return `﻿${[head, ...rows].map((r) => r.map(q).join(',')).join('\r\n')}`;
}

// The readable tabs kept in the Google Sheet next to the data tabs (see store.js).
export const reports = () => reportTabs();

// The scored parts a submitted round has (depends on its question), for the admin's score editor.
export const partsOfRound = (r, rec) => partsFor(r, setById(rec?.setId)?.content);
