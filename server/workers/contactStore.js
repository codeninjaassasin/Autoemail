const fs = require('fs');
const path = require('path');

/**
 * The scraped contacts, on disk, as tab-separated lists: `value<TAB>link`.
 *
 * A run's results live only in the job's memory and the browser's table, so
 * stopping the server — or closing the tab — threw away every address that
 * hadn't been turned into a draft yet. These files are the durable copy.
 *
 * Written as each row lands rather than at the end of a run: a scrape takes
 * tens of minutes and is routinely interrupted, and a file that only appears
 * on clean completion is exactly the file you don't have when you need it.
 *
 * The listing URL sits on the line beside the contact. A bare phone number is
 * close to useless on its own — you cannot tell whose it is — and the same
 * goes for a relay address. Tab-separated rather than JSON so the files stay
 * greppable and paste into a spreadsheet, and `cut -f1` still gives the plain
 * list. Lines written before this carried no URL and read back fine.
 *
 * Three files, not two. "Not drafted" is a difference between two sets, so
 * the drafted ones have to be recorded somewhere or the distinction dies at
 * restart and every address you've already written to comes back as pending.
 */

const STORE_DIR = process.env.CONTACT_STORE_DIR || path.join(__dirname, '..', '..', 'data');
const EMAILS_PENDING_FILE = path.join(STORE_DIR, 'emails-pending.txt');
const EMAILS_DRAFTED_FILE = path.join(STORE_DIR, 'emails-drafted.txt');
const PHONES_FILE = path.join(STORE_DIR, 'phones.txt');
// The rest of the provenance — listing title, area, posted date. The URL is
// not read from here: it lives on the contact's own line, which is the record
// that can't drift from the value it belongs to.
//
// JSONL, appended a line at a time. A single JSON object would have to be
// re-serialised on every contact — thousands of times over a run — for a file
// that is only ever added to.
const META_FILE = path.join(STORE_DIR, 'contacts-meta.jsonl');

// Keyed for dedupe, valued with the text as it was scraped. Addresses differing
// only in case are one address in practice, and the same number turns up as
// "(415) 555-0134" and "415-555-0134" in different ads — deduping on the raw
// string would file both.
const keyEmail = (v) => String(v).trim().toLowerCase();
const keyPhone = (v) => String(v).replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');

/**
 * Scraped text is untrusted: a tab or newline inside a value would split one
 * record into two and corrupt every line after it.
 */
const clean = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();

/** One stored record as a file line — the URL omitted when there isn't one. */
function toLine({ value, url }) {
  return url ? `${clean(value)}\t${clean(url)}` : clean(value);
}

// key -> { value, url }
let pending = new Map();
let drafted = new Map();
let phones = new Map();
// `${kind}:${key}` -> { name, area, postedAt, at }
let meta = new Map();
let loaded = false;
// Lines physically in the metadata file, against entries actually live in it.
// Appends outpace the live set once every read confirms every contact.
let metaLines = 0;
const META_COMPACT_RATIO = Number(process.env.CONTACT_META_COMPACT_RATIO ?? 4);
const META_COMPACT_MIN = Number(process.env.CONTACT_META_COMPACT_MIN ?? 2000);

function readFile(file, keyOf) {
  const out = new Map();
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      // Split on the first tab only; everything after it is the URL. Lines
      // saved before URLs were stored have no tab and yield url = null.
      const tab = line.indexOf('\t');
      const value = (tab === -1 ? line : line.slice(0, tab)).trim();
      const url = tab === -1 ? null : line.slice(tab + 1).trim() || null;
      if (!value) continue;
      const key = keyOf(value);
      if (key) out.set(key, { value, url });
    }
  } catch {
    // No file yet — an empty list is the correct starting state.
  }
  return out;
}

function readMeta() {
  const out = new Map();
  metaLines = 0;
  try {
    for (const line of fs.readFileSync(META_FILE, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      metaLines += 1;
      try {
        const row = JSON.parse(line);
        // Last write wins: a listing re-scraped later carries fresher details.
        if (row?.k) out.set(row.k, row);
      } catch {
        // One corrupt line must not cost the whole file.
      }
    }
  } catch {
    // No metadata yet — entries saved before this existed simply have none.
  }
  return out;
}

function load() {
  if (loaded) return;
  loaded = true;
  pending = readFile(EMAILS_PENDING_FILE, keyEmail);
  drafted = readFile(EMAILS_DRAFTED_FILE, keyEmail);
  phones = readFile(PHONES_FILE, keyPhone);
  meta = readMeta();
}

/**
 * Records where a contact came from, on every read.
 *
 * Written even when nothing about the listing changed. A re-read that finds
 * the post exactly as it was is not a no-op — it is proof the listing is still
 * live and the address still current, and `at` is the only place that fact is
 * recorded. Without it there is no way to tell a contact confirmed a minute
 * ago from one last seen a week ago.
 *
 * The file is append-only, so this does grow; compaction below keeps it in
 * proportion to the number of contacts rather than to the number of reads.
 */
function recordMeta(kind, key, value, source) {
  if (!source?.url) return false;
  const k = `${kind}:${key}`;
  const prev = meta.get(k);

  const row = {
    k,
    value,
    url: source.url,
    name: source.name ?? null,
    area: source.area ?? null,
    postedAt: source.postedAt ?? null,
    at: new Date().toISOString(),
    // How many reads have confirmed this contact. A high count on a listing
    // that is still live is the strongest signal an address is real.
    seen: (prev?.seen ?? 0) + 1,
  };
  meta.set(k, row);
  appendRaw(META_FILE, JSON.stringify(row));
  metaLines += 1;
  compactMetaIfBloated();
  return true;
}

/**
 * Rewrites the metadata file from memory once appends have outgrown it.
 *
 * Confirming every contact on every re-read means one line per contact per
 * pass, so the file would grow without bound while the live set stays the same
 * size. Only the last line for each key matters on load, so the rest is dead
 * weight.
 */
function compactMetaIfBloated() {
  if (metaLines < META_COMPACT_MIN || metaLines < meta.size * META_COMPACT_RATIO) return;
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(
      META_FILE,
      [...meta.values()].map((r) => `${JSON.stringify(r)}\n`).join('')
    );
    metaLines = meta.size;
  } catch (err) {
    console.error('[contacts] could not compact metadata:', err.message);
  }
}

/**
 * Drops every contact that came from a listing which no longer exists.
 *
 * A deleted or expired post takes its contacts with it: a Craigslist relay
 * address stops routing the moment the listing goes, so keeping it in the
 * recipient list means drafting to an address that bounces.
 *
 * Drafted addresses are left alone — a draft already exists for those, and
 * removing them here would let the same address return to pending on a later
 * scrape and be drafted a second time.
 */
function removeForPost(url) {
  load();
  const target = clean(url);
  if (!target) return { emails: [], phones: [] };

  const removed = { emails: [], phones: [] };
  let touchedEmails = false;
  let touchedPhones = false;

  for (const [k, row] of [...meta]) {
    if (row.url !== target) continue;
    const [kind, key] = [k.slice(0, 1), k.slice(2)];

    if (kind === 'e' && pending.has(key)) {
      removed.emails.push(pending.get(key).value);
      pending.delete(key);
      meta.delete(k);
      touchedEmails = true;
    } else if (kind === 'p' && phones.has(key)) {
      removed.phones.push(phones.get(key).value);
      phones.delete(key);
      meta.delete(k);
      touchedPhones = true;
    }
  }

  if (touchedEmails) rewrite(EMAILS_PENDING_FILE, pending);
  if (touchedPhones) rewrite(PHONES_FILE, phones);
  // Entries were deleted from the map, so the file no longer matches it.
  if (touchedEmails || touchedPhones) {
    metaLines = Number.MAX_SAFE_INTEGER;
    compactMetaIfBloated();
  }
  return removed;
}

/**
 * Appends rather than rewrites.
 *
 * This runs once per contact while thirty workers are producing them, so
 * rewriting the whole file each time would mean re-serialising the entire
 * list thousands of times over a run. Synchronous because the deferred write
 * is the one that gets lost when the process is stopped mid-run — the same
 * mistake the proxy store had to be cured of.
 */
function appendRaw(file, line) {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.appendFileSync(file, `${line}\n`);
  } catch (err) {
    console.error(`[contacts] could not append to ${path.basename(file)}:`, err.message);
  }
}

/** Appends one contact record as `value<TAB>link`. */
function appendRecord(file, record) {
  appendRaw(file, toLine(record));
}

function rewrite(file, map) {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(file, [...map.values()].map((r) => `${toLine(r)}\n`).join(''));
  } catch (err) {
    console.error(`[contacts] could not write ${path.basename(file)}:`, err.message);
  }
}

/**
 * Records one scraped row's contacts. Returns what was actually new, so the
 * caller can report it without re-reading the files.
 *
 * Addresses already drafted are skipped: they are not pending, and re-adding
 * one on a later scrape of the same listing would queue a second draft to
 * somebody who has already had one.
 */
function addContacts({ emails = [], phones: numbers = [] } = {}, source = null) {
  load();
  const added = { emails: [], phones: [], updated: [] };

  // The listing the contact came from, stored on the same line as the value.
  const url = clean(source?.url) || null;

  for (const raw of emails) {
    const value = clean(raw);
    const key = keyEmail(value);
    if (!key) continue;

    // Already written to. It must not go back into pending, but its
    // provenance is still worth refreshing — the listing may have been edited
    // since, and the record should describe the post as it is now.
    if (drafted.has(key)) {
      if (recordMeta('e', key, value, source)) added.updated.push(value);
      continue;
    }

    // Seen on an earlier pass. The address is unchanged so the list needs no
    // new line, but a re-read means fresher details: posted date, title, and
    // possibly a different listing carrying the same address.
    if (pending.has(key)) {
      if (recordMeta('e', key, value, source)) added.updated.push(value);
      continue;
    }

    const record = { value, url };
    pending.set(key, record);
    appendRecord(EMAILS_PENDING_FILE, record);
    recordMeta('e', key, value, source);
    added.emails.push(value);
  }

  for (const raw of numbers) {
    const value = clean(raw);
    const key = keyPhone(value);
    if (!key) continue;

    if (phones.has(key)) {
      if (recordMeta('p', key, value, source)) added.updated.push(value);
      continue;
    }

    const record = { value, url };
    phones.set(key, record);
    appendRecord(PHONES_FILE, record);
    recordMeta('p', key, value, source);
    added.phones.push(value);
  }

  return added;
}

/**
 * The saved contacts with whatever provenance we have, newest first.
 *
 * `kind` is 'emails' (the pending ones — drafted addresses have left the list)
 * or 'phones'. Entries saved before metadata existed come back with a null
 * url; the caller shows those without a link rather than hiding them.
 */
function entries(kind) {
  load();
  const isEmail = kind === 'emails';
  const src = isEmail ? pending : phones;
  const prefix = isEmail ? 'e' : 'p';

  const out = [];
  for (const [key, record] of src) {
    const m = meta.get(`${prefix}:${key}`);
    out.push({
      value: record.value,
      // The line's own URL wins — it travels with the value and survives even
      // when the metadata sidecar is missing or was deleted.
      url: record.url ?? m?.url ?? null,
      name: m?.name ?? null,
      area: m?.area ?? null,
      postedAt: m?.postedAt ?? null,
      at: m?.at ?? null,
    });
  }
  // Undated entries (pre-metadata) sort last rather than being interleaved
  // arbitrarily among the dated ones.
  out.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  return out;
}

/**
 * Moves addresses out of pending once a draft exists for them.
 *
 * Pending is rewritten because entries are leaving it, which append can't
 * express. It happens once per Create Drafts click rather than once per
 * contact, so the cost is nothing.
 */
function markDrafted(emails = []) {
  load();
  let moved = 0;
  for (const raw of emails) {
    const value = clean(raw);
    const key = keyEmail(value);
    if (!key || drafted.has(key)) continue;
    // Carries the link across with it — an address that has been written to is
    // exactly the one you may need to trace back to its listing later.
    const record = pending.get(key) ?? { value, url: null };
    drafted.set(key, record);
    appendRecord(EMAILS_DRAFTED_FILE, record);
    if (pending.delete(key)) moved += 1;
  }
  if (moved > 0) rewrite(EMAILS_PENDING_FILE, pending);
  return moved;
}

function counts() {
  load();
  return { pending: pending.size, drafted: drafted.size, phones: phones.size };
}

/** The drafted addresses, so the table can stay filtered across a reload. */
function draftedList() {
  load();
  return [...drafted.keys()];
}

module.exports = {
  addContacts, markDrafted, counts, draftedList, entries, removeForPost,
  EMAILS_PENDING_FILE, EMAILS_DRAFTED_FILE, PHONES_FILE, META_FILE,
};
