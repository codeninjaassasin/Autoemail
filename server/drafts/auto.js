'use strict';

// Automatic drafts. When it is on, every post scraped from then on that has an
// email (the Craigslist relay, or another address) and NO phone gets one draft,
// made from the template assigned to a mailbox. Mailboxes with a template take
// turns. The app never sends: each draft waits in Drafts for the person to
// review, fix and send by hand (the reminder lists them).
//
// data/automation.json: { enabled, enabledAt, assignments: { [accountId]: { templateId } },
//   cursor, drafted, failed, lastDraftAt, lastError }
// Each drafted contact carries `autoDraft` (contacts.json), so it is drafted once.

const fs = require('fs');
const path = require('path');
const contacts = require('../contacts');
const accounts = require('../accounts');
const templates = require('../templates');
const { createOne } = require('./createDrafts');
const { render, FIELDS } = require('./merge');

const FILE = path.join(__dirname, '..', '..', 'data', 'automation.json');
const TICK_MS = 20 * 1000;
const BATCH = 25; // drafts per pass at most
const MAX_FAILS = 3; // per contact, for errors about that contact
const ACCOUNT_PAUSE_MS = 15 * 60 * 1000; // a mailbox that refused (sign-in expired, quota)
const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[a-z]{2,}$/i;

const DEFAULTS = { enabled: false, enabledAt: null, assignments: {}, cursor: 0, drafted: 0, failed: 0, lastDraftAt: null, lastError: null };
let cfg = load();
const paused = new Map(); // accountId -> { until, at, error }
let running = false;
let timer = null;

function load() {
  try {
    const c = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { ...DEFAULTS, ...c, assignments: { ...(c.assignments || {}) } };
  } catch {
    return { ...DEFAULTS, assignments: {} };
  }
}

function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, FILE);
}

// Where the draft goes: the relay, else the first plain address found on the post.
function recipient(r) {
  if (contacts.isRelay(r.relay)) return r.relay;
  return (r.emails || []).find((e) => EMAIL_RE.test(e)) || null;
}

// Scraped, has an email, no phone, not sent or marked red, no draft yet.
const inFlight = new Set(); // contact ids being drafted right now (automatic or Compose)
function draftable(r) {
  if (r.sent || r.unscraped || r.flagged) return false;
  if (r.phones && r.phones.length) return false; // has a phone: you call or text instead
  if (r.autoDraft && (r.autoDraft.draftId || (r.autoDraft.fails || 0) >= MAX_FAILS)) return false;
  if (inFlight.has(r.id)) return false;
  return !!recipient(r);
}
function eligible(r, since) {
  if (!r.scrapedAt || Date.parse(r.scrapedAt) < since) return false; // older posts are never drafted automatically
  return draftable(r);
}

function pending() {
  if (!cfg.enabled || !cfg.enabledAt) return [];
  const since = Date.parse(cfg.enabledAt);
  return contacts
    .list()
    .filter((r) => eligible(r, since))
    .sort((a, b) => a.scrapedAt.localeCompare(b.scrapedAt));
}

// Mailboxes that draft: connected, with a template that still exists.
function senders() {
  const byId = new Map(templates.list().map((t) => [t.id, t]));
  return accounts
    .all()
    .map((account) => ({ account, template: byId.get(cfg.assignments[account.id]?.templateId) }))
    .filter((s) => s.template);
}

function status(err) {
  return Number(err?.code || err?.status || err?.response?.status) || 0;
}
function explain(err) {
  const d = err?.response?.data;
  const msg = String(d?.error_description || d?.error?.message || (typeof d?.error === 'string' ? d.error : '') || err?.message || err);
  if (/invalid_grant|invalid_token|unauthori[sz]ed|reconnect/i.test(msg) || status(err) === 401)
    return 'Access expired or was revoked. Connect this account again.';
  return msg.slice(0, 200);
}
// Errors about the mailbox (not the contact) pause that mailbox instead of
// counting against the post.
function isAccountError(err) {
  const s = status(err);
  return s === 401 || s === 403 || s === 429 || /invalid_grant|invalid_token|quota|rate limit|reconnect/i.test(String(err?.message || ''));
}

// One draft for one post from one template; records it on the contact so the
// post is never drafted twice. Errors about the mailbox are not held against the post.
async function draftOne(account, template, r, source) {
  const to = recipient(r);
  const { subject, bodyHtml } = render(template, r);
  // The other path (automatic or Compose) may have drafted it since the list was made.
  if (!draftable(r)) return { ok: false, skipped: true, at: new Date().toISOString(), to, subject, error: 'Skipped: already drafted, sent or changed.' };
  inFlight.add(r.id);
  try {
    const entry = await createOne(account, { to, subject, bodyHtml, templateId: template.id || null, contactId: r.id });
    contacts.setAutoDraft(r.id, {
      at: entry.createdAt,
      source,
      accountId: account.id,
      account: account.emailAddress,
      templateId: template.id || null,
      to,
      draftId: entry.draftId,
      logId: entry.id,
    });
    return { ok: true, at: entry.createdAt, to, subject, entry };
  } catch (err) {
    const at = new Date().toISOString();
    const error = explain(err);
    const accountError = isAccountError(err);
    if (!accountError) contacts.setAutoDraft(r.id, { fails: (r.autoDraft?.fails || 0) + 1, at, error, to });
    return { ok: false, at, to, subject, error, accountError };
  } finally {
    inFlight.delete(r.id);
  }
}

// Posts Compose can draft now, newest posted first. `days` limits to posts
// posted in the last N days (0 or empty: any age).
function ready(days) {
  const d = Number(days) || 0;
  const since = d > 0 ? Date.now() - d * 86400000 : 0;
  return contacts
    .list()
    .filter((r) => draftable(r) && (!since || Date.parse(r.postedAt || r.scrapedAt || 0) >= since))
    .sort((a, b) => String(b.postedAt || b.scrapedAt || '').localeCompare(String(a.postedAt || a.scrapedAt || '')));
}

const COMPOSE_MAX = 100; // drafts per click
let composing = false;
// Compose: drafts the newest `limit` ready posts with this subject and body
// (fields filled from each post), mailboxes taking turns. Never sends.
async function draftFromCompose({ accountIds, subject, bodyHtml, templateId = null, limit, days } = {}) {
  const chosen = (Array.isArray(accountIds) ? accountIds : []).map((id) => accounts.get(id)).filter(Boolean);
  if (!chosen.length) throw new Error('Tick at least one connected account.');
  if (!String(subject || '').trim()) throw new Error('Write a subject.');
  const n = Math.min(COMPOSE_MAX, Math.max(1, Math.floor(Number(limit) || 0)));
  if (composing) throw new Error('Drafts are already being created. Wait for that to finish.');
  composing = true;
  try {
    const posts = ready(days).slice(0, n);
    if (!posts.length) throw new Error('No scraped post is waiting for a draft (it needs an email, no phone, and no draft yet).');
    const template = { id: templateId || null, subject, bodyHtml };
    const live = [...chosen];
    const results = [];
    const refused = [];
    let turn = 0;
    for (const r of posts) {
      if (!live.length) {
        results.push({ contactId: r.id, title: r.title, to: recipient(r), ok: false, error: 'Skipped: every mailbox refused.' });
        continue;
      }
      // A mailbox that refuses (sign-in expired, quota) is dropped for this run
      // and the same post goes to the next one.
      let res, account;
      while (live.length) {
        account = live[turn++ % live.length];
        res = await draftOne(account, template, r, 'compose');
        if (res.ok || !res.accountError) break;
        live.splice(live.indexOf(account), 1);
        refused.push(`${account.emailAddress}: ${res.error}`);
      }
      results.push({ contactId: r.id, title: r.title, to: res.to, account: account.emailAddress, ok: res.ok, error: res.error });
    }
    for (const msg of refused) results.push({ ok: false, error: msg, mailbox: true });
    return results;
  } finally {
    composing = false;
  }
}

async function tick() {
  if (running || !cfg.enabled) return;
  running = true;
  try {
    for (const r of pending().slice(0, BATCH)) {
      const now = Date.now();
      const open = senders().filter((s) => !((paused.get(s.account.id)?.until || 0) > now));
      if (!open.length) break;
      const s = open[cfg.cursor % open.length];
      cfg.cursor = (cfg.cursor + 1) % 1e9;
      const res = await draftOne(s.account, s.template, r, 'auto');
      if (res.skipped) continue;
      if (res.ok) {
        cfg.drafted++;
        cfg.lastDraftAt = res.at;
      } else {
        if (res.accountError) paused.set(s.account.id, { until: now + ACCOUNT_PAUSE_MS, at: res.at, error: res.error });
        else cfg.failed++;
        cfg.lastError = { at: res.at, account: s.account.emailAddress, error: res.error };
      }
      save();
    }
  } finally {
    running = false;
  }
}

function kick() {
  tick().catch((err) => console.log(`Automatic drafts: ${err.message}`));
}

function start() {
  if (timer) return;
  timer = setInterval(kick, TICK_MS);
  timer.unref();
  setTimeout(kick, 5000).unref();
}

function summary() {
  const now = Date.now();
  const byTpl = new Map(templates.list().map((t) => [t.id, t]));
  return {
    enabled: cfg.enabled,
    enabledAt: cfg.enabledAt,
    assignments: accounts.all().map((a) => {
      const templateId = cfg.assignments[a.id]?.templateId || null;
      const p = paused.get(a.id);
      return {
        accountId: a.id,
        email: a.emailAddress,
        provider: a.provider,
        templateId: byTpl.has(templateId) ? templateId : null,
        paused: p && p.until > now ? { until: new Date(p.until).toISOString(), error: p.error } : null,
      };
    }),
    senders: senders().length,
    pending: pending().length,
    drafted: cfg.drafted,
    failed: cfg.failed,
    lastDraftAt: cfg.lastDraftAt,
    lastError: cfg.lastError,
    fields: FIELDS,
  };
}

// { enabled?, assignments?: { [accountId]: templateId | null } }
function configure({ enabled, assignments } = {}) {
  if (assignments && typeof assignments === 'object') {
    const known = new Set(accounts.all().map((a) => a.id));
    const tpl = new Set(templates.list().map((t) => t.id));
    for (const [id, templateId] of Object.entries(assignments)) {
      if (!known.has(id)) continue;
      if (templateId && !tpl.has(templateId)) throw new Error('That template no longer exists.');
      if (templateId) cfg.assignments[id] = { templateId };
      else delete cfg.assignments[id];
      paused.delete(id); // a change is a reason to try that mailbox again
    }
  }
  if (enabled !== undefined) {
    const on = !!enabled;
    if (on && !cfg.enabled) cfg.enabledAt = new Date().toISOString(); // only posts scraped from now on
    cfg.enabled = on;
  }
  save();
  kick();
  return summary();
}

function forgetAccount(id) {
  if (!cfg.assignments[id]) return;
  delete cfg.assignments[id];
  paused.delete(id);
  save();
}

module.exports = { start, kick, summary, configure, forgetAccount, recipient, ready, draftFromCompose, COMPOSE_MAX, FILE };
