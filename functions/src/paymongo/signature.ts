/**
 * PayMongo webhook signatures.
 *
 * Every delivery carries `Paymongo-Signature: t=<unix seconds>,te=<hex>,li=<hex>`. The signature
 * is HMAC-SHA256 over `"<t>.<raw request body>"` keyed with the webhook's own secret
 * (`whsk_…`, shown once when the webhook is created). `te` is the signature for test-mode
 * events and `li` for live ones; a deployment checks the one for the mode it runs in and
 * ignores the other, so a test event can never be accepted by a live deployment and vice versa.
 *
 * The body must be the exact bytes received. Parsing and re-serialising JSON changes key order
 * and whitespace and breaks the check, which is why the HTTP handler hands `req.rawBody` in.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface ParsedSignature {
  readonly t: number;
  readonly te: string | null;
  readonly li: string | null;
}

export type SignatureVerdict = 'ok' | 'bad-header' | 'no-signature-for-mode' | 'stale' | 'mismatch';

/** Replay window: how far the signed timestamp may sit from the receiving clock, either way. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export function parseSignatureHeader(header: string | null | undefined): ParsedSignature | null {
  if (typeof header !== 'string' || header.trim() === '') return null;
  let t: number | null = null;
  let te: string | null = null;
  let li: string | null = null;
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') {
      if (!/^\d+$/.test(value)) return null;
      t = Number(value);
    } else if (key === 'te') {
      te = value;
    } else if (key === 'li') {
      li = value;
    }
  }
  if (t === null) return null;
  return { t, te, li };
}

export function computeSignature(secret: string, t: number, rawBody: Buffer | string): string {
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  return createHmac('sha256', secret)
    .update(`${String(t)}.`)
    .update(body)
    .digest('hex');
}

function sameHex(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function verifyWebhookSignature(input: {
  readonly header: string | null | undefined;
  readonly rawBody: Buffer | string;
  readonly secret: string;
  readonly livemode: boolean;
  readonly nowSeconds: number;
  readonly toleranceSeconds?: number;
}): SignatureVerdict {
  const parsed = parseSignatureHeader(input.header);
  if (parsed === null) return 'bad-header';
  const presented = input.livemode ? parsed.li : parsed.te;
  if (presented === null || presented === '') return 'no-signature-for-mode';
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(input.nowSeconds - parsed.t) > tolerance) return 'stale';
  // An empty secret means the deployment is misconfigured; nothing may verify against it.
  if (input.secret === '') return 'mismatch';
  const expected = computeSignature(input.secret, parsed.t, input.rawBody);
  return sameHex(expected, presented) ? 'ok' : 'mismatch';
}
