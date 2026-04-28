import { createMimeMessage } from 'mimetext';
import {
  bytesToBase64,
  createCachedRsaSigningKeyImporter,
  normalizePemPrivateKey,
  sha256Base64,
} from './crypto-utils';
import type { Env } from './index';
import { normalizeMimeType } from './attachment-utils';

export interface SendAttachment {
  filename: string;
  content: string;
  mimeType?: string;
}

interface SendOptions {
  from: string;
  fromName: string;
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
const getOciSigningKey = createCachedRsaSigningKeyImporter();

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
  mimeMessage.setSender({ addr: opts.from, name: opts.fromName });
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
      contentType: normalizeMimeType(attachment.mimeType),
      data: attachment.content,
      encoding: 'base64',
    });
  }

  return mimeMessage.asRaw();
}

function buildSigningString(values: Record<OciSignedHeader, string>): string {
  return OCI_SIGNED_HEADERS.map((header) => `${header}: ${values[header]}`).join('\n');
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
