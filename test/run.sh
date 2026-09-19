#!/bin/sh
# Run the mock AIOStreams + the gate (bundled — the only mode) + e2e tests.
set -e
cd "$(dirname "$0")/.."

echo "== starting mock AIOStreams on :3900 =="
node test/mock-master.js &
MOCK_PID=$!
trap 'kill $MOCK_PID $GATE_PID $SESSIONS_GATE_PID 2>/dev/null || true' EXIT
sleep 0.6

echo "== starting aio-gate (bundled) on :8085 =="
MASTER_URL="http://127.0.0.1:3900/stremio/u/dill-alias/manifest.json" \
AIOSTREAMS_INTERNAL_URL="http://127.0.0.1:3900" \
BASE_URL="http://127.0.0.1:8085" \
ADMIN_USERNAME="admin" \
ADMIN_PASSWORD="test-pw" \
IMDB_SUGGEST_URL="http://127.0.0.1:3900" \
PORT=8085 \
DATA_FILE="$(pwd)/test/data-test.json" \
node server.js &
GATE_PID=$!
sleep 1

echo "== running gate core tests =="
node test/test.js

echo "== running AIOStreams-surface tests =="
node test/test-bundled.js

echo "== running watch-history title retry test =="
node test/retry-check.js

# Sessions + 2FA need a clean slate, so they get their own gate instance
# (fresh data file) on :8086.
echo "== running admin sessions + 2FA test =="
rm -f test/data-sessions.json
ADMIN_USERNAME="admin" \
ADMIN_PASSWORD="test-pw" \
PORT=8086 \
DATA_FILE="$(pwd)/test/data-sessions.json" \
node server.js &
SESSIONS_GATE_PID=$!
sleep 0.8
node test/sessions-2fa-check.js
kill $SESSIONS_GATE_PID 2>/dev/null || true
SESSIONS_GATE_PID=""
rm -f test/data-sessions.json

# The origin lock needs its own gate instance (fresh data file) on :8088 —
# ALLOWED_ORIGIN is the gate's own public URL, as in a real deployment.
echo "== running ALLOWED_ORIGIN host/origin-lock test =="
rm -f test/data-origin.json
MASTER_URL="http://127.0.0.1:3900/stremio/u/dill-alias/manifest.json" \
AIOSTREAMS_INTERNAL_URL="http://127.0.0.1:3900" \
BASE_URL="http://127.0.0.1:8088" \
ALLOWED_ORIGIN="http://127.0.0.1:8088" \
ADMIN_USERNAME="admin" \
ADMIN_PASSWORD="test-pw" \
IMDB_SUGGEST_URL="http://127.0.0.1:3900" \
PORT=8088 \
DATA_FILE="$(pwd)/test/data-origin.json" \
node server.js &
ORIGIN_GATE_PID=$!
trap 'kill $MOCK_PID $GATE_PID $SESSIONS_GATE_PID $ORIGIN_GATE_PID 2>/dev/null || true' EXIT
sleep 1
node test/origin-check.js
kill $ORIGIN_GATE_PID 2>/dev/null || true
ORIGIN_GATE_PID=""
rm -f test/data-origin.json

echo "== stopping =="
kill $GATE_PID $MOCK_PID 2>/dev/null || true
rm -f test/data-test.json
echo done
