// The Google Sheet is the data store — there is no local database file.
//
// The server keeps a working copy of everything in memory (`db`) so answers can be autosaved every second,
// loads that copy from the sheet at start-up, and writes back only the rows that changed (within a couple of
// seconds, or almost at once after a start, submit, new student or decision). Each kind of record has its own
// readable tab; nested data (drafts, lifelines, question content) sits in JSON cells at the end of the row.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env, saveEnv, bandOf, SKILLS, DATA_SHEET_TITLE, STORE_FLUSH_MS, STORE_URGENT_MS, STORE_MIN_GAP_MS, REPORT_SYNC_MS, SHEET_GRID_ROWS } from './config.js';
import * as G from './google.js';

export const db = { settings: {}, admins: [], schools: [], events: [], students: [], attempts: [], requests: [], sets: [] };
export const uid = (prefix = '') => prefix + crypto.randomBytes(6).toString('base64url');

// ---------- cell helpers ----------
const CELL = 40000, JSON_COLS = 3; // a cell holds 50,000 characters at most
const iso = (t) => (t ? new Date(t).toISOString() : '');
const ms = (v) => { if (v === '' || v == null) return null; if (typeof v === 'number') return v; const t = Date.parse(v); return Number.isNaN(t) ? null : t; };
const str = (v) => (v == null ? '' : String(v));
const num = (v, d = 0) => (v === '' || v == null || Number.isNaN(Number(v)) ? d : Number(v));
const parse = (v, d) => { try { return v === '' || v == null ? d : JSON.parse(v); } catch { return d; } };
const jsonCells = (v) => {
  const s = JSON.stringify(v === undefined ? null : v);
  if (s.length > CELL * JSON_COLS) console.error('A record is too large for its sheet cells and was cut short:', s.slice(0, 60));
  return Array.from({ length: JSON_COLS }, (_, i) => s.slice(i * CELL, (i + 1) * CELL));
};
const fromCells = (cells, d) => parse(cells.map(str).join(''), d);
const total = (rec) => (rec?.score ? Object.values(rec.score.parts).reduce((t, p) => t + (p.points || 0), 0) : '');
const itemIds = (s) => (s.round === 1 ? [...s.content.items.map((q) => q.id), s.content.boss.id].join(', ') : s.round === 2 ? s.content.case.id : s.content.target.id);

// ---------- tables (one tab each) ----------
const TABLES = [
  { name: 'Schools', head: ['School ID', 'Name', 'Created'], list: () => db.schools, key: (r) => r.id,
    toRow: (r) => [r.id, r.name, iso(r.createdAt)],
    reset: () => { db.schools = []; },
    fromRow: (c) => (str(c[0]) ? { id: str(c[0]), name: str(c[1]), createdAt: ms(c[2]) } : null),
    add: (r) => db.schools.push(r) },

  { name: 'Admins', head: ['Email', 'Added by', 'Added at'], list: () => db.admins, key: (r) => r.email,
    toRow: (r) => [r.email, r.addedBy || '', iso(r.addedAt)],
    reset: () => { db.admins = []; },
    fromRow: (c) => { const email = str(c[0]).toLowerCase(); return email && email !== env.defaultAdmin ? { email, addedBy: str(c[1]), addedAt: ms(c[2]) } : null; },
    add: (r) => db.admins.push(r) },

  { name: 'Students', head: ['Student ID', 'Code', 'Name', 'Grade', 'Band', 'School', 'School ID', 'Account email', 'Created', 'Locked in'],
    list: () => db.students, key: (r) => r.id,
    toRow: (r, x) => [r.id, r.code, r.name, r.grade, bandOf(r.grade) || '', x.school.get(r.schoolId)?.name || '', r.schoolId, r.email, iso(r.createdAt), iso(r.lockedAt)],
    reset: () => { db.students = []; },
    fromRow: (c) => (str(c[0]) ? { id: str(c[0]), code: str(c[1]), name: str(c[2]), grade: num(c[3]), schoolId: str(c[6]), email: str(c[7]).toLowerCase(),
      createdAt: ms(c[8]), lockedAt: ms(c[9]) } : null),
    add: (r) => db.students.push(r) },

  { name: 'Attempts', head: ['Attempt ID', 'Student ID', 'Code', 'Name', 'Status', 'Created', 'Started', 'Paused at', 'Paused ms', 'Ended', 'Device',
    'Archived', 'Archived at', 'R1', 'R2', 'R3', 'Total', 'Acks (JSON)', 'Schedule (JSON)', 'Event ID', 'Run ID', 'Score card (JSON)'],
    list: () => db.attempts, key: (a) => a.id,
    toRow: (a, x) => {
      const s = x.student.get(a.studentId), t = [1, 2, 3].map((r) => total(a.rounds?.[r]));
      return [a.id, a.studentId, s?.code || '', s?.name || '', a.status, iso(a.createdAt), iso(a.startedAt), iso(a.pausedAt), a.pausedMs || 0, iso(a.endedAt),
        a.deviceId || '', a.archived ? 'yes' : '', iso(a.archivedAt), ...t, t.reduce((n, v) => n + (v || 0), 0), JSON.stringify(a.acks || {}), a.flow ? JSON.stringify(a.flow) : '', a.eventId || '', a.runId || '', a.card ? JSON.stringify(a.card) : ''];
    },
    reset: () => { db.attempts = []; },
    fromRow: (c) => (str(c[0]) ? { id: str(c[0]), studentId: str(c[1]), status: str(c[4]) || 'waiting', createdAt: ms(c[5]), startedAt: ms(c[6]), pausedAt: ms(c[7]),
      pausedMs: num(c[8]), endedAt: ms(c[9]), deviceId: str(c[10]) || null, lastSeen: null, archived: str(c[11]) === 'yes' || undefined, archivedAt: ms(c[12]),
      acks: parse(c[17], {}), flow: parse(c[18], undefined), eventId: str(c[19]), runId: str(c[20]) || undefined, card: parse(c[21], undefined), rounds: {} } : null),
    add: (a) => db.attempts.push(a) },

  { name: 'Rounds', head: ['Attempt ID', 'Round', 'Code', 'Name', 'Set ID', 'Opened', 'Saved', 'Submitted', 'Submit reason', 'Reviewed', 'Score', 'Marking pending',
    'Data 1 (JSON)', 'Data 2 (JSON)', 'Data 3 (JSON)'],
    list: () => db.attempts.flatMap((a) => Object.entries(a.rounds || {}).map(([r, rec]) => ({ attemptId: a.id, studentId: a.studentId, round: Number(r), rec }))),
    key: (x) => `${x.attemptId}:${x.round}`,
    toRow: ({ attemptId, studentId, round, rec }, x) => {
      const s = x.student.get(studentId);
      return [attemptId, round, s?.code || '', s?.name || '', rec.setId, iso(rec.openedAt), iso(rec.savedAt), iso(rec.submittedAt), rec.submitReason || '', iso(rec.reviewedAt),
        total(rec), rec.score?.pending ? 'yes' : '', ...jsonCells({ draft: rec.draft, lifelines: rec.lifelines, generations: rec.generations, score: rec.score })];
    },
    reset: () => {},
    fromRow: (c) => {
      if (!str(c[0])) return null;
      const d = fromCells(c.slice(12, 15), {}) || {};
      return { attemptId: str(c[0]), round: num(c[1]), rec: { setId: str(c[4]), openedAt: ms(c[5]), savedAt: ms(c[6]), submittedAt: ms(c[7]), submitReason: str(c[8]) || undefined,
        reviewedAt: ms(c[9]) || undefined, draft: d.draft || {}, lifelines: d.lifelines || { used: [], data: {} }, generations: d.generations || [], score: d.score || null } };
    },
    add: (x) => { const a = db.attempts.find((y) => y.id === x.attemptId); if (!a) return false; a.rounds[x.round] = x.rec; return true; } },

  { name: 'Question Sets', head: ['Set ID', 'Event ID', 'Band', 'Round', 'Difficulty basis', 'Band avg before draw', 'Bank version', 'Seed', 'Drawn at', 'Item IDs',
    'Content 1 (JSON)', 'Content 2 (JSON)', 'Content 3 (JSON)', 'Run ID'],
    list: () => db.sets, key: (s) => s.id,
    toRow: (s) => [s.id, s.eventId, s.band, s.round, s.level, s.perf ?? '', str(s.bankVersion), s.seed, iso(s.drawnAt), itemIds(s), ...jsonCells(s.content), s.runId || ''],
    reset: () => { db.sets = []; },
    fromRow: (c) => { const content = fromCells(c.slice(10, 13), null); return str(c[0]) && content ? { id: str(c[0]), eventId: str(c[1]), band: str(c[2]), round: num(c[3]),
      level: str(c[4]), perf: c[5] === '' || c[5] == null ? null : num(c[5]), bankVersion: str(c[6]), seed: num(c[7]), drawnAt: ms(c[8]), content, runId: str(c[13]) || undefined } : null; },
    add: (s) => db.sets.push(s) },

  { name: 'Reattempt Requests', head: ['Request ID', 'Student ID', 'Attempt ID', 'Code', 'Name', 'School', 'Student note', 'Status', 'Host reply', 'Requested', 'Decided', 'Decided by'],
    list: () => db.requests, key: (r) => r.id,
    toRow: (r, x) => { const s = x.student.get(r.studentId); return [r.id, r.studentId, r.attemptId, s?.code || '', s?.name || '', x.school.get(s?.schoolId)?.name || '',
      r.note || '', r.status, r.reply || '', iso(r.createdAt), iso(r.decidedAt), r.decidedBy || '']; },
    reset: () => { db.requests = []; },
    fromRow: (c) => (str(c[0]) ? { id: str(c[0]), studentId: str(c[1]), attemptId: str(c[2]), note: str(c[6]), status: str(c[7]) || 'pending', reply: str(c[8]),
      createdAt: ms(c[9]), decidedAt: ms(c[10]), decidedBy: str(c[11]) } : null),
    add: (r) => db.requests.push(r) },

  // Derived from the saved answers (see scorecard.js) and kept in the sheet so cards can be produced later from stored data.
  { name: 'Scorecards', derived: true,
    head: ['Attempt ID', 'Student ID', 'Code', 'Name', 'Grade', 'School', 'Band', 'Status', 'Total /60', 'Round 1', 'Round 2', 'Round 3',
      ...Object.keys(SKILLS).map((id) => `${id} %`), 'Strength', 'Next step', 'Card data (JSON)', 'Approved', 'Emailed to', 'Emailed at'],
    list: () => (cardProvider ? cardProvider() : []), key: (c) => c.attemptId,
    toRow: (c) => [c.attemptId, c.studentId, c.code, c.name, c.grade, c.school, c.band, c.status, c.total, ...c.rounds.map((v) => v ?? ''),
      ...Object.keys(SKILLS).map((id) => c.skills.find((s) => s.id === id)?.percent ?? ''), c.strength, c.nextStep, ...jsonCells(c).slice(0, 1), c.approved ? 'yes' : '', c.emailedTo || '', iso(c.emailedAt)],
    reset: () => {}, fromRow: () => null, add: () => false },

  { name: 'Settings', head: ['Key', 'Value (JSON)'],
    list: () => [...Object.entries(db.settings).map(([key, value]) => ({ key, value })), ...(db.events[0] ? [{ key: 'event', value: db.events[0] }] : [])],
    key: (r) => r.key, toRow: (r) => [r.key, JSON.stringify(r.value)],
    reset: () => { db.settings = {}; db.events = []; },
    fromRow: (c) => (str(c[0]) ? { key: str(c[0]), value: parse(c[1], null) } : null),
    add: (r) => { if (r.key === 'event') db.events = [r.value]; else db.settings[r.key] = r.value; } },
];
let cardProvider = null;
export function setCards(fn) { cardProvider = fn; } // call before initStore() so the first save already knows the cards
const REPORT_TABS = ['Results', 'Answers']; // readable summaries, rebuilt from the data above
for (const t of TABLES) Object.assign(t, { index: new Map(), next: 2, gridRows: 0, sheetId: 0 });

const pad = (row, n) => (row.length >= n ? row : [...row, ...Array(n - row.length).fill('')]);
const makeCtx = () => ({ student: new Map(db.students.map((s) => [s.id, s])), school: new Map(db.schools.map((s) => [s.id, s])) });
const sleep = (ms_) => new Promise((r) => setTimeout(r, ms_));

// ---------- start-up: find the sheet, load everything ----------
export async function initStore() {
  await bootstrapConnection();
  const id = env.dataSheetId;
  const info = await G.sheetInfo(id);
  const tabs = new Map(info.tabs.map((t) => [t.title, t]));

  const existing = TABLES.filter((t) => tabs.has(t.name));
  const values = existing.length ? await G.valuesGet(id, existing.map((t) => G.tabRange(t.name))) : [];
  const rowsOf = new Map(existing.map((t, i) => [t.name, values[i]]));

  const structure = [], headers = [], legacy = [];
  const taken = new Set(tabs.keys());
  const create = (title, cols) => structure.push({ addSheet: { properties: { title, gridProperties: { rowCount: SHEET_GRID_ROWS, columnCount: cols, frozenRowCount: 1 } } } });
  for (const t of TABLES) {
    const tab = tabs.get(t.name), rows = rowsOf.get(t.name);
    if (rows?.[0]?.length && rows[0].length <= t.head.length && rows[0].every((h, i) => str(h) === t.head[i])) { // current layout, or an older one with fewer columns
      if (rows[0].length < t.head.length) headers.push({ range: G.tabRange(t.name, 'A1'), values: [t.head] });
      continue;
    }
    rowsOf.set(t.name, []);
    headers.push({ range: G.tabRange(t.name, 'A1'), values: [t.head] });
    if (tab && rows.length) { // a tab from an older layout: keep it under a new name and start a fresh one
      let title = `Old ${t.name}`;
      for (let n = 2; taken.has(title); n++) title = `Old ${t.name} ${n}`;
      taken.add(title);
      structure.push({ updateSheetProperties: { properties: { sheetId: tab.id, title }, fields: 'title' } });
      legacy.push(`${t.name} → ${title}`);
      create(t.name, t.head.length);
    } else if (!tab) create(t.name, t.head.length);
  }
  for (const name of REPORT_TABS) {
    if (!tabs.has(name)) create(name, 16);
  }
  if (structure.length) await G.sheetsBatch(id, structure);
  if (legacy.length) console.log(`Older sheet layouts kept under new names: ${legacy.join('; ')}`);
  await refreshTabInfo();
  const widen = TABLES.filter((t) => t.cols < t.head.length); // a tab created before a column was added
  if (widen.length) { await G.sheetsBatch(id, widen.map((t) => ({ appendDimension: { sheetId: t.sheetId, dimension: 'COLUMNS', length: t.head.length - t.cols } }))); await refreshTabInfo(); }
  if (headers.length) await G.valuesWrite(id, headers); // after widening, so a longer header always fits

  // load rows → memory
  let loaded = 0;
  for (const t of TABLES) t.reset();
  for (const t of TABLES) {
    const rows = rowsOf.get(t.name) || [];
    t.index = new Map();
    rows.slice(1).forEach((c, i) => {
      if (!c || c.every((v) => v === '' || v == null)) return;
      if (t.derived) { t.index.set(str(c[0]), { row: i + 2, text: null }); return; } // rebuilt from the data, only its row numbers are kept
      const rec = t.fromRow(c);
      if (rec && t.add(rec) !== false) { t.index.set(t.key(rec), { row: i + 2, text: null }); loaded++; }
      else t.index.set(`__stale:${i + 2}`, { row: i + 2, text: null }); // unreadable or superseded row: blanked on the first save
    });
    t.next = Math.max(rows.length + 1, 2);
  }

  if (!loaded) migrateLocalFile();
  ready = true;
  await flush(); // writes everything once so the sheet's readable columns are current
  finishMigration();
  setInterval(() => syncReports().catch((err) => console.error('Updating the Results/Answers tabs failed:', err.message)), REPORT_SYNC_MS).unref();
  console.log(`Data store: Google Sheet https://docs.google.com/spreadsheets/d/${id} (${loaded} records loaded)`);
}

async function refreshTabInfo() {
  const info = await G.sheetInfo(env.dataSheetId);
  const by = new Map(info.tabs.map((t) => [t.title, t]));
  for (const t of TABLES) { const i = by.get(t.name); if (i) Object.assign(t, { sheetId: i.id, gridRows: i.rows, cols: i.cols }); }
  reportInfo = new Map(REPORT_TABS.map((n) => [n, by.get(n)]));
}
let reportInfo = new Map();

// The refresh token and sheet id live in .env. Versions that kept them in the local file are upgraded here.
async function bootstrapConnection() {
  const file = path.join(env.dataDir, 'db.json');
  let old = null;
  if (fs.existsSync(file)) { try { old = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { old = null; } }
  if (!env.googleRefreshToken && old?.settings?.google?.refreshToken) { saveEnv('GOOGLE_REFRESH_TOKEN', old.settings.google.refreshToken); console.log('Moved the saved Google connection into .env'); }
  if (!env.dataSheetId && old?.settings?.dataSheetId) { saveEnv('DATA_SHEET_ID', old.settings.dataSheetId); console.log('Moved the results sheet id into .env'); }
  if (!G.driveConnected()) throw new Error('Google Drive is not connected. Run `npm run connect-google` once, then start the app again.');
  if (!env.dataSheetId) {
    const id = await G.createSpreadsheet(DATA_SHEET_TITLE);
    saveEnv('DATA_SHEET_ID', id);
    console.log(`Created the data sheet: https://docs.google.com/spreadsheets/d/${id}`);
  }
}

// One-time: a sheet with no records but an old local db.json receives that data, then the file is set aside.
let migratedFile = '';
function migrateLocalFile() {
  const file = path.join(env.dataDir, 'db.json');
  if (!fs.existsSync(file)) return;
  try {
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    Object.assign(db, { admins: old.admins || [], schools: old.schools || [], events: old.events || [], students: old.students || [], attempts: old.attempts || [],
      requests: old.requests || [], sets: old.sets || [] });
    db.settings = Object.fromEntries(['roundMinutes', 'phaseSeconds', 'lbAllSchools'].filter((k) => old.settings?.[k] !== undefined).map((k) => [k, old.settings[k]]));
    for (const a of db.attempts) a.rounds ||= {};
    migratedFile = file;
    console.log(`Importing ${db.students.length} student(s) from ${file} into the sheet`);
  } catch (err) { console.error('Could not read the old local data file:', err.message); }
}
function finishMigration() {
  if (!migratedFile) return;
  fs.renameSync(migratedFile, `${migratedFile}.migrated`);
  console.log(`Imported. The old file was kept as ${migratedFile}.migrated and is no longer used.`);
}

// ---------- saving ----------
let ready = false, dirty = false, timer = null, dueAt = 0, flushing = null, lastFlush = 0, failures = 0;

export function save(urgent = false) {
  dirty = true;
  if (ready) schedule(urgent ? STORE_URGENT_MS : STORE_FLUSH_MS);
}

function schedule(delay) {
  const at = Date.now() + Math.max(delay, STORE_MIN_GAP_MS - (Date.now() - lastFlush));
  if (timer && dueAt <= at) return;
  clearTimeout(timer);
  dueAt = at;
  timer = setTimeout(() => { timer = null; if (flushing) schedule(500); else flushOnce().catch(() => {}); }, Math.max(0, at - Date.now()));
}

function flushOnce() {
  if (flushing) return flushing;
  flushing = (async () => {
    try { dirty = false; await writeChanges(); lastFlush = Date.now(); failures = 0; }
    catch (err) { dirty = true; failures++; console.error('Saving to Google Sheets failed, will retry:', err.message); schedule(Math.min(30000, 3000 * failures)); throw err; }
    finally { flushing = null; }
  })();
  return flushing;
}

// Resolves once every change made so far has reached the sheet.
export async function flush() {
  if (flushing) await flushing.catch(() => {});
  clearTimeout(timer); timer = null;
  await flushOnce();
}

async function writeChanges() {
  const id = env.dataSheetId, ctx = makeCtx(), writes = [];
  for (const t of TABLES) {
    const seen = new Set();
    for (const rec of t.list()) {
      const key = t.key(rec);
      seen.add(key);
      let ent = t.index.get(key);
      if (!ent) { ent = { row: t.next++, text: null }; t.index.set(key, ent); }
      const row = pad(t.toRow(rec, ctx), t.head.length), text = JSON.stringify(row);
      if (ent.text !== text) writes.push({ t, ent, text, range: G.tabRange(t.name, `A${ent.row}`), values: [row] });
    }
    for (const [key, ent] of t.index) {
      if (!seen.has(key)) writes.push({ t, ent, drop: key, range: G.tabRange(t.name, `A${ent.row}`), values: [Array(t.head.length).fill('')] });
    }
  }
  if (!writes.length) return;

  const grow = TABLES.filter((t) => writes.some((w) => w.t === t && w.ent.row > t.gridRows)).map((t) => {
    const need = Math.max(...writes.filter((w) => w.t === t).map((w) => w.ent.row));
    return { t, length: Math.max(SHEET_GRID_ROWS, need - t.gridRows + 1000) };
  });
  if (grow.length) {
    await G.sheetsBatch(id, grow.map((g) => ({ appendDimension: { sheetId: g.t.sheetId, dimension: 'ROWS', length: g.length } })));
    for (const g of grow) g.t.gridRows += g.length;
  }

  for (let i = 0; i < writes.length;) {
    let size = 0, n = 0;
    while (i + n < writes.length && n < 300 && size < 2_000_000) { size += JSON.stringify(writes[i + n].values).length; n++; }
    const batch = writes.slice(i, i + n);
    await G.valuesWrite(id, batch.map((w) => ({ range: w.range, values: w.values })));
    for (const w of batch) { if (w.drop) w.t.index.delete(w.drop); else w.ent.text = w.text; }
    i += n;
  }
}

// ---------- readable Results / Answers tabs ----------
let reportProvider = null, reportHash = '';
export function setReports(fn) { reportProvider = fn; }

export async function syncReports() {
  if (!reportProvider || !ready) return;
  const tabs = reportProvider();
  const hash = crypto.createHash('sha1').update(JSON.stringify(tabs)).digest('hex');
  if (hash === reportHash) return;
  const id = env.dataSheetId, names = Object.keys(tabs);
  const grow = names.filter((n) => reportInfo.get(n) && tabs[n].length > reportInfo.get(n).rows);
  if (grow.length) {
    await G.sheetsBatch(id, grow.map((n) => ({ appendDimension: { sheetId: reportInfo.get(n).id, dimension: 'ROWS', length: tabs[n].length - reportInfo.get(n).rows + 1000 } })));
    await refreshTabInfo();
  }
  await G.valuesClear(id, names.map((n) => G.tabRange(n)));
  await G.valuesWrite(id, names.map((n) => ({ range: G.tabRange(n, 'A1'), values: tabs[n] })));
  reportHash = hash;
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    try { await Promise.race([flush(), sleep(8000)]); } catch { /* exiting anyway */ }
    process.exit(0);
  });
}
