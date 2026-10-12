// Google OAuth (SSO), Drive file download and Sheets access — plain REST, no SDK.
// Drive and Sheets are used by the backend only, with the refresh token from .env.
import { env, SCOPES_LOGIN, SCOPES_DRIVE } from './config.js';

const OAUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const redirectUri = () => `${env.baseUrl}/auth/callback`;
const JSON_HEADERS = { 'content-type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function authUrl(state, withDrive) {
  const q = new URLSearchParams({
    client_id: env.googleClientId, redirect_uri: redirectUri(), response_type: 'code', state,
    scope: (withDrive ? SCOPES_DRIVE : SCOPES_LOGIN).join(' '),
    prompt: withDrive ? 'consent' : 'select_account',
    ...(withDrive ? { access_type: 'offline', include_granted_scopes: 'true' } : {}),
  });
  return `${OAUTH}?${q}`;
}

// Exchanges the code and returns the verified identity (token comes straight from Google over TLS).
export async function exchangeCode(code) {
  const res = await fetch(TOKEN, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: env.googleClientId, client_secret: env.googleClientSecret,
      redirect_uri: redirectUri(), grant_type: 'authorization_code' }),
  });
  const tokens = await res.json();
  if (!res.ok) throw new Error(tokens.error_description || tokens.error || 'Google sign-in failed');
  const claims = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString());
  const issuerOk = ['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss);
  if (claims.aud !== env.googleClientId || !issuerOk || !claims.email_verified) throw new Error('Google account could not be verified');
  return { email: claims.email.toLowerCase(), name: claims.name || claims.email, picture: claims.picture || '', tokens };
}

// ---- Backend access token (from the refresh token in .env) ----
let cached = { token: '', exp: 0 };
export const driveConnected = () => Boolean(env.googleRefreshToken);

async function accessToken() {
  if (!driveConnected()) throw new Error('Google Drive is not connected. Run `npm run connect-google` on the server.');
  if (cached.token && Date.now() < cached.exp - 60000) return cached.token;
  const res = await fetch(TOKEN, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.googleClientId, client_secret: env.googleClientSecret,
      refresh_token: env.googleRefreshToken, grant_type: 'refresh_token' }),
  });
  const t = await res.json();
  if (!res.ok) throw new Error(`Google token refresh failed: ${t.error_description || t.error}`);
  cached = { token: t.access_token, exp: Date.now() + t.expires_in * 1000 };
  return cached.token;
}

// Retries rate limits (429) and Google hiccups (5xx) with a growing pause; anything else fails at once.
async function gfetch(url, opts = {}) {
  for (let attempt = 0; ; attempt++) {
    const token = await accessToken();
    const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), authorization: `Bearer ${token}` } });
    if (res.ok) return res;
    if ((res.status === 429 || res.status >= 500) && attempt < 4) { await sleep(1000 * 2 ** attempt); continue; }
    throw new Error(`Google API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

// Version info for a Drive file (null before Drive is connected) — lets big files be re-read only when they change.
export async function fileMeta(fileId) {
  if (!driveConnected()) return null;
  const m = await (await gfetch(`${DRIVE}/${fileId}?fields=version,modifiedTime&supportsAllDrives=true`)).json();
  return { version: m.version, modifiedTime: m.modifiedTime };
}

// Downloads the latest revision of a Drive file as .xlsx bytes. Before Drive is connected,
// falls back to the file's public export link.
export async function downloadSheetFile(fileId) {
  if (driveConnected()) {
    const meta = await (await gfetch(`${DRIVE}/${fileId}?fields=id,name,mimeType,modifiedTime,version&supportsAllDrives=true`)).json();
    const url = meta.mimeType === 'application/vnd.google-apps.spreadsheet'
      ? `${DRIVE}/${fileId}/export?mimeType=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
      : `${DRIVE}/${fileId}?alt=media&supportsAllDrives=true`;
    const buf = Buffer.from(await (await gfetch(url)).arrayBuffer());
    return { buffer: buf, meta: { name: meta.name, modifiedTime: meta.modifiedTime, version: meta.version, source: 'Drive API' } };
  }
  const res = await fetch(`https://docs.google.com/spreadsheets/d/${fileId}/export?format=xlsx`);
  if (!res.ok) throw new Error(`Could not download ${fileId} (${res.status}). Run \`npm run connect-google\` on the server.`);
  return { buffer: Buffer.from(await res.arrayBuffer()), meta: { name: fileId, source: 'public link' } };
}

// ---- Sheets (the app's data store) ----
export const tabRange = (tab, range = '') => `'${tab.replace(/'/g, "''")}'${range ? `!${range}` : ''}`;

export async function createSpreadsheet(title) {
  const res = await gfetch(SHEETS, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ properties: { title } }) });
  return (await res.json()).spreadsheetId;
}

export async function sheetInfo(id) {
  const j = await (await gfetch(`${SHEETS}/${id}?fields=properties.title,sheets.properties`)).json();
  return { title: j.properties.title, tabs: j.sheets.map((s) => ({ id: s.properties.sheetId, title: s.properties.title,
    rows: s.properties.gridProperties.rowCount, cols: s.properties.gridProperties.columnCount })) };
}

export const sheetsBatch = (id, requests) =>
  gfetch(`${SHEETS}/${id}:batchUpdate`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ requests }) });

// Returns one array of rows per range; numbers and booleans keep their type.
export async function valuesGet(id, ranges) {
  const q = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join('&');
  const j = await (await gfetch(`${SHEETS}/${id}/values:batchGet?${q}&valueRenderOption=UNFORMATTED_VALUE`)).json();
  return j.valueRanges.map((v) => v.values || []);
}

// data: [{ range, values }] — RAW, so text beginning with "=" is never treated as a formula.
export const valuesWrite = (id, data) =>
  gfetch(`${SHEETS}/${id}/values:batchUpdate`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ valueInputOption: 'RAW', data }) });

export const valuesClear = (id, ranges) =>
  gfetch(`${SHEETS}/${id}/values:batchClear`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ ranges }) });
