const https = require('https');
const http = require('http');
const tls = require('tls');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { URL } = require('url');
const { getSshConfig } = require('./scripts/ssh-config');

const { sites } = JSON.parse(fs.readFileSync('sites.json', 'utf8'));
const SSH_KEY = process.env.SSH_KEY_PATH || `${os.homedir()}/.ssh/dbd_webmaster`;

function attemptUptime(siteUrl) {
  return new Promise((resolve) => {
    const start = Date.now();
    let url;
    try { url = new URL(siteUrl); } catch {
      return resolve({ up: false, responseTime: 0, error: 'Invalid URL' });
    }
    const lib = url.protocol === 'https:' ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.protocol === 'https:' ? 443 : 80,
      path: url.pathname + url.search || '/',
      method: 'GET',
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Upgrade-Insecure-Requests': '1',
      }
    };
    const req = lib.request(options, (res) => {
      res.resume();
      resolve({
        up: res.statusCode < 500,
        statusCode: res.statusCode,
        responseTime: Date.now() - start,
        headers: {
          hsts: !!res.headers['strict-transport-security'],
          xFrameOptions: !!res.headers['x-frame-options'],
          xContentType: !!res.headers['x-content-type-options'],
          csp: !!res.headers['content-security-policy'],
          cacheControl: res.headers['cache-control'] || null,
          expires: res.headers['expires'] || null,
          server: res.headers['server'] || null,
        }
      });
    });
    req.on('error', (err) => resolve({ up: false, responseTime: Date.now() - start, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ up: false, responseTime: 10000, error: 'Timeout' }); });
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A single blocked/reset connection (e.g. a host's bot-protection dropping our
// request) shouldn't read as a real outage — retry before calling it down.
async function checkUptime(siteUrl, retries = 2, delayMs = 4000) {
  let result = await attemptUptime(siteUrl);
  for (let attempt = 0; attempt < retries && !result.up; attempt++) {
    await sleep(delayMs);
    result = await attemptUptime(siteUrl);
  }
  return result;
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

// A public check can fail because a host is blocking our checker's IP (bot
// protection) rather than the site actually being down. When that happens
// and we have SSH access, ask WordPress itself whether it's healthy —
// confirms the app and database are working without going back out over
// the same network path that just got blocked (which, on shared hosts,
// can itself reject requests that spoof a Host header over loopback).
//
// This only ever rescues a false "down" — it can't reliably confirm a real
// outage. A failed wp-cli call could mean the WP install is genuinely
// broken, or just as easily that the path is wrong, or (as found on
// visitridgwayco.com) the site isn't WordPress at all. None of those let us
// assert "confirmed down" with confidence, so a failed check here just
// leaves the original public-check result as-is.
function sshAttempt(cfg) {
  return new Promise((resolve) => {
    const remoteCmd = `wp option get siteurl --path='${cfg.wpPath}' 2>/dev/null`;
    execFile('ssh', [
      '-i', SSH_KEY, '-p', cfg.port, '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=10',
      `${cfg.user}@${cfg.host}`, remoteCmd,
    ], { timeout: 20000 }, (err, stdout) => {
      if (err) return resolve(false);
      resolve(String(stdout).trim().startsWith('http'));
    });
  });
}

async function sshVerify(site) {
  const cfg = getSshConfig(site);
  if (!cfg) return false;
  const first = await sshAttempt(cfg);
  if (first) return true;
  await sleep(3000);
  return sshAttempt(cfg); // one retry — WP Engine's SSH occasionally drops a connection attempt
}

async function checkSite(site) {
  const [uptime, ssl] = await Promise.all([checkUptime(site.url), checkSSL(site.url)]);

  let result = uptime;
  if (!uptime.up && site.sshAccess) {
    const wpHealthy = await sshVerify(site);
    if (wpHealthy) {
      result = { ...uptime, up: true, sshVerified: true };
    }
    // wp-cli check failed or unavailable — leave the public-check result as-is, unverified
  }

  return {
    name: site.name,
    url: site.url,
    host: site.host || null,
    managedByDbd: site.managedByDbd || false,
    sshAccess: site.sshAccess || false,
    clientEmail: site.clientEmail || null,
    notes: site.notes || null,
    checkedAt: new Date().toISOString(),
    ...result,
    ssl,
  };
}

async function run() {
  console.log(`Checking ${sites.length} sites...`);
  const results = await Promise.all(sites.map(checkSite));
  results.forEach(r => {
    const ssl = r.ssl ? `SSL: ${r.ssl.daysLeft} days` : 'no SSL';
    const sshNote = r.sshVerified ? (r.up ? ' [SSH-verified after public check blocked]' : ' [SSH check also failed]') : '';
    console.log(`${r.up ? '✓' : '✗'} ${r.name} — ${r.responseTime}ms — ${ssl}${sshNote}`);
  });
  fs.writeFileSync('results.json', JSON.stringify({ updatedAt: new Date().toISOString(), sites: results }, null, 2));
  console.log('Saved results.json');
}

run().catch(err => { console.error(err); process.exit(1); });
