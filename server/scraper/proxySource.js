'use strict';

const { httpGet } = require('./httpGet');

// Free proxy lists, grouped by protocol. Each plain-text source is "ip:port"
// per line; geonode is JSON (carries protocol + anonymity, so we can prefer
// elite/non-datacenter where tagged). Quality is low and churns — the pool
// self-cleans (10 linear fails -> dropped). NOTE: these are overwhelmingly
// datacenter IPs, which Craigslist's reply hCaptcha gates regardless of
// freshness; relay yield on free proxies is ~0. Swap in residential to produce.
const TEXT_SOURCES = [
  // HTTP
  ['http', 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt'],
  ['http', 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt'],
  ['http', 'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt'],
  ['http', 'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt'],
  ['http', 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt'],
  ['http', 'https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/proxies.txt'],
  ['http', 'https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/http.txt'],
  ['http', 'https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt'],
  ['http', 'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all'],
  ['http', 'https://www.proxy-list.download/api/v1/get?type=http'],
  // SOCKS5 (occasionally carry residential/mobile exits — best free shot at a good IP)
  ['socks5', 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt'],
  ['socks5', 'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt'],
  ['socks5', 'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt'],
  ['socks5', 'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks5/data.txt'],
  ['socks5', 'https://api.proxyscrape.com/v2/?request=getproxies&protocol=socks5&timeout=10000&country=all'],
  // SOCKS4
  ['socks4', 'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks4.txt'],
  ['socks4', 'https://api.proxyscrape.com/v2/?request=getproxies&protocol=socks4&timeout=10000&country=all'],
];

// geonode: JSON, filterable; prefer elite + non-datacenter where tagged.
const GEONODE = 'https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc';

const IPPORT = /(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})/;

function validIpPort(ip, port) {
  const p = Number(port);
  if (p < 1 || p > 65535) return false;
  return ip.split('.').every((o) => Number(o) >= 0 && Number(o) <= 255);
}

function normalize(proto, ipport) {
  return `${proto}://${ipport}`;
}

// Returns { proxies: [{server, proto, elite}], perSource }. `elite` marks exits
// a source tagged as elite/anonymous or residential (preferred by the pool).
async function fetchFreeProxies() {
  const map = new Map(); // server -> {server, proto, elite}
  const perSource = {};

  await Promise.all(
    TEXT_SOURCES.map(async ([proto, url]) => {
      try {
        const { status, html } = await httpGet(url, { timeout: 15000 });
        if (status !== 200) return;
        let n = 0;
        for (const line of html.split(/\r?\n/)) {
          const m = line.match(IPPORT);
          if (!m || !validIpPort(m[1], m[2])) continue;
          const server = normalize(proto, `${m[1]}:${m[2]}`);
          if (!map.has(server)) map.set(server, { server, proto, elite: false });
          n++;
        }
        perSource[url] = n;
      } catch {
        perSource[url] = 0;
      }
    })
  );

  // geonode JSON
  try {
    const { status, html } = await httpGet(GEONODE, { timeout: 15000 });
    if (status === 200) {
      const data = JSON.parse(html);
      let n = 0;
      for (const row of data.data || []) {
        const ip = row.ip;
        const port = row.port;
        if (!ip || !port || !validIpPort(ip, port)) continue;
        const protos = (row.protocols || []).map((p) => String(p).toLowerCase());
        const proto = protos.includes('socks5')
          ? 'socks5'
          : protos.includes('socks4')
          ? 'socks4'
          : 'http';
        const elite = /elite|anonymous/i.test(row.anonymityLevel || '') || /residential|mobile/i.test(row.org || '');
        const server = normalize(proto, `${ip}:${port}`);
        const prev = map.get(server);
        if (!prev) map.set(server, { server, proto, elite });
        else if (elite) prev.elite = true;
        n++;
      }
      perSource[GEONODE] = n;
    }
  } catch {
    perSource[GEONODE] = 0;
  }

  return { proxies: [...map.values()], perSource };
}

module.exports = { fetchFreeProxies };
