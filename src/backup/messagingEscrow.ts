/**
 * The account's messaging key, wrapped under its recovery passphrase, kept apart from the vault.
 *
 * WHY THIS EXISTS. A messaging identity is `deriveMessagingIdentity(masterKey)` -- the X25519
 * keypair AND the contacts key, both HKDF'd from one master key with no uid in the derivation. The
 * account publishes the public half at `messagingKeys/{uid}` and never rotates it, because
 * rotating strands whoever holds the real one; an audit found ten production accounts broken
 * exactly that way. So the ONLY thing that can ever read an account's conversations again is the
 * master key that first set them up.
 *
 * Until this document existed, that key had exactly one recoverable copy: `users/{uid}/vault/
 * envelope`, the backup envelope. And `rebindBackup` ends by calling `enable`, which REPLACES that
 * envelope with this device's vault master key wrapped under the same passphrase. One rebind, and
 * the passphrase that used to recover the messaging identity recovered a different key instead --
 * silently, with no warning and no second copy. Every conversation on the account became
 * permanently unreadable, and the only symptom was a refusal weeks later saying "a different vault
 * set that up".
 *
 * That is the bug this fixes, and it is fixed by separation rather than by a warning: the
 * messaging key gets its own record, which the rebind path is structurally unable to overwrite.
 * See `BackupService.enable` for the one rule that guarantees it.
 *
 * WHAT IT IS NOT. Not a second copy of the vault. The document is opaque to the server -- a
 * passphrase-wrapped key with its own salt and its own AAD, so a blob lifted from the backup
 * envelope cannot be substituted into it or the other way round. Not a key the server can use:
 * Argon2id over a passphrase that never leaves the device stands between it and anything. And not
 * a way around the public-key check: recovery still derives the identity and compares it to what
 * the account published, and still refuses when they differ.
 *
 * `publicKey` is stored in the clear on purpose. It is already public -- the same string
 * `messagingKeys/{uid}` holds -- and keeping it here lets both the client and a human tell whether
 * an escrow is the right one for the account WITHOUT unwrapping anything, which is the difference
 * between "this cannot help you" and one wasted Argon2id run.
 *
 * Comparable designs: WhatsApp's end-to-end encrypted backup (a key held under a user secret,
 * separate from the device's own) and Signal's SVR (a master key recoverable by PIN, independent
 * of the identity key the device holds). Both separate "what this device happens to hold" from
 * "what this account can get back" -- precisely the separation that was missing here.
 */
import { kdfParamsFromJson, kdfParamsToJson } from '@/crypto/kdfParams';
import { wrappedKeyFromJson, wrappedKeyToJson } from '@/crypto/keyWrapping';
import { RecordFormatError, type KdfParams, type WrappedKey } from '@/crypto/types';
import { base64Decode, base64Encode, Base64Error } from '@/utils/base64';
import { parseIso8601, toIso8601Utc } from '@/utils/iso8601';
import type { Bytes } from '@/utils/bytes';

const MIN_SALT_LENGTH = 8;
const MAX_SALT_LENGTH = 64;

/** A sibling of the envelope, under the account-scoped prefix the rules already grant. */
export const messagingEscrowPath = (uid: string): string => `users/${uid}/vault/messaging`;

export interface MessagingEscrow {
  readonly version: 1;
  /** Its own salt. Sharing the envelope's would let one Argon2id run open both. */
  readonly salt: Bytes;
  readonly kdf: KdfParams;
  /** The master key that derives this account's messaging identity. */
  readonly wrappedMasterKey: WrappedKey;
  /**
   * The X25519 public key this escrow yields, base64.
   *
   * Not secret, and not trusted: it is what `messagingKeys/{uid}` already publishes, and recovery
   * re-derives and re-checks it after unwrapping. Its only job is to let a stale escrow be
   * recognised and skipped before anyone pays for a key derivation.
   */
  readonly publicKey: string;
  /** Epoch ms UTC. Diagnostics only; nothing branches on it. */
  readonly createdAt: number;
}

export function escrowToJson(escrow: MessagingEscrow): Record<string, unknown> {
  return {
    v: escrow.version,
    salt: base64Encode(escrow.salt),
    kdf: kdfParamsToJson(escrow.kdf),
    wrapped: wrappedKeyToJson(escrow.wrappedMasterKey),
    publicKey: escrow.publicKey,
    createdAt: toIso8601Utc(escrow.createdAt),
  };
}

/**
 * Parses a document that arrived from the network, so every field is hostile until validated --
 * the KDF bounds in particular, which stop a tampered escrow from asking the device to allocate
 * gigabytes while the user waits on a recovery screen. `kdfParamsFromJson` enforces those.
 */
export function escrowFromJson(value: unknown): MessagingEscrow {
  if (typeof value !== 'object' || value === null) {
    throw new RecordFormatError('messaging escrow is not an object');
  }
  const source = value as Record<string, unknown>;
  const version = source.v === undefined ? 1 : source.v;
  if (version !== 1) throw new RecordFormatError('unsupported messaging escrow version');

  if (typeof source.salt !== 'string') {
    throw new RecordFormatError('messaging escrow salt is not a string');
  }
  let salt;
  try {
    salt = base64Decode(source.salt);
  } catch (cause) {
    if (cause instanceof Base64Error) {
      throw new RecordFormatError('messaging escrow salt is not base64');
    }
    throw cause;
  }
  if (salt.length < MIN_SALT_LENGTH || salt.length > MAX_SALT_LENGTH) {
    throw new RecordFormatError('bad messaging escrow salt length');
  }

  if (typeof source.publicKey !== 'string' || source.publicKey === '') {
    throw new RecordFormatError('messaging escrow has no public key');
  }

  return {
    version: 1,
    salt,
    kdf: kdfParamsFromJson(source.kdf),
    wrappedMasterKey: wrappedKeyFromJson(source.wrapped),
    publicKey: source.publicKey,
    createdAt: parseIso8601(source.createdAt),
  };
}
