// A stand-in for the parts of Google's APIs the backend uses (token, Sheets values/batchUpdate), for load tests only.
// It keeps the spreadsheet in memory (it survives app restarts, so restart tests work), adds Google-like latency and
// enforces Google's per-user quota (60 write requests a minute → HTTP 429), so the app's real store code is exercised.
//   node scripts/mock-google.mjs [port]      then start the app with GOOGLE_API_BASE=http://localhost:<port>
import http from 'node:http';

const PORT = Number(process.argv[2] || 4999);
const LATENCY = { read: [150, 600], write: [250, 1200] }; // ms, uniformly random
const QUOTA = { write: 60, read: 300 };                    // per rolling minute
const tabs = new Map(); // title → { id, rows: string[][], gridRows, cols }
let nextId = 100;
const stats = { writes: 0, reads: 0, throttled: 0, bytesIn: 0, cellsWritten: 0, maxBatchBytes: 0, startedAt: Date.now() };
const recent = { write: [], read: [] };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = ([a, b]) => a + Math.random() * (b - a);
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
function quota(kind) {
  const now = Date.now(), list = recent[kind];
  while (list.length && now - list[0] > 60000) list.shift();
  if (list.length >= QUOTA[kind]) { stats.throttled++; return false; }
  list.push(now);
  return true;
}
// "'Tab name'!A12" → { title, row: 12 }
function parseRange(r) {
  const m = /^'((?:[^']|'')*)'(?:!([A-Z]+)(\d+)(?::[A-Z]+\d+)?)?$/.exec(decodeURIComponent(r));
  if (!m) throw new Error(`bad range ${r}`);
  return { title: m[1].replace(/''/g, "'"), row: m[3] ? Number(m[3]) : null };
}
const raw = (req) => new Promise((resolve) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => { stats.bytesIn += s.length; resolve(s); }); });
const body = async (req) => { const s = await raw(req); try { return s ? JSON.parse(s) : {}; } catch { throw new Error('mock: body is not JSON'); } };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`), p = url.pathname;
  try {
    if (p === '/stats') return json(res, 200, { ...stats, tabs: Object.fromEntries([...tabs].map(([t, v]) => [t, v.rows.filter((r) => r?.some((c) => c !== '')).length])) });
    if (p === '/reset') { tabs.clear(); Object.assign(stats, { writes: 0, reads: 0, throttled: 0, bytesIn: 0, cellsWritten: 0, maxBatchBytes: 0, startedAt: Date.now() }); return json(res, 200, { ok: true }); }
    if (p === '/token') { await raw(req); return json(res, 200, { access_token: 'mock-token', expires_in: 3600 }); }
    const m = /^\/v4\/spreadsheets\/([^/:]+)(?::batchUpdate|\/values:(batchGet|batchUpdate|batchClear))?$/.exec(p);
    if (!m) return json(res, 404, { error: { message: `mock: no route ${p}` } });
    const op = p.endsWith(':batchUpdate') && !p.includes('/values') ? 'structure' : m[2] || 'info';
    const kind = ['info', 'batchGet'].includes(op) ? 'read' : 'write';
    if (!quota(kind)) return json(res, 429, { error: { code: 429, message: 'Quota exceeded for quota metric Write requests per minute per user', status: 'RESOURCE_EXHAUSTED' } });
    await sleep(rand(LATENCY[kind]));
    stats[kind === 'read' ? 'reads' : 'writes']++;
    if (op === 'info') {
      return json(res, 200, { properties: { title: 'Mock data sheet' }, sheets: [...tabs].map(([title, t]) => ({ properties: { sheetId: t.id, title, gridProperties: { rowCount: t.gridRows, columnCount: t.cols } } })) });
    }
    if (op === 'structure') {
      const { requests } = await body(req);
      for (const r of requests) {
        if (r.addSheet) { const pr = r.addSheet.properties; tabs.set(pr.title, { id: nextId++, rows: [], gridRows: pr.gridProperties?.rowCount || 1000, cols: pr.gridProperties?.columnCount || 26 }); }
        if (r.updateSheetProperties) { const pr = r.updateSheetProperties.properties; const [title, t] = [...tabs].find(([, v]) => v.id === pr.sheetId); tabs.delete(title); tabs.set(pr.title, t); }
        if (r.appendDimension) { const t = [...tabs.values()].find((v) => v.id === r.appendDimension.sheetId); if (r.appendDimension.dimension === 'ROWS') t.gridRows += r.appendDimension.length; else t.cols += r.appendDimension.length; }
      }
      return json(res, 200, { replies: [] });
    }
    if (op === 'batchGet') {
      const valueRanges = url.searchParams.getAll('ranges').map((r) => { const { title } = parseRange(r); const t = tabs.get(title); return { range: r, values: t ? t.rows.map((row) => row || []) : [] }; });
      return json(res, 200, { valueRanges });
    }
    if (op === 'batchUpdate') {
      const text = await raw(req);
      stats.maxBatchBytes = Math.max(stats.maxBatchBytes, text.length);
      for (const { range, values } of JSON.parse(text).data) {
        const { title, row } = parseRange(range), t = tabs.get(title);
        if (!t) return json(res, 400, { error: { message: `Unable to parse range: ${range}` } });
        values.forEach((v, i) => {
          const at = (row || 1) - 1 + i;
          if (at >= t.gridRows) throw new Error(`Range ${range} exceeds grid limits (${t.gridRows} rows)`);
          for (const cell of v) if (String(cell).length > 50000) throw new Error('Your input contains more than the maximum of 50000 characters in a single cell.');
          t.rows[at] = v.map((c) => (c === null || c === undefined ? '' : c));
          stats.cellsWritten += v.length;
        });
      }
      return json(res, 200, { totalUpdatedCells: 1 });
    }
    if (op === 'batchClear') {
      const { ranges } = await body(req);
      for (const r of ranges) { const t = tabs.get(parseRange(r).title); if (t) t.rows = []; }
      return json(res, 200, {});
    }
    json(res, 404, { error: { message: 'mock: unknown op' } });
  } catch (err) { json(res, 400, { error: { message: err.message } }); }
}).listen(PORT, () => console.log(`mock Google APIs on http://localhost:${PORT}`));
