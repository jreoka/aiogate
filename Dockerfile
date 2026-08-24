# aio-gate bundled with AIOStreams — one container, one volume.
#
# Base: the official AIOStreams image (distroless node24, WORKDIR /app,
# data at /app/data). We layer the gate on top and run both processes:
#   AIOStreams  -> 127.0.0.1:3210  (internal, unpublished)
#   aio-gate    -> 0.0.0.0:3000    (the only published port)
#
# The gate owns the whole public root namespace: /go/<key>/... for your
# friends, /panel/ for key administration, and an admin-gated transparent
# proxy for the AIOStreams panel (so it is never publicly reachable).

FROM ghcr.io/viren070/aiostreams:latest

WORKDIR /app

COPY package.json /app/gate/package.json
COPY server.js /app/gate/server.js
COPY public /app/gate/public
COPY docker/start.sh /app/start.sh

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
