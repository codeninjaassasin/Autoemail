'use strict';

// Launches Chromium. Playwright makes a work folder in the OS temp dir on each
// launch; if that temp dir was removed after the server started (e.g. the
// server inherited a TMPDIR from a short-lived shell), every later launch
// fails with ENOENT. Recreate it first.
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');

function launchBrowser(opts) {
  try {
    fs.mkdirSync(os.tmpdir(), { recursive: true });
  } catch {
    /* launch reports the real problem */
  }
  return chromium.launch(opts);
}

module.exports = { launchBrowser };
