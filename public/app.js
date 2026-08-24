/* aio-gate admin panel — flat, dependency-free */

'use strict';

const state = {
  keys: [],
  config: { publicBase: null, master: '', hasCustomMasters: false },
  view: 'boot',
  currentKeyId: null,
  currentKey: null,
  currentHistory: [],
  retentionDays: 30,
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
  if (d < 0) return 'in ' + Math.round(-d / 1000) + 's';
  if (d < 60_000) return 'just now';
  if (d < 3600_000) return Math.floor(d / 60_000) + 'm ago';
  if (d < 86400_000) return Math.floor(d / 3600_000) + 'h ago';
  if (d < 7 * 86400_000) return Math.floor(d / 86400_000) + 'd ago';
  return new Date(iso).toLocaleDateString();
}

function fmtBytes(b) {
  if (!b) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return (i === 0 ? v : v.toFixed(1)) + ' ' + units[i];
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

function baseUrl() {
  return (state.config.publicBase || location.origin).replace(/\/+$/, '');
}

function keyUrl(key) {
  return `${baseUrl()}/go/${key.id}/manifest.json`;
}

/* ---------- views ---------- */

function renderLogin() {
  state.view = 'login';
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
        }),
      });
      await boot();
    } catch (err) {
      errEl.textContent = err.message || 'Sign in failed';
      btn.disabled = false;
    }
  });
}

function renderDash() {
  state.view = 'dash';
  const counts = { active: 0, paused: 0, revoked: 0, expired: 0 };
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
        <button class="btn btn-sm btn-ghost" id="settings-btn">Settings</button>
        ${state.config.bundled ? `<a class="btn btn-sm" href="/" target="_blank" rel="noopener">AIOStreams panel ↗</a>` : ''}
        <button class="btn btn-sm btn-ghost" id="logout-btn">Sign out</button>
      </header>

      ${state.config.masterConfigured ? '' : `
      <div class="banner">⚠ No master configured — keys won't work until you set the master manifest URL.
        <a href="#" id="banner-settings">Open Settings →</a></div>`}

      <section class="stats">
        <div class="stat"><div class="num green">${counts.active}</div><div class="lbl">Active keys</div></div>
        <div class="stat"><div class="num amber">${counts.paused}</div><div class="lbl">Paused</div></div>
        <div class="stat"><div class="num red">${counts.revoked}</div><div class="lbl">Revoked</div></div>
        <div class="stat"><div class="num">${fmtCount(todayReq)}</div><div class="lbl">Requests today</div></div>
      </section>

      <section class="panel">
        <div class="panel-head"><h2>Issue a new key</h2></div>
        <div class="panel-body">
          <form id="create-form" class="newkey-grid">
            <div class="field">
              <label for="new-label">Label (who is this for?)</label>
              <input id="new-label" type="text" placeholder="e.g. Mom — living room TV" spellcheck="false">
            </div>
            <div class="field">
              <label for="new-expiry">Expires (optional)</label>
              <input id="new-expiry" type="datetime-local">
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

  $('#settings-btn').addEventListener('click', loadSettings);
  const bannerLink = $('#banner-settings');
  if (bannerLink) bannerLink.addEventListener('click', (e) => {
    e.preventDefault();
    loadSettings();
  });

  $('#create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const label = $('#new-label').value.trim();
    if (!label) {
      toast('Give the key a label', 'warn');
      return;
    }
    let expiresAt = null;
    const raw = $('#new-expiry').value;
    if (raw) {
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) expiresAt = d.toISOString();
    }
    try {
      await api('api/keys', {
        method: 'POST',
        body: JSON.stringify({ label, expiresAt }),
      });
      e.target.reset();
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

  const head = `<thead><tr>
      <th>Key / URL</th>
      <th>Label</th>
      <th>Status</th>
      <th>Master</th>
      <th>Expires</th>
      <th>Created</th>
      <th>Usage</th>
      <th style="text-align:right">Actions</th>
    </tr></thead>`;

  const bodyRows = state.keys
    .map((k) => {
      const st = keyStatus(k);
      const statText = `${fmtCount(k.usage.requests)} req · ${fmtBytes(k.usage.bytes)} total`;
      const stat30 = `${fmtBytes(k.usage.bytes30d || 0)} last 30 days`;
      const masterBadge = k.masterUrl
        ? '<span class="badge">custom master</span>'
        : '<span class="badge" style="color:#5c5c64;border-color:var(--border);background:var(--surface-2)">default</span>';
      const expireText = k.expiresAt
        ? `${st === 'expired' ? 'expired ' : ''}${new Date(k.expiresAt).toLocaleDateString()}`
        : '—';
      const lastIp = k.usage.lastIp ? ` · ${esc(k.usage.lastIp)}` : '';

      return `<tr>
        <td class="key-cell">
          <span class="key-id">${esc(k.id)}</span>
          <span class="key-url" title="${esc(keyUrl(k))}">${esc(keyUrl(k))}</span>
        </td>
        <td>
          <div class="label-cell">${esc(k.label)}</div>
          ${k.note ? `<div class="note-cell">${esc(k.note)}</div>` : ''}
        </td>
        <td><span class="pill ${st}">${st}</span></td>
        <td>${masterBadge}</td>
        <td class="faint">${expireText}</td>
        <td class="faint">${relTime(k.createdAt)}</td>
        <td class="faint">
          <div>${statText}</div>
          <div>${stat30}</div>
          <div class="faint" style="font-size:11px">${relTime(k.usage.lastUsedAt)}${lastIp}</div>
        </td>
        <td>
          <div class="row-actions">
            <button class="btn btn-sm btn-primary" data-act="manage" data-id="${k.id}">Manage</button>
          </div>
        </td>
      </tr>`;
    })
    .join('');

  wrap.innerHTML = `<table class="keys">${head}<tbody>${bodyRows || `<tr><td colspan="8"><div class="empty">No keys yet — create one above and hand the link to someone.</div></td></tr>`}</tbody></table>`;

  wrap.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => act(btn.dataset.act, btn.dataset.id));
  });
}

/* ---------- actions ---------- */

// All per-key controls live on the dedicated key page now.
async function act(name, id) {
  if (name === 'manage') await renderKey(id);
}

function openEditModal(key) {
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
        <label for="e-master">Master URL override</label>
        <input id="e-master" type="url" value="${esc(key.masterUrl || '')}" placeholder="leave empty = default master">
      </div>
      <div class="field">
        <label for="e-expiry">Expires</label>
        <input id="e-expiry" type="datetime-local" value="${key.expiresAt ? toLocalInput(key.expiresAt) : ''}">
      </div>
      <div class="btn-row">
        <button class="btn" id="e-cancel">Cancel</button>
        <button class="btn btn-primary" id="e-save">Save</button>
      </div>
    </div>`);

  $('#e-cancel', overlay).addEventListener('click', closeModal);
  $('#e-save', overlay).addEventListener('click', async () => {
    const patch = {
      label: $('#e-label').value.trim() || key.label,
      note: $('#e-note').value.trim(),
      masterUrl: $('#e-master').value.trim() || null,
    };
    const raw = $('#e-expiry').value;
    const d = raw ? new Date(raw) : null;
    patch.expiresAt =
      d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
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
                (in bundled mode, swap the host for <code>http://127.0.0.1:3210</code>).</p>
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

/* ---------- key page ---------- */

function wireTopbar() {
  const back = $('#back-btn');
  if (back)
    back.addEventListener('click', async () => {
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
        <button class="btn btn-sm btn-ghost" id="back-btn">← Dashboard</button>
        <button class="btn btn-sm btn-ghost" id="logout-btn">Sign out</button>
      </header>
      <div class="empty">Loading key…</div>
    </div>`;
}

async function renderKey(id) {
  state.view = 'key';
  state.currentKeyId = id;
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
            <div class="meta"><div class="num">${fmtBytes(k.usage.bytes30d || 0)}</div><div class="lbl">Bandwidth · last 30 days</div></div>
            <div class="meta"><div class="num">${fmtBytes(k.usage.bytes)}</div><div class="lbl">Bandwidth · lifetime</div></div>
            <div class="meta"><div class="num">${fmtCount(k.usage.requests)}</div><div class="lbl">Requests</div></div>
            <div class="meta"><div class="num">${lastUsed}</div><div class="lbl">Last used</div></div>
            <div class="meta"><div class="num">${k.expiresAt ? new Date(k.expiresAt).toLocaleDateString() : '—'}</div><div class="lbl">Expires</div></div>
            <div class="meta"><div class="num">${relTime(k.createdAt)}</div><div class="lbl">Created</div></div>
            <div class="meta"><div class="num">${k.masterUrl ? 'custom master' : 'default'}</div><div class="lbl">Master</div></div>
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

function renderHistTable(entries, q) {
  const wrap = $('#hist-table');
  if (!wrap) return;
  const rows = entries
    .filter((e) => {
      if (!q) return true;
      return [e.type, e.id, e.title, e.ip].some((v) =>
        String(v || '').toLowerCase().includes(q)
      );
    })
    .map((e) => {
      const title = e.title || e.id;
      const idPart = e.title ? `<div class="faint" style="font-size:11px">${esc(e.id)}</div>` : '';
      return `<tr>
        <td class="faint" style="white-space:nowrap">${relTime(e.ts)}</td>
        <td><span class="badge">${esc(e.type)}</span></td>
        <td>
          <div class="hist-title">${esc(title)}</div>
          ${idPart}
        </td>
        <td class="faint">${fmtBytes(e.bytes)}</td>
        ${e.ip ? `<td class="faint">${esc(e.ip)}</td>` : '<td></td>'}
      </tr>`;
    })
    .join('');

  wrap.innerHTML = `<table class="keys">
    <thead><tr>
      <th>When</th><th>Type</th><th>Media</th><th>Served</th><th>IP</th>
    </tr></thead>
    <tbody>${rows || `<tr><td colspan="5"><div class="empty">Nothing streamed yet for this key — entries appear here when Stremio asks it for streams.</div></td></tr>`}</tbody>
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
    else if (state.view === 'key') refreshKey();
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
    await refresh();
    renderDash();
  } catch {
    renderLogin();
  }
}

setInterval(() => {
  if (state.view === 'dash') refresh();
  else if (state.view === 'key') refreshKey();
}, 30_000);

boot();
