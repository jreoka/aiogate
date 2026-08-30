/* aio-gate admin panel — flat, dependency-free */

'use strict';

const state = {
  keys: [],
  config: { publicBase: null },
  view: 'boot',
  currentKeyId: null,
  currentKey: null,
  currentHistory: [],
  retentionDays: 30,
  sessions: [],
  sessionTtlDays: 7,
  twoFactorEnabled: false,
  currentSessionId: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/* ---------- api ---------- */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-json */
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    if (data && data.twoFactorRequired) err.twoFactorRequired = true;
    throw err;
  }
  return data;
}

/* ---------- toast ---------- */

function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toast-root').appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .3s';
    setTimeout(() => el.remove(), 320);
  }, 2800);
}

/* ---------- modal ---------- */

function openModal(html, { onMount } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = html;
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) closeModal();
  });
  $('#modal-root').appendChild(overlay);
  if (onMount) onMount(overlay);
  const first = $('input, textarea, select, button', overlay);
  if (first) setTimeout(() => first.focus(), 30);
  return overlay;
}

function closeModal() {
  const r = $('#modal-root');
  if (r.firstChild) r.firstChild.remove();
}

/* ---------- formatting ---------- */

function relTime(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  const d = Date.now() - t;
  if (d < 0) {
    const ad = -d;
    if (ad < 60_000) return `in ${Math.round(ad / 1000)}s`;
    if (ad < 3600_000) return `in ${Math.floor(ad / 60_000)}m`;
    if (ad < 86400_000) return `in ${Math.floor(ad / 3600_000)}h`;
    if (ad < 7 * 86400_000) return `in ${Math.floor(ad / 86400_000)}d`;
    return new Date(iso).toLocaleString();
  }
  if (d < 60_000) return 'just now';
  if (d < 3600_000) return Math.floor(d / 60_000) + 'm ago';
  if (d < 86400_000) return Math.floor(d / 3600_000) + 'h ago';
  if (d < 7 * 86400_000) return Math.floor(d / 86400_000) + 'd ago';
  return new Date(iso).toLocaleDateString();
}

function fmtCount(n) {
  if (!n) return '0';
  return n.toLocaleString();
}

function keyStatus(key) {
  if (key.status === 'revoked') return 'revoked';
  if (key.status === 'paused') return 'paused';
  if (key.expiresAt && new Date(key.expiresAt).getTime() < Date.now())
    return 'expired';
  return 'active';
}

/* Duration parsing: "7d", "2y", "1w 3d 12h" etc. -> ms */
function parseDurationMs(input) {
  const s = String(input).trim();
  if (!s) return null;
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

function parseExpiryInput(raw) {
  if (raw == null) return null;
  const v = String(raw).trim();
  if (!v) return null;
  if (/^(never|none)$/i.test(v)) return null;
  const dur = parseDurationMs(v);
  if (dur !== null) return new Date(Date.now() + dur).toISOString();
  const t = Date.parse(v);
  if (!Number.isNaN(t)) return new Date(t).toISOString();
  return undefined; // invalid
}

function expiryPreview(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  if (/^(never|none)$/i.test(v)) return '→ never expires';
  const parsed = parseExpiryInput(v);
  if (parsed === undefined) return '⚠ invalid — use 7d, 30d, 1y, 2w, 12h or a date';
  if (parsed === null) return '→ never expires';
  const d = new Date(parsed);
  return `→ expires ${d.toLocaleString()}`;
}

function baseUrl() {
  return (state.config.publicBase || location.origin).replace(/\/+$/, '');
}

function keyUrl(key) {
  return `${baseUrl()}/go/${key.id}/manifest.json`;
}

/* ---------- routing (per-key page URLs) ---------- */

// "Mom — living room TV" -> "Mom-living-room-TV"; safe for URLs.
function slugify(s) {
  return String(s || '')
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Label-based page slugs, deduped ("Test", "Test-2", …) so every key keeps a
// unique, stable URL even with duplicate labels. Order = newest first, same
// as the dashboard table.
function slugMap() {
  const used = new Set();
  const byId = new Map();
  const bySlug = new Map();
  for (const k of state.keys) {
    const base = slugify(k.label) || k.id;
    let slug = base;
    let n = 2;
    while (used.has(slug.toLowerCase())) slug = `${base}-${n++}`;
    used.add(slug.toLowerCase());
    byId.set(k.id, slug);
    bySlug.set(slug, k.id);
  }
  return { byId, bySlug };
}

function keyPagePath(id) {
  const { byId } = slugMap();
  return '/panel/' + (byId.get(id) || id);
}

function slugToId(slug) {
  const { bySlug } = slugMap();
  if (bySlug.has(slug)) return bySlug.get(slug);
  // Raw key ids still work as URLs (label-independent deep links).
  return state.keys.some((k) => k.id === slug) ? slug : null;
}

function currentSlug() {
  const p = location.pathname;
  if (!p.startsWith('/panel/')) return '';
  return decodeURIComponent(p.slice('/panel/'.length));
}

function navigate(path) {
  if (location.pathname === path) {
    route();
    return;
  }
  history.pushState(null, '', path);
  route();
}

// Render whatever page the current URL describes: /panel/ = dashboard,
// /panel/<label> = that key's page.
function route() {
  if (!state.username) {
    renderLogin();
    return;
  }
  const slug = currentSlug();
  if (slug) {
    const id = slugToId(slug);
    if (id) {
      renderKey(id);
      return;
    }
    history.replaceState(null, '', '/panel/');
    toast('Key not found', 'warn');
    renderDash();
    return;
  }
  renderDash();
}

/* ---------- views ---------- */

async function renderLogin() {
  state.view = 'login';
  // Show the 2FA code field up front when the server has it enabled.
  let needCode = false;
  try {
    const st = await api('api/auth-status');
    needCode = !!st.twoFactorEnabled;
  } catch {
    /* server will prompt with twoFactorRequired on submit if needed */
  }
  state.twoFactorEnabled = needCode;

  $('#app').innerHTML = `
    <div class="login-wrap">
      <form class="login-card" id="login-form">
        <div class="brand">
          <div class="brand-mark">◫</div>
          <div class="brand-name">AIO Gate</div>
        </div>
        <p class="brand-sub">Master-stream proxy · key administration</p>
        <div class="field">
          <label for="username">Username</label>
          <input id="username" type="text" autocomplete="username" spellcheck="false">
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input id="password" type="password" autocomplete="current-password">
        </div>
        <div class="field" id="code-field" style="display:${needCode ? 'block' : 'none'}">
          <label for="code">Two-factor code ${needCode ? '' : '(required after enabling 2FA)'}</label>
          <input id="code" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code or recovery code" maxlength="12" spellcheck="false">
        </div>
        <button class="btn btn-primary login-btn" type="submit">Sign in</button>
        <p class="form-error" id="login-error"></p>
        <p class="login-foot">Only the gate administrator can access this panel.</p>
      </form>
    </div>`;
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('#login-error');
    errEl.textContent = '';
    const btn = $('button', e.target);
    btn.disabled = true;
    try {
      await api('api/login', {
        method: 'POST',
        body: JSON.stringify({
          username: $('#username').value,
          password: $('#password').value,
          code: $('#code') && $('#code').value.trim(),
        }),
      });
      await boot();
    } catch (err) {
      // 2FA is on but the code field wasn't shown (stale status) — reveal it.
      if (err.status === 401 && err.twoFactorRequired) {
        state.twoFactorEnabled = true;
        const f = $('#code-field');
        if (f) f.style.display = 'block';
        errEl.textContent = 'Enter your two-factor code to finish signing in';
      } else {
        errEl.textContent = err.message || 'Sign in failed';
      }
      btn.disabled = false;
    }
  });
}

function renderDash() {
  state.view = 'dash';
  const counts = { active: 0, paused: 0, expired: 0 };
  let todayReq = 0;
  const startOfDay = new Date().setHours(0, 0, 0, 0);
  for (const k of state.keys) {
    counts[keyStatus(k)]++;
    if (k.usage.lastUsedAt && new Date(k.usage.lastUsedAt).getTime() >= startOfDay)
      todayReq += k.usage.requests;
  }

  $('#app').innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">◫</div>
          <div class="brand-name">AIO Gate</div>
        </div>
        <div class="grow"></div>
        <span class="base-chip" title="${esc(baseUrl())}">${esc(baseUrl())}</span>
        <span class="user-chip">${esc(state.username)}</span>
        <button class="btn btn-sm btn-ghost" id="sessions-btn">Sessions</button>
        <button class="btn btn-sm btn-ghost" id="settings-btn">Settings</button>
        <a class="btn btn-sm" href="/?aiostreams=1" target="_blank" rel="noopener">AIOStreams panel ↗</a>
        <button class="btn btn-sm btn-ghost" id="logout-btn">Sign out</button>
      </header>

      ${state.config.masterConfigured ? '' : `
      <div class="banner">⚠ No master configured — keys won't work until you set the master manifest URL.
        <a href="#" id="banner-settings">Open Settings →</a></div>`}

      <section class="stats">
        <div class="stat"><div class="num green">${counts.active}</div><div class="lbl">Active keys</div></div>
        <div class="stat"><div class="num amber">${counts.paused}</div><div class="lbl">Paused</div></div>
        <div class="stat"><div class="num">${fmtCount(todayReq)}</div><div class="lbl">Requests today</div></div>
      </section>

      <section class="panel">
        <div class="panel-head"><h2>Issue a new key</h2></div>
        <div class="panel-body">
          <form id="create-form" class="newkey-grid">
            <div class="field">
              <label for="new-label">Label</label>
              <input id="new-label" type="text" placeholder="e.g. Mom — living room TV" spellcheck="false">
            </div>
            <div class="field">
              <label for="new-expiry">Expires (optional)</label>
              <input id="new-expiry" type="text" placeholder="e.g. 7d, 30d, 1y or never" spellcheck="false" autocomplete="off">
              <p class="faint" id="new-expiry-preview" style="font-size:12px;min-height:14px"></p>
            </div>
            <button class="btn btn-primary" type="submit">Create key</button>
          </form>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h2>Keys</h2>
          <div class="grow"></div>
          <span class="faint" id="refresh-hint"></span>
        </div>
        <div class="table-wrap" id="keys-table"></div>
      </section>
    </div>`;

  $('#logout-btn').addEventListener('click', async () => {
    await fetch('api/logout', { method: 'POST' }).catch(() => {});
    renderLogin();
  });

  $('#sessions-btn').addEventListener('click', loadSessions);
  $('#settings-btn').addEventListener('click', loadSettings);
  const bannerLink = $('#banner-settings');
  if (bannerLink) bannerLink.addEventListener('click', (e) => {
    e.preventDefault();
    loadSettings();
  });

  const newExpiryInput = $('#new-expiry');
  const newExpiryPreview = $('#new-expiry-preview');
  if (newExpiryInput && newExpiryPreview) {
    newExpiryInput.addEventListener('input', () => {
      newExpiryPreview.textContent = expiryPreview(newExpiryInput.value);
    });
  }
  $('#create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const label = $('#new-label').value.trim();
    if (!label) {
      toast('Give the key a label', 'warn');
      return;
    }
    const raw = $('#new-expiry').value;
    const parsed = parseExpiryInput(raw);
    if (parsed === undefined) {
      toast('Invalid expiry — use 7d, 30d, 1y or a date', 'error');
      return;
    }
    const expiresAt = parsed;
    try {
      await api('api/keys', {
        method: 'POST',
        body: JSON.stringify({ label, expiresAt }),
      });
      e.target.reset();
      if (newExpiryPreview) newExpiryPreview.textContent = '';
      toast('Key created');
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  renderTable();
  $('#refresh-hint').textContent = 'auto-refreshes';
}

function renderTable() {
  const wrap = $('#keys-table');
  if (!wrap) return;
  const slugs = slugMap(); // key id -> page slug (deduped)

  const head = `<thead><tr>
      <th>Label</th>
      <th>Status</th>
      <th>Expires</th>
      <th>Created</th>
      <th>Usage</th>
      <th style="text-align:right">Actions</th>
    </tr></thead>`;

  const bodyRows = state.keys
    .map((k) => {
      const st = keyStatus(k);
      const expireText = k.expiresAt
        ? `${st === 'expired' ? 'expired ' : ''}${new Date(k.expiresAt).toLocaleString()} <span style="font-size:11px;opacity:0.8">(${relTime(k.expiresAt)})</span>`
        : '—';
      const lastIp = k.usage.lastIp ? ` · ${esc(k.usage.lastIp)}` : '';
      const pagePath = '/panel/' + (slugs.byId.get(k.id) || k.id);

      return `<tr>
        <td>
          <div class="label-cell">${esc(k.label)}</div>
          ${k.note ? `<div class="note-cell">${esc(k.note)}</div>` : ''}
        </td>
        <td><span class="pill ${st}">${st}</span></td>
        <td class="faint">${expireText}</td>
        <td class="faint">${relTime(k.createdAt)}</td>
        <td class="faint">
          <div>${fmtCount(k.usage.requests)} requests</div>
          <div class="faint" style="font-size:11px">${relTime(k.usage.lastUsedAt)}${lastIp}</div>
        </td>
        <td>
          <div class="row-actions">
            <a class="btn btn-sm btn-primary" href="${pagePath}" data-act="manage" data-id="${k.id}">Manage</a>
          </div>
        </td>
      </tr>`;
    })
    .join('');

  wrap.innerHTML = `<table class="keys">${head}<tbody>${bodyRows || `<tr><td colspan="6"><div class="empty">No keys yet — create one above and hand the link to someone.</div></td></tr>`}</tbody></table>`;

  wrap.querySelectorAll('a[data-act]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      navigate(a.getAttribute('href'));
    });
  });
}

/* ---------- actions ---------- */

// All per-key controls live on the dedicated key page (own URL per key).

function openEditModal(key) {
  const currentExpiryText = key.expiresAt
    ? `${new Date(key.expiresAt).toLocaleString()} (${relTime(key.expiresAt)})`
    : 'never';
  const overlay = openModal(`
    <div class="modal">
      <h3>Edit key</h3>
      <p class="sub">${esc(key.id)}</p>
      <div class="field">
        <label for="e-label">Label</label>
        <input id="e-label" type="text" value="${esc(key.label)}">
      </div>
      <div class="field">
        <label for="e-note">Note (internal only)</label>
        <input id="e-note" type="text" value="${esc(key.note || '')}" placeholder="optional">
      </div>
      <div class="field">
        <label for="e-expiry">Expires</label>
        <input id="e-expiry" type="text" placeholder="e.g. 7d, 30d, 1y or 2026-12-31" value="${key.expiresAt ? esc(toLocalInput(key.expiresAt)) : ''}" spellcheck="false" autocomplete="off">
        <p class="hint" style="margin-top:6px">Current: ${esc(currentExpiryText)} — leave as-is to keep, empty for never, or enter 7d / 2y etc. (from now)</p>
        <p class="faint" id="e-expiry-preview" style="font-size:12px;min-height:14px">${key.expiresAt ? esc(expiryPreview(toLocalInput(key.expiresAt))) : ''}</p>
      </div>
      <div class="btn-row">
        <button class="btn" id="e-cancel">Cancel</button>
        <button class="btn btn-primary" id="e-save">Save</button>
      </div>
    </div>`);

  const eInput = $('#e-expiry', overlay);
  const ePreview = $('#e-expiry-preview', overlay);
  if (eInput && ePreview) {
    eInput.addEventListener('input', () => {
      ePreview.textContent = expiryPreview(eInput.value);
    });
  }
  $('#e-cancel', overlay).addEventListener('click', closeModal);
  $('#e-save', overlay).addEventListener('click', async () => {
    const patch = {
      label: $('#e-label').value.trim() || key.label,
      note: $('#e-note').value.trim(),
    };
    const raw = $('#e-expiry').value;
    const parsed = parseExpiryInput(raw);
    if (parsed === undefined) {
      toast('Invalid expiry — use 7d, 30d, 1y or a date', 'error');
      return;
    }
    patch.expiresAt = parsed;
    await patchKey(key.id, patch, 'Key updated');
    closeModal();
  });
}

function toLocalInput(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function patchKey(id, patch, msg) {
  try {
    await api(`api/keys/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    toast(msg);
    await refresh();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function confirmModal({ title, body, confirmText, danger }) {
  return new Promise((resolve) => {
    const overlay = openModal(`
      <div class="modal">
        <h3>${esc(title)}</h3>
        <p class="sub">${body}</p>
        <div class="btn-row">
          <button class="btn" id="c-cancel">Cancel</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="c-ok">${esc(confirmText)}</button>
        </div>
      </div>`);
    $('#c-cancel', overlay).addEventListener('click', () => {
      closeModal();
      resolve(false);
    });
    $('#c-ok', overlay).addEventListener('click', () => {
      closeModal();
      resolve(true);
    });
  });
}

/* ---------- settings view ---------- */

async function loadSettings() {
  try {
    state.settings = (await api('api/settings')) || {};
    renderSettings();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderSettings() {
  state.view = 'settings';
  const s = state.settings || {};
  const envMasterBadge = s.envMasterUrl
    ? '<span class="badge" style="color:#5c5c64;border-color:var(--border);background:var(--surface-2)">env default</span>'
    : '';
  const envBaseBadge = s.envPublicBase
    ? '<span class="badge" style="color:#5c5c64;border-color:var(--border);background:var(--surface-2)">env default</span>'
    : '';

  $('#app').innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">◫</div>
          <div class="brand-name">AIO Gate</div>
        </div>
        <div class="grow"></div>
        <span class="base-chip" title="${esc(baseUrl())}">${esc(baseUrl())}</span>
        <span class="user-chip">${esc(state.username)}</span>
        <button class="btn btn-sm btn-ghost" id="sessions-btn">Sessions</button>
        <button class="btn btn-sm btn-ghost" id="back-btn">← Dashboard</button>
        <button class="btn btn-sm btn-ghost" id="logout-btn">Sign out</button>
      </header>

      <section class="panel">
        <div class="panel-head"><h2>Gate settings</h2></div>
        <div class="panel-body">
          <form id="settings-form">
            <div class="field">
              <label for="set-master">Master manifest URL ${envMasterBadge}</label>
              <input id="set-master" type="text" value="${esc(s.masterUrl || '')}"
                placeholder="https://.../stremio/<uuid>/<password>/manifest.json" spellcheck="false">
              <p class="hint">The single AIOStreams config every key proxies to. Leave empty to fall back to the
                <code>MASTER_URL</code> env var. Find yours in the AIOStreams panel: Save &amp; Install → Copy URL
                (AIOStreams runs inside the gate at <code>http://127.0.0.1:3210</code>).</p>
            </div>
            <div class="field">
              <label for="set-base">Public base URL ${envBaseBadge}</label>
              <input id="set-base" type="text" value="${esc(s.publicBase || '')}"
                placeholder="https://gate.example.com" spellcheck="false">
              <p class="hint">Used to build shareable key URLs and rewrites. Leave empty to fall back to
                <code>PUBLIC_BASE</code> env or the request host.</p>
            </div>
            <div class="btn-row">
              <button class="btn" id="set-test" type="button">Test connection</button>
              <div class="grow"></div>
              <button class="btn btn-primary" type="submit">Save settings</button>
            </div>
            <p class="form-error" id="set-status"></p>
          </form>
        </div>
      </section>
    </div>`;

  $('#back-btn').addEventListener('click', async () => {
    await refresh();
    renderDash();
  });
  $('#sessions-btn').addEventListener('click', loadSessions);
  $('#logout-btn').addEventListener('click', async () => {
    await fetch('api/logout', { method: 'POST' }).catch(() => {});
    renderLogin();
  });

  $('#set-test').addEventListener('click', async () => {
    const statusEl = $('#set-status');
    statusEl.textContent = 'Testing…';
    statusEl.style.color = 'var(--muted)';
    const btn = $('#set-test');
    btn.disabled = true;
    try {
      const r = await api('api/settings/test', {
        method: 'POST',
        body: JSON.stringify({ masterUrl: $('#set-master').value.trim() }),
      });
      if (r.ok) {
        statusEl.textContent = `✓ Connected — master manifest answered with HTTP ${r.status}`;
        statusEl.style.color = 'var(--accent)';
      } else {
        statusEl.textContent = `✗ Master responded with HTTP ${r.status} — check the URL`;
        statusEl.style.color = 'var(--red)';
      }
    } catch (err) {
      statusEl.textContent = `✗ ${err.message}`;
      statusEl.style.color = 'var(--red)';
    } finally {
      btn.disabled = false;
    }
  });

  $('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const statusEl = $('#set-status');
    try {
      const r = await api('api/settings', {
        method: 'PATCH',
        body: JSON.stringify({
          masterUrl: $('#set-master').value.trim(),
          publicBase: $('#set-base').value.trim(),
        }),
      });
      toast('Settings saved');
      state.settings = { ...state.settings, masterUrl: r.masterUrl, publicBase: r.publicBase };
      statusEl.textContent = '';
      await refresh(); // refresh config (banner state, base url)
    } catch (err) {
      statusEl.textContent = `✗ ${err.message}`;
      statusEl.style.color = 'var(--red)';
    }
  });
}

/* ---------- sessions & security view ---------- */

async function loadSessions() {
  try {
    const [sRes, meRes] = await Promise.all([
      api('api/sessions'),
      api('api/me'),
    ]);
    state.sessions = sRes.sessions || [];
    state.sessionTtlDays = sRes.sessionTtlDays || 7;
    state.currentSessionId = meRes.sessionId || state.currentSessionId;
    state.twoFactorEnabled = !!meRes.twoFactorEnabled;
    renderSessions();
  } catch (err) {
    if (err.status === 401) renderLogin();
    else toast(err.message, 'error');
  }
}

async function refreshSessions() {
  if (state.view !== 'sessions') return;
  try {
    const sRes = await api('api/sessions');
    state.sessions = sRes.sessions || [];
    state.sessionTtlDays = sRes.sessionTtlDays || state.sessionTtlDays;
    renderSessionsTable();
  } catch (err) {
    if (err.status === 401) renderLogin();
  }
}

function renderSessions() {
  state.view = 'sessions';
  const twoFa = state.twoFactorEnabled;
  $('#app').innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">◫</div>
          <div class="brand-name">AIO Gate</div>
        </div>
        <div class="grow"></div>
        <span class="base-chip" title="${esc(baseUrl())}">${esc(baseUrl())}</span>
        <span class="user-chip">${esc(state.username)}</span>
        <button class="btn btn-sm btn-ghost" id="back-btn">← Dashboard</button>
        <button class="btn btn-sm btn-ghost" id="logout-btn">Sign out</button>
      </header>

      <section class="panel">
        <div class="panel-head">
          <h2>Two-factor authentication</h2>
          <div class="grow"></div>
          ${twoFa
            ? '<span class="pill active">enabled</span>'
            : '<span class="pill" style="color:var(--faint);border-color:var(--border);background:var(--surface-2)">disabled</span>'}
        </div>
        <div class="panel-body">
          ${twoFa
            ? `<p class="sec-desc">Sign-in requires a 6-digit code from your authenticator app (or a recovery code).
              Your session is protected even if the password leaks.</p>
              <div class="btn-row" style="margin-top:0">
                <button class="btn btn-danger" id="tfa-disable">Disable 2FA</button>
              </div>`
            : `<p class="sec-desc">Add a one-time code from an authenticator app (Google Authenticator, Authy,
              1Password, …) to admin sign-in. You'll get 10 one-time recovery codes when you enable it —
              keep them somewhere safe in case you lose your phone.</p>
              <div class="btn-row" style="margin-top:0">
                <button class="btn btn-primary" id="tfa-enable">Enable two-factor authentication</button>
              </div>`}
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h2>Admin sessions</h2>
          <div class="grow"></div>
          <span class="faint">expire after ${state.sessionTtlDays} days</span>
        </div>
        <div class="table-wrap" id="sessions-table"></div>
        <div class="panel-body" style="padding-top:0">
          <div class="btn-row" style="margin-top:8px">
            <button class="btn" id="revoke-others">Sign out everywhere else</button>
          </div>
          <p class="hint">Every admin sign-in creates a session here. Rename them to recognize devices and
            revoke anything you don't recognize — revocation takes effect immediately server-side.</p>
        </div>
      </section>
    </div>`;

  $('#back-btn').addEventListener('click', async () => {
    state.view = 'dash';
    history.pushState(null, '', '/panel/');
    await refresh();
    renderDash();
  });
  $('#logout-btn').addEventListener('click', async () => {
    await fetch('api/logout', { method: 'POST' }).catch(() => {});
    renderLogin();
  });
  $('#tfa-enable')?.addEventListener('click', setupTwoFactor);
  $('#tfa-disable')?.addEventListener('click', disableTwoFactor);
  $('#revoke-others').addEventListener('click', revokeOthers);

  renderSessionsTable();
}

function renderSessionsTable() {
  const wrap = $('#sessions-table');
  if (!wrap) return;
  const rows = state.sessions
    .map((s) => {
      const isCurrent = s.current;
      const name = isCurrent
        ? `${esc(s.name)} <span class="pill active" style="margin-left:6px">this session</span>`
        : esc(s.name);
      return `<tr>
        <td style="min-width:180px">
          <div class="label-cell">${name}</div>
          ${s.userAgent ? `<div class="note-cell">${esc(s.userAgent)}</div>` : ''}
        </td>
        <td class="faint" style="white-space:nowrap">${esc(s.lastIp || '—')}</td>
        <td class="faint">${relTime(s.createdAt)}</td>
        <td class="faint">${relTime(s.lastSeenAt)}</td>
        <td style="text-align:right">
          <div class="row-actions">
            <button class="btn btn-sm" data-rename="${esc(s.id)}">Rename</button>
            <button class="btn btn-sm btn-danger" data-revoke="${esc(s.id)}" ${isCurrent ? 'data-current="1"' : ''}>Revoke</button>
          </div>
        </td>
      </tr>`;
    })
    .join('');

  wrap.innerHTML = `<table class="keys">
    <thead><tr>
      <th>Session</th><th>IP</th><th>Created</th><th>Last seen</th><th style="text-align:right">Actions</th>
    </tr></thead>
    <tbody>${rows || `<tr><td colspan="5"><div class="empty">No sessions tracked yet.</div></td></tr>`}</tbody>
  </table>`;

  wrap.querySelectorAll('button[data-rename]').forEach((b) =>
    b.addEventListener('click', () => renameSessionModal(b.dataset.rename))
  );
  wrap.querySelectorAll('button[data-revoke]').forEach((b) =>
    b.addEventListener('click', () => revokeSession(b.dataset.revoke, !!b.dataset.current))
  );
}

function renameSessionModal(id) {
  const s = state.sessions.find((x) => x.id === id);
  if (!s) return;
  const overlay = openModal(`
    <div class="modal">
      <h3>Rename session</h3>
      <p class="sub">Give this session a name you'll recognize (max 32 characters).</p>
      <div class="field">
        <label for="s-name">Session name</label>
        <input id="s-name" type="text" value="${esc(s.name)}" maxlength="32" spellcheck="false">
        <p class="hint" id="s-count">0 / 32</p>
      </div>
      <div class="btn-row">
        <button class="btn" id="s-cancel">Cancel</button>
        <button class="btn btn-primary" id="s-save">Save</button>
      </div>
    </div>`);
  const input = $('#s-name', overlay);
  const count = $('#s-count', overlay);
  const upd = () => (count.textContent = `${input.value.length} / 32`);
  input.addEventListener('input', upd);
  upd();
  $('#s-cancel', overlay).addEventListener('click', closeModal);
  $('#s-save', overlay).addEventListener('click', async () => {
    const name = input.value.trim();
    if (!name) return toast('Name is required', 'warn');
    if (name.length > 32) return toast('Max 32 characters', 'warn');
    try {
      await api(`api/sessions/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      });
      closeModal();
      toast('Session renamed');
      await refreshSessions();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

async function revokeSession(id, isCurrent) {
  const s = state.sessions.find((x) => x.id === id);
  const label = s ? s.name : 'this session';
  const ok = await confirmModal({
    title: isCurrent ? 'Sign out this session?' : 'Revoke this session?',
    body: isCurrent
      ? `“${esc(label)}” is the session you're using right now — revoking it signs you out.`
      : `“${esc(label)}” will be signed out immediately and its cookie will stop working.`,
    confirmText: isCurrent ? 'Sign out' : 'Revoke session',
    danger: true,
  });
  if (!ok) return;
  try {
    const r = await api(`api/sessions/${id}`, { method: 'DELETE' });
    toast(r.revokedCurrent ? 'Signed out' : 'Session revoked');
    if (r.revokedCurrent) {
      state.currentSessionId = null;
      state.username = null;
      renderLogin();
    } else {
      await refreshSessions();
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function revokeOthers() {
  const others = state.sessions.filter((s) => !s.current).length;
  if (!others) {
    toast('No other sessions to revoke', 'warn');
    return;
  }
  const ok = await confirmModal({
    title: 'Sign out everywhere else?',
    body: `Revoke ${others} other session${others === 1 ? '' : 's'}? This session stays signed in.`,
    confirmText: 'Sign out others',
    danger: true,
  });
  if (!ok) return;
  try {
    const r = await api('api/sessions/revoke-others', { method: 'POST' });
    toast(`Revoked ${r.revoked} session${r.revoked === 1 ? '' : 's'}`);
    await refreshSessions();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ---------- 2FA setup / disable ---------- */

async function setupTwoFactor() {
  let setup;
  try {
    setup = await api('api/2fa/setup', { method: 'POST' });
  } catch (err) {
    return toast(err.message, 'error');
  }
  const overlay = openModal(`
    <div class="modal modal-wide">
      <h3>Set up two-factor authentication</h3>
      <p class="sub">Scan this with your authenticator app, or enter the secret manually.</p>
      <div class="tfa-secret" title="click to select">${esc(setup.secret)}</div>
      <p class="hint" style="margin-top:8px">
        Or paste this into your app:<br>
        <code class="otpauth-line">${esc(setup.otpauth)}</code>
      </p>
      <div class="field" style="margin-top:16px">
        <label for="tfa-code">Enter the 6-digit code from your app</label>
        <input id="tfa-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" spellcheck="false">
      </div>
      <div class="btn-row">
        <button class="btn" id="tfa-cancel">Cancel</button>
        <button class="btn btn-primary" id="tfa-verify">Verify &amp; enable</button>
      </div>
      <p class="form-error" id="tfa-status"></p>
    </div>`);
  $('#tfa-cancel', overlay).addEventListener('click', closeModal);
  const verify = async () => {
    const code = $('#tfa-code', overlay).value.trim();
    const statusEl = $('#tfa-status', overlay);
    if (!/^\d{6}$/.test(code)) {
      statusEl.textContent = 'Enter the 6-digit code';
      return;
    }
    const btn = $('#tfa-verify', overlay);
    btn.disabled = true;
    try {
      const r = await api('api/2fa/enable', {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      closeModal();
      showRecoveryCodes(r.recoveryCodes || []);
      state.twoFactorEnabled = true;
    } catch (err) {
      statusEl.textContent = err.message || 'Enable failed';
      btn.disabled = false;
    }
  };
  $('#tfa-verify', overlay).addEventListener('click', verify);
  $('#tfa-code', overlay).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') verify();
  });
  setTimeout(() => $('#tfa-code', overlay).focus(), 30);
}

function showRecoveryCodes(codes) {
  const overlay = openModal(`
    <div class="modal modal-wide">
      <h3>Save your recovery codes</h3>
      <p class="sub">Each code works exactly once to sign in if you lose your phone. These are shown
        only now — store them somewhere safe, then confirm.</p>
      <div class="code-grid">${codes.map((c) => `<code>${esc(c)}</code>`).join('')}</div>
      <div class="btn-row">
        <button class="btn btn-primary" id="rc-done">I've saved them</button>
      </div>
    </div>`);
  $('#rc-done', overlay).addEventListener('click', () => {
    closeModal();
    toast('Two-factor authentication enabled');
    renderSessions();
  });
}

function disableTwoFactor() {
  const overlay = openModal(`
    <div class="modal">
      <h3>Disable two-factor authentication</h3>
      <p class="sub">Confirm your password and a current code to turn 2FA off.</p>
      <div class="field">
        <label for="td-pass">Password</label>
        <input id="td-pass" type="password" autocomplete="current-password">
      </div>
      <div class="field">
        <label for="td-code">2FA code</label>
        <input id="td-code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="12" placeholder="6-digit or recovery code" spellcheck="false">
      </div>
      <div class="btn-row">
        <button class="btn" id="td-cancel">Cancel</button>
        <button class="btn btn-danger" id="td-go">Disable 2FA</button>
      </div>
      <p class="form-error" id="td-status"></p>
    </div>`);
  $('#td-cancel', overlay).addEventListener('click', closeModal);
  $('#td-go', overlay).addEventListener('click', async () => {
    const statusEl = $('#td-status', overlay);
    const btn = $('#td-go', overlay);
    btn.disabled = true;
    try {
      await api('api/2fa/disable', {
        method: 'POST',
        body: JSON.stringify({
          password: $('#td-pass', overlay).value,
          code: $('#td-code', overlay).value.trim(),
        }),
      });
      closeModal();
      state.twoFactorEnabled = false;
      toast('Two-factor authentication disabled');
      renderSessions();
    } catch (err) {
      statusEl.textContent = err.message || 'Failed';
      btn.disabled = false;
    }
  });
}

/* ---------- key page ---------- */

function wireTopbar() {
  const back = $('#back-btn');
  if (back)
    back.addEventListener('click', async () => {
      state.view = 'dash';
      state.currentKeyId = null;
      history.pushState(null, '', '/panel/');
      await refresh();
      renderDash();
    });
  const out = $('#logout-btn');
  if (out)
    out.addEventListener('click', async () => {
      await fetch('api/logout', { method: 'POST' }).catch(() => {});
      renderLogin();
    });
}

function keyPageShell() {
  return `
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">◫</div>
          <div class="brand-name">AIO Gate</div>
        </div>
        <div class="grow"></div>
        <span class="base-chip" title="${esc(baseUrl())}">${esc(baseUrl())}</span>
        <span class="user-chip">${esc(state.username)}</span>
        <button class="btn btn-sm btn-ghost" id="sessions-btn">Sessions</button>
        <button class="btn btn-sm btn-ghost" id="back-btn">← Dashboard</button>
        <button class="btn btn-sm btn-ghost" id="logout-btn">Sign out</button>
      </header>
      <div class="empty">Loading key…</div>
    </div>`;
}

async function renderKey(id) {
  state.view = 'key';
  state.currentKeyId = id;
  // Keep the address bar on this key's own URL (label may have changed or
  // duplicate labels re-deduped since the link was rendered).
  const want = keyPagePath(id);
  if (want !== location.pathname) history.replaceState(null, '', want);
  $('#app').innerHTML = keyPageShell();
  wireTopbar();
  await refreshKey();
}

async function refreshKey() {
  const id = state.currentKeyId;
  if (!id) return;
  try {
    const [keyRes, histRes] = await Promise.all([
      api(`api/keys/${id}`),
      api(`api/keys/${id}/history`),
    ]);
    if (state.view !== 'key' || state.currentKeyId !== id) return; // stale
    state.currentKey = keyRes.key;
    state.currentHistory = histRes.entries || [];
    state.retentionDays = histRes.retentionDays || 30;
    renderKeyPage();
  } catch (err) {
    if (err.status === 401) {
      renderLogin();
    } else if (err.status === 404) {
      toast('Key not found', 'error');
      state.currentKeyId = null;
      history.replaceState(null, '', '/panel/');
      renderDash();
    } else {
      toast(err.message, 'error');
    }
  }
}

function renderKeyPage() {
  const k = state.currentKey;
  if (!k) return;
  const st = keyStatus(k);
  const hist = state.currentHistory || [];
  const lastUsed =
    relTime(k.usage.lastUsedAt) + (k.usage.lastIp ? ` · ${esc(k.usage.lastIp)}` : '');

  const pauseBtn =
    st === 'active'
      ? `<button class="btn" id="k-pause">Pause</button>`
      : st === 'paused'
        ? `<button class="btn" id="k-resume">Resume</button>`
        : '';

  $('#app').innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark">◫</div>
          <div class="brand-name">AIO Gate</div>
        </div>
        <div class="grow"></div>
        <span class="base-chip" title="${esc(baseUrl())}">${esc(baseUrl())}</span>
        <span class="user-chip">${esc(state.username)}</span>
        <button class="btn btn-sm btn-ghost" id="sessions-btn">Sessions</button>
        <button class="btn btn-sm btn-ghost" id="back-btn">← Dashboard</button>
        <button class="btn btn-sm btn-ghost" id="logout-btn">Sign out</button>
      </header>

      <section class="panel">
        <div class="panel-head">
          <h2>Key</h2>
          <div class="grow"></div>
          <span class="pill ${st}">${st}</span>
        </div>
        <div class="panel-body">
          <div class="key-head">
            <div class="key-title">${esc(k.label)}</div>
            <div class="key-id-big">${esc(k.id)}</div>
            <div class="key-url-row">
              <code class="key-url-full">${esc(keyUrl(k))}</code>
              <button class="btn btn-sm" id="k-copy">Copy URL</button>
            </div>
          </div>
          <div class="meta-grid">
            <div class="meta"><div class="num">${fmtCount(k.usage.requests)}</div><div class="lbl">Requests</div></div>
            <div class="meta"><div class="num">${lastUsed}</div><div class="lbl">Last used</div></div>
            <div class="meta"><div class="num" style="font-size:13px;line-height:1.3">${k.expiresAt ? `${esc(new Date(k.expiresAt).toLocaleString())}<br><span class="faint" style="font-size:11px">${esc(relTime(k.expiresAt))}</span>` : '—'}</div><div class="lbl">Expires</div></div>
            <div class="meta"><div class="num">${relTime(k.createdAt)}</div><div class="lbl">Created</div></div>
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head"><h2>Controls</h2></div>
        <div class="panel-body">
          <div class="btn-row" style="margin-top:0">
            ${pauseBtn}
            <button class="btn" id="k-edit">Edit</button>
            <button class="btn btn-danger" id="k-del">Delete</button>
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h2>Watch history</h2>
          <div class="grow"></div>
          <span class="faint">kept ${state.retentionDays} days</span>
        </div>
        <div class="panel-body">
          <div class="field" style="max-width:320px">
            <input id="hist-filter" type="text" placeholder="Filter…" spellcheck="false">
          </div>
          <div class="table-wrap" id="hist-table"></div>
          <p class="hint">Stream lookups made by this key are recorded here automatically.
            Entries older than ${state.retentionDays} days are deleted to save space.</p>
        </div>
      </section>
    </div>`;

  wireTopbar();
  const sessBtn = $('#sessions-btn');
  if (sessBtn) sessBtn.addEventListener('click', loadSessions);
  $('#k-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(keyUrl(k));
      toast('Manifest URL copied');
    } catch {
      toast('Copy failed — select the URL manually', 'error');
    }
  });
  if ($('#k-pause'))
    $('#k-pause').addEventListener('click', () =>
      patchKey(k.id, { status: 'paused' }, 'Key paused')
    );
  if ($('#k-resume'))
    $('#k-resume').addEventListener('click', () =>
      patchKey(k.id, { status: 'active' }, 'Key resumed')
    );
  $('#k-edit').addEventListener('click', () => openEditModal(k));
  $('#k-del').addEventListener('click', async () => {
    const ok = await confirmModal({
      title: 'Delete this key permanently?',
      body: `“${esc(k.label)}” (${esc(k.id)}), its usage history and watch log will be removed. This cannot be undone.`,
      confirmText: 'Delete key',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`api/keys/${k.id}`, { method: 'DELETE' });
      toast('Key deleted');
      state.currentKeyId = null;
      state.view = 'dash';
      history.pushState(null, '', '/panel/');
      await refresh();
      renderDash();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  const filterEl = $('#hist-filter');
  filterEl.addEventListener('input', () =>
    renderHistTable(hist, filterEl.value.trim().toLowerCase())
  );
  renderHistTable(hist, '');
}

function histMediaLine(e) {
  const parts = [];
  if (e.season != null || e.episodeNumber != null) {
    const s = e.season != null ? String(e.season).padStart(2, '0') : '?';
    const n =
      e.episodeNumber != null ? String(e.episodeNumber).padStart(2, '0') : '?';
    parts.push(`S${s}E${n}`);
  }
  if (e.episodeName) parts.push(e.episodeName);
  return parts.join(' · ');
}

function renderHistTable(entries, q) {
  const wrap = $('#hist-table');
  if (!wrap) return;
  const rows = entries
    .filter((e) => {
      if (!q) return true;
      return [e.type, e.id, e.title, e.episodeName, e.ip].some((v) =>
        String(v || '').toLowerCase().includes(q)
      );
    })
    .map((e) => {
      const title = e.title || e.id;
      const ep = histMediaLine(e);
      const idPart = e.title
        ? `<div class="faint" style="font-size:11px">${esc(e.id)}</div>`
        : '';
      const epPart = ep ? `<div class="hist-ep">${esc(ep)}</div>` : '';
      return `<tr>
        <td class="faint" style="white-space:nowrap">${relTime(e.ts)}</td>
        <td><span class="badge">${esc(e.type)}</span></td>
        <td>
          <div class="hist-title">${esc(title)}</div>
          ${epPart}
          ${idPart}
        </td>
        ${e.ip ? `<td class="faint">${esc(e.ip)}</td>` : '<td></td>'}
      </tr>`;
    })
    .join('');

  wrap.innerHTML = `<table class="keys">
    <thead><tr>
      <th>When</th><th>Type</th><th>Media</th><th>IP</th>
    </tr></thead>
    <tbody>${rows || `<tr><td colspan="4"><div class="empty">Nothing streamed yet for this key — entries appear here when Stremio asks it for streams.</div></td></tr>`}</tbody>
  </table>`;
}

/* ---------- refresh / boot ---------- */

async function refresh() {
  try {
    const [keyRes, cfg] = await Promise.all([
      api('api/keys'),
      api('api/config'),
    ]);
    state.keys = keyRes.keys;
    state.config = cfg;
    if (state.view === 'dash') renderTable();
    else if (state.view === 'key') {
      const id = state.currentKeyId;
      if (id) {
        const want = keyPagePath(id);
        if (want !== location.pathname) history.replaceState(null, '', want);
      }
      refreshKey();
    }
  } catch (err) {
    if (err.status === 401) {
      renderLogin();
    }
  }
}

async function boot() {
  try {
    const me = await api('api/me');
    state.username = me.username;
    state.currentSessionId = me.sessionId || null;
    state.twoFactorEnabled = !!me.twoFactorEnabled;
    await refresh();
    route();
  } catch {
    renderLogin();
  }
}

// Browser back/forward between /panel/ and /panel/<label>.
window.addEventListener('popstate', route);

setInterval(() => {
  if (state.view === 'dash') refresh();
  else if (state.view === 'key') refreshKey();
  else if (state.view === 'sessions') refreshSessions();
}, 30_000);

boot();
