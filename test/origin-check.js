'use strict';

/*
 * origin-check.js — ALLOWED_ORIGIN (origin lock) tests.
 *
 * Runs against a gate started with:
 *   ALLOWED_ORIGIN=https://web.stremio.test  BASE_URL=http://127.0.0.1:8088
 *   ADMIN_USERNAME=admin ADMIN_PASSWORD=test-pw PORT=8088
 *   MASTER_URL=http://127.0.0.1:3900/stremio/u/dill-alias/manifest.json
 * (test/run.sh starts it; the mock master must be up on :3900.)
 */

const BASE = 'http://127.0.0.1:8088';
const ALLOWED = 'https://web.stremio.test';

let failures = 0;

function check(name, cond, extra = '') {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name} ${extra}`);
  }
}

async function main() {
  // --- login (no Origin header, like a native client) ---
  let res = await fetch(`${BASE}/panel/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-pw' }),
  });
  check('login without Origin works', res.status === 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const authHeaders = { cookie, 'content-type': 'application/json' };

  // --- create a key (same-origin POST: Origin = the gate's own origin) ---
  res = await fetch(`${BASE}/panel/api/keys`, {
    method: 'POST',
    headers: { ...authHeaders, origin: BASE },
    body: JSON.stringify({ label: 'Origin Test' }),
  });
  check('same-origin (gate panel) POST allowed', res.status === 201);
  const { key } = await res.json();
  const kid = key.id;

  // --- no Origin / Referer: native apps, curl, probes ---
  res = await fetch(`${BASE}/go/${kid}/manifest.json`);
  check('header-less request allowed', res.status === 200);
  check(
    'CORS wildcard is gone when ALLOWED_ORIGIN is set',
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
  const body = await res.json().catch(() => ({}));
  check('foreign origin forbidden', res.status === 403, `got ${res.status}`);
  check('foreign origin gets a forbidden error body', body.error === 'forbidden');

  res = await fetch(`${BASE}/panel/api/keys`, {
    method: 'POST',
    headers: { ...authHeaders, origin: 'https://evil.example' },
    body: JSON.stringify({ label: 'Nope' }),
  });
  check('foreign origin blocked on the admin API too', res.status === 403);

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

  // --- health probe (no Origin) stays reachable ---
  res = await fetch(`${BASE}/healthz`);
  check('health probe reaches upstream', res.status === 200 || res.status === 503);

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
