// Admin dashboard: live control, leaderboard, analytics and setup.
import { api, esc, dialog, toast, fmt, leaderboardHTML, $, $$ } from '/app.js';

const TABS = [['live', 'Live control'], ['requests', 'Reattempts'], ['cards', 'Score cards'], ['leaderboard', 'Leaderboard'], ['analytics', 'Analytics'], ['setup', 'Setup']];
const st = { filters: { schools: [], band: '', grade: '', status: '', q: '' }, selected: new Set(), data: null, lbBand: 'G3-4', lbSchool: '' };
let timer, ctx, root;
window.addEventListener('hashchange', () => clearInterval(timer));

export async function renderAdmin(main, tab, c) {
  clearInterval(timer);
  ctx = c;
  root = main;
  if (!TABS.some(([t]) => t === tab)) tab = 'live';
  main.innerHTML = `<div class="wrap wide">
    <nav class="admin-tabs" aria-label="Dashboard sections">${TABS.map(([t, l]) => `<a href="#/admin/${t}" id="tab-${t}" ${t === tab ? 'aria-current="page"' : ''}>${l}</a>`).join('')}</nav>
    <div id="admin-body"><p class="muted">Loading…</p></div></div>`;
  main.focus({ preventScroll: true });
  try {
    st.data = await api('/api/admin/overview');
    const reqN = (st.data.pendingRequests || 0) + (st.data.pendingDeletions || 0);
    if (reqN) $('#tab-requests').textContent = `Reattempts (${reqN})`;
    if (st.data.pendingLocks) $('#tab-live').textContent = `Live control (${st.data.pendingLocks} waiting)`;
    ({ live, requests, cards, leaderboard, analytics, setup })[tab]();
  } catch (err) { $('#admin-body').innerHTML = `<p class="note bad">${esc(err.message)}</p>`; }
}
const body = () => $('#admin-body');
const bandLabel = (id) => ctx.cfg.bands.find((b) => b.id === id)?.label || id;
const schoolName = (id) => st.data.schools.find((s) => s.id === id)?.name || '—';

// ---------------------------------------------------------------- live control
function live() {
  const d = st.data, f = st.filters;
  const problems = Object.entries(d.bandProblems).filter(([, p]) => p.length);
  body().innerHTML = `
    <div class="row between" style="margin-bottom:14px"><div><h1 style="margin:0">${esc(d.event.name)}</h1>
      <span class="muted">Start, pause or stop the test for any group — a whole set of schools, one school, a grade, a band or single students.</span></div></div>
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
        ${[['waiting', 'In lobby'], ['away', 'Not in lobby'], ['running', 'Live'], ['paused', 'Paused'], ['finished', 'Finished'], ['stopped', 'Stopped'], ['not joined', 'Not joined']].map(([v, l]) => `<option value="${v}" ${f.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field grow"><label for="f-q">Search</label><input id="f-q" type="search" data-filter="q" placeholder="Name, code or email" value="${esc(f.q)}"></div>
    </div>
    <div class="controls" role="toolbar" aria-label="Test controls">
      <span id="scope" class="grow"></span>
      <button class="btn" data-admin="control" data-action="start">Start</button>
      <button class="btn ghost" data-admin="control" data-action="pause">Pause</button>
      <button class="btn ghost" data-admin="control" data-action="resume">Resume</button>
      <button class="btn danger" data-admin="control" data-action="stop">Stop</button>
      <button class="btn ghost" data-admin="bulk-reattempt">Reattempt…</button>
      <button class="btn ghost" data-admin="round-time">Timing…</button>
    </div>
    <div id="live-table"></div>`;
  liveTable();
  timer = setInterval(async () => {
    try { st.data = await api('/api/admin/overview'); liveTable(); } catch { /* keep last view */ }
  }, 2000);
}

function filtered() {
  const f = st.filters, q = f.q.trim().toLowerCase();
  return st.data.students.filter((s) => (!f.schools.length || f.schools.includes(s.schoolId)) && (!f.band || s.band === f.band)
    && (!f.grade || String(s.grade) === String(f.grade)) && (!f.status || s.status === f.status)
    && (!q || `${s.name} ${s.code} ${s.email}`.toLowerCase().includes(q)));
}
const targets = () => { const rows = filtered(); const sel = rows.filter((s) => st.selected.has(s.id)); return sel.length ? sel : rows; };

function statusCell(s) {
  const ph = s.phase;
  const map = { 'not joined': '<span class="chip">Not joined</span>', waiting: '<span class="chip brand">In lobby</span>', away: '<span class="chip" title="Picked, but their lobby screen isn’t open">Not in lobby</span>',
    paused: '<span class="chip warn">Paused</span>', finished: '<span class="chip ok">Finished</span>', stopped: '<span class="chip ok">Stopped</span>' };
  if (s.status === 'running' && ph) return `<span class="chip warn">Live</span> <span class="small">${esc(ph.title || '')} · ${fmt(ph.remainingMs || 0)}</span>`;
  if (s.status === 'paused' && s.lock) return `<span class="chip bad">Left test window${s.lock.count > 1 ? ` ×${s.lock.count}` : ''}</span> ${s.lock.requested ? `<span class="chip warn">Asked to continue</span>` : ''}<div class="small">${esc(s.lock.note || '')} · press Resume to let them back in</div>`;
  if (s.status === 'paused' && ph) return `${map.paused} <span class="small">${esc(ph.title || '')} · ${fmt(ph.remainingMs || 0)} left</span>`;
  const redo = s.redoRound ? ` <span class="small">Round ${s.redoRound} replay</span>` : '';
  return (map[s.status] || esc(s.status)) + redo;
}
const sc = (x) => (x ? (x.pending ? '<span title="AI marking in progress">…</span>' : x.total) : '—');

function liveTable() {
  const rows = filtered(), sel = rows.filter((s) => st.selected.has(s.id));
  $('#scope').innerHTML = sel.length ? `Applies to <b>${sel.length} selected</b> student${sel.length > 1 ? 's' : ''}`
    : `Applies to <b>all ${rows.length} shown</b>${rows.length !== st.data.students.length ? ` (of ${st.data.students.length})` : ''}`;
  $('#live-table').innerHTML = `<div class="table-wrap"><table class="t"><caption class="sr-only">Students</caption><thead><tr>
      <th><input type="checkbox" data-admin="select-all" aria-label="Select all shown" ${sel.length && sel.length === rows.length ? 'checked' : ''}></th>
      <th>Code</th><th>Name</th><th>School</th><th class="num">Grade</th><th>Status</th><th class="num">R1</th><th class="num">R2</th><th class="num">R3</th><th class="num">Total</th><th></th></tr></thead>
    <tbody>${rows.length ? rows.map((s) => `<tr>
      <td><input type="checkbox" data-admin="select" value="${s.id}" ${st.selected.has(s.id) ? 'checked' : ''} aria-label="Select ${esc(s.name)}"></td>
      <td class="small"><b>${esc(s.code)}</b></td><td>${esc(s.name)}${s.reattempts ? ` <span class="chip" title="Reattempts">↻${s.reattempts}</span>` : ''}<div class="muted small">${esc(s.email)}</div></td>
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
    ${last ? radio('same', `Same questions as run ${last.number}`, `${last.students} student${last.students === 1 ? '' : 's'}${last.live ? ' playing now' : ''} · started ${new Date(last.startedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}. Fair to compare with them; grade bands with no earlier set get a fresh one.`) : ''}</fieldset>`;
}

async function runControl(action) {
  const list = targets();
  const verbs = { start: 'Start the test for', pause: 'Pause', resume: 'Resume', stop: 'Stop the test for' };
  const notes = { start: 'Only students whose lobby screen is open right now will start. Everyone starts with the full schedule; students replaying one round play only that round (“Same questions” gives them the questions they had before).',
    pause: 'Clocks freeze for live students until you resume.', resume: 'Clocks continue from where they were paused.',
    stop: 'Open rounds are submitted with their saved answers and the test ends. This can’t be undone (use “Enable reattempt” to let a student play again).' };
  if (!list.length) { toast('No students in this selection.'); return; }
  const ok = await dialog({ title: `${verbs[action]} ${list.length} student${list.length > 1 ? 's' : ''}?`,
    body: `<p>${notes[action]}</p>${action === 'start' ? questionChoice() : ''}<p class="small muted">${list.slice(0, 8).map((s) => esc(s.name)).join(', ')}${list.length > 8 ? ` and ${list.length - 8} more` : ''}</p>`,
    actions: [{ label: 'Cancel', value: 'no', kind: 'ghost' }, { label: action[0].toUpperCase() + action.slice(1), value: 'yes', kind: action === 'stop' ? 'danger' : '' }] });
  if (ok !== 'yes') return;
  try {
    const r = await api('/api/admin/control', { action, studentIds: list.map((s) => s.id), questions: action === 'start' ? $('input[name=qs]:checked')?.value : undefined });
    toast(`${r.done} updated${r.skipped ? `, ${r.skipped} skipped (not in the right state)` : ''}.`);
    if (r.errors.length) await dialog({ title: 'Some students could not start', body: `<p class="note bad">${r.errors.map(esc).join('<br>')}</p>`, actions: [{ label: 'OK', value: 'ok' }] });
    st.data = await api('/api/admin/overview');
    liveTable();
  } catch (err) { toast(err.message); }
}

// Reattempt for the selected students (or everyone shown): the whole test, or one round only.
async function bulkReattempt() {
  const list = targets();
  if (!list.length) { toast('No students in this selection.'); return; }
  const ended = list.filter((s) => ['finished', 'stopped'].includes(s.status)).length;
  const ok = await dialog({ title: `Reattempt for ${list.length} student${list.length > 1 ? 's' : ''}`,
    body: `<fieldset class="stack" style="border:0;padding:0;margin:0"><legend style="font-weight:700;margin-bottom:8px">What should they replay?</legend>
      <label class="check"><input type="radio" name="rr" value="0" checked><span>The whole test<br><span class="muted small" style="font-weight:400">Their current attempt is archived (scores kept) and they play all three rounds again.</span></span></label>
      ${[1, 2, 3].map((r) => `<label class="check"><input type="radio" name="rr" value="${r}"><span>Only Round ${r} · ${esc(ctx.cfg.rounds[r].name)}<br><span class="muted small" style="font-weight:400">Other rounds keep their answers and scores.</span></span></label>`).join('')}</fieldset>
      <p class="small muted">${ended} of ${list.length} have finished their test. A single round can be reopened only for students whose test has ended; nobody who is playing right now is changed. Afterwards they go back to the lobby and play when you press Start.</p>
      <p class="small muted">${list.slice(0, 8).map((s) => esc(s.name)).join(', ')}${list.length > 8 ? ` and ${list.length - 8} more` : ''}</p>`,
    actions: [{ label: 'Cancel', value: 'no', kind: 'ghost' }, { label: 'Enable reattempt', value: 'yes' }] });
  if (ok !== 'yes') return;
  const round = Number($('input[name=rr]:checked')?.value) || 0;
  const r = await api('/api/admin/reattempts', { studentIds: list.map((s) => s.id), round });
  toast(`${round ? `Round ${round}` : 'Whole-test'} reattempt enabled for ${r.done} student${r.done === 1 ? '' : 's'}${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}.`);
  if (r.skipped.length) await dialog({ title: 'Some students were skipped', body: `<ul class="small">${r.skipped.slice(0, 30).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>${r.skipped.length > 30 ? `<p class="small muted">and ${r.skipped.length - 30} more</p>` : ''}`, actions: [{ label: 'OK', value: 'ok' }] });
  st.data = await api('/api/admin/overview');
  liveTable();
}

// ---------------------------------------------------------------- student detail
async function detail(id) {
  const d = await api(`/api/admin/students/${id}`);
  const s = d.student;
  const attempt = (a, open) => {
    const rounds = [1, 2, 3].map((r) => {
      const score = a.scores[r];
      const rows = a.answers.filter((x) => x.round === r);
      if (!rows.length) return '';
      const parts = ctx.cfg.scoreParts[r];
      return `<section style="margin-top:16px"><h3>${ctx.cfg.rounds[r].icon} Round ${r} · ${esc(ctx.cfg.rounds[r].name)}
          ${score ? `<span class="chip ${score.pending ? 'warn' : 'ok'}">${score.pending ? 'AI marking…' : `${Object.values(score.parts).reduce((t, p) => t + (p.points || 0), 0)}/20`}</span>` : '<span class="chip">Not submitted</span>'}
          ${a.lifelines[r]?.length ? `<span class="chip">Lifeline: ${esc(a.lifelines[r].join(', '))}</span>` : ''}</h3>
        <div class="table-wrap"><table class="t"><thead><tr><th>ID</th><th>Question</th><th>Student answer</th><th>Correct / reference</th><th class="num">Pts</th><th>Marked</th></tr></thead><tbody>
        ${rows.map((x) => `<tr><td class="small">${esc(x.id)}${x.lifeline ? ' <span class="chip">lifeline</span>' : ''}</td><td class="small">${esc(x.question)}</td><td>${esc(x.answer)}</td>
          <td class="small muted">${esc(x.correct)}</td><td class="num">${x.points ?? '—'}${x.max ? `/${x.max}` : ''}</td>
          <td class="small" title="${esc(x.note)}">${esc(x.by)}${x.note ? ` <span class="muted">${esc(x.note.slice(0, 120))}</span>` : ''}</td></tr>`).join('')}
        </tbody></table></div>
        ${score && !a.archived ? `<div class="row" style="margin-top:10px" data-score-block="${r}" data-attempt="${a.id}">
          ${parts.map((p) => `<label class="field small" style="font-weight:700">${esc(p.label)} /${p.max}
            <input class="editable-score" type="number" min="0" max="${p.max}" step="1" data-part="${p.key}" value="${score.parts[p.key]?.points ?? ''}"></label>`).join('')}
          <button type="button" class="btn sm" data-admin="save-scores" data-round="${r}" data-student="${s.id}">Save Round ${r} scores</button></div>` : ''}
      </section>`;
    }).join('');
    const card = Object.keys(a.scores).length ? ` <button type="button" class="btn ghost sm" data-admin="card-edit" data-id="${a.id}">Score card</button>` : '';
    const head = `${esc(a.event)} · <span class="chip">${esc(a.status)}</span>${a.archived ? ' <span class="chip">Previous attempt</span>' : ''}${card}`;
    return a.archived ? `<details style="margin-top:16px"><summary>${head}</summary>${rounds}</details>` : `<div style="margin-top:8px">${head}${rounds || '<p class="muted">No rounds played yet.</p>'}</div>`;
  };
  await dialog({ title: `${s.name} · ${s.code}`, wide: true,
    body: `<p>Grade ${s.grade} (${bandLabel(s.band)}) · ${esc(s.school)} · <span class="muted">${esc(s.email)}</span>${s.phones?.length ? ` · ${s.phones.map(esc).join(', ')}` : ''}</p>
      <div class="row"><b>Enable reattempt:</b>
        <button type="button" class="btn ghost sm" data-admin="reattempt" data-id="${s.id}" data-round="0">Whole test</button>
        ${[1, 2, 3].map((r) => `<button type="button" class="btn ghost sm" data-admin="reattempt" data-id="${s.id}" data-round="${r}">Round ${r} only</button>`).join('')}</div>
      <p class="small muted">Whole test archives the current attempt (its scores are kept) and the student plays everything again. A single round keeps the other rounds’ answers and scores and replays only that round. Either way the student goes back to the lobby and starts when you press Start.</p>
      ${d.attempts.map((a, i) => attempt(a, i === 0)).join('') || '<p class="muted" style="margin-top:12px">This student hasn’t joined yet.</p>'}`,
    actions: [{ label: 'Close', value: 'close' }] });
}

// ---------------------------------------------------------------- reattempt requests
async function requests() {
  const [list, dels] = await Promise.all([api('/api/admin/requests'), api('/api/admin/deletions')]);
  const when = (t) => (t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const chip = (r) => ({ pending: '<span class="chip warn">Waiting</span>', approved: '<span class="chip ok">Approved</span>', rejected: '<span class="chip bad">Declined</span>' })[r.status];
  body().innerHTML = `<h1 style="margin:0 0 6px">Reattempt requests</h1>
    <p class="muted" style="margin-top:0">Students ask for another try after their test ends. Approving archives their previous attempt and puts them back in the lobby; declining shows them your message.</p>
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

// ---------------------------------------------------------------- timing (rounds, briefings, breaks)
async function timeDialog({ ids = null, scope = 'everyone playing', target = 'current', action = 'extend' } = {}) {
  const radio = (v, label) => `<label class="check"><input type="radio" name="rt-action" value="${v}" ${action === v ? 'checked' : ''}><span>${label}</span></label>`;
  const ok = await dialog({ title: 'Timing',
    body: `<p>Applies to <b>${esc(scope)}</b>. Students see the change within a second; their saved answers are never touched.</p>
      <div class="stack"><div class="field"><label for="rt-target">What to change</label><select id="rt-target">
        <option value="current" ${target === 'current' ? 'selected' : ''}>Whatever each student is on now (round, briefing or break)</option>
        ${[1, 2, 3].map((r) => `<option value="${r}" ${String(target) === String(r) ? 'selected' : ''}>Round ${r} · ${esc(ctx.cfg.rounds[r].name)}</option>`).join('')}</select></div>
      <div class="stack">${radio('extend', 'Add time')}${radio('end', 'End it now — a round’s answers so far are submitted, a briefing or break is skipped')}</div>
      <div class="row"><div class="field" style="flex:1"><label for="rt-amount">Time to add</label><input id="rt-amount" type="number" min="1" max="1800" value="2"></div>
        <div class="field"><label for="rt-unit">Unit</label><select id="rt-unit"><option value="60">minutes</option><option value="1">seconds</option></select></div></div></div>`,
    actions: [{ label: 'Cancel', value: 'no', kind: 'ghost' }, { label: 'Apply', value: 'yes' }] });
  if (ok !== 'yes') return;
  const act = $('input[name=rt-action]:checked').value, tg = $('#rt-target').value;
  if (act === 'end' && await dialog({ title: 'End it now?', body: '<p>Students are moved on straight away. This can’t be undone.</p>',
    actions: [{ label: 'Cancel', value: 'no', kind: 'ghost' }, { label: 'End now', value: 'yes', kind: 'danger' }] }) !== 'yes') return;
  const r = await api('/api/admin/phase-time', { action: act, target: tg, seconds: Number($('#rt-amount').value) * Number($('#rt-unit').value), studentIds: ids || undefined });
  toast(`${r.done} student${r.done === 1 ? '' : 's'} updated${r.skipped ? `, ${r.skipped} skipped (that part isn’t running or is already over for them)` : ''}.`);
  if (root?.isConnected) st.data = await api('/api/admin/overview');
}

// ---------------------------------------------------------------- score cards
const when = (t) => (t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');

async function cards() {
  const d = await api('/api/admin/scorecards'), rows = d.rows;
  const ready = rows.filter((r) => !r.archived && !r.approved && r.status !== 'pending').length;
  const unsent = rows.filter((r) => r.approved && (!r.emailedAt || r.changedSinceEmailed)).length;
  const statusChip = { pending: '<span class="chip warn">Marking…</span>', provisional: '<span class="chip">Provisional</span>', final: '<span class="chip ok">Final</span>' };
  body().innerHTML = `<h1 style="margin:0 0 6px">Score cards</h1>
    <p class="muted" style="margin-top:0">Made from each student’s saved answers. Edit anything, then approve — students see approved cards on their own screen, and approved cards can be emailed to the address saved from each student’s Google sign-in${d.emailReady ? ` (sent from ${esc(d.from)})` : ''}.</p>
    ${d.emailReady ? '' : '<p class="note bad small">Email isn’t set up. Add SMTP_USER and SMTP_PASS (an app password) to .env on the server.</p>'}
    <div class="controls" role="toolbar" aria-label="Score card actions">
      <button class="btn" data-admin="cards-approve-all" ${ready ? '' : 'disabled'}>Approve all ready (${ready})</button>
      <button class="btn" data-admin="cards-send-all" ${d.emailReady && unsent ? '' : 'disabled'}>Email approved cards (${unsent})</button>
      <a class="btn ghost" href="/api/admin/scorecards.zip" download>Download approved (ZIP)</a>
      <button class="btn ghost" data-admin="cards-test" ${d.emailReady ? '' : 'disabled'}>Send me a sample</button>
      <label class="check grow" style="justify-content:flex-end"><input type="checkbox" data-admin-change="cards-auto" ${d.autoSend ? 'checked' : ''} ${d.emailReady ? '' : 'disabled'}><span>Email automatically when a card is approved</span></label>
    </div>
    <div class="table-wrap"><table class="t"><thead><tr><th>Student</th><th>Sends to</th><th class="num">Total</th><th>Marks</th><th>Approved</th><th>Emailed</th><th></th></tr></thead><tbody>
    ${rows.length ? rows.map((r) => `<tr><td><b>${esc(r.name)}</b>${r.edited ? ' <span class="chip brand">Edited</span>' : ''}${r.archived ? ' <span class="chip">Earlier attempt</span>' : ''}
        <div class="muted small">${esc(r.code)} · Grade ${esc(r.grade)} · ${esc(r.school)}${r.run ? ` · Run ${r.run}` : ''}</div></td>
      <td class="small">${esc(r.email)}</td><td class="num"><b>${r.total}</b>/60</td><td>${statusChip[r.status]}</td>
      <td>${r.approved ? '<span class="chip ok">Approved</span>' : '<span class="chip">Not yet</span>'}</td>
      <td class="small">${r.emailedAt ? `<span class="chip ok">Sent</span> ${esc(when(r.emailedAt))}${r.changedSinceEmailed ? ' <span class="chip warn">Changed since</span>' : ''}` : '<span class="muted">—</span>'}</td>
      <td><div class="row" style="gap:6px">
        <button class="btn sm" data-admin="card-edit" data-id="${r.attemptId}">Edit</button>
        <a class="btn ghost sm" href="/api/admin/scorecard/${r.attemptId}" target="_blank" rel="noopener">View</a>
        <a class="btn ghost sm" href="/api/admin/scorecard/${r.attemptId}/pdf" download>PDF</a>
        <button class="btn ghost sm" data-admin="card-approve" data-id="${r.attemptId}" data-on="${!r.approved}" ${r.status === 'pending' && !r.approved ? 'disabled' : ''}>${r.approved ? 'Unapprove' : 'Approve'}</button>
        ${d.emailReady && r.approved ? `<button class="btn ghost sm" data-admin="card-send" data-id="${r.attemptId}">${r.emailedAt ? 'Resend' : 'Email'}</button>` : ''}</div></td></tr>`).join('')
      : '<tr><td colspan="7" class="muted center">No score cards yet — they appear once students have scored rounds from the current question bank.</td></tr>'}
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
        ${c.skills.map((s) => `<div class="row between" style="flex-wrap:nowrap"><label for="ce-${s.id}" style="flex:1;font-weight:400"><b>${esc(s.name)}</b>${s.edited ? ' <span class="chip brand">edited</span>' : ''}<div class="muted small">computed ${base.skills.find((k) => k.id === s.id).percent ?? '—'}${s.evidence ? ` · from ${s.evidence} task${s.evidence === 1 ? '' : 's'}` : ''}</div></label>
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

const sendReport = (r) => dialog({ title: 'Emails', body: `<p><b>${r.sent}</b> sent${r.skipped ? `, ${r.skipped} skipped (already sent or not approved)` : ''}${r.failed.length ? `, <b>${r.failed.length}</b> failed` : ''}.</p>
  ${r.failed.length ? `<p class="note bad small">${r.failed.map((f) => `${esc(f.name)} (${esc(f.to)}): ${esc(f.error)}`).join('<br>')}</p>` : ''}`, actions: [{ label: 'OK', value: 'ok' }] });

// ---------------------------------------------------------------- leaderboard
async function leaderboard() {
  const d = st.data;
  const lb = await api(`/api/leaderboard?band=${st.lbBand}&school=${st.lbSchool}${st.lbRun ? `&run=${st.lbRun}` : ''}`);
  body().innerHTML = `<div class="row between" style="margin-bottom:16px">
      <div class="seg" role="group" aria-label="Grade band">${ctx.cfg.bands.map((b) => `<button data-admin="lb-band" data-band="${b.id}" aria-pressed="${st.lbBand === b.id}">${b.label}</button>`).join('')}</div>
      <div class="row"><label for="lb-school" class="sr-only">School</label><select id="lb-school" data-admin-change="lb-school" style="width:auto">
        <option value="">All schools</option>${d.schools.map((s) => `<option value="${s.id}" ${st.lbSchool === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
        <label for="lb-run" class="sr-only">Run</label><select id="lb-run" data-admin-change="lb-run" style="width:auto">
          ${lb.runs.map((r) => `<option value="${r.id}" ${(st.lbRun || lb.run) === r.id ? 'selected' : ''}>Run ${r.number} · ${r.students} student${r.students === 1 ? '' : 's'}</option>`).join('')}<option value="all" ${(st.lbRun || lb.run) === 'all' ? 'selected' : ''}>All runs</option></select>
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
  const schools = st.data?.schools || (await api('/api/admin/overview')).schools;
  body().innerHTML = `<h1 style="margin:0 0 12px">Analytics · ${esc(a.event)}</h1>
    <section class="card paper" style="margin-bottom:20px"><h2 style="margin-bottom:4px">Download reports</h2>
      <p class="muted small" style="margin-top:0">Formatted Excel workbooks: an overview, results ranked by grade band, thinking skills, a score breakdown, question analysis, every answer and the student list.</p>
      <div class="row">
        <a class="btn" href="/api/admin/export.xlsx" download>All schools (Excel)</a>
        <span class="row" style="gap:8px"><label for="rep-school" class="sr-only">School</label><select id="rep-school" data-admin-change="rep-school" style="width:auto">
          ${schools.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('') || '<option value="">No schools yet</option>'}</select>
          <a class="btn ghost" id="rep-one" href="${schools.length ? `/api/admin/export.xlsx?school=${encodeURIComponent(schools[0].id)}` : '#'}" download ${schools.length ? '' : 'aria-disabled="true"'}>One school (Excel)</a></span>
        <a class="btn ghost" href="/api/admin/export-schools.zip" download ${schools.length ? '' : 'aria-disabled="true"'}>Every school, one file each (ZIP)</a>
      </div></section>
    <div class="kpis">${[['Registered students', a.kpis.registered], ['In lobby', a.kpis.lobby], ['Playing now', a.kpis.live], ['Finished', a.kpis.finished], ['Average total', a.kpis.avgTotal == null ? '—' : `${a.kpis.avgTotal}/60`]]
      .map(([l, v]) => `<div class="kpi"><div class="muted small">${l}</div><div class="big">${v}</div></div>`).join('')}</div>
    <div class="two">
      <section class="card"><h2>Average score by round</h2><p class="muted small">Out of 20 points each.</p>${hbars(a.rounds.map((r) => ({ label: r.name, value: r.avg })), 20, '/20')}</section>
      <section class="card"><h2>Score distribution</h2><p class="muted small">Finished players by total score (out of 60).</p>
        <div class="vbars" role="img" aria-label="Score distribution">${a.distribution.map((d) => `<div class="vbar" tabindex="0" data-tip="${d.label}: ${d.count} player${d.count === 1 ? '' : 's'}"><div class="fill" style="height:${(d.count / maxDist) * 100}%"></div></div>`).join('')}</div>
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
    <section class="card" style="margin-top:20px"><h2>Round 1 item analysis</h2><div class="table-wrap"><table class="t"><thead><tr><th>Band</th><th>Question</th><th>Skill</th><th>Difficulty</th><th class="num">Attempts</th><th class="num">% correct</th><th class="num">Lifelines</th></tr></thead>
      <tbody>${a.items.map((i) => `<tr><td>${bandLabel(i.band)}</td><td class="small">${esc(i.id)}</td><td>${esc(i.skill)}</td><td>${esc(i.difficulty)}</td><td class="num">${i.attempts}</td><td class="num">${i.pctCorrect ?? '—'}</td><td class="num">${i.lifelines}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No rounds played yet.</td></tr>'}</tbody></table></div></section>`;
}

// ---------------------------------------------------------------- setup
function setup() {
  const d = st.data, counts = d.bank;
  body().innerHTML = `<div class="two">
    <section class="card stack"><h2>Schools</h2>
      <ul style="margin:0;padding-left:20px">${d.schools.map((s) => `<li class="row between"><span>${esc(s.name)}</span><button class="btn quiet sm" data-admin="del-school" data-id="${s.id}" aria-label="Remove ${esc(s.name)}">Remove</button></li>`).join('') || '<li class="muted">No schools yet — add one so students can register.</li>'}</ul>
      <form class="row" data-admin-form="school"><input type="text" name="name" placeholder="School name" aria-label="School name" required style="width:auto;flex:1"><button class="btn">Add school</button></form></section>

    <section class="card stack"><h2>Admins</h2>
      <ul style="margin:0;padding-left:20px">${d.admins.map((a) => `<li class="row between"><span>${esc(a.email)}${a.fixed ? ' <span class="chip">default</span>' : ''}</span>
        ${a.fixed ? '' : `<button class="btn quiet sm" data-admin="del-admin" data-email="${esc(a.email)}">Remove</button>`}</li>`).join('')}</ul>
      <form class="row" data-admin-form="admin"><input type="email" name="email" placeholder="name@school.org" aria-label="Admin email" required style="width:auto;flex:1"><button class="btn">Add admin</button></form></section>

    <section class="card stack"><h2>Timing</h2>
      <p class="small muted" style="margin:0">Lengths for students who haven’t started yet (rounds are 8 minutes unless you change them). For something already running use <b>Add time</b> / <b>End now</b> here, or <b>Live control → Timing…</b> for a selection — it also reaches the “Round starts in…” and “Next up…” countdowns.</p>
      <form data-admin-form="timing" class="stack">
        ${[1, 2, 3].map((r) => { const n = d.students.filter((x) => ['running', 'paused'].includes(x.status) && x.phase?.type === 'round' && x.phase.round === r).length;
          return `<div class="row between"><label for="m-${r}" style="flex:1">Round ${r} · ${esc(ctx.cfg.rounds[r].name)}<div class="small muted" style="font-weight:400">${n} playing now</div></label>
            <input id="m-${r}" name="m${r}" type="number" min="1" max="30" value="${d.roundMinutes[r]}" style="width:5.5em" aria-label="Minutes for round ${r}">
            <span class="muted small">min</span>
            <button type="button" class="btn ghost sm" data-admin="round-time" data-round="${r}" data-action="extend">Add time</button>
            <button type="button" class="btn ghost sm" data-admin="round-time" data-round="${r}" data-action="end">End now</button></div>`; }).join('')}
        <h3 style="margin:6px 0 0">Between rounds <span class="muted small" style="font-weight:400">seconds</span></h3>
        ${[['welcome', 'Welcome / rules screen'], ['brief', 'Briefing — “Round 2 starts in…”'], ['transition', 'Break — “Next up…”'], ['finish', 'Finish screen']].map(([k, label]) => `<div class="row between">
          <label for="s-${k}" style="flex:1">${label}</label><input id="s-${k}" name="s_${k}" type="number" min="5" max="600" value="${d.phaseSeconds[k]}" style="width:5.5em"><span class="muted small">sec</span></div>`).join('')}
        <div><button class="btn">Save timing</button></div></form></section>

    <section class="card stack"><h2>Round 3 targets</h2>
      <p class="small muted" style="margin:0">The bank has text targets and picture targets. Each grade band gets one target, chosen to suit how the band did in the earlier rounds. Applies to sets drawn from now on.</p>
      <div class="field"><label for="r3mode">Kinds of target</label><select id="r3mode" data-admin-change="r3-mode">${d.r3Modes.map((m) => `<option value="${m.id}" ${d.r3Mode === m.id ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select></div></section>

    <section class="card stack"><h2>Question bank</h2>
      <p class="small muted" style="margin:0">Only Active questions are used, always the latest version. Sets already drawn never change.</p>
      ${counts ? `<div class="table-wrap"><table class="t"><thead><tr><th>Band</th><th class="num">R1 quick</th><th class="num">R1 boss</th><th class="num">R2 cases</th><th class="num">R3 targets</th><th>Ready?</th></tr></thead>
        <tbody>${ctx.cfg.bands.map((x) => { const c = counts[x.id]; const p = d.bandProblems[x.id]; return `<tr><td style="white-space:nowrap">${x.label}</td><td class="num">${c.blitz}</td><td class="num">${c.boss}</td><td class="num">${c.cases}</td><td class="num">${c.targets}${c.images ? ` <span class="muted small">(${c.images} picture)</span>` : ''}</td>
          <td>${p.length ? `<span class="chip bad" title="${esc(p.join(', '))}">Not playable</span>` : '<span class="chip ok">Ready</span>'}</td></tr>`; }).join('')}</tbody></table></div>`
        : '<p class="note bad">The question bank could not be loaded.</p>'}</section>
  </div>`;
}

// ---------------------------------------------------------------- events (clicks, filters, forms)
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-admin]');
  if (!el || !root?.isConnected) return;
  const act = el.dataset.admin;
  try {
    if (act === 'control') return runControl(el.dataset.action);
    if (act === 'select') { el.checked ? st.selected.add(el.value) : st.selected.delete(el.value); return liveTable(); }
    if (act === 'select-all') { filtered().forEach((s) => (el.checked ? st.selected.add(s.id) : st.selected.delete(s.id))); return liveTable(); }
    if (act === 'detail') return detail(el.dataset.id);
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
    if (act === 'round-time') {
      const round = el.dataset.round; // set when clicked from Setup: everyone, that round
      return round ? timeDialog({ target: round, action: el.dataset.action }) : timeDialog({ ids: targets().map((x) => x.id), scope: `${targets().length} student${targets().length === 1 ? '' : 's'} in this selection` });
    }
    if (act === 'card-edit') return cardEditor(el.dataset.id);
    if (act === 'card-approve') { await api('/api/admin/scorecards/approve', { attemptIds: [el.dataset.id], approved: el.dataset.on === 'true' }); toast(el.dataset.on === 'true' ? 'Approved — the student can see it now.' : 'Hidden from the student.'); return renderAdmin(root, 'cards', ctx); }
    if (act === 'cards-approve-all') {
      if (await dialog({ title: 'Approve all ready cards?', body: '<p>Every card whose marking is complete becomes visible to its student.</p>', actions: [{ label: 'Cancel', value: 'no', kind: 'ghost' }, { label: 'Approve all', value: 'yes' }] }) !== 'yes') return;
      const r = await api('/api/admin/scorecards/approve', { all: true });
      toast(`${r.done} approved.`);
      return renderAdmin(root, 'cards', ctx);
    }
    if (act === 'cards-send-all') {
      if (await dialog({ title: 'Email approved score cards?', body: '<p>Each approved card is emailed as a PDF to the address saved from that student’s Google sign-in. Cards already sent and unchanged are skipped.</p>', actions: [{ label: 'Cancel', value: 'no', kind: 'ghost' }, { label: 'Send emails', value: 'yes' }] }) !== 'yes') return;
      el.disabled = true; el.textContent = 'Sending…';
      await sendReport(await api('/api/admin/scorecards/send', {}));
      return renderAdmin(root, 'cards', ctx);
    }
    if (act === 'card-send') { el.disabled = true; await sendReport(await api('/api/admin/scorecards/send', { attemptIds: [el.dataset.id], resend: true })); return renderAdmin(root, 'cards', ctx); }
    if (act === 'cards-test') { el.disabled = true; const r = await api('/api/admin/scorecards/test-email', {}); toast(`Sample sent to ${r.to}.`); el.disabled = false; return; }
    if (act === 'del-done') { await api(`/api/admin/deletions/${el.dataset.id}`, {}); toast('Marked as done.'); return renderAdmin(root, 'requests', ctx); }
    if (act === 'decide') return await decide(el.dataset.id, el.dataset.approve === 'true', el.dataset.name);
    if (act === 'lb-scope') { await api('/api/admin/leaderboard-scope', { all: el.dataset.all === 'true' }); st.data = await api('/api/admin/overview'); toast(el.dataset.all === 'true' ? 'Students now see every school in their band.' : 'Students now see only their own school.'); return leaderboard(); }
    if (act === 'lb-band') { st.lbBand = el.dataset.band; return leaderboard(); }
    if (act === 'publish') { await api('/api/admin/publish', { final: el.dataset.final === 'true' }); st.data = await api('/api/admin/overview'); return leaderboard(); }
    if (act === 'del-school') { await api(`/api/admin/schools/${el.dataset.id}`, null, 'DELETE'); return renderAdmin(root, 'setup', ctx); }
    if (act === 'del-admin') { await api(`/api/admin/admins/${encodeURIComponent(el.dataset.email)}`, null, 'DELETE'); return renderAdmin(root, 'setup', ctx); }
  } catch (err) { toast(err.message); el.disabled = false; }
});

document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-filter]');
  if (!el) return;
  const k = el.dataset.filter;
  if (k === 'schools') st.filters.schools = $$('[data-filter="schools"]:checked').map((x) => x.value);
  else st.filters[k] = el.value;
  st.selected.clear();
  liveTable();
});

document.addEventListener('change', (e) => {
  if (e.target.dataset.adminChange === 'lb-school') { st.lbSchool = e.target.value; leaderboard(); }
  if (e.target.dataset.adminChange === 'rep-school') $('#rep-one').href = `/api/admin/export.xlsx?school=${encodeURIComponent(e.target.value)}`;
  if (e.target.dataset.adminChange === 'cards-auto') api('/api/admin/scorecards/auto-send', { on: e.target.checked }).then(() => toast(e.target.checked ? 'Cards will be emailed as soon as you approve them.' : 'Automatic emailing is off.')).catch((err) => toast(err.message));
  if (e.target.dataset.adminChange === 'lb-run') { st.lbRun = e.target.value; leaderboard(); }
  if (e.target.dataset.adminChange === 'r3-mode') api('/api/admin/r3-mode', { mode: e.target.value }).then(() => { toast('Saved.'); return api('/api/admin/overview'); }).then((o) => { st.data = o; }).catch((err) => toast(err.message));
});

document.addEventListener('submit', async (e) => {
  const kind = e.target.dataset.adminForm;
  if (!kind) return;
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  try {
    if (kind === 'timing') await api('/api/admin/timing', { minutes: { 1: f.m1, 2: f.m2, 3: f.m3 }, seconds: { welcome: f.s_welcome, brief: f.s_brief, transition: f.s_transition, finish: f.s_finish } });
    if (kind === 'school') await api('/api/admin/schools', f);
    if (kind === 'admin') await api('/api/admin/admins', f);
    toast('Saved.');
    renderAdmin(root, 'setup', ctx);
  } catch (err) { toast(err.message); }
});
