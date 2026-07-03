const HOSTINGER = {
  user: 'u995288748',
  host: '93.127.218.76',
  port: '65002',
};

// Shared by check-updates.js and monitor.js so SSH targeting logic (and any
// fixes to it) lives in exactly one place.
function getSshConfig(site) {
  const isWpEngine = site.host?.toLowerCase().includes('wp engine');
  if (isWpEngine) {
    if (!site.sshInstallName) return null; // no install name on file — can't build the right SSH target
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

module.exports = { HOSTINGER, getSshConfig };
