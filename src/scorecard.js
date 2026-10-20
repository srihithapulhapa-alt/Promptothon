// Score card: a student's results plus the 11-skill profile.
// Skill % = points earned on the components mapped to that skill ÷ points available on them, from the student's own
// assigned questions (never from a round total). A component that informs two skills still counts once in the total.
// Cards are saved in the sheet (Scorecards tab) and rendered from templates/scorecard.html.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { db } from './store.js';
import { SCORE_PARTS, EVENT_NAME, SCORECARD_TEMPLATE, SKILL_CARD, SKILL_PERCENT_FLOOR, bandOf } from './config.js';
import { getSkills } from './bank.js';

const ASSETS = new URL('../templates/scorecard-assets/', import.meta.url);
const R2_PARTS = { rebuild: ['rebuild'], spot: ['spotId', 'spotWhy'], match: ['matchId', 'matchWhy'], repair: ['repairFix', 'repairWhy'] };
const maxOf = (round, key) => SCORE_PARTS[round].find((p) => p.key === key).max;
const sum = (rec) => Object.values(rec.score.parts).reduce((t, p) => t + (p.points || 0), 0);

// Every scored component of a student's submitted rounds, with the skills it feeds.
function components(a) {
  const out = [];
  const add = (task, part, round, earned, skills) => { if (skills?.length) out.push({ task, part, round, earned, max: maxOf(round, part), skills }); };
  for (const r of [1, 2, 3]) {
    const rec = a.rounds?.[r];
    if (!rec?.submittedAt || !rec.score) continue; // a round the student never reached has no assigned questions
    const c = db.sets.find((s) => s.id === rec.setId)?.content, parts = rec.score.parts || {};
    if (r === 1 && c?.items?.[0]?.skillId) {
      for (const q of c.items) out.push({ task: q.id, part: 'quick', round: 1, earned: parts.quick?.items?.[q.id] ?? 0, max: q.max ?? 2, skills: [{ id: q.skillId, max: q.max ?? 2 }] });
      for (const part of ['bossChoice', 'bossWhy']) add(c.boss.id, part, 1, parts[part]?.points, c.boss.skills?.[part]);
    } else if (r === 2 && c?.case) {
      for (const [type, keys] of Object.entries(R2_PARTS)) for (const part of keys) add(`${c.case.id}:${type}`, part, 2, parts[part]?.points, c.case.puzzles[type]?.skills?.[part]);
    } else if (r === 3 && c?.target) {
      for (const p of SCORE_PARTS[3]) add(c.target.id, p.key, 3, parts[p.key]?.points, c.target.skills?.[p.key]);
    }
  }
  return out;
}

// The card as computed from the saved answers, before any admin edits.
export function baseCard(a) {
  const student = db.students.find((s) => s.id === a.studentId);
  const comps = components(a);
  if (!student || !comps.length) return null; // nothing scored with skill data yet (or an attempt from the old bank)
  const agg = {};
  let pending = false;
  for (const c of comps) {
    for (const m of c.skills) {
      const s = (agg[m.id] ||= { earned: 0, available: 0, tasks: new Set() });
      if (c.earned === undefined) { pending = true; continue; } // pending is not zero
      s.earned += (c.earned * m.max) / c.max;
      s.available += m.max;
      s.tasks.add(c.task);
    }
  }
  const info = getSkills();
  const skills = Object.keys(info).sort().map((id) => {
    const s = agg[id];
    const [name, about] = SKILL_CARD[id] || [info[id].name, info[id].about];
    const raw = s?.available ? s.earned / s.available : null; // 0–1
    return { id, name, about, percent: raw == null ? null : Math.round(SKILL_PERCENT_FLOOR + raw * (100 - SKILL_PERCENT_FLOOR)), evidence: s?.tasks.size || 0 };
  });
  const rounds = [1, 2, 3].map((r) => (a.rounds?.[r]?.score ? sum(a.rounds[r]) : null));
  const awaiting = pending || [1, 2, 3].some((r) => a.rounds?.[r]?.score?.pending);
  const scored = skills.filter((s) => s.percent != null);
  const best = [...scored].sort((x, y) => y.percent - x.percent || y.evidence - x.evidence || x.id.localeCompare(y.id))[0];
  const low = [...scored].sort((x, y) => x.percent - y.percent || x.evidence - y.evidence || x.id.localeCompare(y.id))[0];
  return {
    attemptId: a.id, studentId: student.id, code: student.code, name: student.name, grade: student.grade, band: bandOf(student.grade),
    school: db.schools.find((x) => x.id === student.schoolId)?.name || '', event: EVENT_NAME,
    status: awaiting ? 'pending' : db.events[0]?.finalPublished ? 'final' : 'provisional',
    total: rounds.reduce((t, v) => t + (v || 0), 0), rounds, skills,
    strength: best ? `My strongest skill was ${best.name}. ${best.about}` : '', nextStep: low ? info[low.id].tip || '' : '',
  };
}

// The card as students, PDFs and emails see it: the computed card with the admin's edits applied, plus approval and email state.
// a.card = { edits: { name, grade, school, code, total, rounds:[…], strength, nextStep, skills:{S01: 80} }, approved, sentAt, sentTo, … }
export function scorecard(a) {
  const base = baseCard(a);
  if (!base) return null;
  const e = a.card?.edits || {}, student = db.students.find((x) => x.id === a.studentId);
  const rounds = base.rounds.map((v, i) => e.rounds?.[i] ?? v);
  const card = {
    ...base, ...Object.fromEntries(['name', 'school', 'code', 'grade', 'strength'].filter((k) => e[k] !== undefined).map((k) => [k, e[k]])),
    nextStep: e.nextStep ?? base.nextStep, rounds, total: e.total ?? (e.rounds ? rounds.reduce((t, v) => t + (v || 0), 0) : base.total),
    skills: base.skills.map((k) => ({ ...k, percent: e.skills?.[k.id] ?? k.percent, edited: e.skills?.[k.id] !== undefined })),
    email: student?.email || '', approved: Boolean(a.card?.approved), approvedAt: a.card?.approvedAt || null,
    emailedAt: a.card?.sentAt || null, emailedTo: a.card?.sentTo || '', archived: Boolean(a.archived), run: a.runId || a.eventId,
  };
  card.edited = Boolean(Object.keys(e).length);
  card.version = hash(card); // changes whenever anything the student would see changes
  card.changedSinceEmailed = Boolean(card.emailedAt && a.card.sentVersion !== card.version);
  return card;
}

const hash = (c) => crypto.createHash('sha1').update(JSON.stringify([c.name, c.grade, c.school, c.code, c.total, c.rounds, c.strength, c.nextStep, c.skills.map((k) => k.percent)])).digest('hex').slice(0, 10);
export const scorecards = () => db.attempts.map(scorecard).filter(Boolean);

// ---------- template ----------
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fill = (text, values) => text.replace(/\{\{(\w+)\}\}/g, (_, k) => esc(values[k] ?? ''));

// Placeholders: {{student_name}} {{grade}} {{player_code}} {{school}} {{band}} {{event}} {{status}} {{total}} {{round1}} {{round2}}
// {{round3}} {{strength}} {{next_step}} {{date}} {{logo_url}} {{grade_number}}, a repeated block {{#skills}} … {{/skills}} that may use
// {{id}} {{name}} {{about}} {{percent}} {{percent_text}} {{bar}} {{evidence}}, and every picture in templates/scorecard-assets/ as
// {{asset_<name>}} (embedded as data, so PDFs keep it). The file is read on every request, so edits show immediately.
export function renderScorecard(card, { logo = '/the-ai-club-logo.png' } = {}) {
  const template = fs.readFileSync(new URL(`../${SCORECARD_TEMPLATE}`, import.meta.url), 'utf8'); // relative to the project, not the working folder
  const dash = (v) => (v == null ? '—' : v);
  const assets = Object.fromEntries(fs.readdirSync(ASSETS).map((f) => [`asset_${f.replace(/\.[^.]+$/, '')}`, `data:image/png;base64,${fs.readFileSync(new URL(f, ASSETS)).toString('base64')}`]));
  const values = {
    ...assets, grade_number: card.grade, student_name: card.name, grade: /^\d+$/.test(String(card.grade)) ? `Grade ${card.grade}` : card.grade, player_code: card.code, school: card.school, band: card.band, event: card.event,
    status: { final: 'Final results', provisional: 'Provisional results', pending: 'Scoring in progress' }[card.status],
    total: card.total, round1: dash(card.rounds[0]), round2: dash(card.rounds[1]), round3: dash(card.rounds[2]),
    strength: card.strength, next_step: card.nextStep, date: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }), logo_url: logo,
  };
  return fill(template.replace(/\{\{#skills\}\}([\s\S]*?)\{\{\/skills\}\}/g, (_, inner) => card.skills
    .map((s) => fill(inner, { ...s, percent: s.percent == null ? '—' : s.percent, percent_text: s.percent == null ? '—' : `${s.percent}%`, bar: s.percent ?? 0 })).join('')), values);
}
