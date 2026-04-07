import { createMimeMessage } from 'mimetext';
import type { Env } from './index';

export interface SendAttachment {
  filename: string;
  content: string;
  mimeType?: string;
}

interface SendOptions {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: SendAttachment[];
}

const OCI_SUBMIT_RAW_EMAIL_PATH = '/20220926/actions/submitRawEmail';
const OCI_RAW_CONTENT_TYPE = 'message/rfc822';
const OCI_SIGNED_HEADERS = [
  '(request-target)',
  'host',
  'x-date',
  'x-content-sha256',
  'content-type',
  'content-length',
] as const;

type OciSignedHeader = (typeof OCI_SIGNED_HEADERS)[number];

const textEncoder = new TextEncoder();
let cachedSigningKeyPem: string | null = null;
let cachedSigningKeyPromise: Promise<CryptoKey> | null = null;

function normalizePemPrivateKey(input: string): string {
  const trimmed = input.trim();
  if (trimmed.includes('\\n')) {
    return trimmed.replace(/\\n/g, '\n');
  }

  return trimmed;
}

function resolveOciSubmitUrl(endpoint: string): URL {
  const trimmed = endpoint.trim();
  if (!trimmed) {
    throw new Error('OCI_EMAIL_ENDPOINT is required');
  }

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const endpointUrl = new URL(withScheme);
  if (endpointUrl.protocol !== 'https:') {
    throw new Error('OCI email endpoint must use HTTPS');
  }

  return new URL(OCI_SUBMIT_RAW_EMAIL_PATH, `${endpointUrl.origin}/`);
}

function parseRecipientList(rawRecipients: string): string[] {
  const recipients = rawRecipients
    .split(/[;,]/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (recipients.length === 0) {
    throw new Error('At least one recipient address is required');
  }

  if (recipients.length > 50) {
    throw new Error('OCI Email Delivery supports up to 50 recipients per message');
  }

  return recipients;
}

function buildRawMessage(opts: SendOptions, recipients: string[]): string {
  const mimeMessage = createMimeMessage();
  mimeMessage.setSender({ addr: opts.from, name: 'Webmail' });
  mimeMessage.setTo(recipients.map((email) => ({ addr: email })));
  mimeMessage.setSubject(opts.subject);

  mimeMessage.addMessage({
    contentType: 'text/plain',
    data: opts.text,
    charset: 'UTF-8',
  });

  if (opts.html) {
    mimeMessage.addMessage({
      contentType: 'text/html',
      data: opts.html,
      charset: 'UTF-8',
    });
  }

  for (const attachment of opts.attachments ?? []) {
    mimeMessage.addAttachment({
      filename: attachment.filename,
      contentType: attachment.mimeType ?? 'application/octet-stream',
      data: attachment.content,
      encoding: 'base64',
    });
  }

  return mimeMessage.asRaw();
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

async function sha256Base64(content: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', content as unknown as BufferSource);
  return toBase64(new Uint8Array(digest));
}

function buildSigningString(values: Record<OciSignedHeader, string>): string {
  return OCI_SIGNED_HEADERS.map((header) => `${header}: ${values[header]}`).join('\n');
}

function pemToDerBytes(privateKeyPem: string): Uint8Array {
  const normalized = privateKeyPem.trim();

  if (normalized.includes('BEGIN RSA PRIVATE KEY')) {
    throw new Error(
      'OCI_EMAIL_API_PRIVATE_KEY must be PKCS#8 PEM (BEGIN PRIVATE KEY). Convert with: openssl pkcs8 -topk8 -nocrypt -in rsa_private.pem -out private_key.pem'
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
  return toBase64(new Uint8Array(signature));
}

export async function sendEmail(env: Env, opts: SendOptions): Promise<void> {
  const recipients = parseRecipientList(opts.to);
  const submitUrl = resolveOciSubmitUrl(env.OCI_EMAIL_ENDPOINT);
  const rawMessage = buildRawMessage(opts, recipients);
  const rawMessageBytes = textEncoder.encode(rawMessage);
  const contentLength = String(rawMessageBytes.byteLength);
  const xDate = new Date().toUTCString();
  const contentHash = await sha256Base64(rawMessageBytes);

  const signedValues: Record<OciSignedHeader, string> = {
    '(request-target)': `post ${submitUrl.pathname}${submitUrl.search}`,
    host: submitUrl.host,
    'x-date': xDate,
    'x-content-sha256': contentHash,
    'content-type': OCI_RAW_CONTENT_TYPE,
    'content-length': contentLength,
  };

  const signingString = buildSigningString(signedValues);
  const signature = await signOciRequest(
    signingString,
    normalizePemPrivateKey(env.OCI_EMAIL_API_PRIVATE_KEY)
  );
  const keyId = `${env.OCI_EMAIL_API_TENANCY_OCID}/${env.OCI_EMAIL_API_USER_OCID}/${env.OCI_EMAIL_API_KEY_FINGERPRINT}`;
  const authorization = `Signature version="1",keyId="${keyId}",algorithm="rsa-sha256",headers="${OCI_SIGNED_HEADERS.join(
    ' '
  )}",signature="${signature}"`;

  const response = await fetch(submitUrl.toString(), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'Compartment-Id': env.OCI_EMAIL_COMPARTMENT_OCID,
      'Content-Length': contentLength,
      'Content-Type': OCI_RAW_CONTENT_TYPE,
      'Opc-Request-Id': crypto.randomUUID(),
      Recipients: recipients.join(','),
      Sender: opts.from,
      'X-Content-SHA256': contentHash,
      'X-Date': xDate,
    },
    body: rawMessage,
  });

  if (!response.ok) {
    const responseText = await response.text();
    const detail = responseText.trim().length > 0 ? responseText : response.statusText;
    throw new Error(`OCI HTTPS send failed (${response.status}): ${detail}`);
  }
}
