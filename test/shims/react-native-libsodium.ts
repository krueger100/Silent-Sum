/**
 * Jest replacement for `react-native-libsodium`.
 *
 * Delegates to the pure-JS `libsodium-wrappers-sumo` build, which exposes the same function
 * names and signatures as the native JSI binding. `test/setup.ts` awaits `sodium.ready` before
 * any test runs, so the calls below can stay synchronous like the native module.
 */
import sodium from 'libsodium-wrappers-sumo';

type Bytes = Uint8Array;

function ensureReady(): typeof sodium {
  if (typeof sodium.crypto_pwhash !== 'function') {
    throw new Error('libsodium-wrappers-sumo is not ready; await sodium.ready in test setup');
  }
  return sodium;
}

export const crypto_pwhash_ALG_ARGON2ID13 = 2;
export const crypto_pwhash_SALTBYTES = 16;
export const crypto_aead_xchacha20poly1305_ietf_KEYBYTES = 32;
export const crypto_aead_xchacha20poly1305_ietf_NPUBBYTES = 24;
export const crypto_aead_xchacha20poly1305_ietf_ABYTES = 16;

export function randombytes_buf(length: number): Bytes {
  return ensureReady().randombytes_buf(length);
}

export function crypto_pwhash(
  keyLength: number,
  password: string | Bytes,
  salt: Bytes,
  opsLimit: number,
  memLimit: number,
  algorithm: number,
): Bytes {
  return ensureReady().crypto_pwhash(keyLength, password, salt, opsLimit, memLimit, algorithm);
}

/**
 * The native binding accepts associated data ONLY as a string, throwing
 * "input type not yet implemented" for a Uint8Array, while libsodium-wrappers accepts both.
 *
 * That divergence once produced a build where every test passed and the app could not create a
 * vault on a real device, so the shim reproduces the native restriction exactly.
 */
function requireStringAad(additional_data: string | Bytes | null): string | null {
  if (additional_data === null || typeof additional_data === 'string') return additional_data;
  throw new Error(
    'crypto_aead_xchacha20poly1305_ietf: additional data must be a string; the native binding rejects Uint8Array',
  );
}

export function crypto_aead_xchacha20poly1305_ietf_encrypt(
  message: string | Bytes,
  additional_data: string | Bytes | null,
  secret_nonce: string | Bytes | null,
  public_nonce: Bytes,
  key: Bytes,
): Bytes {
  return ensureReady().crypto_aead_xchacha20poly1305_ietf_encrypt(
    message,
    requireStringAad(additional_data),
    secret_nonce,
    public_nonce,
    key,
  );
}

export function crypto_aead_xchacha20poly1305_ietf_decrypt(
  secret_nonce: string | Bytes | null,
  ciphertext: string | Bytes,
  additional_data: string | Bytes | null,
  public_nonce: Bytes,
  key: Bytes,
): Bytes {
  const ct = typeof ciphertext === 'string' ? new TextEncoder().encode(ciphertext) : ciphertext;
  return ensureReady().crypto_aead_xchacha20poly1305_ietf_decrypt(
    secret_nonce,
    ct,
    requireStringAad(additional_data),
    public_nonce,
    key,
  );
}

export function crypto_generichash(
  hash_length: number,
  message: string | Bytes,
  key?: Bytes | null,
): Bytes {
  const msg = typeof message === 'string' ? new TextEncoder().encode(message) : message;
  return ensureReady().crypto_generichash(hash_length, msg, key ?? null);
}

export function to_base64(input: string | Bytes, variant?: number): string {
  return ensureReady().to_base64(input, variant);
}

export function from_base64(input: string, variant?: number): Bytes {
  return ensureReady().from_base64(input, variant);
}

export function to_hex(input: string | Bytes): string {
  return ensureReady().to_hex(input);
}

export const base64_variants = {
  ORIGINAL: 1,
  ORIGINAL_NO_PADDING: 3,
  URLSAFE: 5,
  URLSAFE_NO_PADDING: 7,
} as const;
