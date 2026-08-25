'use strict';

/*
 * sessions-2fa-check.js — end-to-end test for admin session tracking and
 * TOTP two-factor authentication. Expects mock-master.js on :3900 and the
 * gate (bundled) on :8086 with a FRESH data file.
 */

const BASE = 'http://127.0.0.1:8086';

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name} ${extra}`);
  }
}

/* Minimal RFC 6238 TOTP for the test (30s period, SHA1, 6 digits). */
const crypto = require('crypto');
function totp(secret, timeMs = Date.now()) {
  const b32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = secret.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const c of clean) {
    value = (value << 5) | b32.indexOf(c);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  const counter = BigInt(Math.floor(timeMs / 30000));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter);
  const hmac = crypto.createHmac('sha1', Buffer.from(out)).update(msg).digest();
  const o = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[o] & 0x7f) << 24) | (hmac[o + 1] << 16) | (hmac[o + 2] << 8) | hmac[o + 3];
  return String(bin % 1000000).padStart(6, '0');
}

async function main() {
  // --- login creates a tracked session ---
  let res = await fetch(`${BASE}/panel/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-pw' }),
  });
  check('login ok', res.status === 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const authHeaders = { cookie, 'content-type': 'application/json' };

  // --- auth-status (public) ---
  res = await fetch(`${BASE}/panel/api/auth-status`);
  const pub = await res.json();
  check('auth-status public + 2FA off', res.status === 200 && pub.twoFactorEnabled === false, JSON.stringify(pub));

  // --- sessions list shows the current session ---
  res = await fetch(`${BASE}/panel/api/sessions`, { headers: authHeaders });
  check('sessions list 200', res.status === 200);
  const s1 = await res.json();
  check('one session tracked', s1.sessions.length === 1, JSON.stringify(s1));
  check('session is current', s1.sessions[0] && s1.sessions[0].current === true);
  check('session has ip + ua + timestamps',
    !!(s1.sessions[0] && s1.sessions[0].lastIp && s1.sessions[0].userAgent && s1.sessions[0].createdAt && s1.sessions[0].lastSeenAt));
  check('session ttl reported', typeof s1.sessionTtlDays === 'number');
  const sid = s1.sessions[0].id;

  // --- second login from another "device" (different UA) ---
  res = await fetch(`${BASE}/panel/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' },
    body: JSON.stringify({ username: 'admin', password: 'test-pw' }),
  });
  const cookie2 = res.headers.get('set-cookie').split(';')[0];
  res = await fetch(`${BASE}/panel/api/sessions`, { headers: { cookie: cookie2 } });
  const s2 = await res.json();
  check('two sessions tracked', s2.sessions.length === 2, JSON.stringify(s2.sessions.map((x) => x.name)));
  const cur = s2.sessions.find((x) => x.current);
  const mobile = s2.sessions.find((x) => !x.current);
  check('current session is the iPhone login', cur && /iPhone/i.test(cur.name), JSON.stringify(cur && cur.name));
  check('exactly one current', s2.sessions.filter((x) => x.current).length === 1);

  // --- rename (32 char limit) ---
  res = await fetch(`${BASE}/panel/api/sessions/${sid}`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({ name: 'Office desktop' }),
  });
  check('rename ok', res.status === 200);
  res = await fetch(`${BASE}/panel/api/sessions/${sid}`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({ name: 'x'.repeat(33) }),
  });
  check('rename over 32 chars rejected', res.status === 400, res.status);
  res = await fetch(`${BASE}/panel/api/sessions/${sid}`, {
    method: 'PATCH',
    headers: authHeaders,
    body: JSON.stringify({ name: '   ' }),
  });
  check('empty rename rejected', res.status === 400, res.status);

  // --- revoke the mobile (other) session -> its cookie dies ---
  // Use cookie2 (the current iPhone session) so the revoked one is NOT current.
  res = await fetch(`${BASE}/panel/api/sessions/${mobile.id}`, { method: 'DELETE', headers: { cookie: cookie2 } });
  check('revoke session ok', res.status === 200 && (await res.json()).revokedCurrent === false, res.status);
  res = await fetch(`${BASE}/panel/api/me`, { headers: authHeaders }); // cookie1 = the revoked one
  check('revoked cookie rejected', res.status === 401, res.status);

  // --- revoke-others keeps the current session ---
  res = await fetch(`${BASE}/panel/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'curl/8.0' },
    body: JSON.stringify({ username: 'admin', password: 'test-pw' }),
  });
  const cookie3 = res.headers.get('set-cookie').split(';')[0];
  res = await fetch(`${BASE}/panel/api/sessions/revoke-others`, {
    method: 'POST',
    headers: { cookie: cookie3 },
  });
  const ro = await res.json();
  check('revoke-others ok', ro.ok === true && ro.revoked >= 1, JSON.stringify(ro));
  res = await fetch(`${BASE}/panel/api/sessions`, { headers: { cookie: cookie3 } });
  const s3 = await res.json();
  check('only current session remains', s3.sessions.length === 1 && s3.sessions[0].current, JSON.stringify(s3.sessions));
  // cookie1 was revoked too
  res = await fetch(`${BASE}/panel/api/me`, { headers: authHeaders });
  check('old cookie revoked by revoke-others', res.status === 401, res.status);

  // --- 2FA setup + enable ---
  res = await fetch(`${BASE}/panel/api/2fa/setup`, { method: 'POST', headers: { cookie: cookie3 } });
  check('2fa setup ok', res.status === 200);
  const setup = await res.json();
  check('secret + otpauth returned', /^[A-Z2-7]{32}$/.test(setup.secret) && setup.otpauth.startsWith('otpauth://totp/'), JSON.stringify({ s: setup.secret, u: setup.otpauth }));

  res = await fetch(`${BASE}/panel/api/2fa/enable`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookie3 },
    body: JSON.stringify({ code: '000000' }),
  });
  check('enable with wrong code rejected', res.status === 400, res.status);

  const good = totp(setup.secret);
  res = await fetch(`${BASE}/panel/api/2fa/enable`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookie3 },
    body: JSON.stringify({ code: good }),
  });
  const en = await res.json();
  check('enable with live code ok', res.status === 200 && en.ok === true, JSON.stringify(en));
  check('10 recovery codes issued', Array.isArray(en.recoveryCodes) && en.recoveryCodes.length === 10 &&
    en.recoveryCodes.every((c) => /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(c)), JSON.stringify(en.recoveryCodes));

  // --- auth-status now reports enabled (public) ---
  res = await fetch(`${BASE}/panel/api/auth-status`);
  check('auth-status reports 2FA on', (await res.json()).twoFactorEnabled === true);

  // --- login without code rejected ---
  res = await fetch(`${BASE}/panel/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-pw' }),
  });
  const noCode = await res.json();
  check('login without code rejected', res.status === 401 && noCode.twoFactorRequired === true, JSON.stringify(noCode));

  // --- login with wrong code rejected ---
  res = await fetch(`${BASE}/panel/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-pw', code: '123456' }),
  });
  check('login with wrong code rejected', res.status === 401, res.status);

  // --- login with correct TOTP code works ---
  res = await fetch(`${BASE}/panel/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-pw', code: totp(setup.secret) }),
  });
  check('login with TOTP code ok', res.status === 200);
  const cookie4 = res.headers.get('set-cookie').split(';')[0];

  // --- recovery code sign-in (then it's consumed) ---
  const rc = en.recoveryCodes[0];
  res = await fetch(`${BASE}/panel/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-pw', code: rc }),
  });
  check('login with recovery code ok', res.status === 200, res.status);
  res = await fetch(`${BASE}/panel/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-pw', code: rc }),
  });
  check('recovery code single-use (reuse rejected)', res.status === 401, res.status);

  // --- disable requires password + code ---
  res = await fetch(`${BASE}/panel/api/2fa/disable`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookie4 },
    body: JSON.stringify({ password: 'wrong', code: totp(setup.secret) }),
  });
  check('disable with wrong password rejected', res.status === 401, res.status);
  res = await fetch(`${BASE}/panel/api/2fa/disable`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookie4 },
    body: JSON.stringify({ password: 'test-pw', code: '000000' }),
  });
  check('disable with wrong code rejected', res.status === 400, res.status);
  res = await fetch(`${BASE}/panel/api/2fa/disable`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookie4 },
    body: JSON.stringify({ password: 'test-pw', code: totp(setup.secret) }),
  });
  check('disable ok', res.status === 200 && (await res.json()).ok === true);

  // --- password-only login works again ---
  res = await fetch(`${BASE}/panel/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-pw' }),
  });
  check('password-only login works after disable', res.status === 200, res.status);

  // --- logout revokes the session server-side ---
  const cookie5 = res.headers.get('set-cookie').split(';')[0];
  res = await fetch(`${BASE}/panel/api/logout`, { method: 'POST', headers: { cookie: cookie5 } });
  check('logout ok', res.status === 204, res.status);
  res = await fetch(`${BASE}/panel/api/me`, { headers: { cookie: cookie5 } });
  check('session dead after logout', res.status === 401, res.status);

  console.log('');
  if (failures === 0) console.log('ALL SESSIONS/2FA CHECKS PASSED');
  else {
    console.log(`${failures} SESSIONS/2FA CHECK(S) FAILED`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('sessions/2fa check crashed:', e);
  process.exitCode = 1;
});
