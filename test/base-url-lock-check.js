'use strict';

/*
 * base-url-lock-check.js — BASE_URL access lock (host + origin) tests.
 *
 * Runs against a gate whose BASE_URL is its own public URL:
 *   BASE_URL=http://127.0.0.1:8088
 *   ADMIN_USERNAME=admin ADMIN_PASSWORD=test-pw PORT=8088
 *   MASTER_URL=http://127.0.0.1:3900/stremio/u/dill-alias/manifest.json
 * (test/run.sh starts it; the mock master must be up on :3900.)
 */

const http = require('http');

const PORT = 8088;
const BASE = `http://127.0.0.1:${PORT}`;
const ALLOWED = BASE; // BASE_URL is the only address the gate answers on

let failures = 0;

function check(name, cond, extra = '') {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name} ${extra}`);
  }
}

/** Raw request so a custom Host / X-Forwarded-Host can be sent (fetch forbids it). */
function rawGet(path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path, method: 'GET', headers },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  // --- login (no Origin header, like a native client or direct navigation) ---
  let res = await fetch(`${BASE}/panel/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-pw' }),
  });
  check('login without Origin works', res.status === 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const authHeaders = { cookie, 'content-type': 'application/json' };

  // --- create a key (same-origin POST: Origin = the gate's own URL) ---
  res = await fetch(`${BASE}/panel/api/keys`, {
    method: 'POST',
    headers: { ...authHeaders, origin: BASE },
    body: JSON.stringify({ label: 'Origin Test' }),
  });
  check('same-origin (gate panel) POST allowed', res.status === 201);
  const { key } = await res.json();
  const kid = key.id;

  // --- no Origin / Referer: native apps, curl, players ---
  res = await fetch(`${BASE}/go/${kid}/manifest.json`);
  check('header-less request allowed', res.status === 200);
  check(
    'CORS wildcard is gone when BASE_URL is set',
    res.headers.get('access-control-allow-origin') === ALLOWED,
    `got ${res.headers.get('access-control-allow-origin')}`
  );

  // --- the configured origin ---
  res = await fetch(`${BASE}/go/${kid}/manifest.json`, {
    headers: { origin: ALLOWED },
  });
  check('configured origin allowed', res.status === 200);

  // --- any other origin ---
  res = await fetch(`${BASE}/go/${kid}/manifest.json`, {
    headers: { origin: 'https://evil.example' },
  });
  let body = await res.text();
  check('foreign origin forbidden', res.status === 403, `got ${res.status}`);
  check(
    'foreign origin gets a plain Forbidden body',
    body.trim() === 'Forbidden',
    body
  );

  res = await fetch(`${BASE}/panel/api/keys`, {
    method: 'POST',
    headers: { ...authHeaders, origin: 'https://evil.example' },
    body: JSON.stringify({ label: 'Nope' }),
  });
  check('foreign origin blocked on the admin API too', res.status === 403);

  // Same host, different scheme is still a different origin.
  res = await fetch(`${BASE}/go/${kid}/manifest.json`, {
    headers: { origin: 'https://127.0.0.1:8088' },
  });
  check('same host, different scheme forbidden', res.status === 403, `got ${res.status}`);

  // --- Referer is used when no Origin is sent (top-level navigation) ---
  res = await fetch(`${BASE}/go/${kid}/manifest.json`, {
    headers: { referer: 'https://evil.example/page.html' },
  });
  check('foreign referer forbidden', res.status === 403, `got ${res.status}`);

  res = await fetch(`${BASE}/go/${kid}/manifest.json`, {
    headers: { referer: `${BASE}/panel/` },
  });
  check('same-origin referer allowed', res.status === 200);

  // --- Origin: null (sandboxed iframe / file://) never matches an allowlist ---
  res = await fetch(`${BASE}/go/${kid}/manifest.json`, {
    headers: { origin: 'null' },
  });
  check('opaque null origin forbidden', res.status === 403, `got ${res.status}`);

  // --- CORS preflight from a foreign origin is refused ---
  res = await fetch(`${BASE}/go/${kid}/manifest.json`, {
    method: 'OPTIONS',
    headers: { origin: 'https://evil.example' },
  });
  check('foreign preflight forbidden', res.status === 403, `got ${res.status}`);

  // --- the addon URL behind another domain / IP does not work at all ---
  let raw = await rawGet(`/go/${kid}/manifest.json`, { host: 'alt.example' });
  check('alternate domain (Host) forbidden', raw.status === 403, `got ${raw.status}`);
  check(
    'alternate domain gets a plain Forbidden body',
    raw.body.trim() === 'Forbidden',
    raw.body
  );

  // (302 = the allowed bare-manifest redirect; rawGet does not follow it)
  raw = await rawGet(`/go/${kid}/manifest.json`, { host: '127.0.0.1' });
  check('host without the port still matches', raw.status === 302, `got ${raw.status}`);

  raw = await rawGet(`/go/${kid}/manifest.json`, {
    host: 'alt.example',
    origin: ALLOWED,
  });
  check('alternate domain refused even with the right origin', raw.status === 403);

  // --- the admin panel is bound by the same lock ---
  raw = await rawGet('/panel/', { host: 'alt.example' });
  check('alternate domain cannot reach the panel', raw.status === 403, `got ${raw.status}`);
  raw = await rawGet('/assets/app.css', { host: 'alt.example' });
  check('alternate domain cannot reach panel assets', raw.status === 403, `got ${raw.status}`);
  raw = await rawGet('/panel/', { host: `127.0.0.1:${PORT}` });
  check('panel served on the allowed URL', raw.status === 200, `got ${raw.status}`);

  // --- a proxy may keep the internal Host but forward the public one ---
  raw = await rawGet(`/go/${kid}/manifest.json`, {
    host: '127.0.0.1:9999',
    'x-forwarded-host': ALLOWED.replace('http://', ''),
  });
  check('X-Forwarded-Host honored behind a proxy', raw.status === 302, `got ${raw.status}`);

  // --- health probes stay reachable from localhost (container healthcheck) ---
  raw = await rawGet('/healthz', { host: '127.0.0.1:8088' });
  check(
    'health probe reaches upstream',
    raw.status === 200 || raw.status === 503,
    `got ${raw.status}`
  );
  raw = await rawGet('/healthz', { host: '127.0.0.1:3000' });
  check(
    'health probe exempt from the host lock',
    raw.status === 200 || raw.status === 503,
    `got ${raw.status}`
  );

  await fetch(`${BASE}/panel/api/keys/${kid}`, {
    method: 'DELETE',
    headers: authHeaders,
  });

  console.log('');
  if (failures === 0) {
    console.log('ALL TESTS PASSED');
  } else {
    console.log(`${failures} TEST(S) FAILED`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('test crashed:', e);
  process.exitCode = 1;
});
