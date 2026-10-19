import * as G from './src/google.js';
const id = process.env.DATA_SHEET_ID;
const rows = (await G.valuesGet(id, [G.tabRange('Question Sets', 'A1:N80')]))[0];
console.log(JSON.stringify(rows[0]));
for (const r of rows.slice(1)) if (String(r[3]) === '3' || String(r[3]) === '3') {
  const txt = r.slice(10).join('');
  const m = /"target":\{[^}]{0,400}/.exec(txt);
  console.log(r[0], r[2], r[4], (/"imageId":"([^"]*)"/.exec(txt) || [])[1], (/"id":"(G\d+-R3[^"]*)"/.exec(txt) || [])[1], r[9]?.toString().slice(0, 40));
}
