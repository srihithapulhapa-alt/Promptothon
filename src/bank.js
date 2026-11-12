// Question bank + game flow, read from Drive (or a local file in tests). Only Active rows are used (sheets without a Status
// column count as active), and only the latest version of each ID. Questions are never generated — every item comes from
// the bank as written. The bank also carries the skill mapping behind the score card and the embedded pictures.
//
// Sheets: R1 Blitz, R1 Boss (unchanged), R2 Questions (one case = one AI picture + three fact cards + three questions,
// grouped by Case ID), R3 Questions (one AI picture per row). Grade bands come from the "Grade band" column.
import crypto from 'node:crypto';
import fs from 'node:fs';
import * as XLSX from 'xlsx';
import { unzipSync, strFromU8 } from 'fflate';
import sharp from 'sharp';
import { env, BANDS, DEFAULT_FLOW, ROUND_SECONDS, R1_MIX, R1_ORDER, R1_MANDATORY, R1_OTHERS, BOSS_DIFFICULTY, DIFFICULTIES,
  ADAPTIVE_THRESHOLDS, ADAPTIVE_DEFAULT, SKILL_LABELS, SKILLS, BANK_IMAGE_WIDTH } from './config.js';
import { downloadSheetFile, fileMeta } from './google.js';

let bank = null;
let flow = DEFAULT_FLOW;
let skills = SKILLS;
let images = new Map(); // image id → { buf, type } — resized for the web; served only through signed links
// Rules and the round-to-round break are folded into each round's briefing, so kids see one screen per set of instructions.
export const getFlow = () => flow.filter((p) => p.type !== 'welcome' && p.type !== 'transition');
export const bankInfo = () => bank && { meta: bank.meta, counts: counts(), format: bank.format };
export const getSkills = () => skills;
export const imageFor = (id) => images.get(id);

// ---------- parsing helpers ----------
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const lines = (s) => String(s ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const pick = (row, prefix) => row[Object.keys(row).find((k) => k === prefix || k.startsWith(`${prefix}_`)) ?? ''] ?? '';

// The header row is the first one naming an ID column (or Status).
function readTable(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
  const h = rows.findIndex((r) => r.some((c) => ['status', 'question_id', 'case_id'].includes(norm(c))));
  if (h < 0) return [];
  const keys = rows[h].map(norm);
  return rows.slice(h + 1).map((r) => Object.fromEntries(keys.map((k, i) => [k, String(r[i] ?? '').trim()])));
}

// Latest version per ID first (highest "Version" column, else the last row), then keep it only if Active.
function latestActive(rows, idOf) {
  const latest = new Map();
  for (const r of rows) {
    const id = idOf(r);
    if (!id) continue;
    const prev = latest.get(id);
    if (!prev || (parseFloat(pick(r, 'version')) || 0) >= (parseFloat(pick(prev, 'version')) || 0)) latest.set(id, r);
  }
  return [...latest.values()].filter((r) => (!('status' in r) || r.status.trim().toLowerCase() === 'active')
    && (!pick(r, 'language') || /^en/i.test(pick(r, 'language'))));
}

function bandsOf(row) {
  const name = pick(row, 'grade_band').toLowerCase().replace(/\s+/g, ' ').trim();
  return BANDS.filter((b) => b.bank.includes(name)).map((b) => b.id);
}

// "Not assigned" (the newer Round 3 pictures) fits any level.
const difficulty = (s) => DIFFICULTIES.find((d) => d.toLowerCase() === String(s).trim().toLowerCase()) || (/not\s*assigned|^$/i.test(String(s).trim()) ? null : 'Medium');
const options = (s) => lines(s).map((l) => l.match(/^([A-H])[.)]\s*(.+)$/)).filter(Boolean).map((m) => ({ id: m[1], text: m[2] }));
const letters = (s) => String(s).toUpperCase().match(/\b[A-H]\b/g) || [];
const num = (v, d) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : d);

// "choice: S06 /2; explanation: S04 /3 and S07 /3" → { choice: [{id:'S06', max:2}], explanation: [{S04,3},{S07,3}] }
function skillMap(text) {
  const out = {};
  for (const part of String(text || '').split(';')) {
    const m = part.match(/^\s*([^:]+):\s*(.+)$/);
    if (m) out[norm(m[1])] = [...m[2].matchAll(/(S\d+)\s*\/\s*(\d+)/g)].map((x) => ({ id: x[1], max: Number(x[2]) }));
  }
  return out;
}
const BOSS_PARTS = { choice: 'bossChoice', explanation: 'bossWhy' };
function bossSkills(text) {
  const map = skillMap(text), out = {};
  for (const [label, part] of Object.entries(BOSS_PARTS)) if (map[label]?.length) out[part] = map[label];
  return out;
}

// ---------- embedded pictures ----------
const attr = (tag, name) => new RegExp(`\\b(?:\\w+:)?${name}="([^"]*)"`).exec(tag)?.[1];
const resolvePath = (base, target) => (target.startsWith('/') ? target.slice(1) : new URL(target, `file:///${base}`).pathname.slice(1));
const relsOf = (xml) => Object.fromEntries([...xml.matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)].map((m) => [attr(m[0], 'Id'), attr(m[0], 'Target')]));

// Reads the pictures straight out of the workbook: each picture belongs to the ID in column A of the row it sits on.
// Returns Map(id → png/jpeg bytes); a Round 2 case repeats its picture on each of its three rows, the first one is kept.
function embeddedImages(buffer, wb, sheetNames) {
  const files = unzipSync(new Uint8Array(buffer), { filter: (f) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|worksheets\/_rels\/[^/]+|drawings\/.+|media\/.+)$/.test(f.name) });
  const text = (p) => (files[p] ? strFromU8(files[p]) : '');
  const sheetFile = new Map();
  const wbRels = relsOf(text('xl/_rels/workbook.xml.rels'));
  for (const m of text('xl/workbook.xml').matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)) {
    const target = wbRels[attr(m[0], 'id')];
    if (target) sheetFile.set(attr(m[0], 'name'), resolvePath('xl/workbook.xml', target));
  }
  const found = new Map();
  for (const sheetName of sheetNames) {
    const file = sheetFile.get(sheetName), ws = wb.Sheets[sheetName];
    if (!file || !ws) continue;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const sheetRels = relsOf(text(file.replace(/([^/]+)$/, '_rels/$1.rels')));
    const drawing = Object.values(sheetRels).find((t) => /drawings\//.test(t));
    if (!drawing) continue;
    const drawingFile = resolvePath(file, drawing), dRels = relsOf(text(drawingFile.replace(/([^/]+)$/, '_rels/$1.rels')));
    for (const a of text(drawingFile).matchAll(/<(?:\w+:)?(?:twoCellAnchor|oneCellAnchor)\b[\s\S]*?<\/(?:\w+:)?(?:twoCellAnchor|oneCellAnchor)>/g)) {
      const row0 = Number(/<(?:\w+:)?from>[\s\S]*?<(?:\w+:)?row>(\d+)</.exec(a[0])?.[1]);
      const embed = /\bembed="([^"]+)"/.exec(a[0])?.[1];
      const media = embed && dRels[embed] && files[resolvePath(drawingFile, dRels[embed])];
      const id = Number.isFinite(row0) && String(rows[row0]?.[0] ?? '').trim();
      if (media && id && !found.has(id)) found.set(id, media);
    }
  }
  return found;
}

async function webImage(bytes) {
  const buf = await sharp(Buffer.from(bytes)).rotate().resize({ width: BANK_IMAGE_WIDTH, withoutEnlargement: true }).webp({ quality: 84 }).toBuffer();
  return { buf, type: 'image/webp' };
}

// ---------- loading ----------
async function readBankFile() {
  if (env.bankFile) {
    const st = fs.statSync(env.bankFile);
    const meta = { name: env.bankFile, version: String(st.mtimeMs), modifiedTime: st.mtime.toISOString(), source: 'local file' };
    if (bank && bank.meta.version === meta.version) return null;
    return { buffer: fs.readFileSync(env.bankFile), meta };
  }
  const latest = await fileMeta(env.bankFileId).catch(() => null);
  if (bank && latest && bank.meta.version === latest.version && bank.meta.modifiedTime === latest.modifiedTime) return null; // unchanged
  const { buffer, meta } = await downloadSheetFile(env.bankFileId);
  return { buffer, meta: { ...meta, ...(latest || {}) } };
}

export async function loadBank() {
  const file = await readBankFile();
  if (!file) return bankInfo();
  const { buffer, meta } = file;
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheet = (name) => wb.SheetNames.find((n) => norm(n) === norm(name));
  const tab = (name) => (sheet(name) ? readTable(wb.Sheets[sheet(name)]) : []);

  // skill names for the score card (fall back to the built-in ones)
  const skillRows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames.find((n) => norm(n) === 'skills_selection')] || {}, { header: 1, defval: '' });
  const nextSkills = Object.fromEntries(Object.entries(SKILLS).map(([id, s]) => [id, { ...s }]));
  for (const r of skillRows) if (/^S\d+$/.test(String(r[0]).trim()) && r[1]) Object.assign(nextSkills[String(r[0]).trim()] ||= { tip: '' }, { name: String(r[1]).trim(), about: String(r[2] || '').trim() });

  const blitz = latestActive(tab('R1 Blitz'), (r) => pick(r, 'question_id')).map((r) => ({
    id: pick(r, 'question_id'), bands: bandsOf(r), difficulty: difficulty(r.difficulty) || 'Medium', skill: norm(pick(r, 'skill_slot')), skillId: pick(r, 'skill_id'),
    max: num(pick(r, 'max_points'), 2), question: pick(r, 'student_question'), options: options(pick(r, 'four_options')), key: pick(r, 'key_id').toUpperCase().trim(),
    explanation: pick(r, 'answer_explanation'), clue: pick(r, 'clue_flash'), hide: letters(pick(r, '50_50_hide_ids')),
  })).filter((q) => q.options.length >= 2 && q.key && q.bands.length);

  const boss = latestActive(tab('R1 Boss'), (r) => pick(r, 'question_id')).map((r) => ({
    id: pick(r, 'question_id'), bands: bandsOf(r), difficulty: difficulty(r.difficulty) || 'Medium',
    question: pick(r, 'student_task'), options: options(pick(r, 'four_options')), key: pick(r, 'key_id').toUpperCase().trim(),
    explanation: pick(r, 'full_credit_explanation'), clue: pick(r, 'clue_flash'), hide: letters(pick(r, '50_50_hide_ids')), skills: bossSkills(pick(r, 'skill_scoring')),
  })).filter((q) => q.options.length >= 2 && q.key && q.bands.length);

  // Pictures first (a case or target without one can't be played). Built into a new map, then swapped in at once.
  const nextImages = new Map();
  try {
    const raw = [...embeddedImages(buffer, wb, [sheet('R2 Questions'), sheet('R3 Questions')].filter(Boolean))];
    for (let i = 0; i < raw.length; i += 4) {
      const done = await Promise.all(raw.slice(i, i + 4).map(async ([id, bytes]) => [id, await webImage(bytes)]));
      for (const [id, img] of done) nextImages.set(id, img);
    }
  } catch (err) { console.warn('Could not read the pictures in the question bank:', err.message); }

  // Round 2: rows grouped by Case ID, questions 1–3 (spot, evidence, fix).
  const KINDS = { 1: 'spot', 2: 'evidence', 3: 'fix' };
  const r2rows = latestActive(tab('R2 Questions'), (r) => pick(r, 'case_id') && `${pick(r, 'case_id')}|${pick(r, 'question')}`);
  const byCase = new Map();
  for (const r of r2rows) { const id = pick(r, 'case_id'); if (!byCase.has(id)) byCase.set(id, []); byCase.get(id).push(r); }
  const cases = [...byCase.entries()].map(([id, rows]) => {
    const first = rows[0];
    const cards = lines(pick(first, 'fact_cards')).map((l) => l.match(/^card\s+([A-Z])\s*[:.\-–]\s*(.+)$/i)).filter(Boolean).map((m) => ({ id: m[1].toUpperCase(), text: m[2] }));
    const questions = rows.map((r) => {
      const n = Number(pick(r, 'question')), opts = options(pick(r, 'options_response'));
      const answer = pick(r, 'correct_answer_sample');
      const mcq = opts.length >= 2;
      return { n, kind: KINDS[n], question: pick(r, 'student_question'), options: mcq ? opts : null, key: mcq ? ((answer.match(/^\s*([A-H])[.)]/) || [])[1] || '') : '',
        written: !mcq, sample: mcq ? '' : answer, explanation: pick(r, 'evidence_explanation'), rubric: pick(r, 'scoring_rubric'), max: num(pick(r, 'max_points'), n === 3 ? 8 : 6) };
    }).filter((q) => q.kind).sort((x, y) => x.n - y.n);
    const complete = questions.length === 3 && questions.every((q, i) => q.n === i + 1 && (q.written ? q.sample || q.rubric : q.key))
      && questions[0].options && questions[1].options && cards.length >= 2 && nextImages.has(id);
    return { id, bands: bandsOf(first), difficulty: difficulty(first.difficulty) || 'Medium', title: pick(first, 'case_title'), imageId: id, cards, questions, complete };
  });

  // Round 3: one picture per row. The older three per band also ask for two short reasons.
  const targets = latestActive(tab('R3 Questions'), (r) => pick(r, 'question_id')).map((r) => {
    const id = pick(r, 'question_id'), question = pick(r, 'student_question');
    return { id, bands: bandsOf(r), origin: /exist/i.test(pick(r, 'origin')) ? 'existing' : 'new', difficulty: difficulty(r.difficulty), title: pick(r, 'image_title'),
      question, reference: pick(r, 'teacher_reference'), rubric: pick(r, 'scoring_rubric'), imageId: id, type: 'image',
      needsReasons: /\breasons?\b/i.test(question), goalLens: pick(r, 'goal_lens'), structureScan: pick(r, 'structure_scan') };
  }).filter((t) => t.bands.length && nextImages.has(t.imageId));

  const format = sheet('R2 Questions') && sheet('R3 Questions') ? 'current' : 'unsupported';
  if (format !== 'current') console.error(`The question bank ${meta.name} has no “R2 Questions” / “R3 Questions” sheets. Set QUESTION_BANK_FILE_ID to the compiled bank (1pVfKokcXqrNdCFeVPuPmUNIlPGOflZ1Q).`);
  images = nextImages;
  skills = nextSkills;
  bank = { meta: { ...meta, loadedAt: new Date().toISOString() }, format, blitz, boss, cases, targets };
  return bankInfo();
}

// Game Flow tab: phase order, non-round durations and narration scripts. Rounds default to 8 minutes.
export async function loadFlow() {
  if (env.bankFile) return flow; // offline/test runs use the built-in flow
  try {
    const { buffer } = await downloadSheetFile(env.rulesFileId);
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const name = wb.SheetNames.find((n) => norm(n) === 'game_flow');
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', raw: false });
    const h = rows.findIndex((r) => r.some((c) => norm(c) === 'phase') && r.some((c) => norm(c) === 'seconds'));
    const keys = rows[h].map(norm);
    const out = [];
    let round = 0;
    for (const r of rows.slice(h + 1)) {
      const row = Object.fromEntries(keys.map((k, i) => [k, String(r[i] ?? '').trim()]));
      const phase = row.phase.toLowerCase(), sec = Number(row.seconds);
      if (!phase || !sec) continue;
      const script = pick(row, 'foldling'), title = row.screen;
      let m;
      if (/welcome/.test(phase)) out.push({ key: 'welcome', type: 'welcome', round: 0, sec, title, script });
      else if ((m = phase.match(/r(\d)\s*brief/))) out.push({ key: `r${m[1]}-brief`, type: 'brief', round: Number(m[1]), sec, title, script });
      else if ((m = phase.match(/^round\s*(\d)/))) { round = Number(m[1]); out.push({ key: `r${round}`, type: 'round', round, sec: ROUND_SECONDS, title }); }
      else if (/transition/.test(phase)) out.push({ key: `r${round}-done`, type: 'transition', round, sec, title, script });
      else if (/finish/.test(phase)) out.push({ key: 'finish', type: 'finish', round, sec, title, script });
    }
    const rounds = out.filter((p) => p.type === 'round').map((p) => p.round).join();
    if (rounds === '1,2,3' && out.at(-1).type === 'finish') flow = out;
  } catch (err) {
    console.warn('Game Flow sheet not read, using built-in timings:', err.message);
  }
  return flow;
}

function counts() {
  return Object.fromEntries(BANDS.map((b) => [b.id, {
    blitz: bank.blitz.filter((q) => q.bands.includes(b.id)).length,
    boss: bank.boss.filter((q) => q.bands.includes(b.id)).length,
    cases: bank.cases.filter((c) => c.complete && c.bands.includes(b.id)).length,
    targets: bank.targets.filter((t) => t.bands.includes(b.id)).length,
    images: bank.targets.filter((t) => t.bands.includes(b.id)).length,
  }]));
}

// Every question in one grade band, for the admin's "which questions does each grade get" view (no keys).
export function bandCatalogue(bandId) {
  if (!bank) return null;
  const lvl = (d) => d || 'Any';
  return {
    blitz: bank.blitz.filter((q) => q.bands.includes(bandId)).map((q) => ({ id: q.id, difficulty: q.difficulty, skill: SKILL_LABELS[q.skill] || q.skill, text: q.question })),
    boss: bank.boss.filter((q) => q.bands.includes(bandId)).map((q) => ({ id: q.id, difficulty: q.difficulty, text: q.question })),
    cases: bank.cases.filter((c) => c.bands.includes(bandId)).map((c) => ({ id: c.id, difficulty: c.difficulty, text: c.title, ready: c.complete, fix: c.questions[2]?.written ? 'Written prompt' : 'Choice' })),
    targets: bank.targets.filter((t) => t.bands.includes(bandId)).map((t) => ({ id: t.id, difficulty: lvl(t.difficulty), text: t.title, reasons: t.needsReasons })),
  };
}

// ---------- drawing ----------
function rngFrom(seed) { // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const shuffle = (arr, rng) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const choose = (arr, rng) => arr[Math.floor(rng() * arr.length)];

// Round 2/3 difficulty follows how the band did so far: weak → Easy, solid → Medium, strong → Hard.
export function levelFor(perf) {
  if (perf == null) return ADAPTIVE_DEFAULT;
  return ADAPTIVE_THRESHOLDS.find((t) => perf < t.below).level;
}

// Items at the wanted difficulty (plus any with no difficulty set), else the nearest level (ties go to the easier side).
function byNearest(pool, wanted, rng) {
  const exact = pool.filter((x) => x.difficulty === wanted || x.difficulty == null);
  if (exact.length) return choose(exact, rng);
  const w = DIFFICULTIES.indexOf(wanted);
  const ranked = [...DIFFICULTIES].sort((a, b) => Math.abs(DIFFICULTIES.indexOf(a) - w) - Math.abs(DIFFICULTIES.indexOf(b) - w) || DIFFICULTIES.indexOf(a) - DIFFICULTIES.indexOf(b));
  for (const d of ranked) { const hits = pool.filter((x) => x.difficulty === d); if (hits.length) return choose(hits, rng); }
  return null;
}

// Round 1: the four mandatory slots (privacy, agency, fairness, uncertainty = skills S08–S11) plus four of the other seven,
// with exactly 3 Easy, 3 Medium and 2 Hard spread over the eight slots at random.
function drawBlitz(bandId, rng) {
  const pool = bank.blitz.filter((q) => q.bands.includes(bandId));
  const have = new Set(pool.map((q) => q.skill));
  if (!R1_MANDATORY.every((s) => have.has(s))) return null;
  const others = R1_OTHERS.filter((s) => have.has(s));
  const need = Object.values(R1_MIX).reduce((a, b) => a + b, 0) - R1_MANDATORY.length;
  if (others.length < need) return null;
  const diffs = Object.entries(R1_MIX).flatMap(([d, n]) => Array(n).fill(d));
  for (let attempt = 0; attempt < 300; attempt++) {
    const slots = shuffle([...R1_MANDATORY, ...shuffle(others, rng).slice(0, need)], rng);
    const ds = shuffle(diffs, rng);
    const picked = slots.map((s, i) => { const hits = pool.filter((q) => q.skill === s && q.difficulty === ds[i]); return hits.length ? choose(hits, rng) : null; });
    if (picked.every(Boolean)) {
      const queue = Object.fromEntries(DIFFICULTIES.map((d) => [d, picked.filter((q) => q.difficulty === d)]));
      return R1_ORDER.map((d) => queue[d].shift()).filter(Boolean).concat(DIFFICULTIES.flatMap((d) => queue[d]));
    }
  }
  return null;
}

// What is missing in the bank for a band (empty list = the band can be played).
export function bandProblems(bandId) {
  if (!bank) return ['Question bank not loaded'];
  if (bank.format !== 'current') return ['the question bank is in an old format — use the compiled bank with “R2 Questions” and “R3 Questions”'];
  const problems = [];
  if (!drawBlitz(bandId, rngFrom(1))) problems.push('not enough active Round 1 quick questions (needs the four mandatory skill slots and 3 Easy / 3 Medium / 2 Hard)');
  if (!bank.boss.some((q) => q.bands.includes(bandId))) problems.push('no active Round 1 boss');
  if (!bank.cases.some((c) => c.complete && c.bands.includes(bandId))) problems.push('no complete Round 2 case with its picture');
  if (!bank.targets.some((t) => t.bands.includes(bandId))) problems.push('no Round 3 picture');
  return problems;
}

// Draws one round's content for a band. `perf` (0–1) is the band's average so far, used for rounds 2 and 3.
export function drawRound(round, bandId, perf) {
  if (!bank) throw new Error('Question bank not loaded');
  const seed = crypto.randomInt(2 ** 31);
  const rng = rngFrom(seed);
  const level = round === 1 ? 'Balanced' : levelFor(perf);
  let content;
  if (round === 1) {
    const items = drawBlitz(bandId, rng);
    const boss = byNearest(bank.boss.filter((q) => q.bands.includes(bandId)), BOSS_DIFFICULTY, rng);
    if (!items || !boss) throw new Error('Not enough active Round 1 questions for this band');
    content = { items, boss };
  } else if (round === 2) {
    const c = byNearest(bank.cases.filter((x) => x.complete && x.bands.includes(bandId)), level, rng);
    if (!c) throw new Error('No complete Round 2 case for this band');
    content = { v: 2, case: c };
  } else {
    const t = byNearest(bank.targets.filter((x) => x.bands.includes(bandId)), level, rng);
    if (!t) throw new Error('No Round 3 picture for this band');
    content = { v: 2, target: t };
  }
  return { round, band: bandId, seed, level, perf, bankVersion: bank.meta.version || bank.meta.modifiedTime || bank.meta.loadedAt, drawnAt: Date.now(), content };
}

// Student-facing view: no keys, explanations, clues, rubrics or example answers. Picture links are added by the game (signed).
export function publicView(set) {
  const c = set.content;
  if (set.round === 1) {
    return {
      items: c.items.map((q) => ({ id: q.id, type: SKILL_LABELS[q.skill] || 'Quick challenge', question: q.question, options: q.options })),
      boss: { id: c.boss.id, type: 'Final boss', question: c.boss.question, options: c.boss.options },
    };
  }
  if (set.round === 2) {
    const k = c.case;
    return { title: k.title, imageId: k.imageId, cards: k.cards,
      steps: k.questions.map((q) => ({ n: q.n, kind: q.kind, question: q.question, options: q.options, written: q.written, max: q.max })) };
  }
  const t = c.target;
  return { title: t.title, question: t.question, imageId: t.imageId, needsReasons: Boolean(t.needsReasons) };
}
