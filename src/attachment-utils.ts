export function sanitizeFilename(filename: string): string {
  const trimmed = filename.trim();
  const safe = trimmed.replace(/[\\/:*?"<>|\u0000-\u001F]+/g, '_').replace(/\s+/g, ' ');
  if (!safe) return 'attachment';
  return safe.slice(0, 180);
}

export function normalizeAttachmentContent(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith('data:')) {
    return trimmed;
  }

  const comma = trimmed.indexOf(',');
  return comma === -1 ? '' : trimmed.slice(comma + 1).trim();
}

export function decodeBase64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function normalizeMimeType(mimeType: unknown): string {
  if (typeof mimeType !== 'string') {
    return 'application/octet-stream';
  }

  const trimmed = mimeType.trim();
  return trimmed.length > 0 ? trimmed : 'application/octet-stream';
}

export function escapeQuotedHeaderValue(value: string): string {
  return value.replace(/["\\\r\n]/g, '_');
}
