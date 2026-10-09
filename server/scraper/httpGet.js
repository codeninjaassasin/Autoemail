'use strict';

const https = require('https');
const http = require('http');
const zlib = require('zlib');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Plain HTTP(S) GET with a browser-like UA, redirect following, gzip/br
// handling and a timeout. Returns { status, html, url }. Craigslist serves its
// pages to a normal HTTP client (200) while 403-blocking headless browsers, so
// the scraper fetches with this instead of driving Chromium — no bot
// fingerprint, no browser process, far faster.
function httpGet(url, { timeout = 20000, maxRedirects = 6 } = {}) {
  return new Promise((resolve, reject) => {
    const visit = (target, redirects) => {
      if (redirects > maxRedirects) return reject(new Error('too many redirects'));
      let mod;
      try {
        mod = new URL(target).protocol === 'http:' ? http : https;
      } catch (e) {
        return reject(e);
      }
      const req = mod.get(
        target,
        {
          headers: {
            'User-Agent': UA,
            Accept: 'text/html,application/xhtml+xml',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
          },
          timeout,
        },
        (res) => {
          const { statusCode, headers } = res;
          if ([301, 302, 303, 307, 308].includes(statusCode) && headers.location) {
            res.resume();
            const next = new URL(headers.location, target).toString();
            return visit(next, redirects + 1);
          }
          const enc = (headers['content-encoding'] || '').toLowerCase();
          let stream = res;
          if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
          else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
          else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('end', () =>
            resolve({ status: statusCode, html: Buffer.concat(chunks).toString('utf8'), url: target })
          );
          stream.on('error', reject);
        }
      );
      req.on('timeout', () => req.destroy(new Error('Timeout')));
      req.on('error', reject);
    };
    visit(url, 0);
  });
}

module.exports = { httpGet, UA };
