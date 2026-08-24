'use strict';
/* Drives headless Chrome via CDP (Node >= 22, built-in WebSocket) to
 * log into the panel and dump the rendered dashboard DOM. */

const PORT = process.env.CDP_PORT || 9222;
const APP = process.env.APP_URL || 'http://127.0.0.1:8084';

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

  await call('Page.enable');
  await call('Runtime.enable');

  // Load the app first (same-origin), then log in via fetch.
  await call('Page.navigate', { url: APP + '/' });
  await new Promise((r) => setTimeout(r, 1500));

  const loginScript = `
    fetch('${APP}/panel/api/login', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({username: 'admin', password: 'test-pw'})
    }).then(r => r.ok ? 'login-ok' : 'login-failed:' + r.status)`;
  const loginRes = await call('Runtime.evaluate', {
    expression: loginScript,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log('login:', JSON.stringify(loginRes.result));

  await call('Page.navigate', { url: APP + '/' });
  await new Promise((r) => setTimeout(r, 2500));

  const dom = await call('Runtime.evaluate', {
    expression: `document.body.innerText`,
    returnByValue: true,
  });
  console.log('=== rendered dashboard text ===');
  console.log(dom.result.value);
  console.log('=== end ===');

  // Quick structural checks
  const checks = await call('Runtime.evaluate', {
    expression: `JSON.stringify({
      hasCreateForm: !!document.querySelector('#create-form'),
      hasKeysTable: !!document.querySelector('#keys-table'),
      rows: document.querySelectorAll('#keys-table tr').length,
      keyIds: [...document.querySelectorAll('.key-id')].map(e => e.textContent),
      pills: [...document.querySelectorAll('.pill')].map(e => e.textContent.trim()),
      stats: [...document.querySelectorAll('.stat .num')].map(e => e.textContent),
      hasError: !!document.querySelector('.form-error') && document.querySelector('.form-error').textContent
    })`,
    returnByValue: true,
  });
  console.log('checks:', checks.result.value);

  const shot = await call('Page.captureScreenshot', { format: 'png' });
  require('fs').writeFileSync(
    require('path').join(process.env.TMP || '/tmp', 'shots', 'dashboard.png'),
    Buffer.from(shot.data, 'base64')
  );
  console.log('screenshot saved');
  ws.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
