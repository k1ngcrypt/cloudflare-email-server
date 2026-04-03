import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/index';
import {
  authenticate,
  clearLoginAttempts,
  createSession,
  getLoginThrottleKey,
  hashPassword,
  isLoginBlocked,
  recordFailedLoginAttempt,
  revokeSession,
  verifyPasswordAndUpgrade,
} from '../src/auth';
import { addUserEmailAddress, resetState, seedLegacyUser } from './helpers';

function bindings(): Env {
  return env as unknown as Env;
}

describe('auth helper behavior', () => {
  beforeEach(async () => {
    await resetState();
  });

  it('hashes passwords with argon2id and verifies valid/invalid credentials', async () => {
    const hash = await hashPassword('P@ssw0rd!');

    expect(hash.startsWith('argon2id$')).toBe(true);

    const matches = await verifyPasswordAndUpgrade(bindings(), 0, 'P@ssw0rd!', hash);
    const mismatch = await verifyPasswordAndUpgrade(bindings(), 0, 'definitely-wrong', hash);

    expect(matches).toBe(true);
    expect(mismatch).toBe(false);
  });

  it('upgrades legacy SHA-256 hashes after successful verification', async () => {
    const user = await seedLegacyUser({
      username: 'legacy-upgrade-user',
      email: 'legacy-upgrade-user@mail.example.test',
      password: 'Legacy-Upgrade-Pass-123',
    });

    const before = await bindings()
      .DB.prepare('SELECT password_hash FROM users WHERE id = ?')
      .bind(user.id)
      .first<{ password_hash: string }>();

    expect(before?.password_hash).toMatch(/^[a-f0-9]{64}$/);

    const verified = await verifyPasswordAndUpgrade(bindings(), user.id, user.password, before?.password_hash as string);

    expect(verified).toBe(true);

    const after = await bindings()
      .DB.prepare('SELECT password_hash FROM users WHERE id = ?')
      .bind(user.id)
      .first<{ password_hash: string }>();

    expect(after?.password_hash).toContain('argon2id$');
    expect(after?.password_hash).not.toBe(before?.password_hash);
  });

  it('rejects malformed stored password hashes that are not supported', async () => {
    const verified = await verifyPasswordAndUpgrade(bindings(), 0, 'password', 'not-a-hash');
    expect(verified).toBe(false);
  });

  it('creates, authenticates, and revokes bearer and cookie sessions', async () => {
    const user = await seedLegacyUser({
      username: 'session-user',
      email: 'session-user@mail.example.test',
      password: 'Session-Pass-123',
    });

    const session = await createSession(bindings(), user.id);

    const bearerRequest = new Request('https://webmail.test/api/me', {
      headers: {
        Authorization: `Bearer ${session.token}`,
      },
    });

    const cookieRequest = new Request('https://webmail.test/api/me', {
      headers: {
        Cookie: `session_token=${session.token}`,
      },
    });

    const bearerUser = await authenticate(bearerRequest, bindings());
    const cookieUser = await authenticate(cookieRequest, bindings());

    expect(bearerUser?.id).toBe(user.id);
    expect(cookieUser?.id).toBe(user.id);

    await revokeSession(cookieRequest, bindings());

    const afterRevoke = await authenticate(bearerRequest, bindings());
    expect(afterRevoke).toBeNull();
  });

  it('authenticates with the account primary address from user_addresses', async () => {
    const user = await seedLegacyUser({
      username: 'multi-address-auth-user',
      email: 'primary-auth@mail.example.test',
      password: 'Multi-Auth-Pass-123',
    });

    await addUserEmailAddress(user.id, 'alias-auth@mail.example.test');
    await addUserEmailAddress(user.id, 'new-primary-auth@mail.example.test', { isPrimary: true });

    const session = await createSession(bindings(), user.id);
    const request = new Request('https://webmail.test/api/me', {
      headers: {
        Authorization: `Bearer ${session.token}`,
      },
    });

    const authenticated = await authenticate(request, bindings());
    expect(authenticated?.email).toBe('new-primary-auth@mail.example.test');
  });

  it('rejects sessions that have already expired', async () => {
    const user = await seedLegacyUser({
      username: 'expired-session-user',
      email: 'expired-session-user@mail.example.test',
      password: 'Expired-Session-Pass-123',
    });

    const session = await createSession(bindings(), user.id);

    await bindings()
      .DB.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?')
      .bind(new Date(Date.now() - 60_000).toISOString(), user.id)
      .run();

    const request = new Request('https://webmail.test/api/me', {
      headers: {
        Authorization: `Bearer ${session.token}`,
      },
    });

    const authenticated = await authenticate(request, bindings());
    expect(authenticated).toBeNull();
  });

  it('normalizes username and includes client IP when generating throttle keys', () => {
    const request = new Request('https://webmail.test/api/login', {
      headers: {
        'CF-Connecting-IP': '203.0.113.44',
      },
    });

    const key = getLoginThrottleKey(request, '  MiXeD-Case-User  ');
    expect(key).toBe('203.0.113.44:mixed-case-user');
  });

  it('blocks after repeated failed logins and clearLoginAttempts removes that state', async () => {
    const throttleKey = '198.51.100.44:blocked-user';

    for (let attempt = 1; attempt <= 9; attempt += 1) {
      const state = await recordFailedLoginAttempt(bindings(), throttleKey);
      expect(state.blocked).toBe(false);
    }

    const blockedState = await recordFailedLoginAttempt(bindings(), throttleKey);
    expect(blockedState.blocked).toBe(true);
    expect(blockedState.retryAfterSeconds).toBeGreaterThan(0);

    const blockedCheck = await isLoginBlocked(bindings(), throttleKey);
    expect(blockedCheck.blocked).toBe(true);

    await clearLoginAttempts(bindings(), throttleKey);

    const afterClear = await isLoginBlocked(bindings(), throttleKey);
    expect(afterClear.blocked).toBe(false);
  });

  it('deletes stale throttle windows during login block checks', async () => {
    const throttleKey = '198.51.100.55:stale-user';
    const staleTime = new Date(Date.now() - 20 * 60 * 1000).toISOString();

    await bindings()
      .DB.prepare(
        `
          INSERT INTO login_attempts
            (throttle_key, attempt_count, window_started_at, blocked_until, updated_at)
          VALUES (?, ?, ?, NULL, ?)
        `
      )
      .bind(throttleKey, 5, staleTime, staleTime)
      .run();

    const state = await isLoginBlocked(bindings(), throttleKey);
    expect(state.blocked).toBe(false);

    const row = await bindings()
      .DB.prepare('SELECT throttle_key FROM login_attempts WHERE throttle_key = ?')
      .bind(throttleKey)
      .first<{ throttle_key: string }>();

    expect(row).toBeNull();
  });
});