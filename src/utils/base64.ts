/**
 * Standard-alphabet base64 (`+` `/`, `=` padding) as used by every persisted record.
 * Pure JS; small inputs only (keys, salts, nonces). Large image payloads use the native
 * libsodium `to_base64` through the crypto module instead.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charAt(i)] = i;
// Tolerate the URL-safe alphabet on input (records written by other implementations).
LOOKUP['-'] = 62;
LOOKUP['_'] = 63;

export function base64Encode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out +=
      ALPHABET.charAt((n >> 18) & 63) +
      ALPHABET.charAt((n >> 12) & 63) +
      ALPHABET.charAt((n >> 6) & 63) +
      ALPHABET.charAt(n & 63);
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] ?? 0) << 16;
    out += ALPHABET.charAt((n >> 18) & 63) + ALPHABET.charAt((n >> 12) & 63) + '==';
  } else if (rest === 2) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8);
    out +=
      ALPHABET.charAt((n >> 18) & 63) +
      ALPHABET.charAt((n >> 12) & 63) +
      ALPHABET.charAt((n >> 6) & 63) +
      '=';
  }
  return out;
}

export class Base64Error extends Error {
  constructor(message = 'invalid base64') {
    super(message);
    this.name = 'Base64Error';
  }
}

/** Decodes standard or URL-safe base64, with or without padding. Throws Base64Error on garbage. */
export function base64Decode(text: string): Uint8Array {
  const clean = text.replace(/[\s=]+$/g, '').replace(/\s+/g, '');
  if (clean.length % 4 === 1) throw new Base64Error();
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    const v = LOOKUP[clean.charAt(i)];
    if (v === undefined) throw new Base64Error();
    buffer = ((buffer << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}
