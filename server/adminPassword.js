'use strict';

// The admin password, kept in data/admin.json as a salted scrypt hash (never
// the password itself). On first start, an ADMIN_PASSWORD still in .env is
// hashed into the file; after that .env doesn't need it.
// Reset it with: npm run admin-password

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, '..', 'data', 'admin.json');
const PARAMS = { N: 1 << 15, r: 8, p: 1, keylen: 64 };
const MAXMEM = 64 * 1024 * 1024;

function read() {
  try {
    const rec = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return rec && rec.algo === 'scrypt' && rec.salt && rec.hash ? rec : null;
  } catch {
    return null;
  }
}

function derive(password, salt, { N, r, p, keylen }) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(String(password), salt, keylen, { N, r, p, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)))
  );
}

const isSet = () => !!read();

async function set(password) {
  if (!password || String(password).length < 8) throw new Error('The admin password needs at least 8 characters.');
  const salt = crypto.randomBytes(16);
  const key = await derive(password, salt, PARAMS);
  const rec = { algo: 'scrypt', ...PARAMS, salt: salt.toString('base64'), hash: key.toString('base64'), updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

async function verify(password) {
  const rec = read();
  if (!rec) return false;
  const expected = Buffer.from(rec.hash, 'base64');
  const key = await derive(password, Buffer.from(rec.salt, 'base64'), { N: rec.N, r: rec.r, p: rec.p, keylen: expected.length });
  return crypto.timingSafeEqual(key, expected);
}

// Move a legacy ADMIN_PASSWORD from .env into the hashed file (once).
async function migrateFromEnv() {
  const legacy = process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  if (isSet()) {
    if (legacy) console.warn('[admin] ADMIN_PASSWORD in .env is ignored: the password lives in data/admin.json. Remove it from .env.');
    return;
  }
  if (!legacy) {
    console.warn('[admin] No admin password yet. Set one with: npm run admin-password');
    return;
  }
  const salt = crypto.randomBytes(16);
  const key = await derive(legacy, salt, PARAMS);
  const rec = { algo: 'scrypt', ...PARAMS, salt: salt.toString('base64'), hash: key.toString('base64'), updatedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 });
  console.log('[admin] Moved the admin password from .env into data/admin.json (hashed). Remove ADMIN_PASSWORD from .env.');
}

module.exports = { isSet, set, verify, migrateFromEnv, FILE };
