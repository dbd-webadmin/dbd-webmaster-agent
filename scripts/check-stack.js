const https = require('https');
const http = require('http');
const dns = require('dns').promises;
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const SITES_PATH = path.join(__dirname, '..', 'sites.json');
const OUT_PATH = path.join(__dirname, '..', 'stack-results.json');

const { sites } = JSON.parse(fs.readFileSync(SITES_PATH, 'utf8'));

const httpAgent = new http.Agent({ keepAlive: false });
const httpsAgent = new https.Agent({ keepAlive: false });

function getDnsTtl(siteUrl) {
  return dns.resolve4(new URL(siteUrl).hostname, { ttl: true })
    .then(records => records[0]?.ttl ?? null)
    .catch(() => null);
}

function fetchBody(siteUrl) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(siteUrl); } catch { return resolve(null); }
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const options = {
      hostname: url.hostname,
      port: isHttps ? 443 : 80,
      path: url.pathname || '/',
      method: 'GET',
      timeout: 12000,
      agent: isHttps ? httpsAgent : httpAgent,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    };
    let body = '';
    const req = lib.request(options, (res) => {
      res.on('data', (chunk) => {
        body += chunk.toString();
        if (body.length > 75000) req.destroy();
      });
      res.on('end', () => resolve(body));
      res.on('error', () => resolve(body || null));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function detectStack(html) {
  if (!html) return { wordpress: false, wpVersion: null, builder: null, theme: null };

  const wordpress = html.includes('/wp-content/') || html.includes('/wp-includes/');
  const versionMatch = html.match(/meta\s+name=["']generator["']\s+content=["']WordPress\s+([0-9.]+)/i);
  const wpVersion = versionMatch ? versionMatch[1] : null;
  const themeMatch = html.match(/\/wp-content\/themes\/([^\/'"]+)/);
  const theme = themeMatch ? themeMatch[1] : null;

  let builder = null;
  if (html.includes('class="elementor') || html.includes("class='elementor")) builder = 'Elementor';
  else if (html.includes('et_pb_') || html.includes('id="et-main-area"')) builder = 'Divi';
  else if (html.includes('vc_row') || html.includes('wpb_wrapper')) builder = 'WPBakery';
  else if (html.includes('fl-builder') || html.includes('fl-row')) builder = 'Beaver Builder';
  else if (html.includes('data-is-root-container') || html.includes('wp-block-')) builder = 'Gutenberg';

  return { wordpress, wpVersion, builder, theme };
}

async function checkSiteStack(site) {
  const [dnsTtl, html] = await Promise.all([getDnsTtl(site.url), fetchBody(site.url)]);
  const stack = detectStack(html);
  return { url: site.url, name: site.name, dnsTtl, ...stack };
}

async function run() {
  console.log(`Checking stack for ${sites.length} sites...`);
  const results = await Promise.all(sites.map(checkSiteStack));
  results.forEach(r => {
    const builder = r.builder || (r.wordpress ? 'WordPress (unknown builder)' : 'unknown');
    console.log(`${r.name} — TTL: ${r.dnsTtl}s — ${builder}${r.wpVersion ? ` ${r.wpVersion}` : ''}`);
  });
  fs.writeFileSync(OUT_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), sites: results }, null, 2));
  console.log('Saved stack-results.json');
}

run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
