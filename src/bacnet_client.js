const bacnet = require('bacstack');
const config = require('config');
const { scheduleJob } = require('node-schedule');
const { EventEmitter } = require('events');
const { BacnetConfig } = require('./bacnet_config');
const { DeviceObjectId, DeviceObject, logger } = require('./common');
const { RuntimeState } = require('./runtime_state');
const { BacnetRequests, BacnetUnavailableError } = require('./bacnet_requests');
const { validateDeviceConfig } = require('./bacnet_validation');

const { PropertyIdentifier: Property, ObjectType, ApplicationTags } = bacnet.enum;
const MAX_ACTIVE_SCANS = 16;
const MAX_DISCOVERY_OBJECTS = 10000;

class BacnetClient extends EventEmitter {
    constructor(options = {}) {
        super();
        this.requestOptions = this._loadRequestOptions();
        this.client = options.client || new bacnet(this._loadClientOptions());
        this.deviceConfigs = new Map();
        this.deviceRuntime = new Map();
        this.schedules = new Map();
        this.queue = [];
        this.queuedDevices = new Set();
        this.inFlightDevices = new Set();
        this.deviceUpdates = new Map();
        this.polls = new Set();
        this.scans = new Map();
        this.requests = new BacnetRequests();
        this.activePolls = 0;
        this.closing = false;

        this.globalConcurrency = this._loadIntegerOption('polling.globalConcurrency', 2);
        this.objectConcurrency = this._loadIntegerOption('polling.objectConcurrency', 4);
        this.schedulerTickMs = this._loadIntegerOption('polling.schedulerTickMs', 1000);
        this.defaultFreshnessMs = this._loadIntegerOption('polling.defaultFreshnessMs', 30000);
        this.failureThreshold = this._loadIntegerOption('polling.failureThreshold', 3);
        this.baseBackoffMs = this._loadIntegerOption('polling.baseBackoffMs', 5000);
        this.maxBackoffMs = this._loadIntegerOption('polling.maxBackoffMs', 120000);
        this.discoveryRetries = this._loadIntegerOption('bacnet.discoveryRetries', 2, 0);

        this.metrics = {
            totalPolls: 0,
            successfulPolls: 0,
            failedPolls: 0,
            totalObjectsRead: 0,
            totalObjectFailures: 0,
            totalPollDurationMs: 0,
            lastPollAt: null,
            queueHighWaterMark: 0
        };

        this.runtimeState = options.runtimeState || new RuntimeState();
        this.bacnetConfig = options.bacnetConfig || new BacnetConfig();

        this.onDeviceFound = (device) => {
            if (!this.closing) this.emit('deviceFound', device);
        };
        this.onTransportError = (error) => logger.log('error', `[BACnet] Transport error: ${error.message}`);
        this.client.on('iAm', this.onDeviceFound);
        this.client.on('error', this.onTransportError);

        this.onConfigLoaded = (deviceConfig) => this._registerDeviceConfig(deviceConfig).catch((error) => {
            if (!this.closing) logger.log('error', `[Polling] Failed to register config: ${error.message}`);
        });
        this.schedulerHandle = null;
        this.closePromise = null;
        this.ready = this._init();
    }

    async _init() {
        await this.runtimeState.init();
        if (this.closing) return;

        // The loader awaits its listeners, so readiness includes every registration.
        this.bacnetConfig.on('configLoaded', this.onConfigLoaded);
        await this.bacnetConfig.load();
        if (!this.closing) {
            this.schedulerHandle = setInterval(() => {
                this._schedulerLoop().catch((error) => logger.log('error', `[Polling] Scheduler failed: ${error.message}`));
            }, this.schedulerTickMs);
        }
    }

    _loadRequestOptions() {
        const options = {};
        if (config.has('bacnet.maxSegments')) {
            const maxSegments = parseInt(config.get('bacnet.maxSegments'), 10);
            if (!Number.isNaN(maxSegments)) {
                options.maxSegments = maxSegments;
            }
        }
        if (config.has('bacnet.maxApdu')) {
            const maxApdu = parseInt(config.get('bacnet.maxApdu'), 10);
            if (!Number.isNaN(maxApdu)) {
                options.maxApdu = maxApdu;
            }
        }
        return options;
    }

    _loadClientOptions() {
        const options = {
            apduTimeout: this._loadIntegerOption('bacnet.apduTimeout', 10000),
            port: this._loadIntegerOption('bacnet.port', 47808)
        };
        if (config.has('bacnet.interface')) {
            options.interface = config.get('bacnet.interface');
        }
        if (config.has('bacnet.broadcastAddress')) {
            options.broadcastAddress = config.get('bacnet.broadcastAddress');
        }
        return options;
    }

    _buildRequestOptions(priority) {
        const options = { ...this.requestOptions };
        if (priority !== undefined) {
            options.priority = priority;
        }
        return options;
    }

    _loadIntegerOption(path, fallback, minimum = 1) {
        const value = config.has(path) ? Number(config.get(path)) : fallback;
        return Number.isSafeInteger(value) && value >= minimum ? value : fallback;
    }

    _withDeviceUpdate(deviceId, update) {
        const previous = this.deviceUpdates.get(deviceId) || Promise.resolve();
        const pending = previous.catch(() => {}).then(update).finally(() => {
            if (this.deviceUpdates.get(deviceId) === pending) this.deviceUpdates.delete(deviceId);
        });
        this.deviceUpdates.set(deviceId, pending);
        return pending;
    }

    async _registerDeviceConfig(deviceConfig, persist = false) {
        if (this.closing) throw new BacnetUnavailableError('BACnet client is closing');
        const errors = validateDeviceConfig(deviceConfig);
        if (errors.length > 0) throw new TypeError(errors.join(' '));

        deviceConfig = structuredClone(deviceConfig);
        const deviceId = String(deviceConfig.device.deviceId);
        return this._withDeviceUpdate(deviceId, async () => {
            if (this.closing) throw new BacnetUnavailableError('BACnet client is closing');
            const previous = this.deviceRuntime.get(deviceId);
            const runtime = this._createRuntime(deviceConfig);
            const job = this._prepareSchedule(runtime);

            try {
                if (persist) await this.bacnetConfig.save(deviceConfig);
            } catch (error) {
                job?.cancel();
                throw error;
            }

            this.schedules.get(deviceId)?.cancel();
            this.schedules.delete(deviceId);
            if (job && !this.closing) this.schedules.set(deviceId, job);
            else job?.cancel();

            this.deviceConfigs.set(deviceId, deviceConfig);
            this.deviceRuntime.set(deviceId, runtime);
            const keys = runtime.objects.map(({ objectId }) => this._objectKey(objectId));
            const addressChanged = previous && previous.address !== runtime.address;
            runtime.pruneKeys = addressChanged ? [] : keys;
            this.emit('configChanged', deviceId, runtime.pruneKeys);
            await this._syncRuntimeConfig(runtime).catch((error) => {
                // The config file is authoritative. Retry the derived SQLite update on the next poll.
                logger.log('error', `[Polling] Failed to sync device ${deviceId}: ${error.message}`);
            });
        });
    }

    async _syncRuntimeConfig(runtime) {
        if (!runtime.pruneKeys) return;
        if (!runtime.checkedStoredAddress && this.runtimeState.getDeviceState) {
            const stored = await this.runtimeState.getDeviceState(runtime.deviceId);
            if (stored?.address && stored.address !== runtime.address) runtime.pruneKeys = [];
            runtime.checkedStoredAddress = true;
        }
        await this.runtimeState.pruneDeviceObjects?.(runtime.deviceId, runtime.pruneKeys);
        await this.runtimeState.upsertDeviceState(this._serializeRuntime(runtime));
        runtime.pruneKeys = null;
    }

    _objectKey({ type, instance }) {
        return `${Number(type)}_${Number(instance)}`;
    }

    _normalizePolling(polling = {}) {
        const normalized = { ...polling };
        normalized.class = polling.class || 'normal';
        normalized.intervalMs = this._resolveIntervalMs(polling);
        normalized.freshnessMs = parseInt(polling.freshnessMs || normalized.intervalMs * 2 || this.defaultFreshnessMs, 10);
        normalized.schedule = polling.schedule || null;
        normalized.jitterMs = parseInt(polling.jitterMs || 0, 10);
        return normalized;
    }

    _resolveIntervalMs(polling = {}) {
        if (polling.intervalMs) {
            return parseInt(polling.intervalMs, 10);
        }
        const classIntervals = config.has('polling.classIntervals')
            ? config.get('polling.classIntervals')
            : { fast: 5000, normal: 15000, slow: 60000 };
        return parseInt(classIntervals[polling.class || 'normal'] || classIntervals.normal || 15000, 10);
    }

    _createRuntime({ device, polling, objects }) {
        const settings = this._normalizePolling(polling);
        return {
            deviceId: String(device.deviceId),
            address: device.address,
            pollClass: settings.class,
            schedule: settings.schedule,
            nextDueAt: Date.now() + Math.floor(Math.random() * settings.jitterMs),
            nextEligiblePollAt: Date.now(),
            consecutiveFailures: 0,
            circuitState: 'closed',
            lastAttemptAt: null,
            lastSuccessAt: null,
            lastDurationMs: null,
            lastError: null,
            cronDue: false,
            objects,
            polling: settings,
            unsupportedUnits: new Set()
        };
    }

    _serializeRuntime(runtime) {
        return {
            deviceId: runtime.deviceId,
            address: runtime.address,
            pollClass: runtime.pollClass,
            schedule: runtime.schedule,
            circuitState: runtime.circuitState,
            consecutiveFailures: runtime.consecutiveFailures,
            lastError: runtime.lastError,
            lastAttemptAt: runtime.lastAttemptAt,
            lastSuccessAt: runtime.lastSuccessAt,
            lastDurationMs: runtime.lastDurationMs,
            nextEligiblePollAt: runtime.nextEligiblePollAt
        };
    }

    _prepareSchedule(runtime) {
        if (!runtime.schedule) return null;
        const job = scheduleJob(runtime.schedule, () => { runtime.cronDue = true; });
        if (!job) throw new TypeError('polling.schedule must be a valid cron expression.');
        return job;
    }

    async _schedulerLoop() {
        await this.ready;
        if (this.closing) {
            return;
        }
        const now = Date.now();
        for (const [deviceId, runtime] of this.deviceRuntime.entries()) {
            if (!runtime.objects || runtime.objects.length === 0) {
                continue;
            }
            if (this.queuedDevices.has(deviceId) || this.inFlightDevices.has(deviceId)) {
                continue;
            }
            if (runtime.nextEligiblePollAt && runtime.nextEligiblePollAt > now) {
                continue;
            }

            const dueBySchedule = runtime.schedule ? runtime.cronDue === true : runtime.nextDueAt <= now;
            if (!dueBySchedule) {
                continue;
            }

            runtime.cronDue = false;
            if (!runtime.schedule) {
                runtime.nextDueAt = now + runtime.polling.intervalMs;
            }
            this.queue.push(deviceId);
            this.queuedDevices.add(deviceId);
            this.metrics.queueHighWaterMark = Math.max(this.metrics.queueHighWaterMark, this.queue.length);
        }

        await this._drainQueue();
    }

    async _drainQueue() {
        if (this.closing) {
            this.queue.length = 0;
            this.queuedDevices.clear();
            return;
        }
        while (this.activePolls < this.globalConcurrency && this.queue.length > 0) {
            const deviceId = this.queue.shift();
            this.queuedDevices.delete(deviceId);
            if (this.inFlightDevices.has(deviceId)) {
                continue;
            }
            this.inFlightDevices.add(deviceId);
            this.activePolls += 1;
            const poll = this._pollDevice(deviceId)
                .catch((error) => logger.log('error', `[Polling] Device poll failed for ${deviceId}: ${error.message}`))
                .finally(() => {
                    this.polls.delete(poll);
                    this.inFlightDevices.delete(deviceId);
                    this.activePolls -= 1;
                    if (!this.closing && this.queue.length > 0) {
                        return this._drainQueue().catch((error) => logger.log('error', `[Polling] Queue drain failed: ${error.message}`));
                    }
                });
            this.polls.add(poll);
        }
    }

    async _pollDevice(deviceId) {
        const deviceConfig = this.deviceConfigs.get(deviceId);
        const runtime = this.deviceRuntime.get(deviceId);
        if (!deviceConfig || !runtime) {
            return;
        }

        const startedAt = Date.now();
        const reads = await this._runWithConcurrency(runtime.objects, this.objectConcurrency, async ({ objectId }) => {
            const result = await this._readObjectPresentValue(
                runtime.address, Number(objectId.type), Number(objectId.instance), runtime.unsupportedUnits
            );
            return { objectId, result };
        });

        if (this.closing) return;
        await this._withDeviceUpdate(deviceId, async () => {
            if (this.closing || this.deviceRuntime.get(deviceId) !== runtime) return;

            if (reads.some(({ error, result }) => (error || result?.error) instanceof BacnetUnavailableError)) {
                runtime.nextEligiblePollAt = Date.now() + this.schedulerTickMs;
                if (runtime.schedule) runtime.cronDue = true;
                else runtime.nextDueAt = runtime.nextEligiblePollAt;
                return;
            }
            await this._syncRuntimeConfig(runtime);
            await this._commitPoll(deviceConfig, runtime, startedAt, reads);
        });
    }

    async _commitPoll(deviceConfig, runtime, startedAt, reads) {
        const { deviceId } = runtime;
        runtime.lastAttemptAt = startedAt;
        const completedAt = Date.now();
        const durationMs = completedAt - startedAt;
        this.metrics.totalPolls += 1;
        this.metrics.totalPollDurationMs += durationMs;
        this.metrics.lastPollAt = completedAt;

        const values = {};
        let successCount = 0;
        let failureCount = 0;
        let pollErrorClass = null;

        for (const { objectId, result, error } of reads) {
            const properties = result?.value?.values?.[0]?.values;
            const presentValue = this._findProperty(properties, Property.PRESENT_VALUE);
            if (error || result?.error || !presentValue || presentValue.type === ApplicationTags.ERROR) {
                failureCount += 1;
                this.metrics.totalObjectFailures += 1;
                pollErrorClass ||= (error || result?.error)?.message || 'present_value_unavailable';
                continue;
            }

            successCount += 1;
            this.metrics.totalObjectsRead += 1;
            const objectKey = this._objectKey(objectId);
            const objectName = this._findValueById(properties, Property.OBJECT_NAME);
            const units = this._findValueById(properties, Property.UNITS);
            const acquiredAt = completedAt;
            const freshnessMs = runtime.polling.freshnessMs;

            values[objectKey] = {
                value: presentValue.value,
                name: objectName,
                units,
                objectKey,
                objectType: Number(objectId.type),
                objectInstance: Number(objectId.instance),
                deviceId,
                address: deviceConfig.device.address,
                acquiredAt,
                publishedAt: completedAt,
                freshnessMs,
                sourceStatus: 'fresh',
                pollDurationMs: durationMs,
                pollClass: runtime.polling.class
            };

            await this.runtimeState.saveObjectTelemetry(deviceId, objectKey, values[objectKey]);
        }

        if (successCount > 0) {
            runtime.consecutiveFailures = 0;
            runtime.circuitState = 'closed';
            runtime.lastSuccessAt = completedAt;
            runtime.lastError = null;
            runtime.lastDurationMs = durationMs;
            runtime.nextEligiblePollAt = completedAt;
            this.metrics.successfulPolls += 1;
            await this.runtimeState.recordPollHistory({
                deviceId,
                objectCount: runtime.objects.length,
                successCount,
                failureCount,
                durationMs,
                status: failureCount > 0 ? 'partial' : 'success',
                errorClass: pollErrorClass,
                createdAt: completedAt
            });
            await this.runtimeState.upsertDeviceState(this._serializeRuntime(runtime));
            if (!this.closing) this.emit('values', deviceConfig.device, values);
            return;
        }

        runtime.consecutiveFailures += 1;
        runtime.circuitState = runtime.consecutiveFailures >= this.failureThreshold ? 'open' : 'closed';
        runtime.lastError = pollErrorClass || 'poll_failed';
        runtime.lastDurationMs = durationMs;
        runtime.nextEligiblePollAt = completedAt + this._calculateBackoffMs(runtime.consecutiveFailures);
        this.metrics.failedPolls += 1;
        await this.runtimeState.recordPollHistory({
            deviceId,
            objectCount: runtime.objects.length,
            successCount,
            failureCount,
            durationMs,
            status: 'failed',
            errorClass: runtime.lastError,
            createdAt: completedAt
        });
        await this.runtimeState.upsertDeviceState(this._serializeRuntime(runtime));
    }

    _calculateBackoffMs(consecutiveFailures) {
        const factor = Math.max(0, consecutiveFailures - 1);
        return Math.min(this.maxBackoffMs, this.baseBackoffMs * Math.pow(2, factor));
    }

    async _runWithConcurrency(items, limit, worker) {
        const results = new Array(items.length);
        let index = 0;
        const runners = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
            while (index < items.length) {
                const current = index;
                index += 1;
                try {
                    results[current] = await worker(items[current], current);
                } catch (err) {
                    results[current] = { error: err };
                }
            }
        });
        await Promise.all(runners);
        return results;
    }

    _readObjectList(deviceAddress, deviceId) {
        return this._readObject(deviceAddress, ObjectType.DEVICE, Number(deviceId), [{ id: Property.OBJECT_LIST }])
            .then(({ error, value }) => {
                if (error) throw error;
                return value;
            });
    }

    async _readObjectListWithRetry(deviceAddress, deviceId) {
        return this._retryDiscoveryRead(
            () => this._readObjectList(deviceAddress, deviceId),
            `Object_List for ${deviceId}`
        );
    }

    _readObjectListArrayIndex(deviceAddress, deviceId, arrayIndex) {
        const objectId = { type: ObjectType.DEVICE, instance: Number(deviceId) };
        const options = { ...this.requestOptions, arrayIndex };
        return this.requests.submit((done) => {
            this.client.readProperty(deviceAddress, objectId, Property.OBJECT_LIST, options, done);
        });
    }

    async _readObjectListArrayIndexWithRetry(deviceAddress, deviceId, arrayIndex) {
        return this._retryDiscoveryRead(
            () => this._readObjectListArrayIndex(deviceAddress, deviceId, arrayIndex),
            `Object_List[${arrayIndex}] for ${deviceId}`
        );
    }

    async _readObjectListCount(deviceAddress, deviceId) {
        const value = await this._readObjectListArrayIndexWithRetry(deviceAddress, deviceId, 0);
        return this._extractObjectListCount(value);
    }

    async _readObjectListByIndex(deviceAddress, deviceId, count) {
        if (count > MAX_DISCOVERY_OBJECTS) throw new Error(`BACnet object list exceeds ${MAX_DISCOVERY_OBJECTS} entries`);
        const indexes = Array.from({ length: count }, (_, index) => index + 1);
        const objects = await this._runWithConcurrency(indexes, this.objectConcurrency, async (index) => {
            const value = await this._readObjectListArrayIndexWithRetry(deviceAddress, deviceId, index);
            return this._extractIndexedObjectListEntry(value);
        });
        const failed = objects.find((object) => object?.error);
        if (failed) throw failed.error;
        if (objects.some((object) => !object)) throw new Error('Failed to read complete BACnet object list by index');
        return this._dedupeObjectIds(objects);
    }

    async _retryDiscoveryRead(readFn, label) {
        let lastError = null;
        for (let attempt = 0; attempt <= this.discoveryRetries; attempt += 1) {
            try {
                return await readFn();
            } catch (error) {
                if (error instanceof BacnetUnavailableError) throw error;
                lastError = error;
                if (attempt < this.discoveryRetries) {
                    logger.log('warn', `[Discovery] ${label} failed on attempt ${attempt + 1}/${this.discoveryRetries + 1}: ${error.message || error}`);
                }
            }
        }
        throw lastError;
    }

    async _readObject(deviceAddress, type, instance, properties) {
        try {
            const value = await this.requests.submit((done) => {
                this.client.readPropertyMultiple(
                    deviceAddress, [{ objectId: { type, instance }, properties }], this._buildRequestOptions(), done
                );
            });
            return { error: null, value };
        } catch (error) {
            return { error, value: null };
        }
    }

    async _readObjectWithRetry(deviceAddress, type, instance, properties, label) {
        let lastResult = null;
        for (let attempt = 0; attempt <= this.discoveryRetries; attempt += 1) {
            const result = await this._readObject(deviceAddress, type, instance, properties);
            if (result.error instanceof BacnetUnavailableError) throw result.error;
            if (!result.error) {
                return result;
            }
            lastResult = result;
            if (attempt < this.discoveryRetries) {
                logger.log('warn', `[Discovery] ${label} failed on attempt ${attempt + 1}/${this.discoveryRetries + 1}: ${result.error.message || result.error}`);
            }
        }
        return lastResult;
    }

    async _readObjectDiscoveryDetails(deviceAddress, objectId) {
        const full = await this._readObjectWithRetry(
            deviceAddress,
            objectId.type,
            objectId.instance,
            [
                { id: Property.OBJECT_IDENTIFIER },
                { id: Property.OBJECT_NAME },
                { id: Property.OBJECT_TYPE },
                { id: Property.DESCRIPTION },
                { id: Property.UNITS },
                { id: Property.PRESENT_VALUE }
            ],
            `full metadata ${objectId.type}/${objectId.instance}`
        );
        if (!full.error) {
            return full;
        }

        logger.log('warn', `[Discovery] Full object read failed for ${objectId.type}/${objectId.instance}: ${full.error.message || full.error}`);
        const basic = await this._readObjectWithRetry(
            deviceAddress,
            objectId.type,
            objectId.instance,
            [
                { id: Property.OBJECT_IDENTIFIER },
                { id: Property.OBJECT_NAME },
                { id: Property.OBJECT_TYPE },
                { id: Property.PRESENT_VALUE }
            ],
            `basic metadata ${objectId.type}/${objectId.instance}`
        );
        if (!basic.error) {
            return basic;
        }

        logger.log('warn', `[Discovery] Basic object read failed for ${objectId.type}/${objectId.instance}: ${basic.error.message || basic.error}`);
        return {
            error: null,
            value: this._buildMinimalObjectReadResult(objectId)
        };
    }

    async _readObjectPresentValue(deviceAddress, type, instance, unsupportedUnits) {
        const basic = [{ id: Property.PRESENT_VALUE }, { id: Property.OBJECT_NAME }];
        const key = this._objectKey({ type, instance });
        if (unsupportedUnits?.has(key)) return this._readObject(deviceAddress, type, instance, basic);

        const result = await this._readObject(deviceAddress, type, instance, [...basic, { id: Property.UNITS }]);
        if (!result.error) {
            const units = this._findProperty(result.value?.values?.[0]?.values, Property.UNITS);
            if (units?.type === ApplicationTags.ERROR && units.value?.errorClass === 2 && units.value?.errorCode === 32) {
                unsupportedUnits?.add(key);
            }
            return result;
        }
        if (!this._isUnknownPropertyError(result.error)) return result;

        const fallback = await this._readObject(deviceAddress, type, instance, basic);
        if (!fallback.error) unsupportedUnits?.add(key);
        return fallback;
    }

    _isUnknownPropertyError(error) {
        const message = error && error.message ? error.message : String(error || '');
        return /unknown[\s_-]*property/i.test(message) || /class:\s*2\s*-\s*code:\s*32/i.test(message);
    }

    _findProperty(properties, id) {
        return properties?.find((property) => property.id === id)?.value?.[0];
    }

    _findValueById(properties, id) {
        const property = this._findProperty(properties, id);
        return property?.type === ApplicationTags.ERROR ? null : property?.value ?? null;
    }

    _buildMinimalObjectReadResult(objectId) {
        return {
            values: [{
                objectId,
                values: [
                    { id: Property.OBJECT_IDENTIFIER, value: [{ value: objectId }] },
                    { id: Property.OBJECT_TYPE, value: [{ value: objectId.type }] }
                ]
            }]
        };
    }

    _extractObjectListEntries(result) {
        const properties = result?.values?.[0]?.values;
        const values = properties?.find(({ id }) => id === Property.OBJECT_LIST)?.value;
        if (!Array.isArray(values)) {
            return [];
        }
        return this._dedupeObjectIds(values
            .map((entry) => this._normalizeObjectIdentifierValue(entry))
            .filter(Boolean));
    }

    _extractObjectListCount(result) {
        if (!result || !Array.isArray(result.values) || !result.values[0]) {
            return null;
        }
        const count = result.values[0].value;
        return Number.isSafeInteger(count) && count >= 0 ? count : null;
    }

    _extractIndexedObjectListEntry(result) {
        if (!result || !Array.isArray(result.values) || !result.values[0]) {
            return null;
        }
        return this._normalizeObjectIdentifierValue(result.values[0]);
    }

    _normalizeObjectIdentifierValue(entry) {
        if (!entry) {
            return null;
        }
        const value = entry.value !== undefined ? entry.value : entry;
        if (value && value.type !== undefined && value.instance !== undefined) {
            return {
                type: parseInt(value.type, 10),
                instance: parseInt(value.instance, 10)
            };
        }
        if (value && value.objectId && value.objectId.type !== undefined && value.objectId.instance !== undefined) {
            return {
                type: parseInt(value.objectId.type, 10),
                instance: parseInt(value.objectId.instance, 10)
            };
        }
        return null;
    }

    _dedupeObjectIds(objects) {
        const seen = new Set();
        return objects.filter((object) => {
            if (!object || Number.isNaN(object.type) || Number.isNaN(object.instance)) {
                return false;
            }
            const key = `${object.type}_${object.instance}`;
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
    }

    _mapToDeviceObject(object) {
        if (!object || !object.values) {
            return null;
        }

        const objectInfo = object.values[0].objectId;
        const deviceObjectId = new DeviceObjectId(objectInfo.type, objectInfo.instance);

        const objectProperties = object.values[0].values;
        const name = this._findValueById(objectProperties, Property.OBJECT_NAME);
        const description = this._findValueById(objectProperties, Property.DESCRIPTION);
        const type = this._findValueById(objectProperties, Property.OBJECT_TYPE);
        const units = this._findValueById(objectProperties, Property.UNITS);
        const presentValue = this._findValueById(objectProperties, Property.PRESENT_VALUE);

        return new DeviceObject(deviceObjectId, name, description, type, units, presentValue);
    }

    scanForDevices() {
        if (this.closing) throw new BacnetUnavailableError('BACnet client is closing');
        this.client.whoIs();
    }

    scanDevice(device) {
        if (this.closing) return Promise.reject(new BacnetUnavailableError('BACnet client is closing'));
        const key = JSON.stringify([String(device.deviceId), device.address]);
        if (this.scans.has(key)) return this.scans.get(key);
        if (this.scans.size >= MAX_ACTIVE_SCANS) {
            return Promise.reject(new BacnetUnavailableError('Too many active device scans'));
        }
        const pending = this._scanDevice(device).finally(() => this.scans.delete(key));
        this.scans.set(key, pending);
        return pending;
    }

    async _scanDevice(device) {
        const { address, deviceId } = device;
        let bulkError;
        let objects = [];
        try {
            const result = await this._readObjectListWithRetry(address, deviceId);
            objects = this._extractObjectListEntries(result);
            if (objects.length === 0) bulkError = new Error('BACnet bulk object list was empty or unavailable');
        } catch (error) {
            if (error instanceof BacnetUnavailableError) throw error;
            bulkError = error;
        }

        let count;
        try {
            count = await this._readObjectListCount(address, deviceId);
        } catch (error) {
            if (error instanceof BacnetUnavailableError) throw error;
            if (bulkError) throw bulkError;
            logger.log('warn', `[Discovery] Object list count unavailable for ${deviceId}: ${error.message}`);
        }
        if (Number.isSafeInteger(count) && (bulkError || count !== objects.length)) {
            objects = await this._readObjectListByIndex(address, deviceId, count);
        } else if (bulkError) {
            throw bulkError;
        }
        if (objects.length > MAX_DISCOVERY_OBJECTS) throw new Error(`BACnet object list exceeds ${MAX_DISCOVERY_OBJECTS} entries`);

        const reads = await this._runWithConcurrency(objects, this.objectConcurrency, async (objectId) => {
            const details = await this._readObjectDiscoveryDetails(address, objectId);
            return this._mapToDeviceObject(details.value) || this._mapToDeviceObject(this._buildMinimalObjectReadResult(objectId));
        });
        const failed = reads.find((entry) => entry?.error);
        if (failed) throw failed.error;
        if (!this.closing) this.emit('deviceObjects', device, reads);
        return reads;
    }

    startPolling(device, objects, pollingOrSchedule) {
        const pollSettings = typeof pollingOrSchedule === 'string'
            ? { schedule: pollingOrSchedule }
            : (pollingOrSchedule || {});
        const deviceConfig = {
            device,
            objects,
            polling: pollSettings
        };
        return this._registerDeviceConfig(deviceConfig);
    }

    saveConfig(deviceConfig) {
        return this._registerDeviceConfig(deviceConfig, true);
    }

    writeProperty(deviceAddress, objectId, propertyId, value, priority, bacnetApplicationTag, deviceId) {
        let type = bacnetApplicationTag;
        if (type === undefined) {
            if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) value = Number(value);
            if (typeof value === 'boolean') type = ApplicationTags.BOOLEAN;
            else if (typeof value === 'string') type = ApplicationTags.CHARACTER_STRING;
            else if (Number.isFinite(value)) type = Number.isInteger(value) ? ApplicationTags.SIGNED_INTEGER : ApplicationTags.REAL;
            else return Promise.reject(new TypeError('Unsupported value type for BACnet write'));
        }
        if (type === ApplicationTags.BOOLEAN) {
            if (typeof value === 'string') {
                const text = value.trim().toLowerCase();
                if (!['true', 'false', '1', '0'].includes(text)) {
                    return Promise.reject(new TypeError('A BACnet boolean must be true, false, 1, or 0'));
                }
                value = text === 'true' || text === '1';
            }
            value = value ? 1 : 0;
        }

        const key = JSON.stringify([deviceAddress, objectId.type, objectId.instance, propertyId]);
        return this.requests.submit((done) => {
            if (deviceId !== undefined && this.deviceConfigs.get(String(deviceId))?.device.address !== deviceAddress) {
                done(new BacnetUnavailableError('BACnet device address changed while the write was queued'));
                return;
            }
            this.client.writeProperty(deviceAddress, objectId, propertyId, [{ type, value }], this._buildRequestOptions(priority), done);
        }, key);
    }

    async listRuntimeStates() {
        return this.runtimeState.listDeviceStates();
    }

    async listRuntimeObjectStates(deviceId) {
        return this.runtimeState.listObjectStates(deviceId.toString());
    }

    getStatus() {
        const avgPollDurationMs = this.metrics.totalPolls > 0
            ? this.metrics.totalPollDurationMs / this.metrics.totalPolls
            : 0;
        return {
            configuredDevices: this.deviceConfigs.size,
            activePolls: this.activePolls,
            queuedPolls: this.queue.length,
            queueHighWaterMark: this.metrics.queueHighWaterMark,
            totalPolls: this.metrics.totalPolls,
            successfulPolls: this.metrics.successfulPolls,
            failedPolls: this.metrics.failedPolls,
            totalObjectsRead: this.metrics.totalObjectsRead,
            totalObjectFailures: this.metrics.totalObjectFailures,
            avgPollDurationMs,
            lastPollAt: this.metrics.lastPollAt
        };
    }

    close(httpClosed) {
        this.closePromise ??= this._close(httpClosed);
        return this.closePromise;
    }

    async _close(httpClosed) {
        this.closing = true;
        clearInterval(this.schedulerHandle);
        this.schedulerHandle = null;
        this.bacnetConfig.removeListener('configLoaded', this.onConfigLoaded);
        this.client.removeListener('iAm', this.onDeviceFound);
        for (const job of this.schedules.values()) job.cancel();
        this.schedules.clear();
        this.queue.length = 0;
        this.queuedDevices.clear();
        this.requests.close();

        try {
            await this.client.close?.();
        } finally {
            await Promise.allSettled([this.ready, ...this.polls, ...this.scans.values(), ...this.deviceUpdates.values()]);
            this.client.removeListener('error', this.onTransportError);
            await httpClosed;
            await this.runtimeState.close?.();
        }
    }
}

module.exports = { BacnetClient };
