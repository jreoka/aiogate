'use strict';
/*
 * retry-check.js — verify watch-history titles backfill when the master's
 * meta endpoint fails briefly at record time and recovers later.
 * Runs its own tiny master + gate on random ports.
 */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const FAIL_META_FOR_MS = 4000; // meta 404s for the first 4s, then works
const boot = Date.now();

const mock = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  const json = (o) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(o));
  };
  // alias 302 -> real path
  if (p.startsWith('/stremio/u/')) {
    const rest = p.slice('/stremio/u/'.length);
    const i = rest.indexOf('/');
    res.writeHead(302, { location: `/stremio/abc/def/${rest.slice(i + 1)}` });
    return res.end();
  }
  if (p === '/stremio/abc/def/manifest.json') {
    return json({
      id: 'retry.mock',
      name: 'RetryMock',
      resources: ['stream', 'meta'],
      types: ['movie'],
    });
  }
  if (p.startsWith('/stremio/abc/def/stream/')) {
    return json({ streams: [{ name: 'x', url: 'https://cdn.example/v.mp4' }] });
  }
  if (p.startsWith('/stremio/abc/def/meta/')) {
    if (Date.now() - boot < FAIL_META_FOR_MS) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end('{}');
    }
    const id = decodeURIComponent(p.split('/').pop().replace(/\.json$/, ''));
    return json({ meta: { id, type: 'movie', name: 'Resolved Title ' + id } });
  }
  res.writeHead(404);
  res.end();
});
mock.listen(0, '127.0.0.1', () => {
  const mport = mock.address().port;
  const gport = 8087;
  const dataFile = path.join(os.tmpdir(), 'retry-data.json');
  fs.rmSync(dataFile, { force: true });
  const gate = spawn(
    process.execPath,
    [path.join(__dirname, '..', 'server.js')],
    {
      env: {
        ...process.env,
        HISTORY_META_RETRY_MS: '1000',
        MASTER_URL: `http://127.0.0.1:${mport}/stremio/u/my-alias/manifest.json`,
        ADMIN_USERNAME: 'admin',
        ADMIN_PASSWORD: 'pw',
        PORT: String(gport),
        DATA_FILE: dataFile,
        PUBLIC_BASE: `http://127.0.0.1:${gport}`,
      },
      stdio: 'ignore',
    }
  );
  const BASE = `http://127.0.0.1:${gport}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let failures = 0;
  const check = (name, cond, extra = '') => {
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`);
    if (!cond) failures++;
  };

  (async () => {
    await sleep(1200);
    let res = await fetch(`${BASE}/panel/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'pw' }),
    });
    const cookie = res.headers.get('set-cookie').split(';')[0];
    res = await fetch(`${BASE}/panel/api/keys`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'retry' }),
    });
    const { key } = await res.json();

    // stream while meta is failing
    await fetch(`${BASE}/go/${key.id}/stream/movie/tt777.json`);
    await sleep(500);
    res = await fetch(`${BASE}/panel/api/keys/${key.id}/history`, {
      headers: { cookie },
    });
    let h = (await res.json()).entries[0];
    check('title missing while meta down', h.title === null, JSON.stringify(h));

    // wait for meta to recover + retry window, then re-request history.
    // The history GET itself triggers the lazy retry (async), so wait again
    // for the resolve to land before reading the result.
    await sleep(FAIL_META_FOR_MS - 500 + 3000);
    res = await fetch(`${BASE}/panel/api/keys/${key.id}/history`, {
      headers: { cookie },
    });
    await sleep(2000);
    res = await fetch(`${BASE}/panel/api/keys/${key.id}/history`, {
      headers: { cookie },
    });
    h = (await res.json()).entries[0];
    check('title backfilled after recovery', h.title === 'Resolved Title tt777', JSON.stringify(h));

    gate.kill('SIGKILL');
    mock.close();
    fs.rmSync(dataFile, { force: true });
    console.log(failures ? 'RETRY CHECK FAILED' : 'RETRY CHECK PASSED');
    process.exit(failures ? 1 : 0);
  })().catch((e) => {
    console.error(e);
    gate.kill('SIGKILL');
    mock.close();
    process.exit(1);
  });
});
