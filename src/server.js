const express = require('express');
const config = require('config');
const cors = require('cors');
const fs = require('fs');
const { logger } = require('./common');
const swaggerUi = require('swagger-ui-express'); 
const YAML = require('yaml');
const path = require('path'); 
const rateLimit = require('express-rate-limit');
const { BacnetUnavailableError } = require('./bacnet_requests');
const { validateDeviceConfig, parseWriteCommand } = require('./bacnet_validation');

const port = parseInt(config.get('httpServer.port'), 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('httpServer.port must be an integer between 1 and 65535');
}
const webRoot = path.join(__dirname, '../web');
const openapiDocument = buildOpenApiDocument(
    YAML.parse(fs.readFileSync(path.join(__dirname, '../openapi.yaml'), 'utf8')),
    getOpenApiServerUrl()
);

function getBooleanConfig(configPath, fallback = false) {
    if (!config.has(configPath)) {
        return fallback;
    }
    const value = config.get(configPath);
    if (typeof value === 'string') {
        return value.trim().toLowerCase() === 'true';
    }
    return value === true;
}

function getIngressSources() {
    if (!config.has('auth.ingressSource')) {
        return [];
    }
    const configured = config.get('auth.ingressSource');
    const values = Array.isArray(configured) ? configured : String(configured).split(',');
    return values
        .map((value) => normalizeAddress(value))
        .filter(Boolean);
}

function normalizeAddress(address) {
    if (address === undefined || address === null) {
        return '';
    }
    const normalized = String(address).trim().split('%')[0];
    return normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized;
}

function resolvePackageAsset(packageName, relativePath) {
    return path.join(__dirname, '../node_modules', packageName, relativePath);
}

function getOpenApiServerUrl() {
    if (!config.has('openapi.serverUrl')) {
        return '';
    }
    const serverUrl = config.get('openapi.serverUrl');
    return typeof serverUrl === 'string' ? serverUrl.trim() : '';
}

function buildOpenApiDocument(document, configuredServerUrl) {
    const spec = JSON.parse(JSON.stringify(document));
    const serverUrl = typeof configuredServerUrl === 'string' ? configuredServerUrl.trim() : '';
    if (serverUrl) {
        spec.servers = [{
            url: serverUrl,
            description: 'Configured API server'
        }];
    }
    return spec;
}

class Server {

    constructor(bacnetClient, mqttClient, authService) {

        this.bacnetClient = bacnetClient;
        this.mqttClient = mqttClient;
        this.authService = authService;
        this.trustIngress = getBooleanConfig('auth.trustIngress');
        this.ingressSources = getIngressSources();
        this.listener = null;
        this.closePromise = null;
        this.deviceScan = null;
        this.activeHandlers = new Set();
        this.rateLimitStores = [];

        this.app = express();
        if (typeof this.app.disable === 'function') {
            this.app.disable('x-powered-by');
        }
        if (this.trustIngress) {
            this.app.use(this._restrictIngressSource.bind(this));
        }
        this.app.use((req, res, next) => {
            if (this.closePromise) return res.status(503).send({ status: 'error', message: 'Gateway is shutting down' });
            next();
        });
        this.app.use(express.json({ limit: '1mb' }));
        if (!this.trustIngress) {
            this.app.use(cors());
        }

        this._mountVendorAssets();
        this.app.use('/admin', express.static(webRoot));
        this.app.use('/', express.static(webRoot));
        this.app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapiDocument));

        const authLimiter = rateLimit({
            windowMs: 15 * 60 * 1000,
            max: 30,
            store: this._createRateLimitStore(),
            standardHeaders: true,
            legacyHeaders: false,
            keyGenerator: (req) => this._rateLimitKey(req)
        });
        const apiLimiter = rateLimit({
            windowMs: 60 * 1000,
            max: 120,
            store: this._createRateLimitStore(),
            standardHeaders: true,
            legacyHeaders: false,
            keyGenerator: (req) => this._rateLimitKey(req)
        });

        // auth routes
        this.app.get('/auth/mode', this._authMode.bind(this));
        if (!this.trustIngress) {
            this.app.post('/auth/login', authLimiter, this._trackHandler(this._login));
            this.app.post('/auth/register', authLimiter, this._requireRole('admin'), this._trackHandler(this._register));
            this.app.post('/auth/refresh', authLimiter, this._trackHandler(this._refresh));
            this.app.post('/auth/change-password', authLimiter, this._requireRole('viewer'), this._trackHandler(this._changePassword));
        }

        // health/metrics (unauthenticated)
        this.app.get('/health', this._trackHandler(this._health));
        this.app.get('/metrics', this._trackHandler(this._metrics));

        // protected API
        this.app.put('/api/bacnet/scan', apiLimiter, this._requireRole('viewer'), this._scanForDevices.bind(this));
        this.app.put('/api/bacnet/:deviceId/objects', apiLimiter, this._requireRole('viewer'), this._trackHandler(this._scanDevice));
        this.app.get('/api/bacnet/configured', apiLimiter, this._requireRole('viewer'), this._listConfigured.bind(this));
        this.app.get('/api/bacnet/runtime', apiLimiter, this._requireRole('viewer'), this._trackHandler(this._listRuntime));
        this.app.get('/api/bacnet/runtime-objects/:deviceId', apiLimiter, this._requireRole('viewer'), this._trackHandler(this._listRuntimeObjects));
        this.app.put('/api/bacnet/:deviceId/config', apiLimiter, this._requireRole('admin'), this._trackHandler(this._configurePolling));
        this.app.put('/api/bacnet/write', apiLimiter, this._requireRole('admin'), this._trackHandler(this._writeProperty));

        // start server
        this.listener = this.app.listen(port, () => {
        });
    }

    _mountVendorAssets() {
        const assets = [
            ['vue.global.prod.js', resolvePackageAsset('vue', 'dist/vue.global.prod.js')],
            ['axios.min.js', resolvePackageAsset('axios', 'dist/axios.min.js')],
            ['bootstrap.min.css', resolvePackageAsset('bootstrap', 'dist/css/bootstrap.min.css')]
        ];

        for (const [publicName, filePath] of assets) {
            const serveAsset = (_req, res, next) => {
                res.sendFile(filePath, {
                    headers: {
                        'Cache-Control': 'public, max-age=31536000, immutable'
                    }
                }, (error) => {
                    if (error) {
                        next(error);
                    }
                });
            };
            this.app.get(`/vendor/${publicName}`, serveAsset);
            this.app.get(`/admin/vendor/${publicName}`, serveAsset);
        }
    }

    _remoteAddress(req) {
        return normalizeAddress(
            req && req.socket && req.socket.remoteAddress
                ? req.socket.remoteAddress
                : req && req.connection && req.connection.remoteAddress
                    ? req.connection.remoteAddress
                    : req && req.ip
        );
    }

    _isLoopback(address) {
        const normalized = normalizeAddress(address);
        return normalized === '::1' || normalized === 'localhost' || normalized.startsWith('127.');
    }

    _isHealthRequest(req) {
        const requestPath = (req.path || req.url || '').split('?')[0];
        const method = String(req.method || 'GET').toUpperCase();
        return (method === 'GET' || method === 'HEAD') && (requestPath === '/health' || requestPath === '/metrics');
    }

    _rateLimitKey(req) {
        if (this.trustIngress && req.ingressUser && req.ingressUser.sub) {
            return `ingress:${req.ingressUser.sub}`;
        }
        return `socket:${this._remoteAddress(req) || 'unknown'}`;
    }

    _isTrustedIngressRequest(req) {
        const remoteAddress = this._remoteAddress(req);
        if (this.ingressSources.includes(remoteAddress)) {
            return true;
        }
        if (process.env.NODE_ENV === 'test' && (!remoteAddress || this._isLoopback(remoteAddress))) {
            return true;
        }
        return this._isLoopback(remoteAddress) && this._isHealthRequest(req);
    }

    _ingressUser(req) {
        const headers = req.headers || {};
        const username = headers['x-remote-user-display-name'] || headers['x-remote-user-name'] || 'Home Assistant';
        return {
            sub: headers['x-remote-user-id'] || 'home-assistant-ingress',
            username: String(username),
            role: 'admin',
            authProvider: 'home_assistant_ingress'
        };
    }

    _restrictIngressSource(req, res, next) {
        if (!this._isTrustedIngressRequest(req)) {
            return res.status(403).send({ status: 'error', message: 'Ingress proxy access required' });
        }
        req.ingressUser = this._ingressUser(req);
        next();
    }

    _authMode(req, res) {
        if (!this.trustIngress) {
            return res.send({ trustIngress: false });
        }
        res.send({
            trustIngress: true,
            user: req.ingressUser || this._ingressUser(req)
        });
    }

    _createRateLimitStore() {
        const store = new rateLimit.MemoryStore();
        this.rateLimitStores.push(store);
        return store;
    }

    _trackHandler(handler) {
        return (req, res) => {
            if (this.closePromise) return res.status(503).send({ status: 'error', message: 'Gateway is shutting down' });
            const pending = handler.call(this, req, res);
            this.activeHandlers.add(pending);
            return pending.finally(() => this.activeHandlers.delete(pending));
        };
    }

    close() {
        this.closePromise ??= this._close();
        return this.closePromise;
    }

    async _close() {
        this._finishDeviceScan(503);
        const listener = this.listener;
        try {
            if (listener) {
                await new Promise((resolve, reject) => {
                    listener.close((error) => {
                        if (!error || error.code === 'ERR_SERVER_NOT_RUNNING') resolve();
                        else reject(error);
                    });
                });
                this.listener = null;
            }
        } finally {
            await Promise.allSettled(this.activeHandlers || []);
            for (const store of this.rateLimitStores || []) store.shutdown();
        }
    }

    forceClose() {
        this.listener?.closeAllConnections?.();
    }

    _finishDeviceScan(status) {
        const scan = this.deviceScan;
        if (!scan) return;
        this.deviceScan = null;
        clearTimeout(scan.timer);
        this.bacnetClient.removeListener('deviceFound', scan.collect);
        const devices = Array.from(scan.devices.values());
        for (const [res, onClose] of scan.responses) {
            res.removeListener?.('close', onClose);
            if (status === 200) res.send(devices);
            else res.status(status).send({ status: 'error', message: 'BACnet discovery is unavailable' });
        }
        scan.responses.clear();
    }

    _scanForDevices(_req, res) {
        if (this.closePromise) return res.status(503).send({ status: 'error', message: 'Gateway is shutting down' });
        const newScan = !this.deviceScan;
        if (newScan) {
            const devices = new Map();
            const collect = (device) => devices.set(JSON.stringify([device.deviceId, device.address]), device);
            this.deviceScan = { devices, collect, responses: new Map() };
            this.bacnetClient.on('deviceFound', collect);
            this.deviceScan.timer = setTimeout(() => this._finishDeviceScan(200), 5000);
        }

        const scan = this.deviceScan;
        const onClose = () => {
            scan.responses.delete(res);
            if (this.deviceScan === scan && scan.responses.size === 0) this._finishDeviceScan(200);
        };
        scan.responses.set(res, onClose);
        res.once?.('close', onClose);

        if (newScan) {
            try {
                this.bacnetClient.scanForDevices();
            } catch (error) {
                logger.log('warn', `[Discovery] Network scan failed: ${error.message}`);
                this._finishDeviceScan(503);
            }
        }
    }

    async _scanDevice(req, res) {
        const device = req.body;
        if (!device || device.deviceId === undefined || !device.address) {
            return res.status(400).send({ status: 'error', message: 'deviceId and address are required in request body.' });
        }
        const saveConfig = req.query?.saveConfig === 'true';
        if (saveConfig && req.user?.role !== 'admin') {
            return res.status(403).send({ status: 'error', message: 'Forbidden' });
        }
        try {
            const deviceObjects = await this.bacnetClient.scanDevice(device);
            if (saveConfig && !res.destroyed) {
                await this.bacnetClient.saveConfig({
                    device,
                    polling: { class: 'normal' },
                    objects: deviceObjects
                });
            }
            res.send(deviceObjects);
        } catch (err) {
            logger.log('error', `[API] Failed to scan device ${JSON.stringify(device)}: ${err}`);
            res.status(err instanceof BacnetUnavailableError ? 503 : 500).send({
                status: 'error', message: 'Failed to scan device', details: err.message
            });
        }
    }

    async _health(_req, res) {
        const mqttStatus = this.mqttClient && this.mqttClient.getStatus ? this.mqttClient.getStatus() : { connected: false };
        const bacnetStatus = this.bacnetClient && this.bacnetClient.getStatus ? this.bacnetClient.getStatus() : { configuredDevices: 0 };
        const runtimeSummary = this.bacnetClient && this.bacnetClient.runtimeState && this.bacnetClient.runtimeState.getMetricsSummary
            ? await this.bacnetClient.runtimeState.getMetricsSummary()
            : { healthyDevices: 0, degradedDevices: 0, openCircuits: 0, staleObjects: 0 };
        const overallOk = mqttStatus.connected === true && runtimeSummary.openCircuits === 0;
        res.status(200).send({
            status: overallOk ? 'ok' : 'degraded',
            mqtt: mqttStatus,
            bacnet: bacnetStatus,
            runtime: runtimeSummary
        });
    }

    async _metrics(_req, res) {
        const mqttStatus = this.mqttClient && this.mqttClient.getStatus ? this.mqttClient.getStatus() : { connected: false };
        const bacnetStatus = this.bacnetClient && this.bacnetClient.getStatus ? this.bacnetClient.getStatus() : {};
        const runtimeSummary = this.bacnetClient && this.bacnetClient.runtimeState && this.bacnetClient.runtimeState.getMetricsSummary
            ? await this.bacnetClient.runtimeState.getMetricsSummary()
            : { configuredDevices: 0, healthyDevices: 0, degradedDevices: 0, openCircuits: 0, staleObjects: 0 };
        const lines = [
            '# HELP bacnet_gateway_mqtt_connected MQTT connection state (1=connected, 0=not connected)',
            '# TYPE bacnet_gateway_mqtt_connected gauge',
            `bacnet_gateway_mqtt_connected ${mqttStatus.connected ? 1 : 0}`,
            '# HELP bacnet_gateway_configured_devices Count of BACnet devices configured for polling',
            '# TYPE bacnet_gateway_configured_devices gauge',
            `bacnet_gateway_configured_devices ${runtimeSummary.configuredDevices}`,
            '# HELP bacnet_gateway_healthy_devices Count of healthy BACnet devices',
            '# TYPE bacnet_gateway_healthy_devices gauge',
            `bacnet_gateway_healthy_devices ${runtimeSummary.healthyDevices}`,
            '# HELP bacnet_gateway_degraded_devices Count of degraded BACnet devices',
            '# TYPE bacnet_gateway_degraded_devices gauge',
            `bacnet_gateway_degraded_devices ${runtimeSummary.degradedDevices}`,
            '# HELP bacnet_gateway_open_circuits Count of BACnet devices with open circuit breakers',
            '# TYPE bacnet_gateway_open_circuits gauge',
            `bacnet_gateway_open_circuits ${runtimeSummary.openCircuits}`,
            '# HELP bacnet_gateway_stale_objects Count of stale BACnet objects',
            '# TYPE bacnet_gateway_stale_objects gauge',
            `bacnet_gateway_stale_objects ${runtimeSummary.staleObjects}`,
            '# HELP bacnet_gateway_poll_queue_depth Pending BACnet device polls in queue',
            '# TYPE bacnet_gateway_poll_queue_depth gauge',
            `bacnet_gateway_poll_queue_depth ${bacnetStatus.queuedPolls || 0}`,
            '# HELP bacnet_gateway_poll_queue_high_water_mark Maximum observed BACnet poll queue depth',
            '# TYPE bacnet_gateway_poll_queue_high_water_mark gauge',
            `bacnet_gateway_poll_queue_high_water_mark ${bacnetStatus.queueHighWaterMark || 0}`,
            '# HELP bacnet_gateway_poll_total Total BACnet poll executions',
            '# TYPE bacnet_gateway_poll_total counter',
            `bacnet_gateway_poll_total ${bacnetStatus.totalPolls || 0}`,
            '# HELP bacnet_gateway_poll_failures_total Total failed BACnet poll executions',
            '# TYPE bacnet_gateway_poll_failures_total counter',
            `bacnet_gateway_poll_failures_total ${bacnetStatus.failedPolls || 0}`,
            '# HELP bacnet_gateway_objects_read_total Total BACnet objects read successfully',
            '# TYPE bacnet_gateway_objects_read_total counter',
            `bacnet_gateway_objects_read_total ${bacnetStatus.totalObjectsRead || 0}`,
            '# HELP bacnet_gateway_object_failures_total Total BACnet object read failures',
            '# TYPE bacnet_gateway_object_failures_total counter',
            `bacnet_gateway_object_failures_total ${bacnetStatus.totalObjectFailures || 0}`,
            '# HELP bacnet_gateway_poll_average_duration_ms Average BACnet poll duration in milliseconds',
            '# TYPE bacnet_gateway_poll_average_duration_ms gauge',
            `bacnet_gateway_poll_average_duration_ms ${bacnetStatus.avgPollDurationMs || 0}`,
            '# HELP bacnet_gateway_mqtt_publish_success_total Total successful MQTT publishes',
            '# TYPE bacnet_gateway_mqtt_publish_success_total counter',
            `bacnet_gateway_mqtt_publish_success_total ${mqttStatus.publishSuccessCount || 0}`,
            '# HELP bacnet_gateway_mqtt_publish_failure_total Total failed MQTT publishes',
            '# TYPE bacnet_gateway_mqtt_publish_failure_total counter',
            `bacnet_gateway_mqtt_publish_failure_total ${mqttStatus.publishFailureCount || 0}`,
            '# TYPE bacnet_gateway_mqtt_pending_publishes gauge',
            `bacnet_gateway_mqtt_pending_publishes ${mqttStatus.pendingPublishCount || 0}`,
            '# TYPE bacnet_gateway_mqtt_in_flight_publishes gauge',
            `bacnet_gateway_mqtt_in_flight_publishes ${mqttStatus.inFlightPublishCount || 0}`,
            '# TYPE bacnet_gateway_mqtt_dropped_publishes_total counter',
            `bacnet_gateway_mqtt_dropped_publishes_total ${mqttStatus.droppedPublishCount || 0}`
        ];
        res.type('text/plain').send(lines.join('\n'));
    }

    _listConfigured(_req, res) {
        const list = [];
        if (this.bacnetClient && this.bacnetClient.deviceConfigs) {
            for (const [deviceId, cfg] of this.bacnetClient.deviceConfigs.entries()) {
                const objects = Array.isArray(cfg.objects) ? cfg.objects.map((obj) => {
                    const objectId = obj && obj.objectId ? obj.objectId : {};
                    const type = objectId.type;
                    const instance = objectId.instance;
                    return {
                        objectKey: type !== undefined && instance !== undefined ? `${type}_${instance}` : undefined,
                        objectType: type,
                        objectInstance: instance,
                        name: obj && obj.name,
                        description: obj && obj.description
                    };
                }) : [];
                list.push({
                    deviceId,
                    address: cfg.device && cfg.device.address,
                    schedule: cfg.polling && cfg.polling.schedule,
                    pollClass: cfg.polling && cfg.polling.class,
                    intervalMs: cfg.polling && cfg.polling.intervalMs,
                    freshnessMs: cfg.polling && cfg.polling.freshnessMs,
                    objectCount: objects.length,
                    objects
                });
            }
        }
        res.send(list);
    }

    async _listRuntime(_req, res) {
        try {
            const states = await this.bacnetClient.listRuntimeStates();
            res.send(states);
        } catch (err) {
            logger.log('error', `[API] Failed to fetch runtime states: ${err}`);
            res.status(500).send({ status: 'error', message: 'Failed to fetch runtime states' });
        }
    }

    async _listRuntimeObjects(req, res) {
        const { deviceId } = req.params || {};
        if (deviceId === undefined || deviceId === '') {
            return res.status(400).send({ status: 'error', message: 'deviceId is required' });
        }
        try {
            const states = await this.bacnetClient.listRuntimeObjectStates(deviceId);
            res.send(states);
        } catch (err) {
            logger.log('error', `[API] Failed to fetch runtime object states for ${deviceId}: ${err}`);
            res.status(500).send({ status: 'error', message: 'Failed to fetch runtime object states' });
        }
    }

    async _configurePolling(req, res) {
        const config = req.body;
        const validationErrors = validateDeviceConfig(config, { requirePolling: true });
        if (req.params?.deviceId && req.params.deviceId !== String(config?.device?.deviceId)) {
            validationErrors.push('The URL deviceId must match device.deviceId.');
        }

        if (validationErrors.length > 0) {
            return res.status(400).send({ status: 'error', message: 'Invalid configuration', details: validationErrors });
        }

        try {
            await this.bacnetClient.saveConfig(config);
            res.send({});
        } catch (err) {
            logger.log('error', `[API] Failed to configure polling: ${err}`);
            const status = err instanceof BacnetUnavailableError ? 503 : err instanceof TypeError ? 400 : 500;
            res.status(status).send({ status: 'error', message: 'Failed to configure polling', details: err.message });
        }
    }

    async _writeProperty(req, res) {
        let command;
        try {
            command = parseWriteCommand(req.body);
        } catch (error) {
            return res.status(400).send({ status: 'error', message: error.message });
        }

        const { deviceId, objectType, objectInstance, propertyId, value, priority, bacnetApplicationTag } = command;
        const address = this.bacnetClient.deviceConfigs.get(String(deviceId))?.device.address;
        if (!address) {
            return res.status(404).send({ status: 'error', message: `Device configuration not found for deviceId: ${deviceId}` });
        }

        try {
            const response = await this.bacnetClient.writeProperty(
                address, { type: objectType, instance: objectInstance }, propertyId, value, priority, bacnetApplicationTag, deviceId
            );
            res.status(200).send({ status: 'success', message: 'Write operation successful', response });
        } catch (error) {
            logger.log('error', `[API Write] Failed for DeviceId ${deviceId}: ${error.message}`);
            const status = error instanceof BacnetUnavailableError ? 503 : error instanceof TypeError ? 400 : 500;
            res.status(status).send({
                status: 'error', message: `BACnet write operation failed: ${error.message}`
            });
        }
    }

    async _login(req, res) {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).send({ status: 'error', message: 'username and password required' });
        }
        try {
            const user = await this.authService.validateUser(username, password);
            if (!user) {
                return res.status(401).send({ status: 'error', message: 'Invalid credentials' });
            }
            const token = this.authService.generateToken(user);
            const refreshToken = await this.authService.generateRefreshToken(user.id);
            res.send({ status: 'success', token, refreshToken, role: user.role, username: user.username });
        } catch (err) {
            logger.log('error', `[Auth] Login failed: ${err}`);
            res.status(500).send({ status: 'error', message: 'Login failed' });
        }
    }

    async _register(req, res) {
        const { username, password, role } = req.body;
        if (!username || !password) {
            return res.status(400).send({ status: 'error', message: 'username and password required' });
        }
        try {
            const user = await this.authService.createUser(username, password, role || 'viewer');
            res.status(201).send({ status: 'success', user: { id: user.id, username: user.username, role: user.role } });
        } catch (err) {
            logger.log('error', `[Auth] Register failed: ${err}`);
            res.status(400).send({ status: 'error', message: 'Register failed', details: err.message || err });
        }
    }

    async _refresh(req, res) {
        const { refreshToken } = req.body;
        if (!refreshToken) {
            return res.status(400).send({ status: 'error', message: 'refreshToken required' });
        }
        try {
            const newRefresh = await this.authService.rotateRefreshToken(refreshToken);
            const stored = await this.authService._getRefreshToken(newRefresh);
            const user = await this.authService.findUserById(stored.user_id);
            const access = this.authService.generateToken(user);
            res.send({ status: 'success', token: access, refreshToken: newRefresh });
        } catch (err) {
            logger.log('warn', `[Auth] Refresh failed: ${err}`);
            res.status(401).send({ status: 'error', message: 'Invalid or expired refresh token' });
        }
    }

    async _changePassword(req, res) {
        const { oldPassword, newPassword } = req.body;
        if (!oldPassword || !newPassword) {
            return res.status(400).send({ status: 'error', message: 'oldPassword and newPassword required' });
        }
        try {
            await this.authService.changePassword(req.user.sub, oldPassword, newPassword);
            res.send({ status: 'success', message: 'Password updated' });
        } catch (err) {
            res.status(400).send({ status: 'error', message: err.message || 'Failed to change password' });
        }
    }

    _requireRole(minRole) {
        return async (req, res, next) => {
            if (this.trustIngress) {
                if (!this._isTrustedIngressRequest(req)) {
                    return res.status(403).send({ status: 'error', message: 'Ingress proxy access required' });
                }
                req.user = req.ingressUser || this._ingressUser(req);
                next();
                return;
            }
            try {
                const authHeader = req.headers.authorization || '';
                const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null;
                if (!token) {
                    return res.status(401).send({ status: 'error', message: 'Missing token' });
                }
                const payload = await this.authService.verifyToken(token);
                if (!this.authService.hasRequiredRole(payload.role, minRole)) {
                    return res.status(403).send({ status: 'error', message: 'Forbidden' });
                }
                req.user = payload;
                next();
            } catch (err) {
                logger.log('warn', `[Auth] Unauthorized: ${err.message || err}`);
                res.status(401).send({ status: 'error', message: 'Unauthorized' });
            }
        };
    }
}

module.exports = {Server, buildOpenApiDocument};
