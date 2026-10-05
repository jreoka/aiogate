# aio-gate bundled with AIOStreams — one container, one volume.
#
# Base: the official AIOStreams image (distroless node24, WORKDIR /app,
# data at /app/data).
#
# Pinned to an explicit version on purpose. `:latest` is rebuilt nightly, so a
# floating tag makes every rebuild silently pull an untested upstream release --
# and AIOStreams migrates the SQLite database on startup, so an unexpected bump
# can rewrite data on the volume without warning. Bump this deliberately: read
# the upstream CHANGELOG, back up /app/data/db.sqlite, and watch the startup
# logs for migration errors.
#
# Last updated 2026-10-02: 2.34.1 -> 2.35.7. Migrations 0028-0040 are new
# (append-only; no existing migration was renamed, so AIOStreams' "refuse a
# database migrated by a different build" guard does not trip).
FROM ghcr.io/viren070/aiostreams:v2.35.9

# We layer the gate on top and run both processes:
#   AIOStreams  -> 127.0.0.1:3210  (internal, unpublished)
#   aio-gate    -> 0.0.0.0:3000    (the only published port)
#
# The gate owns the whole public root namespace: /go/<key>/... for your
# friends, /panel/ for key administration, and an admin-gated transparent
# proxy for the AIOStreams panel (so it is never publicly reachable).

WORKDIR /app

COPY package.json /app/gate/package.json
COPY server.js /app/gate/server.js
COPY public /app/gate/public
COPY docker/start.sh /app/start.sh
# start.sh comes from the host checkout and may carry Windows CRLF line
# endings (git autocrlf on Windows). Normalize it to LF at build time.
# The base image ships no sed/tr, so use the bundled node to rewrite the
# file; this is a no-op when it already uses LF endings.
RUN /nodejs/bin/node -e "const fs = require('fs'); \
  const p = '/app/start.sh'; \
  const s = fs.readFileSync(p, 'utf8'); \
  if (s.includes('\r')) { \
    fs.writeFileSync(p, s.replace(/\r/g, '')); \
    console.log('start.sh: converted CRLF to LF'); \
  }"
# Data for both apps lives under /app/data (mount a volume here).
ENV DATA_FILE=/app/data/keys.json \
    AIOSTREAMS_INTERNAL_URL=http://127.0.0.1:3210

EXPOSE 3000

# Override the inherited healthcheck so it probes the gate, which in turn
# reports the bundled AIOStreams status.
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-3000}/healthz" || exit 1

# The published image sets ENTRYPOINT=["/nodejs/bin/node"] with the server
# path as CMD. We clear the entrypoint so our shell script can supervise both
# processes.
ENTRYPOINT []

CMD ["/bin/sh", "/app/start.sh"]
