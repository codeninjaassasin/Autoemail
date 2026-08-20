const express = require('express');
const crypto = require('crypto');
const { scrapeAreas } = require('../workers/publicPageScraper');

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

function reapOldJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.finishedAt && job.finishedAt < cutoff) jobs.delete(id);
  }
}

router.post('/scrape', (req, res) => {
  const { areas, category } = req.body ?? {};

  if (!Array.isArray(areas) || areas.length === 0) {
    return res.status(400).json({ error: 'areas must be a non-empty array.' });
  }

  const cleanAreas = areas.map((a) => String(a).trim().toLowerCase()).filter(Boolean);
  const cleanCategory = String(category || 'all').trim();

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
    currentLabel: 'checking proxies',
  };
  jobs.set(id, job);

  // Deliberately not awaited: the response goes back now with an id to poll.
  scrapeAreas(cleanAreas, cleanCategory, {
    onPreflight: (report) => {
      job.proxyCheck = report;
      job.currentLabel = 'reading listings';
    },
    onCategory: ({ area, categoryName, planned }) => {
      job.planned += planned;
      job.currentLabel = `${area} · ${categoryName}`;
    },
    onRow: (row) => job.results.push(row),
  })
    .then((results) => {
      // The callback already collected rows; trust the return value as the
      // authoritative set in case anything was added outside a category loop.
      if (results.length >= job.results.length) job.results = results;
      job.status = 'done';
    })
    .catch((err) => {
      console.error('Scrape failed:', err);
      job.status = 'failed';
      job.error = err.message;
    })
    .finally(() => {
      job.finishedAt = Date.now();
      job.currentLabel = null;
    });

  res.status(202).json({ jobId: id });
});

router.get('/scrape/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'No such job — it may have expired.' });

  res.json({
    id: job.id,
    status: job.status,
    error: job.error,
    areas: job.areas,
    proxyCheck: job.proxyCheck,
    currentLabel: job.currentLabel,
    planned: job.planned,
    completed: job.results.length,
    elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt,
    results: job.results,
  });
});

module.exports = router;
