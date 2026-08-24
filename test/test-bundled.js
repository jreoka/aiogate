'use strict';

/*
 * test-bundled.js — end-to-end tests for the AIOStreams surface behind the
 * gate: root admin-gating, panel proxying, cookie round-trips, key proxy.
 * Requires mock-master.js on :3900 and the gate (bundled) on :8085.
 */

const BASE = 'http://127.0.0.1:8085';

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
  // --- panel surface is NOT public without gate admin auth ---
  let res = await fetch(`${BASE}/`, {
    headers: { accept: 'text/html' },
    redirect: 'manual',
  });
  check('root redirects to gate login', res.status === 302 && (res.headers.get('location') || '').includes('/panel/'), res.status);

  res = await fetch(`${BASE}/login`, {
    headers: { accept: 'text/html' },
    redirect: 'manual',
  });
  check('AIOStreams /login not public', res.status === 302, res.status);

  res = await fetch(`${BASE}/api/v1/status`);
  check('AIOStreams API not public (401)', res.status === 401, res.status);

  res = await fetch(`${BASE}/stremio/abcdef1234567890/testpassword123/manifest.json`);
  check('addon API at root not public', res.status === 401, res.status);

  // --- gate panel loads at /panel/ ---
  res = await fetch(`${BASE}/panel/`);
  const panelHtml = await res.text();
  check('gate panel serves at /panel', res.status === 200 && panelHtml.includes('AIO Gate'));

  res = await fetch(`${BASE}/panel`, { redirect: 'manual' });
  check('/panel redirects to /panel/', res.status === 302, res.status);

  res = await fetch(`${BASE}/panel/app.css`);
  check('panel css serves', res.status === 200 && (res.headers.get('content-type') || '').includes('css'));

  // --- gate admin login ---
  res = await fetch(`${BASE}/panel/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-pw' }),
  });
  check('gate login ok', res.status === 200);
  const gateCookie = res.headers.get('set-cookie').split(';')[0];

  res = await fetch(`${BASE}/panel/api/me`, { headers: { cookie: gateCookie } });
  check('gate me ok', res.status === 200);

  // --- AIOStreams panel proxied through the gate for admins ---
  // The bare root now lands on the gate panel; AIOStreams is entered via
  // the gate panel's button (/?aiostreams=1).
  res = await fetch(`${BASE}/`, {
    headers: { accept: 'text/html', cookie: gateCookie },
    redirect: 'manual',
  });
  check(
    'authenticated root lands on gate panel',
    res.status === 302 &&
      (res.headers.get('location') || '').includes('/panel/'),
    res.status
  );

  res = await fetch(`${BASE}/?aiostreams=1`, {
    headers: { accept: 'text/html', cookie: gateCookie },
  });
  const proxied = await res.text();
  check(
    'panel proxied to AIOStreams via /?aiostreams=1',
    res.status === 200 && proxied.includes('Mock AIOStreams Panel'),
    res.status
  );

  res = await fetch(`${BASE}/assets/app.js`, { headers: { cookie: gateCookie } });
  check('panel assets proxied', res.status === 200 && (res.headers.get('content-type') || '').includes('javascript'));

  // SPA fallback route
  res = await fetch(`${BASE}/stremio/configure`, {
    headers: { accept: 'text/html', cookie: gateCookie },
  });
  check('SPA fallback proxied', res.status === 200 && (await res.text()).includes('Mock AIOStreams Panel'));

  // --- AIOStreams session cookie round-trips through the gate ---
  res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: gateCookie },
    body: JSON.stringify({ username: 'admin', password: 'test-pw' }),
  });
  check('AIOStreams login through gate', res.status === 200);
  const setCookie = res.headers.get('set-cookie') || '';
  check('AIOStreams set-cookie passes through', setCookie.includes('mock_session=1'), setCookie);
  const mockCookie = setCookie.split(';')[0];

  // both cookies forwarded: gate session + AIOStreams session
  res = await fetch(`${BASE}/api/v1/auth/me`, {
    headers: { cookie: `${gateCookie}; ${mockCookie}` },
  });
  const me = await res.json();
  check(
    'AIOStreams API works with both cookies',
    res.status === 200 && me.user === 'admin',
    res.status
  );

  // gate session alone is NOT enough for AIOStreams API (session isolation)
  res = await fetch(`${BASE}/api/v1/auth/me`, {
    headers: { cookie: gateCookie },
  });
  check('gate session alone rejected by AIOStreams API', res.status === 401, res.status);

  // --- /go key proxy still works without ANY admin auth ---
  res = await fetch(`${BASE}/panel/api/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: gateCookie },
    body: JSON.stringify({ label: 'Bundled Test User' }),
  });
  check('create key via /panel/api', res.status === 201);
  const { key } = await res.json();

  res = await fetch(`${BASE}/go/${key.id}/manifest.json`);
  check('key manifest works with no admin auth', res.status === 200);

  res = await fetch(`${BASE}/go/${key.id}/stream/movie/tt1.json`);
  const body = await res.text();
  check('key stream has no internal origin', !body.includes('127.0.0.1:3900'), body);
  check('key stream routed via /go/raw', body.includes(`/go/${key.id}/raw/api/v1/debrid/playback/`));

  // paused key still gated correctly
  await fetch(`${BASE}/panel/api/keys/${key.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: gateCookie },
    body: JSON.stringify({ status: 'paused' }),
  });
  res = await fetch(`${BASE}/go/${key.id}/manifest.json`);
  check('paused key blocked', res.status === 403);

  await fetch(`${BASE}/panel/api/keys/${key.id}`, {
    method: 'DELETE',
    headers: { cookie: gateCookie },
  });

  // --- health reflects upstream ---
  res = await fetch(`${BASE}/healthz`);
  check('healthz ok with upstream up', res.status === 200);

  // --- config reports bundled mode ---
  res = await fetch(`${BASE}/panel/api/config`, { headers: { cookie: gateCookie } });
  const cfg = await res.json();
  check('config reports bundled', cfg.bundled === true);

  // --- runtime settings available in bundled mode ---
  res = await fetch(`${BASE}/panel/api/settings`, {
    headers: { cookie: gateCookie },
  });
  check(
    'settings available in bundled mode',
    res.status === 200 && (await res.json()).bundled === true
  );

  console.log('');
  if (failures === 0) {
    console.log('ALL BUNDLED TESTS PASSED');
  } else {
    console.log(`${failures} BUNDLED TEST(S) FAILED`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('bundled test crashed:', e);
  process.exitCode = 1;
});
