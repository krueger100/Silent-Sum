import {
  CallableClient,
  CallableError,
  type CallableFetch,
  type CallableHttpResponse,
} from '@/firebase/callableClient';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function respond(status: number, body: string): CallableHttpResponse {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

function rig(
  responder: (call: Recorded) => CallableHttpResponse | Promise<CallableHttpResponse>,
  tokens: { id?: string | null; appCheck?: string | null } = {},
): { client: CallableClient; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl: CallableFetch = async (url, init) => {
    const call: Recorded = {
      url,
      method: init.method,
      headers: init.headers,
      body: JSON.parse(init.body),
    };
    calls.push(call);
    return responder(call);
  };
  const client = new CallableClient({
    baseUrl: 'https://us-central1-example.cloudfunctions.net/',
    tokens: {
      idToken: async () => tokens.id ?? null,
      appCheckToken: async () => tokens.appCheck ?? null,
    },
    fetchImpl,
  });
  return { client, calls };
}

async function codeOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return error instanceof CallableError ? error.code : `not-a-callable-error: ${String(error)}`;
  }
  return 'did-not-throw';
}

describe('CallableClient', () => {
  it('speaks the callable protocol: POST {data} with the identity and App Check headers', async () => {
    const { client, calls } = rig(() => respond(200, JSON.stringify({ result: { ok: true } })), {
      id: 'id-token',
      appCheck: 'app-check-token',
    });

    const result = await client.call<{ ok: boolean }>('silentsumCreateCheckout', {
      product: 'pro',
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: 'https://us-central1-example.cloudfunctions.net/silentsumCreateCheckout',
      method: 'POST',
      body: { data: { product: 'pro' } },
    });
    expect(calls[0]?.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer id-token',
      'X-Firebase-AppCheck': 'app-check-token',
    });
  });

  it('sends no identity headers it does not have', async () => {
    const { client, calls } = rig(() => respond(200, JSON.stringify({ result: null })));
    await client.call('silentsumSyncCheckout', {});
    expect(calls[0]?.headers).not.toHaveProperty('Authorization');
    expect(calls[0]?.headers).not.toHaveProperty('X-Firebase-AppCheck');
  });

  it('turns a structured error into its canonical code, message and details', async () => {
    const { client } = rig(() =>
      respond(
        400,
        JSON.stringify({
          error: {
            message: 'Pro is already on this account',
            status: 'FAILED_PRECONDITION',
            details: { reason: 'already-owned' },
          },
        }),
      ),
    );
    let caught: unknown;
    try {
      await client.call('silentsumCreateCheckout', { product: 'pro' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CallableError);
    const error = caught as CallableError;
    expect(error.code).toBe('failed-precondition');
    expect(error.message).toContain('Pro is already on this account');
    expect(error.details).toEqual({ reason: 'already-owned' });
  });

  it.each([
    [401, 'unauthenticated'],
    [403, 'permission-denied'],
    [404, 'not-found'],
    [429, 'resource-exhausted'],
    [503, 'unavailable'],
    [500, 'internal'],
  ])('maps a bare HTTP %s to %s', async (status, code) => {
    const { client } = rig(() => respond(status, '<html>nope</html>'));
    expect(await codeOf(() => client.call('x', {}))).toBe(code);
  });

  it('reports a connection failure as unavailable', async () => {
    const { client } = rig(() => {
      throw new Error('Network request failed');
    });
    expect(await codeOf(() => client.call('x', {}))).toBe('unavailable');
  });

  it('gives up after the timeout and reports that as unavailable too', async () => {
    const calls: Recorded[] = [];
    const fetchImpl: CallableFetch = (url, init) =>
      new Promise((_resolve, reject) => {
        calls.push({ url, method: init.method, headers: init.headers, body: null });
        init.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
    const client = new CallableClient({
      baseUrl: 'https://example.test',
      tokens: { idToken: async () => null, appCheckToken: async () => null },
      fetchImpl,
      timeoutMs: 5,
    });
    expect(await codeOf(() => client.call('slow', {}))).toBe('unavailable');
    expect(calls).toHaveLength(1);
  });

  it('treats a 200 without a result as a broken backend, not a success', async () => {
    const { client } = rig(() => respond(200, 'not json'));
    expect(await codeOf(() => client.call('x', {}))).toBe('internal');
    const missing = rig(() => respond(200, JSON.stringify({ something: 1 })));
    expect(await codeOf(() => missing.client.call('x', {}))).toBe('internal');
  });

  it('strips a trailing slash from the base URL exactly once', async () => {
    const { client, calls } = rig(() => respond(200, JSON.stringify({ result: 1 })));
    await client.call('name', {});
    expect(calls[0]?.url).toBe('https://us-central1-example.cloudfunctions.net/name');
  });
});
