import {
  RelaySupportService,
  type SupportFetch,
  type SupportHttpResponse,
} from '@/support/relaySupportService';
import type { SupportConfig } from '@/support/supportConfig';
import type { SupportMessage } from '@/support/types';

/** The deployed relay function, which is the only kind of endpoint the config now allows. */
const RELAY = 'https://us-central1-example.cloudfunctions.net/silentsumSupportRelay';

const CONFIG: SupportConfig = {
  endpoint: RELAY,
  from: 'Calculator <support@example.com>',
  to: 'support@example.com',
};

const MESSAGE: SupportMessage = {
  topic: 'bug',
  body: 'The gallery is empty after an import.',
  replyTo: 'user@example.com',
  diagnostics: 'App details\nApp version: 0.1.0',
};

interface Call {
  url: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
}

function recorder(response: Partial<SupportHttpResponse> = {}): {
  calls: Call[];
  fetchImpl: SupportFetch;
} {
  const calls: Call[] = [];
  const fetchImpl: SupportFetch = async (url, init) => {
    calls.push({
      url,
      headers: init.headers,
      payload: JSON.parse(init.body) as Record<string, unknown>,
    });
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      text: response.text ?? (async () => '{"id":"3f1e-sent"}'),
    };
  };
  return { calls, fetchImpl };
}

describe('RelaySupportService', () => {
  it('posts the message to the relay, in the shape the relay forwards', async () => {
    const { calls, fetchImpl } = recorder();

    const result = await new RelaySupportService(CONFIG, { fetchImpl }).send(MESSAGE);

    expect(result).toEqual({ kind: 'sent', reference: '3f1e-sent' });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error('no request was made');
    expect(call.url).toBe(RELAY);
    expect(call.headers['Content-Type']).toBe('application/json');
    expect(call.payload.from).toBe(CONFIG.from);
    expect(call.payload.to).toEqual([CONFIG.to]);
    expect(call.payload.subject).toBe('Calculator support: Something is broken');
    expect(call.payload.reply_to).toBe('user@example.com');
    expect(String(call.payload.text)).toContain('The gallery is empty after an import.');
    expect(String(call.payload.text)).toContain('App version: 0.1.0');
  });

  /**
   * The whole point of the relay. This build has no credential to send, so any Authorization header
   * at all would mean one had crept back into the bundle.
   */
  it('sends no credential of any kind', async () => {
    const { calls, fetchImpl } = recorder();

    await new RelaySupportService(CONFIG, { fetchImpl }).send(MESSAGE);

    const headers = calls[0]?.headers ?? {};
    expect(headers.Authorization).toBeUndefined();
    expect(Object.keys(headers)).toEqual(['Content-Type']);
    expect(JSON.stringify(calls[0]?.payload)).not.toMatch(/re_[A-Za-z0-9_]{8,}/);
  });

  it('leaves out a reply address that was never given, or could not be one', async () => {
    const { calls, fetchImpl } = recorder();
    const service = new RelaySupportService(CONFIG, { fetchImpl });

    await service.send({ ...MESSAGE, replyTo: null });
    await service.send({ ...MESSAGE, replyTo: 'not an address' });

    expect(calls[0]?.payload.reply_to).toBeUndefined();
    expect(calls[1]?.payload.reply_to).toBeUndefined();
  });

  it('never lets something PIN-shaped reach the wire', async () => {
    const { calls, fetchImpl } = recorder();

    await new RelaySupportService(CONFIG, { fetchImpl }).send({
      ...MESSAGE,
      body: 'my pin 12142907 stopped working',
    });

    expect(String(calls[0]?.payload.text)).not.toContain('12142907');
  });

  it('turns every provider answer into something the screen can say', async () => {
    const cases: readonly [number, string][] = [
      [401, 'configuration'],
      [403, 'configuration'],
      // The shape an undeployed relay has from here. NOT 'rejected': nothing read the message,
      // so telling the user to shorten it sends them to edit something that was never seen.
      [404, 'missing'],
      [405, 'missing'],
      [422, 'rejected'],
      [400, 'rejected'],
      [429, 'rateLimited'],
      [500, 'server'],
      [503, 'server'],
      [302, 'unknown'],
    ];

    for (const [status, reason] of cases) {
      const { fetchImpl } = recorder({ ok: false, status });
      const result = await new RelaySupportService(CONFIG, { fetchImpl }).send(MESSAGE);
      expect(result).toEqual({ kind: 'failed', reason });
    }
  });

  it('reports a refused connection as unreachable rather than throwing at the caller', async () => {
    const fetchImpl: SupportFetch = () => Promise.reject(new Error('network down'));

    await expect(new RelaySupportService(CONFIG, { fetchImpl }).send(MESSAGE)).resolves.toEqual({
      kind: 'failed',
      reason: 'unreachable',
    });
  });

  it('gives up on a request that never answers', async () => {
    const fetchImpl: SupportFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });

    await expect(
      new RelaySupportService(CONFIG, { fetchImpl, timeoutMs: 10 }).send(MESSAGE),
    ).resolves.toEqual({ kind: 'failed', reason: 'unreachable' });
  });

  it('counts a send as sent even when the answer carries no id', async () => {
    const { fetchImpl } = recorder({ text: async () => 'accepted' });

    await expect(new RelaySupportService(CONFIG, { fetchImpl }).send(MESSAGE)).resolves.toEqual({
      kind: 'sent',
      reference: null,
    });
  });
});
