const MAX_ACTIVE_REQUESTS = 64;
const MAX_WAITING_REQUESTS = 256;

class BacnetUnavailableError extends Error {
    constructor(message) {
        super(message);
        this.name = 'BacnetUnavailableError';
    }
}

class BacnetRequests {
    constructor() {
        this.active = new Set();
        this.activeKeys = new Set();
        this.waiting = [];
        this.closed = false;
    }

    submit(send, key) {
        if (this.closed) return Promise.reject(new BacnetUnavailableError('BACnet client is closing'));
        if (this.waiting.length >= MAX_WAITING_REQUESTS) {
            return Promise.reject(new BacnetUnavailableError('BACnet request queue is full'));
        }

        return new Promise((resolve, reject) => {
            this.waiting.push({ send, key, resolve, reject });
            this._drain();
        });
    }

    _drain() {
        if (this.draining) return;
        this.draining = true;
        try {
            while (!this.closed && this.active.size < MAX_ACTIVE_REQUESTS) {
                const index = this.waiting.findIndex(({ key }) => !this.activeKeys.has(key));
                if (index < 0) break;
                const [entry] = this.waiting.splice(index, 1);
                this.active.add(entry);
                if (entry.key !== undefined) this.activeKeys.add(entry.key);
                try {
                    entry.send((error, value) => this._finish(entry, error, value));
                } catch (error) {
                    this._finish(entry, error);
                }
            }
        } finally {
            this.draining = false;
        }
    }

    _finish(entry, error, value) {
        if (!this.active.delete(entry)) return;
        this.activeKeys.delete(entry.key);
        if (error) entry.reject(error);
        else entry.resolve(value);
        this._drain();
    }

    close() {
        this.closed = true;
        const error = new BacnetUnavailableError('BACnet client is closing');
        for (const entry of this.waiting.splice(0)) entry.reject(error);
        for (const entry of this.active) this._finish(entry, error);
    }
}

module.exports = { BacnetRequests, BacnetUnavailableError };
