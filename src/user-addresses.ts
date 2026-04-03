import type { Env } from './index';

interface AddressRow {
  address: string;
}

interface UserAddressMatchRow {
  user_id: number;
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

export async function listUserEmailAddresses(
  env: Env,
  userId: number
): Promise<string[]> {
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