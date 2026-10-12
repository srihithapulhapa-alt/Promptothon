// All environment values and game constants live here. Nothing else reads process.env.
import fs from 'node:fs';
const e = process.env;

export const env = {
  port: Number(e.PORT || 3000),
  baseUrl: (e.BASE_URL || `http://localhost:${e.PORT || 3000}`).replace(/\/$/, ''),
  sessionSecret: e.SESSION_SECRET || 'dev-only-secret',
  dataDir: e.DATA_DIR || './data',
  googleClientId: e.GOOGLE_CLIENT_ID || '',
  googleClientSecret: e.GOOGLE_CLIENT_SECRET || '',
  defaultAdmin: (e.DEFAULT_ADMIN_EMAIL || 'srihitha.pulhapa@expinfi.com').toLowerCase(),
  bankFileId: e.QUESTION_BANK_FILE_ID || '1jYPiILnJbk0yqG_h9AM6PiD6D4kJL1Pr',
  rulesFileId: e.GAME_RULES_FILE_ID || '1knJMFlyXsXr_MjWFHIplUBqv2111wk8K',
  dataSheetId: e.DATA_SHEET_ID || '',
  googleRefreshToken: e.GOOGLE_REFRESH_TOKEN || '',
  anthropicKey: e.ANTHROPIC_API_KEY || '',
  smtpHost: e.SMTP_HOST || 'smtp.gmail.com',
  smtpPort: Number(e.SMTP_PORT || 465),
  smtpUser: e.SMTP_USER || '',
  smtpPass: (e.SMTP_PASS || '').replace(/\s+/g, ''), // Google shows app passwords in groups of four
  smtpFromName: e.SMTP_FROM_NAME || 'The AI Club Promptathon',
  claudeModel: e.CLAUDE_MODEL || 'claude-sonnet-5-5',
};

// Writes (or replaces) one KEY=value line in .env and updates the running process.
export function saveEnv(key, value) {
  const file = '.env';
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const re = new RegExp(`^${key}=.*$`, 'm');
  fs.writeFileSync(file, re.test(text) ? text.replace(re, `${key}=${value}`) : `${text.replace(/\n*$/, '\n')}${key}=${value}\n`);
  const field = { GOOGLE_REFRESH_TOKEN: 'googleRefreshToken', DATA_SHEET_ID: 'dataSheetId' }[key];
  if (field) env[field] = value;
}

export const APP_NAME = 'Promptathon';
export const EVENT_NAME = 'Promptathon';       // one fixed event; there is no way to create another
export const BANK_REFRESH_MS = 5 * 60 * 1000; // re-read the Drive bank/flow so the latest version is always used
export const DATA_SHEET_TITLE = 'The AI Club Promptathon — Results';
export const SESSION_DAYS = 7;

// Google scopes: students only need identity; the backend alone uses Drive + Sheets (see `npm run connect-google`).
export const SCOPES_LOGIN = ['openid', 'email', 'profile'];
export const SCOPES_DRIVE = [...SCOPES_LOGIN,
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/spreadsheets'];

// Grade bands of the question bank. `bank` lists the spellings its "Grade band" column may use.
export const BANDS = [
  { id: 'G3-4', label: 'G3–4', min: 3, max: 4, bank: ['3-4', '3–4', 'g3-4', 'grades 3-4'] },
  { id: 'G5-6', label: 'G5–6', min: 5, max: 6, bank: ['5-6', '5–6', 'g5-6', 'grades 5-6'] },
  { id: 'G7-8', label: 'G7–8', min: 7, max: 8, bank: ['7-8', '7–8', 'g7-8', 'grades 7-8'] },
];
export const GRADES = [3, 4, 5, 6, 7, 8];
export const bandOf = (grade) => BANDS.find((b) => grade >= b.min && grade <= b.max)?.id;

// Timing. Rounds default to 8 minutes whatever the Game Flow sheet says; admins can change the length.
export const ROUND_SECONDS = 480;
export const ROUND_MINUTES_RANGE = { min: 1, max: 30, default: ROUND_SECONDS / 60 }; // admins may change a round's length
export const SAVE_GRACE_MS = 1500;      // an autosave already in flight at the deadline is still accepted
// The Google Sheet is the data store. The server keeps a working copy in memory and writes only the rows that changed.
export const STORE_FLUSH_MS = 2500;      // changed rows reach the sheet within this long (autosave still lands in memory every second)
export const STORE_URGENT_MS = 400;      // …and almost at once after a start, submit, new student or decision
export const STORE_MIN_GAP_MS = 1500;    // never write to Sheets more often than this (Google allows ~60 writes a minute)
export const REPORT_SYNC_MS = 30000;     // readable Results / Answers tabs are rebuilt at most this often
export const SHEET_GRID_ROWS = 5000;     // rows each data tab starts with; more are added automatically
export const PHASE_SECONDS_RANGE = { min: 5, max: 600 };   // welcome, briefing, break and finish screens
export const TIME_ADJUST_RANGE = { min: 5, max: 1800 };    // one "add time" step, in seconds

// Fallback for the Game Flow sheet (27:30). The sheet on Drive overrides scripts and non-round timings.
export const DEFAULT_FLOW = [
  { key: 'welcome', type: 'welcome', round: 0, sec: 45, title: 'Rules and readiness',
    script: 'Welcome to the AI Challenge Arena! Three rounds, eight minutes each. Your answers save as you work. Use your lifelines wisely.' },
  { key: 'r1-brief', type: 'brief', round: 1, sec: 30, title: 'AI Blitz briefing',
    script: 'First up: AI Blitz! Answer eight quick challenges and the final boss. You have eight minutes, fifty–fifty and one clue. Ready?' },
  { key: 'r1', type: 'round', round: 1, sec: ROUND_SECONDS, title: 'AI Blitz' },
  { key: 'r1-done', type: 'transition', round: 1, sec: 15, title: 'Round lock and update',
    script: 'Round one is saved. Next, put on your detective hat!' },
  { key: 'r2-brief', type: 'brief', round: 2, sec: 30, title: 'Crack the AI Case briefing',
    script: 'Crack the AI Case! Rebuild, spot, match and repair. Use the evidence cards. Case Compass and Unlock a Clue can help you.' },
  { key: 'r2', type: 'round', round: 2, sec: ROUND_SECONDS, title: 'Crack the AI Case' },
  { key: 'r2-done', type: 'transition', round: 2, sec: 15, title: 'Round lock and update',
    script: 'Case closed! Your answers are saved. Now let’s work backwards.' },
  { key: 'r3-brief', type: 'brief', round: 3, sec: 30, title: 'Creator Showdown briefing',
    script: 'Match the Output! Read the target and write a prompt that could create it. Include the audience, content and layout. Two lifelines are ready.' },
  { key: 'r3', type: 'round', round: 3, sec: ROUND_SECONDS, title: 'Creator Showdown' },
  { key: 'finish', type: 'finish', round: 3, sec: 45, title: 'Completion and next steps',
    script: 'You’ve completed the arena! Your work is saved. Check your score status. Final rankings appear after the answers are reviewed.' },
];

// Lifelines: each round offers two, and each can be used once per round (no deductions, no extra time).
export const LIFELINES_PER_ROUND = 2;

export const ROUNDS = {
  1: { name: 'AI Blitz', tagline: 'Eight quick challenges. One final boss. Think fast!', icon: '⚡', max: 20,
    lifelines: [
      { id: 'fifty', name: '50–50', desc: 'Removes two incorrect choices from the question you are on.' },
      { id: 'clue', name: 'Clue Flash', desc: 'Shows one prepared clue for the question you are on.' }] },
  2: { name: 'Crack the AI Case', tagline: 'The AI has left four puzzles behind. Can you solve the case?', icon: '🧩', max: 20,
    lifelines: [
      { id: 'compass', name: 'Case Compass', desc: 'Shows which paragraph contains the main trap.' },
      { id: 'unlock', name: 'Unlock a Clue', desc: 'Gives a prepared hint for the puzzle you choose.' }] },
  3: { name: 'Creator Showdown', tagline: 'Your mission. Your choices. Your final creation.', icon: '🎨', max: 20,
    lifelines: [
      { id: 'goal', name: 'Goal Lens', desc: 'A hint about the purpose and the reader of the target.' },
      { id: 'structure', name: 'Structure Scan', desc: 'A hint about the layout of the target.' }] },
};

// Score components (from the Scoring sheet). `auto` parts are key-matched; the rest use the rubric.
export const SCORE_PARTS = {
  1: [
    { key: 'quick', label: 'Quick challenges (8 × 2)', max: 16, auto: true },
    { key: 'bossChoice', label: 'Boss choice', max: 2, auto: true },
    { key: 'bossWhy', label: 'Boss explanation', max: 2 },
  ],
  2: [
    { key: 'rebuild', label: 'Rebuild the prompt', max: 5, auto: true },
    { key: 'spotId', label: 'Spot the trap — identified', max: 2, auto: true },
    { key: 'spotWhy', label: 'Spot the trap — explanation', max: 3 },
    { key: 'matchId', label: 'Match the evidence — card', max: 2, auto: true },
    { key: 'matchWhy', label: 'Match the evidence — connection', max: 3 },
    { key: 'repairFix', label: 'Repair — corrected claim', max: 3 },
    { key: 'repairWhy', label: 'Repair — why it works', max: 2 },
  ],
  3: [
    { key: 'purpose', label: 'Purpose and audience', max: 4 },
    { key: 'content', label: 'Target content', max: 4 },
    { key: 'format', label: 'Format and structure', max: 4 },
    { key: 'clarity', label: 'Clarity and constraints', max: 4 },
    { key: 'rationale', label: 'Rationale', max: 4 },
  ],
};

// Question selection (Skills & Selection sheet).
export const R1_MIX = { Easy: 3, Medium: 3, Hard: 2 };              // 8 quick items
export const R1_MANDATORY = ['privacy', 'agency', 'fairness', 'uncertainty']; // always drawn: skills S08–S11
export const R1_OTHERS = ['clarity', 'detail', 'next_move', 'format', 'confidence', 'verification', 'repair']; // 4 of these 7
export const R1_ORDER = ['Easy', 'Medium', 'Easy', 'Medium', 'Easy', 'Medium', 'Hard', 'Hard'];
export const BOSS_DIFFICULTY = 'Medium';
export const DIFFICULTIES = ['Easy', 'Medium', 'Hard'];
// R2/R3 difficulty follows the band's average performance so far (share of points earned).
export const ADAPTIVE_THRESHOLDS = [{ below: 0.5, level: 'Easy' }, { below: 0.75, level: 'Medium' }, { below: Infinity, level: 'Hard' }];
export const ADAPTIVE_DEFAULT = 'Medium';

export const SKILL_LABELS = {
  clarity: 'Pick the stronger prompt', detail: 'Spot the missing detail', next_move: 'Choose the next move',
  privacy: 'Find the privacy risk', format: 'Match the instruction', confidence: 'AI confidence trap',
  verification: 'Choose the useful check', repair: 'Prompt repair', agency: 'Your call', fairness: 'Fair or unfair?',
  uncertainty: 'What is missing?',
};

// Round 3 targets: text and image, mixed (random) or one kind only. Image targets are prompt-only (the AI tool writes text).
export const R3_MODES = [{ id: 'mixed', label: 'Text and image (random)' }, { id: 'image', label: 'Image only' }, { id: 'text', label: 'Text only' }];
export const BANK_IMAGE_WIDTH = 1280;
export const SCORECARD_TEMPLATE = 'templates/scorecard.html'; // replace this file with the final design, keeping its {{placeholders}}

// Score card: the 11 skills (names and explanations are re-read from the bank; these are the fallbacks) and the "next step" tips.
export const SKILLS = {
  S01: { name: 'Purposeful Communication with AI', about: 'Gives clear instructions to achieve a specific goal.', tip: 'Practise giving AI clear instructions that say exactly what you want.' },
  S02: { name: 'Problem Understanding & Planning', about: 'Identifies the goal, audience and requirements.', tip: 'Practise naming the goal, the audience and what is needed before you write a prompt.' },
  S03: { name: 'Structured Thinking', about: 'Organises ideas and instructions logically.', tip: 'Practise putting your ideas and instructions in a clear order.' },
  S04: { name: 'Critical Thinking & AI Evaluation', about: 'Questions answers and spots unsupported claims.', tip: 'Practise questioning AI answers and spotting claims with nothing to support them.' },
  S05: { name: 'Evidence-Based Reasoning', about: 'Uses relevant evidence to support conclusions.', tip: 'Practise checking evidence before accepting an AI answer.' },
  S06: { name: 'Problem Solving & Improvement', about: 'Identifies problems and proposes useful fixes.', tip: 'Practise spotting what is wrong and suggesting a fix that keeps what is right.' },
  S07: { name: 'Reasoning & Explanation', about: 'Explains choices with clear, relevant reasons.', tip: 'Practise explaining your choices with clear, relevant reasons.' },
  S08: { name: 'Digital Safety & Privacy', about: 'Recognises sensitive information and protects it.', tip: 'Practise noticing private information and keeping it out of AI tools.' },
  S09: { name: 'Independent Judgment & Decision-Making', about: 'Decides when to accept, change or reject AI advice.', tip: 'Practise deciding when to accept, change or reject what AI suggests.' },
  S10: { name: 'Ethical Thinking & Fairness', about: 'Recognises unfair treatment and suggests fairer options.', tip: 'Practise spotting unfair treatment and suggesting fairer options.' },
  S11: { name: 'Managing Uncertainty & Verification', about: 'Recognises missing information and decides what to check.', tip: 'Practise noticing what information is missing and what to check.' },
};

export const R3_GENERATIONS = 2;
export const AI_CONCURRENCY = 4;

export const AWARDS = [
  { id: 'overall', title: 'Overall Winner', round: 0 },
  { id: 'blitz', title: 'Blitz Champion', round: 1 },
  { id: 'detective', title: 'Sharpest Detective', round: 2 },
  { id: 'creative', title: 'Creative Thinker', round: 3 },
];

// Published rules (criteria only — never answers).
export const RULES = {
  general: [
    'You play on your own. There are {rounds}, worth 60 points in total.',
    'Your answers save automatically every second. Look for the “Saved” note next to the timer.',
    'When the timer reaches zero, your saved answers are submitted. Changes after that are not accepted.',
    'Submitting early locks that round. The next round still starts at its scheduled time.',
    'Each round has two lifelines, and each lifeline can be used once in that round. Lifelines never cost points and never add time.',
    'Your host may add time to a round or end it early. The timer on your screen is always the right one.',
    'Scores you see are provisional until the host checks them. Ties are split by Round 2, then Round 3 content.',
    'Never type personal details such as your address, phone number or passwords.',
  ],
  1: [
    'Eight quick challenges, then one final boss question. No AI tool in this round — you decide.',
    'Each quick challenge: 2 points for the correct choice.',
    'Final boss: 2 points for the best choice + 2 points for a one-sentence explanation of why.',
    'Lifelines: 50–50 removes two wrong choices. Clue Flash shows a hint. Neither gives the answer.',
  ],
  2: [
    'You get a Case File: an AI answer, a mixed-up prompt and evidence cards. Solve four puzzles (5 points each).',
    'Rebuild the Prompt: put the four blocks into Goal → Audience → Must include → Format. 1 point per slot, +1 if all four are right.',
    'Spot the Trap: pick the paragraph with the false or misleading claim (2) and explain the problem (3).',
    'Match the Evidence: pick the card that supports a correction (2) and explain how it helps (3).',
    'Repair the Campaign: rewrite the faulty claim correctly (3) and explain why your fix works (2).',
    'One timer of {r} for the whole case — divide your time as you like.',
  ],
  3: [
    'You see a target that an AI made — a text or a picture. Write a prompt that could make something similar.',
    `For a text target you may test your prompt with the AI tool up to ${R3_GENERATIONS} times and choose one result. You can’t edit it. For a picture, write your prompt only.`,
    'Then write three short connections: how parts of your prompt match the target.',
    'Scored on purpose & audience, content, format & structure, clarity, and your rationale (4 points each). Many different prompts can score full marks.',
  ],
};
