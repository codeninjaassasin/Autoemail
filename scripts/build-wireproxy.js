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

files.forEach((file, i) => {
  const text = fs.readFileSync(path.join(CONF_DIR, file), 'utf8');
  const name = path.basename(file, '.conf');
  const port = BASE_PORT + i;

  // Each config has its own key pair — they are not shared across servers.
  const conf =
    `[Interface]\n` +
    `PrivateKey = ${field(text, 'PrivateKey')}\n` +
    `Address = ${field(text, 'Address')}\n` +
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
