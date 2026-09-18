import {
  ResendSupportService,
  type SupportFetch,
  type SupportHttpResponse,
} from '@/support/resendSupportService';
import { RESEND_ENDPOINT, type SupportConfig } from '@/support/supportConfig';
import type { SupportMessage } from '@/support/types';

const CONFIG: SupportConfig = {
  endpoint: RESEND_ENDPOINT,
  apiKey: 'test-key',
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
    calls.push({ url, headers: init.headers, payload: JSON.parse(init.body) as Record<string, unknown> });
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      text: response.text ?? (async () => '{"id":"3f1e-sent"}'),
    };
  };
  return { calls, fetchImpl };
}

describe('ResendSupportService', () => {
  it('posts the message where the build says, in the shape Resend expects', async () => {
    const { calls, fetchImpl } = recorder();

    const result = await new ResendSupportService(CONFIG, { fetchImpl }).send(MESSAGE);

    expect(result).toEqual({ kind: 'sent', reference: '3f1e-sent' });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error('no request was made');
    expect(call.url).toBe(RESEND_ENDPOINT);
    expect(call.headers.Authorization).toBe('Bearer test-key');
    expect(call.headers['Content-Type']).toBe('application/json');
    expect(call.payload.from).toBe(CONFIG.from);
    expect(call.payload.to).toEqual([CONFIG.to]);
    expect(call.payload.subject).toBe('Calculator support: Something is broken');
    expect(call.payload.reply_to).toBe('user@example.com');
    expect(String(call.payload.text)).toContain('The gallery is empty after an import.');
    expect(String(call.payload.text)).toContain('App version: 0.1.0');
  });

  it('sends no Authorization header when the relay holds the credentials', async () => {
    const { calls, fetchImpl } = recorder();

    await new ResendSupportService(
      { ...CONFIG, endpoint: 'https://relay.example.com/support', apiKey: null },
      { fetchImpl },
    ).send(MESSAGE);

    expect(calls[0]?.url).toBe('https://relay.example.com/support');
    expect(calls[0]?.headers.Authorization).toBeUndefined();
  });

  it('leaves out a reply address that was never given, or could not be one', async () => {
    const { calls, fetchImpl } = recorder();
    const service = new ResendSupportService(CONFIG, { fetchImpl });

    await service.send({ ...MESSAGE, replyTo: null });
    await service.send({ ...MESSAGE, replyTo: 'not an address' });

    expect(calls[0]?.payload.reply_to).toBeUndefined();
    expect(calls[1]?.payload.reply_to).toBeUndefined();
  });

  it('never lets something PIN-shaped reach the wire', async () => {
    const { calls, fetchImpl } = recorder();

    await new ResendSupportService(CONFIG, { fetchImpl }).send({
      ...MESSAGE,
      body: 'my pin 12142907 stopped working',
    });

    expect(String(calls[0]?.payload.text)).not.toContain('12142907');
  });

  it('turns every provider answer into something the screen can say', async () => {
    const cases: readonly [number, string][] = [
      [401, 'configuration'],
      [403, 'configuration'],
      [422, 'rejected'],
      [400, 'rejected'],
      [429, 'rateLimited'],
      [500, 'server'],
      [503, 'server'],
      [302, 'unknown'],
    ];

    for (const [status, reason] of cases) {
      const { fetchImpl } = recorder({ ok: false, status });
      const result = await new ResendSupportService(CONFIG, { fetchImpl }).send(MESSAGE);
      expect(result).toEqual({ kind: 'failed', reason });
    }
  });

  it('reports a refused connection as unreachable rather than throwing at the caller', async () => {
    const fetchImpl: SupportFetch = () => Promise.reject(new Error('network down'));

    await expect(new ResendSupportService(CONFIG, { fetchImpl }).send(MESSAGE)).resolves.toEqual({
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
      new ResendSupportService(CONFIG, { fetchImpl, timeoutMs: 10 }).send(MESSAGE),
    ).resolves.toEqual({ kind: 'failed', reason: 'unreachable' });
  });

  it('counts a send as sent even when the answer carries no id', async () => {
    const { fetchImpl } = recorder({ text: async () => 'accepted' });

    await expect(new ResendSupportService(CONFIG, { fetchImpl }).send(MESSAGE)).resolves.toEqual({
      kind: 'sent',
      reference: null,
    });
  });
});
