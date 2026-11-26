'use strict';

require('dotenv').config();

const PORT = Number(process.env.PORT) || 3000;
const HEADLESS = process.env.HEADLESS === '1' || process.env.HEADLESS === 'true';

const base = `http://localhost:${PORT}`;

const config = {
  port: PORT,
  headless: HEADLESS,
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: `${base}/oauth/google/callback`,
    // compose: create and list drafts. metadata: headers only (sender, subject,
    // date) to notice replies to sent drafts; it cannot read message bodies.
    scope: ['https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/gmail.metadata'],
  },
  microsoft: {
    clientId: process.env.MICROSOFT_CLIENT_ID || '',
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET || '',
    redirectUri: `${base}/oauth/microsoft/callback`,
    authority: 'https://login.microsoftonline.com/consumers',
    scope: ['Mail.ReadWrite'],
  },
};

function missingEnv() {
  const missing = [];
  if (!config.google.clientId) missing.push('GOOGLE_CLIENT_ID');
  if (!config.google.clientSecret) missing.push('GOOGLE_CLIENT_SECRET');
  if (!config.microsoft.clientId) missing.push('MICROSOFT_CLIENT_ID');
  if (!config.microsoft.clientSecret) missing.push('MICROSOFT_CLIENT_SECRET');
  return missing;
}

module.exports = { ...config, missingEnv };
