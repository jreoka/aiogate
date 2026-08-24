#!/bin/sh
# Run the mock master + gate (standalone AND bundled) + end-to-end tests.
set -e
cd "$(dirname "$0")/.."

echo "== starting mock master on :3900 =="
node test/mock-master.js &
MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null || true' EXIT
sleep 0.6

echo "== starting aio-gate (standalone) on :8081 =="
MASTER_URL="http://127.0.0.1:3900/stremio/abcdef1234567890/testpassword123/manifest.json" \
ADMIN_USERNAME="admin" \
ADMIN_PASSWORD="test-pw" \
PORT=8081 \
DATA_FILE="$(pwd)/test/data-test.json" \
node server.js &
GATE1_PID=$!
sleep 1

echo "== running standalone tests =="
node test/test.js

echo "== starting aio-gate (bundled) on :8085 =="
MASTER_URL="http://127.0.0.1:3900/stremio/abcdef1234567890/testpassword123/manifest.json" \
AIOSTREAMS_INTERNAL_URL="http://127.0.0.1:3900" \
BASE_URL="https://stream.dill.moe" \
PUBLIC_BASE="http://127.0.0.1:8085" \
ADMIN_USERNAME="admin" \
ADMIN_PASSWORD="test-pw" \
PORT=8085 \
DATA_FILE="$(pwd)/test/data-bundled.json" \
node server.js &
GATE2_PID=$!
sleep 1

echo "== running bundled tests =="
node test/test-bundled.js

echo "== stopping =="
kill $GATE1_PID $GATE2_PID $MOCK_PID 2>/dev/null || true
rm -f test/data-test.json test/data-bundled.json
echo done
