// Admin dashboard: open/close, live control, students, reattempts, score cards, leaderboard, analytics, feedback and setup.
import { api, esc, dialog, toast, fmt, leaderboardHTML, $, $$ } from '/app.js';

const TABS = [['live', 'Live control'], ['students', 'Students'], ['requests', 'Reattempts'], ['cards', 'Score cards'], ['leaderboard', 'Leaderboard'],
  ['analytics', 'Analytics'], ['feedback', 'Feedback'], ['setup', 'Setup']];
const st = { filters: { schools: [], band: '', grade: '', status: '', q: '' }, selected: new Set(), data: null, lbBand: 'G3-4', lbSchool: '' };
let timer, ctx, root;
window.addEventListener('hashchange', () => clearInterval(timer));
const when = (t) => (t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export async function renderAdmin(main, tab, c) {
  clearInterval(timer);
  ctx = c;
  root = main;
  if (!TABS.some(([t]) => t === tab)) tab = 'live';
  main.innerHTML = `<div class="wrap wide">
    <div id="gate-bar"></div>
    <nav class="admin-tabs" aria-label="Dashboard sections">${TABS.map(([t, l]) => `<a href="#/admin/${t}" id="tab-${t}" ${t === tab ? 'aria-current="page"' : ''}>${l}</a>`).join('')}</nav>
    <div id="admin-body"><p class="muted">Loading…</p></div></div>`;
  main.focus({ preventScroll: true });
  try {
    st.data = await api('/api/admin/overview');
    gateBar();
    const reqN = (st.data.pendingRequests || 0) + (st.data.pendingDeletions || 0);
    if (reqN) $('#tab-requests').textContent = `Reattempts (${reqN})`;
    if (st.data.pendingLocks) $('#tab-live').textContent = `Live control (${st.data.pendingLocks} waiting)`;
    $('#tab-students').textContent = `Students (${st.data.students.length})`;
    if (st.data.feedbackCount) $('#tab-feedback').textContent = `Feedback (${st.data.feedbackCount})`;
    await ({ live, students, requests, cards, leaderboard, analytics, feedback, setup })[tab]();
  } catch (err) {
    if (err.status === 401) { location.hash = '#/admin'; return; }
    $('#admin-body').innerHTML = `<p class="note bad">${esc(err.message)}</p>`;
  }
}
const body = () => $('#admin-body');
const bandLabel = (id) => ctx.cfg.bands.find((b) => b.id === id)?.label || id;
const schoolName = (id) => st.data.schools.find((s) => s.id === id)?.name || '—';
const refresh = async () => { st.data = await api('/api/admin/overview'); gateBar(); };

// ---------------------------------------------------------------- open / closed (stays as set until a host changes it — even for days)
function gateBar() {
  const g = st.data.gate, live = st.data.students.filter((s) => ['running', 'paused'].includes(s.status)).length;
  const bar = $('#gate-bar');
  if (!bar) return;
  const html = `<div class="gate ${g.open ? 'open' : 'closed'}" role="status">
    <span class="gate-dot" aria-hidden="true"></span>
    <div class="grow"><b>Promptathon is ${g.open ? 'OPEN' : 'CLOSED'}</b>
      <div class="small">${g.open ? 'Students can join and play.' : 'Nobody can join or play. Every student page and API says “closed”.'}
      ${g.changedAt ? ` · since ${esc(when(g.changedAt))}${g.by ? ` by ${esc(g.by)}` : ''}` : ''}${!g.open && live ? ` · ${plural(live, 'test')} paused by closing` : ''}</div></div>
    <button class="btn ${g.open ? 'danger' : ''}" data-admin="gate" data-open="${!g.open}">${g.open ? 'Close Promptathon' : 'Open Promptathon'}</button></div>
    ${st.data.store?.failures ? `<p class="note bad small">Saving to the Google Sheet is failing (${st.data.store.failures} tries). Data is safe in memory and keeps retrying — check the server log.</p>` : ''}
    ${st.data.bankFormat && st.data.bankFormat !== 'current' ? '<p class="note bad small">The question bank on the server is in the old format. Set QUESTION_BANK_FILE_ID to the compiled bank (1pVfKokcXqrNdCFeVPuPmUNIlPGOflZ1Q) and restart.</p>' : ''}`;
  if (bar.dataset.html !== html) { bar.innerHTML = html; bar.dataset.html = html; } // redraw only when something changed, so a click never lands on a vanished button
}
// The live view refreshes every 2 seconds; it waits while the host is pressing something or has a dialog open.
let pressing = false;
document.addEventListener('pointerdown', () => { pressing = true; }, true);
document.addEventListener('pointerup', () => { setTimeout(() => { pressing = false; }, 250); }, true);
const busy = () => pressing || $('#dlg')?.open;
async function toggleGate(open) {
  const live = st.data.students.filter((s) => s.status === 'running').length;
  const ok = await dialog({ title: open ? 'Open Promptathon?' : 'Close Promptathon?',
    body: open ? '<p>Students can join and play until you close it again. It stays open even if the server restarts.</p>'
      : `<p>Nobody can join or play until you open it again — it stays closed even for days, and even if the server restarts.</p>
        ${live ? `<p class="note warn"><b>${plural(live, 'student')} ${live === 1 ? 'is' : 'are'} playing right now.</b> Their clocks stop and their answers are kept; they continue exactly where they were when you open Promptathon again.</p>` : ''}`,
    actions: [{ label: 'Cancel', value: 'no', kind: 'ghost' }, { label: open ? 'Open Promptathon' : 'Close Promptathon', value: 'yes', kind: open ? '' : 'danger' }] });
  if (ok !== 'yes') return;
  const r = await api('/api/admin/gate', { open });
  toast(open ? `Promptathon is open.${r.resumed ? ` ${plural(r.resumed, 'test')} resumed.` : ''}` : `Promptathon is closed.${r.paused ? ` ${plural(r.paused, 'test')} paused.` : ''}`);
  await refresh();
  if (location.hash.startsWith('#/admin/live') || location.hash === '#/admin') liveTable();
}

// ---------------------------------------------------------------- live control
function live() {
  const d = st.data, f = st.filters;
  const problems = Object.entries(d.bandProblems).filter(([, p]) => p.length);
  body().innerHTML = `
    <div class="row between" style="margin-bottom:14px"><div><h1 style="margin:0">${esc(d.event.name)}</h1>
      <span class="muted">Start, pause or stop the test for any group — schools, a band, a grade or single students. Each student starts each round themselves after its practice question.</span></div></div>
    ${problems.length ? `<p class="note small">${problems.map(([b, p]) => `<b>${bandLabel(b)}</b> can’t start: ${esc(p.join(', '))}.`).join('<br>')}</p>` : ''}
    <div class="filters">
      <div class="field grow"><span id="fs-l" style="font-weight:700">Schools</span><div class="school-picks" role="group" aria-labelledby="fs-l">
        ${d.schools.length ? d.schools.map((s) => `<label><input type="checkbox" data-filter="schools" value="${s.id}" ${f.schools.includes(s.id) ? 'checked' : ''}>${esc(s.name)}</label>`).join('')
          : '<a href="#/admin/setup">Add schools in Setup</a>'}</div></div>
      <div class="field"><label for="f-band">Band</label><select id="f-band" data-filter="band"><option value="">All bands</option>
        ${ctx.cfg.bands.map((b) => `<option value="${b.id}" ${f.band === b.id ? 'selected' : ''}>${b.label}</option>`).join('')}</select></div>
      <div class="field"><label for="f-grade">Grade</label><select id="f-grade" data-filter="grade"><option value="">All grades</option>
        ${ctx.cfg.grades.map((g) => `<option value="${g}" ${String(f.grade) === String(g) ? 'selected' : ''}>Grade ${g}</option>`).join('')}</select></div>
      <div class="field"><label for="f-status">Status</label><select id="f-status" data-filter="status"><option value="">Any status</option>
        ${[['waiting', 'In lobby'], ['away', 'Not in lobby'], ['running', 'Playing'], ['paused', 'Paused'], ['finished', 'Finished'], ['stopped', 'Stopped'], ['not joined', 'Not joined']].map(([v, l]) => `<option value="${v}" ${f.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field grow"><label for="f-q">Search</label><input id="f-q" type="search" data-filter="q" placeholder="Name, code, phone or email" value="${esc(f.q)}"></div>
    </div>
    <div class="controls" role="toolbar" aria-label="Test controls">
      <span id="scope" class="grow"></span>
      <button class="btn" data-admin="control" data-action="start">Start</button>
      <button class="btn ghost" data-admin="control" data-action="pause">Pause</button>
      <button class="btn ghost" data-admin="control" data-action="resume">Resume</button>
      <button class="btn danger" data-admin="control" data-action="stop">Stop</button>
      <button class="btn ghost" data-admin="bulk-reattempt">Reattempt…</button>
      <button class="btn ghost" data-admin="logout">Log out…</button>
      <button class="btn ghost" data-admin="round-time">Timing…</button>
    </div>
    <div id="live-table"></div>`;
  liveTable();
  timer = setInterval(async () => {
    if (busy()) return;
    try { const next = await api('/api/admin/overview'); if (busy()) return; st.data = next; gateBar(); liveTable(); } catch { /* keep last view */ }
  }, 2000);
}

function filtered() {
  const f = st.filters, q = f.q.trim().toLowerCase();
  return st.data.students.filter((s) => (!f.schools.length || f.schools.includes(s.schoolId)) && (!f.band || s.band === f.band)
    && (!f.grade || String(s.grade) === String(f.grade)) && (!f.status || s.status === f.status)
    && (!q || `${s.name} ${s.code} ${s.email} ${s.phones.join(' ')}`.toLowerCase().includes(q)));
}
const targets = () => { const rows = filtered(); const sel = rows.filter((s) => st.selected.has(s.id)); return sel.length ? sel : rows; };

function statusCell(s) {
  const ph = s.phase, dot = `<span class="conn ${s.online ? 'on' : ''}" title="${s.online ? 'Connected' : 'Not connected right now'}" aria-label="${s.online ? 'Connected' : 'Not connected'}"></span>`;
  const map = { 'not joined': '<span class="chip">Not joined</span>', waiting: '<span class="chip brand">In lobby</span>', away: '<span class="chip" title="Registered, but their lobby screen isn’t open">Not in lobby</span>',
    paused: '<span class="chip warn">Paused</span>', finished: '<span class="chip ok">Finished</span>', stopped: '<span class="chip ok">Stopped</span>' };
  const where = ph && (ph.type === 'brief' ? `Round ${ph.round} · instructions & practice` : ph.type === 'round' ? `Round ${ph.round}` : ph.title || '');
  if (s.status === 'running' && ph) return `${dot}<span class="chip warn">Playing</span> <span class="small">${esc(where)} · ${fmt(ph.remainingMs || 0)}</span>`;
  if (s.status === 'paused' && s.closedPause) return `${dot}<span class="chip">Paused by closing</span> <span class="small">${esc(where)}</span>`;
  if (s.status === 'paused' && s.lock?.reason === 'logout') return `${dot}<span class="chip">${s.loggedIn ? 'Back after logout' : 'Logged out'}</span> ${s.lock.requested ? '<span class="chip warn">Asked to continue</span>' : ''}<div class="small">${esc(s.lock.note || '')}${s.loggedIn ? ' · press Resume to let them continue' : ` · they log in again with code <b>${esc(s.code)}</b>`}</div>`;
  if (s.status === 'paused' && s.lock) return `${dot}<span class="chip bad">Left test window${s.lock.count > 1 ? ` ×${s.lock.count}` : ''}</span> ${s.lock.requested ? '<span class="chip warn">Asked to continue</span>' : ''}<div class="small">${esc(s.lock.note || '')} · press Resume to let them back in</div>`;
  if (s.status === 'paused' && ph) return `${dot}${map.paused} <span class="small">${esc(where)} · ${fmt(ph.remainingMs || 0)} left</span>${s.loggedIn ? '' : ' <span class="chip" title="Logged out by a host — resume after they log in again with their player code">Logged out</span>'}`;
  const redo = s.redoRound ? ` <span class="small">Round ${s.redoRound} replay</span>` : '';
  const out = !s.loggedIn ? ' <span class="chip" title="This player’s window was logged out. They come back with their player code.">Logged out</span>' : '';
  return (s.status === 'not joined' ? '' : dot) + (map[s.status] || esc(s.status)) + redo + out;
}
const sc = (x) => (x ? (x.pending ? '<span title="AI marking in progress">…</span>' : `${x.total}${x.skipped ? `<sup title="${x.skipped} left empty">·${x.skipped}</sup>` : ''}`) : '—');

function liveTable() {
  if (!$('#live-table')) return;
  const rows = filtered(), sel = rows.filter((s) => st.selected.has(s.id));
  $('#scope').innerHTML = sel.length ? `Applies to <b>${sel.length} selected</b> student${sel.length > 1 ? 's' : ''}`
    : `Applies to <b>all ${rows.length} shown</b>${rows.length !== st.data.students.length ? ` (of ${st.data.students.length})` : ''}`;
  $('#live-table').innerHTML = `<div class="table-wrap"><table class="t"><caption class="sr-only">Students</caption><thead><tr>
      <th><input type="checkbox" data-admin="select-all" aria-label="Select all shown" ${sel.length && sel.length === rows.length ? 'checked' : ''}></th>
      <th>Code</th><th>Name</th><th>School</th><th class="num">Grade</th><th>Status</th><th class="num">R1</th><th class="num">R2</th><th class="num">R3</th><th class="num">Total</th><th></th></tr></thead>
    <tbody>${rows.length ? rows.map((s) => `<tr>
      <td><input type="checkbox" data-admin="select" value="${s.id}" ${st.selected.has(s.id) ? 'checked' : ''} aria-label="Select ${esc(s.name)}"></td>
      <td class="small"><b>${esc(s.code)}</b></td><td>${esc(s.name)}${s.reattempts ? ` <span class="chip" title="Reattempts">↻${s.reattempts}</span>` : ''}<div class="muted small">${esc(s.phones[0] || '')}</div></td>
      <td>${esc(schoolName(s.schoolId))}</td><td class="num">${s.grade}</td><td>${statusCell(s)}</td>
      ${[0, 1, 2].map((i) => `<td class="num">${sc(s.scores?.[i])}</td>`).join('')}
      <td class="num"><b>${s.scores?.some(Boolean) ? s.scores.reduce((t, x) => t + (x?.total || 0), 0) : '—'}</b></td>
      <td><button class="btn ghost sm" data-admin="detail" data-id="${s.id}">View</button></td></tr>`).join('')
      : '<tr><td colspan="11" class="muted center">No students match these filters.</td></tr>'}</tbody></table></div>`;
}

// Students started together share one set of questions per grade band. A later group can reuse the last run's questions or get new ones.
function questionChoice() {
  const last = (st.data.runs || []).at(-1);
  const pick = last?.live ? 'same' : 'new';
  const radio = (v, title, text) => `<label class="check"><input type="radio" name="qs" value="${v}" ${pick === v ? 'checked' : ''}><span>${title}<br><span class="muted small" style="font-weight:400">${text}</span></span></label>`;
  return `<fieldset class="stack" style="border:1.5px solid var(--line);border-radius:12px;padding:12px 14px"><legend style="font-weight:700;padding:0 6px">Questions for this group</legend>
    ${radio('new', 'New questions', 'Drawn fresh for each grade band. Rounds 2 and 3 adapt to how this group performs.')}
    ${last ? radio('same', `Same questions as session ${last.number}`, `${plural(last.students, 'student')}${last.live ? ' playing now' : ''} · started ${new Date(last.startedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}. Fair to compare with them.`) : ''}</fieldset>`;
}

async function runControl(action) {
  const list = targets();
  const verbs = { start: 'Start the test for', pause: 'Pause', resume: 'Resume', stop: 'Stop the test for' };
  const notes = { start: 'Only students whose lobby screen is open right now will start. Each student then reads the Round 1 instructions, tries a practice question and starts the round clock with “Start Round 1”.',
    pause: 'Clocks freeze for live students until you resume.', resume: 'Clocks continue from where they were paused.',
    stop: 'Open rounds are submitted with their saved answers and the test ends. This can’t be undone (use “Reattempt” to let a student play again).' };
  if (!list.length) { toast('No students in this selection.'); return; }
  if (action === 'start' && !st.data.gate.open) { toast('Promptathon is closed. Open it first (top of the page).'); return; }
  const ok = await dialog({ title: `${verbs[action]} ${plural(list.length, 'student')}?`,
    body: `<p>${notes[action]}</p>${action === 'start' ? questionChoice() : ''}<p class="small muted">${list.slice(0, 8).map((s) => esc(s.name)).join(', ')}${list.length > 8 ? ` and ${list.length - 8} more` : ''}</p>`,
    actions: [{ label: 'Cancel', value: 'no', kind: 'ghost' }, { label: action[0].toUpperCase() + action.slice(1), value: 'yes', kind: action === 'stop' ? 'danger' : '' }] });
  if (ok !== 'yes') return;
  try {
    const r = await api('/api/admin/control', { action, studentIds: list.map((s) => s.id), questions: action === 'start' ? $('input[name=qs]:checked')?.value : undefined });
    toast(`${r.done} updated${r.skipped ? `, ${r.skipped} skipped (not in the right state${action === 'start' ? ' — e.g. not in the lobby' : ''})` : ''}.`);
    if (r.errors.length) await dialog({ title: 'Some students could not start', body: `<p class="note bad">${r.errors.map(esc).join('<br>')}</p>`, actions: [{ label: 'OK', value: 'ok' }] });
    await refresh();
    liveTable();
  } catch (err) { toast(err.message); }
}

// Logs players out of their windows (their window returns to the join page). Running tests are paused.
async function logoutDialog(list) {
  const joined = list.filter((s) => s.loggedIn), live = joined.filter((s) => s.status === 'running').length;
  if (!joined.length) { toast('Nobody in this selection is logged in.'); return; }
  const ok = await dialog({ title: `Log out ${plural(joined.length, 'player')}?`,
    body: `<p>Each of these windows goes back to the start page straight away, and their old login stops working. Nobody can log themselves out or switch — only you can.</p>
      <p>To come back, a player chooses <b>I have a player code</b> and types their code (shown in the Students list). They return to their own test; a paused test continues when you press <b>Resume</b> (they can ask you from their screen).</p>
      ${live ? `<p class="note warn"><b>${plural(live, 'player')} ${live === 1 ? 'is' : 'are'} playing.</b> Their tests are paused (clocks stop) until they log in again with their code and you press <b>Resume</b>.</p>` : ''}
      <p class="small muted">${joined.slice(0, 8).map((s) => esc(s.name)).join(', ')}${joined.length > 8 ? ` and ${joined.length - 8} more` : ''}</p>`,
    actions: [{ label: 'Cancel', value: 'no', kind: 'ghost' }, { label: 'Log out', value: 'yes', kind: 'danger' }] });
  if (ok !== 'yes') return;
  const r = await api('/api/admin/logout', { studentIds: joined.map((s) => s.id) });
  toast(`${plural(r.done, 'player')} logged out${r.paused ? `, ${plural(r.paused, 'test')} paused` : ''}.`);
  await refresh();
  if ($('#live-table')) liveTable();
  else if (location.hash.startsWith('#/admin/students')) students();
}

// Reattempt for the selected students (or everyone shown): the whole test, or one round only.
async function bulkReattempt() {
  const list = targets();
  if (!list.length) { toast('No students in this selection.'); return; }
  const ended = list.filter((s) => ['finished', 'stopped'].includes(s.status)).length;
  const ok = await dialog({ title: `Reattempt for ${plural(list.length, 'student')}`,
    body: `<fieldset class="stack" style="border:0;padding:0;margin:0"><legend style="font-weight:700;margin-bottom:8px">What should they replay?</legend>
      <label class="check"><input type="radio" name="rr" value="0" checked><span>The whole test<br><span class="muted small" style="font-weight:400">Their current attempt is archived (scores kept) and they play all three rounds again.</span></span></label>
      ${[1, 2, 3].map((r) => `<label class="check"><input type="radio" name="rr" value="${r}"><span>Only Round ${r} · ${esc(ctx.cfg.rounds[r].name)}<br><span class="muted small" style="font-weight:400">Other rounds keep their answers and scores.</span></span></label>`).join('')}</fieldset>
      <p class="small muted">${ended} of ${list.length} have finished their test. A single round can be reopened only for students whose test has ended; nobody who is playing right now is changed. Afterwards they go back to the lobby and play when you press Start.</p>`,
    actions: [{ label: 'Cancel', value: 'no', kind: 'ghost' }, { label: 'Enable reattempt', value: 'yes' }] });
  if (ok !== 'yes') return;
  const round = Number($('input[name=rr]:checked')?.value) || 0;
  const r = await api('/api/admin/reattempts', { studentIds: list.map((s) => s.id), round });
  toast(`${round ? `Round ${round}` : 'Whole-test'} reattempt enabled for ${plural(r.done, 'student')}${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}.`);
  if (r.skipped.length) await dialog({ title: 'Some students were skipped', body: `<ul class="small">${r.skipped.slice(0, 30).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>${r.skipped.length > 30 ? `<p class="small muted">and ${r.skipped.length - 30} more</p>` : ''}`, actions: [{ label: 'OK', value: 'ok' }] });
  await refresh();
  liveTable();
}

// ---------------------------------------------------------------- student detail
async function detail(id) {
  const d = await api(`/api/admin/students/${id}`);
  const s = d.student;
  const secs = (v) => (v == null ? '' : v >= 60 ? `${Math.floor(v / 60)}m ${v % 60}s` : `${v}s`);
  const attempt = (a) => {
    const rounds = [1, 2, 3].map((r) => {
      const score = a.scores[r], meta = a.meta?.[r];
      const rows = a.answers.filter((x) => x.round === r);
      if (!rows.length) return '';
      const parts = a.parts?.[r] || ctx.cfg.scoreParts[r];
      return `<section style="margin-top:16px"><h3>${ctx.cfg.rounds[r].icon} Round ${r} · ${esc(ctx.cfg.rounds[r].name)}
          ${score ? `<span class="chip ${score.pending ? 'warn' : 'ok'}">${score.pending ? 'AI marking…' : `${Object.values(score.parts).reduce((t, p) => t + (p.points || 0), 0)}/20`}</span>` : '<span class="chip">Not submitted</span>'}
          ${meta?.takenMs != null ? `<span class="chip">⏱ ${secs(Math.round(meta.takenMs / 1000))}</span>` : ''}${meta?.skipped?.length ? `<span class="chip warn">${meta.skipped.length} left empty</span>` : ''}
          ${a.practice?.[r] ? `<span class="chip">Practice ${a.practice[r].correct === true ? '✓' : a.practice[r].correct === false ? '✗' : 'tried'}</span>` : ''}
          ${a.lifelines[r]?.length ? `<span class="chip">Lifeline: ${esc(a.lifelines[r].join(', '))}</span>` : ''}</h3>
        <div class="table-wrap"><table class="t"><thead><tr><th>ID</th><th>Question</th><th>Student answer</th><th>Correct / reference</th><th class="num">Pts</th><th class="num">Time</th><th>Marked</th></tr></thead><tbody>
        ${rows.map((x) => `<tr class="${x.skipped ? 'skipped-row' : ''}"><td class="small">${esc(x.id)}${x.lifeline ? ' <span class="chip">lifeline</span>' : ''}${x.skipped ? ' <span class="chip warn">empty</span>' : x.passed ? ' <span class="chip" title="Moved on without answering, came back later">passed over</span>' : ''}</td>
          <td class="small">${esc(x.question)}</td><td>${esc(x.answer)}</td>
          <td class="small muted">${esc(x.correct)}</td><td class="num">${x.points ?? '—'}${x.max ? `/${x.max}` : ''}</td><td class="num small">${secs(x.timeSec)}</td>
          <td class="small" title="${esc(x.note)}">${esc(x.by)}${x.note ? ` <span class="muted">${esc(x.note.slice(0, 120))}</span>` : ''}</td></tr>`).join('')}
        </tbody></table></div>
        ${score && !a.archived ? `<div class="row" style="margin-top:10px" data-score-block="${r}" data-attempt="${a.id}">
          ${parts.map((p) => `<label class="field small" style="font-weight:700">${esc(p.label)} /${p.max}
            <input class="editable-score" type="number" min="0" max="${p.max}" step="1" data-part="${p.key}" value="${score.parts[p.key]?.points ?? ''}"></label>`).join('')}
          <button type="button" class="btn sm" data-admin="save-scores" data-round="${r}" data-student="${s.id}">Save Round ${r} scores</button></div>` : ''}
      </section>`;
    }).join('');
    const card = Object.keys(a.scores).length ? ` <button type="button" class="btn ghost sm" data-admin="card-edit" data-id="${a.id}">Score card</button>` : '';
    const fb = a.feedback ? `<p class="small"><b>Feedback:</b> ${'★'.repeat(a.feedback.rating)}${'☆'.repeat(5 - a.feedback.rating)} ${a.feedback.text ? `“${esc(a.feedback.text)}”` : ''}</p>` : '';
    const head = `${esc(a.event)} · <span class="chip">${esc(a.status)}</span>${a.archived ? ' <span class="chip">Previous attempt</span>' : ''}${card}`;
    return a.archived ? `<details style="margin-top:16px"><summary>${head}</summary>${fb}${rounds}</details>` : `<div style="margin-top:8px">${head}${fb}${rounds || '<p class="muted">No rounds played yet.</p>'}</div>`;
  };
  await dialog({ title: `${s.name} · ${s.code}`, wide: true,
    body: `<p>Grade ${s.grade} (${bandLabel(s.band)}) · ${esc(s.school)} · 📞 ${esc((s.phones || []).join(', ') || '—')} · ✉️ ${esc(s.email || '—')} · registered ${esc(when(s.createdAt))}</p>
      <div class="row"><b>Window:</b> ${s.loggedIn ? `<span class="chip ok">Logged in</span> <button type="button" class="btn ghost sm" data-admin="logout-one" data-id="${s.id}">Log out</button>` : '<span class="chip">Logged out</span>'}</div>
      <div class="row" style="margin-top:8px"><b>Enable reattempt:</b>
        <button type="button" class="btn ghost sm" data-admin="reattempt" data-id="${s.id}" data-round="0">Whole test</button>
        ${[1, 2, 3].map((r) => `<button type="button" class="btn ghost sm" data-admin="reattempt" data-id="${s.id}" data-round="${r}">Round ${r} only</button>`).join('')}</div>
      <p class="small muted">Whole test archives the current attempt (its scores are kept) and the student plays everything again. A single round keeps the other rounds and replays only that round. Either way the student goes back to the lobby and starts when you press Start.</p>
      ${d.attempts.map((a) => attempt(a)).join('') || '<p class="muted" style="margin-top:12px">This student hasn’t joined yet.</p>'}`,
    actions: [{ label: 'Close', value: 'close' }] });
}

// ---------------------------------------------------------------- students (registrations: who joined, how to contact them)
const sf = { q: '', school: '', grade: '', status: '' };
function students() {
  const all = st.data.students;
  const q = sf.q.trim().toLowerCase();
  const rows = all.filter((s) => (!sf.school || s.schoolId === sf.school) && (!sf.grade || String(s.grade) === sf.grade) && (!sf.status || s.status === sf.status)
    && (!q || `${s.name} ${s.code} ${s.email} ${s.phones.join(' ')}`.toLowerCase().includes(q))).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const label = { 'not joined': 'Not joined', away: 'Registered', waiting: 'In lobby', running: 'Playing', paused: 'Paused', finished: 'Finished', stopped: 'Stopped' };
  body().innerHTML = `<div class="row between"><div><h1 style="margin:0 0 6px">Students</h1>
      <p class="muted" style="margin-top:0">Everyone who registered: name, grade, school, phone and email. Players don’t sign in — this is where their details live.</p></div>
      <div class="row"><a class="btn ghost" href="/api/admin/students.csv" download>Download CSV</a><a class="btn ghost" href="/api/admin/export.xlsx" download>Full Excel report</a></div></div>
    <div class="filters" role="group" aria-label="Filter students">
      <div class="field grow"><label for="sf-q">Search</label><input id="sf-q" type="search" data-sf="q" value="${esc(sf.q)}" placeholder="Name, code, phone or email"></div>
      <div class="field"><label for="sf-school">School</label><select id="sf-school" data-sf="school"><option value="">All schools</option>${st.data.schools.map((s) => `<option value="${s.id}" ${sf.school === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="sf-grade">Grade</label><select id="sf-grade" data-sf="grade"><option value="">All grades</option>${ctx.cfg.grades.map((g) => `<option value="${g}" ${sf.grade === String(g) ? 'selected' : ''}>Grade ${g}</option>`).join('')}</select></div>
      <div class="field"><label for="sf-status">Status</label><select id="sf-status" data-sf="status"><option value="">Any</option>${Object.entries(label).map(([v, l]) => `<option value="${v}" ${sf.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <p class="muted small" style="align-self:end;margin:0">Showing ${rows.length} of ${all.length}</p></div>
    <div class="table-wrap"><table class="t"><thead><tr><th>Student</th><th>School</th><th class="num">Grade</th><th>Phone</th><th>Email</th><th>Registered</th><th>Status</th><th>Window</th><th>Feedback</th><th></th></tr></thead><tbody>
    ${rows.length ? rows.map((s) => `<tr><td><b>${esc(s.name)}</b><div class="muted small">${esc(s.code)} · ${esc(bandLabel(s.band))}</div></td><td>${esc(schoolName(s.schoolId))}</td><td class="num">${s.grade}</td>
      <td class="small">${s.phones.map(esc).join('<br>') || '—'}</td><td class="small">${esc(s.email) || '<span class="muted">—</span>'}</td><td class="small">${esc(when(s.createdAt))}</td>
      <td><span class="chip ${s.status === 'finished' || s.status === 'stopped' ? 'ok' : s.status === 'running' ? 'warn' : ''}">${esc(label[s.status] || s.status)}</span></td>
      <td>${s.loggedIn ? `<span class="chip ok">${s.online ? 'Logged in · connected' : 'Logged in'}</span>` : `<span class="chip" title="They come back with their player code">Logged out</span>`}</td>
      <td class="small">${s.feedback ? `<span title="${esc(s.feedback.text)}">${['', '😞', '🙁', '😐', '🙂', '😄'][s.feedback.rating]} ${s.feedback.text ? '💬' : ''}</span>` : '—'}</td>
      <td><div class="row" style="gap:6px"><button class="btn ghost sm" data-admin="detail" data-id="${s.id}">View</button>
        ${s.loggedIn ? `<button class="btn ghost sm" data-admin="logout-one" data-id="${s.id}">Log out</button>` : ''}
        ${['not joined', 'away', 'waiting'].includes(s.status) && !s.reattempts ? `<button class="btn quiet sm" data-admin="del-student" data-id="${s.id}" data-name="${esc(s.name)}">Remove</button>` : ''}</div></td></tr>`).join('')
      : '<tr><td colspan="10" class="muted center">No students match.</td></tr>'}</tbody></table></div>`;
}

// ---------------------------------------------------------------- reattempt requests
async function requests() {
  const [list, dels] = await Promise.all([api('/api/admin/requests'), api('/api/admin/deletions')]);
  const chip = (r) => ({ pending: '<span class="chip warn">Waiting</span>', approved: '<span class="chip ok">Approved</span>', rejected: '<span class="chip bad">Declined</span>' })[r.status];
  body().innerHTML = `<h1 style="margin:0 0 6px">Reattempt requests</h1>
    <p class="muted" style="margin-top:0">Students ask for another try after their test ends. Approving puts them back in the lobby; declining shows them your message.</p>
    <div class="table-wrap"><table class="t"><thead><tr><th>Student</th><th>School</th><th class="num">Score</th><th>Their note</th><th>Requested</th><th>Status</th><th></th></tr></thead><tbody>
    ${list.length ? list.map((r) => `<tr><td><b>${esc(r.student.name)}</b><div class="muted small">${esc(r.student.code)} · Grade ${r.student.grade}</div></td>
      <td>${esc(r.student.school)}</td><td class="num">${r.total ?? '—'}</td><td class="small">${r.note ? esc(r.note) : '<span class="muted">No note</span>'}</td>
      <td class="small">${esc(when(r.createdAt))}</td>
      <td>${chip(r)}${r.status !== 'pending' ? `<div class="small muted">${esc(when(r.decidedAt))}${r.reply ? ` · “${esc(r.reply)}”` : ''}</div>` : ''}</td>
      <td>${r.status === 'pending' ? `<div class="row" style="gap:6px"><button class="btn sm" data-admin="decide" data-id="${r.id}" data-approve="true" data-name="${esc(r.student.name)}">Approve</button>
        <button class="btn ghost sm" data-admin="decide" data-id="${r.id}" data-approve="false" data-name="${esc(r.student.name)}">Decline</button></div>` : ''}</td></tr>`).join('')
      : '<tr><td colspan="7" class="muted center">No requests yet.</td></tr>'}</tbody></table></div>
    <h2 style="margin-top:32px">Data deletion requests</h2>
    <p class="muted" style="margin-top:0">Parents and guardians can ask for a child’s data to be erased (Privacy → Delete my data). Delete the student’s rows from the sheet, reply to them, then mark it done.</p>
    <div class="table-wrap"><table class="t"><thead><tr><th>From</th><th>Student code</th><th>Details</th><th>Requested</th><th>Status</th><th></th></tr></thead><tbody>
    ${dels.length ? dels.map((d) => `<tr><td><b>${esc(d.name)}</b><div class="small"><a href="mailto:${esc(d.email)}">${esc(d.email)}</a></div></td><td>${esc(d.code) || '—'}</td><td class="small">${esc(d.details) || '—'}</td>
      <td class="small">${esc(when(d.at))}</td><td>${d.status === 'open' ? '<span class="chip warn">Open</span>' : `<span class="chip ok">Done</span><div class="small muted">${esc(d.by)} · ${esc(when(d.doneAt))}</div>`}</td>
      <td>${d.status === 'open' ? `<button class="btn sm" data-admin="del-done" data-id="${d.id}">Mark done</button>` : ''}</td></tr>`).join('')
      : '<tr><td colspan="6" class="muted center">No deletion requests.</td></tr>'}</tbody></table></div>`;
}

async function decide(id, approve, name) {
  const ok = await dialog({ title: `${approve ? 'Approve' : 'Decline'} ${name}’s request?`,
    body: `<p>${approve ? 'They return to the lobby for another try.' : 'They will see that the request was declined, along with your message.'}</p>
      ${approve ? `<div class="field"><label for="rq-round">What should they replay?</label><select id="rq-round">
        <option value="0">The whole test (previous attempt archived, scores kept)</option>
        ${[1, 2, 3].map((r) => `<option value="${r}">Only Round ${r} · ${esc(ctx.cfg.rounds[r].name)} (other rounds kept)</option>`).join('')}</select></div>` : ''}
      <div class="field"><label for="rq-msg">Message to the student <span class="hint">(optional)</span></label><textarea id="rq-msg" maxlength="500"></textarea></div>`,
    actions: [{ label: 'Cancel', value: 'no', kind: 'ghost' }, { label: approve ? 'Approve' : 'Decline', value: 'yes', kind: approve ? '' : 'danger' }] });
  if (ok !== 'yes') return;
  await api(`/api/admin/requests/${id}`, { approve, reply: $('#rq-msg').value, round: approve ? Number($('#rq-round').value) : 0 });
  toast(approve ? 'Approved — the student can rejoin the lobby.' : 'Declined — the student will see your message.');
  renderAdmin(root, 'requests', ctx);
}

// ---------------------------------------------------------------- timing (rounds and the instructions before them)
async function timeDialog({ ids = null, scope = 'everyone playing', target = 'current', action = 'extend' } = {}) {
  const radio = (v, label) => `<label class="check"><input type="radio" name="rt-action" value="${v}" ${action === v ? 'checked' : ''}><span>${label}</span></label>`;
  const ok = await dialog({ title: 'Timing',
    body: `<p>Applies to <b>${esc(scope)}</b>. Students see the change within a second; their saved answers are never touched.</p>
      <div class="stack"><div class="field"><label for="rt-target">What to change</label><select id="rt-target">
        <option value="current" ${target === 'current' ? 'selected' : ''}>Whatever each student is on now (a round, or the instructions before it)</option>
        ${[1, 2, 3].map((r) => `<option value="${r}" ${String(target) === String(r) ? 'selected' : ''}>Round ${r} · ${esc(ctx.cfg.rounds[r].name)}</option>`).join('')}</select></div>
      <div class="stack">${radio('extend', 'Add time')}${radio('end', 'End it now — a round’s answers so far are submitted; instructions end and the round starts')}</div>
      <div class="row"><div class="field" style="flex:1"><label for="rt-amount">Time to add</label><input id="rt-amount" type="number" min="1" max="1800" value="2"></div>
        <div class="field"><label for="rt-unit">Unit</label><select id="rt-unit"><option value="60">minutes</option><option value="1">seconds</option></select></div></div></div>`,
    actions: [{ label: 'Cancel', value: 'no', kind: 'ghost' }, { label: 'Apply', value: 'yes' }] });
  if (ok !== 'yes') return;
  const act = $('input[name=rt-action]:checked').value, tg = $('#rt-target').value;
  const amount = Number($('#rt-amount').value) * Number($('#rt-unit').value);
  if (act === 'end' && await dialog({ title: 'End it now?', body: '<p>Students are moved on straight away. This can’t be undone.</p>',
    actions: [{ label: 'Cancel', value: 'no', kind: 'ghost' }, { label: 'End now', value: 'yes', kind: 'danger' }] }) !== 'yes') return;
  const r = await api('/api/admin/phase-time', { action: act, target: tg, seconds: amount, studentIds: ids || undefined });
  toast(`${plural(r.done, 'student')} updated${r.skipped ? `, ${r.skipped} skipped (that part isn’t running or is already over for them)` : ''}.`);
  if (root?.isConnected) await refresh();
}

// ---------------------------------------------------------------- score cards (filter by school, grade, session; act on what is shown)
const cf = { school: '', grade: '', run: '', state: '' };
const CARD_STATES = [['', 'Any'], ['ready', 'Ready to approve'], ['approved', 'Approved'], ['unsent', 'Approved, not emailed yet'], ['sent', 'Emailed'], ['noemail', 'No email given'], ['pending', 'Still marking']];
const cardState = (r) => ({ ready: !r.archived && !r.approved && r.status !== 'pending', approved: r.approved, unsent: r.approved && r.email && (!r.emailedAt || r.changedSinceEmailed),
  sent: Boolean(r.emailedAt), noemail: !r.email, pending: r.status === 'pending' });

async function cards() {
  const d = await api('/api/admin/scorecards'), all = d.rows;
  const schools = [...new Set(all.map((r) => r.school).filter(Boolean))].sort(), grades = [...new Set(all.map((r) => String(r.grade)).filter(Boolean))].sort((a, b) => a - b);
  const runsList = [...new Set(all.map((r) => String(r.run)).filter(Boolean))].sort((a, b) => a - b);
  if (cf.school && !schools.includes(cf.school)) cf.school = '';
  if (cf.grade && !grades.includes(cf.grade)) cf.grade = '';
  if (cf.run && !runsList.includes(cf.run)) cf.run = '';
  const rows = all.filter((r) => (!cf.school || r.school === cf.school) && (!cf.grade || String(r.grade) === cf.grade) && (!cf.run || String(r.run) === cf.run) && (!cf.state || cardState(r)[cf.state]));
  st.cardRows = rows;
  const ready = rows.filter((r) => cardState(r).ready).length;
  const unsent = rows.filter((r) => cardState(r).unsent).length;
  const approvedShown = rows.filter((r) => r.approved);
  const runInfo = (n) => { const x = d.runs.find((r) => String(r.number) === String(n)); return x ? `Session ${n} · ${new Date(x.startedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · ${plural(x.students, 'student')}` : `Session ${n}`; };
  const statusChip = { pending: '<span class="chip warn">Marking…</span>', provisional: '<span class="chip">Provisional</span>', final: '<span class="chip ok">Final</span>' };
  body().innerHTML = `<h1 style="margin:0 0 6px">Score cards</h1>
    <p class="muted" style="margin-top:0">Made from each student’s saved answers. Edit anything, then approve — students see approved cards on their own screen, and approved cards can be emailed to the email the student gave when registering${d.emailReady ? ` (sent from ${esc(d.from)})` : ''}. Pick a school and session to send one batch at a time.</p>
    ${d.emailReady ? '' : '<p class="note bad small">Email isn’t set up. Add SMTP_USER and SMTP_PASS (an app password) on the server.</p>'}
    <div class="filters" role="group" aria-label="Filter score cards">
      <div class="field"><label for="cf-school">School</label><select id="cf-school" data-admin-change="cards-filter" data-k="school"><option value="">All schools</option>${schools.map((x) => `<option value="${esc(x)}" ${cf.school === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div>
      <div class="field"><label for="cf-run">Session (group started together)</label><select id="cf-run" data-admin-change="cards-filter" data-k="run"><option value="">All sessions</option>${runsList.map((x) => `<option value="${esc(x)}" ${cf.run === x ? 'selected' : ''}>${esc(runInfo(x))}</option>`).join('')}</select></div>
      <div class="field"><label for="cf-grade">Grade</label><select id="cf-grade" data-admin-change="cards-filter" data-k="grade"><option value="">All grades</option>${grades.map((x) => `<option value="${esc(x)}" ${cf.grade === x ? 'selected' : ''}>Grade ${esc(x)}</option>`).join('')}</select></div>
      <div class="field"><label for="cf-state">Status</label><select id="cf-state" data-admin-change="cards-filter" data-k="state">${CARD_STATES.map(([v, l]) => `<option value="${v}" ${cf.state === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <p class="muted small" style="align-self:end;margin:0">Showing <b>${rows.length}</b> of ${all.length}. The buttons below act on the cards shown.</p></div>
    <div class="controls" role="toolbar" aria-label="Score card actions">
      <button class="btn" data-admin="cards-approve-all" ${ready ? '' : 'disabled'}>Approve shown (${ready})</button>
      <button class="btn" data-admin="cards-send-all" ${d.emailReady && unsent ? '' : 'disabled'}>Email shown (${unsent})</button>
      <a class="btn ghost" ${approvedShown.length ? `href="/api/admin/scorecards.zip?ids=${approvedShown.map((r) => r.attemptId).join(',')}" download` : 'aria-disabled="true"'}>Download shown (ZIP · ${approvedShown.length})</a>
      <button class="btn ghost" data-admin="cards-test" ${d.emailReady ? '' : 'disabled'}>Send me a sample</button>
      <label class="check grow" style="justify-content:flex-end"><input type="checkbox" data-admin-change="cards-auto" ${d.autoSend ? 'checked' : ''} ${d.emailReady ? '' : 'disabled'}><span>Email automatically when a card is approved</span></label>
    </div>
    <div class="table-wrap"><table class="t"><thead><tr><th>Student</th><th>Sends to</th><th class="num">Total</th><th>Marks</th><th>Approved</th><th>Emailed</th><th></th></tr></thead><tbody>
    ${rows.length ? rows.map((r) => `<tr><td><b>${esc(r.name)}</b>${r.edited ? ' <span class="chip brand">Edited</span>' : ''}${r.archived ? ' <span class="chip">Earlier attempt</span>' : ''}
        <div class="muted small">${esc(r.code)} · Grade ${esc(r.grade)} · ${esc(r.school)}${r.run ? ` · Session ${r.run}` : ''}</div></td>
      <td class="small">${r.email ? esc(r.email) : '<span class="chip">No email — download instead</span>'}</td><td class="num"><b>${r.total}</b>/60</td><td>${statusChip[r.status]}</td>
      <td>${r.approved ? '<span class="chip ok">Approved</span>' : '<span class="chip">Not yet</span>'}</td>
      <td class="small">${r.emailedAt ? `<span class="chip ok">Sent</span> ${esc(when(r.emailedAt))}${r.changedSinceEmailed ? ' <span class="chip warn">Changed since</span>' : ''}` : '<span class="muted">—</span>'}</td>
      <td><div class="row" style="gap:6px">
        <button class="btn sm" data-admin="card-edit" data-id="${r.attemptId}">Edit</button>
        <a class="btn ghost sm" href="/api/admin/scorecard/${r.attemptId}" target="_blank" rel="noopener">View</a>
        <a class="btn ghost sm" href="/api/admin/scorecard/${r.attemptId}/pdf" download>PDF</a>
        <button class="btn ghost sm" data-admin="card-approve" data-id="${r.attemptId}" data-on="${!r.approved}" ${r.status === 'pending' && !r.approved ? 'disabled' : ''}>${r.approved ? 'Unapprove' : 'Approve'}</button>
        ${d.emailReady && r.approved && r.email ? `<button class="btn ghost sm" data-admin="card-send" data-id="${r.attemptId}">${r.emailedAt ? 'Resend' : 'Email'}</button>` : ''}</div></td></tr>`).join('')
      : '<tr><td colspan="7" class="muted center">No score cards match — they appear once students have scored rounds.</td></tr>'}
    </tbody></table></div>`;
}

async function cardEditor(attemptId) {
  const d = await api(`/api/admin/scorecard/${attemptId}/data`), c = d.card, base = d.computed;
  const text = (key, label, extra = '') => `<div class="field"><label for="ce-${key}">${label}</label><input id="ce-${key}" data-f="${key}" type="text" value="${esc(c[key])}" ${extra}></div>`;
  const num = (attr, label, v, max, ph) => `<div class="field"><label>${label}<input ${attr} type="number" min="0" max="${max}" value="${v ?? ''}" placeholder="${ph ?? ''}"></label></div>`;
  const choice = await dialog({ title: `Score card · ${c.name}`, wide: true,
    body: `<div class="row between"><span>${c.approved ? '<span class="chip ok">Approved — students can see it</span>' : '<span class="chip">Not approved</span>'} ${c.status === 'pending' ? '<span class="chip warn">Marking still in progress</span>' : ''}${c.edited ? ' <span class="chip brand">Edited</span>' : ''}</div>
        <div class="row"><a class="btn ghost sm" href="/api/admin/scorecard/${attemptId}" target="_blank" rel="noopener">Preview</a><a class="btn ghost sm" href="/api/admin/scorecard/${attemptId}/pdf" download>Download PDF</a></div></div>
      <p class="small muted">Change any field or percentage; leave a box as it is to keep the computed value. Edits apply to the preview, the PDF, the email and what the student sees.</p>
      <div class="two"><div class="stack">
        <div class="row">${text('name', 'Student name')}${text('grade', 'Grade')}</div>
        <div class="row">${text('school', 'School')}${text('code', 'Player code')}</div>
        <div class="row">${num('data-r="0"', 'Round 1 /20', c.rounds[0], 20, base.rounds[0])}${num('data-r="1"', 'Round 2 /20', c.rounds[1], 20, base.rounds[1])}${num('data-r="2"', 'Round 3 /20', c.rounds[2], 20, base.rounds[2])}${num('data-f="total"', 'Total /60', c.total, 60, base.total)}</div>
        <div class="field"><label for="ce-strength">My strength</label><textarea id="ce-strength" data-f="strength" maxlength="400">${esc(c.strength)}</textarea></div>
        <div class="field"><label for="ce-next">My next step</label><textarea id="ce-next" data-f="nextStep" maxlength="400">${esc(c.nextStep)}</textarea></div></div>
      <div><h3 style="margin-top:0">Skill percentages</h3><div class="stack" style="gap:8px">
        ${c.skills.map((s) => `<div class="row between" style="flex-wrap:nowrap"><label for="ce-${s.id}" style="flex:1;font-weight:400"><b>${esc(s.name)}</b>${s.edited ? ' <span class="chip brand">edited</span>' : ''}<div class="muted small">computed ${base.skills.find((k) => k.id === s.id).percent ?? '—'}${s.evidence ? ` · from ${plural(s.evidence, 'task')}` : ''}</div></label>
          <input id="ce-${s.id}" data-s="${s.id}" type="number" min="0" max="100" value="${s.percent ?? ''}" style="width:5.5em"><span class="muted small">%</span></div>`).join('')}</div></div></div>`,
    actions: [{ label: 'Cancel', value: 'no', kind: 'ghost' }, { label: 'Reset edits', value: 'reset', kind: 'ghost' }, { label: 'Save', value: 'save' }, { label: c.approved ? 'Save (stays approved)' : 'Save & approve', value: 'approve' }] });
  if (!['reset', 'save', 'approve'].includes(choice)) return;
  const edits = {};
  if (choice !== 'reset') {
    for (const el of $$('[data-f]')) edits[el.dataset.f] = el.value;
    edits.rounds = $$('[data-r]').map((el) => el.value);
    edits.skills = Object.fromEntries($$('[data-s]').map((el) => [el.dataset.s, el.value]));
  }
  await api(`/api/admin/scorecard/${attemptId}`, { edits, approve: choice === 'approve' ? true : undefined });
  toast(choice === 'reset' ? 'Edits cleared.' : choice === 'approve' ? 'Saved and approved.' : 'Saved.');
  if (location.hash.startsWith('#/admin/cards')) renderAdmin(root, 'cards', ctx);
}

const sendReport = (r) => dialog({ title: 'Emails', body: `<p><b>${r.sent}</b> sent${r.skipped ? `, ${r.skipped} skipped (already sent or not approved)` : ''}${r.noEmail ? `, <b>${r.noEmail}</b> without an email address (download those cards instead)` : ''}${r.failed.length ? `, <b>${r.failed.length}</b> failed` : ''}.</p>
  ${r.failed.length ? `<p class="note bad small">${r.failed.map((f) => `${esc(f.name)} (${esc(f.to)}): ${esc(f.error)}`).join('<br>')}</p>` : ''}`, actions: [{ label: 'OK', value: 'ok' }] });

// ---------------------------------------------------------------- leaderboard
async function leaderboard() {
  const d = st.data;
  const lb = await api(`/api/leaderboard?band=${st.lbBand}&school=${st.lbSchool}${st.lbRun ? `&run=${st.lbRun}` : ''}`);
  body().innerHTML = `<div class="row between" style="margin-bottom:16px">
      <div class="seg" role="group" aria-label="Grade band">${ctx.cfg.bands.map((b) => `<button data-admin="lb-band" data-band="${b.id}" aria-pressed="${st.lbBand === b.id}">${b.label}</button>`).join('')}</div>
      <div class="row"><label for="lb-school" class="sr-only">School</label><select id="lb-school" data-admin-change="lb-school" style="width:auto">
        <option value="">All schools</option>${d.schools.map((s) => `<option value="${s.id}" ${st.lbSchool === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
        <label for="lb-run" class="sr-only">Session</label><select id="lb-run" data-admin-change="lb-run" style="width:auto">
          ${lb.runs.map((r) => `<option value="${r.id}" ${(st.lbRun || lb.run) === r.id ? 'selected' : ''}>Session ${r.number} · ${plural(r.students, 'student')}</option>`).join('')}<option value="all" ${(st.lbRun || lb.run) === 'all' ? 'selected' : ''}>All sessions</option></select>
        <button class="btn ${d.event.finalPublished ? 'ghost' : ''}" data-admin="publish" data-final="${!d.event.finalPublished}">${d.event.finalPublished ? 'Mark as provisional' : 'Publish final results'}</button></div></div>
    <div class="card tight row between" style="margin-bottom:16px"><div><b>What students see</b><div class="muted small">Whether a student’s leaderboard lists only their own school or every school in their grade band.</div></div>
      <div class="seg" role="group" aria-label="Student leaderboard scope"><button data-admin="lb-scope" data-all="false" aria-pressed="${!d.lbAllSchools}">Own school only</button><button data-admin="lb-scope" data-all="true" aria-pressed="${d.lbAllSchools}">All schools</button></div></div>
    ${leaderboardHTML(lb, { bands: ctx.cfg.bands })}`;
}

// ---------------------------------------------------------------- analytics
const hbars = (rows, max, unit = '') => `<div class="hbars">${rows.map((r) => `<div class="hbar"><span class="label">${esc(r.label)}</span>
  <div class="track" tabindex="0" data-tip="${esc(r.label)}: ${r.value ?? '—'}${unit}"><div class="fill" style="width:${r.value ? (r.value / max) * 100 : 0}%"></div></div>
  <span class="num small"><b>${r.value ?? '—'}</b></span></div>`).join('')}</div>`;

async function analytics() {
  const a = await api('/api/admin/analytics');
  const maxDist = Math.max(1, ...a.distribution.map((d) => d.count));
  const schools = st.data.schools;
  body().innerHTML = `<h1 style="margin:0 0 12px">Analytics · ${esc(a.event)}</h1>
    <section class="card paper" style="margin-bottom:20px"><h2 style="margin-bottom:4px">Download reports</h2>
      <p class="muted small" style="margin-top:0">Formatted Excel workbooks: overview, results ranked by grade band, thinking skills, score breakdown, question analysis (with time per question), every answer (with time and skipped questions), students with contact details, and feedback.</p>
      <div class="row">
        <a class="btn" href="/api/admin/export.xlsx" download>All schools (Excel)</a>
        <span class="row" style="gap:8px"><label for="rep-school" class="sr-only">School</label><select id="rep-school" data-admin-change="rep-school" style="width:auto">
          ${schools.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('') || '<option value="">No schools yet</option>'}</select>
          <a class="btn ghost" id="rep-one" href="${schools.length ? `/api/admin/export.xlsx?school=${encodeURIComponent(schools[0].id)}` : '#'}" download ${schools.length ? '' : 'aria-disabled="true"'}>One school (Excel)</a></span>
        <a class="btn ghost" href="/api/admin/export-schools.zip" download ${schools.length ? '' : 'aria-disabled="true"'}>Every school, one file each (ZIP)</a>
        <a class="btn ghost" href="/api/admin/students.csv" download>Students (CSV)</a>
      </div></section>
    <div class="kpis">${[['Registered students', a.kpis.registered], ['In lobby', a.kpis.lobby], ['Playing now', a.kpis.live], ['Finished', a.kpis.finished],
      ['Average total', a.kpis.avgTotal == null ? '—' : `${a.kpis.avgTotal}/60`], ['Feedback', a.kpis.avgRating == null ? '—' : `${a.kpis.avgRating}/5 · ${a.kpis.feedback}`]]
      .map(([l, v]) => `<div class="kpi"><div class="muted small">${l}</div><div class="big">${v}</div></div>`).join('')}</div>
    <div class="two">
      <section class="card"><h2>Average score by round</h2><p class="muted small">Out of 20 points each.</p>${hbars(a.rounds.map((r) => ({ label: r.name, value: r.avg })), 20, '/20')}
        <div class="table-wrap" style="margin-top:14px"><table class="t"><thead><tr><th>Round</th><th class="num">Avg minutes</th><th class="num">Questions left empty</th></tr></thead>
        <tbody>${a.rounds.map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${r.avgMinutes ?? '—'}</td><td class="num">${r.skipped}</td></tr>`).join('')}</tbody></table></div></section>
      <section class="card"><h2>Score distribution</h2><p class="muted small">Finished players by total score (out of 60).</p>
        <div class="vbars" role="img" aria-label="Score distribution">${a.distribution.map((d) => `<div class="vbar" tabindex="0" data-tip="${d.label}: ${plural(d.count, 'player')}"><div class="fill" style="height:${(d.count / maxDist) * 100}%"></div></div>`).join('')}</div>
        <div class="vlabels" aria-hidden="true">${a.distribution.map((d) => `<span>${d.label}</span>`).join('')}</div></section>
    </div>
    <div class="two" style="margin-top:20px">
      <section class="card"><h2>Schools</h2>${hbars(a.schools.map((s) => ({ label: s.name, value: s.avg })), 60, '/60')}
        <div class="table-wrap" style="margin-top:14px"><table class="t"><thead><tr><th>School</th><th class="num">Students</th><th class="num">Finished</th><th class="num">Avg /60</th></tr></thead>
        <tbody>${a.schools.map((s) => `<tr><td>${esc(s.name)}</td><td class="num">${s.students}</td><td class="num">${s.finished}</td><td class="num">${s.avg ?? '—'}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No schools yet.</td></tr>'}</tbody></table></div></section>
      <section class="card"><h2>Grade bands</h2><div class="table-wrap"><table class="t"><thead><tr><th>Band</th><th class="num">Finished</th><th class="num">Avg /60</th><th>Difficulty drawn</th></tr></thead>
        <tbody>${a.bands.map((b) => `<tr><td>${b.label}</td><td class="num">${b.finished}</td><td class="num">${b.avg ?? '—'}</td><td class="small">${esc(b.levels || '—')}</td></tr>`).join('')}</tbody></table></div>
        <h3 style="margin-top:18px">Lifelines used</h3><p>${Object.entries(a.lifelineUse).map(([k, v]) => `<span class="chip">${esc(k)}: ${v}</span>`).join(' ') || '<span class="muted">None yet.</span>'}</p></section>
    </div>
    <section class="card" style="margin-top:20px"><h2>Score components</h2><div class="table-wrap"><table class="t"><thead><tr><th>Round</th><th>Component</th><th class="num">Average</th><th class="num">Max</th></tr></thead>
      <tbody>${[1, 2, 3].flatMap((r) => a.parts[r].map((p) => `<tr><td>${esc(ctx.cfg.rounds[r].name)}</td><td>${esc(p.label)}</td><td class="num">${p.avg ?? '—'}</td><td class="num">${p.max}</td></tr>`)).join('')}</tbody></table></div></section>
    <section class="card" style="margin-top:20px"><h2>Round 2 steps</h2><div class="table-wrap"><table class="t"><thead><tr><th>Band</th><th>Case · step</th><th>Kind</th><th class="num">Students</th><th class="num">Avg %</th><th class="num">Avg seconds</th></tr></thead>
      <tbody>${a.steps.map((i) => `<tr><td>${bandLabel(i.band)}</td><td class="small">${esc(i.id)}</td><td>${esc(i.kind)}${i.written ? ' (written)' : ''}</td><td class="num">${i.attempts}</td><td class="num">${i.pct ?? '—'}</td><td class="num">${i.avgSec ?? '—'}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No Round 2 answers yet.</td></tr>'}</tbody></table></div></section>
    <section class="card" style="margin-top:20px"><h2>Round 1 item analysis</h2><div class="table-wrap"><table class="t"><thead><tr><th>Band</th><th>Question</th><th>Skill</th><th>Difficulty</th><th class="num">Attempts</th><th class="num">% correct</th><th class="num">Lifelines</th><th class="num">Avg seconds</th></tr></thead>
      <tbody>${a.items.map((i) => `<tr><td>${bandLabel(i.band)}</td><td class="small">${esc(i.id)}</td><td>${esc(i.skill)}</td><td>${esc(i.difficulty)}</td><td class="num">${i.attempts}</td><td class="num">${i.pctCorrect ?? '—'}</td><td class="num">${i.lifelines}</td><td class="num">${i.avgSec ?? '—'}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">No rounds played yet.</td></tr>'}</tbody></table></div></section>`;
}

// ---------------------------------------------------------------- feedback (the smiley card at the end)
const ff = { school: '', rating: '' };
async function feedback() {
  const d = await api('/api/admin/feedback');
  const rows = d.rows.filter((f) => (!ff.school || f.student.schoolId === ff.school) && (!ff.rating || String(f.rating) === ff.rating));
  const counts = d.ratings.map((r) => ({ ...r, n: rows.filter((f) => f.rating === r.value).length }));
  const max = Math.max(1, ...counts.map((c) => c.n)), avg = rows.length ? Math.round((rows.reduce((t, f) => t + f.rating, 0) / rows.length) * 10) / 10 : null;
  body().innerHTML = `<h1 style="margin:0 0 6px">Feedback</h1>
    <p class="muted" style="margin-top:0">The smiley each student picked at the end, and their optional comment.</p>
    <div class="filters"><div class="field"><label for="ff-school">School</label><select id="ff-school" data-ff="school"><option value="">All schools</option>${st.data.schools.map((s) => `<option value="${s.id}" ${ff.school === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
      <div class="field"><label for="ff-rating">Smiley</label><select id="ff-rating" data-ff="rating"><option value="">All</option>${d.ratings.map((r) => `<option value="${r.value}" ${ff.rating === String(r.value) ? 'selected' : ''}>${r.face} ${esc(r.label)}</option>`).join('')}</select></div></div>
    <div class="two"><section class="card"><h2>${avg == null ? 'No feedback yet' : `Average ${avg} / 5`}</h2><p class="muted small">${plural(rows.length, 'student')}</p>
      <div class="face-bars">${counts.map((c) => `<div class="face-bar"><span class="emoji" aria-hidden="true">${c.face}</span><span class="label">${esc(c.label)}</span>
        <div class="track"><div class="fill" style="width:${(c.n / max) * 100}%"></div></div><b class="num">${c.n}</b></div>`).join('')}</div></section>
      <section class="card"><h2>Comments</h2><div class="comments">${rows.filter((f) => f.text).map((f) => `<blockquote><p>${esc(f.text)}</p><footer class="small muted">${d.ratings.find((r) => r.value === f.rating)?.face || ''} ${esc(f.student.name)} · Grade ${f.student.grade} · ${esc(f.student.school)} · ${esc(when(f.at))}</footer></blockquote>`).join('') || '<p class="muted">No comments yet.</p>'}</div></section></div>`;
}

// ---------------------------------------------------------------- setup
function setup() {
  const d = st.data, counts = d.bank;
  body().innerHTML = `<div class="two">
    <section class="card stack"><h2>Schools</h2>
      <ul style="margin:0;padding-left:20px">${d.schools.map((s) => `<li class="row between"><span>${esc(s.name)}</span><button class="btn quiet sm" data-admin="del-school" data-id="${s.id}" aria-label="Remove ${esc(s.name)}">Remove</button></li>`).join('') || '<li class="muted">No schools yet — add one so students can register.</li>'}</ul>
      <form class="row" data-admin-form="school"><input type="text" name="name" placeholder="School name" aria-label="School name" required style="width:auto;flex:1"><button class="btn">Add school</button></form></section>

    <section class="card stack"><h2>Hosts (admins)</h2>
      <ul style="margin:0;padding-left:20px">${d.admins.map((a) => `<li class="row between"><span>${esc(a.email)}${a.fixed ? ' <span class="chip">default</span>' : ''}</span>
        ${a.fixed ? '' : `<button class="btn quiet sm" data-admin="del-admin" data-email="${esc(a.email)}">Remove</button>`}</li>`).join('')}</ul>
      <form class="row" data-admin-form="admin"><input type="email" name="email" placeholder="name@school.org" aria-label="Host email" required style="width:auto;flex:1"><button class="btn">Add host</button></form>
      <p class="small muted" style="margin:0">Hosts sign in with Google at <b>/#/admin</b>. Players never sign in.</p></section>

    <section class="card stack"><h2>Timing</h2>
      <p class="small muted" style="margin:0">For students who haven’t started yet. Each student starts a round’s clock with “Start Round” after its instructions and practice question; if they don’t, it starts by itself after the time below. For someone already playing use <b>Add time</b> / <b>End now</b>, or <b>Live control → Timing…</b>.</p>
      <form data-admin-form="timing" class="stack">
        ${[1, 2, 3].map((r) => { const n = d.students.filter((x) => ['running', 'paused'].includes(x.status) && x.phase?.type === 'round' && x.phase.round === r).length;
          return `<div class="row between"><label for="m-${r}" style="flex:1">Round ${r} · ${esc(ctx.cfg.rounds[r].name)}<div class="small muted" style="font-weight:400">${n} playing now</div></label>
            <input id="m-${r}" name="m${r}" type="number" min="1" max="30" value="${d.roundMinutes[r]}" style="width:5.5em" aria-label="Minutes for round ${r}">
            <span class="muted small">min</span>
            <button type="button" class="btn ghost sm" data-admin="round-time" data-round="${r}" data-action="extend">Add time</button>
            <button type="button" class="btn ghost sm" data-admin="round-time" data-round="${r}" data-action="end">End now</button></div>`; }).join('')}
        <div class="row between"><label for="s-brief" style="flex:1">Instructions + practice before each round, at most<div class="small muted" style="font-weight:400">then the round starts by itself</div></label>
          <input id="s-brief" name="s_brief" type="number" min="${d.practiceRange.min / 60}" max="${d.practiceRange.max / 60}" value="${Math.round(d.phaseSeconds.brief / 60)}" style="width:5.5em"><span class="muted small">min</span></div>
        <div class="row between"><label for="s-finish" style="flex:1">Finish screen</label><input id="s-finish" name="s_finish" type="number" min="5" max="600" value="${d.phaseSeconds.finish}" style="width:5.5em"><span class="muted small">sec</span></div>
        <div><button class="btn">Save timing</button></div></form></section>

    <section class="card stack"><h2>Question bank by grade</h2>
      <p class="small muted" style="margin:0">Each grade gets only its own band’s questions: Grades 3–4, 5–6 and 7–8. Only Active questions are used, always the latest version. Round 2 step 3 is a choice for Grades 3–4 and a written prompt for Grades 5–8. Round 3 is pictures only.${d.bankName ? ` Bank: <b>${esc(d.bankName)}</b>.` : ''}</p>
      ${counts ? `<div class="table-wrap"><table class="t"><thead><tr><th>Band</th><th class="num">R1 quick</th><th class="num">R1 boss</th><th class="num">R2 cases</th><th class="num">R3 pictures</th><th>Ready?</th><th></th></tr></thead>
        <tbody>${ctx.cfg.bands.map((x) => { const c = counts[x.id]; const p = d.bandProblems[x.id]; return `<tr><td style="white-space:nowrap">${x.label}</td><td class="num">${c.blitz}</td><td class="num">${c.boss}</td><td class="num">${c.cases}</td><td class="num">${c.targets}</td>
          <td>${p.length ? `<span class="chip bad" title="${esc(p.join(', '))}">Not playable</span>` : '<span class="chip ok">Ready</span>'}</td>
          <td><button type="button" class="btn ghost sm" data-admin="bank-view" data-band="${x.id}">View questions</button></td></tr>`; }).join('')}</tbody></table></div>`
        : '<p class="note bad">The question bank could not be loaded.</p>'}</section>
  </div>`;
}

async function bankView(band) {
  const d = await api(`/api/admin/bank/${band}`);
  const table = (title, rows, cols) => `<h3 style="margin-top:16px">${title} <span class="chip">${rows.length}</span></h3><div class="table-wrap"><table class="t"><thead><tr>${cols.map((c) => `<th>${c[0]}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td class="small">${esc(c[1](r))}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${cols.length}" class="muted">None.</td></tr>`}</tbody></table></div>`;
  await dialog({ title: `Questions for ${bandLabel(band)}`, wide: true,
    body: `<p class="muted small">Students in these grades only ever get questions from this list. Each session draws a set from it (Round 1: 8 questions + a boss; Round 2: one case; Round 3: one picture).</p>
      ${table('Round 1 · quick questions', d.blitz, [['ID', (r) => r.id], ['Difficulty', (r) => r.difficulty], ['Skill', (r) => r.skill], ['Question', (r) => r.text]])}
      ${table('Round 1 · final boss', d.boss, [['ID', (r) => r.id], ['Difficulty', (r) => r.difficulty], ['Task', (r) => r.text]])}
      ${table('Round 2 · cases', d.cases, [['ID', (r) => r.id], ['Difficulty', (r) => r.difficulty], ['Case', (r) => r.text], ['Step 3', (r) => r.fix], ['Ready', (r) => (r.ready ? 'Yes' : 'Missing parts')]])}
      ${table('Round 3 · pictures', d.targets, [['ID', (r) => r.id], ['Difficulty', (r) => r.difficulty], ['Picture', (r) => r.text], ['Two reasons?', (r) => (r.reasons ? 'Yes' : 'No')]])}`,
    actions: [{ label: 'Close', value: 'close' }] });
}

// ---------------------------------------------------------------- events (clicks, filters, forms)
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-admin]');
  if (!el || !root?.isConnected) return;
  const act = el.dataset.admin;
  try {
    if (act === 'gate') return toggleGate(el.dataset.open === 'true');
    if (act === 'control') return runControl(el.dataset.action);
    if (act === 'select') { el.checked ? st.selected.add(el.value) : st.selected.delete(el.value); return liveTable(); }
    if (act === 'select-all') { filtered().forEach((s) => (el.checked ? st.selected.add(s.id) : st.selected.delete(s.id))); return liveTable(); }
    if (act === 'detail') return detail(el.dataset.id);
    if (act === 'bank-view') return bankView(el.dataset.band);
    if (act === 'del-student') {
      if (await dialog({ title: `Remove ${el.dataset.name}?`, body: '<p>This removes a registration that hasn’t played (for example a duplicate or a typo). It can’t be undone.</p>', actions: [{ label: 'Cancel', value: 'no', kind: 'ghost' }, { label: 'Remove', value: 'yes', kind: 'danger' }] }) !== 'yes') return;
      await api(`/api/admin/students/${el.dataset.id}`, null, 'DELETE'); toast('Removed.'); return renderAdmin(root, 'students', ctx);
    }
    if (act === 'save-scores') {
      const block = el.closest('[data-score-block]');
      const parts = Object.fromEntries($$('[data-part]', block).map((i) => [i.dataset.part, i.value]));
      await api('/api/admin/scores', { attemptId: block.dataset.attempt, round: Number(el.dataset.round), parts });
      toast(`Round ${el.dataset.round} scores saved.`);
      $('#dlg').close();
      return detail(el.dataset.student);
    }
    if (act === 'reattempt') {
      const round = Number(el.dataset.round) || 0;
      await api('/api/admin/reattempt', { studentId: el.dataset.id, round });
      toast(`${round ? `Round ${round}` : 'Whole-test'} reattempt enabled — the student can rejoin the lobby.`);
      $('#dlg').close();
      return;
    }
    if (act === 'bulk-reattempt') return await bulkReattempt();
    if (act === 'logout') return await logoutDialog(targets());
    if (act === 'logout-one') {
      return await logoutDialog(st.data.students.filter((x) => x.id === el.dataset.id));
    }
    if (act === 'round-time') {
      const round = el.dataset.round; // set when clicked from Setup: everyone, that round
      return round ? timeDialog({ target: round, action: el.dataset.action }) : timeDialog({ ids: targets().map((x) => x.id), scope: `${plural(targets().length, 'student')} in this selection` });
    }
    if (act === 'card-edit') return cardEditor(el.dataset.id);
    if (act === 'card-approve') { await api('/api/admin/scorecards/approve', { attemptIds: [el.dataset.id], approved: el.dataset.on === 'true' }); toast(el.dataset.on === 'true' ? 'Approved — the student can see it now.' : 'Hidden from the student.'); return renderAdmin(root, 'cards', ctx); }
    if (act === 'cards-approve-all') {
      const ids = st.cardRows.filter((c) => cardState(c).ready).map((c) => c.attemptId);
      if (await dialog({ title: `Approve ${plural(ids.length, 'card')}?`, body: '<p>Every shown card whose marking is complete becomes visible to its student.</p>', actions: [{ label: 'Cancel', value: 'no', kind: 'ghost' }, { label: 'Approve', value: 'yes' }] }) !== 'yes') return;
      const r = await api('/api/admin/scorecards/approve', { attemptIds: ids });
      toast(`${r.done} approved.`);
      return renderAdmin(root, 'cards', ctx);
    }
    if (act === 'cards-send-all') {
      const ids = st.cardRows.filter((c) => c.approved).map((c) => c.attemptId);
      if (await dialog({ title: 'Email the shown score cards?', body: `<p>Each approved card in this list (${ids.length}) is emailed as a PDF to the email given at registration. Cards already sent and unchanged are skipped; students without an email are listed so you can download theirs.</p>`, actions: [{ label: 'Cancel', value: 'no', kind: 'ghost' }, { label: 'Send emails', value: 'yes' }] }) !== 'yes') return;
      el.disabled = true; el.textContent = 'Sending…';
      await sendReport(await api('/api/admin/scorecards/send', { attemptIds: ids }));
      return renderAdmin(root, 'cards', ctx);
    }
    if (act === 'card-send') { el.disabled = true; await sendReport(await api('/api/admin/scorecards/send', { attemptIds: [el.dataset.id], resend: true })); return renderAdmin(root, 'cards', ctx); }
    if (act === 'cards-test') { el.disabled = true; const r = await api('/api/admin/scorecards/test-email', {}); toast(`Sample sent to ${r.to}.`); el.disabled = false; return; }
    if (act === 'del-done') { await api(`/api/admin/deletions/${el.dataset.id}`, {}); toast('Marked as done.'); return renderAdmin(root, 'requests', ctx); }
    if (act === 'decide') return await decide(el.dataset.id, el.dataset.approve === 'true', el.dataset.name);
    if (act === 'lb-scope') { await api('/api/admin/leaderboard-scope', { all: el.dataset.all === 'true' }); await refresh(); toast(el.dataset.all === 'true' ? 'Students now see every school in their band.' : 'Students now see only their own school.'); return leaderboard(); }
    if (act === 'lb-band') { st.lbBand = el.dataset.band; return leaderboard(); }
    if (act === 'publish') { await api('/api/admin/publish', { final: el.dataset.final === 'true' }); await refresh(); return leaderboard(); }
    if (act === 'del-school') { await api(`/api/admin/schools/${el.dataset.id}`, null, 'DELETE'); return renderAdmin(root, 'setup', ctx); }
    if (act === 'del-admin') { await api(`/api/admin/admins/${encodeURIComponent(el.dataset.email)}`, null, 'DELETE'); return renderAdmin(root, 'setup', ctx); }
  } catch (err) { toast(err.message); el.disabled = false; }
});

document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-filter]');
  if (el) {
    const k = el.dataset.filter;
    if (k === 'schools') st.filters.schools = $$('[data-filter="schools"]:checked').map((x) => x.value);
    else st.filters[k] = el.value;
    st.selected.clear();
    liveTable();
    return;
  }
  const s = e.target.closest('[data-sf]');
  if (s) { sf[s.dataset.sf] = s.value; const pos = s.selectionStart; students(); const again = $(`[data-sf="${s.dataset.sf}"]`); again?.focus(); if (again?.setSelectionRange && pos != null) again.setSelectionRange(pos, pos); }
});

document.addEventListener('change', (e) => {
  const k = e.target.dataset.adminChange;
  if (e.target.dataset.ff) { ff[e.target.dataset.ff] = e.target.value; feedback(); return; }
  if (k === 'lb-school') { st.lbSchool = e.target.value; leaderboard(); }
  if (k === 'rep-school') $('#rep-one').href = `/api/admin/export.xlsx?school=${encodeURIComponent(e.target.value)}`;
  if (k === 'cards-auto') api('/api/admin/scorecards/auto-send', { on: e.target.checked }).then(() => toast(e.target.checked ? 'Cards will be emailed as soon as you approve them.' : 'Automatic emailing is off.')).catch((err) => toast(err.message));
  if (k === 'cards-filter') { cf[e.target.dataset.k] = e.target.value; cards(); }
  if (k === 'lb-run') { st.lbRun = e.target.value; leaderboard(); }
});

document.addEventListener('submit', async (e) => {
  const kind = e.target.dataset.adminForm;
  if (!kind) return;
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  try {
    if (kind === 'timing') await api('/api/admin/timing', { minutes: { 1: f.m1, 2: f.m2, 3: f.m3 }, seconds: { brief: Number(f.s_brief) * 60, finish: f.s_finish } });
    if (kind === 'school') await api('/api/admin/schools', f);
    if (kind === 'admin') await api('/api/admin/admins', f);
    toast('Saved.');
    renderAdmin(root, 'setup', ctx);
  } catch (err) { toast(err.message); }
});
