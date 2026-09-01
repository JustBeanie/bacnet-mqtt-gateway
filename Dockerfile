FROM ghcr.io/home-assistant/base:3.22

ARG BUILD_VERSION=2.0.2
ARG BUILD_ARCH

ENV NODE_ENV=production \
    NODE_CONFIG_DIR=/opt/bacnet-mqtt-gateway/config \
    APP_VERSION=${BUILD_VERSION} \
    SCARF_ANALYTICS=false

WORKDIR /opt/bacnet-mqtt-gateway

COPY package.json package-lock.json ./

RUN apk add --no-cache \
        nodejs \
        npm \
        sqlite-libs \
    && apk add --no-cache --virtual .build-dependencies \
        g++ \
        linux-headers \
        make \
        python3 \
    && npm ci --omit=dev --no-audit --no-fund \
    && node -e "require('sqlite3'); require('bacstack'); require('mqtt'); require('express')" \
    && npm cache clean --force \
    && apk del .build-dependencies

COPY config ./config
COPY scripts ./scripts
COPY src ./src
COPY web ./web
COPY LICENSE openapi.yaml device.example.json ./
COPY run.sh /run.sh

RUN chmod 0755 /run.sh

LABEL \
    io.hass.version="${BUILD_VERSION}" \
    io.hass.type="app" \
    io.hass.arch="${BUILD_ARCH}" \
    org.opencontainers.image.title="BACnet MQTT Gateway" \
    org.opencontainers.image.description="BACnet/IP to MQTT gateway for Home Assistant" \
    org.opencontainers.image.source="https://github.com/JustBeanie/bacnet-mqtt-gateway" \
    org.opencontainers.image.licenses="Apache-2.0" \
    org.opencontainers.image.version="${BUILD_VERSION}"

# Replaces the manifest's obsolete `watchdog:` key. server.js exempts loopback
# requests to /health from the ingress source restriction for exactly this, and
# the endpoint answers 200 whenever the process is serving, so this probe means
# "the listener is up" - the same thing the Supervisor watchdog checked.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "-e", "require('http').get('http://127.0.0.1:18082/health',(r)=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]

CMD ["/run.sh"]
