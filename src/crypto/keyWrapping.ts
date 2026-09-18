/**
 * XChaCha20-Poly1305 key wrapping.
 *
 * The Poly1305 tag is the PIN verifier: there is no separate hash of the PIN to attack, so the
 * cheapest guess costs one full Argon2id derivation. `wrap` stores the tag detached from the
 * ciphertext to match the reference record layout; libsodium works in combined mode, so the two
 * are split on the way out and re-joined on the way in.
 */
import { SODIUM_AEAD_NONCE_BYTES, SODIUM_AEAD_TAG_BYTES, aeadDecrypt, aeadEncrypt, randomBytes } from '@/crypto/sodium';
import {
  AAD,
  RecordFormatError,
  WRAPPED_KEY_LIMITS,
  WrongKeyError,
  type KeyWrapping,
  type WrappedKey,
  type WrappedKeyJson,
} from '@/crypto/types';
import { base64Decode, base64Encode, Base64Error } from '@/utils/base64';
import { concatBytes, type Bytes } from '@/utils/bytes';

export function wrappedKeyToJson(wrapped: WrappedKey): WrappedKeyJson {
  return {
    nonce: base64Encode(wrapped.nonce),
    ct: base64Encode(wrapped.cipherText),
    mac: base64Encode(wrapped.mac),
  };
}

function decodeField(source: Record<string, unknown>, name: string): Bytes {
  const value = source[name];
  if (typeof value !== 'string') throw new RecordFormatError(`wrapped.${name} is not a string`);
  try {
    return base64Decode(value);
  } catch (cause) {
    if (cause instanceof Base64Error) throw new RecordFormatError(`wrapped.${name} is not base64`);
    throw cause;
  }
}

export function wrappedKeyFromJson(value: unknown): WrappedKey {
  if (typeof value !== 'object' || value === null) {
    throw new RecordFormatError('wrapped key is not an object');
  }
  const source = value as Record<string, unknown>;
  const nonce = decodeField(source, 'nonce');
  const cipherText = decodeField(source, 'ct');
  const mac = decodeField(source, 'mac');
  if (nonce.length !== WRAPPED_KEY_LIMITS.nonceLength) {
    throw new RecordFormatError('bad nonce length');
  }
  if (mac.length !== WRAPPED_KEY_LIMITS.macLength) {
    throw new RecordFormatError('bad mac length');
  }
  if (cipherText.length === 0 || cipherText.length > WRAPPED_KEY_LIMITS.maxCipherTextLength) {
    throw new RecordFormatError('bad ciphertext length');
  }
  return { nonce, cipherText, mac };
}

export class SodiumKeyWrapping implements KeyWrapping {
  async wrap(key: Bytes, kek: Bytes, aad: string = AAD.vault): Promise<WrappedKey> {
    const nonce = randomBytes(SODIUM_AEAD_NONCE_BYTES);
    const combined = aeadEncrypt(key, aad, nonce, kek);
    const split = combined.length - SODIUM_AEAD_TAG_BYTES;
    return {
      nonce,
      cipherText: combined.slice(0, split),
      mac: combined.slice(split),
    };
  }

  async unwrap(wrapped: WrappedKey, kek: Bytes, aad: string = AAD.vault): Promise<Bytes> {
    const combined = concatBytes(wrapped.cipherText, wrapped.mac);
    try {
      return aeadDecrypt(combined, aad, wrapped.nonce, kek);
    } catch {
      // Wrong PIN, wrong passphrase, or tampered record: all indistinguishable, all one error.
      throw new WrongKeyError();
    }
  }
}
