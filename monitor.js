const https = require('https');
const http = require('http');
const tls = require('tls');
const fs = require('fs');
const { URL } = require('url');

const { sites } = JSON.parse(fs.readFileSync('sites.json', 'utf8'));

function checkUptime(siteUrl) {
  return new Promise((resolve) => {
    const start = Date.now();
    const url = new URL(siteUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(siteUrl, { timeout: 10000 }, (res) => {
      res.resume();
      resolve({
        up: res.statusCode < 400,
        statusCode: res.statusCode,
        responseTime: Date.now() - start,
        headers: {
          hsts: !!res.headers['strict-transport-security'],
          xFrameOptions: !!res.headers['x-frame-options'],
          xContentType: !!res.headers['x-content-type-options'],
          csp: !!res.headers['content-security-policy'],
        }
      });
    });
    req.on('error', () => resolve({ up: false, responseTime: Date.now() - start }));
    req.on('timeout', () => { req.destroy(); resolve({ up: false, responseTime: 10000 }); });
  });
}

function checkSSL(siteUrl) {
  return new Promise((resolve) => {
    if (!siteUrl.startsWith('https://')) return resolve(null);
    const { hostname } = new URL(siteUrl);
    const socket = tls.connect({ host: hostname, port: 443, servername: hostname }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!cert || !cert.valid_to) return resolve(null);
      const expiry = new Date(cert.valid_to);
      const daysLeft = Math.floor((expiry - Date.now()) / 86400000);
      resolve({ valid: true, expiry: expiry.toISOString(), daysLeft });
    });
    socket.on('error', () => resolve({ valid: false }));
  });
}

async function checkSite(site) {
  const [uptime, ssl] = await Promise.all([checkUptime(site.url), checkSSL(site.url)]);
  return { name: site.name, url: site.url, client: site.client, clientEmail: site.clientEmail, checkedAt: new Date().toISOString(), ...uptime, ssl };
}

async function run() {
  console.log(`Checking ${sites.length} sites...`);
  const results = await Promise.all(sites.map(checkSite));
  results.forEach(r => {
    const ssl = r.ssl ? `SSL: ${r.ssl.daysLeft} days` : 'no SSL';
    console.log(`${r.up ? '✓' : '✗'} ${r.name} — ${r.responseTime}ms — ${ssl}`);
  });
  fs.writeFileSync('results.json', JSON.stringify({ updatedAt: new Date().toISOString(), sites: results }, null, 2));
  console.log('Saved results.json');
}

run().catch(err => { console.error(err); process.exit(1); });
