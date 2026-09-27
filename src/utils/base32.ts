/**
 * Crockford base32, for the one string in this app a human has to read off a screen or retype
 * out of an email.
 *
 * Standard base32 and base64 are both worse for that job: base64 is case-sensitive and mixes `l`
 * with `1` and `O` with `0`, and RFC 4648 base32 keeps `I`, `L`, `O` and `U` in the alphabet.
 * Crockford drops all four and folds the confusable characters back on input, so `O` typed for a
 * zero, or a lowercase code pasted out of a mail client, still decodes to the same bytes.
 *
 * Decoding is deliberately forgiving about SHAPE and strict about nothing else: separators and
 * whitespace are discarded, so the grouped form this module prints, the ungrouped form, and a
 * form a mail client has line-wrapped all decode identically. Trailing pad bits are ignored,
 * because the caller checks the decoded LENGTH and, for a recovery code, a signature over the
 * result -- a checksum here would only duplicate a far stronger check one layer up.
 */
import type { Bytes } from '@/utils/bytes';

/** Crockford's alphabet: no I, L, O or U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const LOOKUP: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charAt(i)] = i;
// Crockford's documented substitutions, so a hand-typed code survives the obvious misreadings.
LOOKUP['I'] = 1;
LOOKUP['L'] = 1;
LOOKUP['O'] = 0;

export class Base32Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Base32Error';
  }
}

export function base32Encode(bytes: Bytes): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET.charAt((acc >> bits) & 31);
    }
  }
  // The final partial group is left-aligned and zero-padded, which is what the decoder ignores.
  if (bits > 0) out += ALPHABET.charAt((acc << (5 - bits)) & 31);
  return out;
}

/**
 * Throws {@link Base32Error} on a character that is not in the alphabet after folding. Anything
 * that is not a letter or a digit is a separator and is dropped.
 */
export function base32Decode(text: string): Bytes {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const raw of text.toUpperCase()) {
    if (!/[0-9A-Z]/.test(raw)) continue;
    const value = LOOKUP[raw];
    if (value === undefined) throw new Base32Error(`not a base32 character: ${raw}`);
    acc = (acc << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/**
 * Inserts `-` every `size` characters, so a long code is readable and a short reference can be
 * read aloud. Purely cosmetic: {@link base32Decode} discards the separators again.
 */
export function groupBase32(text: string, size: number): string {
  if (size <= 0) throw new RangeError('group size must be positive');
  const groups: string[] = [];
  for (let i = 0; i < text.length; i += size) groups.push(text.slice(i, i + size));
  return groups.join('-');
}
