// Game engine: events, students, attempts, the server-side clock, admin controls, results and exports.
import crypto from 'node:crypto';
import * as XLSX from 'xlsx';
import { env, BANDS, GRADES, bandOf, ROUNDS, SCORE_PARTS, LIFELINES_PER_ROUND, SAVE_GRACE_MS, R3_GENERATIONS,
  AWARDS, EVENT_NAME, ROUND_MINUTES_RANGE, PHASE_SECONDS_RANGE, TIME_ADJUST_RANGE, R3_MODES } from './config.js';
import { db, save, uid } from './store.js';
import { getFlow, drawRound, publicView, bandProblems, imageFor } from './bank.js';
import { scorecards, scorecard, baseCard, renderScorecard } from './scorecard.js';
import { getSkills as getSkillsList } from './bank.js';
import { scoreRound, generate } from './scoring.js';

export class GameError extends Error {
  constructor(message, status = 400, code) { super(message); this.status = status; this.code = code; }
}
const fail = (msg, status, code) => { throw new GameError(msg, status, code); };
const now = () => Date.now();
const LIVE = ['running', 'paused'];
const iso = (t) => (t ? new Date(t).toISOString().replace('T', ' ').slice(0, 19) : '');
const clip = (s, n = 1500) => String(s ?? '').slice(0, n);

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

// ---------- timing (admin-editable lengths for the rounds and for the screens between them) ----------
const PHASES = ['welcome', 'brief', 'transition', 'finish'];
export const roundMinutes = () => Object.fromEntries([1, 2, 3].map((r) => [r, db.settings.roundMinutes?.[r] ?? ROUND_MINUTES_RANGE.default]));
export const phaseSeconds = () => Object.fromEntries(PHASES.map((k) => [k, db.settings.phaseSeconds?.[k] ?? getFlow().find((p) => p.type === k)?.sec ?? 30]));

// Applies to students who have not started yet; anyone already playing keeps their schedule (use phaseTime for them).
export function setTiming({ minutes = {}, seconds = {} } = {}) {
  const m = {}, sec = {};
  for (const r of [1, 2, 3]) {
    m[r] = Math.round(Number(minutes[r]));
    if (!(m[r] >= ROUND_MINUTES_RANGE.min && m[r] <= ROUND_MINUTES_RANGE.max)) fail(`Round ${r} must be between ${ROUND_MINUTES_RANGE.min} and ${ROUND_MINUTES_RANGE.max} minutes.`);
  }
  for (const k of PHASES) {
    sec[k] = Math.round(Number(seconds[k]));
    if (!(sec[k] >= PHASE_SECONDS_RANGE.min && sec[k] <= PHASE_SECONDS_RANGE.max)) fail(`Each screen between rounds must last ${PHASE_SECONDS_RANGE.min}–${PHASE_SECONDS_RANGE.max} seconds.`);
  }
  db.settings.roundMinutes = m;
  db.settings.phaseSeconds = sec;
  save(true);
}

// ---------- Round 3 target kinds (text and image at random, or one kind only) ----------
export const r3Mode = () => db.settings.r3Mode || 'mixed';
export function setR3Mode(mode) {
  if (!R3_MODES.some((m) => m.id === mode)) fail('Choose text, image or both.');
  db.settings.r3Mode = mode;
  save(true);
}

// ---------- students ----------
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  let c;
  do c = `BZ-${Array.from({ length: 5 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('')}`;
  while (db.students.some((s) => s.code === c));
  return c;
}

export const studentsOf = (email) => db.students.filter((s) => s.email === email);
const studentById = (id) => db.students.find((s) => s.id === id);
const schoolName = (id) => db.schools.find((s) => s.id === id)?.name || '—';
export const displayName = (s) => {
  const [first, ...rest] = s.name.trim().split(/\s+/);
  return rest.length ? `${first} ${rest.at(-1)[0].toUpperCase()}.` : first;
};

export function createStudent(email, { name, grade, schoolId }) {
  name = clip(name, 60).replace(/\s+/g, ' ').trim();
  grade = Number(grade);
  if (name.length < 2) fail('Please enter the student’s name.');
  if (!GRADES.includes(grade)) fail('Please choose a grade between 3 and 12.');
  if (!db.schools.some((s) => s.id === schoolId)) fail('Please choose a school.');
  if (studentsOf(email).some((s) => s.name.toLowerCase() === name.toLowerCase() && s.grade === grade)) fail('This student already exists for your account.');
  const s = { id: uid('st_'), code: newCode(), email, name, grade, schoolId, createdAt: now(), lockedAt: null };
  db.students.push(s);
  save(true);
  return s;
}

// ---------- attempts ----------
export const currentAttempt = (studentId, eventId = activeEvent().id) =>
  db.attempts.find((a) => a.studentId === studentId && a.eventId === eventId && !a.archived);

function ensureAttempt(student) {
  let a = currentAttempt(student.id);
  if (!a) {
    a = { id: uid('at_'), studentId: student.id, eventId: activeEvent().id, status: 'waiting', createdAt: now(),
      startedAt: null, pausedAt: null, pausedMs: 0, endedAt: null, deviceId: null, lastSeen: null, acks: {}, rounds: {} };
    db.attempts.push(a);
    save();
  }
  return a;
}

// A session (one signed-in device) locks onto one student. It cannot switch while that student's test is live.
export const liveStudentOf = (email) => studentsOf(email).find((st) => { const a = currentAttempt(st.id); return a && LIVE.includes(a.status); });

export function selectStudent(session, studentId) {
  const s = studentById(studentId);
  if (!s || s.email !== session.email) fail('Student not found.', 404);
  const live = liveStudentOf(session.email); // holds even after signing in again on another device
  if (live && live.id !== s.id) fail('A test is in progress for another student on this account — you can switch once it ends.', 409);
  session.studentId = s.id;
  s.lockedAt ??= now();
  ensureAttempt(s);
  save(true);
}

export function releaseStudent(session) {
  const a = session.studentId && currentAttempt(session.studentId);
  if (a && LIVE.includes(a.status)) fail('The test has started — you can’t change the student now.', 409);
  session.studentId = null;
  save();
}

function mine(session) {
  const student = session.studentId && studentById(session.studentId);
  if (!student) fail('Choose a student first.', 409, 'no-student');
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
  if (p.type === 'welcome') return secs.every((x) => x === secs[0]) ? text.replace(/\beight minutes each\b/i, `${minutesText(secs[0])} each`) : text.replace(/Three rounds, eight minutes each\./i, 'Three timed rounds.');
  return text;
}

export function phaseOf(a, t = now()) {
  if (a.status === 'waiting') return { type: 'waiting' };
  if (a.status === 'stopped' || a.status === 'finished') return { type: 'done', round: 3 };
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

// ---------- question sets (same set for every player in an event + band) ----------
const setById = (id) => db.sets.find((s) => s.id === id);

// A run is one group of students who were started together: they share one question set per band and round.
// A later start can reuse that run's questions ("same") or begin a new run with freshly drawn ones ("new").
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
      const parts = a.rounds[r]?.score?.parts || {};
      for (const def of SCORE_PARTS[r]) if (parts[def.key]?.points != null) { got += parts[def.key].points; max += def.max; }
    }
  }
  return max ? got / max : null;
}

function ensureSet(run, band, round) {
  let s = db.sets.find((x) => runOf(x) === run && x.band === band && x.round === round);
  if (!s) {
    s = { id: uid('set_'), eventId: activeEvent().id, runId: run, ...drawRound(round, band, round === 1 ? null : bandPerformance(run, band, round), { r3Mode: r3Mode() }) };
    db.sets.push(s);
    save(true);
  }
  return s;
}

function openRound(a, r) {
  if (a.rounds[r]) return a.rounds[r];
  for (let k = 1; k < r; k++) finalize(a, k, 'time'); // earlier rounds count towards the adaptive draw
  const student = studentById(a.studentId);
  const set = ensureSet(runOf(a), bandOf(student.grade), r);
  a.rounds[r] = { setId: set.id, openedAt: now(), draft: {}, savedAt: null, submittedAt: null, lifelines: { used: [], data: {} }, generations: [], score: null };
  save();
  return a.rounds[r];
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
  const res = scoreRound(r, set.content, rec.draft, grade, (later) => {
    for (const [k, v] of Object.entries(later)) if (rec.score.parts[k]?.by !== 'admin') rec.score.parts[k] = { ...v, by: v.note?.startsWith('AI') ? 'ai' : 'auto' };
    rec.score.pending = false;
    save(true);
  });
  rec.score = { parts: Object.fromEntries(Object.entries(res.parts).map(([k, v]) => [k, { ...v, by: 'auto' }])), pending: res.pending };
  save(true);
}

// Runs every second: opens rounds on schedule, auto-submits at cutoff, finishes completed attempts.
export function tick() {
  const t = now();
  const live = db.attempts.filter((a) => a.status === 'running' && !a.archived);
  // Pass 1: close every round that is past its cutoff, so adaptive draws in pass 2 see all scores.
  for (const a of live) {
    for (const r of [1, 2, 3]) {
      if (a.rounds[r] && !a.rounds[r].submittedAt && elapsed(a, t) >= roundWindow(a, r).end + SAVE_GRACE_MS) finalize(a, r, 'time');
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

function cleanDraft(r, d = {}) {
  if (r === 1) {
    return { answers: Object.fromEntries(Object.entries(d.answers || {}).slice(0, 20).map(([k, v]) => [clip(k, 60), clip(v, 2)])), bossWhy: clip(d.bossWhy) };
  }
  if (r === 2) {
    const rb = d.rebuild || {};
    return { rebuild: { goal: clip(rb.goal, 4), audience: clip(rb.audience, 4), include: clip(rb.include, 4), format: clip(rb.format, 4) },
      spot: { paragraph: clip(d.spot?.paragraph, 4), why: clip(d.spot?.why) }, match: { evidence: clip(d.match?.evidence, 4), why: clip(d.match?.why) },
      repair: { text: clip(d.repair?.text), why: clip(d.repair?.why) } };
  }
  return { prompt: clip(d.prompt, 3000), c1: clip(d.c1, 400), c2: clip(d.c2, 400), c3: clip(d.c3, 400), finalPick: clip(d.finalPick, 2) };
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

function summary(a) {
  const rounds = [1, 2, 3].map((r) => {
    const rec = a.rounds[r];
    if (!rec?.submittedAt) return { round: r, name: ROUNDS[r].name, state: rec ? 'open' : 'not started', total: null, max: ROUNDS[r].max };
    return { round: r, name: ROUNDS[r].name, state: rec.score?.pending ? 'pending' : 'scored', total: roundTotal(rec), max: ROUNDS[r].max };
  });
  return { rounds, total: rounds.reduce((s, r) => s + (r.total || 0), 0), pending: rounds.some((r) => r.state === 'pending') };
}

function stateFor(a, student, extra = {}) {
  const ph = phaseOf(a);
  const rec = ph.round ? a.rounds[ph.round] : null;
  return {
    attemptId: a.id, scorecard: Boolean(approvedCardOf(student.id)),
    student: { id: student.id, code: student.code, name: student.name, grade: student.grade, band: bandOf(student.grade), school: schoolName(student.schoolId) },
    status: a.status, paused: Boolean(a.pausedAt), phase: ph, acks: a.acks,
    roundSeconds: Object.fromEntries([1, 2, 3].map((r) => [r, flowOf(a).find((p) => p.key === `r${r}`)?.sec])), request: requestFor(a, student.id),
    round: rec && { submitted: Boolean(rec.submittedAt), savedAt: rec.savedAt },
    results: summary(a), final: activeEvent().finalPublished, ...extra,
  };
}

// ---------- student API ----------
export function playState(session) {
  const { student, attempt } = mine(session);
  return stateFor(attempt, student);
}

function checkDevice(a, deviceId) {
  if (!deviceId) fail('Missing device id.');
  if (a.deviceId && a.deviceId !== deviceId && LIVE.includes(a.status)) fail('This test is open on another device.', 409, 'device');
  a.deviceId = deviceId;
  a.lastSeen = now();
}

export function sync(session, { deviceId, round, draft, ack }) {
  const { student, attempt: a } = mine(session);
  checkDevice(a, deviceId);
  if (ack && /^[a-z0-9-]{1,20}$/.test(ack)) a.acks[ack] = a.acks[ack] || now();
  const ph = phaseOf(a);
  if (ph.type === 'round' && a.status === 'running') openRound(a, ph.round);
  const saved = round && draft ? saveDraft(a, Number(round), draft) : null;
  save();
  return stateFor(a, student, { saved });
}

export function takeover(session, deviceId) {
  const { student, attempt: a } = mine(session);
  a.deviceId = deviceId;
  a.lastSeen = now();
  save();
  return stateFor(a, student);
}

function liveRound(session, deviceId) {
  const { student, attempt: a } = mine(session);
  checkDevice(a, deviceId);
  const ph = phaseOf(a);
  if (ph.type !== 'round') fail('No round is open right now.', 409);
  const rec = openRound(a, ph.round);
  return { student, a, r: ph.round, rec, set: setById(rec.setId) };
}

export function roundContent(session, deviceId) {
  const { r, rec, set } = liveRound(session, deviceId);
  return { round: r, view: publicView(set), draft: rec.draft, submitted: Boolean(rec.submittedAt), savedAt: rec.savedAt,
    lifelines: rec.lifelines, generations: rec.generations.filter((g) => g.output), generationsLeft: R3_GENERATIONS - rec.generations.length };
}

export function useLifeline(session, { deviceId, id, target }) {
  const { a, r, rec, set } = liveRound(session, deviceId);
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
      if (q.options.length < 4) fail('50–50 works on four-option questions only.');
      let hide = q.hide.filter((h) => h !== q.key && q.options.some((o) => o.id === h));
      if (hide.length < 2) hide = q.options.map((o) => o.id).filter((o) => o !== q.key).sort(() => crypto.randomInt(3) - 1).slice(0, 2);
      data = { target, hide: hide.slice(0, 2) };
    } else data = { target, text: q.clue };
  } else if (r === 2) {
    if (id === 'compass') data = { text: c.case.compass };
    else {
      const p = c.case.puzzles[target];
      if (!p) fail('Choose a puzzle first.');
      data = { target, text: p.clue };
    }
  } else data = { text: id === 'goal' ? c.target.goalLens : c.target.structureScan };
  rec.lifelines.used.push(id);
  rec.lifelines.data[id] = data;
  save();
  return rec.lifelines;
}

export function submitRound(session, { deviceId, round, draft }) {
  const { a, r, rec, student } = liveRound(session, deviceId);
  if (Number(round) !== r) fail('That round is no longer open.', 409);
  if (draft) {
    const res = saveDraft(a, r, draft);
    if (!res.ok && !rec.submittedAt) fail(res.reason, 409);
  }
  finalize(a, r, 'submitted');
  return stateFor(a, student);
}

export async function generateR3(session, { deviceId, prompt }) {
  const { a, r, rec, student } = liveRound(session, deviceId);
  if (r !== 3 || rec.submittedAt || a.status !== 'running') fail('The AI tool is only available during Round 3.');
  if (setById(rec.setId).content.target?.type === 'image') fail('This target is a picture, so there is no AI tool here. Write your prompt and your three connections.');
  prompt = clip(prompt, 3000).trim();
  if (prompt.length < 5) fail('Write your prompt first.');
  if (rec.generations.length >= R3_GENERATIONS) fail(`You have used both AI generations.`);
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

// ---------- admin controls ----------
export function control(action, studentIds, { questions } = {}) {
  const ev = activeEvent();
  const out = { done: 0, skipped: 0, errors: [] };
  let run = null; // everyone started by one press of Start shares this run
  const t = now();
  for (const id of new Set(studentIds)) {
    const s = studentById(id);
    const a = s && currentAttempt(s.id, ev.id);
    if (!a) { out.skipped++; continue; }
    if (action === 'start' && a.status === 'waiting') {
      const band = bandOf(s.grade);
      const problems = bandProblems(band, r3Mode());
      if (problems.length) { out.errors.push(`${BANDS.find((b) => b.id === band).label}: ${problems.join(', ')}`); continue; }
      run ||= (questions === 'same' && runs().at(-1)?.id) || uid('run_');
      ensureSet(run, band, 1);
      Object.assign(a, { status: 'running', runId: run, startedAt: t, pausedAt: null, pausedMs: 0, flow: getFlow().map(({ key, type, round, sec, title, script }) => ({ key, type, round, sec: type === 'round' ? roundMinutes()[round] * 60 : phaseSeconds()[type], title, script })) });
    } else if (action === 'pause' && a.status === 'running') {
      Object.assign(a, { status: 'paused', pausedAt: t });
    } else if (action === 'resume' && a.status === 'paused') {
      Object.assign(a, { status: 'running', pausedMs: a.pausedMs + (t - a.pausedAt), pausedAt: null });
    } else if (action === 'stop' && LIVE.includes(a.status)) {
      if (a.pausedAt) { a.pausedMs += t - a.pausedAt; a.pausedAt = null; }
      for (const r of [1, 2, 3]) finalize(a, r, 'stopped');
      Object.assign(a, { status: 'stopped', endedAt: t });
    } else { out.skipped++; continue; }
    out.done++;
  }
  out.errors = [...new Set(out.errors)];
  save(true);
  return out;
}

export function enableReattempt(studentId) {
  const a = currentAttempt(studentId);
  if (a && LIVE.includes(a.status)) fail('Stop this student’s test before enabling a reattempt.');
  if (a) { a.archived = true; a.archivedAt = now(); }
  const s = studentById(studentId);
  if (s) ensureAttempt(s);
  for (const r of db.requests) if (r.studentId === studentId && r.status === 'pending') Object.assign(r, { status: 'approved', decidedAt: now(), decidedBy: 'admin' });
  save(true);
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

export function requestReattempt(session, note) {
  const { student, attempt: a } = mine(session);
  if (!['finished', 'stopped'].includes(a.status)) fail('You can ask for another attempt once your test has ended.', 409);
  if (db.requests.some((r) => r.studentId === student.id && r.status === 'pending')) fail('Your request is already waiting for the host.', 409);
  db.requests.push({ id: uid('rq_'), studentId: student.id, attemptId: a.id, note: clip(note, 500).trim(), status: 'pending',
    createdAt: now(), decidedAt: null, decidedBy: '', reply: '' });
  save(true);
}

export const pendingRequests = () => db.requests.filter((r) => r.status === 'pending').length;

export function listRequests() {
  return db.requests.map((r) => {
    const s = studentById(r.studentId), a = db.attempts.find((x) => x.id === r.attemptId), sum = a && summary(a);
    return { id: r.id, status: r.status, note: r.note, reply: r.reply, createdAt: r.createdAt, decidedAt: r.decidedAt, decidedBy: r.decidedBy,
      student: { id: s.id, code: s.code, name: s.name, grade: s.grade, band: bandOf(s.grade), school: schoolName(s.schoolId) }, total: sum?.total ?? null };
  }).sort((x, y) => (x.status === 'pending' ? 0 : 1) - (y.status === 'pending' ? 0 : 1) || y.createdAt - x.createdAt);
}

export function decideRequest(id, approve, reply, adminEmail) {
  const r = db.requests.find((x) => x.id === id);
  if (!r) fail('Request not found.', 404);
  if (r.status !== 'pending') fail('This request has already been answered.', 409);
  const current = currentAttempt(r.studentId);
  if (approve && current?.id === r.attemptId) enableReattempt(r.studentId); // otherwise a reattempt was already opened for them
  Object.assign(r, { status: approve ? 'approved' : 'rejected', decidedAt: now(), decidedBy: adminEmail, reply: clip(reply, 500).trim() });
  save(true);
}

// ---------- add time to / end a round, briefing or break (live students only) ----------
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
    a.flow ||= getFlow().map((p) => ({ ...p }));
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
  for (const def of SCORE_PARTS[round]) {
    if (parts[def.key] == null || parts[def.key] === '') continue;
    const points = Math.max(0, Math.min(def.max, Math.round(Number(parts[def.key]) || 0)));
    rec.score.parts[def.key] = { ...rec.score.parts[def.key], points, by: 'admin' };
  }
  rec.score.pending = false;
  rec.reviewedAt = now();
  save(true);
}

// A target picture is served only to the student it was drawn for (or to an admin).
export function targetImage(session, imageId) {
  const student = session.studentId && studentById(session.studentId);
  const a = student && currentAttempt(student.id);
  const rec = a?.rounds[3];
  if (!rec || setById(rec.setId)?.content.target?.imageId !== imageId) fail('Not available.', 404);
  return imageFor(imageId);
}

// ---------- score cards ----------
// A card is computed from the saved answers; the admin can edit any field, then approve it. Only approved cards reach students.
const attemptById = (id) => db.attempts.find((x) => x.id === id);
export const attemptCard = (attemptId) => { const a = attemptById(attemptId); return a && scorecard(a); };
export function cardHtml(attemptId) {
  const card = attemptCard(attemptId);
  if (!card) fail('There is no score card for this attempt yet — it needs at least one scored round from the current question bank.', 404);
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

// Rows for the admin's Score cards tab.
export const cardRows = () => scorecards().map((c) => ({ attemptId: c.attemptId, studentId: c.studentId, name: c.name, code: c.code, grade: c.grade, school: c.school,
  email: c.email, total: c.total, status: c.status, edited: c.edited, approved: c.approved, emailedAt: c.emailedAt, emailedTo: c.emailedTo, changedSinceEmailed: c.changedSinceEmailed,
  archived: c.archived, run: runs().find((r) => r.id === c.run)?.number ?? '' }));

const approvedCardOf = (studentId) => db.attempts.filter((x) => x.studentId === studentId).sort((x, y) => y.createdAt - x.createdAt).map(scorecard).find((c) => c?.approved) || null;
export const studentCard = (session) => (session.studentId ? approvedCardOf(session.studentId) : null);

// ---------- reporting ----------
const optText = (q, id) => (id ? `${id}. ${q.options.find((o) => o.id === id)?.text || ''}` : '—');

export function answerDetail(a) {
  const out = [];
  for (const r of [1, 2, 3]) {
    const rec = a.rounds[r];
    if (!rec) continue;
    const c = setById(rec.setId).content, d = rec.draft || {}, p = rec.score?.parts || {};
    const pts = (k) => p[k]?.points ?? null;
    const row = (id, part, question, answer, correct, points, max, extra = {}) => out.push({ round: r, id, part, question, answer: answer || '—', correct, points, max, by: p[part]?.by || '', note: p[part]?.note || '', ...extra });
    if (r === 1) {
      for (const q of c.items) row(q.id, 'quick', q.question, optText(q, d.answers?.[q.id]), optText(q, q.key), p.quick?.items?.[q.id] ?? null, 2,
        { lifeline: Object.values(rec.lifelines.data).some((l) => l.target === q.id) });
      row(c.boss.id, 'bossChoice', c.boss.question, optText(c.boss, d.answers?.[c.boss.id]), optText(c.boss, c.boss.key), pts('bossChoice'), 2);
      row(`${c.boss.id} · why`, 'bossWhy', 'Explain why it is the best choice', d.bossWhy, c.boss.explanation, pts('bossWhy'), 2);
    } else if (r === 2) {
      const k = c.case, pz = k.puzzles;
      row(`${k.id} · rebuild`, 'rebuild', pz.rebuild.task, ['goal', 'audience', 'include', 'format'].map((s) => d.rebuild?.[s] || '?').join(' → '), pz.rebuild.order.join(' → '), pts('rebuild'), 5);
      row(`${k.id} · spot`, 'spotId', pz.spot.task, d.spot?.paragraph, `${pz.spot.paragraph}: ${pz.spot.claim}`, pts('spotId'), 2);
      row(`${k.id} · spot why`, 'spotWhy', 'Explain the problem', d.spot?.why, pz.spot.reason, pts('spotWhy'), 3);
      row(`${k.id} · match`, 'matchId', pz.match.task, d.match?.evidence, pz.match.evidenceId, pts('matchId'), 2);
      row(`${k.id} · match why`, 'matchWhy', 'Explain how it helps', d.match?.why, pz.match.connection, pts('matchWhy'), 3);
      row(`${k.id} · repair`, 'repairFix', pz.repair.task, d.repair?.text, pz.repair.expected, pts('repairFix'), 3);
      row(`${k.id} · repair why`, 'repairWhy', 'Why your fix works', d.repair?.why, pz.repair.rubric, pts('repairWhy'), 2);
    } else {
      const t = c.target;
      const promptPts = ['purpose', 'content', 'format', 'clarity'].reduce((s, k) => (pts(k) == null ? s : (s ?? 0) + pts(k)), null);
      row(`${t.id} · prompt`, 'purpose', `Write a prompt for: ${t.title}`, d.prompt, t.example, promptPts, 16);
      row(`${t.id} · rationale`, 'rationale', 'Three prompt-to-target connections', [d.c1, d.c2, d.c3].filter(Boolean).join(' / '), t.rubric, pts('rationale'), 4);
      rec.generations.forEach((g, i) => row(`${t.id} · AI ${i + 1}`, '', `AI generation ${i + 1}: ${g.prompt}`, g.output, '', null, null));
      const pick = rec.generations[Number(d.finalPick)];
      if (pick) row(`${t.id} · final`, '', 'Chosen final creation (AI result)', pick.output, '', null, null);
    }
  }
  return out;
}

function resultRows(ev = activeEvent()) {
  return db.attempts.filter((a) => a.eventId === ev.id && !a.archived && a.status !== 'waiting').map((a) => {
    const s = studentById(a.studentId), sum = summary(a);
    const [r1, r2, r3] = sum.rounds.map((x) => x.total);
    return { a, s, run: runOf(a), band: bandOf(s.grade), school: schoolName(s.schoolId), r1, r2, r3, total: sum.total, pending: sum.pending,
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

export function analytics() {
  const ev = activeEvent();
  const attempts = db.attempts.filter((a) => a.eventId === ev.id && !a.archived);
  const rows = resultRows(ev);
  const done = rows.filter((x) => ['finished', 'stopped'].includes(x.a.status) && !x.pending);
  const avg = (xs) => (xs.length ? Math.round((xs.reduce((s, v) => s + v, 0) / xs.length) * 10) / 10 : null);
  const items = [];
  for (const set of db.sets.filter((s) => s.eventId === ev.id && s.round === 1)) {
    for (const q of [...set.content.items, set.content.boss]) {
      const recs = attempts.map((a) => a.rounds[1]).filter((r) => r?.setId === set.id && r.submittedAt);
      const answered = recs.filter((r) => r.draft.answers?.[q.id]).length;
      const correct = recs.filter((r) => r.draft.answers?.[q.id] === q.key).length;
      const lifelines = recs.filter((r) => Object.values(r.lifelines.data).some((l) => l.target === q.id)).length;
      items.push({ band: set.band, id: q.id, skill: q.skill || 'boss', difficulty: q.difficulty, attempts: recs.length, answered, correct,
        pctCorrect: recs.length ? Math.round((correct / recs.length) * 100) : null, lifelines });
    }
  }
  const partAvgs = Object.fromEntries([1, 2, 3].map((r) => [r, SCORE_PARTS[r].map((def) => ({ ...def,
    avg: avg(attempts.map((a) => a.rounds[r]?.score?.parts?.[def.key]?.points).filter((v) => v != null)) }))]));
  const lifelineUse = {};
  for (const a of attempts) for (const r of [1, 2, 3]) for (const id of a.rounds[r]?.lifelines?.used || []) lifelineUse[id] = (lifelineUse[id] || 0) + 1;
  return {
    event: ev.name,
    kpis: { registered: db.students.length, lobby: attempts.filter((a) => a.status === 'waiting').length,
      live: attempts.filter((a) => LIVE.includes(a.status)).length, finished: rows.filter((x) => ['finished', 'stopped'].includes(x.a.status)).length,
      avgTotal: avg(done.map((x) => x.total)) },
    rounds: [1, 2, 3].map((r) => ({ round: r, name: ROUNDS[r].name, max: 20, avg: avg(rows.map((x) => x[`r${r}`]).filter((v) => v != null)) })),
    distribution: [0, 10, 20, 30, 40, 50].map((lo) => ({ label: `${lo}–${lo === 50 ? 60 : lo + 9}`, count: done.filter((x) => x.total >= lo && (lo === 50 ? x.total <= 60 : x.total < lo + 10)).length })),
    schools: db.schools.map((sc) => {
      const mineRows = done.filter((x) => x.s.schoolId === sc.id);
      return { name: sc.name, students: db.students.filter((s) => s.schoolId === sc.id).length, finished: mineRows.length, avg: avg(mineRows.map((x) => x.total)) };
    }),
    bands: BANDS.map((b) => ({ label: b.label, finished: done.filter((x) => x.band === b.id).length, avg: avg(done.filter((x) => x.band === b.id).map((x) => x.total)),
      levels: db.sets.filter((s) => s.eventId === ev.id && s.band === b.id).map((s) => `R${s.round}: ${s.level}`).join(', ') })),
    parts: partAvgs, items, lifelineUse,
  };
}

// Tabs used for both the Google Sheet mirror and the Excel download.
export function reportTabs() {
  const ev = activeEvent();
  const tabs = {
    Results: [['Event', 'Code', 'Name', 'School', 'Grade', 'Band', 'Status', 'Started', 'Ended', 'R1 AI Blitz', 'R2 AI Case', 'R3 Creator', 'Total /60', 'Scoring', 'Reviewed', 'Run']],
    Answers: [['Event', 'School', 'Band', 'Grade', 'Code', 'Name', 'Round', 'Question / part ID', 'Question', 'Student answer', 'Correct answer / reference', 'Points', 'Max', 'Marked by', 'Marker note']],
    Students: [['Code', 'Name', 'Grade', 'Band', 'School', 'Account email', 'Created', 'Locked in']],
    Schools: [['School ID', 'Name', 'Students']],
    'Question Sets': [['Event', 'Band', 'Round', 'Difficulty basis', 'Band avg before draw', 'Item IDs', 'Bank version', 'Seed', 'Drawn at']],
    Admins: [['Email', 'Added by', 'Added at']],
    Scorecards: [['Code', 'Name', 'Grade', 'School', 'Status', 'Total /60', 'Round 1', 'Round 2', 'Round 3', ...Object.keys(getSkillsList()).map((id) => `${id} %`), 'Strength', 'Next step']],
    'Reattempt Requests': [['Code', 'Name', 'School', 'Student note', 'Status', 'Host reply', 'Requested', 'Decided', 'Decided by']],
  };
  for (const x of resultRows(ev)) {
    tabs.Results.push([ev.name, x.s.code, x.s.name, x.school, x.s.grade, x.band, x.a.status, iso(x.a.startedAt), iso(x.a.endedAt),
      x.r1 ?? '', x.r2 ?? '', x.r3 ?? '', x.total, x.pending ? 'pending' : ev.finalPublished ? 'final' : 'provisional', x.reviewed ? 'yes' : 'no', runs().find((r) => r.id === x.run)?.number ?? '']);
    for (const d of answerDetail(x.a)) {
      tabs.Answers.push([ev.name, x.school, x.band, x.s.grade, x.s.code, x.s.name, d.round, d.id, d.question, d.answer, d.correct, d.points ?? '', d.max ?? '', d.by, d.note]);
    }
  }
  for (const s of db.students) tabs.Students.push([s.code, s.name, s.grade, bandOf(s.grade), schoolName(s.schoolId), s.email, iso(s.createdAt), iso(s.lockedAt)]);
  for (const sc of db.schools) tabs.Schools.push([sc.id, sc.name, db.students.filter((s) => s.schoolId === sc.id).length]);
  for (const st of db.sets) {
    const c = st.content;
    const ids = st.round === 1 ? [...c.items.map((q) => q.id), c.boss.id] : st.round === 2 ? [c.case.id] : [c.target.id];
    tabs['Question Sets'].push([db.events.find((e) => e.id === st.eventId)?.name || '', st.band, st.round, st.level,
      st.perf == null ? '' : `${Math.round(st.perf * 100)}%`, ids.join(', '), String(st.bankVersion || ''), st.seed, iso(st.drawnAt)]);
  }
  for (const r of listRequests()) tabs['Reattempt Requests'].push([r.student.code, r.student.name, r.student.school, r.note, r.status, r.reply, iso(r.createdAt), iso(r.decidedAt), r.decidedBy]);
  for (const c of scorecards()) tabs.Scorecards.push([c.code, c.name, c.grade, c.school, c.status, c.total, ...c.rounds.map((v) => v ?? ''), ...Object.keys(getSkillsList()).map((id) => c.skills.find((k) => k.id === id)?.percent ?? ''), c.strength, c.nextStep]);
  tabs.Admins.push([env.defaultAdmin, 'default', '']);
  for (const a of db.admins) tabs.Admins.push([a.email, a.addedBy, iso(a.addedAt)]);
  return tabs;
}

export function exportWorkbook() {
  const wb = XLSX.utils.book_new();
  const an = analytics();
  const tabs = {
    Summary: [['Event', an.event], [], ['Registered', an.kpis.registered], ['Finished', an.kpis.finished], ['Average total /60', an.kpis.avgTotal ?? ''], [],
      ['Round', 'Average /20'], ...an.rounds.map((r) => [r.name, r.avg ?? '']), [],
      ['School', 'Students', 'Finished', 'Average /60'], ...an.schools.map((s) => [s.name, s.students, s.finished, s.avg ?? '']), [],
      ['Band', 'Finished', 'Average /60', 'Difficulty drawn'], ...an.bands.map((b) => [b.label, b.finished, b.avg ?? '', b.levels])],
    'Item Analysis': [['Band', 'Question ID', 'Skill', 'Difficulty', 'Attempts', 'Answered', 'Correct', '% correct', 'Lifeline used'],
      ...an.items.map((i) => [i.band, i.id, i.skill, i.difficulty, i.attempts, i.answered, i.correct, i.pctCorrect ?? '', i.lifelines])],
    ...reportTabs(),
  };
  for (const [name, rows] of Object.entries(tabs)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// The readable tabs kept in the Google Sheet next to the data tabs (see store.js).
export const reports = () => { const t = reportTabs(); return { Results: t.Results, Answers: t.Answers }; };
