import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { env, APP_NAME, BANDS, GRADES, ROUNDS, RULES, SCORE_PARTS, LIFELINES_PER_ROUND, R3_GENERATIONS, SESSION_DAYS, BANK_REFRESH_MS, POLICY_VERSION,
  PRACTICE, RATINGS, PRACTICE_SECONDS, bandOf } from './config.js';
import { db, save, uid, initStore, setReports, setCards, storeHealth } from './store.js';
import { authUrl, exchangeCode } from './google.js';
import { loadBank, loadFlow, bankInfo, bandProblems, getFlow, imageFor, bandCatalogue } from './bank.js';
import * as game from './game.js';
import { cardPdf, cardFileName, cardsZip, emailReady, sendCards, sendTestEmail } from './deliver.js';

const app = express();
app.set('trust proxy', 1); // Render (and most hosts) sit behind one proxy
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));
app.get(['/admin', '/host'], (req, res) => res.redirect('/#/admin')); // an easy address for hosts; works whether Promptathon is open or closed
app.use(express.static(path.resolve('public'), { extensions: ['html'], setHeaders: (res, file) => {
  // pictures rarely change, so they may be cached for a day; code and pages are re-checked so an update shows on the next load
  res.set('Cache-Control', /\.(jpe?g|png|webp|webm|svg|woff2?)$/i.test(file) ? 'public, max-age=86400' : 'no-cache');
} }));

// ---------- admin sessions: a signed cookie (students never get one — see the player token below) ----------
const sign = (v) => `${v}.${crypto.createHmac('sha256', env.sessionSecret).update(v).digest('base64url')}`;
const unsign = (s) => { const v = String(s || '').split('.')[0]; return s && sign(v) === s ? v : null; };
const secure = env.baseUrl.startsWith('https');
const cookie = (name, value, maxAge) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
const readCookie = (req, name) => (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);

function adminSession(req) {
  const v = unsign(readCookie(req, 'pt'));
  if (!v) return null;
  try {
    const s = JSON.parse(Buffer.from(v, 'base64url').toString());
    return s.email && s.exp > Date.now() && game.isAdmin(s.email) ? s : null;
  } catch { return null; }
}
const A = (req, res, next) => {
  const s = adminSession(req);
  if (!s) return res.status(401).json({ error: 'Please sign in as a host again.', code: 'admin-signin' });
  req.s = s;
  next();
};

// ---------- students: the player token travels in a header, so each browser tab is its own student ----------
// The gate is checked first: while Promptathon is closed, every student API answers the same way.
const closed = (res) => res.status(423).json({ error: 'Promptathon is closed right now. Please wait for your host to open it.', code: 'closed' });
const S = (req, res, next) => {
  if (!game.gate().open) return closed(res);
  const r = game.studentFromToken(req.get('x-player'));
  if (r.error === 'logged-out') return res.status(401).json({ error: 'Your host logged you out of this window. Type your details to join again.', code: 'logged-out' });
  if (!r.student) return res.status(401).json({ error: 'Please join first.', code: 'no-student' });
  req.student = r.student;
  next();
};

// ---------- Google sign-in: hosts only ----------
app.get('/auth/google', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie', cookie('pt_state', state, 600));
  res.redirect(authUrl(state));
});

app.get('/auth/callback', async (req, res) => {
  const expected = readCookie(req, 'pt_state');
  if (!req.query.code || !expected || req.query.state !== expected) return res.redirect('/#/admin?error=signin');
  try {
    const who = await exchangeCode(req.query.code);
    res.append('Set-Cookie', cookie('pt_state', '', 0));
    if (!game.isAdmin(who.email)) return res.redirect(`/#/admin?error=notadmin&who=${encodeURIComponent(who.email)}`);
    const s = { email: who.email, name: who.name, picture: who.picture, exp: Date.now() + SESSION_DAYS * 864e5 };
    res.append('Set-Cookie', cookie('pt', sign(Buffer.from(JSON.stringify(s)).toString('base64url')), SESSION_DAYS * 86400));
    res.redirect('/#/admin/live');
  } catch (err) {
    console.error('Sign-in failed:', err.message);
    res.redirect('/#/admin?error=signin');
  }
});

// Load tests and local checks only: exists when TEST_ADMIN_KEY is set (never on a real server).
if (env.testAdminKey) {
  console.warn('TEST_ADMIN_KEY is set — the test-only admin sign-in is enabled. Never set it on a real server.');
  app.post('/auth/test-admin', (req, res) => {
    if (req.body?.key !== env.testAdminKey) return res.status(403).json({ error: 'Wrong key.' });
    const s = { email: env.defaultAdmin, name: 'Test admin', picture: '', exp: Date.now() + 864e5 };
    res.append('Set-Cookie', cookie('pt', sign(Buffer.from(JSON.stringify(s)).toString('base64url')), 86400));
    res.json({ ok: true });
  });
}

app.post('/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', cookie('pt', '', 0));
  res.json({ ok: true });
});

// ---------- public ----------
app.get('/healthz', (req, res) => {
  const info = bankInfo();
  res.status(info ? 200 : 503).json({ ok: Boolean(info), bank: Boolean(info), store: storeHealth(), open: game.gate().open, uptime: Math.round(process.uptime()) });
});

app.get('/api/config', (req, res) => {
  const open = game.gate().open;
  res.json({ app: APP_NAME, open, bands: BANDS.map(({ id, label }) => ({ id, label })), grades: GRADES, rounds: ROUNDS, rules: RULES,
    roundMinutes: game.roundMinutes(), practiceMinutes: Math.round(game.phaseSeconds().brief / 60), scoreParts: SCORE_PARTS, lifelinesPerRound: LIFELINES_PER_ROUND,
    generations: R3_GENERATIONS, aiTool: false, practice: PRACTICE, ratings: RATINGS,
    schools: open ? db.schools.map(({ id, name }) => ({ id, name })).sort((x, y) => x.name.localeCompare(y.name)) : [],
    googleReady: Boolean(env.googleClientId), contact: env.contactEmail, policyVersion: POLICY_VERSION });
});

// Anyone (a parent, a student, a teacher) may ask for a child's data to be erased; it works even while the event is closed.
app.post('/api/deletion', (req, res) => res.json(game.requestDeletion(adminSession(req)?.email, req.body)));

app.get('/api/me', (req, res) => {
  const s = adminSession(req);
  res.json(s ? { signedIn: true, role: 'admin', email: s.email, name: s.name, picture: s.picture } : { signedIn: false });
});

// ---------- student ----------
app.post('/api/register', (req, res) => {
  if (!game.gate().open) return closed(res);
  const { student, returning } = game.register(req.body || {});
  res.json({ token: game.playerToken(student), returning, student: { id: student.id, code: student.code, name: student.name, grade: student.grade, band: bandOf(student.grade) } });
});
// Log back in with a player code. Wrong codes are limited per address so codes can't be guessed.
const codeTries = new Map(); // ip → { n, until }
app.post('/api/login', (req, res) => {
  if (!game.gate().open) return closed(res);
  const t = Date.now(), rec = codeTries.get(req.ip);
  if (rec && rec.until > t && rec.n >= 30) return res.status(429).json({ error: 'Too many wrong codes. Please ask your host for your player code.', code: 'slow-down' });
  try {
    const { student } = game.loginWithCode(req.body?.code);
    res.json({ token: game.playerToken(student), returning: true, student: { id: student.id, code: student.code, name: student.name, grade: student.grade, band: bandOf(student.grade) } });
  } catch (err) {
    if (err.code === 'bad-code') { const r = rec && rec.until > t ? rec : { n: 0, until: t + 5 * 60e3 }; r.n++; codeTries.set(req.ip, r); }
    throw err;
  }
});
app.get('/api/play', S, (req, res) => res.json(game.playState(req.student)));
app.post('/api/play/sync', S, (req, res) => res.json(game.sync(req.student, req.body)));
app.post('/api/play/start-round', S, (req, res) => res.json(game.startRound(req.student, req.body)));
app.post('/api/play/practice', S, (req, res) => res.json(game.recordPractice(req.student, req.body)));
app.post('/api/play/leave', S, (req, res) => res.json(game.leaveWindow(req.student, req.body.deviceId)));
app.post('/api/play/lock-request', S, (req, res) => res.json(game.lockRequest(req.student, req.body.note)));
app.post('/api/play/takeover', S, (req, res) => res.json(game.takeover(req.student, req.body.deviceId)));
app.post('/api/play/profile', S, (req, res) => res.json(game.updateProfile(req.student, req.body || {})));
app.post('/api/play/reattempt-request', S, (req, res) => res.json(game.requestReattempt(req.student, req.body.note)));
app.post('/api/play/feedback', S, (req, res) => res.json(game.submitFeedback(req.student, req.body)));
app.get('/api/play/round', S, (req, res) => res.json(game.roundContent(req.student, req.query.deviceId)));
app.post('/api/play/lifeline', S, (req, res) => res.json(game.useLifeline(req.student, req.body)));
app.post('/api/play/submit', S, (req, res) => res.json(game.submitRound(req.student, req.body)));
app.post('/api/play/generate', S, async (req, res) => res.json(await game.generateR3(req.student, req.body)));
app.get('/api/play/scorecard', S, (req, res) => {
  const card = game.studentCard(req.student);
  if (!card) return res.status(404).json({ error: 'Your score card is not ready yet.' });
  res.type('html').send(game.cardHtml(card.attemptId));
});
app.get('/api/play/scorecard.pdf', S, async (req, res) => {
  const card = game.studentCard(req.student);
  if (!card) return res.status(404).json({ error: 'Your score card is not ready yet.' });
  await pdfOf(res, card);
});
// Question pictures: signed, expiring links handed out with the round (an <img> can't send the player header).
app.get('/api/img/:id', (req, res) => {
  if (!game.gate().open) return closed(res);
  const img = game.signedImage(req.params.id, req.query.e, req.query.s);
  if (!img) return res.status(404).json({ error: 'Not found' });
  res.type(img.type).set('Cache-Control', 'private, max-age=3600').send(img.buf);
});

app.get('/api/leaderboard', (req, res, next) => {
  const admin = adminSession(req);
  if (admin) {
    const all = game.runs(), run = req.query.run === 'all' ? '' : req.query.run || all.at(-1)?.id || '';
    return res.json(game.leaderboard({ band: req.query.band || BANDS[0].id, schoolId: req.query.school || '', runId: run }));
  }
  S(req, res, () => {
    const st = req.student;
    const mine = game.currentAttempt(st.id); // students are ranked against the people who answered the same questions
    const all = Boolean(db.settings.lbAllSchools); // the admin decides whether students see other schools
    const lb = game.leaderboard({ band: bandOf(st.grade), schoolId: all ? '' : st.schoolId, runId: mine ? game.runOf(mine) : '' });
    res.json({ ...lb, rows: lb.rows.map(({ code, ...r }) => ({ ...r, me: code === st.code })), scope: all ? 'all' : 'school' }); // other players' codes stay private
  });
});

// ---------- admin ----------
app.get('/api/admin/overview', A, (req, res) => {
  const ev = game.activeEvent();
  res.json({ event: ev, gate: game.gate(), schools: db.schools, admins: [{ email: env.defaultAdmin, fixed: true }, ...db.admins], students: game.studentRows(),
    runs: game.runs(), emailReady: emailReady(), pendingRequests: game.pendingRequests(), pendingLocks: game.pendingLocks(), pendingDeletions: db.deletions.filter((d) => d.status === 'open').length,
    roundMinutes: game.roundMinutes(), phaseSeconds: game.phaseSeconds(), practiceRange: PRACTICE_SECONDS, lbAllSchools: Boolean(db.settings.lbAllSchools),
    bank: bankInfo()?.counts, bankFormat: bankInfo()?.format, bankName: bankInfo()?.meta?.name, bandProblems: Object.fromEntries(BANDS.map((b) => [b.id, bandProblems(b.id)])),
    feedbackCount: db.feedback.length, store: storeHealth() });
});
app.post('/api/admin/gate', A, (req, res) => res.json(game.setGate(Boolean(req.body.open), req.s.email)));
app.post('/api/admin/logout', A, (req, res) => res.json(game.logoutStudents(Array.isArray(req.body.studentIds) ? req.body.studentIds : [])));

app.get('/api/admin/students/:id', A, (req, res) => {
  const s = db.students.find((x) => x.id === req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  const attempts = db.attempts.filter((a) => a.studentId === s.id).sort((x, y) => y.createdAt - x.createdAt).map((a) => ({
    id: a.id, event: db.events.find((e) => e.id === a.eventId)?.name, status: a.status, archived: Boolean(a.archived), startedAt: a.startedAt, endedAt: a.endedAt,
    scores: Object.fromEntries(Object.entries(a.rounds).map(([r, rec]) => [r, rec.score])),
    parts: Object.fromEntries(Object.entries(a.rounds).map(([r, rec]) => [r, game.partsOfRound(Number(r), rec)])),
    meta: Object.fromEntries(Object.entries(a.rounds).map(([r, rec]) => [r, rec.meta ? { takenMs: rec.meta.takenMs, skipped: rec.meta.skipped } : null])),
    lifelines: Object.fromEntries(Object.entries(a.rounds).map(([r, rec]) => [r, rec.lifelines.used])),
    practice: a.practice || {}, feedback: db.feedback.find((f) => f.attemptId === a.id) || null,
    answers: game.answerDetail(a) }));
  res.json({ student: { ...s, band: bandOf(s.grade), school: db.schools.find((x) => x.id === s.schoolId)?.name }, attempts });
});
app.delete('/api/admin/students/:id', A, (req, res) => { game.deleteStudent(req.params.id); res.json({ ok: true }); });
app.get('/api/admin/students.csv', A, (req, res) => {
  attach(res, 'text/csv; charset=utf-8', `Promptathon students - ${new Date().toISOString().slice(0, 10)}.csv`);
  res.send(game.studentsCsv());
});
app.get('/api/admin/feedback', A, (req, res) => res.json({ rows: game.feedbackList(), ratings: RATINGS }));
app.get('/api/admin/bank/:band', A, (req, res) => {
  if (!BANDS.some((b) => b.id === req.params.band)) return res.status(404).json({ error: 'Unknown grade band.' });
  res.json(bandCatalogue(req.params.band) || { error: 'The question bank is not loaded.' });
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
app.get('/api/admin/scorecards', A, (req, res) => res.json({ rows: game.cardRows(), runs: game.runs(), emailReady: emailReady(), autoSend: Boolean(db.settings.cardAutoSend), from: env.smtpUser }));
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
  const want = new Set(String(req.query.ids || '').split(',').filter(Boolean)); // the filtered list from the Score cards tab
  const cards = game.cardRows().filter((c) => (want.size ? want.has(c.attemptId) : true) && (req.query.all === '1' || c.approved)).map((c) => game.attemptCard(c.attemptId));
  if (!cards.length) return res.status(400).json({ error: 'There are no approved score cards to download in this selection.' });
  res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="score-cards.zip"' }).send(await cardsZip(cards));
});
app.get('/api/admin/image/:id', A, (req, res) => {
  const img = imageFor(req.params.id);
  if (!img) return res.status(404).json({ error: 'Not found' });
  res.type(img.type).set('Cache-Control', 'private, max-age=3600').send(img.buf);
});
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
app.post('/api/admin/publish', A, (req, res) => { game.activeEvent().finalPublished = Boolean(req.body.final); save(true); res.json({ ok: true }); });
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
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof game.GameError) return res.status(err.status).json({ error: err.message, code: err.code, missing: err.missing });
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(400).json({ error: 'That request could not be read.' });
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
}, BANK_REFRESH_MS).unref();
setInterval(() => { try { game.tick(); } catch (err) { console.error('Clock tick failed:', err.message); } }, 1000);
const server = app.listen(env.port, () => console.log(`${APP_NAME} running at ${env.baseUrl} · Promptathon is ${game.gate().open ? 'OPEN' : 'CLOSED'}`));
server.keepAliveTimeout = 65000; // longer than the proxy's idle timeout, so kept-alive connections aren't cut mid-request
server.headersTimeout = 66000;
