'use strict';

// Email templates (name, subject, plain multi-line body), shared by every device.
// data/templates.json: Array<{ id, name, subject, body, createdAt, updatedAt }>.
// The body is plain text: each line becomes one line in the draft, blank lines
// stay blank (see drafts/merge.js). Older templates saved as HTML (`bodyHtml`)
// are read as text.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, '..', 'data', 'templates.json');
const MAX_NAME = 80;
const MAX_SUBJECT = 300;
const MAX_BODY = 50 * 1024;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function htmlToText(html) {
  return String(html || '')
    .replace(/\r/g, '')
    .replace(/<(p|div)>\s*<br\s*\/?>\s*<\/\1>/gi, '\n') // an empty paragraph: one blank line
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+|#39);/gi, (m, e) => {
      if (ENTITIES[e.toLowerCase()] !== undefined) return ENTITIES[e.toLowerCase()];
      if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return m;
    })
    .replace(/\n+$/, '');
}

function normalize(t) {
  if (typeof t.body === 'string') return t;
  const { bodyHtml, ...rest } = t;
  return { ...rest, body: htmlToText(bodyHtml) };
}

function load() {
  try {
    const list = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(list) ? list.map(normalize) : [];
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
  const subject = String(input?.subject ?? '').replace(/[\r\n]+/g, ' ').slice(0, MAX_SUBJECT);
  const body = String(input?.body ?? '').replace(/\r\n?/g, '\n');
  if (!name) throw new Error('Give the template a name.');
  if (!subject.trim()) throw new Error('Write a subject.');
  if (!body.trim()) throw new Error('Write the email body.');
  if (body.length > MAX_BODY) throw new Error('The template body is too large.');
  return { name, subject, body };
}

function list() {
  return load().sort((a, b) => a.name.localeCompare(b.name));
}

function get(id) {
  return load().find((t) => t.id === id) || null;
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

module.exports = { list, get, create, update, remove, htmlToText, FILE };
