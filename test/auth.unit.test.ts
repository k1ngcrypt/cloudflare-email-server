import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/index';
import {
  authenticate,
  createSession,
  getLoginThrottleKey,
  hashPassword,
  revokeSession,
  verifyPassword,
} from '../src/auth';
import { addUserEmailAddress, resetState, seedUser } from './helpers';

function bindings(): Env {
  return env as unknown as Env;
}

describe('auth helper behavior', () => {
  beforeEach(async () => {
    await resetState();
  });

  it('hashes passwords with SHA-256 and verifies valid/invalid credentials', async () => {
    const hash = await hashPassword('P@ssw0rd!');

    expect(hash).toMatch(/^[a-f0-9]{64}$/i);

    const matches = await verifyPassword('P@ssw0rd!', hash);
    const mismatch = await verifyPassword('definitely-wrong', hash);

    expect(matches).toBe(true);
    expect(mismatch).toBe(false);
  });

  it('verifies plain SHA-256 password hashes without metadata', async () => {
    const verified = await verifyPassword(
      'abc',
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
    expect(verified).toBe(true);
  });

  it('rejects malformed stored password hashes that are not supported', async () => {
    const verified = await verifyPassword('password', 'not-a-hash');
    expect(verified).toBe(false);
  });

  it('creates, authenticates, and revokes bearer and cookie sessions', async () => {
    const user = await seedUser({
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

  it('authenticates accounts that have multiple user_addresses entries', async () => {
    const user = await seedUser({
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
    expect(authenticated?.id).toBe(user.id);
    expect(authenticated?.username).toBe(user.username);
  });

  it('rejects sessions that have already expired', async () => {
    const user = await seedUser({
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
});
