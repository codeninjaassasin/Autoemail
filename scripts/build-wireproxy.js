#!/usr/bin/env node
/**
 * Turns each WireGuard config in proxies/ into a wireproxy config exposing a
 * local SOCKS5 port.
 *
 * wireproxy speaks WireGuard entirely in userspace and hands out a SOCKS5
 * proxy, so nothing touches the host routing table and no TUN device is
 * created. That means no sudo, no Docker, no Linux VM — and because each
 * instance is just a process with its own port, all of them run at once, which
 * is what per-post rotation needs.
 *
 * The WireGuard Endpoint is left as the hostname from the original config:
 * Surfshark round-robins those across servers holding different peer keys, so
 * resolving and pinning one address risks pairing a key with a server that
 * doesn't own it.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONF_DIR = fs.existsSync(path.join(ROOT, 'proxies'))
  ? path.join(ROOT, 'proxies')
  : path.join(ROOT, 'Proxies');
const OUT_DIR = path.join(ROOT, 'vpn', 'wireproxy');
const BASE_PORT = Number(process.env.SOCKS_BASE_PORT ?? 9001);

const field = (text, key) => {
  const m = text.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm'));
  return m ? m[1].trim() : '';
};

const files = fs.readdirSync(CONF_DIR).filter((f) => f.endsWith('.conf')).sort();
if (files.length === 0) {
  console.error(`No .conf files in ${CONF_DIR}`);
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const entries = [];

// Surfshark issues one client key per account and rotating it invalidates the
// previous one, so downloading configs at different times leaves all but the
// newest holding a dead key. The key is not tied to a server, though — the
// newest one authenticates against every endpoint — so take it from the most
// recently written config and pair it with each server's own peer block.
// Surfshark also hands out templates with the key field left as a
// placeholder. Those look newest by timestamp and would replace a working key
// with something that isn't base64, taking every tunnel down at once — so
// only a real key counts as a candidate.
const isRealKey = (k) => /^[A-Za-z0-9+/]{42,43}=$/.test(k);

const candidates = files
  .map((f) => {
    const text = fs.readFileSync(path.join(CONF_DIR, f), 'utf8');
    return { f, text, key: field(text, 'PrivateKey'), mtime: fs.statSync(path.join(CONF_DIR, f)).mtimeMs };
  })
  .filter((c) => isRealKey(c.key))
  .sort((a, b) => b.mtime - a.mtime);

const skipped = files.length - candidates.length;
if (candidates.length === 0) {
  console.error('No config contains a usable private key — every one is a placeholder.');
  console.error('In the Surfshark dashboard, generate a key pair and download configs that include it.');
  process.exit(1);
}

const ACCOUNT_KEY = candidates[0].key;
const ACCOUNT_ADDRESS = field(candidates[0].text, 'Address');
if (skipped > 0) {
  console.log(`Ignored ${skipped} config(s) with a placeholder key (no key filled in).`);
}
console.log(`Using the client key from ${candidates[0].f} (most recent real key) for all tunnels.\n`);

files.forEach((file, i) => {
  const text = fs.readFileSync(path.join(CONF_DIR, file), 'utf8');
  const name = path.basename(file, '.conf');
  const port = BASE_PORT + i;

  // Interface comes from the account's live key; only the peer varies.
  const conf =
    `[Interface]\n` +
    `PrivateKey = ${ACCOUNT_KEY}\n` +
    `Address = ${ACCOUNT_ADDRESS}\n` +
    `DNS = ${(field(text, 'DNS') || '1.1.1.1').split(',')[0].trim()}\n` +
    `\n[Peer]\n` +
    `PublicKey = ${field(text, 'PublicKey')}\n` +
    `Endpoint = ${field(text, 'Endpoint')}\n` +
    `AllowedIPs = 0.0.0.0/0\n` +
    `PersistentKeepalive = 25\n` +
    `\n[Socks5]\n` +
    `BindAddress = 127.0.0.1:${port}\n`;

  const out = path.join(OUT_DIR, `${name}.conf`);
  fs.writeFileSync(out, conf);
  fs.chmodSync(out, 0o600);
  entries.push({ name, port, file: out });
});

const list = entries.map((e) => `socks5://127.0.0.1:${e.port}`).join(',');
fs.writeFileSync(path.join(OUT_DIR, 'proxies.txt'), list + '\n');

console.log(`Wrote ${entries.length} wireproxy configs to vpn/wireproxy/ (chmod 600):\n`);
for (const e of entries) console.log(`   ${e.name.padEnd(8)} socks5://127.0.0.1:${e.port}`);
console.log(`\nStart all:  for f in vpn/wireproxy/*.conf; do wireproxy -d -c "$f"; done`);
console.log(`Stop all:   pkill -f wireproxy`);
console.log(`\nRun with:   PROXY_STATIC="${list}" npm start`);
