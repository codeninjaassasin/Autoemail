'use strict';

// Every draft this app creates, so the reminder can tell which of them still
// sit unsent in the mailbox. The app never sends mail: a draft leaves the
// "waiting" list only when it is gone from the account's Drafts folder
// (the person sent it, or deleted it).
// data/drafts.json: Array<DraftEntry>.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, '..', '..', 'data', 'drafts.json');
const KEEP_GONE_DAYS = 30;

function load() {
  try {
    const list = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function save(list) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, FILE);
}

function add(entries) {
  if (!entries.length) return [];
  const now = new Date().toISOString();
  const all = load();
  const added = entries.map((e) => ({ id: crypto.randomUUID(), status: 'waiting', createdAt: now, ...e }));
  all.push(...added);
  save(all);
  return added;
}

function all() {
  return load();
}

function waiting() {
  return load().filter((e) => e.status === 'waiting');
}

// Apply what a check found for one account: `present` maps draftId -> fresh
// fields (e.g. the current Gmail message id); waiting drafts not in it are gone.
// Drafts created after `startedAt` were not in the listing yet, so they are left alone.
function reconcile(accountId, present, startedAt) {
  const list = load();
  const now = new Date().toISOString();
  const cutoff = Date.now() - KEEP_GONE_DAYS * 86400000;
  let changed = false;
  for (const e of list) {
    if (e.accountId !== accountId || e.status !== 'waiting') continue;
    if (Date.parse(e.createdAt) >= startedAt) continue;
    const fresh = present.get(e.draftId);
    if (!fresh) {
      e.status = 'gone';
      e.goneAt = now;
      changed = true;
    } else if (fresh.messageId && fresh.messageId !== e.messageId) {
      e.messageId = fresh.messageId;
      changed = true;
    }
  }
  const kept = list.filter((e) => e.status === 'waiting' || Date.parse(e.goneAt || e.createdAt) > cutoff);
  if (changed || kept.length !== list.length) save(kept);
}

// An account removed from the app: its drafts can't be checked any more.
function forgetAccount(accountId) {
  const list = load();
  const next = list.filter((e) => e.accountId !== accountId);
  if (next.length !== list.length) save(next);
}

// Merge fields into one entry (e.g. the thread id found later).
function patch(id, fields) {
  const list = load();
  const e = list.find((x) => x.id === id);
  if (!e) return null;
  Object.assign(e, fields);
  save(list);
  return e;
}

module.exports = { add, all, waiting, reconcile, forgetAccount, patch, FILE };
