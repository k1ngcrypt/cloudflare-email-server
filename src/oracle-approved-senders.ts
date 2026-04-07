import type { Env } from './index';

const OCI_CONTROL_API_VERSION_PATH = '/20170907';
const JSON_CONTENT_TYPE = 'application/json';
const LIST_SENDERS_PAGE_SIZE = 100;
const LIST_SENDERS_MAX_PAGES = 50;
const OCI_SENDER_CACHE_TABLE = 'oci_approved_sender_cache';

const SIGNED_HEADERS_NO_BODY = ['(request-target)', 'host', 'x-date'] as const;
const SIGNED_HEADERS_WITH_BODY = [
  '(request-target)',
  'host',
  'x-date',
  'x-content-sha256',
  'content-type',
  'content-length',
] as const;

interface SenderSummary {
  id: string;
  emailAddress: string;
  lifecycleState?: string;
}

interface ListSendersResponseBody {
  items?: SenderSummary[];
}

interface ListSendersPageOptions {
  emailAddress?: string;
  page?: string;
}

interface ListSendersPageResult {
  items: SenderSummary[];
  nextPage: string | null;
}

interface SenderCacheRow {
  email_address: string;
  sender_id: string;
}

export class ApprovedSenderSyncError extends Error {
  readonly createdAddresses: string[];

  constructor(message: string, createdAddresses: string[]) {
    super(message);
    this.name = 'ApprovedSenderSyncError';
    this.createdAddresses = createdAddresses;
  }
}

const textEncoder = new TextEncoder();
let cachedSigningKeyPem: string | null = null;
let cachedSigningKeyPromise: Promise<CryptoKey> | null = null;
let cachedNormalizedPrivateKeyRaw: string | null = null;
let cachedNormalizedPrivateKey: string | null = null;
let cachedKeyIdParts: string | null = null;
let cachedKeyId: string | null = null;
let senderCacheReadyPromise: Promise<void> | null = null;
let senderCacheReadyDb: D1Database | null = null;
let senderCacheDisabled = false;

function normalizeEmailAddress(address: string): string {
  return address.trim().toLowerCase();
}

function normalizeUniqueEmailAddresses(emailAddresses: string[]): string[] {
  const uniqueAddresses: string[] = [];
  const seen = new Set<string>();

  for (const value of emailAddresses) {
    const normalized = normalizeEmailAddress(String(value ?? ''));
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    uniqueAddresses.push(normalized);
  }

  return uniqueAddresses;
}

function buildSqlPlaceholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function canUseSenderCache(env: Env): boolean {
  const candidate = env.DB as unknown as { prepare?: unknown };
  return !senderCacheDisabled && typeof candidate.prepare === 'function';
}

async function ensureSenderCacheTable(env: Env): Promise<void> {
  if (!canUseSenderCache(env)) {
    return;
  }

  if (senderCacheReadyPromise && senderCacheReadyDb === env.DB) {
    await senderCacheReadyPromise;
    return;
  }

  senderCacheReadyDb = env.DB;
  senderCacheReadyPromise = (async () => {
    await env.DB.prepare(
      `
        CREATE TABLE IF NOT EXISTS ${OCI_SENDER_CACHE_TABLE} (
          email_address TEXT PRIMARY KEY,
          sender_id TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `
    ).run();

    await env.DB.prepare(
      `
        CREATE INDEX IF NOT EXISTS idx_oci_sender_cache_updated_at
        ON ${OCI_SENDER_CACHE_TABLE}(updated_at)
      `
    ).run();
  })().catch((err) => {
    senderCacheDisabled = true;
    senderCacheReadyPromise = null;
    console.error('Failed to initialize OCI sender cache table:', err);
  });

  await senderCacheReadyPromise;
}

async function getCachedSenderMap(
  env: Env,
  normalizedEmailAddresses: string[]
): Promise<Map<string, SenderSummary>> {
  const senderByEmail = new Map<string, SenderSummary>();
  if (normalizedEmailAddresses.length === 0) {
    return senderByEmail;
  }

  await ensureSenderCacheTable(env);
  if (!canUseSenderCache(env)) {
    return senderByEmail;
  }

  try {
    const placeholders = buildSqlPlaceholders(normalizedEmailAddresses.length);
    const rows = await env.DB.prepare(
      `
        SELECT email_address, sender_id
        FROM ${OCI_SENDER_CACHE_TABLE}
        WHERE email_address IN (${placeholders})
      `
    )
      .bind(...normalizedEmailAddresses)
      .all<SenderCacheRow>();

    for (const row of rows.results ?? []) {
      const emailAddress = normalizeEmailAddress(String(row.email_address ?? ''));
      const senderId = String(row.sender_id ?? '').trim();
      if (!emailAddress || !senderId) {
        continue;
      }

      senderByEmail.set(emailAddress, {
        id: senderId,
        emailAddress,
      });
    }
  } catch (err) {
    senderCacheDisabled = true;
    console.error('Failed to read OCI sender cache entries:', err);
  }

  return senderByEmail;
}

async function upsertSenderCacheEntries(
  env: Env,
  entries: Array<{ emailAddress: string; senderId: string }>
): Promise<void> {
  if (entries.length === 0) {
    return;
  }

  await ensureSenderCacheTable(env);
  if (!canUseSenderCache(env)) {
    return;
  }

  const senderIdByEmail = new Map<string, string>();
  for (const entry of entries) {
    const emailAddress = normalizeEmailAddress(entry.emailAddress);
    const senderId = String(entry.senderId ?? '').trim();
    if (!emailAddress || !senderId) {
      continue;
    }

    senderIdByEmail.set(emailAddress, senderId);
  }

  if (senderIdByEmail.size === 0) {
    return;
  }

  try {
    await env.DB.batch(
      Array.from(senderIdByEmail.entries()).map(([emailAddress, senderId]) =>
        env.DB.prepare(
          `
            INSERT INTO ${OCI_SENDER_CACHE_TABLE} (email_address, sender_id, updated_at)
            VALUES (?, ?, datetime('now'))
            ON CONFLICT(email_address) DO UPDATE SET
              sender_id = excluded.sender_id,
              updated_at = excluded.updated_at
          `
        ).bind(emailAddress, senderId)
      )
    );
  } catch (err) {
    senderCacheDisabled = true;
    console.error('Failed to upsert OCI sender cache entries:', err);
  }
}

async function deleteSenderCacheEntries(env: Env, normalizedEmailAddresses: string[]): Promise<void> {
  if (normalizedEmailAddresses.length === 0) {
    return;
  }

  await ensureSenderCacheTable(env);
  if (!canUseSenderCache(env)) {
    return;
  }

  const uniqueEmailAddresses = normalizeUniqueEmailAddresses(normalizedEmailAddresses);
  if (uniqueEmailAddresses.length === 0) {
    return;
  }

  try {
    const placeholders = buildSqlPlaceholders(uniqueEmailAddresses.length);
    await env.DB.prepare(
      `
        DELETE FROM ${OCI_SENDER_CACHE_TABLE}
        WHERE email_address IN (${placeholders})
      `
    )
      .bind(...uniqueEmailAddresses)
      .run();
  } catch (err) {
    senderCacheDisabled = true;
    console.error('Failed to delete OCI sender cache entries:', err);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function normalizePemPrivateKey(input: string): string {
  const trimmed = input.trim();
  if (trimmed.includes('\\n')) {
    return trimmed.replace(/\\n/g, '\n');
  }

  return trimmed;
}

function getNormalizedPemPrivateKey(input: string): string {
  if (cachedNormalizedPrivateKeyRaw === input && cachedNormalizedPrivateKey !== null) {
    return cachedNormalizedPrivateKey;
  }

  const normalized = normalizePemPrivateKey(input);
  cachedNormalizedPrivateKeyRaw = input;
  cachedNormalizedPrivateKey = normalized;
  return normalized;
}

function getOciKeyId(env: Env): string {
  const keyIdParts = `${env.OCI_EMAIL_API_TENANCY_OCID}|${env.OCI_EMAIL_API_USER_OCID}|${env.OCI_EMAIL_API_KEY_FINGERPRINT}`;
  if (cachedKeyIdParts === keyIdParts && cachedKeyId !== null) {
    return cachedKeyId;
  }

  const keyId = `${env.OCI_EMAIL_API_TENANCY_OCID}/${env.OCI_EMAIL_API_USER_OCID}/${env.OCI_EMAIL_API_KEY_FINGERPRINT}`;
  cachedKeyIdParts = keyIdParts;
  cachedKeyId = keyId;
  return keyId;
}

function pemToDerBytes(privateKeyPem: string): Uint8Array {
  const normalized = privateKeyPem.trim();

  if (normalized.includes('BEGIN RSA PRIVATE KEY')) {
    throw new Error(
      'OCI_EMAIL_API_PRIVATE_KEY must use PKCS#8 format (BEGIN PRIVATE KEY).'
    );
  }

  const body = normalized
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '');

  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

async function sha256Base64(content: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', content as unknown as BufferSource);
  return bytesToBase64(new Uint8Array(digest));
}

function getOciSigningKey(privateKeyPem: string): Promise<CryptoKey> {
  if (cachedSigningKeyPromise && cachedSigningKeyPem === privateKeyPem) {
    return cachedSigningKeyPromise;
  }

  cachedSigningKeyPem = privateKeyPem;
  cachedSigningKeyPromise = crypto.subtle.importKey(
    'pkcs8',
    pemToDerBytes(privateKeyPem) as unknown as BufferSource,
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
    },
    false,
    ['sign']
  );

  cachedSigningKeyPromise.catch(() => {
    cachedSigningKeyPem = null;
    cachedSigningKeyPromise = null;
  });

  return cachedSigningKeyPromise;
}

async function signOciRequest(signingString: string, privateKeyPem: string): Promise<string> {
  const key = await getOciSigningKey(privateKeyPem);

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    textEncoder.encode(signingString)
  );

  return bytesToBase64(new Uint8Array(signature));
}

function ensureHttpsUrl(rawInput: string): URL {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    throw new Error('OCI endpoint is required');
  }

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(withScheme);

  if (parsed.protocol !== 'https:') {
    throw new Error('OCI endpoint must use HTTPS');
  }

  return parsed;
}

function deriveControlPlaneEndpointFromSubmissionEndpoint(submissionEndpoint: string): URL {
  const parsedSubmission = ensureHttpsUrl(submissionEndpoint);
  const regionMatch = /\.submit\.email\.([a-z0-9-]+)\.oci\./i.exec(parsedSubmission.host);

  if (!regionMatch || !regionMatch[1]) {
    throw new Error(
      'Unable to derive OCI region from OCI_EMAIL_ENDPOINT. Set OCI_EMAIL_CONTROL_ENDPOINT explicitly.'
    );
  }

  return new URL(`https://ctrl.email.${regionMatch[1]}.oci.oraclecloud.com${OCI_CONTROL_API_VERSION_PATH}/`);
}

function resolveControlPlaneBaseUrl(env: Env): URL {
  if (env.OCI_EMAIL_CONTROL_ENDPOINT && env.OCI_EMAIL_CONTROL_ENDPOINT.trim().length > 0) {
    const explicit = ensureHttpsUrl(env.OCI_EMAIL_CONTROL_ENDPOINT);

    if (explicit.pathname.includes(OCI_CONTROL_API_VERSION_PATH)) {
      return new URL(`${explicit.origin}${explicit.pathname.endsWith('/') ? explicit.pathname : `${explicit.pathname}/`}`);
    }

    return new URL(`${explicit.origin}${OCI_CONTROL_API_VERSION_PATH}/`);
  }

  return deriveControlPlaneEndpointFromSubmissionEndpoint(env.OCI_EMAIL_ENDPOINT);
}

function buildSigningString(
  headerNames: readonly string[],
  values: Record<string, string>
): string {
  return headerNames.map((name) => `${name}: ${values[name]}`).join('\n');
}

async function buildAuthorizationHeader(
  env: Env,
  headerNames: readonly string[],
  values: Record<string, string>
): Promise<string> {
  const signingString = buildSigningString(headerNames, values);
  const signature = await signOciRequest(
    signingString,
    getNormalizedPemPrivateKey(env.OCI_EMAIL_API_PRIVATE_KEY)
  );

  const keyId = getOciKeyId(env);

  return `Signature version="1",keyId="${keyId}",algorithm="rsa-sha256",headers="${headerNames.join(
    ' '
  )}",signature="${signature}"`;
}

async function requestOciEmailControlPlane(
  env: Env,
  options: {
    method: 'GET' | 'POST' | 'DELETE';
    path: string;
    query?: Record<string, string | number | boolean | undefined>;
    headers?: Record<string, string | undefined>;
    body?: unknown;
  }
): Promise<Response> {
  const baseUrl = resolveControlPlaneBaseUrl(env);
  const requestUrl = new URL(options.path.replace(/^\//, ''), baseUrl);

  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined) {
        requestUrl.searchParams.set(key, String(value));
      }
    }
  }

  const xDate = new Date().toUTCString();
  const headers = new Headers({
    Accept: 'application/json',
    'X-Date': xDate,
    'Opc-Request-Id': crypto.randomUUID(),
  });

  const signingValues: Record<string, string> = {
    '(request-target)': `${options.method.toLowerCase()} ${requestUrl.pathname}${requestUrl.search}`,
    host: requestUrl.host,
    'x-date': xDate,
  };

  let bodyText: string | undefined;
  let signedHeaderNames: readonly string[] = SIGNED_HEADERS_NO_BODY;

  if (options.body !== undefined) {
    bodyText = JSON.stringify(options.body);
    const bodyBytes = textEncoder.encode(bodyText);
    const contentLength = String(bodyBytes.byteLength);
    const contentHash = await sha256Base64(bodyBytes);

    headers.set('Content-Type', JSON_CONTENT_TYPE);
    headers.set('Content-Length', contentLength);
    headers.set('X-Content-SHA256', contentHash);

    signingValues['x-content-sha256'] = contentHash;
    signingValues['content-type'] = JSON_CONTENT_TYPE;
    signingValues['content-length'] = contentLength;
    signedHeaderNames = SIGNED_HEADERS_WITH_BODY;
  }

  const authorization = await buildAuthorizationHeader(env, signedHeaderNames, signingValues);
  headers.set('Authorization', authorization);

  if (options.headers) {
    for (const [key, value] of Object.entries(options.headers)) {
      if (value !== undefined) {
        headers.set(key, value);
      }
    }
  }

  return fetch(requestUrl.toString(), {
    method: options.method,
    headers,
    body: bodyText,
  });
}

async function readOciError(response: Response): Promise<string> {
  const raw = await response.text();
  const trimmed = raw.trim();
  if (!trimmed) {
    return response.statusText || 'Unknown OCI error';
  }

  return trimmed;
}

function isSenderDeleted(lifecycleState: string | undefined): boolean {
  const lifecycle = String(lifecycleState ?? '').toUpperCase();
  return lifecycle === 'DELETED' || lifecycle === 'DELETING';
}

async function listSendersPage(
  env: Env,
  options: ListSendersPageOptions
): Promise<ListSendersPageResult> {
  const response = await requestOciEmailControlPlane(env, {
    method: 'GET',
    path: '/senders',
    query: {
      compartmentId: env.OCI_EMAIL_COMPARTMENT_OCID,
      emailAddress: options.emailAddress,
      page: options.page,
      limit: LIST_SENDERS_PAGE_SIZE,
    },
  });

  if (!response.ok) {
    const requestId = response.headers.get('opc-request-id');
    const detail = await readOciError(response);
    console.error('OCI approved sender list failed', {
      emailFilter: options.emailAddress ?? null,
      page: options.page ?? null,
      status: response.status,
      requestId,
      detail,
    });
    throw new Error(`Failed to list approved senders (${response.status}): ${detail}`);
  }

  const payload = (await response.json().catch(() => ({}))) as ListSendersResponseBody;
  const items = Array.isArray(payload.items) ? payload.items : [];
  const nextPage = response.headers.get('opc-next-page');

  return {
    items,
    nextPage: nextPage && nextPage.trim().length > 0 ? nextPage : null,
  };
}

async function findApprovedSenderInPages(
  env: Env,
  normalizedEmailAddress: string,
  options: { emailFilter?: string }
): Promise<SenderSummary | null> {
  const seenPages = new Set<string>();
  let page: string | undefined;

  for (let pageCount = 0; pageCount < LIST_SENDERS_MAX_PAGES; pageCount += 1) {
    const pageResult = await listSendersPage(env, {
      emailAddress: options.emailFilter,
      page,
    });

    for (const item of pageResult.items) {
      const itemEmail = normalizeEmailAddress(String(item.emailAddress ?? ''));
      if (itemEmail !== normalizedEmailAddress || isSenderDeleted(item.lifecycleState)) {
        continue;
      }

      return item;
    }

    if (!pageResult.nextPage || seenPages.has(pageResult.nextPage)) {
      break;
    }

    seenPages.add(pageResult.nextPage);
    page = pageResult.nextPage;
  }

  return null;
}

async function findApprovedSendersInUnfilteredPages(
  env: Env,
  normalizedEmailAddresses: string[]
): Promise<Map<string, SenderSummary>> {
  const remaining = new Set(normalizedEmailAddresses);
  const senderByEmail = new Map<string, SenderSummary>();

  if (remaining.size === 0) {
    return senderByEmail;
  }

  const seenPages = new Set<string>();
  let page: string | undefined;

  for (let pageCount = 0; pageCount < LIST_SENDERS_MAX_PAGES && remaining.size > 0; pageCount += 1) {
    const pageResult = await listSendersPage(env, { page });

    for (const item of pageResult.items) {
      const itemEmail = normalizeEmailAddress(String(item.emailAddress ?? ''));
      if (!remaining.has(itemEmail) || isSenderDeleted(item.lifecycleState)) {
        continue;
      }

      senderByEmail.set(itemEmail, item);
      remaining.delete(itemEmail);
    }

    if (!pageResult.nextPage || seenPages.has(pageResult.nextPage)) {
      break;
    }

    seenPages.add(pageResult.nextPage);
    page = pageResult.nextPage;
  }

  return senderByEmail;
}

async function getApprovedSenderEtag(env: Env, senderId: string): Promise<string | null> {
  const response = await requestOciEmailControlPlane(env, {
    method: 'GET',
    path: `/senders/${encodeURIComponent(senderId)}`,
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const detail = await readOciError(response);
    console.error('OCI approved sender detail lookup failed', {
      senderId,
      status: response.status,
      requestId: response.headers.get('opc-request-id'),
      detail,
    });
    throw new Error(`Failed to get approved sender details for ${senderId} (${response.status}): ${detail}`);
  }

  return response.headers.get('etag');
}

async function deleteApprovedSender(env: Env, senderId: string, etag?: string): Promise<Response> {
  return requestOciEmailControlPlane(env, {
    method: 'DELETE',
    path: `/senders/${encodeURIComponent(senderId)}`,
    query: {
      isLockOverride: true,
    },
    headers: etag
      ? {
          'if-match': etag,
        }
      : undefined,
  });
}

async function ensureApprovedSender(
  env: Env,
  emailAddress: string
): Promise<{ created: boolean; senderId: string | null }> {
  const normalized = normalizeEmailAddress(emailAddress);
  if (!normalized) {
    return { created: false, senderId: null };
  }

  const createResponse = await requestOciEmailControlPlane(env, {
    method: 'POST',
    path: '/senders',
    body: {
      compartmentId: env.OCI_EMAIL_COMPARTMENT_OCID,
      emailAddress: normalized,
    },
  });

  if (createResponse.ok) {
    const payload = (await createResponse.json().catch(() => ({}))) as { id?: string };
    const senderId = typeof payload.id === 'string' && payload.id.trim().length > 0 ? payload.id.trim() : null;

    return {
      created: true,
      senderId,
    };
  }

  if (createResponse.status === 409) {
    return { created: false, senderId: null };
  }

  const detail = await readOciError(createResponse);
  throw new Error(`Failed to create approved sender for ${normalized} (${createResponse.status}): ${detail}`);
}

async function removeApprovedSenderById(
  env: Env,
  normalizedEmailAddress: string,
  sender: SenderSummary
): Promise<void> {
  let response = await deleteApprovedSender(env, sender.id);

  if (response.status === 412 || response.status === 428) {
    const etag = await getApprovedSenderEtag(env, sender.id);
    if (etag === null) {
      return;
    }

    response = await deleteApprovedSender(env, sender.id, etag);
  }

  if (response.ok || response.status === 404) {
    return;
  }

  const detail = await readOciError(response);
  console.error('OCI approved sender delete failed', {
    emailAddress: normalizedEmailAddress,
    senderId: sender.id,
    status: response.status,
    requestId: response.headers.get('opc-request-id'),
    detail,
  });
  throw new Error(
    `Failed to delete approved sender for ${normalizedEmailAddress} (${response.status}): ${detail}`
  );
}

export async function ensureApprovedSenders(env: Env, emailAddresses: string[]): Promise<string[]> {
  const uniqueEmailAddresses = normalizeUniqueEmailAddresses(emailAddresses);
  const settled = await Promise.allSettled(
    uniqueEmailAddresses.map(async (emailAddress) => ({
      emailAddress,
      ...(await ensureApprovedSender(env, emailAddress)),
    }))
  );

  const createdAddresses: string[] = [];
  const cacheEntries: Array<{ emailAddress: string; senderId: string }> = [];
  let firstError: unknown = null;

  for (const result of settled) {
    if (result.status === 'fulfilled') {
      if (result.value.created) {
        createdAddresses.push(result.value.emailAddress);
      }

      if (result.value.senderId) {
        cacheEntries.push({
          emailAddress: result.value.emailAddress,
          senderId: result.value.senderId,
        });
      }

      continue;
    }

    if (firstError === null) {
      firstError = result.reason;
    }
  }

  if (firstError !== null) {
    const message = firstError instanceof Error ? firstError.message : 'Failed to ensure approved senders';
    throw new ApprovedSenderSyncError(message, createdAddresses);
  }

  await upsertSenderCacheEntries(env, cacheEntries);

  return createdAddresses;
}

export async function removeApprovedSenders(env: Env, emailAddresses: string[]): Promise<void> {
  const uniqueEmailAddresses = normalizeUniqueEmailAddresses(emailAddresses);
  if (uniqueEmailAddresses.length === 0) {
    return;
  }

  const senderByEmail = await getCachedSenderMap(env, uniqueEmailAddresses);
  const discoveredSenderEntries: Array<{ emailAddress: string; senderId: string }> = [];
  let unresolvedEmailAddresses = uniqueEmailAddresses.filter((emailAddress) => !senderByEmail.has(emailAddress));

  if (unresolvedEmailAddresses.length > 1) {
    const unfilteredSenderByEmail = await findApprovedSendersInUnfilteredPages(env, unresolvedEmailAddresses);
    unresolvedEmailAddresses = [];

    for (const emailAddress of uniqueEmailAddresses) {
      if (senderByEmail.has(emailAddress)) {
        continue;
      }

      const sender = unfilteredSenderByEmail.get(emailAddress);
      if (sender) {
        senderByEmail.set(emailAddress, sender);
        discoveredSenderEntries.push({ emailAddress, senderId: sender.id });
        continue;
      }

      unresolvedEmailAddresses.push(emailAddress);
    }
  }

  if (unresolvedEmailAddresses.length > 0) {
    const filteredLookupResults = await Promise.all(
      unresolvedEmailAddresses.map(async (emailAddress) => {
        const sender = await findApprovedSenderInPages(env, emailAddress, {
          emailFilter: emailAddress,
        });

        return { emailAddress, sender };
      })
    );

    for (const result of filteredLookupResults) {
      if (result.sender) {
        senderByEmail.set(result.emailAddress, result.sender);
        discoveredSenderEntries.push({
          emailAddress: result.emailAddress,
          senderId: result.sender.id,
        });
      }
    }
  }

  const unresolvedAfterFiltered = uniqueEmailAddresses.filter(
    (emailAddress) => !senderByEmail.has(emailAddress)
  );

  if (unresolvedAfterFiltered.length > 0) {
    // Some OCI tenancies can return incomplete filtered results; do one final
    // unfiltered scan for unresolved addresses before treating them as absent.
    const fallbackSenderByEmail = await findApprovedSendersInUnfilteredPages(env, unresolvedAfterFiltered);

    for (const emailAddress of unresolvedAfterFiltered) {
      const fallbackSender = fallbackSenderByEmail.get(emailAddress);
      if (fallbackSender) {
        senderByEmail.set(emailAddress, fallbackSender);
        discoveredSenderEntries.push({
          emailAddress,
          senderId: fallbackSender.id,
        });
      }
    }
  }

  await upsertSenderCacheEntries(env, discoveredSenderEntries);

  const emailAddressesWithSender = uniqueEmailAddresses.filter((emailAddress) =>
    senderByEmail.has(emailAddress)
  );

  if (emailAddressesWithSender.length === 0) {
    await deleteSenderCacheEntries(env, uniqueEmailAddresses);
    return;
  }

  const settled = await Promise.allSettled(
    emailAddressesWithSender.map(async (emailAddress) => {
      await removeApprovedSenderById(env, emailAddress, senderByEmail.get(emailAddress) as SenderSummary);
      return emailAddress;
    })
  );

  const removedEmailAddresses: string[] = [];
  let firstError: unknown = null;

  for (const result of settled) {
    if (result.status === 'fulfilled') {
      removedEmailAddresses.push(result.value);
      continue;
    }

    if (firstError === null) {
      firstError = result.reason;
    }
  }

  await deleteSenderCacheEntries(env, removedEmailAddresses);

  if (firstError !== null) {
    throw firstError instanceof Error
      ? firstError
      : new Error('Failed to remove one or more OCI approved senders');
  }
}
