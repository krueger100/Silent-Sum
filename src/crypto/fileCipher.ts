/**
 * Authenticated container for every byte the vault writes to disk.
 *
 *   offset 0   4  magic "SSV1"
 *   offset 4   1  format version (1)
 *   offset 5   1  key id (photo = 1, thumb = 2, index = 3)
 *   offset 6   24 XChaCha20 nonce, fresh random per blob
 *   offset 30  n  ciphertext
 *   tail       16 Poly1305 tag
 *
 * The 6-byte header is bound in as associated data, so the key id cannot be edited to make a
 * thumbnail decrypt as a photo. Nonces are 192-bit random values, which is why generating them
 * randomly per blob is safe without any counter.
 */
import {
  SODIUM_AEAD_NONCE_BYTES,
  SODIUM_AEAD_TAG_BYTES,
  aeadDecrypt,
  aeadEncrypt,
  aadFromBytes,
  randomBytes,
} from '@/crypto/sodium';
import {
  FileCipherFormatError,
  SSV1,
  WrongKeyError,
  vaultKeyIdFromCode,
  vaultKeyIdName,
  type FileCipher,
  type VaultKeyId,
} from '@/crypto/types';
import { concatBytes, type Bytes } from '@/utils/bytes';

function header(id: VaultKeyId): Bytes {
  const out = new Uint8Array(SSV1.headerLength);
  out.set(SSV1.magic, 0);
  out[4] = SSV1.version;
  out[5] = id;
  return out;
}

/** Validates magic, version and key id without touching any key material. */
export function parseHeader(blob: Bytes): { keyId: VaultKeyId } {
  if (blob.length < SSV1.overhead) throw new FileCipherFormatError('blob too short');
  for (let i = 0; i < SSV1.magic.length; i++) {
    if (blob[i] !== SSV1.magic[i]) throw new FileCipherFormatError('bad magic');
  }
  if (blob[4] !== SSV1.version) {
    throw new FileCipherFormatError(`unsupported version ${String(blob[4])}`);
  }
  const keyId = vaultKeyIdFromCode(blob[5] ?? -1);
  if (keyId === null) throw new FileCipherFormatError(`unknown key id ${String(blob[5])}`);
  return { keyId };
}

export class Ssv1FileCipher implements FileCipher {
  async encrypt(plain: Bytes, key: Bytes, id: VaultKeyId): Promise<Bytes> {
    const head = header(id);
    const nonce = randomBytes(SODIUM_AEAD_NONCE_BYTES);
    const combined = aeadEncrypt(plain, aadFromBytes(head), nonce, key);
    return concatBytes(head, nonce, combined);
  }

  async decrypt(blob: Bytes, key: Bytes, id: VaultKeyId): Promise<Bytes> {
    const { keyId } = parseHeader(blob);
    if (keyId !== id) {
      throw new FileCipherFormatError(
        `blob was encrypted for ${vaultKeyIdName(keyId)}, not ${vaultKeyIdName(id)}`,
      );
    }
    const head = blob.subarray(0, SSV1.headerLength);
    const nonce = blob.subarray(SSV1.headerLength, SSV1.headerLength + SODIUM_AEAD_NONCE_BYTES);
    const combined = blob.subarray(SSV1.headerLength + SODIUM_AEAD_NONCE_BYTES);
    if (combined.length < SODIUM_AEAD_TAG_BYTES) {
      throw new FileCipherFormatError('blob too short');
    }
    try {
      return aeadDecrypt(combined, aadFromBytes(head), nonce, key);
    } catch {
      throw new WrongKeyError();
    }
  }
}
