import type { Env } from './index';

const OCI_CONTROL_API_VERSION_PATH = '/20170907';
const JSON_CONTENT_TYPE = 'application/json';

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
}

export interface EnsureApprovedSendersResult {
  createdAddresses: string[];
  senderIdByEmail: Map<string, string>;
}

interface RemoveApprovedSendersOptions {
  senderIdByEmail?: ReadonlyMap<string, string | null | undefined>;
}

export class ApprovedSenderSyncError extends Error {
  readonly createdAddresses: string[];
  readonly createdSenderIdByEmail: ReadonlyMap<string, string>;

  constructor(
    message: string,
    createdAddresses: string[],
    createdSenderIdByEmail: ReadonlyMap<string, string> = new Map<string, string>()
  ) {
    super(message);
    this.name = 'ApprovedSenderSyncError';
    this.createdAddresses = createdAddresses;
    this.createdSenderIdByEmail = createdSenderIdByEmail;
  }
}

const textEncoder = new TextEncoder();
let cachedSigningKeyPem: string | null = null;
let cachedSigningKeyPromise: Promise<CryptoKey> | null = null;
let cachedNormalizedPrivateKeyRaw: string | null = null;
let cachedNormalizedPrivateKey: string | null = null;
let cachedKeyIdParts: string | null = null;
let cachedKeyId: string | null = null;

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
): Promise<{ emailAddress: string; senderId: string }> {
  const normalized = normalizeEmailAddress(emailAddress);
  if (!normalized) {
    throw new Error('Email address is required for OCI approved sender creation');
  }

  const createResponse = await requestOciEmailControlPlane(env, {
    method: 'POST',
    path: '/senders',
    body: {
      compartmentId: env.OCI_EMAIL_COMPARTMENT_OCID,
      emailAddress: normalized,
    },
  });

  if (!createResponse.ok) {
    const detail = await readOciError(createResponse);
    if (createResponse.status === 409) {
      throw new Error(
        `Approved sender already exists for ${normalized} but OCI did not return an OCID. Remove the stale sender and retry.`
      );
    }

    throw new Error(`Failed to create approved sender for ${normalized} (${createResponse.status}): ${detail}`);
  }

  const payload = (await createResponse.json().catch(() => ({}))) as { id?: string };
  const senderId = typeof payload.id === 'string' ? payload.id.trim() : '';
  if (!senderId) {
    throw new Error(`OCI create sender response for ${normalized} did not include an id (OCID)`);
  }

  return {
    emailAddress: normalized,
    senderId,
  };
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

export async function ensureApprovedSenders(
  env: Env,
  emailAddresses: string[]
): Promise<EnsureApprovedSendersResult> {
  const uniqueEmailAddresses = normalizeUniqueEmailAddresses(emailAddresses);
  const settled = await Promise.allSettled(uniqueEmailAddresses.map((emailAddress) => ensureApprovedSender(env, emailAddress)));

  const createdAddresses: string[] = [];
  const senderIdByEmail = new Map<string, string>();
  let firstError: unknown = null;

  for (const result of settled) {
    if (result.status === 'fulfilled') {
      createdAddresses.push(result.value.emailAddress);
      senderIdByEmail.set(result.value.emailAddress, result.value.senderId);

      continue;
    }

    if (firstError === null) {
      firstError = result.reason;
    }
  }

  if (firstError !== null) {
    const message = firstError instanceof Error ? firstError.message : 'Failed to ensure approved senders';
    throw new ApprovedSenderSyncError(message, createdAddresses, senderIdByEmail);
  }

  return {
    createdAddresses,
    senderIdByEmail,
  };
}

export async function removeApprovedSenders(
  env: Env,
  emailAddresses: string[],
  options: RemoveApprovedSendersOptions = {}
): Promise<void> {
  const uniqueEmailAddresses = normalizeUniqueEmailAddresses(emailAddresses);
  if (uniqueEmailAddresses.length === 0) {
    return;
  }

  const senderByEmail = new Map<string, SenderSummary>();
  if (options.senderIdByEmail) {
    for (const [rawEmailAddress, rawSenderId] of options.senderIdByEmail.entries()) {
      const emailAddress = normalizeEmailAddress(rawEmailAddress);
      const senderId = String(rawSenderId ?? '').trim();
      if (!emailAddress || !senderId) {
        continue;
      }

      senderByEmail.set(emailAddress, {
        id: senderId,
        emailAddress,
      });
    }
  }

  const missingSenderIdEmails = uniqueEmailAddresses.filter(
    (emailAddress) => !senderByEmail.has(emailAddress)
  );

  if (missingSenderIdEmails.length > 0) {
    throw new Error(
      `Missing OCI sender OCID in DB for: ${missingSenderIdEmails.join(', ')}`
    );
  }

  const settled = await Promise.allSettled(
    uniqueEmailAddresses.map(async (emailAddress) => {
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

  if (firstError !== null) {
    throw firstError instanceof Error
      ? firstError
      : new Error('Failed to remove one or more OCI approved senders');
  }
}
