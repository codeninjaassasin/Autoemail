const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(ACCOUNTS_FILE)) fs.writeFileSync(ACCOUNTS_FILE, '[]');
}

function readAccounts() {
  ensureDataFile();
  return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
}

function writeAccounts(accounts) {
  ensureDataFile();
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
}

function addAccount(account) {
  const accounts = readAccounts();
  const existingIndex = accounts.findIndex(
    (a) => a.provider === account.provider && a.emailAddress === account.emailAddress
  );
  if (existingIndex >= 0) {
    accounts[existingIndex] = { ...accounts[existingIndex], ...account };
  } else {
    accounts.push(account);
  }
  writeAccounts(accounts);
  return account;
}

function getAccount(id) {
  return readAccounts().find((a) => a.id === id);
}

function updateAccount(id, patch) {
  const accounts = readAccounts();
  const index = accounts.findIndex((a) => a.id === id);
  if (index === -1) return null;
  accounts[index] = { ...accounts[index], ...patch };
  writeAccounts(accounts);
  return accounts[index];
}

function removeAccount(id) {
  const accounts = readAccounts();
  const next = accounts.filter((a) => a.id !== id);
  writeAccounts(next);
  return next.length !== accounts.length;
}

module.exports = { readAccounts, writeAccounts, addAccount, getAccount, updateAccount, removeAccount };
