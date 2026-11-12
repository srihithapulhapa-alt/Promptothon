# Promptathon — 100-student stress test report

**Date:** 12 November 2026 · **Build:** locked player identity (host-only logout), lobby self-edit, open/close gate, practice rounds, new Round 2/3 bank
**Verdict:** ✅ Ready for 100 simultaneous students on one Render instance. 100/100 finished in both runs with **no identity mix-ups, no wrong-grade questions,
no lost answers and no unexpected errors** — while the host paused, closed and reopened Promptathon, added time and logged players out mid-round, and
students switched tabs, opened second tabs and tried to take over each other's seats.

| | Run A — app logic (in-memory store) | Run B — Google Sheets store (quota enforced) |
|---|---|---|
| Students finished | 100 / 100 | 100 / 100 |
| Requests | 15,158 (26/s avg) | 14,833 (26/s avg) |
| Autosave (`sync`) latency p50 / p95 / p99 / max | 1 / 4 / 10 / 24 ms | 1 / 4 / 12 / 24 ms |
| Identity, grade-band or privacy violations | **0** | **0** |
| Unexpected errors | **0** | **0** |
| Server CPU peak / average | 12.8% / 2% | 23.7% / 3% |
| Server memory peak | 316 MB | 379 MB |
| Sheet writes | — | 271 in ~10 min (≈27/min; Google allows 60), **0 throttled** |
| Rows in the sheet afterwards | — | 100 students · 300 rounds · 100 feedback · 1,400 answers |
| Server restarts (logins, host logout, closed state) | — | ✅ all kept (section 4) |

*Both runs were executed at the same time on the same laptop, so the CPU and latency figures are on the pessimistic side.*

---

## 1. What was tested

`scripts/stress.mjs` plays **100 simulated students** against a running server exactly like the browser does (same API calls, same 1-second autosave, real
waiting times). Grades 3–8 are mixed evenly across three schools. 10% of students think slowly and are cut off by the timer. Every response is checked: it
must be about **this** student and **this** student's grade band, question IDs must carry the band prefix (G34 / G56 / G78), and each round's picture must
load through its signed link.

**Before the start (all must hold):**

| Check | Expected |
|---|---|
| Every student API called while Promptathon is **closed** | `423 closed` |
| 5 players retype another player's details in different capitals / phone formats | **refused** (`409 already-joined`), no token issued — nobody can take a seat |
| A token asked about someone else / a forged token / a player token on the host dashboard | answers only for its own player / `401` / `401` |
| 3 players edit their own details in the lobby | saved, and visible to the host |
| A player edits into another player's exact details | refused (`409`) |
| The host logs 5 waiting players out; each old login is tried, then each rejoins | old login → `401 logged-out`; rejoining gives the **same player, same code** |

**During the run (seconds after Start):**

| t | Event | Result |
|---|---|---|
| 35 s | 3 players switch tabs mid-round | paused with “You left the test window”, host resumes them ✅ |
| 45 s | 3 players try to edit their details after the test started | refused (`409 locked`) ✅ |
| 50 s | 3 players open a **second window** | second window refused (`409 device`) ✅ |
| 70 s | Host **pauses everyone** 10 s, then resumes | clocks freeze and continue ✅ |
| 100 s | **4 players mid-round lose their window.** They retype their details (refused while still logged in) → the host logs them out (4 tests paused) → a Resume attempt skips them → old logins return `401 logged-out` → they join again (same player) → host resumes | 4 out · 4 paused · 0 resumed while logged out · 4 resumed after rejoining ✅ |
| 130 s | Host **closes Promptathon** for 15 s mid-test | every student API `423`; 10 running tests paused; reopening resumed exactly those 10 ✅ |
| 170 s | Host adds 1 minute for 10 students | only their clocks grow ✅ |

**End of run:** all 100 finished; every student has all 3 round scores and saved feedback; time per question and questions left empty are recorded; each
player's leaderboard shows only their own band, **no other player's code**, and at most one row marked “you”; score cards (Round 2 + 3 skills present) for
20 students; the host overwrites Round 2 and Round 3 marks and the totals follow; Excel report, students CSV, analytics, score-card and feedback lists download.

## 2. Run A — app logic at full load (in-memory store)

Rounds of 2 minutes (so the run takes ~10 minutes), instructions + practice limit 90 s, one Node process.

| Endpoint | Calls | p50 ms | p95 ms | p99 ms | max ms |
|---|---:|---:|---:|---:|---:|
| `/api/play/sync` (autosave, every second) | 12,133 | 1 | 4 | 10 | 24 |
| `/api/play/submit` | 649 | 1 | 2 | 2 | 22 |
| `/api/play/round` | 442 | 1 | 2 | 4 | 12 |
| `/api/img/:id` (question pictures) | 332 | 1 | 2 | 3 | 11 |
| `/api/play/start-round` | 328 | 1 | 2 | 3 | 8 |
| `/api/play/practice` | 322 | 1 | 2 | 3 | 4 |
| `/api/admin/overview` (host dashboard, every 2 s) | 283 | 7 | 9 | 11 | 14 |
| `/api/play/lifeline` | 259 | 1 | 1 | 3 | 12 |
| `/api/register` | 118 | 2 | 4 | 4 | 4 |
| `/api/play/feedback` | 100 | 2 | 3 | 4 | 4 |
| `/api/leaderboard` | 100 | 2 | 3 | 5 | 5 |
| `/api/play/profile` (lobby edits) | 7 | 1 | 1 | 1 | 1 |

160 early submits were correctly refused because questions were unanswered; 180 lifelines used; 9 players re-joined after a host logout; 10 slow players were
submitted by the timer. Excel report for 100 students: 0.3 s.

## 3. Run B — the real Google Sheets store under Google's quota

Same students and chaos, but every change goes through `src/store.js` to a stand-in for the Sheets API (`scripts/mock-google.mjs`) that adds Google-like
latency (150–1,200 ms per call) and **enforces Google's 60-writes-per-minute quota** with `429` errors.

| Measure | Result |
|---|---|
| Students finished / violations / unexpected errors | **100 / 0 / 0** |
| Sheet writes | **271** in ~10 minutes ≈ **27 per minute** (limit 60); largest batch 444 KB; 12.6 MB sent in total |
| Writes throttled by the quota | **0** |
| Closing mid-test | 10 running tests paused; reopening resumed exactly those 10 |
| Host logout mid-round | 4 out, 4 paused, 4 resumed after they rejoined |
| Excel report / CSV / analytics | 291 ms / 2 ms / 4 ms |

Requests never wait for Google: answers land in memory at once and reach the sheet within ~2–3 seconds in the background.

## 4. Restart and upgrade tests (new login state is saved in the sheet)

Logins are a signed token plus a **login epoch** saved in the Students tab (`Login epoch`, `Logged in`), so a Render restart or deploy must not log anyone out
— and a host logout must not be undone by one.

| Test | Result |
|---|---|
| Restart after the run | 100 students, 100 finished tests, 100 feedback reloaded; Promptathon still **open**; **all 100 still logged in**; a player's old token still works ✅ |
| Host logs a player out, closes Promptathon, restart again | still **closed**: `/api/play` and `/api/register` answer `423`; the **host dashboard still works while closed** (`200`) ✅ |
| Reopen after that restart | the player the host logged out is `401 logged-out`; the others still `200` ✅ |
| Someone retypes the details of a player who is still in | `409 already-joined` ✅ |
| Retyping the details of the player the host freed | `200`, same player ✅ |
| **Upgrade of an existing sheet**: a Students tab in the previous 11-column layout with one student | loads (2 records), student kept, header widened to 13 columns, login state written (`1`, `yes`), login and logout both survive a restart ✅ |

**Security spot checks:** forged token → 401 · no token → 401 · tampered or expired picture link → 404 · host APIs with a player token or no cookie → 401.

## 5. What this means on Render

**Capacity.** The server does almost nothing per request (≤4 ms at p95 even with both test runs sharing one laptop). 100 students use a few percent of
one CPU core and 300–400 MB of memory (most of it the question bank's pictures). The limit is not the app but Google Sheets' quota (60 writes/minute), which the
store stays under by batching all changes into one write at most every 2 seconds. One Render instance comfortably serves several hundred students.

| Setting | Value | Why |
|---|---|---|
| Instance count | **1** (no autoscaling) | The live state is kept in memory; two copies would disagree. |
| Instance size | **≥ 1 GB RAM** | 300–400 MB measured, plus headless Chromium (~150–250 MB) when making score-card PDFs. 512 MB is too tight. |
| Region | Singapore | Lower latency for every 1-second autosave. |
| Health check path | `/healthz` | Answers 200 only once the sheet and the bank are loaded. |
| Auto-deploy | **Off on event days** | A deploy briefly runs two copies; close Promptathon, deploy, then open it. (Logins and open/closed state survive the restart.) |
| Env vars never to set | `TEST_ADMIN_KEY`, `DATA_STORE`, `GOOGLE_API_BASE`, `QUESTION_BANK_FILE` | Test-only switches. |
| `QUESTION_BANK_FILE_ID` | `1pVfKokcXqrNdCFeVPuPmUNIlPGOflZ1Q` | The compiled bank. With the old ID the dashboard shows a red “old format” warning and no band can start. |

**School network.** Each student downloads about 3–4 MB over the whole event (mostly pictures, cached for a day). 100 students ≈ 350 MB spread over the event;
a lab of 30–40 computers needs roughly 10 Mbps or more for comfortable loading.

**Operating note.** Because only a host can end a login, a child who **closes their tab by accident** cannot get back in until a host presses **Log out** on them
(Students tab, or Live control → Log out…) and they type the same details again. Keep the dashboard open during the event for this.

**Not covered by this test**

- **Google sign-in for hosts**: the host dashboard, routes and the closed-state access were tested, but the real Google OAuth screen was not (no real client in the test setup).
- **Claude marking** (`ANTHROPIC_API_KEY`): not called (costs money, not set). With it on, ~250 written answers are marked 6 at a time and show “Scoring…” for a few minutes after a wave of submissions; the built-in keyword marker (used here) is instant.
- **Real Google Sheets latency**: simulated (150–1,200 ms, 60 writes/min), in the range of Google's real behaviour.
- **Real browsers on lab machines at 100× scale** (rendering, speech, microphone permission): checked by hand in Chrome at desktop and phone sizes only.
- **Score-card PDFs at scale**: the ZIP renders three cards at a time (6 cards in 2.2 s including starting the PDF engine); emailing 100 cards takes several minutes by design (Gmail limits).

## 6. Test-harness notes

Two earlier attempts of this round failed on flaws in the **test**, not the app, and were fixed before the final runs: the test picked a player for the mid-round
logout who had already finished (a finished test has nothing to pause), and its end-of-run check ran while the last player was still on the 10-second finish screen.
The final runs above use the corrected test.

## 7. How to re-run

```bash
# A. app logic only (nothing is saved anywhere)
DATA_STORE=memory QUESTION_BANK_FILE=./bank.xlsx TEST_ADMIN_KEY=secret PORT=3998 node src/server.js &
node scripts/stress.mjs --base http://127.0.0.1:3998 --key secret --users 100 --round-min 2 --pid <server pid> --out run-a.json

# B. with the Google Sheets store (stand-in API, quota enforced)
node scripts/mock-google.mjs 4999 &
GOOGLE_API_BASE=http://127.0.0.1:4999 GOOGLE_REFRESH_TOKEN=mock GOOGLE_CLIENT_ID=mock GOOGLE_CLIENT_SECRET=mock DATA_SHEET_ID=mock \
  QUESTION_BANK_FILE=./bank.xlsx TEST_ADMIN_KEY=secret PORT=3996 node src/server.js &
node scripts/stress.mjs --base http://127.0.0.1:3996 --key secret --users 100 --round-min 2 --pid <server pid> --out run-b.json --tokens-out tokens.json
curl http://127.0.0.1:4999/stats      # writes, throttling, rows per tab
```

`bank.xlsx` is a local copy of the compiled question bank. The script exits with code 1 and lists every violation if anything goes wrong.
