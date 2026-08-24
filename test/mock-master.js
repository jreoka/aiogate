'use strict';

/*
 * mock-master.js — a tiny fake AIOStreams for testing aio-gate locally.
 * Mimics the parts of AIOStreams that matter to the gate:
 *   /stremio/<uuid>/<password>/manifest.json        -> manifest
 *   /stremio/<uuid>/<password>/stream/...           -> stream JSON (self URLs + external + usenet playback)
 *   /api/v1/debrid/playback/...                     -> 302 redirect chain -> HLS playlist -> segments
 * Logs every request so you can confirm the gate never leaks the master.
 */

const http = require('http');
const crypto = require('crypto');

const PORT = parseInt(process.env.MOCK_PORT || '3900', 10);
const HOST = '127.0.0.1';
const ORIGIN = `http://${HOST}:${PORT}`;
const UUID = 'abcdef1234567890';
const PASS = 'testpassword123';
const ROOT = `/stremio/${UUID}/${PASS}`;

function json(res, obj, extra = {}) {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    ...extra,
  });
  res.end(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, ORIGIN);
  const p = url.pathname;
  console.log(`[mock] ${req.method} ${p}`);

  /* ---------- bundled panel surface (AIOStreams SPA + API) ---------- */

  const SPA_HTML = `<!doctype html>
<html><head><title>MockStreams Panel</title></head>
<body><h1>Mock AIOStreams Panel</h1>
<script src="/assets/app.js"></script>
</body></html>`;

  if (
    p === '/' ||
    p === '/login' ||
    p === '/dashboard' ||
    p === '/stremio/configure'
  ) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(SPA_HTML);
  }

  if (p === '/assets/app.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    return res.end(
      `document.title='MockPanel loaded';fetch('/api/v1/status').then(r=>r.json()).then(d=>{document.body.dataset.status=JSON.stringify(d)})`
    );
  }

  if (p === '/api/v1/health') {
    return json(res, { ok: true });
  }

  // Real AIOStreams: /api/v1/status is public (healthchecks hit it).
  if (p === '/api/v1/status') {
    return json(res, { ok: true, user: 'anon', baseUrl: ORIGIN });
  }

  // Session-protected endpoint used to prove cookie isolation.
  if (p === '/api/v1/auth/me') {
    const cookies = req.headers.cookie || '';
    if (!cookies.includes('mock_session=1')) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'mock: no session' }));
    }
    return json(res, { ok: true, user: 'admin' });
  }

  if (p === '/api/v1/auth/login' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let creds = {};
      try {
        creds = JSON.parse(body);
      } catch {
        /* ignore */
      }
      if (creds.username === 'admin' && creds.password === 'test-pw') {
        res.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': 'mock_session=1; Path=/; HttpOnly; SameSite=Lax',
        });
        return res.end(JSON.stringify({ ok: true, username: 'admin' }));
      }
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'mock: bad creds' }));
    });
    return;
  }

  /* ---------- stremio addon API (used by /go key proxy) ---------- */

  if (p === `${ROOT}/manifest.json` || p === `${ROOT}/v/phone/manifest.json`) {
    return json(res, {
      id: 'aiostreams.mock',
      name: 'MockStreams',
      version: '0.0.0',
      description: 'mock addon for gate testing',
      resources: ['catalog', 'stream', 'meta'],
      types: ['movie', 'series'],
      catalogs: [],
      behaviorHints: { configurable: true },
    });
  }

  // Modern AIOStreams panel "Copy URL" is an alias URL: /stremio/u/<alias>/...
  // which 302-redirects to the real /stremio/<uuid>/<pass>/... path.
  if (p.startsWith('/stremio/u/')) {
    const rest = p.slice('/stremio/u/'.length);
    const slash = rest.indexOf('/');
    if (slash !== -1) {
      res.writeHead(302, { location: `${ROOT}/${rest.slice(slash + 1)}` });
      return res.end();
    }
  }

  if (p.startsWith(`${ROOT}/stream/`)) {
    return json(res, {
      streams: [
        {
          name: 'Direct debrid (external host)',
          url: 'https://cdn.torbox.example/video/title-1080p.mp4',
        },
        {
          name: 'Usenet via instance (must be rewritten!)',
          url: `${ORIGIN}/api/v1/debrid/playback/abc/xyz/title.mp4`,
        },
        {
          name: 'Subtitle',
          url: 'https://subs.example/title.en.vtt',
        },
      ],
    });
  }

  if (p.startsWith(`${ROOT}/meta/`)) {
    const rest = p.slice(`${ROOT}/meta/`.length);
    const type = rest.split('/')[0];
    const id = decodeURIComponent((rest.split('/')[1] || '').replace(/\.json$/, ''));
    const name =
      id === 'tt123' && type === 'movie'
        ? 'Mock Movie: Test Title'
        : `Mock ${type} ${id}`;
    const meta = { id, type, name };
    // Series meta carries per-episode entries, powering "S01E02 Pilot" in
    // the gate's watch history.
    if (type === 'series' && id === 'tt123') {
      meta.videos = [
        { id: 'tt123:1:1', season: 1, number: 1, title: 'Pilot' },
        { id: 'tt123:1:2', season: 1, number: 2, title: 'Second Episode' },
      ];
    }
    return json(res, { meta });
  }

  if (p === '/api/v1/debrid/playback/abc/xyz/title.mp4') {
    res.writeHead(302, {
      location: `${ORIGIN}/api/v1/debrid/playback/abc/xyz/title.m3u8`,
    });
    return res.end();
  }

  if (p === '/api/v1/debrid/playback/abc/xyz/rel.mp4') {
    // relative redirect, as express res.redirect('/...') would emit
    res.writeHead(302, { location: '/api/v1/debrid/playback/abc/xyz/seg0.ts' });
    return res.end();
  }

  if (p === '/api/v1/debrid/playback/abc/xyz/title.m3u8') {
    res.writeHead(200, {
      'content-type': 'application/vnd.apple.mpegurl; charset=utf-8',
    });
    return res.end(
      `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:6.0,\n${ORIGIN}/api/v1/debrid/playback/abc/xyz/seg0.ts\n#EXTINF:6.0,\n${ORIGIN}/api/v1/debrid/playback/abc/xyz/seg1.ts\n#EXT-X-ENDLIST\n`
    );
  }

  if (p === '/api/v1/debrid/playback/abc/xyz/seg0.ts') {
    res.writeHead(200, { 'content-type': 'video/mp2t' });
    return res.end(crypto.randomBytes(128 * 1024));
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'mock: not found' }));
});

server.listen(PORT, HOST, () => {
  console.log(`[mock] AIOStreams fake on ${ORIGIN}${ROOT}/manifest.json`);
});
