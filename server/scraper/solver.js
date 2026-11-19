'use strict';

// hCaptcha solver plug-in point.
//
// Craigslist gates the reply relay behind hCaptcha on /reply/.../init, which
// returns { siteKey_hCaptcha, nonce }. To obtain the relay email the app must
// solve that hCaptcha and re-request the reply endpoint with the token + nonce.
//
// This requires a third-party solving service (2captcha, anti-captcha, capsolver
// …). Configure via .env:
//   CAPTCHA_SOLVER=2captcha
//   CAPTCHA_SOLVER_KEY=<your api key>
//
// Until a key is set, isConfigured() is false and the scraper falls back to
// ad-text contacts only.

const PROVIDER = process.env.CAPTCHA_SOLVER || '';
const KEY = process.env.CAPTCHA_SOLVER_KEY || '';

function isConfigured() {
  return !!(PROVIDER && KEY);
}

// Solve an hCaptcha for the given siteKey + page URL. Returns the token string,
// or null if unconfigured / failed. Implement per provider when a key exists.
async function solveHcaptcha(siteKey, pageUrl) {
  if (!isConfigured()) return null;
  // TODO: call the configured provider's API (create task, poll for token).
  // Left unimplemented until a provider + key are supplied.
  throw new Error(`CAPTCHA_SOLVER "${PROVIDER}" configured but solveHcaptcha() not implemented yet.`);
}

module.exports = { isConfigured, solveHcaptcha, PROVIDER };
