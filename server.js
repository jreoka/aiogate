#!/usr/bin/env node
'use strict';

/*
 * aio-gate — a key-gated proxy in front of AIOStreams.
 *
 * One master AIOStreams manifest URL lives on the server. Friends/family get
 * per-user "keys" (`/go/<key>/manifest.json`) which are proxied to the master.
 * Keys can be paused / revoked / deleted from the admin panel without touching
 * the master instance at all.
 *
 * How the URL mapping works:
 *
 *   client:  /go/<key>/manifest.json                  ->  master: /stremio/<uuid>/<pass>/manifest.json
 *   client:  /go/<key>/stream/<type>/<id>.json        ->  master: /stremio/<uuid>/<pass>/stream/<type>/<id>.json
 *   client:  /go/<key>/v/<variant>/manifest.json      ->  master: /stremio/<uuid>/<pass>/v/<variant>/manifest.json
 *   client:  /go/<key>/raw/<any path>                 ->  master: /<any path>          (origin-absolute URLs,
 *                                                       e.g. /api/v1/debrid/playback/...)
 *
 * Every response body and redirect that contains the master origin (or any
 * origin listed in REWRITE_ORIGINS) has those URLs rewritten to route back
 * through the gate, so the master address is never exposed to key holders.
 *
 * Zero runtime dependencies: pure Node >= 20.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ============================================================
 * Configuration
 * ============================================================ */

const ENV = process.env;

const PORT = clampInt(ENV.PORT, 8080, 1, 65535);
const HOST = ENV.HOST || '0.0.0.0';

// Admin credentials: explicit env, or fall back to the first AIOSTREAMS_AUTH
// pair (comma-separated `user:pass`) so a bundled container only needs one
// credential set for both the gate panel and the AIOStreams panel.
const AIOSTREAMS_AUTH_PAIR = parseAuthPair(ENV.AIOSTREAMS_AUTH);
const ADMIN_USERNAME =
  ENV.ADMIN_USERNAME || (AIOSTREAMS_AUTH_PAIR && AIOSTREAMS_AUTH_PAIR.username) || 'admin';
const ADMIN_PASSWORD =
  ENV.ADMIN_PASSWORD || (AIOSTREAMS_AUTH_PAIR && AIOSTREAMS_AUTH_PAIR.password) || '';
const SESSION_SECRET =
  ENV.SESSION_SECRET || sha256('aio-gate:' + ADMIN_PASSWORD);
const DATA_FILE =
  ENV.DATA_FILE || path.join(process.cwd(), 'data', 'keys.json');
const PUBLIC_BASE = (ENV.PUBLIC_BASE || '').replace(/\/+$/, '');
const TRUST_PROXY = !isFalsy(ENV.TRUST_PROXY);
const KEY_LENGTH = clampInt(ENV.KEY_LENGTH, 12, 8, 32);
// Watch history retention: entries older than this are pruned automatically
// to keep the data file small. Configurable via HISTORY_RETENTION_DAYS.
const HISTORY_RETENTION_MS =
  clampInt(ENV.HISTORY_RETENTION_DAYS, 30, 1, 365) * 24 * 3600 * 1000;
const HISTORY_MAX_PER_KEY = clampInt(ENV.HISTORY_MAX_PER_KEY, 2000, 50, 50000);
// Timeout for the best-effort title lookup against the master's /meta
// endpoint. AIOStreams can take a while to aggregate meta, so this is
// generous but still bounded.
const META_FETCH_TIMEOUT_MS = 15000;
// How long to wait before retrying a titleless history entry (the panel
// polls every 30s, so one retry per poll at most). Configurable via
// HISTORY_META_RETRY_MS (1000-3600000).
const HISTORY_META_RETRY_MS = clampInt(
  ENV.HISTORY_META_RETRY_MS,
  30000,
  1000,
  3600000
);
// When the master can't resolve a title (no meta resource, error meta, slow
// or down), fall back to IMDb's unofficial suggestion API — the same one
// Torrentio uses — for tt* ids. No API key needed. TITLE_IMDB_FALLBACK=0
// disables it; IMDB_SUGGEST_URL overrides the endpoint (mainly for tests).
const TITLE_IMDB_FALLBACK =
  ENV.TITLE_IMDB_FALLBACK === undefined
    ? true
    : isTruthy(ENV.TITLE_IMDB_FALLBACK);
const IMDB_SUGGEST_BASE = (
  ENV.IMDB_SUGGEST_URL || 'https://v2.sg.media-imdb.com'
).replace(/\/+$/, '');
// Unknown ids are cached negative so we don't re-hit IMDb for them too often.
const IMDB_FAIL_TTL_MS = 6 * 3600 * 1000;
const imdbFailCache = new Map();
const MAX_REWRITE_BYTES = 16 * 1024 * 1024;
const LOGIN_MAX_FAILS = 10;
const LOGIN_LOCKOUT_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

// Bundled mode: AIOStreams runs next to the gate inside the same container.
// When AIOSTREAMS_INTERNAL_URL is set, the gate owns the whole public root
// namespace and admin-gated-transparently proxies everything else to the
// internal AIOStreams, so the AIOStreams panel is never public.
// Bundled mode is the only mode: AIOStreams runs next to the gate inside the
// same container and the gate owns the whole public root namespace,
// admin-gating a transparent proxy to the internal AIOStreams. The default
// matches the container layout (docker/start.sh binds AIOStreams to the
// internal port; the gate owns the public port).
const AIOSTREAMS_INTERNAL_URL = (
  ENV.AIOSTREAMS_INTERNAL_URL ||
  `http://127.0.0.1:${ENV.AIOSTREAMS_INTERNAL_PORT || 3210}`
).replace(/\/+$/, '');

if (!ADMIN_PASSWORD) {
  console.error(
    'FATAL: ADMIN_PASSWORD (or AIOSTREAMS_AUTH) environment variable is required'
  );
  process.exit(1);
}

// MASTER_URL and PUBLIC_BASE are now runtime-configurable from the admin
// panel (stored in the data file). Env vars act as defaults / fallbacks.
const ENV_MASTER_URL = (ENV.MASTER_URL || '').trim() || null;
if (ENV_MASTER_URL) {
  try {
    parseMaster(ENV_MASTER_URL); // validate loudly at boot
  } catch (e) {
    console.error(`FATAL: MASTER_URL is not a valid URL: ${e.message}`);
    process.exit(1);
  }
} else {
  console.warn(
    '[boot] WARNING: MASTER_URL is not set — configure it in the admin panel (Settings)'
  );
}

const INTERNAL = parseOrigin(AIOSTREAMS_INTERNAL_URL);

// Env-supplied origins rewritten out of /go responses. The master origin is
// dynamic (it can change from the panel) and is prepended per request.
const AUTO_ORIGINS = [];
for (const raw of [ENV.BASE_URL, AIOSTREAMS_INTERNAL_URL, ENV_MASTER_URL]) {
  if (!raw) continue;
  try {
    AUTO_ORIGINS.push(new URL(raw).origin);
  } catch {
    /* ignore */
  }
}
const EXTRA_ORIGINS = (ENV.REWRITE_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((o) => {
    try {
      return new URL(o).origin;
    } catch {
      return null;
    }
  })
  .filter(Boolean);
const REWRITE_ORIGINS_BOOT = [...new Set([...AUTO_ORIGINS, ...EXTRA_ORIGINS])];

console.log(
  `[boot] bundled mode: AIOStreams at ${AIOSTREAMS_INTERNAL_URL} — root namespace is admin-gated`
);

/* ============================================================
 * Small helpers
 * ============================================================ */

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function isTruthy(v) {
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function isFalsy(v) {
  return v === '0' || v === 'false' || v === 'no' || v === 'off';
}

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(Math.max(n, min), max);
}

/* Duration parsing for expiresAt: "7d", "2y", "1w 3d 12h" etc. */
function parseDurationMs(input) {
  const s = String(input).trim();
  if (!s) return null;
  // ISO date-looking strings are not durations
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  const re = /(\d+(?:\.\d+)?)\s*([a-zA-Z]+)/g;
  let total = 0;
  let count = 0;
  let lastIndex = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const gap = s.slice(lastIndex, m.index).trim();
    if (gap !== '') return null;
    const val = parseFloat(m[1]);
    const unit = m[2].toLowerCase();
    let msPerUnit = null;
    if (/^y(rs?)?$|^years?$/.test(unit)) msPerUnit = 365 * 24 * 3600 * 1000;
    else if (/^mo(n)?s?$|^months?$/.test(unit)) msPerUnit = 30 * 24 * 3600 * 1000;
    else if (/^w(ks?)?$|^weeks?$/.test(unit)) msPerUnit = 7 * 24 * 3600 * 1000;
    else if (/^d(ays?)?$/.test(unit)) msPerUnit = 24 * 3600 * 1000;
    else if (/^h(rs?)?$|^hours?$/.test(unit)) msPerUnit = 3600 * 1000;
    else if (/^m$|^mins?$|^minutes?$/.test(unit)) msPerUnit = 60 * 1000;
    else if (/^s$|^secs?$|^seconds?$/.test(unit)) msPerUnit = 1000;
    else return null;
    total += val * msPerUnit;
    count++;
    lastIndex = re.lastIndex;
  }
  if (count === 0) return null;
  if (s.slice(lastIndex).trim() !== '') return null;
  if (total <= 0) return null;
  return total;
}

function parseExpiresAt(value) {
  if (value == null) return null;
  const v = String(value).trim();
  if (!v) return null;
  if (/^(never|none)$/i.test(v)) return null;
  const dur = parseDurationMs(v);
  if (dur !== null) return new Date(Date.now() + dur).toISOString();
  const t = Date.parse(v);
  if (!Number.isNaN(t)) return new Date(t).toISOString();
  const err = new Error('invalid expiresAt — use e.g. 7d, 30d, 1y or a date like 2026-12-31');
  err.status = 400;
  throw err;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  if (!res.headersSent) {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
  }
  res.end(body);
}

/**
 * Best-effort client IP.
 *
 * The direct TCP peer (req.socket.remoteAddress) is only the real client when
 * nothing sits in front. Behind a reverse proxy or Docker bridge it is the
 * proxy/bridge address (e.g. 172.17.0.1), so by default (TRUST_PROXY on)
 * we honor X-Forwarded-For (first hop = original client) and fall back to
 * X-Real-IP. Those headers are never trusted with TRUST_PROXY=0, or a
 * client could spoof them (and bypass IP-based login rate limiting).
 */
function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) {
      const first = String(fwd).split(',')[0].trim();
      if (first) return first;
    }
    const real = req.headers['x-real-ip'];
    if (real && String(real).trim()) return String(real).trim();
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function nowIso() {
  return new Date().toISOString();
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/* ------------------------------------------------------------
 * Env / URL parsing helpers
 * ------------------------------------------------------------ */

function parseAuthPair(raw) {
  if (!raw) return null;
  const entry = String(raw).split(',')[0].trim();
  const sep = entry.indexOf(':');
  if (sep <= 0 || sep === entry.length - 1) return null;
  return {
    username: entry.slice(0, sep).trim(),
    password: entry.slice(sep + 1).trim(),
  };
}

function parseOrigin(raw) {
  const url = new URL(raw);
  return {
    origin: url.origin,
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    hostHeader: url.host,
  };
}

/* ------------------------------------------------------------
 * Master URL parsing
 * ------------------------------------------------------------ */

function parseMaster(raw) {
  const url = new URL(raw);
  const origin = url.origin;
  const m = url.pathname.match(
    /^\/(stremio|chilllink)\/([^/]+)\/([^/]+)(?:\/.*)?$/
  );
  const masterRoot = m ? `/${m[1]}/${m[2]}/${m[3]}` : url.pathname.replace(/\/+$/, '');
  return {
    origin,
    masterRoot,
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    hostHeader: url.host,
  };
}

/* ============================================================
 * Storage (single JSON file, atomic writes, debounced save)
 * ============================================================ */

let state = null;
let saveTimer = null;

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.keys) {
      if (!parsed.settings) parsed.settings = {};
      if (!Array.isArray(parsed.history)) parsed.history = [];
      if (!parsed.sessions || typeof parsed.sessions !== 'object')
        parsed.sessions = {};
      // Strip legacy bandwidth-tracking fields (bytes / daily buckets) from
      // data files written by older versions. Requests / last-used remain.
      for (const key of Object.values(parsed.keys)) {
        if (key.usage) {
          delete key.usage.bytes;
          delete key.usage.bytes30d;
          delete key.usage.daily;
        }
      }
      if (Array.isArray(parsed.history)) {
        for (const e of parsed.history) delete e.bytes;
      }
      state = parsed;
      return;
    }
  } catch {
    /* first boot or corrupt file -> start fresh */
  }
  state = { version: 1, keys: {}, settings: {}, sessions: {} };
  saveStateSync();
}

/* ------------------------------------------------------------
 * Effective (runtime-overridable) configuration
 *
 * Settings stored in the data file take precedence over env vars.
 * ------------------------------------------------------------ */

function effectiveMasterUrl() {
  const s = state && state.settings && state.settings.masterUrl;
  const v = s && typeof s === 'string' ? s.trim() : '';
  return v || ENV_MASTER_URL;
}

function effectiveMaster() {
  const url = effectiveMasterUrl();
  if (!url) return null;
  try {
    return parseMaster(url);
  } catch {
    return null;
  }
}

function effectivePublicBase() {
  const s = state && state.settings && state.settings.publicBase;
  const v = s && typeof s === 'string' ? s.trim() : '';
  const base = v || PUBLIC_BASE;
  return base ? base.replace(/\/+$/, '') : '';
}

function effectiveOrigins(master) {
  if (!master) return REWRITE_ORIGINS_BOOT;
  return [...new Set([master.origin, ...REWRITE_ORIGINS_BOOT])];
}

function saveStateSync() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error(`[storage] save failed: ${e.message}`);
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveStateSync();
  }, 400);
}

function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveStateSync();
}

/* ============================================================
 * Sessions (HMAC-signed cookie + tracked, revocable records)
 *
 * Each login creates a record in state.sessions (persisted) so the admin
 * can name, inspect and revoke sessions from the panel. The cookie payload
 * carries the session id; records are the source of truth for revocation.
 * ============================================================ */

const sessionTouchCache = new Map(); // sessionId -> last touch timestamp
const SESSION_MAX = 100; // keep newest N sessions, drop the rest

/** Best-effort "Browser · OS" label from a user-agent string. */
function defaultSessionName(ua) {
  const lower = String(ua || '').toLowerCase();
  if (!lower) return 'Unknown device';
  let os = 'Unknown OS';
  // Mobile first: "iPhone OS 17 … like Mac OS X" must not match macOS.
  if (lower.includes('iphone')) os = 'iPhone';
  else if (lower.includes('ipad')) os = 'iPad';
  else if (lower.includes('android')) os = 'Android';
  else if (lower.includes('windows')) os = 'Windows';
  else if (lower.includes('mac os') || lower.includes('macintosh')) os = 'macOS';
  else if (lower.includes('linux')) os = 'Linux';
  let browser = 'Browser';
  if (lower.includes('edg/')) browser = 'Edge';
  else if (lower.includes('opr/') || lower.includes('opera')) browser = 'Opera';
  else if (lower.includes('chrome')) browser = 'Chrome';
  else if (lower.includes('firefox')) browser = 'Firefox';
  else if (lower.includes('safari')) browser = 'Safari';
  const mobile = lower.includes('mobile') ? ' · mobile' : '';
  return `${browser} · ${os}${mobile}`.slice(0, 32);
}

function createSession(username, req) {
  const id = crypto.randomBytes(16).toString('hex');
  const ua = String(req.headers['user-agent'] || '').slice(0, 300);
  state.sessions[id] = {
    id,
    name: defaultSessionName(ua),
    createdAt: nowIso(),
    lastSeenAt: nowIso(),
    lastIp: clientIp(req),
    userAgent: ua,
  };
  pruneSessions();
  const payload = Buffer.from(
    JSON.stringify({
      u: username,
      e: Date.now() + SESSION_TTL_MS,
      s: id,
    })
  ).toString('base64url');
  const sig = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(payload)
    .digest('base64url');
  saveStateSync(); // sessions persist so revocation survives restarts
  return payload + '.' + sig;
}

/**
 * Resolve the admin session from a cookie header, or null. Returns
 * `{ username, sessionId }`. Legacy cookies without a session id (created
 * before session tracking existed) still validate and work, but can't be
 * revoked individually.
 */
function readSession(cookieHeader) {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(/(?:^|;\s*)aio_session=([^;]+)/);
  if (!m) return null;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig) return null;
  const expected = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(payload)
    .digest('base64url');
  if (!safeEqual(expected, sig)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof data.e !== 'number' || data.e < Date.now()) return null;
    if (typeof data.s === 'string') {
      const rec = state.sessions[data.s];
      if (!rec || rec.revoked) return null;
      return { username: data.u, sessionId: data.s };
    }
    return { username: data.u, sessionId: null }; // legacy cookie
  } catch {
    return null;
  }
}

/** Throttled "last seen" heartbeat so the panel shows live-ish activity. */
function touchSession(sessionId) {
  const rec = state.sessions && state.sessions[sessionId];
  if (!rec) return;
  const now = Date.now();
  if (now - (sessionTouchCache.get(sessionId) || 0) < 60_000) return;
  sessionTouchCache.set(sessionId, now);
  rec.lastSeenAt = nowIso();
  scheduleSave();
}

function revokeSession(sessionId) {
  if (!state.sessions[sessionId]) return false;
  delete state.sessions[sessionId];
  saveStateSync();
  return true;
}

/** Drop expired sessions and cap the tracked set to the newest N. */
function pruneSessions() {
  const sessions = state.sessions || {};
  const cutoff = Date.now() - SESSION_TTL_MS;
  let changed = false;
  for (const [id, rec] of Object.entries(sessions)) {
    if (!rec || Date.parse(rec.createdAt || 0) < cutoff) {
      delete sessions[id];
      changed = true;
    }
  }
  const ids = Object.keys(sessions).sort(
    (a, b) =>
      (sessions[b].lastSeenAt || '').localeCompare(sessions[a].lastSeenAt || '')
  );
  for (const id of ids.slice(SESSION_MAX)) {
    delete sessions[id];
    changed = true;
  }
  if (changed) scheduleSave();
}

function listSessions() {
  return Object.values(state.sessions || {}).sort((a, b) =>
    (b.lastSeenAt || '').localeCompare(a.lastSeenAt || '')
  );
}

/* ============================================================
 * Two-factor authentication (TOTP, zero-dependency)
 * ============================================================ */

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/1/I/L/O
const TOTP_PERIOD_MS = 30_000;
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1; // ±1 step either side

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(s) {
  const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const c of clean) {
    const idx = B32_ALPHABET.indexOf(c);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function randomBase32(len) {
  const buf = crypto.randomBytes(Math.ceil((len * 5) / 8));
  return base32Encode(buf).slice(0, len);
}

/** RFC 6238 TOTP code for a base32 secret at a given time (ms). */
function totpCode(secret, timeMs = Date.now()) {
  const counter = BigInt(Math.floor(timeMs / TOTP_PERIOD_MS));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter);
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

function verifyTotp(secret, code) {
  const c = String(code || '').trim();
  if (!/^\d{6}$/.test(c)) return false;
  const now = Date.now();
  for (let i = -TOTP_WINDOW; i <= TOTP_WINDOW; i++) {
    if (safeEqual(totpCode(secret, now + i * TOTP_PERIOD_MS), c)) return true;
  }
  return false;
}

function otpauthUri(secret) {
  const label = encodeURIComponent('AIO Gate:' + ADMIN_USERNAME);
  const issuer = encodeURIComponent('AIO Gate');
  return `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&period=30&digits=6&algorithm=SHA1`;
}

function twoFactor() {
  return (state.settings && state.settings.twoFactor) || null;
}

function twoFactorEnabled() {
  const tf = twoFactor();
  return !!(tf && tf.enabled && tf.secret);
}

/** Generate n recovery codes ("ABCD-EFGH" style); returns { plain, hashes }. */
function generateRecoveryCodes(n = 10) {
  const plain = [];
  const hashes = [];
  for (let i = 0; i < n; i++) {
    let chunk = '';
    for (let j = 0; j < 8; j++) {
      chunk += RECOVERY_ALPHABET[crypto.randomInt(0, RECOVERY_ALPHABET.length)];
    }
    const code = chunk.slice(0, 4) + '-' + chunk.slice(4);
    plain.push(code);
    hashes.push(sha256(code.toUpperCase().replace(/[^A-Z0-9]/g, '')));
  }
  return { plain, hashes };
}

/** Consume a recovery code if it matches an unused one. */
function useRecoveryCode(tf, code) {
  const norm = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (norm.length < 8) return false;
  const hashes = tf.recovery || [];
  for (let i = 0; i < hashes.length; i++) {
    if (hashes[i] === sha256(norm)) {
      hashes.splice(i, 1);
      saveStateSync(); // a one-time credential must persist immediately
      return true;
    }
  }
  return false;
}

/** True when a login 2FA challenge was satisfied (TOTP or recovery code). */
function passTwoFactor(code) {
  const tf = twoFactor();
  if (!tf || !tf.enabled || !tf.secret) return true; // 2FA not enabled
  if (verifyTotp(tf.secret, code)) return true;
  return useRecoveryCode(tf, code);
}

/* ============================================================
 * Key management
 * ============================================================ */

const KEY_STATUSES = new Set(['active', 'paused', 'revoked']);
const KEY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function randomKeyId(len) {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += KEY_ALPHABET[crypto.randomInt(0, KEY_ALPHABET.length)];
  }
  return out;
}

function listKeys() {
  return Object.values(state.keys).sort(
    (a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')
  );
}

function getKey(id) {
  return state.keys[id] || null;
}

function createKey(fields) {
  let id;
  do {
    id = randomKeyId(KEY_LENGTH);
  } while (state.keys[id]);
  let expiresAt = null;
  if (fields.expiresAt !== undefined && fields.expiresAt !== null && String(fields.expiresAt).trim() !== '') {
    expiresAt = parseExpiresAt(fields.expiresAt);
  }
  const key = {
    id,
    label: String(fields.label || 'Key ' + id.slice(0, 6)),
    note: String(fields.note || ''),
    status: 'active',
    expiresAt,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    usage: { requests: 0, lastUsedAt: null, lastIp: null },
  };
  state.keys[id] = key;
  saveStateSync(); // admin mutations persist immediately
  return key;
}

function updateKey(id, patch) {
  const key = state.keys[id];
  if (!key) return null;
  if (patch.label !== undefined) key.label = String(patch.label).slice(0, 120);
  if (patch.note !== undefined) key.note = String(patch.note).slice(0, 500);
  if (patch.status !== undefined) {
    if (!KEY_STATUSES.has(patch.status)) {
      const err = new Error('invalid status');
      err.status = 400;
      throw err;
    }
    key.status = patch.status;
  }
  if (patch.expiresAt !== undefined) {
    key.expiresAt = parseExpiresAt(patch.expiresAt);
  }
  key.updatedAt = nowIso();
  saveStateSync();
  return key;
}

function deleteKey(id) {
  if (!state.keys[id]) return false;
  delete state.keys[id];
  // Watch history is owned by its key — purge it so nothing lingers.
  if (state.history) {
    state.history = state.history.filter((e) => e.keyId !== id);
  }
  saveStateSync();
  return true;
}

function pruneExpiredKeys() {
  const now = Date.now();
  let changed = false;
  for (const [id, key] of Object.entries(state.keys)) {
    if (key.expiresAt && Date.parse(key.expiresAt) < now) {
      delete state.keys[id];
      if (state.history) {
        state.history = state.history.filter((e) => e.keyId !== id);
      }
      changed = true;
      console.log(`[keys] auto-deleted expired key ${id.slice(0, 6)} (${key.label})`);
    }
  }
  if (changed) saveStateSync();
  return changed;
}

function touchKey(key, ip) {
  const u = key.usage;
  u.requests += 1;
  u.lastUsedAt = nowIso();
  u.lastIp = ip || null;
  scheduleSave();
}

function keyStatusError(key) {
  const now = Date.now();
  if (key.status === 'paused') return [403, 'This key is paused.'];
  if (key.status === 'revoked') return [410, 'This key has been revoked.'];
  if (key.expiresAt && Date.parse(key.expiresAt) < now)
    return [410, 'This key has expired.'];
  return null;
}

/* ============================================================
 * Watch history (what each key streamed, 30-day retention)
 * ============================================================ */

const titleCache = new Map();
const TITLE_CACHE_MAX = 1000;
let lastPruneAt = 0;

/**
 * Extract { type, id } from a gate suffix for a stream lookup, or null.
 * Matches `/stream/<movie|series|channel>/<id>.json` including variant
 * paths (`/v/<variant>/stream/...`). Catalog / manifest / playback-segment
 * requests never match, so only "user asked to watch this" is recorded.
 */
function parseStreamRef(suffix) {
  const m = String(suffix).match(
    /(?:^|\/)stream\/(movie|series|channel)\/([^/?]+)\.json$/
  );
  if (!m) return null;
  let id = m[2];
  try {
    id = decodeURIComponent(id);
  } catch {
    /* keep raw */
  }
  return { type: m[1], id };
}

function applyMeta(entry, info) {
  entry.title = info.name;
  if (info.episode) {
    entry.season = info.episode.season;
    entry.episodeNumber = info.episode.number;
    entry.episodeName = info.episode.name;
  }
}

function recordStream(keyRec, ref, ip) {
  if (!state.history) state.history = [];
  const entry = {
    keyId: keyRec.id,
    ts: nowIso(),
    type: ref.type,
    id: ref.id,
    title: null,
    season: null,
    episodeNumber: null,
    episodeName: null,
    titleAttempted: false,
    ip: ip || null,
  };
  state.history.push(entry);
  pruneHistory();
  scheduleSave();
  // Best-effort title lookup, after the response — never blocks proxying.
  // metaAttemptedAt is stamped on every outcome (success or failure) so
  // keyHistory can retry titleless entries later without hammering the master.
  resolveMeta(ref.type, ref.id)
    .then((info) => {
      entry.metaAttemptedAt = Date.now();
      if (info && !entry.title) {
        entry.titleAttempted = true;
        applyMeta(entry, info);
        scheduleSave();
      }
    })
    .catch(() => {
      entry.metaAttemptedAt = Date.now();
    });
}

function pruneHistory(force) {
  const now = Date.now();
  if (!force && now - lastPruneAt < 60_000) return; // at most once a minute
  lastPruneAt = now;
  if (!state.history || !state.history.length) return;
  const cutoff = now - HISTORY_RETENTION_MS;
  let kept = state.history.filter((e) => {
    const t = Date.parse(e.ts);
    return !Number.isNaN(t) && t >= cutoff;
  });
  // Per-key cap: keep only the newest entries when a key goes over.
  if (kept.length) {
    const counts = {};
    for (const e of kept) counts[e.keyId] = (counts[e.keyId] || 0) + 1;
    if (Object.values(counts).some((n) => n > HISTORY_MAX_PER_KEY)) {
      const seen = {};
      kept = kept
        .reverse()
        .filter((e) => {
          seen[e.keyId] = (seen[e.keyId] || 0) + 1;
          return seen[e.keyId] <= HISTORY_MAX_PER_KEY;
        })
        .reverse();
    }
  }
  if (kept.length !== state.history.length) {
    state.history = kept;
    scheduleSave();
  }
}

/**
 * Newest-first history for one key. Entries recorded while the master wasn't
 * configured (or meta was slow) may still be missing a title — each gets one
 * lazy retry per entry, capped per call so a big backlog can't hammer the
 * master.
 */
function keyHistory(keyId, limit) {
  if (!state.history) return [];
  const out = [];
  const canResolve = !!effectiveMasterUrl() || TITLE_IMDB_FALLBACK;
  const now = Date.now();
  let reattempted = 0;
  for (let i = state.history.length - 1; i >= 0 && out.length < limit; i--) {
    const e = state.history[i];
    if (e.keyId !== keyId) continue;
    out.push(e);
    // Lazy retry for titleless entries: previously this set a sticky
    // titleAttempted flag, so a single transient failure (slow meta, alias
    // redirect not yet supported) permanently lost the title. Now failed
    // attempts are retried once the retry window has elapsed.
    if (canResolve && !e.title && reattempted < 30) {
      const lastAttempt = e.metaAttemptedAt || 0;
      if (now - lastAttempt >= HISTORY_META_RETRY_MS) {
        e.metaAttemptedAt = now;
        reattempted++;
        const rec = getKey(keyId);
        if (rec) {
          resolveMeta(e.type, e.id)
            .then((info) => {
              if (info && !e.title) {
                e.titleAttempted = true;
                applyMeta(e, info);
                scheduleSave();
              }
            })
            .catch(() => {});
        }
      }
    }
  }
  return out;
}

/**
 * Pull the human-readable bits we care about out of a meta response. For
 * series, `meta.videos` carries per-episode entries (id `tt123:1:2` -> season
 * 1, episode 2), so history rows can say "S01E02 Pilot" instead of just the
 * series title. Returns null when there's nothing to show.
 */
function parseMetaInfo(data, type, id) {
  const meta = data && data.meta;
  if (!meta) return null;
  const name = String(meta.name || '').trim();
  if (!name) return null;
  // AIOStreams error metas look like "[❌] Addon - Error" — that's a failure
  // placeholder, not a real title. Treat it as unresolved so the IMDb
  // fallback gets a chance instead of showing "[❌] ..." in watch history.
  if (name.includes('[❌]')) return null;
  const info = { name };
  if (type === 'series' && Array.isArray(meta.videos)) {
    const v = meta.videos.find((x) => String(x.id) === String(id));
    if (v) {
      const season = v.season != null ? Number(v.season) : null;
      const number =
        v.number != null
          ? Number(v.number)
          : v.episode != null
            ? Number(v.episode)
            : null;
      if (season != null || number != null) {
        info.episode = {
          season,
          number,
          name: v.title ? String(v.title) : null,
        };
      }
    }
  }
  // The meta named the show but didn't list this episode (e.g. a metadata
  // addon whose video ids don't match `tt123:1:2`). Still show S/E derived
  // from the episode id itself, like the IMDb fallback does.
  if (type === 'series' && !info.episode && String(id).includes(':')) {
    const parts = String(id).split(':');
    const s = Number(parts[1]);
    const n = Number(parts[2]);
    if (Number.isInteger(s) && s >= 0 && Number.isInteger(n) && n >= 0) {
      info.episode = { season: s, number: n, name: null };
    }
  }
  return info;
}

function fetchMetaInfo(master, type, id, lookupId) {
  return getMaster(
    master,
    `${master.masterRoot}/meta/${type}/${encodeURIComponent(id)}.json`,
    META_FETCH_TIMEOUT_MS
  ).then((res) => {
    if (!res || res.status !== 200) return null;
    try {
      const data = JSON.parse(res.body);
      // The episode-video lookup always uses the original streamed id
      // (tt123:1:2), even when the fetched meta is the series (tt123).
      return parseMetaInfo(data, type, lookupId || id);
    } catch {
      return null;
    }
  });
}

/**
 * GET a path on the master, following same-origin redirects (modern
 * AIOStreams install URLs are `/stremio/u/<alias>/...` aliases that 302 to
 * the real `/stremio/<uuid>/<password>/...` path; node's http.get does not
 * follow redirects on its own). Resolves `{ status, body }` with the body
 * capped, or null on network failure / off-origin redirect. Never throws.
 */
function getMaster(master, path, timeoutMs) {
  return new Promise((resolve) => {
    const mod = master.protocol === 'https:' ? https : http;
    const fetch = (p, hops) => {
      const req = mod.get(
        {
          protocol: master.protocol,
          hostname: master.hostname,
          port: master.port,
          path: p,
          timeout: timeoutMs,
          headers: { accept: 'application/json' },
        },
        (upRes) => {
          const status = upRes.statusCode || 0;
          if (
            status >= 300 &&
            status < 400 &&
            upRes.headers.location &&
            hops > 0
          ) {
            upRes.resume();
            try {
              const next = new URL(upRes.headers.location, master.origin);
              if (next.origin !== master.origin) return resolve(null);
              return fetch(next.pathname + next.search, hops - 1);
            } catch {
              return resolve(null);
            }
          }
          const chunks = [];
          let size = 0;
          upRes.on('data', (c) => {
            size += c.length;
            if (size <= 256 * 1024) chunks.push(c);
          });
          upRes.on('end', () =>
            resolve({ status, body: Buffer.concat(chunks).toString('utf8') })
          );
          upRes.on('error', () => resolve(null));
        }
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', () => resolve(null));
    };
    fetch(path, 5);
  });
}

/**
 * Best-effort, cached title info for a streamed item. Episode ids like
 * `tt123:1:2` resolve via the series meta (which carries the per-episode
 * `videos` array), falling back to the full id for masters that answer
 * episode-level meta directly. Only successful lookups are cached, so a
 * transient failure (master not configured yet, slow meta) isn't sticky.
 * Never throws.
 */
function resolveMeta(type, id) {
  const cacheKey = `${type}:${id}`;
  if (titleCache.has(cacheKey)) return Promise.resolve(titleCache.get(cacheKey));
  const masterUrl = effectiveMasterUrl();
  let master;
  try {
    master = parseMaster(masterUrl);
  } catch {
    // No usable master configured — the IMDb fallback can still name tt ids.
    return fallbackTitle(type, id, cacheKey);
  }
  const baseId = String(id).split(':')[0];
  // For episode ids (tt123:1:2) the series meta (base id) carries the
  // per-episode `videos` array, so look it up first; fall back to the full
  // id for masters that answer episode-level meta directly.
  const candidates = id !== baseId ? [baseId, id] : [baseId];
  return candidates
    .reduce(
      (p, cid) =>
        p.then((info) => info || fetchMetaInfo(master, type, cid, id)),
      Promise.resolve(null)
    )
    .then((info) => {
      if (info) {
        if (titleCache.size > TITLE_CACHE_MAX) titleCache.clear();
        titleCache.set(cacheKey, info);
        return info;
      }
      return fallbackTitle(type, id, cacheKey);
    });
}

/**
 * Last-resort title lookup against IMDb's suggestion API for tt* ids (the
 * same unofficial endpoint Torrentio uses). Only fires when the master's own
 * meta couldn't name the item. For series episode ids (tt123:1:2) it attaches
 * S/E numbers parsed from the id itself; the episode name still needs real
 * meta, so it stays null. Negative results are cached so unknown ids aren't
 * re-queried for a while.
 */
function fallbackTitle(type, id, cacheKey) {
  const baseId = String(id).split(':')[0];
  return imdbTitleLookup(baseId).then((fb) => {
    if (!fb) return null;
    if (type === 'series' && id !== baseId) {
      const parts = String(id).split(':');
      const s = Number(parts[1]);
      const n = Number(parts[2]);
      fb.episode = {
        season: Number.isInteger(s) && s >= 0 ? s : null,
        number: Number.isInteger(n) && n >= 0 ? n : null,
        name: null,
      };
    }
    if (titleCache.size > TITLE_CACHE_MAX) titleCache.clear();
    titleCache.set(cacheKey, fb);
    return fb;
  });
}

function imdbTitleLookup(baseId) {
  if (!TITLE_IMDB_FALLBACK) return Promise.resolve(null);
  if (!/^tt\d+$/.test(baseId)) return Promise.resolve(null);
  const lastFail = imdbFailCache.get(baseId) || 0;
  if (Date.now() - lastFail < IMDB_FAIL_TTL_MS) return Promise.resolve(null);
  const url = `${IMDB_SUGGEST_BASE}/suggestion/${baseId.slice(0, 1)}/${baseId}.json`;
  return getJson(url, 6000)
    .then((data) => {
      const hit =
        data && Array.isArray(data.d)
          ? data.d.find((x) => x && String(x.id) === baseId && x.l)
          : null;
      if (!hit) {
        imdbFailCache.set(baseId, Date.now());
        return null;
      }
      const name = String(hit.l).trim();
      return name ? { name } : null;
    })
    .catch(() => null);
}

/** GET a JSON URL with a bounded body and timeout. Resolves null on any
 * failure; never throws. */
function getJson(urlStr, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch {
      return resolve(null);
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        timeout: timeoutMs,
        headers: { accept: 'application/json' },
      },
      (upRes) => {
        if (upRes.statusCode !== 200) {
          upRes.resume();
          return resolve(null);
        }
        const chunks = [];
        let size = 0;
        upRes.on('data', (c) => {
          size += c.length;
          if (size <= 256 * 1024) chunks.push(c);
        });
        upRes.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            resolve(null);
          }
        });
        upRes.on('error', () => resolve(null));
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(null));
  });
}

/* ============================================================
 * Rewriting
 * ============================================================ */

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const TEXT_TYPE_PREFIXES = [
  'text/',
  'application/json',
  'application/manifest+json',
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/x-subrip',
  'application/dash+xml',
  'image/svg+xml',
];

function isTextType(ct) {
  const t = String(ct || '').split(';')[0].trim().toLowerCase();
  return TEXT_TYPE_PREFIXES.some((p) => t.startsWith(p));
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a text rewriter for one key.
 * - `origin + masterRoot`  ->  `<gateBase>/go/<key>`   (stremio resources)
 * - `origin`               ->  `<gateBase>/go/<key>/raw` (origin-absolute paths)
 * The lookahead ensures we never touch `masterx.example` or `master:8443`
 * style false positives, and never re-match the gate base we just wrote.
 */
function buildRewriter(keyId, gateBase, master, origins) {
  const alts = [];
  for (const origin of origins) {
    const root = origin === master.origin ? master.masterRoot : '';
    const rootPat = root ? `${escapeRegex(origin)}${escapeRegex(root)}` : null;
    const re = new RegExp(
      (rootPat ? `${rootPat}(?=[/?#&]|$)|` : '') +
        `${escapeRegex(origin)}(?=[/?#&]|$)`,
      'g'
    );
    alts.push({ re, root: rootPat });
  }
  return (text) => {
    for (const { re, root } of alts) {
      text = text.replace(re, (match) =>
        match === root
          ? `${gateBase}/go/${keyId}`
          : `${gateBase}/go/${keyId}/raw`
      );
    }
    return text;
  };
}

/* ============================================================
 * Proxy core
 * ============================================================ */

function getGateBase(req) {
  const base = effectivePublicBase();
  if (base) return base;
  const proto =
    TRUST_PROXY && req.headers['x-forwarded-proto']
      ? String(req.headers['x-forwarded-proto']).split(',')[0].trim()
      : req.socket && req.socket.encrypted
        ? 'https'
        : 'http';
  const host =
    TRUST_PROXY && req.headers['x-forwarded-host']
      ? String(req.headers['x-forwarded-host']).split(',')[0].trim()
      : req.headers['host'] || 'localhost';
  return `${proto}://${host}`;
}

/**
 * Map a gate suffix (the part after /go/<key>) to a path on the master.
 */
function mapSuffixToMasterPath(suffix, master) {
  if (suffix === 'raw') return '/';
  if (suffix.startsWith('raw/')) return '/' + suffix.slice(4);
  if (
    suffix.startsWith('stremio/') ||
    suffix.startsWith('chilllink/') ||
    suffix.startsWith('api/') ||
    suffix.startsWith(master.masterRoot.slice(1) + '/') ||
    suffix === master.masterRoot.slice(1)
  ) {
    return '/' + suffix;
  }
  return master.masterRoot + '/' + suffix;
}

function hasDotSegment(suffix) {
  return suffix
    .split('/')
    .some((seg) => seg === '..' || seg === '%2e%2e' || /^\.{2,}$/.test(seg));
}

function logHit(keyId, req, status, ms) {
  const shortKey = keyId ? keyId.slice(0, 6) : '-';
  console.log(
    `[${new Date().toISOString()}] key=${shortKey} ${req.method} ${req.url} -> ${status} (${ms}ms)`
  );
}

/**
 * Forward one request to the master and relay the response, rewriting the
 * master origin out of text bodies / redirects along the way.
 */
function forward(req, res, keyRec, suffix) {
  const started = Date.now();
  const ip = clientIp(req);
  const gateBase = getGateBase(req);

  const masterUrl = effectiveMasterUrl();
  if (!masterUrl) {
    sendJson(res, 503, {
      error: 'gate: master not configured — set MASTER_URL in Settings',
    });
    return;
  }
  let master;
  try {
    master = parseMaster(masterUrl);
  } catch {
    sendJson(res, 503, { error: 'gate: master URL is invalid' });
    return;
  }
  const rewriter = buildRewriter(
    keyRec.id,
    gateBase,
    master,
    effectiveOrigins(master)
  );

  const targetPath = mapSuffixToMasterPath(suffix, master);
  const query = req.url.indexOf('?') === -1 ? '' : req.url.slice(req.url.indexOf('?'));
  const isHead = req.method === 'HEAD';

  const mod = master.protocol === 'https:' ? https : http;
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (
      lk === 'host' ||
      lk === 'cookie' ||
      lk === 'connection' ||
      lk === 'accept-encoding' ||
      HOP_BY_HOP.has(lk)
    ) {
      continue;
    }
    headers[k] = v;
  }
  headers['host'] = master.hostHeader;
  headers['x-forwarded-for'] = req.headers['x-forwarded-for']
    ? `${req.headers['x-forwarded-for']}, ${ip}`
    : ip;
  headers['x-aio-gate-key'] = keyRec.id;

  const upstreamReq = mod.request(
    {
      protocol: master.protocol,
      hostname: master.hostname,
      port: master.port,
      path: targetPath + query,
      method: req.method,
      headers,
      timeout: 20000,
    },
    (upRes) => {
      const status = upRes.statusCode || 502;
      const ct = upRes.headers['content-type'] || '';
      const enc = upRes.headers['content-encoding'] || '';
      const rewriteBody =
        isTextType(ct) && !isHead && (!enc || enc === 'identity');

      const outHeaders = {};
      for (const [k, v] of Object.entries(upRes.headers)) {
        const lk = k.toLowerCase();
        if (HOP_BY_HOP.has(lk)) continue;
        if (lk === 'location') {
          const loc = String(v);
          // Absolute master URLs -> rewritten through the gate. Relative
          // paths are origin-absolute on the master -> route via /raw.
          outHeaders[k] = loc.startsWith('/')
            ? `${gateBase}/go/${keyRec.id}/raw${loc}`
            : rewriter(loc);
          continue;
        }
        if (lk === 'content-length' && rewriteBody) continue; // recompute below
        outHeaders[k] = v;
      }

      const finish = (statusCode) => {
        touchKey(keyRec, ip);
        logHit(keyRec.id, req, statusCode, Date.now() - started);
        // Record what media this key asked to stream (successful lookups only).
        if (statusCode >= 200 && statusCode < 400) {
          const ref = parseStreamRef(suffix);
          if (ref) recordStream(keyRec, ref, ip);
        }
      };

      if (isHead) {
        res.writeHead(status, outHeaders);
        res.end();
        finish(status);
        return;
      }

      if (rewriteBody) {
        const chunks = [];
        let size = 0;
        let exceeded = false;
        upRes.on('data', (c) => {
          size += c.length;
          if (!exceeded) {
            if (size <= MAX_REWRITE_BYTES) chunks.push(c);
            else exceeded = true;
          }
        });
        upRes.on('end', () => {
          if (exceeded || size > MAX_REWRITE_BYTES) {
            // Too big to buffer — stream what we already have untouched.
            res.writeHead(status, outHeaders);
            res.end(Buffer.concat(chunks));
            finish(status);
            return;
          }
          const text = Buffer.concat(chunks).toString('utf8');
          const rewritten = rewriter(text);
          const buf = Buffer.from(rewritten, 'utf8');
          res.writeHead(status, {
            ...outHeaders,
            'content-length': buf.length,
            'content-encoding': 'identity',
          });
          res.end(buf);
          finish(status);
        });
        upRes.on('error', () => {
          if (!res.headersSent) {
            res.writeHead(status, outHeaders);
          }
          res.end();
          finish(status);
        });
      } else {
        res.writeHead(status, outHeaders);
        upRes.pipe(res);
        upRes.on('error', () => res.destroy());
        res.once('close', () => {
          if (!res.writableEnded) upRes.destroy();
          finish(status);
        });
      }
    }
  );

  // Swallow socket errors raised after the client has gone away.
  res.on('error', () => {});

  upstreamReq.on('timeout', () => {
    upstreamReq.destroy(new Error('upstream timeout'));
  });
  upstreamReq.on('error', (err) => {
    console.error(
      `[proxy] key=${keyRec.id.slice(0, 6)} upstream error: ${err.message}`
    );
    if (!res.headersSent) {
      res.writeHead(502, {
        'content-type': 'application/json; charset=utf-8',
      });
      res.end(JSON.stringify({ error: 'gate: upstream request failed' }));
      logHit(keyRec.id, req, 502, Date.now() - started);
    } else {
      res.destroy();
    }
  });

  // Client-side response socket closed (normally after finish, or because
  // the client aborted) — stop pushing to it.
  res.once('close', () => {
    if (!res.writableEnded) upstreamReq.destroy();
  });

  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    upstreamReq.end();
  } else {
    req.pipe(upstreamReq);
  }

  // 'close' fires on the request side as soon as the client finished sending
  // the body — that is NOT an abort. Only tear down when the request never
  // completed (true client disconnect mid-request).
  req.on('close', () => {
    if (!req.complete) upstreamReq.destroy();
  });
}

/* ============================================================
 * AIOStreams panel proxy
 * ============================================================ */

/**
 * Transparent reverse proxy for the whole AIOStreams surface (panel SPA,
 * /api/v1, /stremio, /assets ...). Admin-gated at the router level. Unlike
 * the key proxy: cookies pass through in both directions (AIOStreams
 * session), no body rewriting, methods + bodies forwarded, streaming
 * throughout.
 */
function forwardPanel(req, res) {
  const started = Date.now();
  const ip = clientIp(req);
  const mod = INTERNAL.protocol === 'https:' ? https : http;

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (lk === 'host' || lk === 'connection' || HOP_BY_HOP.has(lk)) continue;
    headers[k] = v;
  }
  headers['host'] = INTERNAL.hostHeader;
  headers['x-forwarded-for'] = req.headers['x-forwarded-for']
    ? `${req.headers['x-forwarded-for']}, ${ip}`
    : ip;
  if (req.headers['x-forwarded-proto'])
    headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'];
  if (req.headers['x-forwarded-host'])
    headers['x-forwarded-host'] = req.headers['x-forwarded-host'];

  const upstreamReq = mod.request(
    {
      protocol: INTERNAL.protocol,
      hostname: INTERNAL.hostname,
      port: INTERNAL.port,
      path: req.url,
      method: req.method,
      headers,
      timeout: 30000,
    },
    (upRes) => {
      const status = upRes.statusCode || 502;
      const outHeaders = {};
      for (const [k, v] of Object.entries(upRes.headers)) {
        const lk = k.toLowerCase();
        if (HOP_BY_HOP.has(lk)) continue;
        outHeaders[k] = v;
      }
      res.writeHead(status, outHeaders);
      upRes.pipe(res);
      upRes.on('error', () => res.destroy());
      console.log(
        `[${new Date().toISOString()}] panel ${req.method} ${req.url} -> ${status} (${Date.now() - started}ms)`
      );
    }
  );

  res.on('error', () => {});
  upstreamReq.on('timeout', () => {
    upstreamReq.destroy(new Error('upstream timeout'));
  });
  upstreamReq.on('error', (err) => {
    console.error(`[panel] upstream error: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, {
        'content-type': 'application/json; charset=utf-8',
      });
      res.end(JSON.stringify({ error: 'gate: AIOStreams not reachable' }));
    } else {
      res.destroy();
    }
  });

  res.once('close', () => {
    if (!res.writableEnded) upstreamReq.destroy();
  });

  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    upstreamReq.end();
  } else {
    req.pipe(upstreamReq);
  }
  req.on('close', () => {
    if (!req.complete) upstreamReq.destroy();
  });
}

/* ============================================================
 * Proxy route handling
 * ============================================================ */

const MANAGED_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Addon managed</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#050506;color:#e8e8ea;font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  .card{background:#0c0c0e;border:1px solid #222226;border-radius:12px;padding:32px 36px;max-width:420px;text-align:center}
  h1{font-size:17px;margin:0 0 8px;letter-spacing:.2px}
  p{color:#8a8a93;margin:0 0 18px;font-size:14px}
  .tag{display:inline-block;padding:4px 10px;border-radius:99px;border:1px solid #1f2a24;
    color:#34d399;background:#0c1511;font-size:12px;letter-spacing:.4px}
</style>
</head>
<body>
  <div class="card">
    <h1>This addon is managed by your provider</h1>
    <p>Configuration changes are handled by the administrator. If you need
    changes, contact the person who gave you this link.</p>
    <span class="tag">AIO Gate</span>
  </div>
</body>
</html>`;

function serveManagedPage(res) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(MANAGED_PAGE);
}

function handleProxy(req, res, pathname) {
  // pathname: /go/<key>/<suffix...>
  const rest = pathname.slice('/go/'.length); // "<key>" or "<key>/suffix/..."
  const slash = rest.indexOf('/');
  const keyId = slash === -1 ? rest : rest.slice(0, slash);
  const suffix = slash === -1 ? '' : rest.slice(slash + 1);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      'access-control-allow-headers': '*',
      'access-control-max-age': '86400',
    });
    res.end();
    return;
  }

  const keyRec = getKey(keyId);
  if (!keyRec) {
    sendJson(res, 404, { error: 'key not found' });
    return;
  }

  if (suffix === '' && !req.url.includes('?')) {
    res.writeHead(302, {
      location: `${getGateBase(req)}/go/${keyId}/manifest.json`,
    });
    res.end();
    return;
  }

  if (hasDotSegment(suffix)) {
    sendJson(res, 400, { error: 'bad path' });
    return;
  }

  const blocked = keyStatusError(keyRec);
  if (blocked) {
    // Expired keys are auto-deleted — behave like deleteKey.
    if (keyRec.expiresAt && Date.parse(keyRec.expiresAt) < Date.now()) {
      deleteKey(keyRec.id);
    }
    sendJson(res, blocked[0], { error: blocked[1] });
    return;
  }

  // Never proxy the master's configuration / dashboard surface.
  let decoded = suffix;
  try {
    decoded = decodeURIComponent(suffix);
  } catch {
    /* keep raw */
  }
  const segments = decoded.split('/').filter(Boolean);
  if (segments.length > 0 && segments[segments.length - 1] === 'configure') {
    touchKey(keyRec, clientIp(req));
    serveManagedPage(res);
    return;
  }

  forward(req, res, keyRec, suffix);
}

/* ============================================================
 * Admin API
 * ============================================================ */

const loginFailures = new Map(); // ip -> { fails, lockedUntil }

function adminAuth(req) {
  const sess = readSession(req.headers['cookie']);
  if (!sess || sess.username !== ADMIN_USERNAME) return null;
  if (sess.sessionId) touchSession(sess.sessionId);
  return sess;
}

function requireAdmin(req, res) {
  const user = adminAuth(req);
  if (!user) {
    sendJson(res, 401, { error: 'unauthorized' });
    return null;
  }
  return user;
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function handleAdmin(req, res, pathname) {
  const parts = pathname.split('/').filter(Boolean); // ['panel','api',...]

  // POST /panel/api/login
  if (parts.length === 3 && parts[2] === 'login') {
    return handleLogin(req, res);
  }
  if (parts.length === 3 && parts[2] === 'logout') {
    // Revoke the session record so a stolen cookie dies server-side too.
    const sess = readSession(req.headers['cookie']);
    if (sess && sess.sessionId) revokeSession(sess.sessionId);
    res.writeHead(204, {
      'set-cookie':
        'aio_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    });
    res.end();
    return;
  }

  // GET /panel/api/auth-status — public, so the login form can show the
  // 2FA code field without leaking anything but a boolean.
  if (parts.length === 3 && parts[2] === 'auth-status') {
    sendJson(res, 200, { twoFactorEnabled: twoFactorEnabled() });
    return;
  }

  const auth = requireAdmin(req, res);
  if (!auth) return;

  // GET /panel/api/me
  if (parts.length === 3 && parts[2] === 'me') {
    sendJson(res, 200, {
      username: ADMIN_USERNAME,
      sessionId: auth.sessionId,
      twoFactorEnabled: twoFactorEnabled(),
    });
    return;
  }

  // GET /panel/api/config
  if (parts.length === 3 && parts[2] === 'config') {
    const master = effectiveMaster();
    sendJson(res, 200, {
      publicBase: effectivePublicBase() || null,
      masterConfigured: !!master,
      bundled: true,
    });
    return;
  }

  // GET /panel/api/settings — current effective values (admin only)
  if (parts.length === 3 && parts[2] === 'settings' && req.method === 'GET') {
    sendJson(res, 200, {
      masterUrl: effectiveMasterUrl(),
      publicBase: effectivePublicBase() || null,
      envMasterUrl: !!ENV_MASTER_URL,
      envPublicBase: !!PUBLIC_BASE,
      bundled: true,
    });
    return;
  }

  // PATCH /panel/api/settings — set/clear runtime overrides
  if (parts.length === 3 && parts[2] === 'settings' && req.method === 'PATCH') {
    return readBody(req)
      .then((body) => {
        try {
          const s = (state.settings = state.settings || {});
          if (body.masterUrl !== undefined) {
            const v = String(body.masterUrl || '').trim();
            if (v) {
              parseMaster(v); // validate (throws on bad input)
              s.masterUrl = v;
            } else {
              s.masterUrl = null;
            }
          }
          if (body.publicBase !== undefined) {
            const v = String(body.publicBase || '').trim();
            if (v) {
              new URL(v); // validate
              s.publicBase = v.replace(/\/+$/, '');
            } else {
              s.publicBase = null;
            }
          }
          saveStateSync();
          sendJson(res, 200, {
            ok: true,
            masterUrl: effectiveMasterUrl(),
            publicBase: effectivePublicBase() || null,
          });
        } catch (e) {
          sendJson(res, 400, { error: e.message });
        }
      })
      .catch((e) => sendJson(res, 400, { error: e.message }));
  }

  // POST /panel/api/settings/test — probe a candidate master URL
  if (
    parts.length === 4 &&
    parts[2] === 'settings' &&
    parts[3] === 'test' &&
    req.method === 'POST'
  ) {
    return readBody(req, 10_000)
      .then((body) => {
        const candidate =
          String(body.masterUrl || '').trim() || effectiveMasterUrl();
        if (!candidate) {
          return sendJson(res, 400, { error: 'no master URL configured' });
        }
        let m;
        try {
          m = parseMaster(candidate);
        } catch {
          return sendJson(res, 400, { error: 'invalid master URL' });
        }
        let done = false;
        const finish = (status, payload) => {
          if (done) return;
          done = true;
          sendJson(res, status, payload);
        };
        // Follow same-origin redirects so alias URLs (/stremio/u/<alias>/...)
        // probe green instead of failing on the 302 hop.
        getMaster(m, m.masterRoot + '/manifest.json', 6000).then((r) => {
          if (!r) {
            return finish(502, {
              ok: false,
              error: 'could not reach master (network error)',
            });
          }
          const ok = r.status >= 200 && r.status < 300;
          finish(ok ? 200 : 502, { ok, status: r.status });
        });
      })
      .catch(() => sendJson(res, 400, { error: 'invalid request' }));
  }

  // GET /panel/api/keys
  if (parts.length === 3 && parts[2] === 'keys' && req.method === 'GET') {
    pruneExpiredKeys();
    sendJson(res, 200, { keys: listKeys() });
    return;
  }

  // POST /panel/api/keys
  if (parts.length === 3 && parts[2] === 'keys' && req.method === 'POST') {
    return readBody(req)
      .then((body) => {
        const key = createKey(body);
        sendJson(res, 201, { key });
      })
      .catch((e) => sendJson(res, 400, { error: e.message }));
  }

  // PATCH /panel/api/keys/:id
  if (
    parts.length === 4 &&
    parts[2] === 'keys' &&
    req.method === 'PATCH'
  ) {
    return readBody(req)
      .then((body) => {
        try {
          const key = updateKey(parts[3], body);
          if (!key) return sendJson(res, 404, { error: 'not found' });
          sendJson(res, 200, { key });
        } catch (e) {
          sendJson(res, e.status || 400, { error: e.message });
        }
      })
      .catch((e) => sendJson(res, 400, { error: e.message }));
  }

  // DELETE /panel/api/keys/:id
  if (
    parts.length === 4 &&
    parts[2] === 'keys' &&
    req.method === 'DELETE'
  ) {
    if (!deleteKey(parts[3])) {
      return sendJson(res, 404, { error: 'not found' });
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  // GET /panel/api/keys/:id — single key detail
  if (
    parts.length === 4 &&
    parts[2] === 'keys' &&
    req.method === 'GET'
  ) {
    const key = getKey(parts[3]);
    if (!key) return sendJson(res, 404, { error: 'not found' });
    if (key.expiresAt && Date.parse(key.expiresAt) < Date.now()) {
      deleteKey(key.id);
      return sendJson(res, 404, { error: 'not found' });
    }
    sendJson(res, 200, { key });
    return;
  }

  // GET /panel/api/keys/:id/history — what this key streamed (newest first)
  if (
    parts.length === 5 &&
    parts[2] === 'keys' &&
    parts[4] === 'history' &&
    req.method === 'GET'
  ) {
    const hk = getKey(parts[3]);
    if (!hk) return sendJson(res, 404, { error: 'not found' });
    if (hk.expiresAt && Date.parse(hk.expiresAt) < Date.now()) {
      deleteKey(hk.id);
      return sendJson(res, 404, { error: 'not found' });
    }
    sendJson(res, 200, {
      entries: keyHistory(parts[3], 500),
      retentionDays: Math.round(HISTORY_RETENTION_MS / 86400000),
    });
    return;
  }

  // GET /panel/api/sessions — tracked admin sessions (newest activity first)
  if (parts.length === 3 && parts[2] === 'sessions' && req.method === 'GET') {
    sendJson(res, 200, {
      sessions: listSessions().map((s) => ({
        ...s,
        current: s.id === auth.sessionId,
      })),
      sessionTtlDays: Math.round(SESSION_TTL_MS / 86400000),
    });
    return;
  }

  // PATCH /panel/api/sessions/:id — rename a session (max 32 chars)
  if (
    parts.length === 4 &&
    parts[2] === 'sessions' &&
    parts[3] !== 'revoke-others' &&
    req.method === 'PATCH'
  ) {
    return readBody(req, 10_000)
      .then((body) => {
        const rec = state.sessions && state.sessions[parts[3]];
        if (!rec) return sendJson(res, 404, { error: 'session not found' });
        const name = String(body.name || '').trim();
        if (!name) return sendJson(res, 400, { error: 'name is required' });
        if (name.length > 32) {
          return sendJson(res, 400, { error: 'name must be 32 characters or fewer' });
        }
        rec.name = name;
        saveStateSync();
        sendJson(res, 200, { ok: true, session: rec });
      })
      .catch((e) => sendJson(res, 400, { error: e.message }));
  }

  // DELETE /panel/api/sessions/:id — revoke a session
  if (
    parts.length === 4 &&
    parts[2] === 'sessions' &&
    parts[3] !== 'revoke-others' &&
    req.method === 'DELETE'
  ) {
    if (!revokeSession(parts[3])) {
      return sendJson(res, 404, { error: 'session not found' });
    }
    sendJson(res, 200, {
      ok: true,
      revokedCurrent: parts[3] === auth.sessionId,
    });
    return;
  }

  // POST /panel/api/sessions/revoke-others — keep only this session
  if (
    parts.length === 4 &&
    parts[2] === 'sessions' &&
    parts[3] === 'revoke-others' &&
    req.method === 'POST'
  ) {
    let n = 0;
    for (const id of Object.keys(state.sessions || {})) {
      if (id !== auth.sessionId && state.sessions[id]) {
        delete state.sessions[id];
        n++;
      }
    }
    if (n) saveStateSync();
    sendJson(res, 200, { ok: true, revoked: n });
    return;
  }

  // POST /panel/api/2fa/setup — generate a pending TOTP secret
  if (
    parts.length === 4 &&
    parts[2] === '2fa' &&
    parts[3] === 'setup' &&
    req.method === 'POST'
  ) {
    const secret = randomBase32(32);
    const s = (state.settings = state.settings || {});
    s.twoFactor = s.twoFactor || {};
    s.twoFactor.pendingSecret = secret;
    saveStateSync();
    sendJson(res, 200, { secret, otpauth: otpauthUri(secret) });
    return;
  }

  // POST /panel/api/2fa/enable — verify the pending secret with a live code
  if (
    parts.length === 4 &&
    parts[2] === '2fa' &&
    parts[3] === 'enable' &&
    req.method === 'POST'
  ) {
    return readBody(req, 10_000)
      .then((body) => {
        const s = (state.settings = state.settings || {});
        s.twoFactor = s.twoFactor || {};
        const tf = s.twoFactor;
        if (!tf.pendingSecret) {
          return sendJson(res, 400, { error: 'start a 2FA setup first' });
        }
        if (!verifyTotp(tf.pendingSecret, body.code)) {
          return sendJson(res, 400, { error: 'invalid code — check the time on your device and try again' });
        }
        const { plain, hashes } = generateRecoveryCodes(10);
        tf.enabled = true;
        tf.secret = tf.pendingSecret;
        tf.pendingSecret = null;
        tf.enabledAt = nowIso();
        tf.recovery = hashes;
        saveStateSync();
        sendJson(res, 200, { ok: true, recoveryCodes: plain });
      })
      .catch((e) => sendJson(res, 400, { error: e.message }));
  }

  // POST /panel/api/2fa/disable — requires password + current code
  if (
    parts.length === 4 &&
    parts[2] === '2fa' &&
    parts[3] === 'disable' &&
    req.method === 'POST'
  ) {
    return readBody(req, 10_000)
      .then((body) => {
        const s = (state.settings = state.settings || {});
        s.twoFactor = s.twoFactor || {};
        const tf = s.twoFactor;
        if (!tf.enabled) return sendJson(res, 400, { error: '2FA is not enabled' });
        if (String(body.password || '') !== ADMIN_PASSWORD) {
          return sendJson(res, 401, { error: 'wrong password' });
        }
        if (!verifyTotp(tf.secret, body.code) && !useRecoveryCode(tf, body.code)) {
          return sendJson(res, 400, { error: 'invalid 2FA code' });
        }
        tf.enabled = false;
        tf.secret = null;
        tf.recovery = null;
        saveStateSync();
        sendJson(res, 200, { ok: true });
      })
      .catch((e) => sendJson(res, 400, { error: e.message }));
  }

  sendJson(res, 404, { error: 'not found' });
}

function handleLogin(req, res) {
  const ip = clientIp(req);
  const rec = loginFailures.get(ip);
  if (rec && rec.lockedUntil > Date.now()) {
    const mins = Math.ceil((rec.lockedUntil - Date.now()) / 60000);
    sendJson(res, 429, { error: `Too many attempts. Try again in ${mins} min.` });
    return;
  }
  readBody(req, 10_000)
    .then((body) => {
      const fail = (status, msg, extra) => {
        const cur = loginFailures.get(ip) || { fails: 0, lockedUntil: 0 };
        cur.fails += 1;
        if (cur.fails >= LOGIN_MAX_FAILS) {
          cur.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
          cur.fails = 0;
        }
        loginFailures.set(ip, cur);
        sendJson(res, status, { error: msg, ...(extra || {}) });
      };
      const ok =
        String(body.username || '') === ADMIN_USERNAME &&
        String(body.password || '') === ADMIN_PASSWORD;
      if (!ok) {
        return fail(401, 'invalid credentials');
      }
      // Password is right — if 2FA is enabled, the TOTP/recovery code must
      // be too. Missing/wrong codes get the same lockout treatment.
      if (!passTwoFactor(body.code)) {
        const provided = String(body.code || '').trim();
        return fail(
          401,
          provided ? 'invalid two-factor code' : 'two-factor code required',
          { twoFactorRequired: true }
        );
      }
      loginFailures.delete(ip);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'set-cookie': `aio_session=${createSession(ADMIN_USERNAME, req)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      });
      res.end(JSON.stringify({ username: ADMIN_USERNAME }));
    })
    .catch(() => sendJson(res, 400, { error: 'invalid request' }));
}

/* ============================================================
 * Static files (admin panel)
 * ============================================================ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#050506"/><rect x="7" y="14" width="18" height="12" rx="2.5" fill="none" stroke="#34d399" stroke-width="2"/><path d="M11 14V10a5 5 0 0 1 10 0v4" fill="none" stroke="#34d399" stroke-width="2" stroke-linecap="round"/><circle cx="16" cy="20" r="2" fill="#34d399"/></svg>`;

function servePanelFile(res, relFile) {
  const full = path.resolve(PUBLIC_DIR, relFile);
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      // SPA fallback: every key has its own page URL (/panel/<label>), so any
      // unknown extension-less path boots the panel app, which routes to the
      // key page (or the dashboard when the key is gone).
      if (!path.extname(relFile)) {
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, html) => {
          if (err2) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('not found');
            return;
          }
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-cache',
          });
          res.end(html);
        });
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(full)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}

/* Gate admin panel lives under /panel; AIOStreams keeps the root namespace. */
function handlePanel(req, res, pathname) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, GET, PATCH, DELETE, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
    });
    res.end();
    return;
  }
  if (pathname === '/panel') {
    res.writeHead(302, { location: '/panel/' });
    res.end();
    return;
  }
  if (pathname.startsWith('/panel/api')) {
    handleAdmin(req, res, pathname);
    return;
  }
  const rel = pathname.slice('/panel/'.length) || 'index.html';
  if (rel === 'favicon.ico') {
    res.writeHead(200, {
      'content-type': 'image/svg+xml',
      'cache-control': 'public, max-age=86400',
    });
    res.end(FAVICON);
    return;
  }
  servePanelFile(res, rel);
}

const PUBLIC_DIR = path.resolve(__dirname, 'public');

/* ============================================================
 * Router + server
 * ============================================================ */

function handleHealth(req, res) {
  const mod = INTERNAL.protocol === 'https:' ? https : http;
  const probe = mod.get(
    {
      protocol: INTERNAL.protocol,
      hostname: INTERNAL.hostname,
      port: INTERNAL.port,
      path: '/api/v1/status',
      timeout: 4000,
    },
    (upRes) => {
      const ok = upRes.statusCode === 200;
      res.writeHead(ok ? 200 : 503, {
        'content-type': 'application/json',
      });
      res.end(JSON.stringify({ ok, upstream: ok ? 'ok' : 'degraded' }));
      upRes.resume();
    }
  );
  probe.on('timeout', () => probe.destroy(new Error('timeout')));
  probe.on('error', () => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, upstream: 'down' }));
  });
}

/** The root namespace is an admin-gated transparent proxy for AIOStreams. */
function handleBundledRoot(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, HEAD, POST, PATCH, DELETE, OPTIONS',
      'access-control-allow-headers': '*',
      'access-control-max-age': '86400',
    });
    res.end();
    return;
  }
  const isHtml = (req.headers.accept || '').includes('text/html');
  // The gate panel is the landing page. Visiting the bare root goes to
  // /panel/ (logged in or not); the AIOStreams panel is reached through the
  // gate panel's "AIOStreams panel" button, which opens /?aiostreams=1.
  // Everything else at the root still proxies to AIOStreams, so its SPA
  // (client-side routes like /dashboard and /login) keeps working.
  if (req.method === 'GET' && isHtml && req.url.split('?')[0] === '/') {
    const q = new URL(req.url, 'http://aio-gate.local');
    if (q.searchParams.get('aiostreams') !== '1') {
      res.writeHead(302, { location: '/panel/' });
      res.end();
      return;
    }
  }
  if (!adminAuth(req)) {
    if (req.method === 'GET' && isHtml) {
      res.writeHead(302, { location: '/panel/' });
      res.end();
      return;
    }
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }
  forwardPanel(req, res);
}

const server = http.createServer((req, res) => {
  const pathname = req.url.split('?')[0];
  try {
    if (pathname === '/healthz') {
      handleHealth(req, res);
      return;
    }
    if (pathname.startsWith('/go/')) {
      handleProxy(req, res, pathname);
      return;
    }
    if (pathname === '/panel' || pathname.startsWith('/panel/')) {
      handlePanel(req, res, pathname);
      return;
    }
    // Bundled mode is the only mode: everything left at the root is the
    // admin-gated AIOStreams surface.
    handleBundledRoot(req, res);
  } catch (err) {
    console.error(`[route] ${err.stack || err}`);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'internal error' });
    } else {
      res.destroy();
    }
  }
});

server.on('clientError', (err, socket) => {
  if (err.code === 'ECONNRESET' || !socket.writable) return;
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

function shutdown(signal) {
  console.log(`[shutdown] received ${signal}, closing…`);
  server.close(() => {
    flushSave();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

loadState();
pruneHistory(true); // drop watch-history entries older than the retention window
pruneSessions(); // drop expired sessions + cap the tracked set
pruneExpiredKeys(); // delete keys whose expiresAt is in the past
setInterval(() => {
  pruneHistory();
  pruneSessions();
}, 6 * 3600 * 1000).unref();
setInterval(() => {
  pruneExpiredKeys();
}, 60 * 1000).unref();
server.listen(PORT, HOST, () => {
  const bootMaster = effectiveMaster();
  console.log(`[boot] aio-gate listening on http://${HOST}:${PORT}`);
  console.log(`[boot] admin: ${ADMIN_USERNAME} (data: ${DATA_FILE})`);
  console.log(
    `[boot] master=${
      bootMaster ? bootMaster.origin + bootMaster.masterRoot : '(not configured)'
    } origins_rewritten=${effectiveOrigins(bootMaster).join(', ')}`
  );
  console.log(
    `[boot] shareable key base: ${effectivePublicBase() || 'http://' + HOST + ':' + PORT}/go/<key>/manifest.json`
  );
});
