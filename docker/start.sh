#!/bin/sh
# aio-gate + AIOStreams single container.
# AIOStreams binds the internal port (unpublished); aio-gate owns the
# public port and admin-gates the whole AIOStreams surface.

set -e

# distroless image keeps node at /nodejs/bin/node (not on PATH)
if [ -x /nodejs/bin/node ]; then
  NODE_BIN=/nodejs/bin/node
else
  NODE_BIN=node
fi

AIOSTREAMS_INTERNAL_PORT="${AIOSTREAMS_INTERNAL_PORT:-3210}"
export AIOSTREAMS_INTERNAL_URL="${AIOSTREAMS_INTERNAL_URL:-http://127.0.0.1:${AIOSTREAMS_INTERNAL_PORT}}"
PUBLIC_PORT="${PORT:-3000}"

echo "[start] launching AIOStreams on :${AIOSTREAMS_INTERNAL_PORT}"
PORT="${AIOSTREAMS_INTERNAL_PORT}" "$NODE_BIN" /app/packages/server/dist/server.js &
AIO_PID=$!

echo "[start] waiting for AIOStreams to become ready..."
ready=0
i=0
while [ "$i" -lt 60 ]; do
  if wget -q -O /dev/null "http://127.0.0.1:${AIOSTREAMS_INTERNAL_PORT}/api/v1/status" 2>/dev/null; then
    ready=1
    break
  fi
  i=$((i + 1))
  sleep 1
done
if [ "$ready" != "1" ]; then
  echo "[start] WARNING: AIOStreams did not become ready in time, starting gate anyway"
fi

echo "[start] launching aio-gate on :${PUBLIC_PORT}"
PORT="${PUBLIC_PORT}" "$NODE_BIN" /app/gate/server.js &
GATE_PID=$!

trap 'echo "[start] stopping"; kill $AIO_PID $GATE_PID 2>/dev/null || true' TERM INT
wait
