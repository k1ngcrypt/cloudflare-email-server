import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/index';
import { removeApprovedSenders } from '../src/oracle-approved-senders';

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
    OCI_EMAIL_ENDPOINT: 'https://cell0.submit.email.ca-montreal-1.oci.oraclecloud.com',
    OCI_EMAIL_CONTROL_ENDPOINT: 'https://ctrl.email.ca-montreal-1.oci.oraclecloud.com/20170907',
    OCI_EMAIL_COMPARTMENT_OCID: 'ocid1.compartment.oc1..exampleuniqueID',
    OCI_EMAIL_API_TENANCY_OCID: 'ocid1.tenancy.oc1..exampletenancy',
    OCI_EMAIL_API_USER_OCID: 'ocid1.user.oc1..exampleuser',
    OCI_EMAIL_API_KEY_FINGERPRINT: '20:3b:97:13:55:1c:cb:2f:00:c8:d1:61:47:bf:5f:65',
    OCI_EMAIL_API_PRIVATE_KEY: TEST_PRIVATE_KEY,
    AUTH_SECRET: 'test-auth-secret',
  };
}

function jsonResponse(
  payload: unknown,
  options: { status?: number; headers?: Record<string, string> } = {}
): Response {
  return new Response(JSON.stringify(payload), {
    status: options.status ?? 200,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
  });
}

describe('removeApprovedSenders', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to unfiltered pagination and deletes with lock override when filtered lookup misses', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      );
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

      if (method === 'GET' && requestUrl.pathname.endsWith('/senders')) {
        const emailAddress = requestUrl.searchParams.get('emailAddress');
        const page = requestUrl.searchParams.get('page');

        if (emailAddress) {
          return jsonResponse({ items: [] });
        }

        if (!page) {
          return jsonResponse(
            {
              items: [
                {
                  id: 'ocid1.sender.oc1..someoneelse',
                  emailAddress: 'someoneelse@example.test',
                  lifecycleState: 'ACTIVE',
                },
              ],
            },
            {
              headers: {
                'opc-next-page': 'page-token-2',
              },
            }
          );
        }

        if (page === 'page-token-2') {
          return jsonResponse({
            items: [
              {
                id: 'ocid1.sender.oc1..target',
                emailAddress: 'alias@example.test',
                lifecycleState: 'ACTIVE',
              },
            ],
          });
        }
      }

      if (method === 'DELETE' && requestUrl.pathname.endsWith('/senders/ocid1.sender.oc1..target')) {
        expect(requestUrl.searchParams.get('isLockOverride')).toBe('true');
        return new Response(null, { status: 204 });
      }

      return new Response('unexpected request', { status: 500 });
    });

    await removeApprovedSenders(makeEnv(), ['Alias@example.test']);

    const requestUrls = fetchMock.mock.calls.map((call) =>
      new URL(String(call[0] instanceof Request ? call[0].url : call[0]))
    );

    expect(
      requestUrls.some(
        (url) =>
          url.pathname.endsWith('/senders') &&
          url.searchParams.get('emailAddress') === 'alias@example.test'
      )
    ).toBe(true);
    expect(requestUrls.some((url) => url.searchParams.get('page') === 'page-token-2')).toBe(true);
    expect(requestUrls.some((url) => url.pathname.endsWith('/senders/ocid1.sender.oc1..target'))).toBe(true);
  });
});
