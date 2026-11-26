'use strict';

// Replies to the drafts this app made (after the person sent them from Gmail).
// Every minute it reads each Gmail's change history (gmail.metadata scope:
// sender, subject and date only, never the body) and records any incoming
// message in the thread of one of our drafts. The page shows them, badges the
// Drafts tab and raises a desktop notification until they are marked read.
//
// data/replies.json: { accounts: { [accountId]: { historyId, checkedAt, error } },
//   replies: Array<{ id, accountId, logId, contactId, threadId, from, subject,
//   snippet, at, foundAt, seenAt }> }

const fs = require('fs');
const path = require('path');
const accounts = require('../accounts');
const log = require('./log');
const gmail = require('./gmail');

const FILE = path.join(__dirname, '..', '..', 'data', 'replies.json');
const CHECK_EVERY_MS = 60 * 1000;
const FIRST_CHECK_MS = 15 * 1000;
const KEEP = 1000;

let state = load();
let running = null;
let timer = null;

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { accounts: s.accounts || {}, replies: Array.isArray(s.replies) ? s.replies : [] };
  } catch {
    return { accounts: {}, replies: [] };
  }
}
function save() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, FILE);
}

const addrOf = (from) => (String(from).match(/<([^>]+)>/)?.[1] || String(from)).trim().toLowerCase();

// An incoming message: not one we sent or drafted, not from the mailbox itself.
function isReply(msg, account) {
  if (msg.labelIds.includes('SENT') || msg.labelIds.includes('DRAFT')) return false;
  return addrOf(msg.from) !== String(account.emailAddress).toLowerCase();
}

function record(account, entry, msg) {
  if (state.replies.some((r) => r.id === msg.id)) return false;
  state.replies.push({
    id: msg.id,
    accountId: account.id,
    logId: entry.id,
    contactId: entry.contactId || null,
    threadId: msg.threadId,
    from: msg.from,
    subject: msg.subject,
    snippet: msg.snippet,
    at: msg.at,
    foundAt: new Date().toISOString(),
    seenAt: null,
  });
  return true;
}

// Our drafts in this mailbox, by thread. Older log entries have no thread id
// yet: it is looked up once from the draft's message id.
async function trackedThreads(account) {
  const byThread = new Map();
  for (const e of log.all()) {
    if (e.accountId !== account.id) continue;
    let threadId = e.threadId;
    if (!threadId && e.messageId && !e.threadLookupFailed) {
      try {
        threadId = (await gmail.getMessage(account, e.messageId)).threadId;
        log.patch(e.id, { threadId });
      } catch {
        log.patch(e.id, { threadLookupFailed: true }); // deleted before it was sent
      }
    }
    if (threadId) byThread.set(threadId, e);
  }
  return byThread;
}

async function checkAccount(account) {
  const st = (state.accounts[account.id] ||= { historyId: null, checkedAt: null, error: null });
  if (!gmail.canReadReplies(account)) {
    st.error = 'reconnect';
    return 0;
  }
  const threads = await trackedThreads(account);
  let found = 0;
  if (!st.historyId) {
    // First look (or the history id expired): read each of our threads once.
    const start = await gmail.historyId(account);
    for (const [threadId, entry] of threads) {
      try {
        for (const msg of await gmail.threadMessages(account, threadId)) if (isReply(msg, account) && record(account, entry, msg)) found++;
      } catch {
        /* thread deleted */
      }
    }
    st.historyId = start;
  } else {
    let h;
    try {
      h = await gmail.historySince(account, st.historyId);
    } catch (err) {
      if (Number(err?.code || err?.response?.status) === 404) {
        st.historyId = null; // too old: start over on the next check
        return 0;
      }
      throw err;
    }
    for (const m of h.added) {
      const entry = threads.get(m.threadId);
      if (!entry || state.replies.some((r) => r.id === m.id)) continue;
      try {
        const msg = await gmail.getMessage(account, m.id);
        if (isReply(msg, account) && record(account, entry, msg)) found++;
      } catch {
        /* gone again */
      }
    }
    st.historyId = h.historyId;
  }
  st.error = null;
  return found;
}

function explain(err) {
  const d = err?.response?.data;
  const msg = String(d?.error_description || d?.error?.message || (typeof d?.error === 'string' ? d.error : '') || err?.message || err);
  if (/invalid_grant|invalid_token|unauthori[sz]ed/i.test(msg) || Number(err?.code) === 401) return 'Access expired or was revoked. Connect this account again.';
  if (/insufficient.*(scope|permission)|scope/i.test(msg)) return 'reconnect';
  return msg.slice(0, 200);
}

async function check() {
  if (running) return running;
  running = (async () => {
    for (const account of accounts.all()) {
      if (account.provider !== 'google') continue;
      try {
        await checkAccount(account);
      } catch (err) {
        (state.accounts[account.id] ||= {}).error = explain(err);
      }
      state.accounts[account.id].checkedAt = new Date().toISOString();
    }
    const known = new Set(accounts.all().map((a) => a.id));
    for (const id of Object.keys(state.accounts)) if (!known.has(id)) delete state.accounts[id];
    state.replies = state.replies.filter((r) => known.has(r.accountId)).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, KEEP);
    save();
  })().finally(() => {
    running = null;
  });
  return running;
}

// Replies by draft log id, for the Drafted emails table.
function byLog() {
  const map = new Map();
  for (const r of state.replies) {
    const cur = map.get(r.logId) || { count: 0, unread: 0, last: null, ids: [] };
    cur.count++;
    if (!r.seenAt) cur.unread++;
    cur.ids.push(r.id);
    if (!cur.last || String(r.at) > String(cur.last.at)) cur.last = { id: r.id, from: r.from, at: r.at, snippet: r.snippet, subject: r.subject };
    map.set(r.logId, cur);
  }
  return map;
}

function summary() {
  const byId = new Map(accounts.all().map((a) => [a.id, a]));
  const unread = state.replies
    .filter((r) => !r.seenAt && byId.has(r.accountId))
    .map((r) => ({ id: r.id, logId: r.logId, from: r.from, subject: r.subject, at: r.at, account: byId.get(r.accountId).emailAddress }));
  const mailboxes = [...byId.values()]
    .filter((a) => a.provider === 'google')
    .map((a) => {
      const st = state.accounts[a.id] || {};
      const needsReconnect = !gmail.canReadReplies(a) || st.error === 'reconnect';
      return { email: a.emailAddress, checkedAt: st.checkedAt || null, needsReconnect, error: needsReconnect ? null : st.error || null };
    });
  return { unread, total: state.replies.length, mailboxes };
}

// ids: reply ids to mark read; none: all of them.
function markSeen(ids) {
  const want = Array.isArray(ids) && ids.length ? new Set(ids) : null;
  const now = new Date().toISOString();
  let n = 0;
  for (const r of state.replies)
    if (!r.seenAt && (!want || want.has(r.id))) {
      r.seenAt = now;
      n++;
    }
  if (n) save();
  return n;
}

function forgetAccount(id) {
  delete state.accounts[id];
  state.replies = state.replies.filter((r) => r.accountId !== id);
  save();
}

function start() {
  if (timer) return;
  setTimeout(() => check().catch(() => {}), FIRST_CHECK_MS).unref();
  timer = setInterval(() => check().catch(() => {}), CHECK_EVERY_MS);
  timer.unref();
}

module.exports = { start, check, summary, byLog, markSeen, forgetAccount, isReply, FILE };
