import type { Env } from './index';

interface AddressRow {
  address: string;
  display_name: string;
  is_primary: number;
}

interface UserAddressMatchRow {
  user_id: number;
}

export interface UserEmailIdentity {
  address: string;
  name: string;
  isPrimary: boolean;
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

export function normalizeEmailAddress(address: string): string {
  return normalizeAddress(address);
}

export function isValidEmailAddress(address: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
}

function dedupeIdentitiesPreserveOrder(values: UserEmailIdentity[]): UserEmailIdentity[] {
  const seen = new Set<string>();
  const deduped: UserEmailIdentity[] = [];

  for (const value of values) {
    if (!seen.has(value.address)) {
      seen.add(value.address);
      deduped.push(value);
    }
  }

  return deduped;
}

export async function listUserEmailIdentities(
  env: Env,
  userId: number
): Promise<UserEmailIdentity[]> {
  const rows = await env.DB.prepare(
    `
      SELECT address, display_name, is_primary
      FROM user_addresses
      WHERE user_id = ?
      ORDER BY is_primary DESC, id ASC
    `
  )
    .bind(userId)
    .all<AddressRow>();

  const normalized = (rows.results ?? [])
    .map((row) => ({
      address: normalizeAddress(String(row.address ?? '')),
      name: String(row.display_name ?? '').trim(),
      isPrimary: Number(row.is_primary ?? 0) === 1,
    }))
    .filter((identity) => identity.address.length > 0 && identity.name.length > 0);

  return dedupeIdentitiesPreserveOrder(normalized);
}

export async function listUserEmailAddresses(
  env: Env,
  userId: number
): Promise<string[]> {
  const identities = await listUserEmailIdentities(env, userId);
  const normalized = identities.map((identity) => identity.address);

  return dedupePreserveOrder(normalized);
}

export async function getPrimaryUserEmailAddress(
  env: Env,
  userId: number
): Promise<string | null> {
  const addresses = await listUserEmailAddresses(env, userId);
  return addresses[0] ?? null;
}

export async function findUserIdByEmailAddress(env: Env, address: string): Promise<number | null> {
  const normalized = normalizeAddress(address);
  if (!normalized) {
    return null;
  }

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

  return row?.user_id ?? null;
}