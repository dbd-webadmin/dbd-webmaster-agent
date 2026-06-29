const REPO_OWNER = 'dbd-webadmin';
const REPO_NAME = 'dbd-webmaster-agent';
const MAX_EVENTS = 50;

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const url = new URL(request.url);
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
