#!/bin/sh
# Run the mock AIOStreams + the gate (bundled — the only mode) + e2e tests.
set -e
cd "$(dirname "$0")/.."

echo "== starting mock AIOStreams on :3900 =="
node test/mock-master.js &
MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null || true' EXIT
sleep 0.6

echo "== starting aio-gate (bundled) on :8085 =="
MASTER_URL="http://127.0.0.1:3900/stremio/u/dill-alias/manifest.json" \
AIOSTREAMS_INTERNAL_URL="http://127.0.0.1:3900" \
BASE_URL="https://stream.dill.moe" \
PUBLIC_BASE="http://127.0.0.1:8085" \
ADMIN_USERNAME="admin" \
ADMIN_PASSWORD="test-pw" \
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

echo "== stopping =="
kill $GATE_PID $MOCK_PID 2>/dev/null || true
rm -f test/data-test.json
echo done
