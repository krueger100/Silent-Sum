/**
 * The single place the libsodium binding is imported.
 *
 * On device this is `react-native-libsodium` (JSI, synchronous, native speed). Under Jest the
 * module name is mapped to `test/shims/react-native-libsodium.ts`, which forwards to
 * `libsodium-wrappers-sumo`. Both expose the same function names and argument order, so every
 * byte produced here is identical in tests and in the app.
 *
 * Nothing else in the codebase may import the binding directly.
 */
import {
  base64_variants,
  crypto_aead_xchacha20poly1305_ietf_decrypt,
  crypto_aead_xchacha20poly1305_ietf_encrypt,
  crypto_pwhash,
  crypto_pwhash_ALG_ARGON2ID13,
  from_base64,
  randombytes_buf,
  to_base64,
} from 'react-native-libsodium';

import type { Bytes } from '@/utils/bytes';

/** Argon2id salt length libsodium requires, and the length we generate. */
export const SODIUM_SALT_BYTES = 16;
export const SODIUM_AEAD_NONCE_BYTES = 24;
export const SODIUM_AEAD_TAG_BYTES = 16;
export const SODIUM_AEAD_KEY_BYTES = 32;

/**
 * libsodium refuses parameters below these floors. They are far under every preset we use, but
 * a persisted or downloaded record could carry anything, so the callers validate first.
 */
export const SODIUM_PWHASH_LIMITS = {
  minMemoryKiB: 8,
  minIterations: 1,
  minOutputBytes: 16,
} as const;

export class SodiumError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'SodiumError';
    this.cause = cause;
  }
}

export function randomBytes(length: number): Bytes {
  return randombytes_buf(length);
}

/**
 * Argon2id (RFC 9106, libsodium ALG_ARGON2ID13). libsodium always computes with one lane, so
 * `parallelism` must already have been validated as 1 by the caller.
 */
export function argon2id(
  password: Bytes,
  salt: Bytes,
  memoryKiB: number,
  iterations: number,
  outputBytes: number,
): Bytes {
  try {
    return crypto_pwhash(
      outputBytes,
      password,
      salt,
      iterations,
      memoryKiB * 1024,
      crypto_pwhash_ALG_ARGON2ID13,
    );
  } catch (cause) {
    throw new SodiumError('argon2id failed', cause);
  }
}

/**
 * Associated data must be a STRING, not bytes.
 *
 * The native binding refuses a `Uint8Array` outright ("input type not yet implemented"), while the
 * pure-JS build used in tests happily accepts one. Taking a string here is what keeps the two
 * honest; the Jest shim enforces the same rule so the divergence cannot come back.
 *
 * The string is UTF-8 encoded on the way in, so for the byte sequences this app binds (ASCII
 * labels, and the SSV1 header whose bytes are all below 0x80) the authenticated bytes are exactly
 * the same ones the Flutter implementation binds.
 */
export type Aad = string;

/**
 * Turns a byte header into an AAD string whose UTF-8 encoding is byte-identical to it.
 *
 * Only valid for bytes below 0x80; anything above would encode as two bytes and silently change
 * what is authenticated, so it throws rather than corrupting the format.
 */
export function aadFromBytes(bytes: Bytes): Aad {
  let out = '';
  for (const byte of bytes) {
    if (byte >= 0x80) {
      throw new SodiumError('associated data byte is not representable as single-byte UTF-8');
    }
    out += String.fromCharCode(byte);
  }
  return out;
}

/** Returns ciphertext||tag (libsodium combined mode). */
export function aeadEncrypt(plain: Bytes, aad: Aad, nonce: Bytes, key: Bytes): Bytes {
  try {
    return crypto_aead_xchacha20poly1305_ietf_encrypt(plain, aad, null, nonce, key);
  } catch (cause) {
    throw new SodiumError('aead encrypt failed', cause);
  }
}

/**
 * Takes ciphertext||tag. Throws (any error) when authentication fails; callers translate that
 * into WrongKeyError without inspecting the reason.
 */
export function aeadDecrypt(combined: Bytes, aad: Aad, nonce: Bytes, key: Bytes): Bytes {
  return crypto_aead_xchacha20poly1305_ietf_decrypt(null, combined, aad, nonce, key);
}

/**
 * Standard-alphabet base64 with padding, computed natively.
 *
 * The pure-JS helpers in `@/utils/base64` are for small records; image payloads are megabytes and
 * go through here so encoding a data URI does not stall the JS thread.
 */
export function toBase64(bytes: Bytes): string {
  return to_base64(bytes, base64_variants.ORIGINAL);
}

export function fromBase64(text: string): Bytes {
  return from_base64(text, base64_variants.ORIGINAL);
}
