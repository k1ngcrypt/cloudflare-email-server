import type { Env } from './index';

interface AddressRow {
  address: string;
}

interface UserAddressMatchRow {
  user_id: number;
}

interface LegacyEmailRow {
  email: string | null;
}

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

function dedupePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      deduped.push(value);
    }
  }

  return deduped;
}

function isMissingUserAddressesTableError(err: unknown): boolean {
  return err instanceof Error && /no such table:\s*user_addresses/i.test(err.message);
}

async function getLegacyEmail(env: Env, userId: number): Promise<string | null> {
  const row = await env.DB.prepare('SELECT email FROM users WHERE id = ?')
    .bind(userId)
    .first<LegacyEmailRow>();

  const normalized = row?.email ? normalizeAddress(row.email) : '';
  return normalized.length > 0 ? normalized : null;
}

export function normalizeEmailAddress(address: string): string {
  return normalizeAddress(address);
}

export function isValidEmailAddress(address: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
}

export async function listUserEmailAddresses(
  env: Env,
  userId: number,
  fallbackEmail?: string | null
): Promise<string[]> {
  try {
    const rows = await env.DB.prepare(
      `
        SELECT address
        FROM user_addresses
        WHERE user_id = ?
        ORDER BY is_primary DESC, id ASC
      `
    )
      .bind(userId)
      .all<AddressRow>();

    const normalized = (rows.results ?? [])
      .map((row) => normalizeAddress(String(row.address ?? '')))
      .filter((address) => address.length > 0);

    if (normalized.length > 0) {
      return dedupePreserveOrder(normalized);
    }
  } catch (err) {
    if (!isMissingUserAddressesTableError(err)) {
      throw err;
    }
  }

  const fallbackNormalized = fallbackEmail ? normalizeAddress(fallbackEmail) : '';
  if (fallbackNormalized.length > 0) {
    return [fallbackNormalized];
  }

  const legacy = await getLegacyEmail(env, userId);
  return legacy ? [legacy] : [];
}

export async function getPrimaryUserEmailAddress(
  env: Env,
  userId: number,
  fallbackEmail?: string | null
): Promise<string | null> {
  const addresses = await listUserEmailAddresses(env, userId, fallbackEmail);
  return addresses[0] ?? null;
}

export async function userOwnsEmailAddress(
  env: Env,
  userId: number,
  address: string,
  fallbackEmail?: string | null
): Promise<boolean> {
  const normalized = normalizeAddress(address);
  if (!normalized) {
    return false;
  }

  try {
    const row = await env.DB.prepare(
      `
        SELECT user_id
        FROM user_addresses
        WHERE user_id = ? AND address = ?
        LIMIT 1
      `
    )
      .bind(userId, normalized)
      .first<UserAddressMatchRow>();

    if (row) {
      return true;
    }
  } catch (err) {
    if (!isMissingUserAddressesTableError(err)) {
      throw err;
    }
  }

  const addresses = await listUserEmailAddresses(env, userId, fallbackEmail);
  return addresses.includes(normalized);
}

export async function findUserIdByEmailAddress(env: Env, address: string): Promise<number | null> {
  const normalized = normalizeAddress(address);
  if (!normalized) {
    return null;
  }

  try {
    const row = await env.DB.prepare(
      `
        SELECT user_id
        FROM user_addresses
        WHERE address = ?
        ORDER BY is_primary DESC, id ASC
        LIMIT 1
      `
    )
      .bind(normalized)
      .first<UserAddressMatchRow>();

    if (row) {
      return row.user_id;
    }
  } catch (err) {
    if (!isMissingUserAddressesTableError(err)) {
      throw err;
    }
  }

  const legacyRow = await env.DB.prepare('SELECT id FROM users WHERE lower(trim(email)) = ? LIMIT 1')
    .bind(normalized)
    .first<{ id: number }>();

  return legacyRow?.id ?? null;
}