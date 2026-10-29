import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { env, APP_NAME, BANDS, GRADES, ROUNDS, RULES, R3_MODES, SCORE_PARTS, LIFELINES_PER_ROUND, R3_GENERATIONS, SESSION_DAYS, BANK_REFRESH_MS, POLICY_VERSION, bandOf } from './config.js';
import { db, save, uid, initStore, setReports, setCards } from './store.js';
import { authUrl, exchangeCode } from './google.js';
import { loadBank, loadFlow, bankInfo, bandProblems, getFlow, imageFor } from './bank.js';
import { aiEnabled } from './scoring.js';
import * as game from './game.js';
import { cardPdf, cardFileName, cardsZip, emailReady, sendCards, sendTestEmail } from './deliver.js';

const app = express();
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.resolve('public'), { extensions: ['html'], setHeaders: (res) => res.set('Cache-Control', 'no-cache') })); // browsers re-check, so an update shows on the next load

// ---------- sessions: a signed cookie that carries the whole session, so nothing is lost when the server restarts ----------
const sign = (v) => `${v}.${crypto.createHmac('sha256', env.sessionSecret).update(v).digest('base64url')}`;
const unsign = (s) => { const v = String(s || '').split('.')[0]; return s && sign(v) === s ? v : null; };
const secure = env.baseUrl.startsWith('https');
const cookie = (name, value, maxAge) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
const readCookie = (req, name) => (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);

const sessionCookie = (s) => cookie('pt', sign(Buffer.from(JSON.stringify(s)).toString('base64url')), SESSION_DAYS * 86400);
const issue = (res, s) => { res.append('Set-Cookie', sessionCookie(s)); };

function session(req) {
  const v = unsign(readCookie(req, 'pt'));
  if (!v) return null;
  try {
    const s = JSON.parse(Buffer.from(v, 'base64url').toString());
    return s.email && s.exp > Date.now() ? s : null;
  } catch { return null; }
}
const role = (s) => (game.isAdmin(s.email) ? 'admin' : 'student');
function need(kind) {
  return (req, res, next) => {
    const s = session(req);
    if (!s) return res.status(401).json({ error: 'Please sign in again.' });
    if (kind === 'admin' && role(s) !== 'admin') return res.status(403).json({ error: 'Admins only.' });
    if (kind === 'student' && role(s) !== 'student') return res.status(403).json({ error: 'Students only.' });
    req.s = s;
    next();
  };
}

// ---------- Google sign-in (identity only — students and admins use the same flow) ----------
app.get('/auth/google', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie', cookie('pt_state', state, 600));
  res.redirect(authUrl(state));
});

const finishSignIn = (exchange) => async (req, res) => {
  const expected = readCookie(req, 'pt_state');
  if (!req.query.code || !expected || req.query.state !== expected) return res.redirect('/?error=signin');
  try {
    const who = await exchange(req.query.code);
    res.setHeader('Set-Cookie', cookie('pt_state', '', 0));
    issue(res, { email: who.email, name: who.name, picture: who.picture, studentId: null, exp: Date.now() + SESSION_DAYS * 864e5 });
    res.redirect('/#/');
  } catch (err) {
    console.error('Sign-in failed:', err.message);
    res.redirect('/?error=signin');
  }
};
app.get('/auth/callback', finishSignIn(exchangeCode));

app.post('/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', cookie('pt', '', 0));
  res.json({ ok: true });
});

// ---------- public ----------
app.get('/api/config', (req, res) => {
  res.json({ app: APP_NAME, bands: BANDS.map(({ id, label }) => ({ id, label })), grades: GRADES, rounds: ROUNDS, rules: RULES,
    roundMinutes: game.roundMinutes(), scoreParts: SCORE_PARTS, lifelinesPerRound: LIFELINES_PER_ROUND, generations: R3_GENERATIONS, aiTool: aiEnabled(),
    flow: getFlow().map(({ key, type, round, sec, title }) => ({ key, type, round, sec, title })), googleReady: Boolean(env.googleClientId), contact: env.contactEmail, policyVersion: POLICY_VERSION });
});

// Anyone (a parent, a student, a teacher) may ask for a child's data to be erased; no sign-in needed.
app.post('/api/deletion', (req, res) => res.json(game.requestDeletion(session(req)?.email, req.body)));

app.get('/api/me', (req, res) => {
  const s = session(req);
  if (!s) return res.json({ signedIn: false });
  const out = { signedIn: true, email: s.email, name: s.name, picture: s.picture, role: role(s) };
  if (out.role === 'student') {
    const live = game.liveStudentOf(s.email); // a test in progress stays with its student, on any device
    if (live && s.studentId !== live.id) { s.studentId = live.id; issue(res, s); }
    out.studentId = s.studentId;
    out.students = game.studentsOf(s.email).map((st) => {
      const a = game.currentAttempt(st.id);
      return { id: st.id, code: st.code, name: st.name, grade: st.grade, band: bandOf(st.grade), school: db.schools.find((x) => x.id === st.schoolId)?.name, status: a ? game.statusOf(a) : 'new', redoRound: a?.status === 'waiting' ? a.redo?.round || null : null };
    });
    out.schools = db.schools.map(({ id, name }) => ({ id, name }));
  }
  res.json(out);
});

// ---------- student ----------
const S = need('student');
app.post('/api/play/leave', S, (req, res) => res.json(game.leaveWindow(req.s, req.body.deviceId)));
app.post('/api/play/lock-request', S, (req, res) => res.json(game.lockRequest(req.s, req.body.note)));
app.post('/api/students', S, (req, res) => res.json(game.createStudent(req.s.email, req.body)));
app.post('/api/students/select', S, (req, res) => { game.selectStudent(req.s, req.body.studentId); issue(res, req.s); res.json(game.playState(req.s)); });
app.post('/api/students/release', S, (req, res) => { game.releaseStudent(req.s); issue(res, req.s); res.json({ ok: true }); });
app.post('/api/students/reattempt-request', S, (req, res) => { game.requestReattempt(req.s, req.body.note); res.json(game.playState(req.s)); });
app.get('/api/play', S, (req, res) => res.json(game.playState(req.s)));
app.post('/api/play/sync', S, (req, res) => res.json(game.sync(req.s, req.body)));
app.post('/api/play/takeover', S, (req, res) => res.json(game.takeover(req.s, req.body.deviceId)));
app.get('/api/play/image/:id', S, (req, res) => {
  const img = game.targetImage(req.s, req.params.id);
  res.type(img.type).set('Cache-Control', 'private, max-age=3600').send(img.buf);
});
app.get('/api/play/scorecard', S, (req, res) => {
  const card = game.studentCard(req.s);
  if (!card) return res.status(404).json({ error: 'Your score card is not ready yet.' });
  res.type('html').send(game.cardHtml(card.attemptId));
});
app.get('/api/play/scorecard.pdf', S, async (req, res) => {
  const card = game.studentCard(req.s);
  if (!card) return res.status(404).json({ error: 'Your score card is not ready yet.' });
  await pdfOf(res, card);
});
app.get('/api/play/round', S, (req, res) => res.json(game.roundContent(req.s, req.query.deviceId)));
app.post('/api/play/lifeline', S, (req, res) => res.json(game.useLifeline(req.s, req.body)));
app.post('/api/play/submit', S, (req, res) => res.json(game.submitRound(req.s, req.body)));
app.post('/api/play/generate', S, async (req, res) => res.json(await game.generateR3(req.s, req.body)));
app.get('/api/leaderboard', need(), (req, res) => {
  if (role(req.s) === 'admin') {
    const all = game.runs(), run = req.query.run === 'all' ? '' : req.query.run || all.at(-1)?.id || '';
    return res.json(game.leaderboard({ band: req.query.band || BANDS[0].id, schoolId: req.query.school || '', runId: run }));
  }
  const st = db.students.find((x) => x.id === req.s.studentId);
  if (!st) return res.status(409).json({ error: 'Choose a student first.' });
  const mine = game.currentAttempt(st.id); // students are ranked against the people who answered the same questions
  const all = Boolean(db.settings.lbAllSchools); // the admin decides whether students see other schools
  res.json({ ...game.leaderboard({ band: bandOf(st.grade), schoolId: all ? '' : st.schoolId, runId: mine ? game.runOf(mine) : '' }), scope: all ? 'all' : 'school' });
});

// ---------- admin ----------
const A = need('admin');
app.get('/api/admin/overview', A, (req, res) => {
  const ev = game.activeEvent();
  const students = db.students.map((s) => {
    const a = game.currentAttempt(s.id, ev.id);
    const ph = a ? game.phaseOf(a) : null;
    return { id: s.id, code: s.code, name: s.name, email: s.email, grade: s.grade, band: bandOf(s.grade), schoolId: s.schoolId,
      attemptId: a?.id, lock: a?.acks?._lock || null, status: a ? game.statusOf(a) : 'not joined', redoRound: a?.status === 'waiting' ? a.redo?.round || null : null, phase: ph && { type: ph.type, round: ph.round, title: ph.title, remainingMs: ph.remainingMs },
      scores: a && [1, 2, 3].map((r) => {
        const rec = a.rounds[r];
        return rec?.score ? { total: Object.values(rec.score.parts).reduce((t, p) => t + (p.points || 0), 0), pending: rec.score.pending } : null;
      }),
      reattempts: db.attempts.filter((x) => x.studentId === s.id && x.eventId === ev.id && x.archived).length };
  });
  res.json({ event: ev, schools: db.schools, admins: [{ email: env.defaultAdmin, fixed: true }, ...db.admins], students,
    runs: game.runs(), emailReady: emailReady(), pendingRequests: game.pendingRequests(), pendingLocks: game.pendingLocks(), pendingDeletions: db.deletions.filter((d) => d.status === 'open').length, roundMinutes: game.roundMinutes(), phaseSeconds: game.phaseSeconds(), lbAllSchools: Boolean(db.settings.lbAllSchools),
    bank: bankInfo()?.counts, bandProblems: Object.fromEntries(BANDS.map((b) => [b.id, bandProblems(b.id, game.r3Mode())])),
    r3Mode: game.r3Mode(), r3Modes: R3_MODES });

});

app.get('/api/admin/students/:id', A, (req, res) => {
  const s = db.students.find((x) => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  const attempts = db.attempts.filter((a) => a.studentId === s.id).sort((x, y) => y.createdAt - x.createdAt).map((a) => ({
    id: a.id, event: db.events.find((e) => e.id === a.eventId)?.name, status: a.status, archived: Boolean(a.archived), startedAt: a.startedAt, endedAt: a.endedAt,
    scores: Object.fromEntries(Object.entries(a.rounds).map(([r, rec]) => [r, rec.score])),
    lifelines: Object.fromEntries(Object.entries(a.rounds).map(([r, rec]) => [r, rec.lifelines.used])),
    answers: game.answerDetail(a) }));
  res.json({ student: { ...s, band: bandOf(s.grade), school: db.schools.find((x) => x.id === s.schoolId)?.name }, attempts });
});

app.post('/api/admin/control', A, (req, res) => {
  if (!['start', 'pause', 'resume', 'stop'].includes(req.body.action)) return res.status(400).json({ error: 'Unknown action' });
  res.json(game.control(req.body.action, req.body.studentIds || [], { questions: req.body.questions }));
});
const pdfOf = async (res, card) => {
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${cardFileName(card)}"` }).send(await cardPdf(card));
};
app.get('/api/admin/scorecard/:attemptId', A, (req, res) => res.type('html').send(game.cardHtml(req.params.attemptId)));
app.get('/api/admin/scorecard/:attemptId/pdf', A, async (req, res) => {
  const card = game.attemptCard(req.params.attemptId);
  if (!card) return res.status(404).json({ error: 'There is no score card for this attempt yet.' });
  await pdfOf(res, card);
});
app.get('/api/admin/scorecard/:attemptId/data', A, (req, res) => {
  const d = game.cardEditorData(req.params.attemptId);
  if (!d) return res.status(404).json({ error: 'There is no score card for this attempt yet.' });
  res.json(d);
});
app.post('/api/admin/scorecard/:attemptId', A, (req, res) => {
  const card = game.saveCardEdits(req.params.attemptId, req.body.edits);
  if (req.body.approve !== undefined) game.setCardApproval([req.params.attemptId], Boolean(req.body.approve), req.s.email);
  res.json({ card: game.attemptCard(req.params.attemptId) || card });
});
app.get('/api/admin/scorecards', A, (req, res) => res.json({ rows: game.cardRows(), emailReady: emailReady(), autoSend: Boolean(db.settings.cardAutoSend), from: env.smtpUser }));
app.post('/api/admin/scorecards/approve', A, (req, res) => {
  const ids = req.body.all ? game.cardRows().filter((c) => !c.archived && !c.approved && c.status !== 'pending').map((c) => c.attemptId) : req.body.attemptIds || [];
  const out = game.setCardApproval(ids, req.body.approved !== false, req.s.email);
  if (db.settings.cardAutoSend && emailReady() && out.ids.length && req.body.approved !== false) sendCards(out.ids, { by: req.s.email }).catch((err) => console.error('Automatic score-card email failed:', err.message));
  res.json(out);
});
app.post('/api/admin/scorecards/send', A, async (req, res) => {
  const ids = req.body.attemptIds || game.cardRows().filter((c) => c.approved).map((c) => c.attemptId);
  res.json(await sendCards(ids, { resend: Boolean(req.body.resend), by: req.s.email }));
});
app.post('/api/admin/scorecards/auto-send', A, (req, res) => { db.settings.cardAutoSend = Boolean(req.body.on); save(true); res.json({ autoSend: db.settings.cardAutoSend }); });
app.post('/api/admin/scorecards/test-email', A, async (req, res) => {
  const row = game.cardRows()[0], card = row && game.attemptCard(row.attemptId);
  if (!card) return res.status(400).json({ error: 'There is no score card to use as a sample yet.' });
  await sendTestEmail({ ...card, name: `${card.name} (sample)` }, req.s.email);
  res.json({ to: req.s.email });
});
app.get('/api/admin/scorecards.zip', A, async (req, res) => {
  const cards = game.cardRows().filter((c) => req.query.all === '1' || c.approved).map((c) => game.attemptCard(c.attemptId));
  if (!cards.length) return res.status(400).json({ error: 'There are no approved score cards to download yet.' });
  res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="score-cards.zip"' }).send(await cardsZip(cards));
});
app.get('/api/admin/image/:id', A, (req, res) => {
  const img = imageFor(req.params.id);
  if (!img) return res.status(404).json({ error: 'Not found' });
  res.type(img.type).set('Cache-Control', 'private, max-age=3600').send(img.buf);
});
app.post('/api/admin/r3-mode', A, (req, res) => { game.setR3Mode(req.body.mode); res.json({ mode: game.r3Mode() }); });
app.get('/api/admin/deletions', A, (req, res) => res.json(game.listDeletions()));
app.post('/api/admin/deletions/:id', A, (req, res) => { game.closeDeletion(req.params.id, req.s.email); res.json({ ok: true }); });
app.get('/api/admin/requests', A, (req, res) => res.json(game.listRequests()));
app.post('/api/admin/requests/:id', A, (req, res) => { game.decideRequest(req.params.id, Boolean(req.body.approve), req.body.reply, req.s.email, Number(req.body.round) || 0); res.json({ ok: true }); });
app.post('/api/admin/phase-time', A, (req, res) => {
  const ids = Array.isArray(req.body.studentIds) ? req.body.studentIds : db.students.map((s) => s.id);
  res.json(game.phaseTime(req.body.action, ids, req.body));
});
app.post('/api/admin/timing', A, (req, res) => { game.setTiming(req.body); res.json({ roundMinutes: game.roundMinutes(), phaseSeconds: game.phaseSeconds() }); });
app.post('/api/admin/leaderboard-scope', A, (req, res) => { db.settings.lbAllSchools = Boolean(req.body.all); save(true); res.json({ all: db.settings.lbAllSchools }); });
app.post('/api/admin/reattempts', A, (req, res) => res.json(game.enableReattempts(Array.isArray(req.body.studentIds) ? req.body.studentIds : [], Number(req.body.round) || 0)));
app.post('/api/admin/reattempt', A, (req, res) => { game.enableReattempt(req.body.studentId, Number(req.body.round) || 0); res.json({ ok: true }); });
app.post('/api/admin/scores', A, (req, res) => { game.setScores(req.body.attemptId, Number(req.body.round), req.body.parts || {}); res.json({ ok: true }); });
app.post('/api/admin/publish', A, (req, res) => { game.activeEvent().finalPublished = Boolean(req.body.final); save(); res.json({ ok: true }); });
app.get('/api/admin/analytics', A, (req, res) => res.json(game.analytics()));
// Reports: ?school=<id> for one school, nothing for every school; schools.zip holds one report per school.
const attach = (res, type, name) => { res.setHeader('Content-Type', type); res.setHeader('Content-Disposition', `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`); };
app.get('/api/admin/export.xlsx', A, async (req, res) => {
  const school = db.schools.find((s) => s.id === req.query.school);
  if (req.query.school && !school) return res.status(404).json({ error: 'School not found.' });
  attach(res, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', game.reportFileName(school?.name));
  res.send(await game.exportWorkbook(school?.id || ''));
});
app.get('/api/admin/export-schools.zip', A, async (req, res) => {
  if (!db.schools.length) return res.status(400).json({ error: 'Add schools first.' });
  attach(res, 'application/zip', `Promptathon school reports - ${new Date().toISOString().slice(0, 10)}.zip`);
  res.send(await game.exportSchoolsZip());
});

app.post('/api/admin/schools', A, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 100);
  if (name.length < 2) return res.status(400).json({ error: 'Enter a school name.' });
  if (db.schools.some((s) => s.name.toLowerCase() === name.toLowerCase())) return res.status(400).json({ error: 'That school already exists.' });
  db.schools.push({ id: uid('sc_'), name, createdAt: Date.now() });
  save(true);
  res.json({ ok: true });
});
app.delete('/api/admin/schools/:id', A, (req, res) => {
  if (db.students.some((s) => s.schoolId === req.params.id)) return res.status(400).json({ error: 'This school has students, so it can’t be removed.' });
  db.schools = db.schools.filter((s) => s.id !== req.params.id);
  save(true);
  res.json({ ok: true });
});
app.post('/api/admin/admins', A, (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email.' });
  if (!game.isAdmin(email)) db.admins.push({ email, addedBy: req.s.email, addedAt: Date.now() });
  save(true);
  res.json({ ok: true });
});
app.delete('/api/admin/admins/:email', A, (req, res) => {
  const email = req.params.email.toLowerCase();
  if (email === env.defaultAdmin) return res.status(400).json({ error: 'The default admin can’t be removed.' });
  db.admins = db.admins.filter((a) => a.email !== email);
  save(true);
  res.json({ ok: true });
});

// ---------- errors & SPA ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (err instanceof game.GameError) return res.status(err.status).json({ error: err.message, code: err.code });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

// ---------- start ----------
setCards(game.scorecards);
setReports(game.reports);
try { await initStore(); } catch (err) { console.error(`\nCannot start: ${err.message}\n`); process.exit(1); }
game.activeEvent();
save();
try { console.log('Question bank loaded:', JSON.stringify((await loadBank()).counts)); } catch (err) { console.error('Question bank not loaded:', err.message); }
await loadFlow();
setInterval(async () => {
  try { await loadBank(); await loadFlow(); } catch (err) { console.warn('Bank refresh failed, keeping the last copy:', err.message); }
}, BANK_REFRESH_MS);
setInterval(game.tick, 1000);
app.listen(env.port, () => console.log(`${APP_NAME} running at ${env.baseUrl}`));
