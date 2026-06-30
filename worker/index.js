const REPO_OWNER = 'dbd-webadmin';
const REPO_NAME = 'dbd-webmaster-agent';
const MAX_EVENTS = 50;
const SECURITY_RATE_LIMIT_MS = 15 * 60 * 1000;

// These events indicate a possible compromise — always commit immediately
const SECURITY_IMMEDIATE = new Set([
  'login_success', 'user_registered', 'user_role_changed',
  'plugin_installed', 'plugin_activated',
]);

// These are aggregated and rate-limited to avoid Pages build spam
const SECURITY_AGGREGATE = new Set(['login_failed']);

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

function ghHeaders(token) {
  return {
    'Authorization': `token ${token}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'DBD-Webmaster-Worker',
    'Content-Type': 'application/json',
  };
}

async function githubGet(apiUrl, headers) {
  const res = await fetch(apiUrl, { headers });
  if (!res.ok) return { data: null, sha: null };
  const file = await res.json();
  let data = null;
  try { data = JSON.parse(atob(file.content.replace(/\n/g, ''))); } catch {}
  return { data, sha: file.sha };
}

async function githubPut(apiUrl, headers, message, data, sha) {
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
  const res = await fetch(apiUrl, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ message, content, ...(sha ? { sha } : {}) }),
  });
  if (!res.ok) console.error('GitHub write failed:', await res.text());
  return res.ok;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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

    const eventType = payload.action || payload.hook || payload.event || 'unknown';
    const now = new Date().toISOString();
    const headers = ghHeaders(env.GITHUB_TOKEN);

    if (SECURITY_IMMEDIATE.has(eventType) || SECURITY_AGGREGATE.has(eventType)) {
      // Security event path — write to security.json with aggregation
      const isImmediate = SECURITY_IMMEDIATE.has(eventType);
      const apiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/events/${siteSlug}/security.json`;

      const { data: existing, sha } = await githubGet(apiUrl, headers);
      const sec = existing || { loginFailed: null, loginSuccess: null, recentEvents: [], lastCommitAt: null };

      if (eventType === 'login_failed') {
        sec.loginFailed = sec.loginFailed || { count: 0, firstSeen: now };
        sec.loginFailed.count++;
        sec.loginFailed.lastSeen = now;
      } else if (eventType === 'login_success') {
        sec.loginSuccess = sec.loginSuccess || { count: 0 };
        sec.loginSuccess.count++;
        sec.loginSuccess.lastSeen = now;
        sec.loginSuccess.lastUser = payload.user || null;
      }

      // High-priority events always get logged in detail
      if (isImmediate) {
        sec.recentEvents = [
          { type: eventType, time: now, data: payload },
          ...(sec.recentEvents || []),
        ].slice(0, 20);
      }

      // Rate-limit low-priority events to avoid triggering Pages on every attack
      const lastCommit = sec.lastCommitAt ? Date.parse(sec.lastCommitAt) : 0;
      if (!isImmediate && Date.now() - lastCommit < SECURITY_RATE_LIMIT_MS) {
        return new Response('OK', { status: 200 });
      }

      sec.lastCommitAt = now;
      await githubPut(apiUrl, headers, `Security [${eventType}] from ${siteSlug}`, sec, sha);

    } else {
      // Operational event path (plugin_update, core_update, etc.) — write to events.json
      const apiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/events/${siteSlug}/events.json`;
      const { data: existingEvents, sha } = await githubGet(apiUrl, headers);

      const event = { receivedAt: now, type: eventType, data: payload };
      const events = [event, ...(existingEvents || [])].slice(0, MAX_EVENTS);

      await githubPut(apiUrl, headers, `WP event [${eventType}] from ${siteSlug}`, events, sha);
    }

    return new Response('OK', { status: 200 });
  },
};
