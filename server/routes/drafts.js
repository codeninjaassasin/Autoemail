const express = require('express');
const store = require('../store');
const googleProvider = require('../providers/googleProvider');
const microsoftProvider = require('../providers/microsoftProvider');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PROVIDERS = {
  google: googleProvider,
  microsoft: microsoftProvider,
};

router.post('/', async (req, res) => {
  const { fromAccountIds, subject, bodyHtml, recipients } = req.body || {};

  if (!Array.isArray(fromAccountIds) || fromAccountIds.length === 0) {
    return res.status(400).json({ error: 'fromAccountIds must be a non-empty array' });
  }
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ error: 'recipients must be a non-empty array' });
  }

  const accounts = fromAccountIds.map((id) => store.getAccount(id));
  const missingIndex = accounts.findIndex((a) => !a);
  if (missingIndex !== -1) {
    return res.status(404).json({ error: `Account not found: ${fromAccountIds[missingIndex]}` });
  }
  const unsupported = accounts.find((a) => !PROVIDERS[a.provider]);
  if (unsupported) {
    return res.status(400).json({ error: `Unsupported provider: ${unsupported.provider}` });
  }

  const results = [];
  let rotation = 0;
  for (const recipient of recipients) {
    const to = String(recipient).trim();
    if (!EMAIL_RE.test(to)) {
      results.push({ recipient: to, success: false, error: 'Invalid email address' });
      continue;
    }

    const account = accounts[rotation % accounts.length];
    rotation += 1;
    const provider = PROVIDERS[account.provider];

    try {
      const { draftId } = await provider.createDraft({
        accountId: account.id,
        to,
        subject: subject || '',
        bodyHtml: bodyHtml || '',
      });
      results.push({
        recipient: to,
        accountId: account.id,
        accountEmail: account.emailAddress,
        provider: account.provider,
        success: true,
        draftId,
      });
    } catch (err) {
      console.error(`Draft creation failed for ${to}:`, err);
      const status = err.code || err.status || err.response?.status;
      const isAuthError = status === 401 || status === 403 || /invalid_grant|invalid credentials|unauthorized/i.test(err.message);
      const message = isAuthError
        ? 'Authorization expired or revoked — please reconnect this account.'
        : err.message;
      results.push({
        recipient: to,
        accountId: account.id,
        accountEmail: account.emailAddress,
        provider: account.provider,
        success: false,
        error: message,
      });
    }
  }

  res.json({ results });
});

module.exports = router;
