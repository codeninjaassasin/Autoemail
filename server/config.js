require('dotenv').config();

const required = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'];
const missing = required.filter((key) => !process.env[key]);

if (missing.length > 0) {
  console.warn(
    `Warning: missing env vars: ${missing.join(', ')}. ` +
      'Copy .env.example to .env and fill in your OAuth credentials before connecting accounts. ' +
      'See README.md for setup steps.'
  );
}

const port = Number(process.env.PORT) || 3000;
const baseUrl = `http://localhost:${port}`;

module.exports = {
  port,
  baseUrl,
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: `${baseUrl}/oauth/google/callback`,
    scope: 'https://www.googleapis.com/auth/gmail.compose',
  },
  microsoft: {
    clientId: process.env.MICROSOFT_CLIENT_ID,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    redirectUri: `${baseUrl}/oauth/microsoft/callback`,
    authority: 'https://login.microsoftonline.com/consumers',
    scope: 'Mail.ReadWrite offline_access',
  },
};
