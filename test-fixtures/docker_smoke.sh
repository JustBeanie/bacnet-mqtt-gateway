#!/bin/sh
set -eu

app_root="${1:?usage: docker_smoke.sh APP_ROOT [IMAGE]}"
app_image="${2:-local/bacnet-mqtt-gateway:amd64}"
app_container="bacnet-smoke-app-$$"
supervisor_container="bacnet-smoke-supervisor-$$"
mqtt_container="bacnet-smoke-mqtt-$$"
availability_topic="bacnet-gateway/container-smoke/status"

cleanup() {
    docker rm --force "${app_container}" "${mqtt_container}" "${supervisor_container}" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# Use one isolated network namespace so the fixtures can use loopback.
docker run --detach --name "${supervisor_container}" --network none \
    --entrypoint node \
    --mount "type=bind,source=${app_root}/test-fixtures/mock_supervisor.js,target=/tmp/mock_supervisor.js,readonly" \
    --mount "type=bind,source=${app_root}/__tests__/fixtures/options.supervisor.json,target=/tmp/options.supervisor.json,readonly" \
    --mount "type=bind,source=${app_root}/__tests__/fixtures/service.mqtt.json,target=/tmp/service.mqtt.json,readonly" \
    "${app_image}" /tmp/mock_supervisor.js /tmp/options.supervisor.json 18083 /tmp/service.mqtt.json \
    >/dev/null

docker run --detach --name "${mqtt_container}" --network "container:${supervisor_container}" \
    --mount "type=bind,source=${app_root}/test-fixtures/mosquitto.conf,target=/mosquitto/config/mosquitto.conf,readonly" \
    eclipse-mosquitto:2 >/dev/null

docker run --detach --name "${app_container}" --network "container:${supervisor_container}" \
    --env SUPERVISOR_API=http://127.0.0.1:18083 \
    --env SUPERVISOR_TOKEN=smoke-test \
    "${app_image}" >/dev/null

wait_for_health() {
    expected="$1"
    attempt=0
    while [ "${attempt}" -lt 30 ]; do
        health="$(docker exec "${app_container}" wget -qO- http://127.0.0.1:18082/health 2>/dev/null || true)"
        if printf '%s' "${health}" | grep -q "\"connected\":${expected}"; then
            return
        fi
        attempt=$((attempt + 1))
        sleep 1
    done
    docker logs "${app_container}" >&2 || true
    echo "Gateway did not report MQTT connected=${expected} within 30 seconds" >&2
    return 1
}

check_availability() {
    actual="$(docker exec "${mqtt_container}" mosquitto_sub -h 127.0.0.1 -p 65530 -W 5 -C 1 -t "${availability_topic}")"
    if [ "${actual}" != "$1" ]; then
        echo "Expected retained availability $1, got ${actual}" >&2
        return 1
    fi
}

wait_for_health true
check_availability online
docker stop "${mqtt_container}" >/dev/null
wait_for_health false
docker start "${mqtt_container}" >/dev/null
wait_for_health true
check_availability online
docker stop --timeout 12 "${app_container}" >/dev/null
check_availability offline
docker start "${app_container}" >/dev/null
wait_for_health true
check_availability online
if docker logs "${app_container}" 2>&1 | grep -q 'redacted-test-password'; then
    echo "Gateway logs exposed the test MQTT password" >&2
    exit 1
fi
printf '%s\n' "${health}"
