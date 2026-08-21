const assert = require('node:assert');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

/**
 * The store decides which proxies are worth reusing, so its promotion and
 * retirement rules are the part most worth pinning down: a proxy wrongly kept
 * wastes attempts on every future run, and one wrongly retired throws away
 * something that was working.
 */

const STORE_FILE = path.join(__dirname, '..', 'data', 'proxies.json');
const MODULE = path.join(__dirname, '..', 'server', 'workers', 'proxyStore.js');

function freshStore() {
  fs.rmSync(STORE_FILE, { force: true });
  delete require.cache[require.resolve(MODULE)];
  return require(MODULE);
}

const A = { server: 'http://1.1.1.1:80', ip: '1.1.1.1', location: 'A' };
const B = { server: 'http://2.2.2.2:80', ip: '2.2.2.2', location: 'B' };

test('a proxy is stored once it produces a contact', () => {
  const store = freshStore();
  store.recordSuccess(A);
  store.recordSuccess(B);
  assert.strictEqual(store.size(), 2);
  assert.ok(store.has(A.server));
});

test('blocks under the limit do not retire a proxy', () => {
  const store = freshStore();
  store.recordSuccess(A);
  for (let i = 0; i < store.BLOCK_LIMIT - 1; i += 1) store.recordBlock(A.server);
  assert.strictEqual(store.size(), 1, 'still stored below the limit');
});

test('a proxy is retired once blocked past the limit', () => {
  const store = freshStore();
  store.recordSuccess(A);
  store.recordSuccess(B);
  for (let i = 0; i < store.BLOCK_LIMIT; i += 1) store.recordBlock(A.server);
  assert.ok(!store.has(A.server), 'the repeatedly blocked proxy is gone');
  assert.ok(store.has(B.server), 'the other one is untouched');
});

test('a later success claws back a block', () => {
  // Otherwise a long-serving proxy accumulates blocks forever and is retired
  // by ordinary noise rather than by being bad.
  const store = freshStore();
  store.recordSuccess(A);
  for (let i = 0; i < store.BLOCK_LIMIT - 1; i += 1) store.recordBlock(A.server);
  store.recordSuccess(A);
  store.recordBlock(A.server);
  assert.ok(store.has(A.server), 'the success bought it another block');
});

test('an unknown proxy cannot be blocked into existence', () => {
  const store = freshStore();
  assert.strictEqual(store.recordBlock('http://9.9.9.9:80'), false);
  assert.strictEqual(store.size(), 0);
});

test('the store survives a restart', async () => {
  const store = freshStore();
  store.recordSuccess(A);
  store.recordSuccess(B);
  // Saves are coalesced, so give the write a moment to land.
  await new Promise((r) => setTimeout(r, 2500));

  delete require.cache[require.resolve(MODULE)];
  const reloaded = require(MODULE);
  assert.strictEqual(reloaded.size(), 2, 'both proxies came back');
  assert.ok(reloaded.has(A.server));

  fs.rmSync(STORE_FILE, { force: true });
});
