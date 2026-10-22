// Question bank + game flow, read from Drive. Only rows whose Status is "Active" are used, and only the
// latest version of each ID. Questions are never generated — every item comes from the bank as written.
// The bank also carries the skill mapping behind the score card and the embedded Round 3 pictures.
import crypto from 'node:crypto';
import * as XLSX from 'xlsx';
import { unzipSync, strFromU8 } from 'fflate';
import sharp from 'sharp';
import { env, BANDS, DEFAULT_FLOW, ROUND_SECONDS, R1_MIX, R1_ORDER, R1_MANDATORY, R1_OTHERS, BOSS_DIFFICULTY, DIFFICULTIES,
  ADAPTIVE_THRESHOLDS, ADAPTIVE_DEFAULT, SKILL_LABELS, SKILLS, BANK_IMAGE_WIDTH } from './config.js';
import { downloadSheetFile, fileMeta } from './google.js';

let bank = null;
let flow = DEFAULT_FLOW;
let skills = SKILLS;
const images = new Map(); // image id → { buf, type } — resized for the web, served only to the student the target was drawn for
// Rules and the round-to-round break are folded into each round's briefing, so kids see one timer per set of instructions.
export const getFlow = () => flow.filter((p) => p.type !== 'welcome' && p.type !== 'transition');
export const bankInfo = () => bank && { meta: bank.meta, counts: counts() };
export const getSkills = () => skills;
export const imageFor = (id) => images.get(id);

// ---------- parsing helpers ----------
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const lines = (s) => String(s ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const pick = (row, prefix) => row[Object.keys(row).find((k) => k === prefix || k.startsWith(`${prefix}_`)) ?? ''] ?? '';
const words = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9]+/g) || []);

function readTable(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
  const h = rows.findIndex((r) => r.some((c) => norm(c) === 'status'));
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
  return [...latest.values()].filter((r) => r.status.trim().toLowerCase() === 'active'
    && (!pick(r, 'language') || /^en/i.test(pick(r, 'language'))));
}

function bandsOf(row) {
  const name = pick(row, 'grade_band').toLowerCase().replace(/\s+/g, ' ').trim();
  return BANDS.filter((b) => b.bank.includes(name)).map((b) => b.id);
}

const difficulty = (s) => DIFFICULTIES.find((d) => d.toLowerCase() === String(s).trim().toLowerCase()) || 'Medium';
const options = (s) => lines(s).map((l) => l.match(/^([A-H])[.)]\s*(.+)$/)).filter(Boolean).map((m) => ({ id: m[1], text: m[2] }));
const letters = (s) => String(s).toUpperCase().match(/\b[A-H]\b/g) || [];
const labelled = (s, re, fallbackPrefix) => {
  const ls = lines(s);
  const hits = ls.map((l) => l.match(re)).filter(Boolean);
  if (hits.length) return hits.map((m) => ({ id: m[1].toUpperCase(), text: m[2] }));
  return ls.map((text, i) => ({ id: `${fallbackPrefix}${i + 1}`, text }));
};
const splitAfter = (s, label) => {
  const i = String(s).search(new RegExp(`${label}\\s*:`, 'i'));
  return i < 0 ? [String(s).trim(), ''] : [String(s).slice(0, i).trim(), String(s).slice(i).replace(/^[^:]*:\s*/, '').trim()];
};
const num = (v, d) => (Number.isFinite(parseFloat(v)) ? parseFloat(v) : d);

function overlapRatio(a, b) {
  const A = words(a), B = words(b);
  if (!B.size) return 0;
  let n = 0;
  for (const w of B) if (A.has(w)) n++;
  return n / B.size;
}

// "choice: S06 /2; explanation: S04 /3 and S07 /3" → { choice: [{id:'S06', max:2}], explanation: [{S04,3},{S07,3}] }
// A component can inform two skills; it is still counted once in the competition total.
function skillMap(text) {
  const out = {};
  for (const part of String(text || '').split(';')) {
    const m = part.match(/^\s*([^:]+):\s*(.+)$/);
    if (m) out[norm(m[1])] = [...m[2].matchAll(/(S\d+)\s*\/\s*(\d+)/g)].map((x) => ({ id: x[1], max: Number(x[2]) }));
  }
  return out;
}
// The labels the bank uses → the score parts the game awards (see SCORE_PARTS in config.js).
const PART_OF = {
  boss: { choice: 'bossChoice', explanation: 'bossWhy' },
  rebuild: { slots_all_correct_bonus: 'rebuild' },
  spot: { identification: 'spotId', explanation: 'spotWhy' },
  match: { evidence_id: 'matchId', connection: 'matchWhy' },
  repair: { content_checks: 'repairFix', explanation: 'repairWhy' },
  target: { purpose_audience: 'purpose', content: 'content', structure: 'format', clarity_constraints: 'clarity', rationale: 'rationale' },
};
function partSkills(kind, text) {
  const map = skillMap(text), out = {};
  for (const [label, part] of Object.entries(PART_OF[kind])) if (map[label]?.length) out[part] = map[label];
  return out;
}

// ---------- embedded pictures (Round 3 image targets) ----------
const attr = (tag, name) => new RegExp(`\\b(?:\\w+:)?${name}="([^"]*)"`).exec(tag)?.[1];
const resolvePath = (base, target) => (target.startsWith('/') ? target.slice(1) : new URL(target, `file:///${base}`).pathname.slice(1));
const relsOf = (xml) => Object.fromEntries([...xml.matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)].map((m) => [attr(m[0], 'Id'), attr(m[0], 'Target')]));

// Reads the pictures straight out of the workbook and returns Map(image id → png/jpeg bytes).
function embeddedImages(buffer, wb) {
  const files = unzipSync(new Uint8Array(buffer), { filter: (f) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|worksheets\/_rels\/[^/]+|drawings\/.+|media\/.+)$/.test(f.name) });
  const text = (p) => (files[p] ? strFromU8(files[p]) : '');
  const sheetFile = new Map();
  const wbRels = relsOf(text('xl/_rels/workbook.xml.rels'));
  for (const m of text('xl/workbook.xml').matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)) {
    const target = wbRels[attr(m[0], 'id')];
    if (target) sheetFile.set(attr(m[0], 'name'), resolvePath('xl/workbook.xml', target));
  }
  const found = new Map();
  for (const [sheetName, idAtRow] of [['R3 Images', (rows, row0) => { for (let i = row0; i >= 0; i--) { const v = String(rows[i]?.[0] ?? '').trim(); if (/-R3-IMAGE-\w+$/i.test(v)) return v; } return null; }],
    ['R3 Targets', (rows, row0) => String(rows[row0]?.[0] ?? '').trim() || null]]) {
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
      const id = Number.isFinite(row0) && idAtRow(rows, row0);
      if (media && id && !found.has(id)) found.set(id, media);
    }
  }
  return found;
}

async function webImage(bytes) {
  const buf = await sharp(Buffer.from(bytes)).rotate().resize({ width: BANK_IMAGE_WIDTH, withoutEnlargement: true }).webp({ quality: 86 }).toBuffer();
  return { buf, type: 'image/webp' };
}

// ---------- loading ----------
export async function loadBank() {
  const latest = await fileMeta(env.bankFileId).catch(() => null);
  if (bank && latest && bank.meta.version === latest.version && bank.meta.modifiedTime === latest.modifiedTime) return bankInfo(); // unchanged
  const { buffer, meta } = await downloadSheetFile(env.bankFileId);
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const tab = (name) => {
    const k = wb.SheetNames.find((n) => norm(n) === norm(name));
    return k ? readTable(wb.Sheets[k]) : [];
  };

  // skill names for the score card (fall back to the built-in ones)
  const skillRows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames.find((n) => norm(n) === 'skills_selection')] || {}, { header: 1, defval: '' });
  const nextSkills = Object.fromEntries(Object.entries(SKILLS).map(([id, s]) => [id, { ...s }]));
  for (const r of skillRows) if (/^S\d+$/.test(String(r[0]).trim()) && r[1]) Object.assign(nextSkills[String(r[0]).trim()] ||= { tip: '' }, { name: String(r[1]).trim(), about: String(r[2] || '').trim() });

  const blitz = latestActive(tab('R1 Blitz'), (r) => pick(r, 'question_id')).map((r) => ({
    id: pick(r, 'question_id'), bands: bandsOf(r), difficulty: difficulty(r.difficulty), skill: norm(pick(r, 'skill_slot')), skillId: pick(r, 'skill_id'),
    max: num(pick(r, 'max_points'), 2), question: pick(r, 'student_question'), options: options(pick(r, 'four_options')), key: pick(r, 'key_id').toUpperCase().trim(),
    explanation: pick(r, 'answer_explanation'), clue: pick(r, 'clue_flash'), hide: letters(pick(r, '50_50_hide_ids')),
  })).filter((q) => q.options.length >= 2 && q.key);

  const boss = latestActive(tab('R1 Boss'), (r) => pick(r, 'question_id')).map((r) => ({
    id: pick(r, 'question_id'), bands: bandsOf(r), difficulty: difficulty(r.difficulty),
    question: pick(r, 'student_task'), options: options(pick(r, 'four_options')), key: pick(r, 'key_id').toUpperCase().trim(),
    explanation: pick(r, 'full_credit_explanation'), clue: pick(r, 'clue_flash'), hide: letters(pick(r, '50_50_hide_ids')), skills: partSkills('boss', pick(r, 'skill_scoring')),
  })).filter((q) => q.options.length >= 2 && q.key);

  const puzzles = latestActive(tab('R2 Puzzles'), (r) => pick(r, 'case_id') && `${pick(r, 'case_id')}|${norm(r.puzzle)}`);
  const cases = latestActive(tab('R2 Cases'), (r) => pick(r, 'case_id')).map((r) => {
    const id = pick(r, 'case_id');
    const [title, ...context] = lines(pick(r, 'case_title_and_context'));
    const output = labelled(pick(r, 'ai_output_to_investigate'), /^paragraph\s*(\d+)\s*[:.\-–]\s*(.+)$/i, 'P')
      .map((p) => ({ ...p, id: p.id.startsWith('P') ? p.id : `P${p.id}`, label: `Paragraph ${p.id.replace(/\D/g, '')}` }));
    const evidence = labelled(pick(r, 'evidence_cards'), /^(E\d+)\s*[:.\-–]\s*(.+)$/i, 'E');
    const compass = pick(r, 'case_compass');
    const ps = Object.fromEntries(puzzles.filter((p) => pick(p, 'case_id') === id).map((p) => {
      const type = norm(p.puzzle);
      const base = { task: pick(p, 'student_task'), expected: pick(p, 'expected_answer'), rubric: pick(p, 'rubric'), clue: pick(p, 'unlock_a_clue'), skills: partSkills(type, pick(p, 'skill_scoring')) };
      if (type === 'rebuild') {
        base.blocks = labelled(pick(p, 'puzzle_input'), /^(B\d+)\s*[:.\-–]\s*(.+)$/i, 'B');
        base.order = String(base.expected).toUpperCase().match(/B\d+/g) || [];
      }
      if (type === 'spot') {
        [base.claim, base.reason] = splitAfter(base.expected, 'Reason');
        const best = output.map((o) => [o.id, overlapRatio(o.text, base.claim)]).sort((a, b) => b[1] - a[1])[0];
        const fromCompass = compass.match(/paragraph\s*(\d+)/i);
        base.paragraph = best && best[1] > 0.5 ? best[0] : fromCompass ? `P${fromCompass[1]}` : best?.[0];
      }
      if (type === 'match') {
        const [ev, connection] = splitAfter(base.expected, 'Connection');
        base.evidenceId = (ev.toUpperCase().match(/E\d+/) || [''])[0];
        base.connection = connection;
      }
      return [type, base];
    }));
    return { id, bands: bandsOf(r), difficulty: difficulty(pick(r, 'package_difficulty')), title, context: context.join(' '),
      output, evidence, compass, puzzles: ps, complete: ['rebuild', 'spot', 'match', 'repair'].every((k) => ps[k]) };
  });

  // Embedded pictures: only decoded again when this file's version changed (the check at the top).
  images.clear();
  try {
    for (const [id, bytes] of embeddedImages(buffer, wb)) images.set(id, await webImage(bytes));
  } catch (err) { console.warn('Could not read the pictures in the question bank:', err.message); }

  const targets = latestActive(tab('R3 Targets'), (r) => pick(r, 'target_id')).map((r) => {
    const [title, ...aud] = lines(pick(r, 'target_title'));
    const type = norm(pick(r, 'target_type')) === 'image' ? 'image' : 'text';
    const imageId = pick(r, 'image_id') || (type === 'image' ? pick(r, 'target_id') : '');
    const description = lines(pick(r, 'full_supplied_output'));
    return { id: pick(r, 'target_id'), bands: bandsOf(r), difficulty: difficulty(r.difficulty), title, audience: aud.join(' '), type, imageId,
      output: type === 'image' ? [] : description, alt: description.filter((l) => !/embedded image/i.test(l)).join(' '),
      content: lines(pick(r, 'required_content_features')), format: lines(pick(r, 'required_format_features')), example: pick(r, 'example_prompt'),
      rubric: pick(r, 'rubric'), goalLens: pick(r, 'goal_lens'), structureScan: pick(r, 'structure_scan'), skills: partSkills('target', pick(r, 'skill_scoring')) };
  }).filter((t) => t.type === 'text' || images.has(t.imageId));

  skills = nextSkills;
  bank = { meta: { ...meta, ...(latest || {}), loadedAt: new Date().toISOString() }, blitz, boss, cases, targets };
  return bankInfo();
}

// Game Flow tab: phase order, non-round durations and narration scripts. Rounds default to 8 minutes.
export async function loadFlow() {
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
    images: bank.targets.filter((t) => t.bands.includes(b.id) && t.type === 'image').length,
  }]));
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

// Nearest available difficulty to the wanted one (ties go to the easier side).
function byNearest(pool, wanted, rng) {
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

const r3Pool = (bandId, mode) => bank.targets.filter((t) => t.bands.includes(bandId) && (mode === 'image' ? t.type === 'image' : mode === 'text' ? t.type === 'text' : true));

// What is missing in the bank for a band (empty list = the band can be played).
export function bandProblems(bandId, mode = 'mixed') {
  if (!bank) return ['Question bank not loaded'];
  const problems = [];
  if (!drawBlitz(bandId, rngFrom(1))) problems.push('not enough active Round 1 quick questions (needs the four mandatory skill slots and 3 Easy / 3 Medium / 2 Hard)');
  if (!bank.boss.some((q) => q.bands.includes(bandId))) problems.push('no active Round 1 boss');
  if (!bank.cases.some((c) => c.complete && c.bands.includes(bandId))) problems.push('no complete active Round 2 case');
  if (!r3Pool(bandId, mode).length) problems.push(`no active Round 3 ${mode === 'mixed' ? '' : `${mode} `}target`);
  return problems;
}

// Draws one round's content for a band. `perf` (0–1) is the band's average so far, used for rounds 2 and 3.
export function drawRound(round, bandId, perf, { r3Mode = 'mixed' } = {}) {
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
    if (!c) throw new Error('No complete active Round 2 case for this band');
    content = { case: c };
  } else {
    let pool = r3Pool(bandId, r3Mode);
    if (r3Mode === 'mixed') { const kind = choose([...new Set(pool.map((t) => t.type))], rng); pool = pool.filter((t) => t.type === kind); } // text or image, at random
    const t = byNearest(pool, level, rng);
    if (!t) throw new Error('No active Round 3 target for this band');
    content = { target: t };
  }
  return { round, band: bandId, seed, level, perf, bankVersion: bank.meta.version || bank.meta.modifiedTime || bank.meta.loadedAt, drawnAt: Date.now(), content };
}

// Student-facing view: no keys, explanations, clues, rubrics or example answers.
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
    return { title: k.title, context: k.context, output: k.output, evidence: k.evidence, blocks: k.puzzles.rebuild.blocks,
      tasks: Object.fromEntries(Object.entries(k.puzzles).map(([t, p]) => [t, p.task])) };
  }
  const t = c.target;
  return { title: t.title, audience: t.audience, output: t.output, kind: t.type || 'text', image: t.type === 'image' ? { id: t.imageId, alt: t.alt } : null };
}
