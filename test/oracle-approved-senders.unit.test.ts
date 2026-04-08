import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/index';
import { ensureApprovedSenders, removeApprovedSenders } from '../src/oracle-approved-senders';

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

describe('removeApprovedSenders', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('deletes directly by provided sender OCID', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      );
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

      if (method === 'DELETE' && requestUrl.pathname.endsWith('/senders/ocid1.sender.oc1..direct')) {
        expect(requestUrl.searchParams.get('isLockOverride')).toBe('true');
        return new Response(null, { status: 204 });
      }

      return new Response('unexpected request', { status: 500 });
    });

    await removeApprovedSenders(
      makeEnv(),
      ['Alias@example.test'],
      {
        senderIdByEmail: new Map([['alias@example.test', 'ocid1.sender.oc1..direct']]),
      }
    );

    const requests = fetchMock.mock.calls.map((call) => {
      const input = call[0] as RequestInfo | URL;
      const init = call[1] as RequestInit | undefined;
      const requestUrl = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      );
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      return { requestUrl, method };
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('DELETE');
    expect(requests[0].requestUrl.pathname.endsWith('/senders/ocid1.sender.oc1..direct')).toBe(true);
  });

  it('fails when sender OCID is missing for a requested address', async () => {
    await expect(
      removeApprovedSenders(makeEnv(), ['alias@example.test'], {
        senderIdByEmail: new Map(),
      })
    ).rejects.toThrow('Missing OCI sender OCID in DB');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries delete with if-match when OCI requires a precondition', async () => {
    let deleteAttempts = 0;

    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      );
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

      if (method === 'DELETE' && requestUrl.pathname.endsWith('/senders/ocid1.sender.oc1..target')) {
        deleteAttempts += 1;
        const headers = new Headers(init?.headers);

        if (deleteAttempts === 1) {
          expect(headers.get('if-match')).toBeNull();
          return new Response('precondition required', { status: 412 });
        }

        expect(headers.get('if-match')).toBe('W/"sender-etag-1"');
        return new Response(null, { status: 204 });
      }

      if (method === 'GET' && requestUrl.pathname.endsWith('/senders/ocid1.sender.oc1..target')) {
        return new Response(null, {
          status: 200,
          headers: {
            etag: 'W/"sender-etag-1"',
          },
        });
      }

      return new Response('unexpected request', { status: 500 });
    });

    await removeApprovedSenders(makeEnv(), ['Alias@example.test'], {
      senderIdByEmail: new Map([['alias@example.test', 'ocid1.sender.oc1..target']]),
    });

    expect(deleteAttempts).toBe(2);

    const detailLookupCount = fetchMock.mock.calls.filter((call) => {
      const input = call[0] as RequestInfo | URL;
      const init = call[1] as RequestInit | undefined;
      const requestUrl = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      );
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      return method === 'GET' && requestUrl.pathname.endsWith('/senders/ocid1.sender.oc1..target');
    }).length;

    expect(detailLookupCount).toBe(1);
  });
});

describe('ensureApprovedSenders', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stores sender OCID from create response body id', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      );
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

      if (method === 'POST' && requestUrl.pathname.endsWith('/senders')) {
        return new Response(
          JSON.stringify({
            id: 'ocid1.sender.oc1.iad.aaaaaaaaexample',
            compartmentId: 'ocid1.compartment.oc1..aaaa',
            emailAddress: 'alias@example.test',
            lifecycleState: 'ACTIVE',
          }),
          {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
            },
          }
        );
      }

      return new Response('unexpected request', { status: 500 });
    });

    const result = await ensureApprovedSenders(makeEnv(), ['Alias@example.test']);

    expect(result.createdAddresses).toEqual(['alias@example.test']);
    expect(result.senderIdByEmail.get('alias@example.test')).toBe('ocid1.sender.oc1.iad.aaaaaaaaexample');
  });

  it('fails if create response omits sender id', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      );
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

      if (method === 'POST' && requestUrl.pathname.endsWith('/senders')) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        });
      }

      return new Response('unexpected request', { status: 500 });
    });

    await expect(ensureApprovedSenders(makeEnv(), ['Alias@example.test'])).rejects.toThrow(
      'did not include an id'
    );
  });
});
