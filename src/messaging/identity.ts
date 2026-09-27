/**
 * The messaging key hierarchy.
 *
 *   master key (VMK) --HKDF "silentsum/messaging/id/v1"--> 32-byte seed
 *                                                            '- crypto_box_seed_keypair -> X25519 pair
 *
 *   my secret + peer public --X25519--> shared key
 *                                         '- HKDF "silentsum/messaging/conv/v1|<cid>" -> conversation key
 *
 * Nothing here is stored. The identity is derived on unlock from the key the vault already has,
 * so there is no second secret to back up, and restoring a vault restores the ability to read
 * every old conversation. Only the PUBLIC half is ever published.
 *
 * The conversation key is bound to the conversation id, so the same pair of people talking in
 * two conversations use two different keys, and a ciphertext moved between them will not open.
 */
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';

import { MASTER_KEY_LENGTH } from '@/crypto/types';
import {
  SODIUM_BOX_PUBLIC_KEY_BYTES,
  SODIUM_BOX_SEED_BYTES,
  boxSeedKeypair,
  boxSharedKey,
} from '@/crypto/sodium';
import { utf8Encode, zeroBytes, type Bytes } from '@/utils/bytes';

const EMPTY_SALT = new Uint8Array(0);
const IDENTITY_INFO = 'silentsum/messaging/id/v1';
const CONVERSATION_INFO = 'silentsum/messaging/conv/v1';
const CONTACTS_INFO = 'silentsum/messaging/contact/v1';
const CONVERSATION_KEY_LENGTH = 32;
const CONTACTS_KEY_LENGTH = 32;

/**
 * One unlocked session's messaging identity. Live buffers, like `VaultKeys`: read them while the
 * vault is open, and `dispose()` when it locks.
 */
export interface MessagingIdentity {
  readonly isDisposed: boolean;
  readonly publicKey: Bytes;
  /**
   * Encrypts the private notes this account keeps about its own contacts -- the address it typed
   * to find someone. Those live in the owner's own subtree and still never appear in plaintext.
   */
  readonly contactsKey: Bytes;
  /** The shared key for talking to `peerPublicKey` inside `conversationId`. */
  conversationKey(peerPublicKey: Bytes, conversationId: string): Bytes;
  dispose(): void;
}

export class MessagingIdentityDisposedError extends Error {
  constructor() {
    super('messaging identity disposed');
    this.name = 'MessagingIdentityDisposedError';
  }
}

class SessionMessagingIdentity implements MessagingIdentity {
  private disposed = false;

  constructor(
    private readonly pub: Bytes,
    private readonly secret: Bytes,
    private readonly contacts: Bytes,
  ) {}

  get isDisposed(): boolean {
    return this.disposed;
  }

  get publicKey(): Bytes {
    if (this.disposed) throw new MessagingIdentityDisposedError();
    return this.pub;
  }

  get contactsKey(): Bytes {
    if (this.disposed) throw new MessagingIdentityDisposedError();
    return this.contacts;
  }

  conversationKey(peerPublicKey: Bytes, conversationId: string): Bytes {
    if (this.disposed) throw new MessagingIdentityDisposedError();
    if (peerPublicKey.length !== SODIUM_BOX_PUBLIC_KEY_BYTES) {
      throw new RangeError(`peer public key must be ${SODIUM_BOX_PUBLIC_KEY_BYTES} bytes`);
    }
    if (conversationId === '') throw new RangeError('conversation id must not be empty');
    const shared = boxSharedKey(peerPublicKey, this.secret);
    try {
      return hkdf(
        sha256,
        shared,
        EMPTY_SALT,
        utf8Encode(`${CONVERSATION_INFO}|${conversationId}`),
        CONVERSATION_KEY_LENGTH,
      );
    } finally {
      zeroBytes(shared);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    zeroBytes(this.pub);
    zeroBytes(this.secret);
    zeroBytes(this.contacts);
  }
}

/**
 * Derives the identity from the vault master key. The master key is only read, never kept: the
 * seed is zeroed before this returns and only the X25519 pair survives.
 */
export function deriveMessagingIdentity(masterKey: Bytes): MessagingIdentity {
  if (masterKey.length !== MASTER_KEY_LENGTH) {
    throw new RangeError(`master key must be ${MASTER_KEY_LENGTH} bytes`);
  }
  const seed = hkdf(sha256, masterKey, EMPTY_SALT, utf8Encode(IDENTITY_INFO), SODIUM_BOX_SEED_BYTES);
  try {
    const pair = boxSeedKeypair(seed);
    const contacts = hkdf(
      sha256,
      masterKey,
      EMPTY_SALT,
      utf8Encode(CONTACTS_INFO),
      CONTACTS_KEY_LENGTH,
    );
    return new SessionMessagingIdentity(pair.publicKey, pair.secretKey, contacts);
  } finally {
    zeroBytes(seed);
  }
}
