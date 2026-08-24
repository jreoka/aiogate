'use strict';
/* One-off live check: master meta 404s everything; gate must name the movie
 * from the real IMDb suggestion API. Uses a real tt id (tt12042730). */
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const mock = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  const json = (o) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(o));
  };
  if (p.startsWith('/stremio/u/')) {
    const rest = p.slice('/stremio/u/'.length);
    const i = rest.indexOf('/');
    res.writeHead(302, { location: `/stremio/abc/def/${rest.slice(i + 1)}` });
    return res.end();
  }
  if (p === '/stremio/abc/def/manifest.json')
    return json({ id: 'x', name: 'X', resources: ['stream'], types: ['movie'] });
  if (p.startsWith('/stremio/abc/def/stream/'))
    return json({ streams: [{ name: 'x', url: 'https://cdn.example/v.mp4' }] });
  if (p.startsWith('/stremio/abc/def/meta/')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end('{}');
  }
  res.writeHead(404);
  res.end();
});
mock.listen(0, '127.0.0.1', () => {
  const mport = mock.address().port;
  const gport = 8091;
  const dataFile = path.join(os.tmpdir(), 'live-imdb-data.json');
  fs.rmSync(dataFile, { force: true });
  const gate = spawn(
    process.execPath,
    [path.join(__dirname, '..', 'server.js')],
    {
      env: {
        ...process.env,
        MASTER_URL: `http://127.0.0.1:${mport}/stremio/u/my-alias/manifest.json`,
        ADMIN_USERNAME: 'admin',
        ADMIN_PASSWORD: 'pw',
        PORT: String(gport),
        DATA_FILE: dataFile,
        PUBLIC_BASE: `http://127.0.0.1:${gport}`,
        // NOTE: no IMDB_SUGGEST_URL override -> real v2.sg.media-imdb.com
      },
      stdio: 'ignore',
    }
  );
  const BASE = `http://127.0.0.1:${gport}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
      body: JSON.stringify({ label: 'live' }),
    });
    const { key } = await res.json();
    await fetch(`${BASE}/go/${key.id}/stream/movie/tt12042730.json`);
    await sleep(2500);
    res = await fetch(`${BASE}/panel/api/keys/${key.id}/history`, {
      headers: { cookie },
    });
    const h = (await res.json()).entries[0];
    console.log('LIVE IMDB RESULT:', JSON.stringify({ id: h.id, title: h.title }));
    gate.kill('SIGKILL');
    mock.close();
    fs.rmSync(dataFile, { force: true });
    process.exit(h && h.title ? 0 : 1);
  })().catch((e) => {
    console.error(e);
    gate.kill('SIGKILL');
    mock.close();
    process.exit(1);
  });
});
