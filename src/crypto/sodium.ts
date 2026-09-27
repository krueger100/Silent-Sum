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
import { x25519 } from '@noble/curves/ed25519';
import {
  base64_variants,
  crypto_aead_xchacha20poly1305_ietf_decrypt,
  crypto_aead_xchacha20poly1305_ietf_encrypt,
  crypto_box_seed_keypair,
  crypto_pwhash,
  crypto_pwhash_ALG_ARGON2ID13,
  crypto_sign_verify_detached,
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
export const SODIUM_SIGNATURE_BYTES = 64;
export const SODIUM_PUBLIC_KEY_BYTES = 32;
export const SODIUM_BOX_SEED_BYTES = 32;
export const SODIUM_BOX_PUBLIC_KEY_BYTES = 32;
export const SODIUM_BOX_SECRET_KEY_BYTES = 32;
export const SODIUM_BOX_SHARED_KEY_BYTES = 32;

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

/** An X25519 key pair. The secret half never leaves the device and is never persisted. */
export interface BoxKeyPair {
  readonly publicKey: Bytes;
  readonly secretKey: Bytes;
}

/**
 * Derives an X25519 key pair from a 32-byte seed, deterministically.
 *
 * Deterministic is the whole point: the messaging identity is derived from the vault master key
 * on every unlock, so there is no second secret to store, back up or lose. Restore the vault and
 * the same key pair comes back, which is what keeps old conversations readable.
 */
export function boxSeedKeypair(seed: Bytes): BoxKeyPair {
  if (seed.length !== SODIUM_BOX_SEED_BYTES) {
    throw new RangeError(`box seed must be ${SODIUM_BOX_SEED_BYTES} bytes`);
  }
  try {
    const pair = crypto_box_seed_keypair(seed);
    return { publicKey: pair.publicKey, secretKey: pair.privateKey };
  } catch (cause) {
    throw new SodiumError('box seed keypair failed', cause);
  }
}

/**
 * X25519: the raw shared secret both sides of a conversation compute independently.
 *
 * `dh(theirPublic, mySecret)` and `dh(myPublic, theirSecret)` are equal, so one ciphertext is
 * readable by both the sender and the recipient and nothing has to be encrypted twice. The server
 * sees neither half. The caller runs HKDF over this before it is used as a key -- the output of a
 * Diffie-Hellman is a group element, not uniform bytes, and must never be used as a key directly.
 *
 * This is the one primitive here that is NOT libsodium, and deliberately so. The native binding
 * (`react-native-libsodium`'s `lib.native.ts`) bridges a fixed list of functions through JSI, and
 * neither `crypto_box_beforenm` nor `crypto_scalarmult` is on it -- there is no X25519 in the
 * native build at all, only the all-in-one `crypto_box_easy`. Calling one of them compiles, type
 * checks and passes the test suite (whose shim forwards to `libsodium-wrappers-sumo`, which has
 * the whole API) and then throws on a real phone. So the exchange is done in JS, by the same
 * author as the `@noble/hashes` this file already trusts for HKDF.
 *
 * This is raw X25519 where the old code used `crypto_box_beforenm`, which is HSalsa20 applied to
 * that same output. Both are sound under the HKDF that follows; they are not interchangeable, so
 * anything encrypted by the older code cannot be read by this. Nothing ever was.
 */
export function boxSharedKey(peerPublicKey: Bytes, secretKey: Bytes): Bytes {
  if (peerPublicKey.length !== SODIUM_BOX_PUBLIC_KEY_BYTES) {
    throw new RangeError(`peer public key must be ${SODIUM_BOX_PUBLIC_KEY_BYTES} bytes`);
  }
  if (secretKey.length !== SODIUM_BOX_SECRET_KEY_BYTES) {
    throw new RangeError(`secret key must be ${SODIUM_BOX_SECRET_KEY_BYTES} bytes`);
  }
  try {
    // Throws on an all-zero result, which is what rejects a low-order peer key.
    return x25519.getSharedSecret(secretKey, peerPublicKey);
  } catch (cause) {
    throw new SodiumError('box shared key failed', cause);
  }
}

/**
 * Verifies a detached Ed25519 signature.
 *
 * The only asymmetric primitive in the app, and it is verify-only on purpose: the matching
 * secret key lives on an offline machine, and there is deliberately no signing function here
 * to pair with it. Shipping one would put the power to MINT a recovery code in every install,
 * which is exactly what the scheme in `@/support/recoveryCode` exists to avoid.
 *
 * Wrong-length inputs answer false rather than throwing: a caller checking a code someone
 * typed is asking a question, not reporting a bug.
 */
export function signVerify(message: Bytes, signature: Bytes, publicKey: Bytes): boolean {
  if (signature.length !== SODIUM_SIGNATURE_BYTES) return false;
  if (publicKey.length !== SODIUM_PUBLIC_KEY_BYTES) return false;
  try {
    return crypto_sign_verify_detached(signature, message, publicKey);
  } catch {
    // Some bindings throw on a signature that parses but does not verify. Same answer.
    return false;
  }
}
