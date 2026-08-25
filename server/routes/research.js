const express = require('express');
const crypto = require('crypto');
const {
  runForever, CATEGORY_NAMES, ALL_CATEGORIES, requestStop,
} = require('../workers/publicPageScraper');
const proxyLease = require('../workers/proxyLease');
const proxyFinder = require('../workers/proxyFinder');
const postStore = require('../workers/postStore');
const contactStore = require('../workers/contactStore');

const router = express.Router();

/**
 * Scrapes run as background jobs.
 *
 * They used to run inside the request that started them, which is why posts
 * were capped: an uncapped area is hundreds of listings and tens of minutes,
 * and no browser waits that long for a response. The cap was protecting the
 * request, not the site. Starting a job and polling it removes that ceiling —
 * and makes a long run watchable, since rows appear as they land instead of
 * arriving all at once at the end.
 *
 * Jobs live in memory. A restart loses them, which is the right trade for a
 * local single-user tool; persisting them would mean a store to keep in sync
 * with runs that can't survive the restart anyway.
 */
const jobs = new Map();
const JOB_TTL_MS = 60 * 60 * 1000;

// Events kept per job. Deep enough to scroll back through a rough patch,
// shallow enough that the poll response stays small.
const MAX_EVENTS = 300;

function pushEvent(job, event) {
  job.eventSeq += 1;
  job.events.push({ ...event, seq: job.eventSeq });
  if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
}

function reapOldJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.finishedAt && job.finishedAt < cutoff) jobs.delete(id);
  }
}

router.post('/scrape', (req, res) => {
  const { areas, category, categories } = req.body ?? {};

  if (!Array.isArray(areas) || areas.length === 0) {
    return res.status(400).json({ error: 'areas must be a non-empty array.' });
  }

  const cleanAreas = areas.map((a) => String(a).trim().toLowerCase()).filter(Boolean);
  if (cleanAreas.length === 0) {
    return res.status(400).json({ error: 'No usable area codes in the request.' });
  }

  // `categories` is what the section checkboxes send. `category` is kept for
  // the older single-section callers; resolveCategories accepts either shape.
  //
  // Presence of the key is what decides, not its length: treating an empty
  // array as "unspecified" quietly fell back to the full default set, so
  // unticking every section scraped everything instead of refusing.
  let requested;
  if (Array.isArray(categories)) {
    requested = categories.map((c) => String(c).trim().toLowerCase()).filter(Boolean);
    if (requested.length === 0) {
      return res.status(400).json({ error: 'Select at least one section to scrape.' });
    }
  } else {
    requested = String(category || 'all').trim();
  }

  reapOldJobs();

  const id = crypto.randomUUID();
  const job = {
    id,
    status: 'running',
    areas: cleanAreas,
    startedAt: Date.now(),
    finishedAt: null,
    results: [],
    proxyCheck: null,
    planned: 0,
    error: null,
    stopRequested: false,
    currentLabel: 'checking proxies',
    // Live counters for the status panel. Separate from `results.length`,
    // which counts rows produced — including pre-research ones that belong to
    // no city's post total.
    stats: {
      phase: 'starting', area: null, totalPosts: 0, finishedPosts: 0,
      cycles: 0, workers: 0, queueDepth: 0, waiting: 0, freeMemMB: 0,
    },
    // A ring buffer, not a log: a long run emits thousands of events and the
    // panel only ever shows the tail. Keeping them all would grow without
    // bound in a process that never restarts between runs.
    events: [],
    eventSeq: 0,
  };
  jobs.set(id, job);

  // Deliberately not awaited: the response goes back now with an id to poll.
  // Never resolves on its own — it cycles until requestStop() is called.
  runForever(cleanAreas, requested, {
    // Finding proxies takes minutes before a single post is read, and without
    // this the page shows nothing the whole time — indistinguishable from a
    // hang. The label is the only signal there is until rows start arriving.
    onProgress: (label) => { job.currentLabel = label; },
    onRow: (row) => {
      job.results.push(row);
      // Persisted at the moment the row lands — the same moment it shows up
      // in the table. Only `contacts.emails`, so the file mirrors what the
      // table offers as recipients; role mailboxes are deliberately excluded
      // there and shouldn't slip into the list through this door.
      if (!row?.success) return;
      // Provenance travels with the contact so a saved address can be traced
      // back to the listing it came from.
      const added = contactStore.addContacts(row.contacts, {
        url: row.url,
        name: row.name,
        area: row.area,
        postedAt: row.postedAt,
      });
      const at = Date.now();
      for (const e of added.emails) pushEvent(job, { level: 'saved', at, msg: `saved ${e} → emails-pending.txt` });
      for (const p of added.phones) pushEvent(job, { level: 'saved', at, msg: `saved ${p} → phones.txt` });
      // A re-read that refreshed provenance rather than finding anything new.
      for (const v of added.updated) pushEvent(job, { level: 'saved', at, msg: `refreshed ${v} — listing re-read` });
    },
    // Patches, not replacements: the worker sends only what changed, so a
    // finished-count tick must not blank out the city it belongs to.
    onStats: (patch) => Object.assign(job.stats, patch),
    onEvent: (e) => pushEvent(job, e),
  })
    .then(() => {
      // The only way out is a stop. Rows were handed over as they landed, so
      // there is no final set to reconcile.
      job.status = 'stopped';
    })
    .catch((err) => {
      console.error('Scrape failed:', err);
      job.status = 'failed';
      job.error = err.message;
    })
    .finally(() => {
      job.finishedAt = Date.now();
      job.currentLabel = null;
      // There is no 'finished' any more — a run either stops or fails.
      job.stats.phase = job.status === 'failed' ? 'failed' : 'stopped';
      job.stats.area = null;
    });

  res.status(202).json({ jobId: id });
});

/**
 * Asks a running scrape to wind down.
 *
 * Cooperative: workers finish the post they are on, browsers get closed, and
 * the rows already collected are returned. Killing mid-post would leak a
 * Chromium per worker and lose contacts a moment from being saved — so this
 * returns immediately and the job reaches 'stopped' on its own.
 */
router.post('/scrape/:id/stop', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'No such job — it may have expired.' });
  if (job.status !== 'running') {
    return res.status(409).json({ error: `Job is already ${job.status}.`, status: job.status });
  }

  const already = job.stopRequested;
  const first = requestStop();
  job.stopRequested = true;
  job.currentLabel = 'stopping — finishing in-flight posts';
  if (first) pushEvent(job, { level: 'phase', at: Date.now(), msg: 'stop requested from the UI' });
  // In-flight posts are what the caller is now waiting on, so say how many.
  res.json({
    ok: true,
    status: 'stopping',
    already,
    inFlight: proxyLease.snapshot().working.length,
  });
});

router.get('/scrape/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'No such job — it may have expired.' });

  // Only what the client hasn't seen. Without this every poll re-sends the
  // whole buffer, and the panel can't tell a repeat from a new event.
  const since = Number(req.query.sinceEvent ?? 0);
  const events = Number.isFinite(since) ? job.events.filter((e) => e.seq > since) : job.events;

  res.json({
    id: job.id,
    status: job.status,
    stopRequested: job.stopRequested,
    error: job.error,
    areas: job.areas,
    proxyCheck: job.proxyCheck,
    currentLabel: job.currentLabel,
    planned: job.planned,
    completed: job.results.length,
    elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt,
    results: job.results,
    stats: job.stats,
    events,
    eventSeq: job.eventSeq,
    // Read live rather than stored on the job: the pool is a singleton whose
    // state changes between polls, and a copy taken when a row landed would
    // already be stale by the time it's drawn.
    proxies: proxyLease.snapshot(),
    contacts: contactStore.counts(),
    // How the two subsystems are doing, independently of each other.
    finder: proxyFinder.status(),
    posts: postStore.stats(),
  });
});

/**
 * The sections available to scrape, and which are on by default.
 *
 * Served rather than hard-coded in the page so the checkbox list and the
 * scraper can't drift — CATEGORY_NAMES is the one definition of what exists,
 * and CATEGORIES in .env still decides what starts ticked.
 */
router.get('/categories', (req, res) => {
  const defaults = new Set(ALL_CATEGORIES.map((c) => c.code));
  res.json({
    categories: Object.entries(CATEGORY_NAMES).map(([code, name]) => ({
      code,
      name,
      selected: defaults.has(code),
    })),
  });
});

/**
 * The stored contact lists.
 *
 * The table hides addresses that have already been drafted, and that used to
 * be browser memory alone — a reload brought every drafted row back, ticked.
 * Seeding from here makes the filter survive a restart of either end.
 */
router.get('/contacts', (req, res) => {
  res.json({ ...contactStore.counts(), drafted: contactStore.draftedList() });
});

/** The saved addresses or numbers themselves, for the clickable stat cards. */
router.get('/contacts/:kind', (req, res) => {
  const { kind } = req.params;
  if (kind !== 'emails' && kind !== 'phones') {
    return res.status(404).json({ error: 'kind must be emails or phones.' });
  }
  res.json({ kind, entries: contactStore.entries(kind) });
});

module.exports = router;
