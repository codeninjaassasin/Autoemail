const express = require('express');
const { scrapeAreas } = require('../workers/publicPageScraper');

const router = express.Router();

router.post('/scrape', async (req, res) => {
  const { areas, category } = req.body ?? {};

  if (!Array.isArray(areas) || areas.length === 0) {
    return res.status(400).json({ error: 'areas must be a non-empty array.' });
  }

  const cleanAreas = areas.map((a) => String(a).trim().toLowerCase()).filter(Boolean);
  const cleanCategory = String(category || 'jjj').trim();

  try {
    const results = await scrapeAreas(cleanAreas, cleanCategory);
    res.json({ results });
  } catch (err) {
    console.error('Scrape failed:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;