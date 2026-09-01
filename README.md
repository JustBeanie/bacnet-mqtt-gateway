# BACnet MQTT Gateway

Bridge BACnet/IP building-automation devices into MQTT and Home Assistant.

This repository holds the **application source and the container build**. It is
a fork of [`novatechflow/bacnet-mqtt-gateway`](https://github.com/novatechflow/bacnet-mqtt-gateway),
rebased on upstream commit `6e4aed4c` and reworked to run as a Home Assistant
OS app image.

The app provides:

- BACnet/IP discovery, polling, property writes, and per-device configuration.
- MQTT telemetry, availability, command handling, and Home Assistant discovery.
- An administrator-only web console through Home Assistant ingress.
- Automatic use of the Supervisor MQTT service or an independently hosted MQTT
  broker, including TLS and client-certificate support.
- Persistent runtime state in the app data volume and device configuration in
  the app-specific configuration directory.

BACnet broadcast traffic requires host networking. The web console itself only
accepts Home Assistant ingress traffic.

## Where the pieces live

| Concern | Repository |
| --- | --- |
| Application source, tests, `Dockerfile`, `run.sh` | this repository |
| Published images | `ghcr.io/justbeanie/bacnet-mqtt-gateway-{amd64,aarch64}` |
| App manifest (`config.yaml`), options schema, translations, AppArmor profile, user documentation | [`JustBeanie/ha-addons`](https://github.com/JustBeanie/ha-addons/tree/main/bacnet_mqtt_gateway) |

Home Assistant installs the app from the `ha-addons` store repository, which
declares `image:` and pulls the tag matching its `version:`. Nothing is built on
the Home Assistant host.

## Releasing

1. Bump `version` in `package.json` (and the `ARG BUILD_VERSION` default in
   `Dockerfile`).
2. Merge to `master` and let CI pass.
3. Tag `v<version>` and push the tag. The release workflow verifies the tag
   matches `package.json`, then builds and pushes both architectures.
4. Bump `version:` in `ha-addons/bacnet_mqtt_gateway/config.yaml` to the same
   value and add a `CHANGELOG.md` entry there. Its CI refuses a version with no
   published image.

## Local development

```bash
npm ci
npm test
npm run test:coverage
```

Jest coverage thresholds are enforced in `package.json`.

Install and configuration documentation for Home Assistant users lives in the
app's `DOCS.md` in the `ha-addons` repository. Upstream's own documentation is
kept verbatim in [`UPSTREAM.md`](UPSTREAM.md).
