const express = require('express');
const store = require('../store');

const router = express.Router();

router.get('/', (req, res) => {
  const accounts = store.readAccounts().map(({ id, provider, emailAddress }) => ({ id, provider, emailAddress }));
  res.json(accounts);
});

router.post('/:id/disconnect', (req, res) => {
  const removed = store.removeAccount(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Account not found' });
  res.json({ ok: true });
});

module.exports = router;
