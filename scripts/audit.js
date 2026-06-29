const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const httpAgent = new http.Agent({ keepAlive: false });
const httpsAgent = new https.Agent({ keepAlive: false });

function fetchUrl(rawUrl, getBody = false, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(rawUrl); } catch { return resolve({ ok: false, status: 0, body: null }); }
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const options = {
      hostname: url.hostname,
      port: isHttps ? 443 : 80,
      path: (url.pathname || '/') + (url.search || ''),
      method: 'GET',
      timeout: timeoutMs,
      agent: isHttps ? httpsAgent : httpAgent,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    };
    let body = '';
    const req = lib.request(options, (res) => {
      if (getBody) {
        res.on('data', chunk => {
          body += chunk.toString();
          if (body.length > 200000) req.destroy();
        });
        res.on('end', () => resolve({ ok: res.statusCode < 400, status: res.statusCode, body }));
        res.on('error', () => resolve({ ok: false, status: 0, body: null }));
      } else {
        res.resume();
        res.on('end', () => resolve({ ok: res.statusCode < 400, status: res.statusCode, body: null }));
      }
    });
    req.on('error', () => resolve({ ok: false, status: 0, body: null }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, body: null }); });
    req.end();
  });
}

function extractLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  const links = new Set();
  const images = new Set();

  const hrefMatches = html.matchAll(/href=["']([^"'#?][^"']*?)["']/gi);
  for (const m of hrefMatches) {
    try {
      const u = new URL(m[1], baseUrl);
      if (u.hostname === base.hostname) links.add(u.href.split('?')[0].split('#')[0]);
    } catch {}
  }

  const srcMatches = html.matchAll(/src=["']([^"']+\.(jpg|jpeg|png|gif|webp|svg|avif))["']/gi);
  for (const m of srcMatches) {
    try { images.add(new URL(m[1], baseUrl).href); } catch {}
  }

  return { links: [...links], images: [...images] };
}

async function crawlSite(siteUrl, maxPages = 30) {
  const base = new URL(siteUrl);
  const visited = new Set();
  const queue = [siteUrl];
  const allLinks = new Set();
  const allImages = new Set();

  while (queue.length > 0 && visited.size < maxPages) {
    const url = queue.shift();
    const normalized = url.split('?')[0].split('#')[0];
    if (visited.has(normalized)) continue;
    visited.add(normalized);

    const res = await fetchUrl(url, true);
    if (!res.body) continue;

    const { links, images } = extractLinks(res.body, url);
    links.forEach(l => {
      allLinks.add(l);
      if (!visited.has(l) && !queue.includes(l)) queue.push(l);
    });
    images.forEach(i => allImages.add(i));
  }

  return { pages: [...visited], links: [...allLinks], images: [...allImages] };
}

async function checkLinks(urls) {
  const broken = [];
  const chunks = [];
  for (let i = 0; i < urls.length; i += 10) chunks.push(urls.slice(i, i + 10));
  for (const chunk of chunks) {
    const results = await Promise.all(chunk.map(async url => {
      const res = await fetchUrl(url, false);
      return { url, status: res.status, ok: res.ok };
    }));
    results.filter(r => !r.ok).forEach(r => broken.push(r));
  }
  return broken;
}

async function getPageSpeed(siteUrl, apiKey) {
  const strategies = ['mobile', 'desktop'];
  const scores = {};
  for (const strategy of strategies) {
    const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(siteUrl)}&strategy=${strategy}&key=${apiKey}`;
    try {
      const res = await fetchUrl(apiUrl, true, 45000);
      if (res.body) {
        const data = JSON.parse(res.body);
        scores[strategy] = data.error ? null : Math.round((data.lighthouseResult?.categories?.performance?.score || 0) * 100);
      } else {
        scores[strategy] = null;
      }
    } catch { scores[strategy] = null; }
  }
  return scores;
}

async function auditSite(site, apiKey) {
  console.log(`Auditing ${site.name}...`);
  const start = Date.now();

  const { pages, links, images } = await crawlSite(site.url);
  console.log(`  Crawled ${pages.length} pages, found ${links.length} links, ${images.length} images`);

  const [brokenLinks, brokenImages, pageSpeed] = await Promise.all([
    checkLinks(links),
    checkLinks(images),
    apiKey ? getPageSpeed(site.url, apiKey) : Promise.resolve(null),
  ]);

  console.log(`  Broken links: ${brokenLinks.length}, Broken images: ${brokenImages.length}`);
  if (pageSpeed) console.log(`  PageSpeed — mobile: ${pageSpeed.mobile}, desktop: ${pageSpeed.desktop}`);

  const crawlBlocked = pages.length <= 1 && links.length === 0;

  return {
    url: site.url,
    name: site.name,
    auditedAt: new Date().toISOString(),
    durationMs: Date.now() - start,
    pagesChecked: pages.length,
    crawlBlocked,
    brokenLinks: crawlBlocked ? null : brokenLinks,
    brokenImages: crawlBlocked ? null : brokenImages,
    pageSpeed: pageSpeed || null,
  };
}

async function run() {
  const { sites } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'sites.json'), 'utf8'));
  const apiKey = process.env.PAGESPEED_API_KEY || null;

  const siteIndex = parseInt(process.env.SITE_INDEX || '0');
  const batchSize = parseInt(process.env.BATCH_SIZE || '4');
  const batch = sites.slice(siteIndex, siteIndex + batchSize);

  if (batch.length === 0) {
    console.log('No sites in batch, done.');
    process.exit(0);
  }

  console.log(`Auditing batch: sites ${siteIndex}–${siteIndex + batch.length - 1} of ${sites.length}`);

  for (const site of batch) {
    const result = await auditSite(site, apiKey);
    const slug = site.slug || site.url.replace(/[^a-z0-9]/gi, '-').toLowerCase();
    const dir = path.join(__dirname, '..', 'audit-results', slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify(result, null, 2));
    console.log(`  Saved audit-results/${slug}/latest.json`);
  }
}

run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
