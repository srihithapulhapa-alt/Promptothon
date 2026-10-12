# Promptathon — The AI Challenge Arena (a product of The AI Club)

Three 8-minute rounds (AI Blitz, Crack the AI Case, Creator Showdown), 60 points, individual play.
Questions come only from the Drive question bank (Active rows, latest version). Nothing is generated.
Grade bands follow the bank: **Grades 3–4, 5–6, 7–8** (the pilot bank has nothing for other grades).

## Run

```bash
npm install
npm start          # http://localhost:3000
```

Node 22+ is required. Settings live in `.env` (copy `.env.example`). Game constants (timings, bands, scoring, lifelines, rules text) live in `src/config.js`.

## Question bank, adaptive rounds and the score card

- **Round 1** draws 8 quick questions per band: the four mandatory slots (privacy, agency, fairness, uncertainty) plus four of the
  other seven, exactly 3 Easy / 3 Medium / 2 Hard, plus one boss (/4). **Round 2** is one whole case with its 4 puzzles. **Round 3**
  is one target, text or picture (Setup → Round 3 targets: both at random, picture only, or text only).
- **Runs:** students started with one press of **Start** form a run and get the same set per grade band and round. When you start a
  later group, the dialog asks: **New questions** (drawn fresh; Rounds 2–3 adapt to that group only) or **Same questions as run N**
  (a fair comparison with earlier students). Leaderboards compare people within a run (admins can pick a run or all).
- Rounds 2 and 3 are **adaptive**: the case/target difficulty follows the band's average
  so far (below 50% → Easy, below 75% → Medium, otherwise Hard; see `ADAPTIVE_THRESHOLDS` in `src/config.js`).
- Pictures are read from the workbook itself, resized, and served only to the student the target was drawn for. Picture targets have no
  AI tool (it writes text); text targets keep the 2 AI tries.
- **Score card:** each student's results plus a 0–100% profile for the 11 skills, computed from the bank's skill mapping (earned ÷
  available points on that skill's components, not from round totals). It is saved in the **Scorecards** tab of the sheet and rendered from
  `templates/scorecard.html`; admins open it from a student's detail view (“Score card”), where it can be printed to PDF.
  Edit that file to change the design.
- **Approve, edit, download, email** (admin → **Score cards** tab): a card is private until you approve it; then the student sees it on their
  finish screen (view + PDF). You can edit any field or skill percentage (the preview, PDF, email and student view all use the edited
  card). Download one card, or a ZIP of all approved ones. **Email** sends the PDF to the address saved from each student's Google
  sign-in, from the account in `SMTP_USER` (Gmail / Google Workspace app password in `.env`); cards already sent and unchanged are
  skipped, and a card edited after sending is flagged and can be re-sent. Optionally tick “Email automatically when a card is approved”.
  PDFs are made with headless Chromium (installed by `npm install` via puppeteer). Placeholders: `{{student_name}} {{grade}} {{player_code}} {{school}} {{band}} {{event}} {{status}}
  {{total}} {{round1}} {{round2}} {{round3}} {{strength}} {{next_step}} {{date}} {{logo_url}}` and a repeated
  `{{#skills}} … {{/skills}}` block using `{{id}} {{name}} {{about}} {{percent}} {{bar}} {{evidence}}`.

## Where the data lives

The **Google Sheet is the data store** — there is no local database. The server keeps a working copy in memory (so answers
autosave every second), loads it from the sheet at start-up and writes changed rows back within a couple of seconds
(almost at once after a start, submit, new student or admin decision). Tabs: Students (with the Google account email),
Attempts, Rounds (drafts, lifelines, scores), Question Sets, Reattempt Requests, Schools, Admins, Settings, plus the
readable Results and Answers tabs. Don't edit the data tabs by hand while the app is running. If a start-up finds an old
`data/db.json` and an empty sheet, it imports it once and keeps the file as `db.json.migrated`.

## One-time Google setup

Google Drive and Sheets are used by the **backend only** — there is nothing for admins or students to click.

1. Google Cloud Console → **APIs & Services → OAuth consent screen / Audience**: set **User type = External** and **Publish app**
   (otherwise Google answers `403 org_internal` / "access blocked"). Add `http://localhost:3000/auth/callback`
   (or `${BASE_URL}/auth/callback`) under the OAuth client's **Authorised redirect URIs**.
2. Enable the **Google Drive API** and **Google Sheets API** for the project.
3. Stop `npm start`, then run `npm run connect-google` once on the server. Open the link it prints, sign in with the Google
   account that can see the question-bank sheet, and allow access. It saves `GOOGLE_REFRESH_TOKEN` in `.env`.
4. Start the app. The first start creates the private data sheet **The AI Club Promptathon — Results** in that Google
   account's Drive (shared with nobody) and saves its id in `.env` as `DATA_SHEET_ID`. The log prints its link.
5. Optional: set `ANTHROPIC_API_KEY` in `.env` for the Round 3 AI tool and rubric marking. Without it, written answers get
   keyword-based provisional marks that admins can edit.

The question bank and game flow are re-read from Drive every 5 minutes, so the latest version is always used; sets already drawn never change.

## Running the event

The event ("Promptathon") is fixed — there is no new-event button.

1. Admin → Setup: add schools (and other admins). Set round lengths if you want something other than 8 minutes.
2. Students sign in with Google, pick or add their name/grade/school (one email can hold several students), then wait in the lobby.
3. Admin → Live control: filter by schools / band / grade / status, or tick students, then **Start**, **Pause**, **Resume** or **Stop**.
   **Round time…** adds minutes to, or ends early, the round each selected student is in (or any chosen round).
   Setup → Round timing does the same for everyone, per round.
4. Admin → Reattempts: students whose test has ended can request another attempt (with an optional note). Approve to archive
   their old attempt and return them to the lobby, or decline with a message — the student sees the answer.
5. Admin → Leaderboard: choose whether students see only their own school or every school in their band, and publish final results.
6. Review answers, edit scores, download the Excel analytics.

Lifelines: each round has two, each usable once per round, and they never cost points (the Scoring sheet says "no deductions").

## Files

```
src/config.js    env + all constants        src/bank.js     question bank + game flow (Drive) and set drawing
src/server.js    routes, sessions, OAuth    src/game.js     clock, attempts, controls, leaderboard, analytics, exports
src/google.js    OAuth, Drive, Sheets       src/connect-google.js  one-time Drive authorisation
                                            src/scoring.js  auto-scoring (keys, rubric via Claude or heuristic), AI tool
src/deliver.js   score card PDF, ZIP and email
src/store.js     Google Sheet store          src/scorecard.js  skill profile + score card rendering
                                            templates/scorecard.html  default score card (replaceable)
                                            public/          index.html, styles.css, app.js (student + shell), admin.js
```
