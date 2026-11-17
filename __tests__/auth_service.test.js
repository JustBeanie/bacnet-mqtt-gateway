const fs = require('fs');
const os = require('os');
const path = require('path');

describe('AuthService', () => {
    let tempDir;
    let dbPath;
    let service;
    const originalEnv = { ...process.env };

    beforeEach(() => {
        service = null;
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'authdb-'));
        dbPath = path.join(tempDir, 'auth.db');
        process.env.NODE_CONFIG_STRICT_MODE = '0';
        process.env.NODE_ENV = 'development';
        process.env.NODE_CONFIG = JSON.stringify({
            auth: {
                dbPath,
                jwtSecret: 'test-secret-with-at-least-32-characters',
                tokenExpiresIn: '1h'
            }
        });
        jest.resetModules();
    });

    afterEach(async () => {
        if (service) {
            await service.close();
        }
        Object.keys(process.env).forEach((k) => {
            if (!(k in originalEnv)) delete process.env[k];
        });
        Object.entries(originalEnv).forEach(([k, v]) => (process.env[k] = v));
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('seeds admin with random password and validates login', async () => {
        const { AuthService } = require('../src/auth_service');
        service = new AuthService();
        const seedPassword = await service.init();

        expect(seedPassword).toBeTruthy();
        const admin = await service.validateUser('admin', seedPassword);
        expect(admin).toBeTruthy();

        const token = service.generateToken(admin);
        const payload = await service.verifyToken(token);
        expect(payload.username).toBe('admin');
        expect(payload.role).toBe('admin');
    });

    test('rejects a missing or weak JWT signing secret', () => {
        process.env.NODE_CONFIG = JSON.stringify({
            auth: {
                dbPath,
                jwtSecret: 'too-short'
            }
        });
        jest.resetModules();
        const { AuthService } = require('../src/auth_service');

        expect(() => new AuthService()).toThrow('auth.jwtSecret must contain at least 32 characters');
    });

    test('createUser adds viewer', async () => {
        const { AuthService } = require('../src/auth_service');
        service = new AuthService();
        await service.init();
        const user = await service.createUser('bob', 'secret', 'viewer');
        expect(user.username).toBe('bob');
        const validated = await service.validateUser('bob', 'secret');
        expect(validated).toBeTruthy();
    });

    test('refresh token rotation', async () => {
        const { AuthService } = require('../src/auth_service');
        service = new AuthService();
        await service.init();
        const user = await service.createUser('carol', 'secret', 'viewer');
        const refresh = await service.generateRefreshToken(user.id);
        const newRefresh = await service.rotateRefreshToken(refresh);
        expect(newRefresh).toBeTruthy();
    });

    test('change password with old password', async () => {
        const { AuthService } = require('../src/auth_service');
        service = new AuthService();
        await service.init();
        const user = await service.createUser('dave', 'oldpass', 'viewer');
        await service.changePassword(user.id, 'oldpass', 'newpass');
        const validated = await service.validateUser('dave', 'newpass');
        expect(validated).toBeTruthy();
    });

    test('createUser rejects invalid role', async () => {
        const { AuthService } = require('../src/auth_service');
        service = new AuthService();
        await service.init();

        await expect(service.createUser('mallory', 'secret', 'owner')).rejects.toThrow('Invalid role');
    });

    test('rotateRefreshToken rejects expired token', async () => {
        const { AuthService } = require('../src/auth_service');
        service = new AuthService();
        await service.init();
        const user = await service.createUser('erin', 'secret', 'viewer');
        const refresh = await service.generateRefreshToken(user.id);

        await new Promise((resolve, reject) => {
            service.db.run(
                'UPDATE refresh_tokens SET expires_at = ? WHERE token = ?',
                [Date.now() - 1000, refresh],
                (err) => (err ? reject(err) : resolve())
            );
        });

        await expect(service.rotateRefreshToken(refresh)).rejects.toThrow('Refresh token expired');
    });

    test('changePassword rejects wrong old password and missing user', async () => {
        const { AuthService } = require('../src/auth_service');
        service = new AuthService();
        await service.init();
        const user = await service.createUser('frank', 'secret', 'viewer');

        await expect(service.changePassword(user.id, 'wrong', 'newpass')).rejects.toThrow('Invalid old password');
        await expect(service.changePassword(999999, 'secret', 'newpass')).rejects.toThrow('User not found');
    });

    test('hasRequiredRole enforces role ordering', async () => {
        const { AuthService } = require('../src/auth_service');
        service = new AuthService();

        expect(service.hasRequiredRole('admin', 'viewer')).toBe(true);
        expect(service.hasRequiredRole('viewer', 'admin')).toBe(false);
    });

    test('findUser and findUserById return null for unknown users', async () => {
        const { AuthService } = require('../src/auth_service');
        service = new AuthService();
        await service.init();

        await expect(service.findUser('missing')).resolves.toBeNull();
        await expect(service.findUserById(424242)).resolves.toBeNull();
    });

    test('validateUser returns null for unknown user and wrong password', async () => {
        const { AuthService } = require('../src/auth_service');
        service = new AuthService();
        await service.init();
        await service.createUser('gina', 'secret', 'viewer');

        await expect(service.validateUser('missing', 'secret')).resolves.toBeNull();
        await expect(service.validateUser('gina', 'wrong')).resolves.toBeNull();
    });

    test('rotateRefreshToken rejects invalid token', async () => {
        const { AuthService } = require('../src/auth_service');
        service = new AuthService();
        await service.init();

        await expect(service.rotateRefreshToken('missing-token')).rejects.toThrow('Invalid refresh token');
    });

    test('verifyToken rejects tampered token', async () => {
        const { AuthService } = require('../src/auth_service');
        service = new AuthService();
        await service.init();

        await expect(service.verifyToken('not-a-token')).rejects.toBeTruthy();
    });

    test('setPassword updates credentials without old password flow', async () => {
        const { AuthService } = require('../src/auth_service');
        service = new AuthService();
        await service.init();
        const user = await service.createUser('henry', 'secret', 'viewer');

        await service.setPassword(user.id, 'new-secret');

        await expect(service.validateUser('henry', 'secret')).resolves.toBeNull();
        await expect(service.validateUser('henry', 'new-secret')).resolves.toBeTruthy();
    });

    test('resetAdminPassword rotates existing admin and recreates missing admin', async () => {
        const { AuthService } = require('../src/auth_service');
        service = new AuthService();
        const firstPassword = await service.init();

        const rotatedPassword = await service.resetAdminPassword('admin');
        expect(rotatedPassword).toBeTruthy();
        expect(rotatedPassword).not.toBe(firstPassword);
        await expect(service.validateUser('admin', rotatedPassword)).resolves.toBeTruthy();
        await expect(service.validateUser('admin', firstPassword)).resolves.toBeNull();

        await new Promise((resolve, reject) => {
            service.db.run(
                'DELETE FROM users WHERE username = ?',
                ['admin'],
                (err) => (err ? reject(err) : resolve())
            );
        });

        const recreatedPassword = await service.resetAdminPassword('admin');
        const recreatedAdmin = await service.validateUser('admin', recreatedPassword);
        expect(recreatedAdmin).toBeTruthy();
        expect(recreatedAdmin.role).toBe('admin');
    });
    test('concurrent refreshes produce one usable replacement and close idempotently', async () => {
        const { AuthService } = require('../src/auth_service');
        service = new AuthService();
        await service.init();
        const admin = await service.findUser('admin');
        const original = await service.generateRefreshToken(admin.id);

        const results = await Promise.allSettled([
            service.rotateRefreshToken(original), service.rotateRefreshToken(original)
        ]);
        const replacements = results.filter(({ status }) => status === 'fulfilled');
        expect(replacements).toHaveLength(1);
        expect(results.find(({ status }) => status === 'rejected').reason.message).toBe('Invalid refresh token');
        await expect(service._getRefreshToken(original)).resolves.toBeNull();
        await expect(service._getRefreshToken(replacements[0].value)).resolves.toMatchObject({ user_id: admin.id });

        const closed = service.close();
        expect(service.close()).toBe(closed);
        await closed;
    });

    test('opening an existing database removes expired tokens and preserves active sessions', async () => {
        const { AuthService } = require('../src/auth_service');
        service = new AuthService();
        await service.init();
        const { id } = await service.findUser('admin');
        const active = await service.generateRefreshToken(id);
        const expired = await service.generateRefreshToken(id);
        await service._run('UPDATE refresh_tokens SET expires_at = ? WHERE token = ?', [Date.now() - 1, expired]);
        await service.close();

        service = new AuthService();
        await expect(service.init()).resolves.toBeNull();
        await expect(service._getRefreshToken(expired)).resolves.toBeNull();
        await expect(service._getRefreshToken(active)).resolves.toMatchObject({ user_id: id });
    });

    test('two password changes cannot both use the same old password', async () => {
        const { AuthService } = require('../src/auth_service');
        service = new AuthService();
        const original = await service.init();
        const { id } = await service.findUser('admin');

        const results = await Promise.allSettled([
            service.changePassword(id, original, 'first-password'),
            service.changePassword(id, original, 'second-password')
        ]);
        expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
        const password = results[0].status === 'fulfilled' ? 'first-password' : 'second-password';
        await expect(service.validateUser('admin', password)).resolves.toMatchObject({ id });
    });
});
