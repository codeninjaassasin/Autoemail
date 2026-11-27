'use strict';

// Draft reminders: checks each connected mailbox's Drafts folder and reports
// the drafts this app made that are still there, unsent. It only reads:
// the person reviews, edits and sends each one in Gmail or Outlook themselves.

const accounts = require('../accounts');
const contacts = require('../contacts');
const { values } = require('./merge');
const replies = require('./replies');
const log = require('./log');
const gmail = require('./gmail');
const graph = require('./graph');

const CHECK_EVERY_MS = 5 * 60 * 1000;
const FIRST_CHECK_MS = 30 * 1000;

const state = { checkedAt: null, checking: null, errors: {} };

function provider(account) {
  return account.provider === 'google' ? gmail : graph;
}

// Token refresh failures mean the person has to connect the account again.
function explain(err) {
  const msg = String(err?.response?.data?.error_description || err?.response?.data?.error || err?.message || err);
  if (/invalid_grant|invalid_token|unauthori[sz]ed|401|reconnect/i.test(msg))
    return 'Access expired or was revoked. Connect this account again.';
  return msg.slice(0, 200);
}

// A draft that left Drafts counts as sent: its contact is marked sent and the
// row's chip in the Scraper list turns from Drafted to Sent.
function settle() {
  const gone = log.all().filter((e) => e.status === 'gone' && e.contactId);
  if (!gone.length) return;
  const byId = new Map(contacts.list().map((c) => [c.id, c]));
  for (const e of gone) {
    const c = byId.get(e.contactId);
    if (!c || !c.autoDraft || c.autoDraft.logId !== e.id) continue;
    if (c.autoDraft.status !== 'sent') contacts.setAutoDraft(c.id, { status: 'sent', sentAt: e.goneAt || null }, true);
    // Sent when the draft left Drafts (dated then, not when this check noticed).
    if (!c.sent) contacts.setFlags(c.id, { sent: true, sentAt: e.goneAt });
    else if (e.goneAt && c.sentAt && c.sentAt > e.goneAt) contacts.setFlags(c.id, { sentAt: e.goneAt });
  }
}

async function checkAccount(account) {
  const startedAt = Date.now();
  try {
    const present = await provider(account).listDrafts(account);
    log.reconcile(account.id, present, startedAt);
    delete state.errors[account.id];
  } catch (err) {
    state.errors[account.id] = { at: new Date().toISOString(), error: explain(err) };
  }
}

// One check at a time; callers during a check share its result.
function check() {
  if (!state.checking) {
    state.checking = (async () => {
      const waitingIds = new Set(log.waiting().map((e) => e.accountId));
      const connected = accounts.all();
      for (const id of Object.keys(state.errors)) if (!connected.some((a) => a.id === id)) delete state.errors[id];
      for (const account of connected) {
        if (waitingIds.has(account.id)) await checkAccount(account);
        else delete state.errors[account.id];
      }
      settle();
      state.checkedAt = new Date().toISOString();
    })().finally(() => {
      state.checking = null;
    });
  }
  return state.checking;
}

// The post a draft answers: title without the category suffix, and its place.
function postInfo(c) {
  const v = values(c);
  return { title: v.title || c.title || '', url: c.url || null, place: [v.city, v.state].filter(Boolean).join(', '), posted: v.posted };
}

function summary() {
  const byId = new Map(accounts.all().map((a) => [a.id, a]));
  const wanted = new Set(log.all().map((e) => e.contactId).filter(Boolean));
  const posts = new Map();
  if (wanted.size) for (const c of contacts.list()) if (wanted.has(c.id)) posts.set(c.id, c);
  const answered = replies.byLog();
  const row = (e) => {
    const account = byId.get(e.accountId);
    const post = e.contactId ? posts.get(e.contactId) : null;
    return {
      replies: answered.get(e.id) || null,
      post: post ? postInfo(post) : null,
      id: e.id,
      to: e.to,
      subject: e.subject,
      account: account.emailAddress,
      provider: account.provider,
      createdAt: e.createdAt,
      status: e.status,
      goneAt: e.goneAt || null,
    };
  };
  const mine = log.all().filter((e) => byId.has(e.accountId));
  const waiting = mine
    .filter((e) => e.status === 'waiting')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(row);
  // Drafts that left the Drafts folder (counted as sent), newest first.
  const done = mine
    .filter((e) => e.status !== 'waiting')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .filter((e, i) => i < 50 || answered.has(e.id)) // a draft with a reply always stays listed
    .map(row);
  const errors = Object.entries(state.errors)
    .filter(([id]) => byId.has(id))
    .map(([id, v]) => ({ account: byId.get(id).emailAddress, provider: byId.get(id).provider, ...v }));
  return {
    checkedAt: state.checkedAt,
    checking: !!state.checking,
    nextCheckAt: state.checkedAt ? new Date(Date.parse(state.checkedAt) + CHECK_EVERY_MS).toISOString() : null,
    waiting,
    done,
    errors,
  };
}

let timer = null;
function start() {
  if (timer) return;
  setTimeout(() => check().catch(() => {}), FIRST_CHECK_MS).unref();
  timer = setInterval(() => check().catch(() => {}), CHECK_EVERY_MS);
  timer.unref();
}

module.exports = { start, check, summary };
