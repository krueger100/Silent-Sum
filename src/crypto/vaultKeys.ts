/**
 * The key hierarchy of one unlocked session.
 *
 *   PIN --Argon2id--> KEK --unwrap--> master key (VMK)
 *                                       |- HKDF-SHA256 "silentsum/photo/v1" -> photo key
 *                                       |- HKDF-SHA256 "silentsum/thumb/v1" -> thumbnail key
 *                                       |- HKDF-SHA256 "silentsum/index/v1" -> index key
 *                                       '- HKDF-SHA256 "silentsum/video/v1" -> video key
 *
 * Separate sub-keys mean a blob encrypted for one purpose can never be decrypted as another, and
 * the master key itself is only ever used for wrapping (PIN change, backup envelope). Videos get
 * their own for the same reason: photo and video payloads share a directory, so the sub-key (and
 * the key id bound into every blob's associated data) is what actually keeps them apart.
 *
 * Adding the video sub-key changes nothing about the other three. It is derived from the same
 * master key with a different info string, so a vault created before videos existed opens and
 * decrypts byte for byte as it always did.
 *
 * HKDF is computed with an empty salt, exactly as the Flutter reference does. For HMAC an empty
 * key and a zero-filled key of hash length are the same thing, so this matches RFC 5869 with the
 * default salt.
 */
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';

import {
  KeysDisposedError,
  MASTER_KEY_LENGTH,
  VAULT_KEY_INFO,
  VaultKeyId,
  type VaultKeys,
} from '@/crypto/types';
import { toHex, utf8Encode, zeroBytes, type Bytes } from '@/utils/bytes';

const EMPTY_SALT = new Uint8Array(0);
const SUBKEY_LENGTH = 32;
/** Its own HKDF domain, so the id is independent of every sub-key and of the messaging identity. */
const VAULT_ID_INFO = 'silentsum/vault/id/v1';
/** 16 bytes -> 32 hex characters, which is the same shape as a photo id. */
const VAULT_ID_LENGTH = 16;

class SessionVaultKeys implements VaultKeys {
  private disposed = false;

  constructor(
    private readonly master: Bytes,
    private readonly photo: Bytes,
    private readonly thumb: Bytes,
    private readonly manifest: Bytes,
    private readonly video: Bytes,
  ) {}

  get isDisposed(): boolean {
    return this.disposed;
  }

  get masterKey(): Bytes {
    return this.guard(this.master);
  }

  keyFor(id: VaultKeyId): Bytes {
    switch (id) {
      case VaultKeyId.photo:
        return this.guard(this.photo);
      case VaultKeyId.thumb:
        return this.guard(this.thumb);
      case VaultKeyId.manifest:
        return this.guard(this.manifest);
      case VaultKeyId.video:
        return this.guard(this.video);
      default:
        throw new KeysDisposedError();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    zeroBytes(this.master);
    zeroBytes(this.photo);
    zeroBytes(this.thumb);
    zeroBytes(this.manifest);
    zeroBytes(this.video);
  }

  private guard(bytes: Bytes): Bytes {
    if (this.disposed) throw new KeysDisposedError();
    return bytes;
  }
}

function subKey(master: Bytes, id: VaultKeyId): Bytes {
  return hkdf(sha256, master, EMPTY_SALT, utf8Encode(VAULT_KEY_INFO[id]), SUBKEY_LENGTH);
}

/**
 * Derives the session keys. The master key is COPIED, because callers zero their own buffer as
 * soon as this returns.
 */
/**
 * A non-secret name for the vault a master key belongs to.
 *
 * HKDF under its own info string, so it is domain-separated from every sub-key `deriveVaultKeys`
 * produces and from the messaging identity: publishing it says nothing about the key it names, and
 * nothing that uses it can be confused with something that encrypts. It is deliberately NOT a
 * `VaultKeyId` -- those are bound into the AAD of every blob, so adding one would change the
 * storage format.
 *
 * Deterministic, so a vault keeps its name across a restore, a new phone and a re-wrap under a new
 * PIN. That is exactly the property the cloud needs: "is this backup mine?" has to survive the
 * events that make the question worth asking.
 */
export function deriveVaultId(masterKey: Bytes): string {
  if (masterKey.length !== MASTER_KEY_LENGTH) {
    throw new RangeError(`master key must be ${MASTER_KEY_LENGTH} bytes`);
  }
  const id = hkdf(sha256, masterKey, EMPTY_SALT, utf8Encode(VAULT_ID_INFO), VAULT_ID_LENGTH);
  try {
    return toHex(id);
  } finally {
    zeroBytes(id);
  }
}

export function deriveVaultKeys(masterKey: Bytes): VaultKeys {
  if (masterKey.length !== MASTER_KEY_LENGTH) {
    throw new RangeError(`master key must be ${MASTER_KEY_LENGTH} bytes`);
  }
  const master = Uint8Array.from(masterKey);
  return new SessionVaultKeys(
    master,
    subKey(master, VaultKeyId.photo),
    subKey(master, VaultKeyId.thumb),
    subKey(master, VaultKeyId.manifest),
    subKey(master, VaultKeyId.video),
  );
}
