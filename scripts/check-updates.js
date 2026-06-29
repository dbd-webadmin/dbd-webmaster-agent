const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');

const SSH_KEY = process.env.SSH_KEY_PATH || `${os.homedir()}/.ssh/dbd_webmaster`;

const HOSTINGER = {
  user: 'u995288748',
  host: '93.127.218.76',
  port: '65002',
};

function getSshConfig(site) {
  const isWpEngine = site.host?.toLowerCase().includes('wp engine');
  if (isWpEngine && site.sshInstallName) {
    const name = site.sshInstallName;
    return {
      user: name,
      host: `${name}.ssh.wpengine.net`,
      port: '22',
      wpPath: `/home/wpe-user/sites/${name}`,
    };
  }
  let hostname;
  try { hostname = new URL(site.url).hostname.replace(/^www\./, ''); } catch { return null; }
  return {
    user: HOSTINGER.user,
    host: HOSTINGER.host,
    port: HOSTINGER.port,
    wpPath: `/home/${HOSTINGER.user}/domains/${hostname}/public_html`,
  };
}

function ssh(cfg, cmd) {
  try {
    return execSync(
      `ssh -i "${SSH_KEY}" -p ${cfg.port} -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${cfg.user}@${cfg.host} ${JSON.stringify(cmd)}`,
      { encoding: 'utf8', timeout: 30000 }
    ).trim();
  } catch {
    return null;
  }
}

const sites = JSON.parse(fs.readFileSync('sites.json', 'utf8')).sites || [];

for (const site of sites) {
  if (!site.sshAccess || !site.slug) continue;

  const cfg = getSshConfig(site);
  if (!cfg) { console.log(`Skipping ${site.url} — could not build SSH config`); continue; }

  const exists = ssh(cfg, `[ -f '${cfg.wpPath}/wp-config.php' ] && echo yes || echo no`);
  if (exists !== 'yes') {
    console.log(`Skipping ${site.url} — WP not found at ${cfg.wpPath}`);
    continue;
  }

  const pluginJson = ssh(cfg, `wp plugin list --path='${cfg.wpPath}' --update=available --fields=name,version,update_version --format=json 2>/dev/null || echo '[]'`);
  const coreJson = ssh(cfg, `wp core check-update --path='${cfg.wpPath}' --format=json 2>/dev/null || echo '[]'`);
  const wpVersion = ssh(cfg, `wp core version --path='${cfg.wpPath}' 2>/dev/null`);

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
  console.log(`${site.url} [${site.host}]: ${pluginUpdates.length} plugin updates, WP ${wpVersion}${coreUpdates.length > 0 ? ` → ${coreUpdates[0].version} available` : ' is current'}`);
}

console.log('Done.');
process.exit(0);
