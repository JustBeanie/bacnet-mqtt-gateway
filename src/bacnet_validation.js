function integer(value, min, max) {
    const number = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
    return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
}

function isDeviceId(value) {
    return (typeof value === 'string' || Number.isSafeInteger(value)) && /^[A-Za-z0-9_-]+$/.test(String(value));
}

function isRecord(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validateDeviceConfig(config, { requirePolling = false } = {}) {
    const errors = [];
    const { device, objects, polling } = config || {};
    if (!isDeviceId(device?.deviceId) || typeof device.address !== 'string' || !device.address.trim()) {
        errors.push('device.deviceId and device.address are required.');
    }
    if (polling === undefined ? requirePolling : !isRecord(polling)) {
        errors.push('polling configuration is required.');
    } else if (polling) {
        if (requirePolling && !polling.schedule && !polling.intervalMs && !polling.class) {
            errors.push('polling.schedule, polling.intervalMs, or polling.class is required.');
        }
        if (polling.schedule != null && typeof polling.schedule !== 'string') {
            errors.push('polling.schedule must be a cron expression.');
        }
        if (polling.class !== undefined && (typeof polling.class !== 'string' || !polling.class.trim())) {
            errors.push('polling.class must be a non-empty string.');
        }
        for (const [field, min] of [['intervalMs', 1], ['freshnessMs', 1], ['jitterMs', 0]]) {
            if (polling[field] !== undefined && integer(polling[field], min, Number.MAX_SAFE_INTEGER) === null) {
                errors.push(`polling.${field} must be an integer greater than or equal to ${min}.`);
            }
        }
    }
    if (!Array.isArray(objects) || (requirePolling && objects.length === 0)) {
        errors.push('objects must be an array of BACnet object IDs.');
    } else {
        objects.forEach((object, index) => {
            const objectId = object?.objectId;
            if (!objectId || integer(objectId.type, 0, 1023) === null || integer(objectId.instance, 0, 4194303) === null) {
                errors.push(`objects[${index}].objectId must have a valid type and instance.`);
            }
        });
    }
    return errors;
}

function parseWriteCommand(body = {}) {
    const { deviceId, value } = body || {};
    const objectType = integer(body?.objectType, 0, 1023);
    const objectInstance = integer(body?.objectInstance, 0, 4194303);
    const propertyId = integer(body?.propertyId, 0, 4194303);
    const priority = body?.priority === undefined ? undefined : integer(body.priority, 1, 16);
    const bacnetApplicationTag = body?.bacnetApplicationTag === undefined
        ? undefined
        : integer(body.bacnetApplicationTag, 0, 255);
    if (!isDeviceId(deviceId) || objectType === null || objectInstance === null || propertyId === null) {
        throw new Error('A valid deviceId, objectType, objectInstance, and propertyId are required.');
    }
    if (priority === null || bacnetApplicationTag === null) {
        throw new Error('Priority must be an integer from 1 to 16 and BACnet application tag must be numeric.');
    }
    if (!(typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value)
        || (value === null && bacnetApplicationTag === 0))) {
        throw new Error('A string, number, boolean, or explicitly tagged BACnet null is required.');
    }

    return { deviceId, objectType, objectInstance, propertyId, value, priority, bacnetApplicationTag };
}

module.exports = { validateDeviceConfig, parseWriteCommand };
