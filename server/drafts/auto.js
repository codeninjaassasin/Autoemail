'use strict';

// Automatic drafts. When it is on, every post scraped from then on that has an
// email (the Craigslist relay, or another address) and NO phone gets one draft,
// made from the template assigned to a mailbox. The app never sends: each draft
// waits in Drafts for the person to review and send by hand.
//
// Strict limits, per mailbox (each draft becomes one email the person sends):
//   at most `perDay` drafts in any 24 hours, and at most `perHour` in any hour.
// Choosing the mailbox for the next post (plan() explains it for the screen):
//   1. Only mailboxes with a template, not paused, and under both limits.
//   2. Not the mailbox that made the last draft, while another one has room.
//   3. The one with the most left in 24 hours; then the most left this hour;
//      then the one idle longest; then by address.
// Posts wait while every mailbox is full, and are taken newest first.
//
// data/automation.json: { enabled, enabledAt, limits: { perDay, perHour },
//   assignments: { [accountId]: { templateId } }, usage: { [accountId]: [iso] },
//   lastAccountId, recent: [decision], drafted, failed, lastDraftAt, lastError }
// Each drafted contact carries `autoDraft` (contacts.json), so it is drafted once.

const fs = require('fs');
const path = require('path');
const contacts = require('../contacts');
const accounts = require('../accounts');
const templates = require('../templates');
const log = require('./log');
const { createOne } = require('./createDrafts');
const { render, FIELDS } = require('./merge');

const FILE = path.join(__dirname, '..', '..', 'data', 'automation.json');
const TICK_MS = 20 * 1000;
const BATCH = 10; // drafts per pass at most
const MAX_FAILS = 3; // per contact, for errors about that contact
const ACCOUNT_PAUSE_MS = 15 * 60 * 1000; // a mailbox that refused (sign-in expired, quota)
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const RECENT_MAX = 20;
const DEFAULT_LIMITS = { perDay: 5, perHour: 3 };
const LIMIT_MAX = 500;
const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[a-z]{2,}$/i;

const DEFAULTS = {
  enabled: false,
  enabledAt: null,
  limits: { ...DEFAULT_LIMITS },
  assignments: {},
  usage: null,
  lastAccountId: null,
  recent: [],
  drafted: 0,
  failed: 0,
  lastDraftAt: null,
  lastError: null,
};
let cfg = load();
const paused = new Map(); // accountId -> { until, at, error }
const inFlight = new Set(); // contact ids being drafted right now
let running = false;
let timer = null;

function load() {
  let c = {};
  try {
    c = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    /* first run */
  }
  const out = {
    ...DEFAULTS,
    ...c,
    limits: { ...DEFAULT_LIMITS, ...(c.limits || {}) },
    assignments: { ...(c.assignments || {}) },
    recent: Array.isArray(c.recent) ? c.recent : [],
  };
  delete out.cursor; // the old round-robin pointer
  if (!out.usage) {
    // First run with limits: count the post drafts already made in the last 24 hours.
    out.usage = {};
    const since = Date.now() - DAY;
    for (const e of log.all())
      if (e.contactId && Date.parse(e.createdAt) > since) (out.usage[e.accountId] ||= []).push(e.createdAt);
  }
  return out;
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

// Scraped after automatic drafts were turned on, has an email, no phone, not
// sent or marked red, no draft yet.
function eligible(r, since) {
  if (r.sent || r.unscraped || r.flagged) return false;
  if (r.phones && r.phones.length) return false; // has a phone: you call or text instead
  if (r.autoDraft && (r.autoDraft.draftId || (r.autoDraft.fails || 0) >= MAX_FAILS)) return false;
  if (inFlight.has(r.id)) return false;
  if (!r.scrapedAt || Date.parse(r.scrapedAt) < since) return false; // older posts are never drafted
  return !!recipient(r);
}

const postTime = (r) => String(r.postedAt || r.scrapedAt || '');
function pending() {
  if (!cfg.enabledAt) return [];
  const since = Date.parse(cfg.enabledAt);
  return contacts
    .list()
    .filter((r) => eligible(r, since))
    .sort((a, b) => postTime(b).localeCompare(postTime(a))); // newest first
}

// --- Limits ---------------------------------------------------------------
function usedSince(accountId, now) {
  const list = (cfg.usage[accountId] || []).map(Date.parse).filter((t) => t > now - DAY);
  return list.sort((a, b) => a - b);
}
function trimUsage(now) {
  const known = new Set(accounts.all().map((a) => a.id));
  for (const id of Object.keys(cfg.usage)) {
    if (!known.has(id)) delete cfg.usage[id];
    else cfg.usage[id] = cfg.usage[id].filter((t) => Date.parse(t) > now - DAY);
  }
}

// Every mailbox with its counts and what the rules say about it.
function mailboxes(now) {
  const byTpl = new Map(templates.list().map((t) => [t.id, t]));
  const { perDay, perHour } = cfg.limits;
  return accounts.all().map((a) => {
    const times = usedSince(a.id, now);
    const day = times.length;
    const hourTimes = times.filter((t) => t > now - HOUR);
    const hour = hourTimes.length;
    const template = byTpl.get(cfg.assignments[a.id]?.templateId) || null;
    const p = paused.get(a.id);
    const m = {
      account: a,
      accountId: a.id,
      email: a.emailAddress,
      provider: a.provider,
      template,
      templateId: template ? template.id : null,
      templateName: template ? template.name : null,
      day,
      hour,
      dayLeft: Math.max(0, perDay - day),
      hourLeft: Math.max(0, perHour - hour),
      lastAt: times.length ? times[times.length - 1] : null,
      freeAt: null,
      status: 'free',
      note: '',
    };
    if (!template) {
      m.status = 'no-template';
      m.note = 'No template assigned, so it makes no drafts.';
    } else if (p && p.until > now) {
      m.status = 'paused';
      m.freeAt = p.until;
      m.note = `Paused after an error: ${p.error}`;
    } else if (day >= perDay) {
      m.status = 'day-full';
      m.freeAt = times[day - perDay] + DAY; // when the oldest draft that counts leaves the 24-hour window
      m.note = `${day} of ${perDay} in the last 24 hours.`;
    } else if (hour >= perHour) {
      m.status = 'hour-full';
      m.freeAt = hourTimes[hour - perHour] + HOUR;
      m.note = `${hour} of ${perHour} in the last hour.`;
    }
    return m;
  });
}

// The order mailboxes are used in, and why the first one is next.
function rank(boxes) {
  let free = boxes.filter((m) => m.status === 'free');
  let rested = null;
  if (free.length > 1 && cfg.lastAccountId) {
    const others = free.filter((m) => m.accountId !== cfg.lastAccountId);
    if (others.length && others.length < free.length) {
      rested = free.find((m) => m.accountId === cfg.lastAccountId);
      rested.status = 'rested';
      rested.note = 'Made the last draft, so another mailbox goes first.';
      free = others;
    }
  }
  free.sort(
    (a, b) =>
      b.dayLeft - a.dayLeft ||
      b.hourLeft - a.hourLeft ||
      (a.lastAt || 0) - (b.lastAt || 0) ||
      a.email.localeCompare(b.email)
  );
  const order = rested ? [...free, rested] : free;
  order.forEach((m, i) => (m.position = i + 1));
  return { order, reason: order.length ? why(order[0], free[1] || null, rested) : null };
}

function ago(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min ago`;
}

function why(pick, next, rested) {
  const { perDay, perHour } = cfg.limits;
  const parts = [`${pick.dayLeft} of ${perDay} left in 24 hours, ${pick.hourLeft} of ${perHour} this hour`];
  if (!next && !rested) parts.push('the only mailbox with room');
  else if (next && pick.dayLeft > next.dayLeft) parts.push(`more left in 24 hours than ${next.email} (${next.dayLeft})`);
  else if (next && pick.hourLeft > next.hourLeft) parts.push(`more left this hour than ${next.email} (${next.hourLeft})`);
  else if (next && (pick.lastAt || 0) < (next.lastAt || 0))
    parts.push(pick.lastAt ? `idle longest (last draft ${ago(Date.now() - pick.lastAt)})` : 'no draft in the last 24 hours');
  else if (next) parts.push('tied with the others, first by address');
  if (rested) parts.push(`${rested.email} made the last draft`);
  return parts.join('; ');
}

// --- Drafting ---------------------------------------------------------------
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

function remember(decision) {
  cfg.recent.unshift(decision);
  cfg.recent.length = Math.min(cfg.recent.length, RECENT_MAX);
}

async function draftPost(m, r, reason) {
  const to = recipient(r);
  const { subject, bodyHtml, bodyText } = render(m.template, r);
  inFlight.add(r.id);
  try {
    const entry = await createOne(m.account, { to, subject, bodyHtml, bodyText, templateId: m.template.id, contactId: r.id });
    contacts.setAutoDraft(r.id, {
      at: entry.createdAt,
      accountId: m.accountId,
      account: m.email,
      templateId: m.template.id,
      to,
      draftId: entry.draftId,
      logId: entry.id,
    });
    (cfg.usage[m.accountId] ||= []).push(entry.createdAt);
    cfg.lastAccountId = m.accountId;
    cfg.drafted++;
    cfg.lastDraftAt = entry.createdAt;
    remember({ at: entry.createdAt, ok: true, email: m.email, template: m.template.name, title: r.title || '', to, reason });
  } catch (err) {
    const at = new Date().toISOString();
    const error = explain(err);
    if (isAccountError(err)) {
      paused.set(m.accountId, { until: Date.now() + ACCOUNT_PAUSE_MS, at, error });
    } else {
      contacts.setAutoDraft(r.id, { fails: (r.autoDraft?.fails || 0) + 1, at, error, to });
      cfg.failed++;
    }
    cfg.lastError = { at, account: m.email, error };
    remember({ at, ok: false, email: m.email, template: m.template.name, title: r.title || '', to, reason, error });
  } finally {
    inFlight.delete(r.id);
  }
}

async function tick() {
  if (running || !cfg.enabled) return;
  running = true;
  try {
    for (let i = 0; i < BATCH; i++) {
      const r = pending()[0];
      if (!r) break;
      const { order, reason } = rank(mailboxes(Date.now()));
      if (!order.length) break; // every mailbox is full or paused: the post waits
      await draftPost(order[0], r, reason);
      trimUsage(Date.now());
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

// --- For the screen -----------------------------------------------------------
function iso(t) {
  return t ? new Date(t).toISOString() : null;
}

function plan() {
  const boxes = mailboxes(Date.now());
  const { order, reason } = rank(boxes);
  const queue = cfg.enabled ? pending() : [];
  const post = queue[0] || null;
  const next = order[0] || null;
  let waitReason = null;
  let freeAt = null;
  if (!next) {
    const withTpl = boxes.filter((m) => m.templateId);
    if (!withTpl.length) waitReason = 'No mailbox has a template, so nothing can be drafted.';
    else {
      const soonest = Math.min(...withTpl.map((m) => m.freeAt || Infinity));
      waitReason = 'Every mailbox is at its limit or paused.';
      if (Number.isFinite(soonest)) freeAt = iso(soonest);
    }
  }
  return {
    pending: queue.length,
    next: next ? { accountId: next.accountId, email: next.email, template: next.templateName, reason } : null,
    nextPost: post ? { id: post.id, title: post.title || '', to: recipient(post), postedAt: post.postedAt || null } : null,
    waitReason,
    freeAt,
    mailboxes: boxes.map((m) => ({
      accountId: m.accountId,
      email: m.email,
      provider: m.provider,
      templateId: m.templateId,
      templateName: m.templateName,
      day: m.day,
      hour: m.hour,
      lastAt: iso(m.lastAt),
      freeAt: iso(m.freeAt),
      status: m.status,
      position: m.position || null,
      note: m.note,
    })),
  };
}

function summary() {
  return {
    enabled: cfg.enabled,
    enabledAt: cfg.enabledAt,
    limits: cfg.limits,
    drafted: cfg.drafted,
    failed: cfg.failed,
    lastDraftAt: cfg.lastDraftAt,
    lastError: cfg.lastError,
    recent: cfg.recent,
    fields: FIELDS,
    ...plan(),
  };
}

function limitValue(v, name) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > LIMIT_MAX) throw new Error(`${name} must be a whole number from 1 to ${LIMIT_MAX}.`);
  return n;
}

// { enabled?, limits?: { perDay, perHour }, assignments?: { [accountId]: templateId | null } }
function configure({ enabled, limits, assignments } = {}) {
  if (limits && typeof limits === 'object') {
    const next = { ...cfg.limits };
    if (limits.perDay !== undefined) next.perDay = limitValue(limits.perDay, 'Drafts per 24 hours');
    if (limits.perHour !== undefined) next.perHour = limitValue(limits.perHour, 'Drafts per hour');
    cfg.limits = next;
  }
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

// A template was deleted: mailboxes using it stop drafting.
function forgetTemplate(templateId) {
  let changed = false;
  for (const [id, a] of Object.entries(cfg.assignments))
    if (a.templateId === templateId) {
      delete cfg.assignments[id];
      changed = true;
    }
  if (changed) save();
}

function forgetAccount(id) {
  delete cfg.assignments[id];
  delete cfg.usage[id];
  if (cfg.lastAccountId === id) cfg.lastAccountId = null;
  paused.delete(id);
  save();
}

module.exports = { start, kick, summary, configure, forgetAccount, forgetTemplate, recipient, FILE };
