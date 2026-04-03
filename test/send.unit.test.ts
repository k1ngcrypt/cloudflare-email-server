import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/index';

import { sendEmail } from '../src/send';

const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDLoqe/sMOgzmH7
y9hMCMtpvcuX9NBnCY05a1gmNaiHuTXja8EgmlUbTqdW0Yv5rTkJb3jR+QebyfbU
aguNVAsjhFyFlXJFDdS866Be88gJyX2PlO9csyC05YOu7/6OgAR9dR9Ovf5lDOLZ
OTWKDIhMSdQwBK341VMtV7BGxUz64+qPrWsiG8bs+xzcXulvW9MQM5lQoGqCBR3/
7xYL3SHOUenYFRqEzkKRWTm6/g4T33bZ8xnd9GKdyoqom/XdINmXGolIETwkbiM3
s6Yn7/9Ysf+U44y8iayRq43hKtc6wbaOUoPrVzopY+gSGC8mGnJ6r9Tswb1uNFXg
wcUl69svAgMBAAECggEAGdtf1OMGGX97SPS7qf6dOE0QSA2e/3u4Af1+ZkOpUFU/
4Xkc6ciPBqD4dflfqRF0zPI+84fdOSFDr/nTLlvomixEGfY9r0UFVAPQtkiFiFtH
D+9HwYvr8EG1ydsm20NSzqILmqeyC3S/wqNqsp/KwsfGeLPEv3RJqS1ERd2RsR2m
SLqNKHHTYLysud67grpuzwmIyD8sSOgtQPskQ1yJngr8QbuMo08HO01iAi2Whkhg
oc6/lWrDiAtzSl+yabsH78fJvOxpynXYxu/zHI28aB9Yu7sxbjUrjVKpfEdo3Eup
j2FWHXgmr5SzJXjEPYA9JMPk9DlmYLenR4ZOzdOaiQKBgQDtf4ILjZMVTEPlE8vJ
nCnAG4TZ4YD7a6Hc/CK8qECIBPfLLl2UF28FCFHA4JPVVBOUip/UlmyhUcLeujF0
VLf0jA3A6VzIjSlrmi3RN3qBmAlXRr/G4EJBQatcr8He05/PXtpS0vImqZ8wERIP
mLQ7LEPT4dwW5mgNFRtiNn8cSwKBgQDbf9BMMxj6ZVoDFxFlHrh9/I7CfyGXbPYX
ZdaV9NRtFIdXr5P+HDV1L40gyCIxqDwkHdtYGfBhwLcAIp8Q7UdH6UUyS8qMVqq4
ZBtWu9P54Cr0J4DrIgqZBYGrZ/9I3hufIHM2o3yqqrOp9ePvD7+IO8x+9mCiC7Ll
CSCT2CpmLQKBgCXz72s7N5r6sgrki/du7jkV7LgI0lzbSWWQIVj2pkFWUeb1RN0K
laI/PxlMijNYGTzunjYRx9BLyZFgPdDyTOdWjkgawsoFzO22GMZLUFdvXWbGFpWI
du4IuYK5T4j1Vp+D7+22ah4FkzvSLomxhHPEUh6FBG/gaBZXHiYmwU9bAoGAIILW
7GJpIbVfVrPU/MBHHUoKLx67b/1QmfiYhw+DY0C2JzO3XNz6wgewBJoADpDXj5Xo
hi0ZYLE1qcx2+P/cHfecKy30q0Ku+K7DKd6aMBmW4yDyxGD/Ztjc8vFta3KSbshU
qFQgw/qSr+revur7OId665c8iuPmtGvcqmlLJmUCgYAvHlOcCNSt7wsitDZFx+2e
0p8y9ApDRo5tMKnzi69+qvqJ551lNb+87I819LveyX+6LDc0WuiOv2FXrqC6qjOS
672GVmfixhO1KDTpyvVHG+IjZd5Q+pp6jrcECudicl516OiWoEOYlvXINgOyJ/Sy
+IkC3harclnwreyqqfVQFg==
-----END PRIVATE KEY-----`;

const fetchMock = vi.fn();

function makeEnv(): Env {
  return {
    DB: {} as D1Database,
    ATTACHMENTS: {} as R2Bucket,
    FROM_DOMAIN: 'mail.example.test',
    OCI_EMAIL_ENDPOINT: 'https://cell0.submit.email.ca-montreal-1.oci.oraclecloud.com',
    OCI_EMAIL_COMPARTMENT_OCID: 'ocid1.compartment.oc1..exampleuniqueID',
    OCI_EMAIL_API_TENANCY_OCID: 'ocid1.tenancy.oc1..exampletenancy',
    OCI_EMAIL_API_USER_OCID: 'ocid1.user.oc1..exampleuser',
    OCI_EMAIL_API_KEY_FINGERPRINT: '20:3b:97:13:55:1c:cb:2f:00:c8:d1:61:47:bf:5f:65',
    OCI_EMAIL_API_PRIVATE_KEY: TEST_PRIVATE_KEY,
    AUTH_SECRET: 'test-auth-secret',
  };
}

describe('sendEmail', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('submits signed MIME content to the OCI HTTPS endpoint', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ envelopeId: 'env-123', suppressedRecipients: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await sendEmail(makeEnv(), {
      from: 'sender@mail.example.test',
      to: 'recipient@example.net',
      subject: 'Integration Subject',
      text: 'Plain body',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://cell0.submit.email.ca-montreal-1.oci.oraclecloud.com/20220926/actions/submitRawEmail'
    );
    expect(init.method).toBe('POST');

    const headers = new Headers(init.headers);
    expect(headers.get('Content-Type')).toBe('message/rfc822');
    expect(headers.get('Compartment-Id')).toBe('ocid1.compartment.oc1..exampleuniqueID');
    expect(headers.get('Sender')).toBe('sender@mail.example.test');
    expect(headers.get('Recipients')).toBe('recipient@example.net');
    expect(headers.get('Authorization')).toContain('Signature version="1"');
    expect(headers.get('Authorization')).toContain('algorithm="rsa-sha256"');
    expect(headers.get('X-Date')).toBeTruthy();
    expect(headers.get('X-Content-SHA256')).toBeTruthy();

    const rawMime = init.body as string;
    expect(rawMime).toContain('Subject:');
    expect(rawMime).toContain('sender@mail.example.test');
    expect(rawMime).toContain('recipient@example.net');
    expect(rawMime).toContain('Plain body');
  });

  it('includes optional html and attachments in the raw MIME body', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ envelopeId: 'env-456', suppressedRecipients: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await sendEmail(makeEnv(), {
      from: 'sender@mail.example.test',
      to: 'recipient@example.net',
      subject: 'Attachment Subject',
      text: 'Plain body',
      html: '<p>HTML body</p>',
      attachments: [
        {
          filename: 'proof.txt',
          content: 'YQ==',
          mimeType: 'text/plain',
        },
      ],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const rawMime = init.body as string;
    expect(rawMime).toContain('Content-Type: text/html');
    expect(rawMime).toContain('<p>HTML body</p>');
    expect(rawMime).toContain('Content-Disposition: attachment; filename="proof.txt"');
    expect(rawMime).toContain('Content-Transfer-Encoding: base64');
    expect(rawMime).toContain('YQ==');
  });

  it('surfaces OCI API errors', async () => {
    fetchMock.mockResolvedValue(new Response('bad request', { status: 400, statusText: 'Bad Request' }));

    await expect(
      sendEmail(makeEnv(), {
        from: 'sender@mail.example.test',
        to: 'recipient@example.net',
        subject: 'Failure Subject',
        text: 'Body',
      })
    ).rejects.toThrow('OCI HTTPS send failed (400): bad request');
  });
});