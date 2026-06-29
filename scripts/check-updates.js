const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');

const SSH_HOST = '93.127.218.76';
const SSH_PORT = '65002';
const SSH_USER = 'u995288748';
const SSH_KEY = process.env.SSH_KEY_PATH || `${os.homedir()}/.ssh/dbd_webmaster`;

function ssh(cmd) {
  try {
    return execSync(
      `ssh -i "${SSH_KEY}" -p ${SSH_PORT} -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${SSH_USER}@${SSH_HOST} ${JSON.stringify(cmd)}`,
      { encoding: 'utf8', timeout: 30000 }
    ).trim();
  } catch {
    return null;
  }
}

const sites = JSON.parse(fs.readFileSync('sites.json', 'utf8')).sites || [];

for (const site of sites) {
  if (!site.sshAccess || !site.slug) continue;

  let hostname;
  try { hostname = new URL(site.url).hostname.replace(/^www\./, ''); } catch { continue; }

  const wpPath = `/home/${SSH_USER}/domains/${hostname}/public_html`;

  const exists = ssh(`[ -f '${wpPath}/wp-config.php' ] && echo yes || echo no`);
  if (exists !== 'yes') {
    console.log(`Skipping ${site.url} — WP not found at ${wpPath}`);
    continue;
  }

  const pluginJson = ssh(`wp plugin list --path='${wpPath}' --update=available --fields=name,version,update_version --format=json 2>/dev/null || echo '[]'`);
  const coreJson = ssh(`wp core check-update --path='${wpPath}' --format=json 2>/dev/null || echo '[]'`);
  const wpVersion = ssh(`wp core version --path='${wpPath}' 2>/dev/null`);

  let pluginUpdates = [];
  let coreUpdates = [];
  try { pluginUpdates = JSON.parse(pluginJson || '[]'); } catch {}
  try { coreUpdates = JSON.parse(coreJson || '[]'); } catch {}

  const result = {
    slug: site.slug,
    url: site.url,
    checkedAt: new Date().toISOString(),
    currentWpVersion: wpVersion || null,
    wordpressUpdate: coreUpdates.length > 0 ? coreUpdates[0] : null,
    pluginUpdates,
  };

  const dir = `update-status/${site.slug}`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/latest.json`, JSON.stringify(result, null, 2));
  console.log(`${hostname}: ${pluginUpdates.length} plugin updates, WP ${wpVersion}${coreUpdates.length > 0 ? ` → ${coreUpdates[0].version} available` : ' is current'}`);
}

console.log('Done.');
process.exit(0);
