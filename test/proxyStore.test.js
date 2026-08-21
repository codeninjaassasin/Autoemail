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

test('the store survives a restart', () => {
  const store = freshStore();
  store.recordSuccess(A);
  store.recordSuccess(B);

  // No waiting: a deferred write was being lost when the process exited
  // first, so an entire run's proven proxies vanished. Saves are synchronous
  // and this asserts the file is on disk by the time recordSuccess returns.
  assert.ok(fs.existsSync(STORE_FILE), 'written before the call returns');

  delete require.cache[require.resolve(MODULE)];
  const reloaded = require(MODULE);
  assert.strictEqual(reloaded.size(), 2, 'both proxies came back');
  assert.ok(reloaded.has(A.server));

  fs.rmSync(STORE_FILE, { force: true });
});

test('reachable proxies are remembered so a restart need not re-sweep', () => {
  const store = freshStore();
  store.recordReachable({ server: 'http://3.3.3.3:80', ip: '3.3.3.3', location: 'C' });
  assert.strictEqual(store.freshReachable().length, 1);

  delete require.cache[require.resolve(MODULE)];
  const reloaded = require(MODULE);
  assert.strictEqual(reloaded.freshReachable().length, 1, 'survives a restart');

  fs.rmSync(STORE_FILE, { force: true });
});

test('a proven proxy is not offered again as merely reachable', () => {
  // Otherwise the same proxy is seeded twice and the pool double-counts it.
  const store = freshStore();
  store.recordReachable(A);
  store.recordSuccess(A);
  assert.strictEqual(store.freshReachable().length, 0, 'proven takes precedence');
  assert.strictEqual(store.size(), 1);

  fs.rmSync(STORE_FILE, { force: true });
});

test('a dead proxy is dropped from both tiers', () => {
  const store = freshStore();
  store.recordReachable(B);
  store.recordSuccess(B);
  store.remove(B.server);
  store.forget(B.server);
  assert.strictEqual(store.size(), 0);
  assert.strictEqual(store.freshReachable().length, 0);

  fs.rmSync(STORE_FILE, { force: true });
});
