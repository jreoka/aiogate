'use strict';

/*
 * test.js — end-to-end tests for the gate's core: key proxy, admin API,
 * settings and watch history. Runs against the bundled gate (the only mode).
 * Requires: mock-master.js running on :3900 and aio-gate on :8085.
 * Usage:  node test/run.sh   (or run the pieces manually)
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
  res = await fetch(`${BASE}/go/${kid}/stream/movie/tt123.json`, {
    redirect: 'manual',
  });
  const locAfterOverride = res.headers.get('location') || '';
  check(
    'rewrites use overridden base',
    (res.status === 302 && locAfterOverride.includes('http://keyhost.test/go/')) ||
      (res.status === 200 && (await res.text()).includes('http://keyhost.test/go/')),
    `status=${res.status} loc=${locAfterOverride}`
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

  // connection tester (alias URL -> 302 -> must still probe green)
  res = await fetch(`${BASE}/panel/api/settings/test`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      masterUrl:
        'http://127.0.0.1:3900/stremio/u/dill-alias/manifest.json',
    }),
  });
  const probeRes = await res.json();
  check(
    'settings test ok against mock (alias URL)',
    probeRes.ok === true && probeRes.status === 200,
    JSON.stringify(probeRes)
  );
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

  // series episode -> series title + SxxExx + episode name (from meta.videos)
  res = await fetch(`${BASE}/go/${kid}/stream/series/tt123%3A1%3A2.json`);
  check('series stream status 200', res.status === 200);
  await new Promise((r) => setTimeout(r, 900)); // let async title resolution finish
  res = await fetch(`${BASE}/panel/api/keys/${kid}/history`, { headers: authHeaders });
  const histEp = await res.json();
  const epEntry = histEp.entries.find(
    (e) => e.type === 'series' && e.id === 'tt123:1:2'
  );
  check('history has series episode entry', !!epEntry);
  check(
    'episode shows series title',
    epEntry && epEntry.title === 'Mock series tt123',
    epEntry && epEntry.title
  );
  check(
    'episode season/episode recorded',
    epEntry && epEntry.season === 1 && epEntry.episodeNumber === 2,
    JSON.stringify(epEntry && { s: epEntry.season, n: epEntry.episodeNumber })
  );
  check(
    'episode name recorded',
    epEntry && epEntry.episodeName === 'Second Episode',
    epEntry && epEntry.episodeName
  );

  // --- IMDb fallback: master meta 404s, gate names it from the suggestion API ---
  res = await fetch(`${BASE}/go/${kid}/stream/movie/tt999.json`);
  check('fallback movie stream status 200', res.status === 200);
  await new Promise((r) => setTimeout(r, 900));
  res = await fetch(`${BASE}/panel/api/keys/${kid}/history`, { headers: authHeaders });
  const histFb = await res.json();
  const fbMovie = histFb.entries.find((e) => e.id === 'tt999');
  check(
    'imdb fallback names movie',
    fbMovie && fbMovie.title === 'IMDB Fallback Title tt999',
    fbMovie && fbMovie.title
  );

  // series episode whose meta 404s: IMDb names the show, S/E comes from the id
  res = await fetch(`${BASE}/go/${kid}/stream/series/tt999%3A2%3A5.json`);
  await new Promise((r) => setTimeout(r, 900));
  res = await fetch(`${BASE}/panel/api/keys/${kid}/history`, { headers: authHeaders });
  const histFb2 = await res.json();
  const fbSeries = histFb2.entries.find((e) => e.id === 'tt999:2:5');
  check(
    'imdb fallback names series episode',
    fbSeries && fbSeries.title === 'IMDB Fallback Title tt999',
    fbSeries && fbSeries.title
  );
  check(
    'imdb fallback derives S/E from id',
    fbSeries && fbSeries.season === 2 && fbSeries.episodeNumber === 5,
    JSON.stringify(fbSeries && { s: fbSeries.season, n: fbSeries.episodeNumber })
  );

  // master meta names the show but has no matching episode video (different
  // video id scheme) -> S/E still derived from the episode id
  res = await fetch(`${BASE}/go/${kid}/stream/series/tt456%3A3%3A7.json`);
  await new Promise((r) => setTimeout(r, 900));
  res = await fetch(`${BASE}/panel/api/keys/${kid}/history`, { headers: authHeaders });
  const histDerived = await res.json();
  const derived = histDerived.entries.find((e) => e.id === 'tt456:3:7');
  check(
    'series title from master meta',
    derived && derived.title === 'Mock series tt456',
    derived && derived.title
  );
  check(
    'S/E derived when meta lacks the episode',
    derived && derived.season === 3 && derived.episodeNumber === 7,
    JSON.stringify(derived && { s: derived.season, n: derived.episodeNumber })
  );

  check('only stream lookups recorded', hist.entries.every((e) => ['movie', 'series', 'channel'].includes(e.type)));

  // --- single-key detail endpoint ---
  res = await fetch(`${BASE}/panel/api/keys/${kid}`, { headers: authHeaders });
  check('key detail endpoint 200', res.status === 200);
  const detail = await res.json();
  check('key detail matches id', detail.key && detail.key.id === kid);

  // --- per-key page URLs (/panel/<label>) ---
  res = await fetch(`${BASE}/panel/Test-User`, { headers: authHeaders });
  check(
    'per-key page URL serves the panel app',
    res.status === 200 && (await res.text()).includes('AIO Gate')
  );
  res = await fetch(`${BASE}/panel/Test-User/`, { headers: authHeaders });
  check(
    'per-key page URL with trailing slash',
    res.status === 200 && (await res.text()).includes('AIO Gate')
  );
  res = await fetch(`${BASE}/panel/does-not-exist`, { headers: authHeaders });
  check(
    'unknown slug serves the app (SPA route)',
    res.status === 200 && (await res.text()).includes('AIO Gate')
  );
  res = await fetch(`${BASE}/panel/missing-asset.js`, { headers: authHeaders });
  check('unknown file paths still 404', res.status === 404);

  // --- deleting a key purges its watch history ---
  await fetch(`${BASE}/panel/api/keys/${kid}`, { method: 'DELETE', headers: authHeaders });
  res = await fetch(`${BASE}/panel/api/keys/${kid}/history`, { headers: authHeaders });
  check('history purged on key delete', res.status === 404);

  // --- live streams ("watching now" green lights) ---
  res = await fetch(`${BASE}/panel/api/keys`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ label: 'Live Check' }),
  });
  check('create live-check key', res.status === 201);
  const { key: key3 } = await res.json();

  res = await fetch(`${BASE}/panel/api/status`, { headers: authHeaders });
  let st = await res.json();
  check('status endpoint ok', res.status === 200);
  check('no live streams for new key', !st.keys[key3.id], JSON.stringify(st));

  // A stream LOOKUP is browsing, not watching — it must not count.
  res = await fetch(`${BASE}/go/${key3.id}/stream/movie/tt123.json`);
  check('stream lookup ok', res.status === 200);
  res = await fetch(`${BASE}/panel/api/keys/${key3.id}`, { headers: authHeaders });
  let det = await res.json();
  check('stream lookup does not count as watching', det.key.activeStreams === 0, det.key.activeStreams);

  // First playback session registers (green light) and links to the media
  // it just looked up, so the history row lights up too.
  res = await fetch(`${BASE}/go/${key3.id}/raw/api/v1/debrid/playback/abc/xyz/title.m3u8`);
  check('first stream playlist 200', res.status === 200);
  res = await fetch(`${BASE}/panel/api/keys/${key3.id}`, { headers: authHeaders });
  det = await res.json();
  check(
    'key reports 1 active stream (watching)',
    det.key.activeStreams === 1 && det.key.watching === true,
    JSON.stringify(det.key && { a: det.key.activeStreams, w: det.key.watching })
  );
  res = await fetch(`${BASE}/panel/api/status`, { headers: authHeaders });
  st = await res.json();
  check('status widget counts the key stream', st.keys[key3.id] === 1, JSON.stringify(st));

  // The watch-history row for the streaming media carries a green light.
  res = await fetch(`${BASE}/panel/api/keys/${key3.id}/history`, { headers: authHeaders });
  let liveHist = await res.json();
  let liveMovie = liveHist.entries.find((e) => e.type === 'movie' && e.id === 'tt123');
  check('history entry marked live', liveMovie && liveMovie.live === 1, JSON.stringify(liveMovie && liveMovie.live));

  // A second concurrent stream (different media) lights up its own row.
  res = await fetch(`${BASE}/go/${key3.id}/stream/series/tt123%3A1%3A2.json`);
  check('second stream lookup ok', res.status === 200);
  res = await fetch(`${BASE}/go/${key3.id}/raw/api/v1/debrid/playback/def/uvw/title.m3u8`);
  check('second stream playlist 200', res.status === 200);
  res = await fetch(`${BASE}/panel/api/keys/${key3.id}/history`, { headers: authHeaders });
  liveHist = await res.json();
  const liveEp = liveHist.entries.find((e) => e.type === 'series' && e.id === 'tt123:1:2');
  liveMovie = liveHist.entries.find((e) => e.type === 'movie' && e.id === 'tt123');
  check('second media row is live too', liveEp && liveEp.live === 1, JSON.stringify(liveEp && liveEp.live));
  check('first media still live with 2 concurrent', liveMovie && liveMovie.live === 1, JSON.stringify(liveMovie && liveMovie.live));

  // Idle timeout turns the lights off (STREAM_IDLE_MS=3000 in tests).
  await new Promise((r) => setTimeout(r, 3500));
  res = await fetch(`${BASE}/panel/api/keys/${key3.id}/history`, { headers: authHeaders });
  liveHist = await res.json();
  liveMovie = liveHist.entries.find((e) => e.type === 'movie' && e.id === 'tt123');
  const offEp = liveHist.entries.find((e) => e.type === 'series' && e.id === 'tt123:1:2');
  check(
    'idle expiry clears history live flags',
    (!liveMovie || liveMovie.live === 0) && (!offEp || offEp.live === 0),
    JSON.stringify({ m: liveMovie && liveMovie.live, e: offEp && offEp.live })
  );

  // Pausing the key clears its live sessions immediately.
  res = await fetch(`${BASE}/go/${key3.id}/raw/api/v1/debrid/playback/abc/xyz/title.m3u8`);
  check('stream restarts after expiry', res.status === 200, res.status);
  await fetch(`${BASE}/panel/api/keys/${key3.id}`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({ status: 'paused' }),
  });
  res = await fetch(`${BASE}/panel/api/status`, { headers: authHeaders });
  st = await res.json();
  check('pausing the key clears its live sessions', !st.keys[key3.id], JSON.stringify(st));
  await fetch(`${BASE}/panel/api/keys/${key3.id}`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({ status: 'active' }),
  });

  // Serialization.
  res = await fetch(`${BASE}/panel/api/keys`, { headers: authHeaders });
  const keysAll = (await res.json()).keys;
  const k3 = keysAll.find((x) => x.id === key3.id);
  check(
    'keys list serializes live fields',
    !!k3 && 'activeStreams' in k3 && 'watching' in k3
  );

  // --- cleanup ---
  await fetch(`${BASE}/panel/api/keys/${key3.id}`, { method: 'DELETE', headers: authHeaders });
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
