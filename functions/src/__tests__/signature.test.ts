import { createHmac } from 'node:crypto';

import {
  computeSignature,
  parseSignatureHeader,
  verifyWebhookSignature,
} from '../paymongo/signature';

const SECRET = 'test-webhook-signing-secret';
const OTHER_SECRET = 'a-different-secret';
const BODY = '{"data":{"id":"evt_1","attributes":{"type":"payment.paid","livemode":false}}}';
const T = 1_758_000_000;

function sign(secret: string, t: number, body: string): string {
  return createHmac('sha256', secret)
    .update(`${String(t)}.${body}`)
    .digest('hex');
}

function header(parts: { t?: number | string; te?: string; li?: string }): string {
  const out: string[] = [];
  if (parts.t !== undefined) out.push(`t=${String(parts.t)}`);
  if (parts.te !== undefined) out.push(`te=${parts.te}`);
  if (parts.li !== undefined) out.push(`li=${parts.li}`);
  return out.join(',');
}

describe('parseSignatureHeader', () => {
  it('reads the timestamp and both signatures', () => {
    expect(parseSignatureHeader(`t=${String(T)},te=abc,li=def`)).toEqual({
      t: T,
      te: 'abc',
      li: 'def',
    });
  });

  it('tolerates spaces and a missing mode', () => {
    expect(parseSignatureHeader(` t=${String(T)} , te=abc `)).toEqual({
      t: T,
      te: 'abc',
      li: null,
    });
  });

  it('returns null for anything without a numeric timestamp', () => {
    expect(parseSignatureHeader(undefined)).toBeNull();
    expect(parseSignatureHeader(null)).toBeNull();
    expect(parseSignatureHeader('')).toBeNull();
    expect(parseSignatureHeader('te=abc')).toBeNull();
    expect(parseSignatureHeader('t=soon,te=abc')).toBeNull();
    expect(parseSignatureHeader('garbage')).toBeNull();
  });
});

describe('computeSignature', () => {
  it('is HMAC-SHA256 over "<t>.<raw body>" with the webhook secret, hex encoded', () => {
    expect(computeSignature(SECRET, T, BODY)).toBe(sign(SECRET, T, BODY));
    expect(computeSignature(SECRET, T, Buffer.from(BODY, 'utf8'))).toBe(sign(SECRET, T, BODY));
  });
});

describe('verifyWebhookSignature', () => {
  const verify = (
    h: string | undefined,
    overrides: Partial<{
      livemode: boolean;
      nowSeconds: number;
      rawBody: string | Buffer;
      secret: string;
      toleranceSeconds: number;
    }> = {},
  ) =>
    verifyWebhookSignature({
      header: h,
      rawBody: BODY,
      secret: SECRET,
      livemode: false,
      nowSeconds: T + 10,
      ...overrides,
    });

  it('accepts a test-mode event signed under te', () => {
    expect(verify(header({ t: T, te: sign(SECRET, T, BODY) }))).toBe('ok');
  });

  it('accepts a live event signed under li, ignoring te', () => {
    const h = header({ t: T, te: 'not-checked-for-live', li: sign(SECRET, T, BODY) });
    expect(verify(h, { livemode: true })).toBe('ok');
  });

  it('accepts the raw body as a Buffer exactly as it accepts it as a string', () => {
    const h = header({ t: T, te: sign(SECRET, T, BODY) });
    expect(verify(h, { rawBody: Buffer.from(BODY, 'utf8') })).toBe('ok');
  });

  it('refuses a live event that only carries a test signature', () => {
    const h = header({ t: T, te: sign(SECRET, T, BODY) });
    expect(verify(h, { livemode: true })).toBe('no-signature-for-mode');
  });

  it('refuses a body altered after signing', () => {
    const h = header({ t: T, te: sign(SECRET, T, BODY) });
    expect(verify(h, { rawBody: BODY.replace('evt_1', 'evt_2') })).toBe('mismatch');
  });

  it('refuses a signature made with another secret', () => {
    expect(verify(header({ t: T, te: sign(OTHER_SECRET, T, BODY) }))).toBe('mismatch');
  });

  it('refuses a timestamp that does not match the one signed', () => {
    expect(verify(header({ t: T + 1, te: sign(SECRET, T, BODY) }))).toBe('mismatch');
  });

  it('refuses a signature of the wrong length without throwing', () => {
    expect(verify(header({ t: T, te: 'abc' }))).toBe('mismatch');
    expect(verify(header({ t: T, te: '' }))).toBe('no-signature-for-mode');
  });

  it('refuses a stale timestamp and accepts one inside the window, in either direction', () => {
    const h = header({ t: T, te: sign(SECRET, T, BODY) });
    expect(verify(h, { nowSeconds: T + 301 })).toBe('stale');
    expect(verify(h, { nowSeconds: T + 300 })).toBe('ok');
    expect(verify(h, { nowSeconds: T - 299 })).toBe('ok');
    expect(verify(h, { nowSeconds: T - 301 })).toBe('stale');
    expect(verify(h, { nowSeconds: T + 3601, toleranceSeconds: 3600 })).toBe('stale');
  });

  it('refuses a missing or malformed header', () => {
    expect(verify(undefined)).toBe('bad-header');
    expect(verify('')).toBe('bad-header');
    expect(verify('te=abc')).toBe('bad-header');
  });

  it('refuses everything when the secret is empty', () => {
    const h = header({ t: T, te: sign('', T, BODY) });
    expect(verify(h, { secret: '' })).toBe('mismatch');
  });
});
