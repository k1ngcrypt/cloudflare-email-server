import type { Env } from './index';

const OCI_CONTROL_API_VERSION_PATH = '/20170907';
const JSON_CONTENT_TYPE = 'application/json';
const LIST_SENDERS_PAGE_SIZE = 100;
const LIST_SENDERS_MAX_PAGES = 50;

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
  requestId: string | null;
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
    normalizePemPrivateKey(env.OCI_EMAIL_API_PRIVATE_KEY)
  );

  const keyId = `${env.OCI_EMAIL_API_TENANCY_OCID}/${env.OCI_EMAIL_API_USER_OCID}/${env.OCI_EMAIL_API_KEY_FINGERPRINT}`;

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
    const bodyBytes = new TextEncoder().encode(bodyText);
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
  const requestId = response.headers.get('opc-request-id');

  console.info('OCI approved sender list page loaded', {
    emailFilter: options.emailAddress ?? null,
    page: options.page ?? null,
    itemCount: items.length,
    nextPage: nextPage && nextPage.trim().length > 0 ? nextPage : null,
    requestId,
  });

  return {
    items,
    nextPage: nextPage && nextPage.trim().length > 0 ? nextPage : null,
    requestId,
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

      console.info('OCI approved sender lookup matched sender', {
        emailAddress: normalizedEmailAddress,
        senderId: item.id,
        lifecycleState: item.lifecycleState ?? null,
        page: page ?? null,
        requestId: pageResult.requestId,
      });

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

async function findApprovedSenderByEmail(env: Env, emailAddress: string): Promise<SenderSummary | null> {
  const normalized = normalizeEmailAddress(emailAddress);
  if (!normalized) {
    return null;
  }

  const filteredMatch = await findApprovedSenderInPages(env, normalized, {
    emailFilter: normalized,
  });
  if (filteredMatch) {
    return filteredMatch;
  }

  console.warn('OCI approved sender filtered lookup missed; falling back to unfiltered scan', {
    emailAddress: normalized,
  });

  // Some OCI tenancies can return incomplete filtered results; fall back to
  // scanning pages without an email filter before concluding the sender is absent.
  const fallbackMatch = await findApprovedSenderInPages(env, normalized, {});
  if (!fallbackMatch) {
    console.warn('OCI approved sender lookup found no matching sender', {
      emailAddress: normalized,
    });
  }

  return fallbackMatch;
}

async function ensureApprovedSender(env: Env, emailAddress: string): Promise<boolean> {
  const normalized = normalizeEmailAddress(emailAddress);
  if (!normalized) {
    return false;
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
    return true;
  }

  if (createResponse.status === 409) {
    return false;
  }

  const detail = await readOciError(createResponse);
  throw new Error(`Failed to create approved sender for ${normalized} (${createResponse.status}): ${detail}`);
}

async function removeApprovedSender(env: Env, emailAddress: string): Promise<void> {
  const normalized = normalizeEmailAddress(emailAddress);
  if (!normalized) {
    return;
  }

  console.info('OCI approved sender removal starting', {
    emailAddress: normalized,
  });

  const sender = await findApprovedSenderByEmail(env, normalized);
  if (!sender) {
    console.warn('OCI approved sender removal skipped because sender was not found', {
      emailAddress: normalized,
    });
    return;
  }

  const response = await requestOciEmailControlPlane(env, {
    method: 'DELETE',
    path: `/senders/${encodeURIComponent(sender.id)}`,
    query: {
      isLockOverride: true,
    },
  });

  const deleteRequestId = response.headers.get('opc-request-id');
  console.info('OCI approved sender delete response received', {
    emailAddress: normalized,
    senderId: sender.id,
    status: response.status,
    requestId: deleteRequestId,
  });

  if (response.ok || response.status === 404) {
    return;
  }

  const detail = await readOciError(response);
  console.error('OCI approved sender delete failed', {
    emailAddress: normalized,
    senderId: sender.id,
    status: response.status,
    requestId: deleteRequestId,
    detail,
  });
  throw new Error(`Failed to delete approved sender for ${normalized} (${response.status}): ${detail}`);
}

export async function ensureApprovedSenders(env: Env, emailAddresses: string[]): Promise<string[]> {
  const uniqueEmailAddresses = normalizeUniqueEmailAddresses(emailAddresses);
  const settled = await Promise.allSettled(
    uniqueEmailAddresses.map(async (emailAddress) => ({
      emailAddress,
      created: await ensureApprovedSender(env, emailAddress),
    }))
  );

  const createdAddresses: string[] = [];
  let firstError: unknown = null;

  for (const result of settled) {
    if (result.status === 'fulfilled') {
      if (result.value.created) {
        createdAddresses.push(result.value.emailAddress);
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

  return createdAddresses;
}

export async function removeApprovedSenders(env: Env, emailAddresses: string[]): Promise<void> {
  const uniqueEmailAddresses = normalizeUniqueEmailAddresses(emailAddresses);
  console.info('OCI approved sender batch removal starting', {
    requestedCount: emailAddresses.length,
    uniqueCount: uniqueEmailAddresses.length,
    emails: uniqueEmailAddresses,
  });
  await Promise.all(uniqueEmailAddresses.map((emailAddress) => removeApprovedSender(env, emailAddress)));
  console.info('OCI approved sender batch removal completed', {
    removedCount: uniqueEmailAddresses.length,
    emails: uniqueEmailAddresses,
  });
}
