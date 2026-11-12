# Promptathon — The AI Challenge Arena (a product of The AI Club)

Three 8-minute rounds (AI Blitz, Crack the AI Case, Match the Output), 60 points, individual play, for Grades 3–8.
Questions come only from the Drive question bank (the compiled bank `Promptathon_Question_Bank_Compiled.xlsx`). Nothing is generated.
Grade bands follow the bank: **Grades 3–4, 5–6, 7–8**. A student only ever gets their own band's questions.

## Run

```bash
npm install
npm start          # http://localhost:3000
```

Node 22+ is required. Settings live in `.env` (copy `.env.example`). Game constants (timings, bands, scoring, lifelines, practice questions, rules text) live in `src/config.js`.

## How a student plays

1. **Join in the lobby** (no sign-in, no Google): name → grade (big buttons) → school, then a grown-up's **phone (required)** and **email (optional)** and the
   consent box. Joining takes a *seat*: that browser window is now this one player's, and **nobody can switch it** — there is no "change player" anywhere.
   **Joining always makes a brand-new player with a new player code**, even if the name, grade, school, phone and email are exactly the same as someone
   else's — typing details never opens another player's seat. A player who already played comes back with **🔑 I have a player code** instead (below).
2. **Lobby** until the host presses Start. The player sees **only their own details** and can **edit them** (name, grade, school, phone, email) until the
   test starts; after that they are locked. Other players' data is never shown (the leaderboard hides other players' codes).
3. **Before each round**: the round's slides (the existing PPT pages), *How it works*, then **one practice question** from the demo document
   (not scored; the answer and feedback appear after *Check my answer*), then **Start Round N**. The round clock starts only then
   (or by itself after the *Instructions + practice* limit in Setup → Timing, 10 minutes by default).
4. **The round**: one question per screen, big **Back / Next** buttons and question dots, read-aloud on every question. There is no Speak (microphone) option anywhere: all writing boxes are typing only (pasting is off in Round 3). *Check & finish* shows what is still unanswered; **a round can be finished early only when every question is answered**
   (the server enforces this too). When the time runs out, whatever is saved is submitted.
5. **The end**: a smiley rating (1–5) with an optional comment, the scores, and the score card once approved. The window stays this player's until a host
   logs them out.

### Locked identity and shared computers

Who is playing is remembered **per browser window/tab** (sessionStorage) and sent as a signed player token with every request — never a cookie, so many
children on one computer, one browser profile or one lab account can never become each other. The token carries a **login epoch** that is saved in the
sheet (Students tab: *Login epoch*, *Logged in*), so it survives server restarts. **Only a host can end a login** (Students tab → *Log out*, or *Live control →
Log out…* for a selection):

- the window drops back to the join page at once, with a message, and its old token stops working;
- **coming back**: on the start page the player presses **🔑 I have a player code** and types their code (`BZ-ABCDE`; capitals, spaces and the `BZ-` part
  don't matter). It works only while that player is logged out, so a code can't open a seat that is in use (*still logged in on another window*); wrong codes
  get *couldn't find that player code* and are slowed down after 30 tries in 5 minutes from one network. Hosts see every code in the Students tab;
- a running test is **paused** (the clock stops). After the code login the player sees *Welcome back!* with their test paused and answers kept, can send the
  host a note (*Anything to tell your host?* → **Ask to continue**), and the host presses **Resume** (Resume skips players who are still logged out). The
  Students tab shows *Back after logout* / *Asked to continue*. A finished player who logs back in sees their results and can **request a reattempt** there;
- on a shared computer, logging a finished player out lets the next child join in the same window.

A test is also locked to one window at a time; a second window of the same player gets *This test is open in another window → Continue in this window*.
Answers are backed up on the computer per attempt while a round is open.

### Animations (Foldling FX)

Futuristic paper-and-light animations on the orange & white theme, with Foldling in all of them: a floating sky of paper shards and a holo-grid behind
the pages, Foldling in a spinning holo-portal on the start page (napping with *zzz* while closed), the title arriving letter by letter, a holographic
**player card** with the code "decoding" and a *READY!* / *BACK!* stamp after joining or logging in, Foldling hovering on a radar pad in the lobby, a
**"Promptathon is starting!"** warp moment when the host presses Start, a **3 · 2 · 1 · GO!** launch dial before every round clock, ripples and sparkles
on every pick, page-turns between questions, Foldling riding the round's energy bar, a power-up zap for lifelines, the last ten seconds ticking,
**Round clear!** with paper cannons, 1–3 stars and a score ring that counts up, and a **Mission complete** finale with fireworks and the total.
Tap Foldling and he jumps (five quick taps: a somersault).

- Nothing blocks the test: every full-screen moment lasts 2–4 s and a tap or Esc skips it; during a round the sky is switched off so children can focus.
- Light on lab computers: CSS transform/opacity animations and one small canvas for paper confetti (capped at 600 pieces, stops when idle).
- **Reduced motion** (operating-system setting) turns the moments, confetti and looping animations off; the **black & white** theme greys them.
- Code: the *Foldling FX* section at the end of `public/styles.css` and in `public/app.js`; Foldling's sprites are `public/foldling.webp` and
  `public/foldling-happy.webp`.

### Rounds

- **Round 1 · AI Blitz** (unchanged): 8 quick questions (privacy, agency, fairness, uncertainty + 4 others; 3 Easy / 3 Medium / 2 Hard) + a final boss with a reason.
- **Round 2 · Crack the AI Case** (new): one case = an AI picture with one mistake + three fact cards. **Step 1** spot the mistake (/6),
  **Step 2** choose the evidence card (/6), **Step 3** fix it (/8) — a choice for **Grades 3–4**, a **written correction prompt for Grades 5–8**.
  Lifelines: Case Compass (removes one wrong choice) and Unlock a Clue (a hint for the step).
- **Round 3 · Match the Output** (pictures only): write a prompt for an AI picture. Newer pictures are scored on 5 × 4 (AI role, purpose/audience,
  details, layout/style, clear instructions); the three older ones per band also ask for **two short reasons** (on a second screen).
- Rounds 2 and 3 adapt to the group: the case/picture difficulty follows the band's average so far (`ADAPTIVE_THRESHOLDS`).
- **Tracking**: time spent on every question, questions left empty, questions passed over, practice results, lifelines, time taken per round.
  All of it is in the student's detail view, the sheet's Results / Answers tabs and the Excel report.

## Open / closed

The host opens and closes Promptathon from the bar at the top of the dashboard. **It stays open or closed until a host changes it** — for days,
and across server restarts (it is saved in the sheet's Settings tab). While closed, every student page and **every student API** (register, play,
sync, submit, pictures, leaderboard…) answers `423 {"code":"closed"}`, even when called directly. Closing pauses every running test (clocks stop,
answers kept); opening again resumes exactly those tests. Only the privacy "delete my data" form keeps working.

## Hosts (admins)

Hosts sign in with Google at **/#/admin** (players never do). The link is on the closed page and in the footer of every page, and **/admin** or **/host** redirect
there — it works whether Promptathon is open or closed. Dashboard tabs:
**Live control** (start / pause / resume / stop by school, band, grade, status; who is connected; who is on which round or its practice),
**Students** (every registration with phone and email, who is logged in, **Log out**, search and filters, CSV download, remove unplayed duplicates),
**Reattempts**, **Score cards** (filter by **school, session, grade and status**; approve, email and ZIP act on the filtered list; students without
an email are listed for download instead), **Leaderboard**, **Analytics** (times, skipped questions, Round 2 steps, Round 1 items),
**Feedback** (smiley summary and comments, by school) and **Setup** (schools, hosts, timing, and *View questions* per grade band).

## Question bank and score card

- Sheets: `R1 Blitz`, `R1 Boss`, `R2 Questions` (three rows per case, the picture embedded on the rows), `R3 Questions` (one picture per row).
  Rows with a Status column must be Active; the latest Version of each ID wins. The bank is re-read every 5 minutes (only if it changed);
  sets already drawn never change. Pictures are read out of the workbook and served through short-lived signed links.
- **Runs / sessions**: students started with one press of Start share one set per grade band and round. A later group can get **New questions**
  or the **Same questions as session N**. Leaderboards compare people within a session.
- **Score card**: the 11-skill profile from the bank's skill mapping (Round 2 and Round 3 parts map to S01–S07 as set in `SKILL_MAP`), saved in the
  **Scorecards** tab and rendered from `templates/scorecard.html` (unchanged design). Approve, edit, download PDF/ZIP and email as before;
  email goes to the address typed when joining. Placeholders: `{{student_name}} {{grade}} {{player_code}} {{school}} {{band}} {{event}} {{status}}
  {{total}} {{round1}} {{round2}} {{round3}} {{strength}} {{next_step}} {{date}} {{logo_url}}` and `{{#skills}} … {{/skills}}`.

## Where the data lives

The **Google Sheet is the data store**. The server keeps a working copy in memory (answers autosave every second), loads it from the sheet at
start-up and writes changed rows back within a couple of seconds (never more than one write every 2 s, under Google's 60-writes-a-minute limit).
Tabs: Students, Attempts, Rounds, Question Sets, Reattempt Requests, Consents, Deletion Requests, **Feedback**, Scorecards, Settings, plus the readable
Results and Answers tabs. New columns are appended automatically; don't edit the data tabs by hand while the app is running.

## Deploying on Render

- **One instance only** (no autoscaling): the live state is in memory. Use an instance with **at least 1 GB RAM** (the bank's pictures and the PDF
  engine need it); `npm install` as the build command, `npm start` as the start command, **Health check path `/healthz`**.
- Environment: `BASE_URL=https://<your-service>.onrender.com` (also add `${BASE_URL}/auth/callback` to the Google OAuth client),
  `SESSION_SECRET` (long random), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `DATA_SHEET_ID`,
  **`QUESTION_BANK_FILE_ID=1pVfKokcXqrNdCFeVPuPmUNIlPGOflZ1Q`** (the compiled bank), `DEFAULT_ADMIN_EMAIL`, optional `ANTHROPIC_API_KEY`, SMTP settings.
  **Never set `TEST_ADMIN_KEY`, `DATA_STORE` or `GOOGLE_API_BASE` on Render** — they are for load tests only.
- **Don't deploy while a test is live** (turn off auto-deploy for the event day): a deploy starts a new copy of the app, and answers saved to the old
  copy in its last seconds could be missed. Closing Promptathon, deploying, then opening it again is safe.
- See `STRESS-TEST-REPORT.md` for the 100-student load test.

## Load testing

```bash
node scripts/mock-google.mjs 4999 &      # stand-in for Google's Sheets API (latency + quota); keeps nothing on disk
GOOGLE_API_BASE=http://127.0.0.1:4999 GOOGLE_REFRESH_TOKEN=mock GOOGLE_CLIENT_ID=mock GOOGLE_CLIENT_SECRET=mock DATA_SHEET_ID=mock \
  QUESTION_BANK_FILE=./bank.xlsx TEST_ADMIN_KEY=secret PORT=3996 node src/server.js &
node scripts/stress.mjs --base http://127.0.0.1:3996 --key secret --users 100 --round-min 2
```

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

1. Setup: add schools (and other hosts). Set round lengths and the instructions + practice limit if you want something else.
2. **Open Promptathon** (top bar). Students open the site, join and wait in the lobby.
3. Live control: filter by schools / band / grade / status, or tick students, then **Start**. Each student does the instructions and practice and
   presses Start Round. **Pause**, **Resume**, **Stop** and **Timing…** (add time / end now) work for any selection.
4. Reattempts: approve or decline students' requests, or enable a whole-test / single-round reattempt.
5. Score cards: filter by school and session, approve, then email or download.
6. **Close Promptathon** when the event is over.

## Files

```
src/config.js    env + all constants        src/bank.js     question bank + game flow (Drive) and set drawing
src/server.js    routes, player tokens, host OAuth   src/game.js     gate, clock, attempts, controls, leaderboard, analytics, exports
src/google.js    OAuth, Drive, Sheets       src/connect-google.js  one-time Drive authorisation
                                            src/scoring.js  auto-scoring (keys, rubric via Claude or heuristic), AI tool
src/deliver.js   score card PDF, ZIP and email
src/store.js     Google Sheet store          src/scorecard.js  skill profile + score card rendering
                                            templates/scorecard.html  default score card (replaceable)
                                            public/          index.html, styles.css, app.js (student + shell), admin.js, practice/
scripts/stress.mjs  100-student load + chaos test      scripts/mock-google.mjs  stand-in Google API for load tests
```
