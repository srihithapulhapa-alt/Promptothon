// Getting score cards out: PDF files (headless Chromium renders the same HTML template), a ZIP of PDFs, and email.
// Email uses SMTP (Gmail / Google Workspace app password from .env) and goes to the address saved from each student's Google sign-in.
import fs from 'node:fs';
import nodemailer from 'nodemailer';
import { zipSync, strToU8 } from 'fflate';
import { env } from './config.js';
import { db, save } from './store.js';
import { scorecard, renderScorecard } from './scorecard.js';

const LOGO = new URL('../public/the-ai-club-logo.png', import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- PDF ----------
let browser = null;
async function chromium() {
  browser ||= import('puppeteer').then((p) => p.default.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }))
    .catch((err) => { browser = null; throw new Error(`The PDF engine could not start (${err.message.split('\n')[0]}).`); });
  return browser;
}

export async function cardPdf(card) {
  const logo = `data:image/png;base64,${fs.readFileSync(LOGO).toString('base64')}`; // PDFs have no web address to load the logo from
  const page = await (await chromium()).newPage();
  try {
    await page.setContent(renderScorecard(card, { logo }), { waitUntil: 'load' });
    return Buffer.from(await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true }));
  } finally { await page.close(); }
}

export const cardFileName = (card, ext = 'pdf') => `AI-Readiness-Scorecard-${card.name.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '')}-${card.code}.${ext}`;

// A ZIP with one PDF per card.
export async function cardsZip(cards) {
  const files = {};
  for (const c of cards) files[cardFileName(c)] = new Uint8Array(await cardPdf(c));
  return Buffer.from(zipSync(files, { level: 0 }));
}

// ---------- email ----------
export const emailReady = () => Boolean(env.smtpUser && env.smtpPass);
let transport = null;
export const useTransport = (t) => { transport = t; }; // lets tests swap in a fake mail server
const smtp = () => (transport ||= nodemailer.createTransport({ host: env.smtpHost, port: env.smtpPort, secure: env.smtpPort === 465, auth: { user: env.smtpUser, pass: env.smtpPass } }));

function message(card) {
  const best = [...card.skills].filter((s) => s.percent != null).sort((x, y) => y.percent - x.percent)[0];
  const text = `Hello,\n\nHere is ${card.name}'s AI Readiness & Thinking Skills score card from the Promptathon (${card.school}).\n\nTotal score: ${card.total}/60\n${best ? `Strongest skill: ${best.name} (${best.percent}%)\n` : ''}\nThe full score card is attached as a PDF.\n\nThe AI Club`;
  const html = `<div style="font-family:system-ui,Segoe UI,sans-serif;color:#1d1a17;max-width:560px;line-height:1.5">
    <p>Hello,</p><p>Here is <b>${esc(card.name)}</b>’s <b>AI Readiness &amp; Thinking Skills</b> score card from the Promptathon (${esc(card.school)}).</p>
    <p style="font-size:18px;margin:14px 0"><b>Total score: ${esc(card.total)}/60</b>${best ? `<br><span style="font-size:14px;color:#5d554e">Strongest skill: ${esc(best.name)} (${esc(best.percent)}%)</span>` : ''}</p>
    <p>The full score card is attached as a PDF.</p><p style="color:#5d554e">The AI Club</p></div>`;
  return { text, html };
}

export async function sendCardEmail(card, to, pdf) {
  await smtp().sendMail({ from: `"${env.smtpFromName}" <${env.smtpUser}>`, to, subject: `${card.name}’s AI Readiness score card — Promptathon`,
    ...message(card), attachments: [{ filename: cardFileName(card), content: pdf, contentType: 'application/pdf' }] });
}

// Emails approved cards to the address each student signed in with. Cards already emailed (and unchanged) are skipped unless `resend`.
export async function sendCards(attemptIds, { resend = false, by = '' } = {}) {
  if (!emailReady()) throw new Error('Email is not set up. Add SMTP_USER and SMTP_PASS to .env.');
  const out = { sent: 0, skipped: 0, failed: [] };
  for (const id of attemptIds) {
    const a = db.attempts.find((x) => x.id === id), card = a && scorecard(a);
    if (!card?.approved || !card.email || (card.emailedAt && !card.changedSinceEmailed && !resend)) { out.skipped++; continue; }
    try {
      await sendCardEmail(card, card.email, await cardPdf(card));
      Object.assign(a.card, { sentAt: Date.now(), sentTo: card.email, sentBy: by, sentVersion: card.version, lastError: undefined });
      out.sent++;
    } catch (err) {
      a.card.lastError = err.message.slice(0, 200);
      out.failed.push({ name: card.name, to: card.email, error: err.message.slice(0, 160) });
    }
    save(true);
    await sleep(400); // gentle on the mail server
  }
  return out;
}

// A sample to the admin's own address, to check the email looks right before sending to everyone.
export async function sendTestEmail(card, to) {
  if (!emailReady()) throw new Error('Email is not set up. Add SMTP_USER and SMTP_PASS to .env.');
  await sendCardEmail(card, to, await cardPdf(card));
}

process.on('exit', () => { browser?.then((b) => b.close()).catch(() => {}); });
