const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const config = require('config');
const { logger } = require('./common');
const path = require('path');
const fs = require('fs');

const ROLE_ORDER = {
    viewer: 1,
    admin: 2
};

class AuthService {
    constructor() {
        const authCfg = config.get('auth');
        this.dbPath = path.resolve(authCfg.dbPath || './data/auth.db');
        this.jwtSecret = authCfg.jwtSecret;
        if (typeof this.jwtSecret !== 'string' || this.jwtSecret.length < 32) {
            throw new Error('auth.jwtSecret must contain at least 32 characters');
        }
        this.tokenExpiresIn = authCfg.tokenExpiresIn || '1h';
        this.refreshTokenExpiresHours = authCfg.refreshTokenExpiresHours || 168; // 7 days
        this.db = null;
        this.initPromise = null;
        this.closePromise = null;
        this.nextTokenCleanupAt = 0;
    }

    init() {
        if (this.closePromise) {
            return Promise.reject(new Error('Auth service is closed'));
        }
        this.initPromise ??= this._init();
        return this.initPromise;
    }

    async _init() {
        await this._openDb();
        await this._migrate();
        await this._pruneExpiredTokens(Date.now());
        return this._seedAdmin();
    }

    _generateRandomPassword() {
        return crypto.randomBytes(12).toString('base64url');
    }

    _openDb() {
        return new Promise((resolve, reject) => {
            const dir = path.dirname(this.dbPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            this.db = new sqlite3.Database(this.dbPath, (err) => {
                if (err) {
                    logger.log('error', `[Auth] Failed to open DB at ${this.dbPath}: ${err}`);
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    _migrate() {
        return new Promise((resolve, reject) => {
            const sql = `
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT UNIQUE NOT NULL,
                    password TEXT NOT NULL,
                    role TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS refresh_tokens (
                    token TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL,
                    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expiration ON refresh_tokens(expires_at);
            `;
            this.db.exec(sql, (err) => {
                if (err) {
                    logger.log('error', `[Auth] Migration failed: ${err}`);
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    async _seedAdmin() {
        const row = await new Promise((resolve, reject) => {
            this.db.get('SELECT COUNT(*) as count FROM users', (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });
        if (row.count > 0) return null;

        const password = this._generateRandomPassword();
        const hash = await bcrypt.hash(password, 10);
        const changes = await this._run(
            `INSERT OR IGNORE INTO users (username, password, role)
             SELECT 'admin', ?, 'admin' WHERE NOT EXISTS (SELECT 1 FROM users)`,
            [hash]
        );
        if (changes === 0) return null;
        logger.log('info', '[Auth] Seeded initial admin user.');
        return password;
    }

    async createUser(username, password, role = 'viewer') {
        if (!Object.hasOwn(ROLE_ORDER, role)) {
            throw new Error('Invalid role');
        }
        const hash = await bcrypt.hash(password, 10);
        return new Promise((resolve, reject) => {
            this.db.run(
                'INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
                [username, hash, role],
                function(err) {
                    if (err) reject(err);
                    else resolve({ id: this.lastID, username, role });
                }
            );
        });
    }

    _run(sql, params) {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function(err) {
                if (err) reject(err);
                else resolve(this.changes);
            });
        });
    }

    findUser(username) {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT * FROM users WHERE username = ?', [username], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row || null);
                }
            });
        });
    }

    findUserById(id) {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT * FROM users WHERE id = ?', [id], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row || null);
                }
            });
        });
    }

    async validateUser(username, password) {
        const user = await this.findUser(username);
        if (!user) return null;
        const match = await bcrypt.compare(password, user.password);
        return match ? user : null;
    }

    generateToken(user) {
        return jwt.sign(
            { sub: user.id, role: user.role, username: user.username },
            this.jwtSecret,
            { expiresIn: this.tokenExpiresIn }
        );
    }

    async generateRefreshToken(userId) {
        const token = crypto.randomBytes(32).toString('base64url');
        const now = Date.now();
        await this._pruneExpiredTokens(now);
        await this._run(
            'INSERT INTO refresh_tokens (token, user_id, expires_at) VALUES (?, ?, ?)',
            [token, userId, this._refreshExpiration(now)]
        );
        return token;
    }

    _refreshExpiration(now) {
        return now + this.refreshTokenExpiresHours * 60 * 60 * 1000;
    }

    async _pruneExpiredTokens(now) {
        if (now < this.nextTokenCleanupAt) return;
        this.nextTokenCleanupAt = now + 60 * 60 * 1000;
        try {
            await this._run('DELETE FROM refresh_tokens WHERE expires_at < ?', [now]);
        } catch (error) {
            this.nextTokenCleanupAt = 0;
            throw error;
        }
    }

    async rotateRefreshToken(oldToken) {
        const nextToken = crypto.randomBytes(32).toString('base64url');
        const now = Date.now();
        const changes = await this._run(
            'UPDATE refresh_tokens SET token = ?, expires_at = ? WHERE token = ? AND expires_at >= ?',
            [nextToken, this._refreshExpiration(now), oldToken, now]
        );
        if (changes === 1) {
            // Rotation already committed. A maintenance failure must not hide the replacement.
            await this._pruneExpiredTokens(now).catch((error) => logger.log('warn', `[Auth] Token cleanup failed: ${error.message}`));
            return nextToken;
        }

        const expired = await this._run('DELETE FROM refresh_tokens WHERE token = ? AND expires_at < ?', [oldToken, now]);
        throw new Error(expired ? 'Refresh token expired' : 'Invalid refresh token');
    }

    _getRefreshToken(token) {
        return new Promise((resolve, reject) => {
            this.db.get('SELECT * FROM refresh_tokens WHERE token = ?', [token], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row || null);
                }
            });
        });
    }

    verifyToken(token) {
        return new Promise((resolve, reject) => {
            jwt.verify(token, this.jwtSecret, (err, payload) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(payload);
                }
            });
        });
    }

    hasRequiredRole(userRole, minRole) {
        return Object.hasOwn(ROLE_ORDER, userRole) && Object.hasOwn(ROLE_ORDER, minRole)
            && ROLE_ORDER[userRole] >= ROLE_ORDER[minRole];
    }

    async changePassword(userId, oldPassword, newPassword) {
        const user = await this.findUserById(userId);
        if (!user) {
            throw new Error('User not found');
        }
        const match = await bcrypt.compare(oldPassword, user.password);
        if (!match) {
            throw new Error('Invalid old password');
        }
        const hash = await bcrypt.hash(newPassword, 10);
        const changes = await this._run('UPDATE users SET password = ? WHERE id = ? AND password = ?', [hash, userId, user.password]);
        if (changes === 0) throw new Error('Password changed. Sign in and try again.');
    }

    async setPassword(userId, newPassword) {
        const user = await this.findUserById(userId);
        if (!user) {
            throw new Error('User not found');
        }
        const hash = await bcrypt.hash(newPassword, 10);
        return new Promise((resolve, reject) => {
            this.db.run('UPDATE users SET password = ? WHERE id = ?', [hash, userId], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }

    async resetAdminPassword(username = 'admin') {
        const password = this._generateRandomPassword();
        const user = await this.findUser(username);

        if (!user) {
            await this.createUser(username, password, 'admin');
            return password;
        }

        await this.setPassword(user.id, password);
        return password;
    }

    close() {
        this.closePromise ??= this._close();
        return this.closePromise;
    }

    async _close() {
        await this.initPromise?.catch(() => {});
        if (!this.db) return;
        const db = this.db;
        await new Promise((resolve, reject) => {
            db.close((error) => error ? reject(error) : resolve());
        });
        this.db = null;
    }
}

module.exports = { AuthService, ROLE_ORDER };
