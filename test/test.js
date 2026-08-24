'use strict';

/*
 * test.js — end-to-end test for aio-gate against the mock master.
 * Requires: mock-master.js running on :3900 and aio-gate on :8081.
 * Usage:  node test/run.sh   (or run the pieces manually)
 */

const BASE = 'http://127.0.0.1:8081';
const MOCK = 'http://127.0.0.1:3900';

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
  // --- admin login ---
  let res = await fetch(`${BASE}/panel/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-pw' }),
  });
  check('login ok', res.status === 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];

  const authHeaders = { cookie, 'content-type': 'application/json' };

  // --- create keys ---
  res = await fetch(`${BASE}/panel/api/keys`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ label: 'Test User' }),
  });
  check('create key', res.status === 201);
  const { key } = await res.json();
  const kid = key.id;
  console.log(`  key id: ${kid}`);

  // create a second key to test revocation separately
  res = await fetch(`${BASE}/panel/api/keys`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ label: 'Will Be Revoked' }),
  });
  const { key: key2 } = await res.json();

  // --- manifest through the gate ---
  res = await fetch(`${BASE}/go/${kid}/manifest.json`);
  check('manifest status 200', res.status === 200);
  const manifest = await res.json();
  check('manifest parses', manifest && manifest.id === 'aiostreams.mock');

  // --- stream JSON: master origin must be rewritten ---
  res = await fetch(`${BASE}/go/${kid}/stream/movie/tt123.json`);
  check('stream status 200', res.status === 200);
  const body = await res.text();
  check('stream body has no master origin', !body.includes('127.0.0.1:3900'), body);
  check('stream body routes playback via gate/raw', body.includes(`/go/${kid}/raw/api/v1/debrid/playback/`));
  check('stream body keeps external urls', body.includes('https://cdn.torbox.example/'));

  // --- HLS playlist through the gate (raw rewrite) ---
  res = await fetch(`${BASE}/go/${kid}/raw/api/v1/debrid/playback/abc/xyz/title.m3u8`);
  check('playlist status 200', res.status === 200);
  check('playlist content-type', (res.headers.get('content-type') || '').includes('mpegurl'));
  const pl = await res.text();
  check('playlist has no master origin', !pl.includes('127.0.0.1:3900'));
  check('playlist rewritten to gate', pl.includes(`/go/${kid}/raw/api/v1/debrid/playback/`));

  // --- redirect through the gate (Location rewrite) ---
  res = await fetch(`${BASE}/go/${kid}/raw/api/v1/debrid/playback/abc/xyz/title.mp4`, {
    redirect: 'manual',
  });
  check('redirect status 302', res.status === 302);
  const loc = res.headers.get('location') || '';
  check('redirect location rewritten', loc.includes(`${BASE}/go/${kid}/raw/`), loc);
  check('redirect location hides master', !loc.includes('127.0.0.1:3900'), loc);

  // --- relative redirect through the gate (Location rewrite) ---
  res = await fetch(
    `${BASE}/go/${kid}/raw/api/v1/debrid/playback/abc/xyz/rel.mp4`,
    { redirect: 'manual' }
  );
  check('relative redirect status 302', res.status === 302);
  const rloc = res.headers.get('location') || '';
  check(
    'relative redirect location mapped via gate',
    rloc.includes(
      `${BASE}/go/${kid}/raw/api/v1/debrid/playback/abc/xyz/seg0.ts`
    ),
    rloc
  );

  // --- follow the chain: binary segment streams through ---
  res = await fetch(`${BASE}/go/${kid}/raw/api/v1/debrid/playback/abc/xyz/seg0.ts`);
  check('segment status 200', res.status === 200);
  const buf = Buffer.from(await res.arrayBuffer());
  check('segment is binary passthrough', buf.length === 128 * 1024, `got ${buf.length}`);

  // --- variant path ---
  res = await fetch(`${BASE}/go/${kid}/v/phone/manifest.json`);
  check('variant manifest 200', res.status === 200);

  // --- root redirects to manifest ---
  res = await fetch(`${BASE}/go/${kid}`, { redirect: 'manual' });
  check('bare key redirects to manifest', res.status === 302 && (res.headers.get('location') || '').includes('manifest.json'));

  // --- configure is intercepted (never proxied) ---
  res = await fetch(`${BASE}/go/${kid}/configure`);
  const cfgBody = await res.text();
  check('configure intercepted (200, no master)', res.status === 200 && !cfgBody.includes('127.0.0.1:3900'));

  // --- pause / resume / revoke ---
  await fetch(`${BASE}/panel/api/keys/${kid}`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({ status: 'paused' }),
  });
  res = await fetch(`${BASE}/go/${kid}/manifest.json`);
  check('paused key blocked 403', res.status === 403);

  await fetch(`${BASE}/panel/api/keys/${kid}`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({ status: 'active' }),
  });
  res = await fetch(`${BASE}/go/${kid}/manifest.json`);
  check('resumed key works 200', res.status === 200);

  await fetch(`${BASE}/panel/api/keys/${key2.id}`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({ status: 'revoked' }),
  });
  res = await fetch(`${BASE}/go/${key2.id}/manifest.json`);
  check('revoked key blocked 410', res.status === 410);

  // --- unknown key ---
  res = await fetch(`${BASE}/go/doesnotexist123/manifest.json`);
  check('unknown key 404', res.status === 404);

  // --- usage stats recorded ---
  res = await fetch(`${BASE}/panel/api/keys`, { headers: authHeaders });
  const { keys } = await res.json();
  const k = keys.find((x) => x.id === kid);
  check('usage requests counted', k.usage.requests >= 8, `got ${k.usage.requests}`);
  check('usage bytes counted', k.usage.bytes >= 128 * 1024, `got ${k.usage.bytes}`);
  check('usage bytes30d reported', typeof k.usage.bytes30d === 'number' && k.usage.bytes30d >= 128 * 1024, `got ${k.usage.bytes30d}`);
  check('usage bytes30d <= lifetime bytes', k.usage.bytes30d <= k.usage.bytes, `30d=${k.usage.bytes30d} total=${k.usage.bytes}`);
  check('lastUsedAt set', !!k.usage.lastUsedAt);

  // --- runtime settings (master URL + public base from the panel) ---
  res = await fetch(`${BASE}/panel/api/settings`, { headers: authHeaders });
  const settings = await res.json();
  check('settings GET ok', res.status === 200);
  check('settings reflect env master', settings.envMasterUrl === true);

  res = await fetch(`${BASE}/panel/api/settings`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({ masterUrl: 'not-a-valid-url' }),
  });
  check('invalid master URL rejected', res.status === 400, res.status);

  // override public base -> config endpoint and rewrites use it
  await fetch(`${BASE}/panel/api/settings`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({ publicBase: 'http://keyhost.test' }),
  });
  res = await fetch(`${BASE}/panel/api/config`, { headers: authHeaders });
  check(
    'publicBase override in config',
    (await res.json()).publicBase === 'http://keyhost.test'
  );
  res = await fetch(`${BASE}/go/${kid}/stream/movie/tt123.json`);
  check(
    'rewrites use overridden base',
    (await res.text()).includes('http://keyhost.test/go/')
  );

  // override master -> proxying follows it (dead host -> 502)
  await fetch(`${BASE}/panel/api/settings`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({
      masterUrl: 'http://127.0.0.1:9/stremio/x/y/manifest.json',
    }),
  });
  res = await fetch(`${BASE}/go/${kid}/manifest.json`);
  check('bad master override -> 502', res.status === 502, res.status);

  // connection tester
  res = await fetch(`${BASE}/panel/api/settings/test`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      masterUrl:
        'http://127.0.0.1:3900/stremio/abcdef1234567890/testpassword123/manifest.json',
    }),
  });
  check('settings test ok against mock', (await res.json()).ok === true);
  res = await fetch(`${BASE}/panel/api/settings/test`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ masterUrl: 'http://127.0.0.1:9/x/manifest.json' }),
  });
  check('settings test fails on dead host', (await res.json()).ok === false);

  // clear overrides -> back to env master
  await fetch(`${BASE}/panel/api/settings`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({ masterUrl: '', publicBase: '' }),
  });
  res = await fetch(`${BASE}/go/${kid}/manifest.json`);
  check('cleared settings -> env master works again', res.status === 200);

  // --- watch history (what each key streamed) ---
  await new Promise((r) => setTimeout(r, 900)); // let async title resolution finish
  res = await fetch(`${BASE}/panel/api/keys/${kid}/history`, { headers: authHeaders });
  check('history endpoint 200', res.status === 200);
  const hist = await res.json();
  check('history reports retention days', hist.retentionDays === 30, `got ${hist.retentionDays}`);
  check('history recorded stream lookups', hist.entries.length >= 1, `got ${hist.entries.length}`);
  const streamEntry = hist.entries.find((e) => e.type === 'movie' && e.id === 'tt123');
  check('history has movie tt123 entry', !!streamEntry);
  check('history title resolved', streamEntry && streamEntry.title === 'Mock Movie: Test Title', streamEntry && streamEntry.title);
  check('only stream lookups recorded', hist.entries.every((e) => ['movie', 'series', 'channel'].includes(e.type)));

  // --- single-key detail endpoint ---
  res = await fetch(`${BASE}/panel/api/keys/${kid}`, { headers: authHeaders });
  check('key detail endpoint 200', res.status === 200);
  const detail = await res.json();
  check('key detail matches id', detail.key && detail.key.id === kid);

  // --- deleting a key purges its watch history ---
  await fetch(`${BASE}/panel/api/keys/${kid}`, { method: 'DELETE', headers: authHeaders });
  res = await fetch(`${BASE}/panel/api/keys/${kid}/history`, { headers: authHeaders });
  check('history purged on key delete', res.status === 404);

  // --- cleanup ---
  await fetch(`${BASE}/panel/api/keys/${key2.id}`, { method: 'DELETE', headers: authHeaders });

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
