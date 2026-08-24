'use strict';
/* Headless-Chrome (CDP) verification of the three UI changes:
 * 1. per-key page URLs (/panel/<label>)
 * 2. root lands on /panel in bundled mode; AIOStreams via /?aiostreams=1
 * 3. watch history shows titles + SxxExx instead of raw ids
 *
 * Manual: start the mock + gate in bundled mode on :8085, create ONE key
 * labeled "Test", stream movie/tt123 + series/tt123:1:2 through it, then
 * run with Chrome on --remote-debugging-port=9222.
 */

const PORT = process.env.CDP_PORT || 9222;
const APP = 'http://127.0.0.1:8085';

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name} ${extra}`);
  }
}

function cdp(ws, id, method, params = {}) {
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id === id) {
        ws.removeEventListener('message', onMsg);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const call = (m, p) => cdp(ws, ++id, m, p);
  const evalJs = async (expr) => {
    const r = await call('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    return r.result && r.result.value;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  await call('Page.enable');
  await call('Runtime.enable');

  // ---- 2. bare root lands on /panel (not AIOStreams) ----
  await call('Page.navigate', { url: APP + '/' });
  await sleep(1500);
  check('root redirected to /panel/', (await evalJs('location.pathname')) === '/panel/');

  // login
  const login = await evalJs(`fetch('${APP}/panel/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:'test-pw'})}).then(r=>r.ok?'ok':'fail')`);
  check('login ok', login === 'ok');

  await call('Page.navigate', { url: APP + '/' });
  await sleep(2000);
  const onRoot = await evalJs(`JSON.stringify({
    path: location.pathname,
    isDash: !!document.querySelector('#keys-table'),
    rows: document.querySelectorAll('#keys-table tbody tr').length
  })`);
  const root = JSON.parse(onRoot);
  check('root lands on gate dashboard', root.path === '/panel/' && root.isDash, onRoot);
  check('dashboard lists the key', root.rows === 1, onRoot);

  // ---- 1. clicking Manage navigates to /panel/Test and stays there ----
  await evalJs(`document.querySelector('a[data-act="manage"]').click()`);
  await sleep(1500);
  const onKeyPage = await evalJs(`JSON.stringify({
    path: location.pathname,
    label: document.querySelector('.key-title') && document.querySelector('.key-title').textContent,
    hasUrl: !!document.querySelector('.key-url-full'),
    hasHistory: !!document.querySelector('#hist-table')
  })`);
  const kp = JSON.parse(onKeyPage);
  check('Manage navigates to /panel/Test', kp.path === '/panel/Test', onKeyPage);
  check('key page shows label', kp.label === 'Test', onKeyPage);

  // ---- 3. watch history shows title + episode line, not raw ids ----
  await sleep(1200); // title resolution + lazy retry
  await evalJs(`location.reload()`);
  await sleep(2200);
  const hist = await evalJs(`JSON.stringify([...document.querySelectorAll('#hist-table tbody tr')].map(tr => tr.innerText))`);
  const rows = JSON.parse(hist);
  console.log('  history rows:', JSON.stringify(rows));
  check('history has 2 rows', rows.length === 2, hist);
  const movieRow = rows.find((r) => r.toUpperCase().includes('MOVIE'));
  const epRow = rows.find((r) => r.toUpperCase().includes('SERIES'));
  check('movie row shows title not raw id', movieRow && movieRow.includes('Mock Movie: Test Title'), JSON.stringify(movieRow));
  check('movie title comes before raw id', movieRow && movieRow.indexOf('Mock Movie: Test Title') < movieRow.indexOf('tt123'), JSON.stringify(movieRow));
  check('episode row shows series name', epRow && epRow.includes('Mock series tt123'), JSON.stringify(epRow));
  check('episode row shows S01E02', epRow && epRow.includes('S01E02'), JSON.stringify(epRow));
  check('episode row shows episode name', epRow && epRow.includes('Second Episode'), JSON.stringify(epRow));

  // browser back -> dashboard
  await evalJs('history.back()');
  await sleep(1200);
  check('browser back returns to /panel/', (await evalJs('location.pathname')) === '/panel/', await evalJs('location.pathname'));

  // deep link to /panel/Test directly
  await call('Page.navigate', { url: APP + '/panel/Test' });
  await sleep(1800);
  check('deep link /panel/Test opens key page', (await evalJs('!!document.querySelector(".key-url-full")')) === true);

  // ---- 2b. AIOStreams still reachable via /?aiostreams=1 ----
  await call('Page.navigate', { url: APP + '/?aiostreams=1' });
  await sleep(1500);
  const aiostreams = await evalJs(`document.title + '|' + document.body.innerText`);
  check('AIOStreams panel loads via /?aiostreams=1', aiostreams.includes('Mock AIOStreams Panel'), aiostreams);
  check('AIOStreams URL has no /panel redirect', (await evalJs('location.pathname')) === '/', await evalJs('location.pathname'));

  // AIOStreams client-side route (e.g. /dashboard) still proxies
  await call('Page.navigate', { url: APP + '/dashboard' });
  await sleep(1200);
  const dashState = await evalJs(`location.pathname + '|' + document.body.innerText`);
  check('AIOStreams /dashboard proxies', dashState.includes('Mock AIOStreams Panel'), dashState);

  ws.close();
  console.log('');
  if (failures === 0) console.log('ALL UI CHECKS PASSED');
  else {
    console.log(`${failures} UI CHECK(S) FAILED`);
    process.exitCode = 1;
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('ui-check crashed:', e);
  process.exit(1);
});
