'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, '..', 'data', 'accounts.json');

function ensureDir() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return [];
  }
}

function save(list) {
  ensureDir();
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}

function list() {
  return load().map((a) => ({
    id: a.id,
    provider: a.provider,
    emailAddress: a.emailAddress,
  }));
}

function all() {
  return load();
}

function get(id) {
  return load().find((a) => a.id === id) || null;
}

// Upsert by provider+email so re-connecting refreshes tokens instead of duplicating.
function upsert(account) {
  const accounts = load();
  const idx = accounts.findIndex(
    (a) => a.provider === account.provider && a.emailAddress === account.emailAddress
  );
  if (idx >= 0) {
    account.id = accounts[idx].id;
    accounts[idx] = { ...accounts[idx], ...account };
  } else {
    account.id = account.id || crypto.randomUUID();
    accounts.push(account);
  }
  save(accounts);
  return account;
}

function update(id, patch) {
  const accounts = load();
  const idx = accounts.findIndex((a) => a.id === id);
  if (idx < 0) return null;
  accounts[idx] = { ...accounts[idx], ...patch };
  save(accounts);
  return accounts[idx];
}

function remove(id) {
  save(load().filter((a) => a.id !== id));
}

module.exports = { list, all, get, upsert, update, remove };
