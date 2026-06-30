const fs = require('fs');

const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

function extractHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) return null;
  return res.json();
}

async function checkCloudflare(domain) {
  if (!CF_TOKEN) return false;
  try {
    const data = await fetchJson(
      `https://api.cloudflare.com/client/v4/zones?name=${domain}&per_page=1`,
      { Authorization: `Bearer ${CF_TOKEN}` }
    );
    return data?.result?.length > 0;
  } catch {
    return false;
  }
}

async function checkRdap(domain) {
  try {
    const data = await fetchJson(`https://rdap.org/domain/${domain}`, {
      Accept: 'application/rdap+json, application/json',
    });
    if (!data) return {};

    const registrarEntity = data.entities?.find(e => e.roles?.includes('registrar'));
    const fnEntry = registrarEntity?.vcardArray?.[1]?.find(v => v[0] === 'fn');
    const registrar = fnEntry?.[3] || null;

    const expiryEvent = data.events?.find(e => e.eventAction === 'expiration');
    const expiresAt = expiryEvent?.eventDate || null;

    return { registrar, expiresAt };
  } catch (e) {
    console.error(`RDAP error for ${domain}: ${e.message}`);
    return {};
  }
}

async function main() {
  const sites = JSON.parse(fs.readFileSync('sites.json', 'utf8')).sites || [];
  const results = {};

  for (const site of sites) {
    if (!site.slug) continue;
    const domain = extractHostname(site.url);
    if (!domain) continue;

    console.log(`Checking ${domain}...`);
    const [inCloudflare, rdap] = await Promise.all([
      checkCloudflare(domain),
      checkRdap(domain),
    ]);

    results[site.url] = {
      domain,
      registrar: rdap.registrar || null,
      expiresAt: rdap.expiresAt || null,
      inCloudflare,
      checkedAt: new Date().toISOString(),
    };

    console.log(`  Registrar: ${rdap.registrar || 'unknown'} | CF: ${inCloudflare} | Expires: ${rdap.expiresAt || 'unknown'}`);
  }

  fs.writeFileSync('registrar-results.json', JSON.stringify({ updatedAt: new Date().toISOString(), domains: results }, null, 2));
  console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
