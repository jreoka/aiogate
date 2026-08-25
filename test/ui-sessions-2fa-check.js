'use strict';
/* UI smoke check for the new panel features (headless Chrome via CDP):
 * 1. keys table has no Key/URL column; URL lives on the Manage page
 * 2. Sessions view renders (2FA section + session rows + rename/revoke)
 * 3. 2FA enable modal shows the secret; login page shows the code field
 *    when 2FA is enabled.
 * Manual: mock + gate in bundled mode on :8085, Chrome --remote-debugging-port=9222.
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
    if (r.exceptionDetails) {
      console.log('  EXC:', (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    }
    return r.result && r.result.value;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (expr, timeout = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (await evalJs(expr)) return true;
      await sleep(300);
    }
    return false;
  };

  await call('Page.enable');
  await call('Runtime.enable');

  await call('Page.navigate', { url: APP + '/panel/' });
  await waitFor(`!!document.querySelector('#login-form')`);

  // login through the UI form
  await evalJs(`
    document.querySelector('#username').value='admin';
    document.querySelector('#password').value='test-pw';
    document.querySelector('#login-form').requestSubmit();
  `);
  check('login lands on dashboard', await waitFor(`!!document.querySelector('#keys-table')`));

  // ---- 1. keys table: no Key/URL column ----
  const heads = await evalJs(`[...document.querySelectorAll('#keys-table th')].map(t=>t.textContent.trim())`);
  check('table has no Key/URL column', !heads.some((h) => h.includes('Key / URL')), JSON.stringify(heads));
  check('table has Label + Manage action', heads.includes('Label') && heads.includes('Actions'), JSON.stringify(heads));

  // create a key so Manage page can be checked
  await evalJs(`document.querySelector('#new-label').value='UI Test'; document.querySelector('#create-form').requestSubmit();`);
  // NOTE: the empty-state row also matches "1 row" — wait for the real row
  await waitFor(`!!document.querySelector('a[data-act="manage"]')`);
  const rowHasKeyId = await evalJs(`!!document.querySelector('#keys-table .key-id')`);
  check('key id not shown in table row', !rowHasKeyId);

  // Manage page still shows key id + URL
  await evalJs(`document.querySelector('a[data-act="manage"]').click()`);
  await waitFor(`!!document.querySelector('.key-url-full')`);
  const manageShows = await evalJs(`JSON.stringify({id: !!document.querySelector('.key-id-big'), url: !!document.querySelector('.key-url-full')})`);
  check('Manage page shows key id + URL', manageShows === '{"id":true,"url":true}', manageShows);

  // ---- 2. Sessions view ----
  await evalJs(`history.pushState(null,'','/panel/'); location.reload()`);
  await waitFor(`!!document.querySelector('#sessions-btn')`);
  await evalJs(`document.querySelector('#sessions-btn').click()`);
  await waitFor(`!!document.querySelector('#sessions-table')`);
  const sessView = await evalJs(`JSON.stringify({
    twoFaSection: !!document.querySelector('#tfa-enable'),
    table: !!document.querySelector('#sessions-table'),
    rows: document.querySelectorAll('#sessions-table tbody tr').length,
    revokeOthers: !!document.querySelector('#revoke-others')
  })`);
  const sv = JSON.parse(sessView);
  check('sessions view renders', sv.twoFaSection && sv.table && sv.revokeOthers, sessView);
  check('sessions table has rows', sv.rows >= 1, sessView);

  // rename modal: maxlength 32 enforced
  await evalJs(`document.querySelector('button[data-rename]').click()`);
  await waitFor(`!!document.querySelector('#s-name')`);
  const maxLen = await evalJs(`document.querySelector('#s-name').maxLength`);
  check('rename input maxlength 32', maxLen === 32, String(maxLen));
  const counter = await evalJs(`document.querySelector('#s-count').textContent`);
  check('char counter shown', /\/ 32/.test(counter), counter);
  await evalJs(`document.querySelector('#s-cancel').click()`);

  // 2FA enable modal shows the secret + otpauth
  await evalJs(`document.querySelector('#tfa-enable').click()`);
  await waitFor(`!!document.querySelector('.tfa-secret')`);
  const setupModal = await evalJs(`JSON.stringify({
    secret: document.querySelector('.tfa-secret') && document.querySelector('.tfa-secret').textContent.length,
    otpauth: document.querySelector('.otpauth-line') && document.querySelector('.otpauth-line').textContent.startsWith('otpauth://'),
    codeInput: !!document.querySelector('#tfa-code')
  })`);
  const sm = JSON.parse(setupModal);
  check('2FA setup modal shows secret + otpauth + code input', sm.secret === 32 && sm.otpauth && sm.codeInput, setupModal);
  await evalJs(`document.querySelector('#tfa-cancel').click()`);

  // ---- 3. login form shows code field when 2FA enabled ----
  // enable via API (secret from the pending setup is regenerated; fetch fresh)
  const secret = await evalJs(`fetch('${APP}/panel/api/2fa/setup',{method:'POST'}).then(r=>r.json()).then(j=>j.secret)`);
  const crypto = require('crypto');
  const totp = (s, t = Date.now()) => {
    const b32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0, v = 0; const out = [];
    for (const c of s.toUpperCase()) { v = (v << 5) | b32.indexOf(c); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } }
    const ctr = BigInt(Math.floor(t / 30000)); const msg = Buffer.alloc(8); msg.writeBigUInt64BE(ctr);
    const h = crypto.createHmac('sha1', Buffer.from(out)).update(msg).digest();
    const o = h[h.length - 1] & 0x0f;
    return String(((h[o] & 0x7f) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1000000).padStart(6, '0');
  };
  const enableOk = await evalJs(`fetch('${APP}/panel/api/2fa/enable',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:'${totp(secret)}'})}).then(r=>r.ok)`);
  check('2FA enabled via API', enableOk === true);
  // dismiss the recovery modal, sign out, and check the login form
  await evalJs(`document.querySelector('#rc-done') && document.querySelector('#rc-done').click()`);
  await waitFor(`!!document.querySelector('#tfa-disable')`);
  await evalJs(`document.querySelector('#logout-btn').click()`);
  await waitFor(`!!document.querySelector('#login-form')`);
  const loginHasCode = await evalJs(`JSON.stringify({
    field: !!document.querySelector('#code'),
    visible: getComputedStyle(document.querySelector('#code-field')).display !== 'none'
  })`);
  check('login form shows 2FA code field', loginHasCode === '{"field":true,"visible":true}', loginHasCode);

  // login with wrong code rejected + code field stays
  await evalJs(`
    document.querySelector('#username').value='admin';
    document.querySelector('#password').value='test-pw';
    document.querySelector('#code').value='123456';
    document.querySelector('#login-form').requestSubmit();
  `);
  await waitFor(`document.querySelector('#login-error').textContent.length > 0`);
  const loginErr = await evalJs(`document.querySelector('#login-error').textContent`);
  check('wrong code shows login error', /code/i.test(loginErr), loginErr);

  // sign back in with the correct code
  await evalJs(`
    document.querySelector('#code').value='${totp(secret)}';
    document.querySelector('#login-form').requestSubmit();
  `);
  check('login with correct code lands on dashboard', await waitFor(`location.pathname === '/panel/' && !!document.querySelector('#keys-table')`));

  // cleanup: disable 2FA so subsequent runs are unaffected
  await evalJs(`document.querySelector('#sessions-btn').click()`);
  await waitFor(`!!document.querySelector('#tfa-disable')`);
  await evalJs(`document.querySelector('#tfa-disable').click()`);
  await waitFor(`!!document.querySelector('#td-pass')`);
  await evalJs(`
    document.querySelector('#td-pass').value='test-pw';
    document.querySelector('#td-code').value='${totp(secret)}';
    document.querySelector('#td-go').click();
  `);
  await waitFor(`!!document.querySelector('#tfa-enable')`);
  const disabled = await evalJs(`!document.querySelector('#tfa-disable') && !!document.querySelector('#tfa-enable')`);
  check('2FA disabled via UI', disabled === true);

  ws.close();
  console.log('');
  if (failures === 0) console.log('ALL UI SMOKE CHECKS PASSED');
  else {
    console.log(`${failures} UI SMOKE CHECK(S) FAILED`);
    process.exitCode = 1;
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('ui smoke crashed:', e);
  process.exit(1);
});
