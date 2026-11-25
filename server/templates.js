'use strict';

// Email templates (name, subject, HTML body), shared by every device.
// data/templates.json: Array<{ id, name, subject, bodyHtml, createdAt, updatedAt }>.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, '..', 'data', 'templates.json');
const MAX_NAME = 80;
const MAX_SUBJECT = 300;
const MAX_BODY = 200 * 1024;

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

function clean(input) {
  const name = String(input?.name ?? '').trim().slice(0, MAX_NAME);
  const subject = String(input?.subject ?? '').slice(0, MAX_SUBJECT);
  const bodyHtml = String(input?.bodyHtml ?? '');
  if (!name) throw new Error('Give the template a name.');
  if (bodyHtml.length > MAX_BODY) throw new Error('The template body is too large.');
  return { name, subject, bodyHtml };
}

function list() {
  return load().sort((a, b) => a.name.localeCompare(b.name));
}

function create(input) {
  const fields = clean(input);
  const all = load();
  if (all.some((t) => t.name.toLowerCase() === fields.name.toLowerCase()))
    throw new Error(`A template named "${fields.name}" already exists.`);
  const now = new Date().toISOString();
  const tpl = { id: crypto.randomUUID(), ...fields, createdAt: now, updatedAt: now };
  all.push(tpl);
  save(all);
  return tpl;
}

function update(id, input) {
  const fields = clean(input);
  const all = load();
  const idx = all.findIndex((t) => t.id === id);
  if (idx < 0) throw new Error('That template no longer exists.');
  if (all.some((t) => t.id !== id && t.name.toLowerCase() === fields.name.toLowerCase()))
    throw new Error(`A template named "${fields.name}" already exists.`);
  all[idx] = { ...all[idx], ...fields, updatedAt: new Date().toISOString() };
  save(all);
  return all[idx];
}

function remove(id) {
  const all = load();
  const next = all.filter((t) => t.id !== id);
  if (next.length !== all.length) save(next);
  return next.length !== all.length;
}

module.exports = { list, create, update, remove, FILE };
