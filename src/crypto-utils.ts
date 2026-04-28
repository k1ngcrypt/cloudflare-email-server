const DEFAULT_RSA_PRIVATE_KEY_MESSAGE =
  'OCI_EMAIL_API_PRIVATE_KEY must be PKCS#8 PEM (BEGIN PRIVATE KEY). Convert with: openssl pkcs8 -topk8 -nocrypt -in rsa_private.pem -out private_key.pem';

type PemToDerOptions = {
  invalidRsaMessage?: string;
};

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export async function sha256Base64(content: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', content as unknown as BufferSource);
  return bytesToBase64(new Uint8Array(digest));
}

export function normalizePemPrivateKey(input: string): string {
  const trimmed = input.trim();
  if (trimmed.includes('\\n')) {
    return trimmed.replace(/\\n/g, '\n');
  }

  return trimmed;
}

export function pemToDerBytes(privateKeyPem: string, options: PemToDerOptions = {}): Uint8Array {
  const normalized = privateKeyPem.trim();

  if (normalized.includes('BEGIN RSA PRIVATE KEY')) {
    throw new Error(options.invalidRsaMessage ?? DEFAULT_RSA_PRIVATE_KEY_MESSAGE);
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

export function createCachedRsaSigningKeyImporter(
  options: PemToDerOptions = {}
): (privateKeyPem: string) => Promise<CryptoKey> {
  let cachedSigningKeyPem: string | null = null;
  let cachedSigningKeyPromise: Promise<CryptoKey> | null = null;

  return (privateKeyPem: string): Promise<CryptoKey> => {
    if (cachedSigningKeyPromise && cachedSigningKeyPem === privateKeyPem) {
      return cachedSigningKeyPromise;
    }

    cachedSigningKeyPem = privateKeyPem;
    cachedSigningKeyPromise = crypto.subtle.importKey(
      'pkcs8',
      pemToDerBytes(privateKeyPem, options) as unknown as BufferSource,
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
  };
}
