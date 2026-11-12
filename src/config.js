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
  contactEmail: (e.CONTACT_EMAIL || e.DEFAULT_ADMIN_EMAIL || 'srihitha.pulhapa@expinfi.com').toLowerCase(), // shown on the privacy page as the grievance contact
  defaultAdmin: (e.DEFAULT_ADMIN_EMAIL || 'srihitha.pulhapa@expinfi.com').toLowerCase(),
  bankFileId: e.QUESTION_BANK_FILE_ID || '1pVfKokcXqrNdCFeVPuPmUNIlPGOflZ1Q',
  bankFile: e.QUESTION_BANK_FILE || '',          // local .xlsx instead of Drive (tests and offline runs)
  memoryStore: e.DATA_STORE === 'memory',        // tests only: keep data in memory, never touch Google Sheets
  googleApiBase: (e.GOOGLE_API_BASE || '').replace(/\/$/, ''), // tests only: a stand-in for Google's APIs
  testAdminKey: e.TEST_ADMIN_KEY || '',          // tests only: lets a script sign in as the default admin without Google. Never set it on a real server.
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
export const SESSION_DAYS = 7;           // admin sign-in (students have no cookie: each browser tab carries its own player token)
export const POLICY_VERSION = '2026-11'; // bump when the privacy policy or terms change materially

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
export const LOBBY_SEEN_MS = 20000;     // a waiting student counts as "in the lobby" only if their lobby screen checked in this recently
export const ONLINE_MS = 15000;         // a student whose screen checked in this recently is shown as connected
export const MAX_PHONES = 5;            // phone numbers per student (the first one is required)
export const MAX_STUDENTS = 20000;      // a safety cap on registrations
// Before each round: instructions, then one practice question. The round clock starts when the student presses Start Round,
// or by itself after this long (so nobody waits forever). Admins can change it in Setup → Timing.
export const PRACTICE_SECONDS = { default: 600, min: 60, max: 1800 };
// The Google Sheet is the data store. The server keeps a working copy in memory and writes only the rows that changed.
export const STORE_FLUSH_MS = 2500;      // changed rows reach the sheet within this long (autosave still lands in memory every second)
export const STORE_URGENT_MS = 400;      // …and almost at once after a start, submit, new student or decision
export const STORE_MIN_GAP_MS = 2000;    // never write to Sheets more often than this (Google allows 60 writes a minute per user)
export const REPORT_SYNC_MS = 30000;     // readable Results / Answers tabs are rebuilt at most this often
export const SHEET_GRID_ROWS = 5000;     // rows each data tab starts with; more are added automatically
export const PHASE_SECONDS_RANGE = { min: 5, max: 600 };   // welcome, briefing, break and finish screens
export const TIME_ADJUST_RANGE = { min: 5, max: 1800 };    // one "add time" step, in seconds

// Fallback for the Game Flow sheet (27:30). The sheet on Drive overrides scripts and non-round timings.
export const DEFAULT_FLOW = [
  { key: 'welcome', type: 'welcome', round: 0, sec: 45, title: 'Rules and readiness',
    script: 'Welcome to the AI Challenge Arena! Three rounds, eight minutes each. Your answers save as you work. Use your lifelines wisely.' },
  { key: 'r1-brief', type: 'brief', round: 1, sec: 60, title: 'AI Blitz briefing',
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
  1: { name: 'AI Blitz', tagline: 'Quick choices. Smart thinking!', icon: '⚡', max: 20, blurb: 'Choose the best answers.',
    intro: ['Choose the best answer to eight questions. Then take on the Final Boss!'],
    says: '“A confident AI answer can still be wrong. Think before you choose!”',
    lifelineNote: 'Each lifeline can be used once across the whole round, including the Final Boss.',
    points: 'Eight questions × 2 points, plus Final Boss × 4 points = 20 points',
    lifelines: [
      { id: 'fifty', name: '50–50', desc: 'Removes two wrong choices from one question.' },
      { id: 'clue', name: 'Clue Flash', desc: 'Gives you a hint.' }] },
  2: { name: 'Crack the AI Case', tagline: 'Something doesn’t add up. Can you spot it?', icon: '🧩', max: 20, blurb: 'Spot the mistake, find the proof, fix it.',
    intro: ['You will see a picture made by AI and three fact cards. The fact cards are always right — the picture has a mistake.',
      'Spot the mistake, choose the card that proves it, then fix it.'],
    says: '“Follow the evidence. Keep what is right and fix what is wrong!”',
    lifelineNote: 'Each can be used once.',
    points: 'Spot the mistake 6 + Choose the evidence 6 + Fix it 8 = 20 points',
    lifelines: [
      { id: 'compass', name: 'Case Compass', desc: 'Takes away one wrong choice from the step you are on.' },
      { id: 'unlock', name: 'Unlock a Clue', desc: 'Gives you a hint for the step you are on.' }] },
  3: { name: 'Match the Output', tagline: 'See the result. Write the instructions!', icon: '🎨', max: 20, blurb: 'Write a prompt for the picture you see.',
    intro: ['You will see a picture made by AI.',
      'Write a prompt that could help AI make a picture like it. Tell AI what role to take, who it is for and what to show.'],
    says: '“There can be more than one good prompt. Make yours clear!”',
    lifelineNote: 'Each can be used once.',
    points: '20 points',
    lifelines: [
      { id: 'goal', name: 'Goal Lens', desc: 'Helps you think about the purpose and audience.' },
      { id: 'structure', name: 'Structure Scan', desc: 'Helps you notice the layout, colours and style.' }] },
};

// Score components. `auto` parts are key-matched; the rest use the rubric (Claude, or keywords when it is off).
// Round 2: Q1 /6 + Q2 /6 + Q3 /8. Q3 is a choice for Grades 3–4 and a written correction prompt for Grades 5–8.
// Round 3: five parts × 4. Newer picture tasks score the AI role; the three older ones ask for two short reasons instead.
export const SCORE_PARTS = {
  1: [
    { key: 'quick', label: 'Quick challenges (8 × 2)', max: 16, auto: true },
    { key: 'bossChoice', label: 'Boss choice', max: 2, auto: true },
    { key: 'bossWhy', label: 'Boss explanation', max: 2 },
  ],
  2: [
    { key: 'spot', label: 'Spot the mistake', max: 6, auto: true },
    { key: 'evidence', label: 'Choose the evidence', max: 6, auto: true },
    { key: 'fix', label: 'Fix it', max: 8 }, // automatic when it is a choice (Grades 3–4)
  ],
  3: [
    { key: 'role', label: 'Suitable AI role', max: 4, only: 'new' },
    { key: 'purpose', label: 'Purpose and audience', max: 4 },
    { key: 'content', label: 'Important details', max: 4 },
    { key: 'format', label: 'Layout and style', max: 4 },
    { key: 'clarity', label: 'Clear instructions', max: 4 },
    { key: 'reasons', label: 'Two short reasons', max: 4, only: 'existing' },
  ],
};
// Attempts made with the earlier question bank keep their own parts (for reports and score cards).
export const LEGACY_PARTS = {
  2: [
    { key: 'rebuild', label: 'Rebuild the prompt', max: 5, auto: true }, { key: 'spotId', label: 'Spot the trap — identified', max: 2, auto: true },
    { key: 'spotWhy', label: 'Spot the trap — explanation', max: 3 }, { key: 'matchId', label: 'Match the evidence — card', max: 2, auto: true },
    { key: 'matchWhy', label: 'Match the evidence — connection', max: 3 }, { key: 'repairFix', label: 'Repair — corrected claim', max: 3 },
    { key: 'repairWhy', label: 'Repair — why it works', max: 2 },
  ],
  3: [
    { key: 'purpose', label: 'Purpose and audience', max: 5 }, { key: 'content', label: 'Target content', max: 5 },
    { key: 'format', label: 'Format and structure', max: 5 }, { key: 'clarity', label: 'Clarity and constraints', max: 5 },
  ],
};
// Which skills each new-format part feeds on the score card (the new bank has no skill column for Rounds 2 and 3).
export const SKILL_MAP = {
  2: { spot: [{ id: 'S04', max: 6 }], evidence: [{ id: 'S05', max: 6 }], fix: [{ id: 'S06', max: 8 }], fixWritten: [{ id: 'S06', max: 8 }, { id: 'S01', max: 8 }] },
  3: { role: [{ id: 'S01', max: 4 }], purpose: [{ id: 'S02', max: 4 }], content: [{ id: 'S02', max: 4 }], format: [{ id: 'S03', max: 4 }],
    clarity: [{ id: 'S01', max: 4 }], reasons: [{ id: 'S07', max: 4 }] },
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

export const BANK_IMAGE_WIDTH = 1280;
export const IMAGE_LINK_HOURS = 6;  // a question picture's signed link works this long
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

// The names and one-line meanings printed on the score card (same 11 skills as above, in the card's wording).
export const SKILL_CARD = {
  S01: ['Clear Prompts, Better Results', 'I give clear instructions so AI understands my goal.'],
  S02: ['Plan Before You Prompt', 'I work out my goal, audience and requirements.'],
  S03: ['Ideas in Order', 'I organise ideas so they are easy to follow.'],
  S04: ['Check It, Don’t Just Trust It', 'I spot mistakes and claims that need checking.'],
  S05: ['Find the Proof', 'I use evidence to support or challenge an answer.'],
  S06: ['Spot It. Fix It.', 'I identify a problem and suggest a useful improvement.'],
  S07: ['Explain Your Thinking', 'I explain my choices with clear reasons.'],
  S08: ['Keep Private Things Private', 'I recognise personal information and protect it.'],
  S09: ['You’re in Charge', 'AI suggests. I decide what to accept, change or reject.'],
  S10: ['Make It Fair for Everyone', 'I spot unfair treatment and suggest inclusive choices.'],
  S11: ['Know When to Check More', 'I recognise missing information and decide what to check.'],
};
// Skill percentages on the card run from 20 to 100 (a raw 0–100% is shown as 20 + 0.8 × raw).
export const SKILL_PERCENT_FLOOR = 20;

export const R3_GENERATIONS = 2;
export const AI_CONCURRENCY = 6;

export const AWARDS = [
  { id: 'overall', title: 'Overall Winner', round: 0 },
  { id: 'blitz', title: 'Blitz Champion', round: 1 },
  { id: 'detective', title: 'Sharpest Detective', round: 2 },
  { id: 'creative', title: 'Creative Thinker', round: 3 },
];

// Published rules (criteria only — never answers).
export const RULES = {
  start: [
    'Type your name, then choose your school and grade.',
    'Add a parent’s or teacher’s phone number (and an email if you like).',
    'Wait in the lobby until your host starts Promptathon.',
    'Before each round, read the instructions and try one practice question. Your round clock starts only when you press Start Round.',
  ],
  // "Play fair" — shown before each round and in How to play
  general: [
    'Use your own ideas. Do not copy or get answers from others.',
    'Stay in this window. If you open a new tab or app during a round, your test is paused until your host lets you back in.',
    'Each round has two lifelines. Each can be used once, with no points lost.',
    'Answer every question. You can submit early only when every question is answered.',
    'When time runs out, your saved answers are submitted for you.',
  ],
  1: [
    'Read each question and its four choices.',
    'Choose one answer.',
    'For the Final Boss, also explain your choice in one sentence.',
    'Check your answers and submit before time runs out.',
  ],
  2: [
    'Look at the AI picture. Read the three fact cards — the cards are always right.',
    'Step 1 · Spot the mistake: choose what is wrong in the picture.',
    'Step 2 · Choose the evidence: choose the card that shows the mistake.',
    'Step 3 · Fix it: choose the fix (Grades 3–4), or write a short prompt telling AI how to fix the picture (Grades 5–8).',
    'Answer all three steps. You can submit early only when every step is answered.',
  ],
  3: [
    'Look carefully at the picture.',
    'Write a prompt that could make a picture like it.',
    'Tell AI what role to take (for example, “Act as a cartoon illustrator”), who the picture is for and what it is for.',
    'Describe the main things, colours, layout, style and any words in the picture.',
    'If you are asked for two short reasons, say how your prompt matches the picture.',
    'Check your work and submit.',
  ],
};

// One practice question before each round (from the demo document). Not scored; the answer is shown after "Check".
export const PRACTICE = {
  1: { image: '/practice/r1.webp', alt: 'A friendly blue toy robot waving',
    question: 'You want AI to suggest a name for your toy robot. Which prompt is clearer?',
    options: [{ id: 'A', text: 'Give me something.' }, { id: 'B', text: 'Suggest one funny name for my toy robot.' }],
    key: 'B', feedback: 'This tells AI exactly what you want.' },
  2: { image: '/practice/r2.webp', alt: 'An AI picture of one purple kite with two orange bows on its tail', title: 'The Kite',
    cards: [{ id: 'A', text: 'The kite is purple.' }, { id: 'B', text: 'The tail should have three bows.' }, { id: 'C', text: 'There is one kite.' }],
    steps: [
      { id: 'spot', label: 'Spot the mistake', question: 'What is wrong in the AI picture?', options: [{ id: 'A', text: 'Kite colour' }, { id: 'B', text: 'Number of bows' }, { id: 'C', text: 'Number of kites' }], answer: 'B' },
      { id: 'evidence', label: 'Choose the evidence', question: 'Which card shows the mistake?', options: [{ id: 'A', text: 'Card A' }, { id: 'B', text: 'Card B' }, { id: 'C', text: 'Card C' }], answer: 'B' },
      { id: 'fix', label: 'Fix it', question: 'How should AI fix the picture?', options: [{ id: 'A', text: 'Add one bow' }, { id: 'B', text: 'Remove one bow' }, { id: 'C', text: 'Make the kite red' }], answer: 'A',
        written: 'Write a short prompt telling AI how to fix the picture.', example: 'Edit the kite picture. Add one bow so the tail has three bows.' },
    ],
    feedback: 'The picture has two bows, but Card B asks for three. Add one bow to make it match.' },
  3: { image: '/practice/r3.webp', alt: 'A smiling yellow pencil waving on a pale blue background',
    question: 'Write a prompt to create a similar picture for a classroom welcome slide. Tell AI what role to take and describe the picture.',
    example: 'Act as a cartoon illustrator. Create a picture for a classroom welcome slide. Show a smiling yellow pencil waving on a pale blue background. Do not add any words.',
    feedback: 'Different prompts can work! Include a role, the purpose and the main picture details.',
    checks: [
      { label: 'You gave AI a role', tip: 'Start with a role, like “Act as a cartoon illustrator”.', any: ['act as', 'you are', 'illustrator', 'artist', 'designer', 'cartoonist', 'painter'] },
      { label: 'You said what it is for', tip: 'Say what it is for — a classroom welcome slide.', any: ['slide', 'welcome', 'class', 'school', 'students'] },
      { label: 'You described the pencil', tip: 'Describe the main thing: a yellow pencil.', any: ['pencil'] },
      { label: 'You described what it does or looks like', tip: 'Add details: smiling, waving, yellow, pale blue background.', any: ['smil', 'wav', 'yellow', 'blue', 'happy'] },
    ] },
};

// Lifeline hints for the current question bank (it has no hint columns for Rounds 2 and 3).
export const R2_HINTS = {
  spot: 'Read each fact card, then find that thing in the picture. Does the picture match the card?',
  evidence: 'Which card talks about the thing you picked in Step 1?',
  fix: 'Make the picture match the card exactly.',
  fixWritten: 'Say what to change in the picture, then give the correct detail from the fact card. For example: “Edit the poster. Change … to …”.',
};
export const R3_LENS = {
  goal: 'Who is this picture for, and what is it for — a poster, a book, a slide, a website? Start with a role, like “Act as a cartoon illustrator”, then say who it is for.',
  structure: 'Look at the layout: what is in the middle, at the top, at the bottom and in the background? Mention colours, the style (cartoon, painted, realistic) and any words you can see.',
};
export const RATINGS = [
  { value: 1, face: '😞', label: 'Not fun' }, { value: 2, face: '🙁', label: 'A bit boring' }, { value: 3, face: '😐', label: 'Okay' },
  { value: 4, face: '🙂', label: 'Good' }, { value: 5, face: '😄', label: 'Loved it!' },
];
