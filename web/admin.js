const { createApp } = Vue;

function getAppBasePath(locationObject) {
    const pathname = locationObject && typeof locationObject.pathname === 'string'
        ? locationObject.pathname
        : '/';
    let basePath = pathname || '/';

    if (basePath.endsWith('/index.html')) {
        basePath = basePath.slice(0, -'index.html'.length);
    } else if (!basePath.endsWith('/')) {
        basePath += '/';
    }

    if (basePath.endsWith('/admin/')) {
        basePath = basePath.slice(0, -'admin/'.length);
    }

    return basePath || '/';
}

const appBasePath = getAppBasePath(window.location);
axios.defaults.baseURL = appBasePath;

const SessionVault = (() => {
    const ACCESS_TOKEN_KEY = 'bacnet_gateway_access_token';
    const REFRESH_TOKEN_KEY = 'bacnet_gateway_refresh_token';
    const LEGACY_TOKEN_KEY = 'bacnet_gateway_token';
    const KEY_MATERIAL = 'bacnet-gw-ui-key';
    const PLAINTEXT_PREFIX = 'plain:';

    function hasWebCrypto() {
        return typeof crypto !== 'undefined' &&
            crypto.subtle &&
            typeof crypto.subtle.importKey === 'function';
    }

    async function getKey() {
        const enc = new TextEncoder();
        return crypto.subtle.importKey(
            'raw',
            enc.encode(KEY_MATERIAL),
            { name: 'AES-GCM' },
            false,
            ['encrypt', 'decrypt']
        );
    }

    function bufToBase64(buf) {
        return btoa(String.fromCharCode(...new Uint8Array(buf)));
    }

    function base64ToBuf(b64) {
        const bytes = Uint8Array.from(atob(b64), (char) => char.charCodeAt(0));
        return bytes.buffer;
    }

    async function encryptToken(token) {
        if (!hasWebCrypto()) {
            return `${PLAINTEXT_PREFIX}${token}`;
        }
        const key = await getKey();
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const enc = new TextEncoder();
        const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(token));
        return `${bufToBase64(iv)}.${bufToBase64(encrypted)}`;
    }

    async function decryptToken(payload) {
        if (!payload) {
            return null;
        }
        try {
            if (payload.startsWith(PLAINTEXT_PREFIX)) {
                return payload.slice(PLAINTEXT_PREFIX.length);
            }
            if (!hasWebCrypto()) {
                return null;
            }
            const [ivB64, dataB64] = payload.split('.');
            const iv = new Uint8Array(base64ToBuf(ivB64));
            const data = base64ToBuf(dataB64);
            const key = await getKey();
            const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
            return new TextDecoder().decode(decrypted);
        } catch (err) {
            console.error('Failed to decrypt token', err);
            return null;
        }
    }

    return {
        async saveSession(accessToken, refreshToken, signal) {
            const [encryptedAccessToken, encryptedRefreshToken] = await Promise.all([
                encryptToken(accessToken), refreshToken ? encryptToken(refreshToken) : null
            ]);
            signal?.throwIfAborted();
            localStorage.setItem(ACCESS_TOKEN_KEY, encryptedAccessToken);
            if (encryptedRefreshToken) localStorage.setItem(REFRESH_TOKEN_KEY, encryptedRefreshToken);
            else localStorage.removeItem(REFRESH_TOKEN_KEY);
        },
        async loadSession() {
            const legacyToken = localStorage.getItem(LEGACY_TOKEN_KEY);
            if (legacyToken) {
                localStorage.setItem(ACCESS_TOKEN_KEY, legacyToken);
                localStorage.removeItem(LEGACY_TOKEN_KEY);
            }
            const [accessToken, refreshToken] = await Promise.all([
                decryptToken(localStorage.getItem(ACCESS_TOKEN_KEY)),
                decryptToken(localStorage.getItem(REFRESH_TOKEN_KEY))
            ]);
            return { accessToken, refreshToken };
        },
        clear() {
            localStorage.removeItem(ACCESS_TOKEN_KEY);
            localStorage.removeItem(REFRESH_TOKEN_KEY);
            localStorage.removeItem(LEGACY_TOKEN_KEY);
        }
    };
})();

function parseJwt(token) {
    try {
        const base64Url = token.split('.')[1];
        const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
        const jsonPayload = decodeURIComponent(atob(base64).split('').map((char) => {
            return `%${(`00${char.charCodeAt(0).toString(16)}`).slice(-2)}`;
        }).join(''));
        return JSON.parse(jsonPayload);
    } catch (_err) {
        return null;
    }
}

function extractErrorMessage(error, fallback) {
    return (error.response && error.response.data && error.response.data.message) || error.message || fallback;
}

function cancelRequest(component, field) {
    const controller = component[field];
    component[field] = null;
    controller?.abort();
}

function startRequest(component, field) {
    cancelRequest(component, field);
    const controller = new AbortController();
    component[field] = controller;
    return controller.signal;
}

function finishRequest(component, field, signal) {
    if (component[field]?.signal !== signal) return false;
    component[field] = null;
    return true;
}

const Spinner = {
    template: '#spinner-template'
};

const WhoisPanel = {
    template: '#whois-template',
    data() {
        return {
            loading: false,
            devices: [],
            discoveryRequest: null,
            error: null
        };
    },
    beforeUnmount() {
        cancelRequest(this, 'discoveryRequest');
    },
    methods: {
        async startScan() {
            if (this.loading) return;
            this.loading = true;
            this.error = null;
            this.devices = [];
            const signal = startRequest(this, 'discoveryRequest');
            try {
                const response = await axios.put('/api/bacnet/scan', {}, { signal });
                if (!signal.aborted) this.devices = response.data || [];
            } catch (error) {
                if (!signal.aborted) this.error = extractErrorMessage(error, 'Failed to scan BACnet network');
            } finally {
                if (finishRequest(this, 'discoveryRequest', signal)) this.loading = false;
            }
        },
        stopScan() {
            cancelRequest(this, 'discoveryRequest');
            this.loading = false;
            this.error = 'Scan stopped.';
        }
    }
};

const ObjectWriteForm = {
    template: '#object-write-form-template',
    components: { Spinner },
    props: {
        deviceId: { type: [String, Number], required: true },
        objectType: { type: Number, required: true },
        objectInstance: { type: Number, required: true },
        initialObjectName: { type: String, default: '' }
    },
    emits: ['close', 'success'],
    data() {
        return {
            loading: false,
            writeRequest: null,
            valueToWrite: '',
            propertyId: 85,
            priority: null,
            bacnetApplicationTag: null,
            status: null,
            message: null,
            commonProperties: [
                { text: 'Present Value (85)', value: 85 },
                { text: 'Object Name (77)', value: 77 },
                { text: 'Description (28)', value: 28 },
                { text: 'Reliability (103)', value: 103 },
                { text: 'Out Of Service (81)', value: 81 }
            ],
            commonAppTags: [
                { text: 'Auto Detect', value: null },
                { text: 'NULL (0)', value: 0 },
                { text: 'BOOLEAN (1)', value: 1 },
                { text: 'UNSIGNED INT (2)', value: 2 },
                { text: 'SIGNED INT (3)', value: 3 },
                { text: 'REAL (4)', value: 4 },
                { text: 'DOUBLE (5)', value: 5 },
                { text: 'CHARACTER STRING (7)', value: 7 },
                { text: 'ENUMERATED (9)', value: 9 }
            ]
        };
    },
    beforeUnmount() {
        cancelRequest(this, 'writeRequest');
    },
    methods: {
        async submitWrite() {
            const signal = startRequest(this, 'writeRequest');
            this.loading = true;
            this.status = null;
            this.message = null;

            const payload = {
                deviceId: this.deviceId,
                objectType: this.objectType,
                objectInstance: this.objectInstance,
                propertyId: Number(this.propertyId),
                value: this.valueToWrite
            };

            if (this.priority !== null && this.priority !== '') {
                payload.priority = Number(this.priority);
            }
            if (this.bacnetApplicationTag !== null && this.bacnetApplicationTag !== '') {
                payload.bacnetApplicationTag = Number(this.bacnetApplicationTag);
            }

            try {
                const response = await axios.put('/api/bacnet/write', payload, { signal });
                if (signal.aborted) return;
                this.status = 'success';
                this.message = response.data.message || 'Write successful';
                this.$emit('success');
            } catch (error) {
                if (signal.aborted) return;
                this.status = 'error';
                this.message = extractErrorMessage(error, 'Failed to perform write operation');
            } finally {
                if (finishRequest(this, 'writeRequest', signal)) this.loading = false;
            }
        }
    }
};

function isDemoScanAvailable() {
    if (typeof window === 'undefined' || !window.location) {
        return false;
    }
    const hostname = window.location.hostname;
    const search = window.location.search || '';
    return hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '[::1]' ||
        hostname === '::1' ||
        search.includes('demo=1');
}

const DeviceScan = {
    template: '#device-scan-template',
    components: { Spinner, ObjectWriteForm },
    props: {
        canWrite: { type: Boolean, default: false }
    },
    data() {
        return {
            loading: false,
            scanRequest: null,
            diagnosticsRequest: null,
            saveRequest: null,
            diagnosticsLoading: false,
            diagnosticsExpanded: false,
            diagnosticsFilter: 'all',
            demoScanAvailable: isDemoScanAvailable(),
            deviceId: '',
            address: '',
            objects: [],
            pollClass: 'normal',
            intervalMs: '',
            freshnessMs: '',
            saving: false,
            saveError: null,
            saveSuccess: null,
            configuredObjectKeys: new Set(),
            runtimeObjectKeys: new Set(),
            runtimeObjectsByKey: {},
            error: null,
            diagnosticsError: null,
            selectedObject: null
        };
    },
    computed: {
        filteredObjects() {
            if (this.diagnosticsFilter === 'configured') {
                return this.objects.filter((object) => object.configured);
            }
            if (this.diagnosticsFilter === 'runtime') {
                return this.objects.filter((object) => object.runtime);
            }
            if (this.diagnosticsFilter === 'discoveredOnly') {
                return this.objects.filter((object) => !object.configured && !object.runtime);
            }
            return this.objects;
        },
        diagnosticsSummary() {
            const discoveredKeys = new Set(this.objects.map((object) => object.objectKey).filter(Boolean));
            const configuredNotDiscovered = Array.from(this.configuredObjectKeys).filter((key) => !discoveredKeys.has(key));
            const runtimeNotDiscovered = Array.from(this.runtimeObjectKeys).filter((key) => !discoveredKeys.has(key));
            return {
                discovered: discoveredKeys.size,
                configured: this.configuredObjectKeys.size,
                runtime: this.runtimeObjectKeys.size,
                discoveredOnly: this.objects.filter((object) => !object.configured && !object.runtime).length,
                configuredNotDiscovered,
                runtimeNotDiscovered
            };
        }
    },
    watch: {
        deviceId: { handler: 'clearScan', flush: 'sync' },
        address: { handler: 'clearScan', flush: 'sync' }
    },
    beforeUnmount() {
        this.resetDeviceRequests();
    },
    methods: {
        clearScan() {
            this.resetDeviceRequests();
            this.objects = [];
            this.selectedObject = null;
            this.configuredObjectKeys.clear();
            this.runtimeObjectKeys.clear();
            this.runtimeObjectsByKey = {};
            this.error = null;
            this.diagnosticsError = null;
            this.saveError = null;
            this.saveSuccess = null;
        },
        resetDeviceRequests() {
            cancelRequest(this, 'scanRequest');
            cancelRequest(this, 'diagnosticsRequest');
            cancelRequest(this, 'saveRequest');
            this.loading = false;
            this.diagnosticsLoading = false;
            this.saving = false;
        },
        async scanDevice() {
            this.resetDeviceRequests();
            const signal = startRequest(this, 'scanRequest');
            const { deviceId, address } = this;
            this.loading = true;
            this.error = null;
            this.saveError = null;
            this.saveSuccess = null;
            this.diagnosticsError = null;
            try {
                const response = await axios.put(`/api/bacnet/${encodeURIComponent(deviceId)}/objects`, {
                    deviceId, address
                }, { signal });
                if (signal.aborted || this.deviceId !== deviceId || this.address !== address) return;
                this.objects = (response.data || []).map((object) => this.decorateObject({
                    ...object,
                    selected: object?.objectId?.type !== 8
                }));
                await this.loadDiagnostics();
            } catch (error) {
                if (signal.aborted) return;
                this.objects = [];
                this.error = extractErrorMessage(error, 'Failed to read BACnet device objects');
            } finally {
                if (finishRequest(this, 'scanRequest', signal)) this.loading = false;
            }
        },
        loadDemoScan() {
            this.resetDeviceRequests();
            this.error = null;
            this.saveError = null;
            this.saveSuccess = null;
            this.diagnosticsError = null;
            this.deviceId = 'demo-vrf-1';
            this.address = '127.0.0.1';
            this.configuredObjectKeys = new Set(['2_202', '2_203']);
            this.runtimeObjectKeys = new Set(['2_202']);
            this.runtimeObjectsByKey = {
                '2_202': {
                    device_id: 'demo-vrf-1',
                    object_key: '2_202',
                    object_name: 'Zone Temperature',
                    value: 21.5,
                    source_status: 'fresh',
                    updated_at: Date.now()
                }
            };
            this.objects = [
                {
                    objectId: { type: 2, instance: 202 },
                    name: 'Zone Temperature',
                    description: 'Demo configured object with runtime state'
                },
                {
                    objectId: { type: 2, instance: 203 },
                    name: 'Setpoint',
                    description: 'Demo configured object waiting for runtime state'
                },
                {
                    objectId: { type: 3, instance: 9 },
                    name: 'Fan Proof',
                    description: 'Demo discovered-only BACnet object'
                }
            ].map((object) => this.decorateObject({ ...object, selected: true }));
            this.diagnosticsExpanded = true;
            this.diagnosticsFilter = 'all';
        },
        objectKeyFromScanObject(object) {
            if (!object || !object.objectId) {
                return null;
            }
            return `${object.objectId.type}_${object.objectId.instance}`;
        },
        decorateObject(object) {
            const objectKey = this.objectKeyFromScanObject(object);
            return {
                ...object,
                objectKey,
                configured: objectKey ? this.configuredObjectKeys.has(objectKey) : false,
                runtime: objectKey ? this.runtimeObjectKeys.has(objectKey) : false
            };
        },
        applyDiagnostics() {
            this.objects = this.objects.map((object) => this.decorateObject(object));
        },
        async loadDiagnostics() {
            if (!this.deviceId) {
                return;
            }
            const { deviceId, address } = this;
            const signal = startRequest(this, 'diagnosticsRequest');
            const isCurrent = () => !signal.aborted && this.deviceId === deviceId && this.address === address;
            this.diagnosticsLoading = true;
            this.diagnosticsError = null;
            try {
                const [configuredResponse, runtimeResponse] = await Promise.all([
                    axios.get('/api/bacnet/configured', { signal }),
                    axios.get(`/api/bacnet/runtime-objects/${encodeURIComponent(deviceId)}`, { signal })
                ]);
                if (!isCurrent()) return;
                const configuredDevice = (configuredResponse.data || []).find((device) => {
                    return String(device.deviceId) === String(deviceId);
                });
                const configuredObjects = configuredDevice && Array.isArray(configuredDevice.objects)
                    ? configuredDevice.objects
                    : [];
                const runtimeObjects = runtimeResponse.data || [];
                this.configuredObjectKeys = new Set(configuredObjects.map((object) => object.objectKey).filter(Boolean));
                this.runtimeObjectKeys = new Set(runtimeObjects.map((object) => object.object_key).filter(Boolean));
                this.runtimeObjectsByKey = runtimeObjects.reduce((acc, object) => {
                    acc[object.object_key] = object;
                    return acc;
                }, {});
                this.applyDiagnostics();
            } catch (error) {
                if (!isCurrent()) return;
                this.configuredObjectKeys = new Set();
                this.runtimeObjectKeys = new Set();
                this.runtimeObjectsByKey = {};
                this.applyDiagnostics();
                this.diagnosticsError = extractErrorMessage(error, 'Failed to load object diagnostics');
            } finally {
                if (finishRequest(this, 'diagnosticsRequest', signal)) this.diagnosticsLoading = false;
            }
        },
        async saveForPolling() {
            const selectedObjects = this.objects.filter((object) => object.selected);
            this.saveError = null;
            this.saveSuccess = null;

            if (!this.deviceId || !this.address) {
                this.saveError = 'Device ID and IP address are required.';
                return;
            }
            if (selectedObjects.length === 0) {
                this.saveError = 'Select at least one BACnet object to poll.';
                return;
            }

            const polling = { class: this.pollClass };
            for (const [field, value] of [
                ['intervalMs', this.intervalMs],
                ['freshnessMs', this.freshnessMs]
            ]) {
                if (value !== '' && value !== null && value !== undefined) {
                    const parsed = Number(value);
                    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
                        this.saveError = `${field} must be a positive integer.`;
                        return;
                    }
                    polling[field] = parsed;
                }
            }

            const objects = selectedObjects.map((object) => ({
                objectId: {
                    type: object.objectId.type,
                    instance: object.objectId.instance
                },
                name: object.name,
                description: object.description,
                type: object.type,
                units: object.units,
                presentValue: object.presentValue
            }));

            const signal = startRequest(this, 'saveRequest');
            const { deviceId, address } = this;
            this.saving = true;
            try {
                await axios.put(`/api/bacnet/${encodeURIComponent(deviceId)}/config`, {
                    device: { deviceId, address }, polling, objects
                }, { signal });
                if (signal.aborted || this.deviceId !== deviceId || this.address !== address) return;
                cancelRequest(this, 'diagnosticsRequest');
                this.diagnosticsLoading = false;
                this.configuredObjectKeys = new Set(objects.map((object) => {
                    return `${object.objectId.type}_${object.objectId.instance}`;
                }));
                this.applyDiagnostics();
                this.saveSuccess = `Saved ${objects.length} object${objects.length === 1 ? '' : 's'} for polling.`;
            } catch (error) {
                if (!signal.aborted) this.saveError = extractErrorMessage(error, 'Failed to save polling configuration');
            } finally {
                if (finishRequest(this, 'saveRequest', signal)) this.saving = false;
            }
        },
        objectStatusLabels(object) {
            const labels = ['Discovered'];
            if (object.configured) {
                labels.push('Configured');
            }
            if (object.runtime) {
                labels.push('Runtime');
            }
            return labels;
        },
        statusClass(label) {
            return `state-${label.toLowerCase().replace(/\s+/g, '-')}`;
        },
        diagnosticPayload(object) {
            const runtimeObject = this.runtimeObjectsByKey[object.objectKey] || null;
            return JSON.stringify({
                objectKey: object.objectKey,
                discovered: true,
                configured: object.configured,
                runtime: object.runtime,
                deviceId: this.deviceId,
                runtimeValue: runtimeObject ? runtimeObject.value : undefined,
                runtimeUpdatedAt: runtimeObject ? (runtimeObject.updated_at || runtimeObject.acquired_at) : undefined,
                scan: object
            }, null, 2);
        },
        openWriteForm(object) {
            this.selectedObject = {
                objectType: object.objectId.type,
                objectInstance: object.objectId.instance,
                initialObjectName: object.name || '',
                deviceId: this.deviceId
            };
        },
        closeWriteForm() {
            this.selectedObject = null;
        }
    }
};

const ConfiguredDevices = {
    template: '#configured-devices-template',
    components: { Spinner },
    data() {
        return {
            loading: false,
            listRequest: null,
            devices: [],
            error: null
        };
    },
    beforeUnmount() {
        cancelRequest(this, 'listRequest');
    },
    methods: {
        async load() {
            const signal = startRequest(this, 'listRequest');
            this.loading = true;
            this.error = null;
            try {
                const response = await axios.get('/api/bacnet/configured', { signal });
                if (signal.aborted) return;
                this.devices = response.data || [];
            } catch (error) {
                if (signal.aborted) return;
                this.error = extractErrorMessage(error, 'Failed to load configured devices');
            } finally {
                if (finishRequest(this, 'listRequest', signal)) this.loading = false;
            }
        }
    },
    mounted() {
        this.load();
    }
};

const RuntimeDevices = {
    template: '#runtime-devices-template',
    components: { Spinner },
    data() {
        return {
            loading: false,
            listRequest: null,
            devices: [],
            error: null
        };
    },
    beforeUnmount() {
        cancelRequest(this, 'listRequest');
    },
    methods: {
        formatTimestamp(value) {
            if (!value) {
                return '-';
            }
            return new Date(value).toLocaleString();
        },
        async load() {
            const signal = startRequest(this, 'listRequest');
            this.loading = true;
            this.error = null;
            try {
                const response = await axios.get('/api/bacnet/runtime', { signal });
                if (signal.aborted) return;
                this.devices = response.data || [];
            } catch (error) {
                if (signal.aborted) return;
                this.error = extractErrorMessage(error, 'Failed to load runtime device state');
            } finally {
                if (finishRequest(this, 'listRequest', signal)) this.loading = false;
            }
        }
    },
    mounted() {
        this.load();
    }
};

const RuntimeObjects = {
    template: '#runtime-objects-template',
    components: { Spinner },
    data() {
        return {
            loading: false,
            listRequest: null,
            loaded: false,
            deviceId: '',
            objects: [],
            error: null
        };
    },
    beforeUnmount() {
        cancelRequest(this, 'listRequest');
    },
    methods: {
        formatTimestamp(value) {
            if (!value) {
                return '-';
            }
            return new Date(value).toLocaleString();
        },
        formatDuration(value) {
            if (!value) {
                return '-';
            }
            return `${value} ms`;
        },
        formatValue(value) {
            if (value === null || value === undefined) {
                return '-';
            }
            if (typeof value === 'object') {
                return JSON.stringify(value);
            }
            return String(value);
        },
        async load() {
            const { deviceId } = this;
            if (!deviceId) {
                return;
            }
            const signal = startRequest(this, 'listRequest');
            this.loading = true;
            this.loaded = false;
            this.error = null;
            try {
                const response = await axios.get(`/api/bacnet/runtime-objects/${encodeURIComponent(deviceId)}`, { signal });
                if (signal.aborted || this.deviceId !== deviceId) return;
                this.objects = response.data || [];
            } catch (error) {
                if (signal.aborted) return;
                this.objects = [];
                this.error = extractErrorMessage(error, 'Failed to load runtime object state');
            } finally {
                if (finishRequest(this, 'listRequest', signal)) {
                    this.loaded = true;
                    this.loading = false;
                }
            }
        }
    }
};

createApp({
    components: {
        Spinner,
        WhoisPanel,
        DeviceScan,
        ConfiguredDevices,
        RuntimeDevices,
        RuntimeObjects
    },
    data() {
        return {
            state: 'whois',
            tokenValid: false,
            trustIngress: false,
            loginLoading: false,
            loginError: null,
            loginForm: {
                username: '',
                password: ''
            },
            currentUser: {
                username: '',
                role: ''
            },
            health: {
                status: 'unknown',
                mqtt: { connected: false },
                bacnet: { configuredDevices: 0 },
                runtime: { openCircuits: 0, staleObjects: 0, degradedDevices: 0 }
            },
            changePasswordModal: false,
            changeForm: {
                oldPassword: '',
                newPassword: ''
            },
            changeError: null,
            changeSuccess: null,
            refreshInFlight: null,
            authRequest: null,
            healthRequest: null,
            passwordRequest: null,
            healthTimer: null,
            passwordTimer: null,
            responseInterceptor: null,
            disposed: false,
            sessionVersion: 0
        };
    },
    computed: {
        canWrite() {
            return this.currentUser.role === 'admin';
        }
    },
    methods: {
        async initAuth() {
            const signal = startRequest(this, 'authRequest');
            try {
                await this.readAuthMode(signal);
            } finally {
                finishRequest(this, 'authRequest', signal);
            }
        },
        async readAuthMode(signal) {
            try {
                const modeResponse = await axios.get('/auth/mode', { signal });
                if (signal.aborted) return;
                const mode = modeResponse.data || {};
                this.trustIngress = mode.trustIngress === true;
                if (this.trustIngress) {
                    SessionVault.clear();
                    delete axios.defaults.headers.common.Authorization;
                    const ingressUser = mode.user || {};
                    this.tokenValid = true;
                    this.currentUser = {
                        username: ingressUser.username || 'Home Assistant',
                        role: ingressUser.role || 'admin'
                    };
                    return;
                }
            } catch (error) {
                if (signal.aborted) return;
                console.error('Failed to detect authentication mode', error);
                this.trustIngress = false;
            }

            const session = await SessionVault.loadSession();
            if (signal.aborted) return;
            if (!session.accessToken) {
                this.tokenValid = false;
                return;
            }

            const payload = parseJwt(session.accessToken);
            if (!payload || !payload.exp || payload.exp * 1000 < Date.now()) {
                if (session.refreshToken) {
                    const version = this.sessionVersion;
                    try {
                        await this.refreshSession(session.refreshToken);
                        return;
                    } catch {
                        if (this.disposed || this.sessionVersion !== version) return;
                    }
                }
                SessionVault.clear();
                this.tokenValid = false;
                return;
            }

            this.setAuth(session.accessToken, payload);
        },
        setAuth(token, payload) {
            axios.defaults.headers.common.Authorization = `Bearer ${token}`;
            this.tokenValid = true;
            this.currentUser = {
                username: payload.username || '',
                role: payload.role || ''
            };
        },
        async refreshSession(explicitRefreshToken) {
            if (this.refreshInFlight) return this.refreshInFlight;
            const signal = startRequest(this, 'authRequest');
            const pending = (async () => {
                const session = await SessionVault.loadSession();
                signal.throwIfAborted();
                const refreshToken = explicitRefreshToken || session.refreshToken;
                if (!refreshToken) throw new Error('Missing refresh token');

                const client = axios.create({ baseURL: appBasePath });
                const response = await client.post('/auth/refresh', { refreshToken }, { signal });
                const accessToken = response.data.token;
                const payload = parseJwt(accessToken);
                if (!payload) throw new Error('Invalid token received');

                await SessionVault.saveSession(accessToken, response.data.refreshToken || refreshToken, signal);
                signal.throwIfAborted();
                this.setAuth(accessToken, payload);
                return accessToken;
            })();

            this.refreshInFlight = pending;
            try {
                return await pending;
            } finally {
                finishRequest(this, 'authRequest', signal);
                if (this.refreshInFlight === pending) this.refreshInFlight = null;
            }
        },
        async login() {
            const signal = startRequest(this, 'authRequest');
            this.sessionVersion += 1;
            this.loginLoading = true;
            this.loginError = null;
            try {
                const response = await axios.post('/auth/login', {
                    username: this.loginForm.username,
                    password: this.loginForm.password
                }, { signal });
                const token = response.data.token;
                const payload = parseJwt(token);
                if (!payload) throw new Error('Invalid token received');

                await SessionVault.saveSession(token, response.data.refreshToken, signal);
                signal.throwIfAborted();
                this.setAuth(token, payload);
                this.loginForm.password = '';
            } catch (error) {
                if (signal.aborted) return;
                this.loginError = extractErrorMessage(error, 'Login failed');
                SessionVault.clear();
            } finally {
                if (finishRequest(this, 'authRequest', signal)) this.loginLoading = false;
            }
        },
        logout() {
            if (this.trustIngress) return;
            this.sessionVersion += 1;
            cancelRequest(this, 'authRequest');
            cancelRequest(this, 'passwordRequest');
            clearTimeout(this.passwordTimer);
            this.refreshInFlight = null;
            this.loginLoading = false;
            SessionVault.clear();
            delete axios.defaults.headers.common.Authorization;
            this.tokenValid = false;
            this.currentUser = { username: '', role: '' };
            this.state = 'whois';
        },
        showView(name) {
            this.state = name;
        },
        async loadHealth() {
            if (this.disposed || this.healthRequest) return;
            const signal = startRequest(this, 'healthRequest');
            try {
                const response = await axios.get('/health', { signal, timeout: 10000 });
                if (signal.aborted) return;
                const data = response.data || {};
                this.health = {
                    status: data.status || 'unknown',
                    mqtt: data.mqtt || { connected: false },
                    bacnet: data.bacnet || { configuredDevices: 0 },
                    runtime: data.runtime || { openCircuits: 0, staleObjects: 0, degradedDevices: 0 }
                };
            } catch {
                if (signal.aborted) return;
                this.health = {
                    status: 'degraded',
                    mqtt: { connected: false },
                    bacnet: { configuredDevices: 0 },
                    runtime: { openCircuits: 0, staleObjects: 0, degradedDevices: 0 }
                };
            } finally {
                finishRequest(this, 'healthRequest', signal);
            }
        },
        openChangePassword() {
            if (this.trustIngress) {
                return;
            }
            this.changePasswordModal = true;
            this.changeError = null;
            this.changeSuccess = null;
            this.changeForm = { oldPassword: '', newPassword: '' };
        },
        closeChangePassword() {
            cancelRequest(this, 'passwordRequest');
            clearTimeout(this.passwordTimer);
            this.changePasswordModal = false;
            this.changeError = null;
            this.changeSuccess = null;
        },
        async submitChangePassword() {
            const signal = startRequest(this, 'passwordRequest');
            clearTimeout(this.passwordTimer);
            this.changeError = null;
            this.changeSuccess = null;
            try {
                await axios.post('/auth/change-password', {
                    oldPassword: this.changeForm.oldPassword,
                    newPassword: this.changeForm.newPassword
                }, { signal });
                if (signal.aborted) return;
                this.changeSuccess = 'Password updated. Please log in again.';
                this.passwordTimer = window.setTimeout(() => {
                    this.closeChangePassword();
                    this.logout();
                }, 900);
            } catch (error) {
                if (!signal.aborted) this.changeError = extractErrorMessage(error, 'Failed to change password');
            } finally {
                finishRequest(this, 'passwordRequest', signal);
            }
        }
    },
    beforeUnmount() {
        this.disposed = true;
        clearInterval(this.healthTimer);
        clearTimeout(this.passwordTimer);
        cancelRequest(this, 'authRequest');
        cancelRequest(this, 'healthRequest');
        cancelRequest(this, 'passwordRequest');
        axios.interceptors.response.eject(this.responseInterceptor);
    },
    async mounted() {
        this.responseInterceptor = axios.interceptors.response.use(
            (response) => response,
            async (error) => {
                const originalRequest = error.config || {};
                const requestUrl = originalRequest.url || '';
                if (this.disposed || this.trustIngress || originalRequest.signal?.aborted
                    || error.response?.status !== 401 || requestUrl.includes('/auth/')) throw error;

                if (originalRequest._retry) {
                    this.logout();
                    throw error;
                }

                const version = this.sessionVersion;
                originalRequest._retry = true;
                try {
                    const token = await this.refreshSession();
                    if (this.disposed || this.sessionVersion !== version || originalRequest.signal?.aborted) throw error;
                    originalRequest.headers = originalRequest.headers || {};
                    originalRequest.headers.Authorization = `Bearer ${token}`;
                    return axios(originalRequest);
                } catch {
                    if (!this.disposed && !originalRequest.signal?.aborted && this.sessionVersion === version) this.logout();
                    throw error;
                }
            }
        );

        this.healthTimer = window.setInterval(() => this.loadHealth(), 15000);
        await Promise.all([this.initAuth(), this.loadHealth()]);
    }
}).mount('#app');
