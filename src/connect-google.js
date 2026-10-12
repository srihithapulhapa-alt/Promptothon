// One-time, server-side: authorise the Google account that owns the question bank and the results sheet.
// Run `npm run connect-google` on the server (stop `npm start` first — this briefly uses the same port).
// The refresh token is written to .env as GOOGLE_REFRESH_TOKEN; nothing about Drive is reachable from the web app.
// The first `npm start` then creates the private data sheet (its id goes to .env as DATA_SHEET_ID).
import crypto from 'node:crypto';
import http from 'node:http';
import { env, saveEnv } from './config.js';
import { authUrl, exchangeCode } from './google.js';

const state = crypto.randomBytes(16).toString('hex');
const callback = new URL('/auth/callback', env.baseUrl);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, env.baseUrl);
  if (url.pathname !== callback.pathname) { res.writeHead(404).end(); return; }
  const say = (code, msg) => res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' }).end(msg);
  try {
    if (url.searchParams.get('state') !== state) throw new Error('state mismatch');
    const who = await exchangeCode(url.searchParams.get('code'));
    if (!who.tokens.refresh_token) throw new Error('Google returned no refresh token. Remove this app at https://myaccount.google.com/permissions and run the command again.');
    saveEnv('GOOGLE_REFRESH_TOKEN', who.tokens.refresh_token);
    say(200, `Connected as ${who.email}. You can close this tab and start the app with: npm start`);
    console.log(`\nConnected as ${who.email}. GOOGLE_REFRESH_TOKEN saved to .env. Now run: npm start (the first start creates the data sheet).`);
  } catch (err) {
    say(400, `Could not connect: ${err.message}`);
    console.error(`\nCould not connect: ${err.message}`);
    process.exitCode = 1;
  }
  server.close();
});

server.listen(Number(callback.port || 80), () => {
  console.log('Open this link, sign in with the Google account that can see the question bank sheet, and allow access:\n');
  console.log(authUrl(state, true));
  console.log(`\nWaiting for Google to redirect to ${callback.href} ...`);
});
