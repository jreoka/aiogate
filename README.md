# aio-gate

A small, zero-dependency gateway that sits in front of **one master AIOStreams
instance** and hands out **revocable sub-keys** to friends and family.
AIOStreams runs inside the same container as the gate, hidden from the public
internet.

- 🔑 Each person gets their own key URL: `https://gate.example/go/<key>/manifest.json`
- ⏸ Pause, ▶ resume, or ❌ revoke any key from a flat, OLED-black admin panel — no AIOStreams changes needed
- 📺 Per-key **watch history**: every key's page shows what media it streamed (movie/series ids, titles, when, how much data), auto-deleted after **30 days** to save space
- 🔒 The master manifest URL (uuid/password) never appears in anything handed out — the gate proxies and rewrites it out of every response
- 📊 Per-key usage stats: requests, bandwidth (**last 30 days + lifetime**), last used, last IP
- 🐳 **One container**: AIOStreams + gate together, one volume, AIOStreams panel only reachable through the gate's admin login

---

## Why this exists

Today you run one AIOStreams "parent" config plus N child configs (one per
person), so you can revoke a leak by deleting that child. That's painful:
every child is a copy of your config, and updates mean re-doing them all.

With aio-gate you keep **one** master config — the one you already use — and
the gate becomes the only thing your friends ever see:

```
          your friends / family
                 │  https://gate.example/go/<key>/manifest.json
                 ▼
            ┌─────────┐
            │ aio-gate │   keys: active / paused / revoked / deleted
            └────┬────┘
                 │  https://aiostreams.example/stremio/<uuid>/<password>/...   (never exposed)
                 ▼
            ┌─────────────┐
            │  AIOStreams │──► TorBox / debrid
            └─────────────┘
```

Revoke a leak = flip one switch in the panel. Everybody else keeps working.
Because everyone shares your one master config, there's only ever one place to
update settings (debrid keys, addons, filters, …).

---

## Deployment — AIOStreams inside the gate (one container)

One container runs **both** processes:

| Process | Binds | Reachable from outside? |
|---|---|---|
| AIOStreams | `127.0.0.1:3210` (internal) | ❌ never |
| aio-gate | `0.0.0.0:3000` | ✅ the only published port |

The gate owns the whole public URL namespace:

| Public path | What it is | Who can use it |
|---|---|---|
| `/go/<key>/manifest.json` | your friends' addon install URLs | anyone with a valid key |
| `/panel/` | the gate's key-admin panel (and the landing page — `/` redirects here) | gate admin login |
| `/panel/<label>` | one page per key, e.g. `/panel/Test` | gate admin login |
| `/`, `/login`, `/dashboard`, `/stremio/...`, `/api/v1/...`, `/assets/...` | the **AIOStreams panel** (proxied transparently), entered via the gate panel's "AIOStreams panel ↗" button (`/?aiostreams=1`) | **only after gate admin login** |
| `/healthz` | health (checks AIOStreams too) | public |

So the AIOStreams panel — including its configure pages, dashboard, and even
the addon API at `/stremio/<uuid>/<pass>/...` — is completely hidden behind the
gate's admin login. Visiting the site root redirects to the gate panel
(`/panel/`); the "AIOStreams panel ↗" button in the gate panel opens AIOStreams
for you (`/?aiostreams=1`). You log into AIOStreams once with your
`AIOSTREAMS_AUTH` credentials (its own session cookie flows through the proxy).

### Deploy (Docker)

```bash
git clone <this repo> aio-gate
cd aio-gate
cp .env.example .env      # then edit .env
docker compose up -d --build
```

`.env` — your existing AIOStreams env carries over unchanged, plus three new
gate variables:

```dotenv
# ── AIOStreams (same env vars you use today) ──
BASE_URL=https://stream.dill.moe
DATABASE_URI=sqlite://./data/db.sqlite
NODE_ENV=production
AIOSTREAMS_AUTH=admin:your-password
SECRET_KEY=your-64-hex-char-key

# ── aio-gate ──
# Master manifest URL AS SEEN FROM INSIDE the container. To find it: open the
# AIOStreams panel (via the gate), go to Save & Install, click "Copy URL" on
# YOUR main profile, then swap the host for http://127.0.0.1:3210
MASTER_URL=http://127.0.0.1:3210/stremio/<your-uuid>/<your-password>/manifest.json
PUBLIC_BASE=https://stream.dill.moe
```

The gate's admin login reuses the **first `AIOSTREAMS_AUTH` pair** by default
(`admin` / your password) — no separate password to remember. Override with
`ADMIN_USERNAME` / `ADMIN_PASSWORD` if you want them different.

One volume, `/app/data`, holds everything persistent: AIOStreams' `db.sqlite`
and the gate's `keys.json`. On RunOnFlux or any other host, mount your volume
at `/app/data` and publish only port **3000**.

> **Migrating from your current single-AIOStreams container:** your existing
> `DATABASE_URI`/volume already contain your configs — point the same volume
> at the new image and AIOStreams picks up right where it left off. Your master
> config (uuid/password) is already in there; just put it in `MASTER_URL`.

---

## How it works

### URL mapping (key proxy)

| Friend requests (gate) | Proxied to (master) |
|---|---|
| `/go/<key>/manifest.json` | `/stremio/<uuid>/<password>/manifest.json` |
| `/go/<key>/stream/<type>/<id>.json` | `/stremio/<uuid>/<password>/stream/<type>/<id>.json` |
| `/go/<key>/catalog/…`, `meta/…`, `subtitles/…`, `addon_catalog/…` | same, under the master path |
| `/go/<key>/v/<variant>/manifest.json` | variant form, under the master path |
| `/go/<key>/raw/<any path>` | `/<any path>` (origin-absolute URLs, e.g. `/api/v1/debrid/playback/…`) |

### Leak protection

Every response body and redirect passing through the key proxy has every
occurrence of the master origin rewritten to route back through the gate:

- `https://master/stremio/<uuid>/<pass>/…` → `https://gate/go/<key>/…`
- `https://master/anything/else/…` → `https://gate/go/<key>/raw/anything/else/…`
- relative redirects (`Location: /foo`) → `https://gate/go/<key>/raw/foo`

The gate additionally rewrites `BASE_URL` and the internal URL, so
native-usenet playback links (built by AIOStreams from its `BASE_URL`) stay
inside the gate too. Direct debrid CDN URLs (TorBox etc.) pass through
untouched — exactly like your current child-profile setup.

Two surfaces are never proxied by the key proxy: `/go/<key>/configure` and
anything ending in `/configure` (a polite "managed by your provider" page), and
invalid keys (404 / 403 when paused / 410 when revoked or expired).

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `MASTER_URL` | — (recommended) | Master AIOStreams manifest URL. **Can also be set from the panel (Settings)** — the panel value overrides this env fallback; the gate boots fine without it (banner until configured) |
| `AIOSTREAMS_INTERNAL_URL` | `http://127.0.0.1:3210` | Internal AIOStreams URL. Bundled mode is the only mode — the root namespace is an admin-gated transparent proxy to this URL |
| `AIOSTREAMS_INTERNAL_PORT` | `3210` | Internal port AIOStreams binds inside the container (used by `docker/start.sh`; also the default internal URL above) |
| `ADMIN_PASSWORD` | first `AIOSTREAMS_AUTH` pair | Gate admin password |
| `ADMIN_USERNAME` | `admin` (or first `AIOSTREAMS_AUTH` user) | Gate admin username |
| `SESSION_SECRET` | derived from password | HMAC key for session cookies |
| `PUBLIC_BASE` | request host | Public base URL of the gate, used to build shareable key URLs. **Can also be set from the panel (Settings)** — panel value wins over this env fallback |
| `PORT` | `3000` | Gate listen port (the only published port) |
| `HOST` | `0.0.0.0` | Listen address |
| `DATA_FILE` | `<cwd>/data/keys.json` | Keys database (container sets `/app/data/keys.json`) |
| `REWRITE_ORIGINS` | master origin (+`BASE_URL`/internal) | Extra origins to rewrite to the gate |
| `TRUST_PROXY` | `0` | Honor `X-Forwarded-Proto`/`Host` (only behind a trusted proxy) |
| `KEY_LENGTH` | `12` | Key id length in characters (8–32) |
| `HISTORY_RETENTION_DAYS` | `30` | How long each key's watch history is kept before it is pruned (1–365) |
| `HISTORY_MAX_PER_KEY` | `2000` | Max watch-history entries kept per key (newest win; safety cap) |

## Panel settings

`MASTER_URL` and `PUBLIC_BASE` don't have to be env vars. The panel's
**Settings** tab edits both at runtime (stored in `keys.json` next to your
keys; the env vars become fallback defaults):

- **Master manifest URL** — the single AIOStreams config every key proxies to.
  A **Test connection** button probes the candidate URL's manifest before you
  save.
- **Public base URL** — controls the shareable key URLs and rewrites.
- Leaving a field empty removes the override and falls back to the env var
  (or, for the base URL, the request host).

The gate also boots fine with **no** `MASTER_URL` at all — the dashboard shows
an amber banner until you set one in Settings, and `/go` requests return a
clear 503 in the meantime.

## Per-key page & watch history

Click **Manage** on any key row to open that key's page — every key has its
own URL under the panel (`/panel/<label>`, e.g. `/panel/Test`; duplicate
labels get `-2`, `-3`, … suffixes). The page shows the key's URL (with a copy
button), usage stats, and all controls — pause/resume, edit, revoke, delete —
instead of cluttering the dashboard table.

The same page shows a **Watch history** table: every time Stremio asks the key
for streams (`/go/<key>/stream/<type>/<id>.json`), the gate logs the type
(movie/series/channel), the media id, a best-effort title (resolved from the
master's `meta` catalog, cached), bytes served and IP. Series episodes get
`SxxExx` + episode name when the master's meta includes them, so rows read
"Breaking Bad · S01E02 Pilot" instead of `tt12042730`. Entries recorded while
the master wasn't configured get one automatic retry the next time the page is
opened. Manifest loads, catalog browsing and playback segments are **not**
recorded, so the list is "what did this person actually try to watch", not a
request dump.

Logs are pruned automatically — entries older than `HISTORY_RETENTION_DAYS`
(default **30 days**) are deleted on boot, every 6h, and after each new entry
(a per-key safety cap of `HISTORY_MAX_PER_KEY`, default 2000, applies too).
Deleting a key deletes its history with it.

## Local tests

```bash
sh test/run.sh
```

Starts a fake AIOStreams master (with a mock panel surface) and the gate in
its single bundled layout: the core suite (key proxy, admin API, settings,
watch history, per-key page URLs) plus the AIOStreams-surface suite (admin
gating, cookie round-trips, root landing on `/panel/`).

## Deployment notes

- Put it behind TLS (Caddy/Traefik/nginx) with `PUBLIC_BASE` set to the public
  HTTPS URL. `docker compose` already mounts `./data:/app/data` — back it up.
- The admin panel is the crown jewels: it now gates the entire AIOStreams
  surface too, so use a strong password (it defaults to your
  `AIOSTREAMS_AUTH` password).
- Your friends share your one master's debrid/rate limits — same tradeoff as
  today, just with one config instead of N.

## Security model (what it is / isn't)

- **The master URL never reaches key holders.** Verified against real
  AIOStreams responses: stream JSON, playlists, redirects and playback links
  are rewritten through the gate; even error responses don't leak the internal
  address.
- **It does not hide the debrid CDN.** Direct TorBox/debrid playback URLs are
  returned as-is (identical to your current setup) — a key holder could in
  principle copy a live playback URL. A key switch still kills the addon
  instantly.
- **The AIOStreams panel is hidden behind gate auth** — but AIOStreams' own
  login session (once you're in) is its own trust boundary, same as any
  deployment.
- It's an access-management tool for your own instance, not an
  anti-piracy measure.

## License

MIT
