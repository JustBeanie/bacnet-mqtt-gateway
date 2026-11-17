require('dotenv').config({ quiet: true });

const { BacnetClient } = require('./bacnet_client');
const { Server } = require('./server');
const { logger } = require('./common');
const { MqttClient } = require('./mqtt_client');
const { AuthService } = require('./auth_service');
const { deliverInitialAdminPassword } = require('./bootstrap_credentials');
const config = require('config');

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;

function configBoolean(configProvider, path, fallback = false) {
    if (typeof configProvider.has === 'function' && !configProvider.has(path)) {
        return fallback;
    }
    const value = configProvider.get(path);
    if (typeof value === 'string') {
        return value.toLowerCase() === 'true';
    }
    return value === true;
}

function formatError(error) {
    if (error && error.stack) {
        return error.stack;
    }
    if (error && error.message) {
        return error.message;
    }
    return String(error);
}

function invokeClose(target, methodName, args = []) {
    if (!target || typeof target[methodName] !== 'function') {
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        const method = target[methodName];
        let settled = false;
        const done = (error) => {
            if (settled) {
                return;
            }
            settled = true;
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        };

        let result;
        try {
            result = method.call(target, ...args, done);
        } catch (error) {
            done(error);
            return;
        }

        if (result && typeof result.then === 'function') {
            result.then(() => done(), done);
        } else if (method.length <= args.length) {
            done();
        }
    });
}

function createApplication(options = {}) {
    const configProvider = options.config || config;
    const appLogger = options.logger || logger;
    const MqttClientClass = options.MqttClient || MqttClient;
    const BacnetClientClass = options.BacnetClient || BacnetClient;
    const AuthServiceClass = options.AuthService || AuthService;
    const ServerClass = options.Server || Server;
    const deliverPassword = options.deliverInitialAdminPassword || deliverInitialAdminPassword;
    const shutdownTimeoutMs = Number.isFinite(options.shutdownTimeoutMs)
        ? Math.max(1, options.shutdownTimeoutMs)
        : DEFAULT_SHUTDOWN_TIMEOUT_MS;
    const httpServerEnabled = configBoolean(configProvider, 'httpServer.enabled');
    const trustIngress = configBoolean(configProvider, 'auth.trustIngress');

    const authService = trustIngress ? null : (options.authService || new AuthServiceClass());
    const mqttClient = options.mqttClient || new MqttClientClass();
    const bacnetClient = options.bacnetClient || new BacnetClientClass();

    let server = null;
    let shuttingDown = false;
    let shutdownPromise = null;

    let initPromise;
    let authInitialization;

    const onDeviceFound = (device) => mqttClient.publishMessage(device);
    const onValues = (_device, values) => mqttClient.publishMessage(values);
    const onConfigChanged = (deviceId, objectKeys) => mqttClient.pruneDevicePublishes?.(deviceId, objectKeys);
    const onWriteCommand = async (command) => {
        const { deviceId, objectKey, objectType, objectInstance, propertyId, value, priority, bacnetApplicationTag } = command;
        const gatewayId = configProvider.get('mqtt.gatewayId');
        const topic = `bacnetwrite_status/${gatewayId}/${deviceId}/${objectKey}/${propertyId}`;
        const address = bacnetClient.deviceConfigs.get(String(deviceId))?.device.address;
        try {
            if (!address) throw new Error(`Device configuration not found for DeviceID ${deviceId}`);
            const response = await bacnetClient.writeProperty(
                address, { type: objectType, instance: objectInstance }, propertyId, value, priority, bacnetApplicationTag, deviceId
            );
            if (!shuttingDown) mqttClient.publishWriteStatus(topic, {
                status: 'success', detail: `BACnet write successful: ${JSON.stringify(response)}`, writtenValue: value
            });
        } catch (error) {
            if (shuttingDown) return;
            const detail = `BACnet write failed: ${error.message}`;
            appLogger.log('warn', `[App] ${detail}`);
            mqttClient.publishWriteStatus(topic, { status: 'error', detail, attemptedValue: value });
        }
    };
    bacnetClient.on('deviceFound', onDeviceFound);
    bacnetClient.on('values', onValues);
    bacnetClient.on('configChanged', onConfigChanged);
    mqttClient.on('bacnetWriteCommand', onWriteCommand);

    function init() {
        initPromise ??= start();
        return initPromise;
    }

    async function start() {
        await bacnetClient.ready;
        if (shuttingDown) return;
        if (authService) {
            authInitialization = Promise.resolve(authService.init()).then((seededPassword) => {
                if (seededPassword) deliverPassword('admin', seededPassword);
            });
            await authInitialization;
        }
        if (!shuttingDown && httpServerEnabled) {
            server = new ServerClass(bacnetClient, mqttClient, authService);
        }
    }

    function closeHttpServer() {
        if (!server) {
            return Promise.resolve();
        }
        if (typeof server.close === 'function') {
            return invokeClose(server, 'close');
        }
        const httpServer = server.httpServer || server.server;
        return invokeClose(httpServer, 'close');
    }

    function closeMqttClient() {
        if (typeof mqttClient.close === 'function') {
            return invokeClose(mqttClient, 'close');
        }
        if (mqttClient.client && typeof mqttClient.client.end === 'function') {
            return invokeClose(mqttClient.client, 'end', [false, {}]);
        }
        return Promise.resolve();
    }

    function shutdown(reason = 'shutdown requested') {
        if (shutdownPromise) {
            return shutdownPromise;
        }

        shuttingDown = true;
        appLogger.log('info', `[App] Shutting down: ${reason}`);

        bacnetClient.removeListener('deviceFound', onDeviceFound);
        bacnetClient.removeListener('values', onValues);
        bacnetClient.removeListener('configChanged', onConfigChanged);
        mqttClient.removeListener('bacnetWriteCommand', onWriteCommand);

        async function closeResource(name, close) {
            try {
                await close();
            } catch (error) {
                appLogger.log('error', `[App] Failed to close ${name}: ${formatError(error)}`);
            }
        }

        const httpClosed = closeResource('HTTP server', closeHttpServer);
        const cleanup = Promise.all([
            httpClosed,
            closeResource('MQTT client', closeMqttClient),
            closeResource('BACnet client and runtime state', () => invokeClose(bacnetClient, 'close', [httpClosed])),
            closeResource('auth service', async () => {
                await httpClosed;
                await authInitialization?.catch(() => {});
                await invokeClose(authService, 'close');
            })
        ]);

        shutdownPromise = new Promise((resolve) => {
            const deadline = setTimeout(() => {
                appLogger.log('error', `[App] Shutdown timed out after ${shutdownTimeoutMs}ms`);
                server?.forceClose?.();
                resolve();
            }, shutdownTimeoutMs);
            cleanup.then(() => {
                clearTimeout(deadline);
                appLogger.log('info', '[App] Shutdown complete');
                resolve();
            });
        });

        return shutdownPromise;
    }

    return {
        init,
        shutdown,
        mqttClient,
        bacnetClient,
        authService,
        get server() {
            return server;
        },
        get isShuttingDown() {
            return shuttingDown;
        }
    };
}

function runApplication(options = {}) {
    const processRef = options.process || process;
    const appLogger = options.logger || logger;
    const application = options.application || createApplication(options);
    let requestedExitCode = 0;
    let terminationPromise = null;

    const requestStop = (reason, exitCode = 0, error = null) => {
        requestedExitCode = Math.max(requestedExitCode, exitCode);
        processRef.exitCode = requestedExitCode;

        if (error) {
            appLogger.log('error', `[App] Fatal ${reason}: ${formatError(error)}`);
        }

        if (!terminationPromise) {
            terminationPromise = Promise.resolve()
                .then(() => application.shutdown(reason))
                .catch((shutdownError) => {
                    appLogger.log('error', `[App] Shutdown failed: ${formatError(shutdownError)}`);
                })
                .then(() => {
                    for (const [event, handler] of Object.entries(handlers)) processRef.removeListener(event, handler);
                    processRef.exit(requestedExitCode);
                });
        }
        return terminationPromise;
    };

    const handlers = {
        SIGTERM: () => { void requestStop('SIGTERM'); },
        SIGINT: () => { void requestStop('SIGINT'); },
        unhandledRejection: (reason) => { void requestStop('unhandled rejection', 1, reason); },
        uncaughtException: (error) => { void requestStop('uncaught exception', 1, error); }
    };
    for (const [event, handler] of Object.entries(handlers)) processRef.on(event, handler);

    const initPromise = Promise.resolve()
        .then(() => application.init())
        .catch((error) => requestStop('initialization failure', 1, error));

    return { application, initPromise, requestStop };
}

if (require.main === module) {
    runApplication();
}

module.exports = {
    DEFAULT_SHUTDOWN_TIMEOUT_MS,
    createApplication,
    runApplication
};
