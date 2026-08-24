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
const TRUST_PROXY = isTruthy(ENV.TRUST_PROXY);
const KEY_LENGTH = clampInt(ENV.KEY_LENGTH, 12, 8, 32);
// Watch history retention: entries older than this are pruned automatically
// to keep the data file small. Configurable via HISTORY_RETENTION_DAYS.
const HISTORY_RETENTION_MS =
  clampInt(ENV.HISTORY_RETENTION_DAYS, 30, 1, 365) * 24 * 3600 * 1000;
const HISTORY_MAX_PER_KEY = clampInt(ENV.HISTORY_MAX_PER_KEY, 2000, 50, 50000);
const MAX_REWRITE_BYTES = 16 * 1024 * 1024;
const LOGIN_MAX_FAILS = 10;
const LOGIN_LOCKOUT_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

// Bundled mode: AIOStreams runs next to the gate inside the same container.
// When AIOSTREAMS_INTERNAL_URL is set, the gate owns the whole public root
// namespace and admin-gated-transparently proxies everything else to the
// internal AIOStreams, so the AIOStreams panel is never public.
const AIOSTREAMS_INTERNAL_URL = (ENV.AIOSTREAMS_INTERNAL_URL || '').replace(
  /\/+$/,
  ''
);
const BUNDLED = !!AIOSTREAMS_INTERNAL_URL;

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

const INTERNAL = BUNDLED ? parseOrigin(AIOSTREAMS_INTERNAL_URL) : null;

// Env-supplied origins rewritten out of /go responses. The master origin is
// dynamic (it can change from the panel) and is prepended per request.
const AUTO_ORIGINS = [];
if (BUNDLED) {
  for (const raw of [ENV.BASE_URL, AIOSTREAMS_INTERNAL_URL, ENV_MASTER_URL]) {
    if (!raw) continue;
    try {
      AUTO_ORIGINS.push(new URL(raw).origin);
    } catch {
      /* ignore */
    }
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

if (BUNDLED) {
  console.log(
    `[boot] bundled mode: AIOStreams at ${AIOSTREAMS_INTERNAL_URL} — root namespace is admin-gated`
  );
}

/* ============================================================
 * Small helpers
 * ============================================================ */

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function isTruthy(v) {
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(Math.max(n, min), max);
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

function clientIp(req) {
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
    masked: origin + masterRoot + '/manifest.json',
    uuid: m ? m[2] : null,
    password: m ? m[3] : null,
  };
}

function maskMaster(master) {
  if (!master.uuid) return master.masked;
  return `${master.origin}/stremio/${master.uuid}/${'•'.repeat(6)}/manifest.json`;
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
      state = parsed;
      return;
    }
  } catch {
    /* first boot or corrupt file -> start fresh */
  }
  state = { version: 1, keys: {}, settings: {} };
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
 * Sessions (HMAC-signed cookie)
 * ============================================================ */

function createSession(username) {
  const payload = Buffer.from(
    JSON.stringify({ u: username, e: Date.now() + SESSION_TTL_MS })
  ).toString('base64url');
  const sig = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(payload)
    .digest('base64url');
  return payload + '.' + sig;
}

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
    return data.u;
  } catch {
    return null;
  }
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
  const key = {
    id,
    label: String(fields.label || 'Key ' + id.slice(0, 6)),
    note: String(fields.note || ''),
    status: 'active',
    masterUrl: fields.masterUrl || null,
    expiresAt: fields.expiresAt || null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    usage: { requests: 0, bytes: 0, lastUsedAt: null, lastIp: null },
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
  if (patch.masterUrl !== undefined) {
    const v = (patch.masterUrl || '').trim();
    if (v) {
      try {
        parseMaster(v); // validate
        key.masterUrl = v;
      } catch {
        const err = new Error('invalid masterUrl');
        err.status = 400;
        throw err;
      }
    } else {
      key.masterUrl = null;
    }
  }
  if (patch.expiresAt !== undefined) {
    const v = (patch.expiresAt || '').trim();
    if (v && Number.isNaN(Date.parse(v))) {
      const err = new Error('invalid expiresAt');
      err.status = 400;
      throw err;
    }
    key.expiresAt = v ? new Date(v).toISOString() : null;
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

function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Drop daily bandwidth buckets older than 30 days. True if anything was removed. */
function pruneDaily(daily) {
  const cutoff = dayKey(Date.now() - 30 * 86400000);
  let changed = false;
  for (const d of Object.keys(daily)) {
    if (d < cutoff) {
      delete daily[d];
      changed = true;
    }
  }
  return changed;
}

/** Bytes transferred by this key in the last 30 days (rolling daily buckets). */
function bytes30d(key) {
  const daily = key.usage && key.usage.daily;
  if (!daily) return 0;
  const cutoff = dayKey(Date.now() - 30 * 86400000);
  let total = 0;
  for (const [d, b] of Object.entries(daily)) {
    if (d >= cutoff && typeof b === 'number') total += b;
  }
  return total;
}

/** Key as served to the admin API — usage augmented with the 30-day view. */
function serializeKey(key) {
  return { ...key, usage: { ...key.usage, bytes30d: bytes30d(key) } };
}

function touchKey(key, bytes, ip) {
  const u = key.usage;
  u.requests += 1;
  u.bytes += bytes || 0;
  u.lastUsedAt = nowIso();
  u.lastIp = ip || null;
  // Rolling per-day bandwidth buckets power the "last 30 days" stat.
  if (!u.daily) u.daily = {};
  const today = dayKey(Date.now());
  u.daily[today] = (u.daily[today] || 0) + (bytes || 0);
  pruneDaily(u.daily);
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

function recordStream(keyRec, ref, bytes, ip) {
  if (!state.history) state.history = [];
  const entry = {
    keyId: keyRec.id,
    ts: nowIso(),
    type: ref.type,
    id: ref.id,
    title: null,
    bytes: bytes || 0,
    ip: ip || null,
  };
  state.history.push(entry);
  pruneHistory();
  scheduleSave();
  // Best-effort title lookup, after the response — never blocks proxying.
  resolveTitle(keyRec, ref.type, ref.id)
    .then((t) => {
      if (t && !entry.title) {
        entry.title = t;
        scheduleSave();
      }
    })
    .catch(() => {});
}

function pruneHistory(force) {
  const now = Date.now();
  if (!force && now - lastPruneAt < 60_000) return; // at most once a minute
  lastPruneAt = now;
  // Roll old daily bandwidth buckets off every key too.
  let dailyChanged = false;
  for (const key of Object.values(state.keys)) {
    if (key.usage && key.usage.daily && pruneDaily(key.usage.daily)) {
      dailyChanged = true;
    }
  }
  if (dailyChanged) scheduleSave();
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

/** Newest-first history for one key. */
function keyHistory(keyId, limit) {
  if (!state.history) return [];
  const out = [];
  for (let i = state.history.length - 1; i >= 0 && out.length < limit; i--) {
    if (state.history[i].keyId === keyId) out.push(state.history[i]);
  }
  return out;
}

function fetchMetaTitle(master, type, id) {
  return new Promise((resolve) => {
    const mod = master.protocol === 'https:' ? https : http;
    const req = mod.get(
      {
        protocol: master.protocol,
        hostname: master.hostname,
        port: master.port,
        path: `${master.masterRoot}/meta/${type}/${encodeURIComponent(id)}.json`,
        timeout: 3000,
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
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const name = data && data.meta && data.meta.name;
            resolve(name ? String(name) : null);
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

/**
 * Best-effort, cached title for a streamed item. Episode ids like
 * `tt123:1:2` fall back to the series id. Never throws.
 */
function resolveTitle(keyRec, type, id) {
  const cacheKey = `${type}:${id}`;
  if (titleCache.has(cacheKey)) return Promise.resolve(titleCache.get(cacheKey));
  const masterUrl =
    (keyRec.masterUrl && keyRec.masterUrl.trim()) || effectiveMasterUrl();
  let master;
  try {
    master = parseMaster(masterUrl);
  } catch {
    return Promise.resolve(null);
  }
  const baseId = String(id).split(':')[0];
  const candidates = id !== baseId ? [id, baseId] : [baseId];
  return candidates
    .reduce(
      (p, cid) => p.then((title) => title || fetchMetaTitle(master, type, cid)),
      Promise.resolve(null)
    )
    .then((title) => {
      if (titleCache.size > TITLE_CACHE_MAX) titleCache.clear();
      titleCache.set(cacheKey, title);
      return title;
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

function logHit(keyId, req, status, bytes, ms) {
  const shortKey = keyId ? keyId.slice(0, 6) : '-';
  console.log(
    `[${new Date().toISOString()}] key=${shortKey} ${req.method} ${req.url} -> ${status} (${bytes}b, ${ms}ms)`
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

  // Per-key override -> panel-level override -> env fallback.
  const masterUrl =
    (keyRec.masterUrl && keyRec.masterUrl.trim()) || effectiveMasterUrl();
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

      let bytes = 0;
      const finish = (statusCode) => {
        touchKey(keyRec, bytes, ip);
        logHit(keyRec.id, req, statusCode, bytes, Date.now() - started);
        // Record what media this key asked to stream (successful lookups only).
        if (statusCode >= 200 && statusCode < 400) {
          const ref = parseStreamRef(suffix);
          if (ref) recordStream(keyRec, ref, bytes, ip);
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
          bytes += c.length;
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
        upRes.on('data', (c) => (bytes += c.length));
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
      logHit(keyRec.id, req, 502, 0, Date.now() - started);
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
 * Proxy route handling
 * ============================================================ */

/**
 * Transparent reverse proxy used in bundled mode for the whole AIOStreams
 * surface (panel SPA, /api/v1, /stremio, /assets ...). Admin-gated at the
 * router level. Unlike the key proxy: cookies pass through in both
 * directions (AIOStreams session), no body rewriting, methods + bodies
 * forwarded, streaming throughout.
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
    touchKey(keyRec, 0, clientIp(req));
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
  const username = readSession(req.headers['cookie']);
  return username === ADMIN_USERNAME ? username : null;
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
    res.writeHead(204, {
      'set-cookie':
        'aio_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    });
    res.end();
    return;
  }

  if (!requireAdmin(req, res)) return;

  // GET /panel/api/me
  if (parts.length === 3 && parts[2] === 'me') {
    sendJson(res, 200, { username: ADMIN_USERNAME });
    return;
  }

  // GET /panel/api/config
  if (parts.length === 3 && parts[2] === 'config') {
    const master = effectiveMaster();
    sendJson(res, 200, {
      publicBase: effectivePublicBase() || null,
      master: master ? maskMaster(master) : null,
      masterConfigured: !!master,
      bundled: BUNDLED,
      hasCustomMasters: listKeys().some((k) => k.masterUrl),
      keyLength: KEY_LENGTH,
    });
    return;
  }

  // GET /panel/api/settings — current effective values (admin only)
  if (parts.length === 3 && parts[2] === 'settings' && req.method === 'GET') {
    const master = effectiveMaster();
    sendJson(res, 200, {
      masterUrl: effectiveMasterUrl(),
      publicBase: effectivePublicBase() || null,
      envMasterUrl: !!ENV_MASTER_URL,
      envPublicBase: !!PUBLIC_BASE,
      bundled: BUNDLED,
      rewriteOrigins: effectiveOrigins(master),
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
        const mod = m.protocol === 'https:' ? https : http;
        const probe = mod.get(
          {
            protocol: m.protocol,
            hostname: m.hostname,
            port: m.port,
            path: m.masterRoot + '/manifest.json',
            timeout: 6000,
          },
          (upRes) => {
            const ok = upRes.statusCode >= 200 && upRes.statusCode < 300;
            finish(ok ? 200 : 502, { ok, status: upRes.statusCode });
            upRes.resume();
          }
        );
        probe.on('timeout', () => {
          probe.destroy();
          finish(504, { ok: false, error: 'timeout' });
        });
        probe.on('error', (err) =>
          finish(502, { ok: false, error: err.message })
        );
      })
      .catch(() => sendJson(res, 400, { error: 'invalid request' }));
  }

  // GET /panel/api/keys
  if (parts.length === 3 && parts[2] === 'keys' && req.method === 'GET') {
    sendJson(res, 200, { keys: listKeys().map(serializeKey) });
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
    sendJson(res, 200, { key: serializeKey(key) });
    return;
  }

  // GET /panel/api/keys/:id/history — what this key streamed (newest first)
  if (
    parts.length === 5 &&
    parts[2] === 'keys' &&
    parts[4] === 'history' &&
    req.method === 'GET'
  ) {
    if (!getKey(parts[3])) return sendJson(res, 404, { error: 'not found' });
    sendJson(res, 200, {
      entries: keyHistory(parts[3], 500),
      retentionDays: Math.round(HISTORY_RETENTION_MS / 86400000),
    });
    return;
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
      const ok =
        String(body.username || '') === ADMIN_USERNAME &&
        String(body.password || '') === ADMIN_PASSWORD;
      if (!ok) {
        const cur = loginFailures.get(ip) || { fails: 0, lockedUntil: 0 };
        cur.fails += 1;
        if (cur.fails >= LOGIN_MAX_FAILS) {
          cur.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
          cur.fails = 0;
        }
        loginFailures.set(ip, cur);
        return sendJson(res, 401, { error: 'invalid credentials' });
      }
      loginFailures.delete(ip);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'set-cookie': `aio_session=${createSession(ADMIN_USERNAME)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
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

/* Gate admin panel lives under /panel so AIOStreams keeps the root
 * namespace in bundled mode. */
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

/* ============================================================
 * Router + server
 * ============================================================ */

function handleHealth(req, res) {
  if (!BUNDLED) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
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

/** Bundled mode: admin-gated transparent proxy for the AIOStreams surface. */
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
  if (!adminAuth(req)) {
    if (
      req.method === 'GET' &&
      (req.headers.accept || '').includes('text/html')
    ) {
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
    if (BUNDLED) {
      handleBundledRoot(req, res);
      return;
    }
    // Standalone mode: only the key proxy + panel exist at the root.
    if (pathname === '/') {
      res.writeHead(302, { location: '/panel/' });
      res.end();
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
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
setInterval(() => pruneHistory(), 6 * 3600 * 1000).unref();
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
