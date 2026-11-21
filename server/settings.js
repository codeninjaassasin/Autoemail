'use strict';

// Shared UI settings (area/category selections, run parameters, filters, panel
// states), stored on the server so every device that opens the page gets the
// same settings. data/settings.json: { version, updatedAt, updatedBy, prefs }.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'settings.json');

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!cache || typeof cache.prefs !== 'object' || cache.prefs === null) throw new Error('bad file');
    cache.version = Number(cache.version) || 0;
  } catch {
    cache = { version: 0, updatedAt: null, updatedBy: null, prefs: {} };
  }
  return cache;
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, FILE); // atomic: a crash never leaves a half-written file
}

function get() {
  return load();
}

// Merge top-level keys of `patch` into the stored prefs (a key set to null is
// removed). Each save bumps the version so other devices can pick it up.
function patch(changes, clientId) {
  load();
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return cache;
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) delete cache.prefs[k];
    else cache.prefs[k] = v;
  }
  cache.version += 1;
  cache.updatedAt = new Date().toISOString();
  cache.updatedBy = clientId ? String(clientId).slice(0, 64) : null;
  save();
  return cache;
}

module.exports = { get, patch, FILE };
