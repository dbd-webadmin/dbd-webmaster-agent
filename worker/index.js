const REPO_OWNER = 'dbd-webadmin';
const REPO_NAME = 'dbd-webmaster-agent';
const MAX_EVENTS = 50;

const CORS = {
  'Access-Control-Allow-Origin': 'https://status.dbdplanning.com',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // Route: POST /trigger — trigger a GitHub Actions workflow
    if (url.pathname === '/trigger') {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

      const domain = url.searchParams.get('domain');
      const plugin = url.searchParams.get('plugin');
      const secret = url.searchParams.get('secret');
      const host = url.searchParams.get('host') || 'hostinger';
      const install_name = url.searchParams.get('install_name') || '';

      if (!domain || !plugin) return json({ error: 'Missing domain or plugin' }, 400);
      if (!secret || secret !== env.WEBHOOK_SECRET) return json({ error: 'Unauthorized' }, 401);

      const dispatchRes = await fetch(
        `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/update-plugins.yml/dispatches`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'DBD-Webmaster-Worker',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ref: 'main', inputs: { domain, plugin, host, install_name } }),
        }
      );

      if (dispatchRes.status === 204) {
        return json({ ok: true, message: `Update queued for ${domain} (${plugin})` });
      }
      const err = await dispatchRes.text();
      console.error('Dispatch failed:', dispatchRes.status, err);
      return json({ error: 'Failed to trigger workflow', detail: err }, 502);
    }

    // Route: POST / — WordPress webhook relay
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const siteSlug = url.searchParams.get('site');
    const secret = url.searchParams.get('secret');

    if (!siteSlug) return new Response('Missing site', { status: 400 });
    if (!secret || secret !== env.WEBHOOK_SECRET) return new Response('Unauthorized', { status: 401 });

    let payload;
    try { payload = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }

    const event = {
      receivedAt: new Date().toISOString(),
      type: payload.action || payload.hook || payload.event || 'unknown',
      data: payload,
    };

    const filePath = `events/${siteSlug}/events.json`;
    const apiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${filePath}`;
    const headers = {
      'Authorization': `token ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'DBD-Webmaster-Worker',
      'Content-Type': 'application/json',
    };

    let existingEvents = [];
    let fileSha = null;

    const readRes = await fetch(apiUrl, { headers });
    if (readRes.ok) {
      const fileData = await readRes.json();
      fileSha = fileData.sha;
      try { existingEvents = JSON.parse(atob(fileData.content.replace(/\n/g, ''))); } catch {}
    }

    const events = [event, ...existingEvents].slice(0, MAX_EVENTS);
    const writeBody = {
      message: `WP event [${event.type}] from ${siteSlug}`,
      content: btoa(unescape(encodeURIComponent(JSON.stringify(events, null, 2)))),
      ...(fileSha ? { sha: fileSha } : {}),
    };

    const writeRes = await fetch(apiUrl, { method: 'PUT', headers, body: JSON.stringify(writeBody) });
    if (!writeRes.ok) {
      const err = await writeRes.text();
      console.error('GitHub write failed:', err);
      return new Response('Write failed', { status: 500 });
    }

    return new Response('OK', { status: 200 });
  },
};
