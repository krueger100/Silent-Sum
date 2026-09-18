/**
 * End-to-end encrypted cloud backup contracts. Only ciphertext and a passphrase-wrapped key
 * envelope ever leave the device. Formats: docs/reference/flutter-firebase-backup.md.
 */
import type { Bytes } from '@/utils/bytes';
import type { KdfParams, VaultKeys, WrappedKey } from '@/crypto/types';
import type { VaultRepository } from '@/vault/types';

export interface BackupEnvelope {
  readonly version: 1;
  readonly salt: Bytes; // 16 bytes
  readonly kdf: KdfParams; // KDF_PRESETS.backup when created here
  readonly wrappedMasterKey: WrappedKey; // AAD = AAD.backupEnvelope
  readonly createdAt: number; // epoch ms UTC
}

/** Firestore document shape: {"v":1,"salt":b64,"kdf":{...},"wrapped":{...},"createdAt":iso} */

export const PASSPHRASE_MIN_LENGTH = 12;

export interface BackupReport {
  /** Photos this run uploaded. Zero means the cloud already had everything on the device. */
  readonly uploaded: number;
  /**
   * Photos in the backup that are no longer on this device. They are KEPT, never pruned -- see
   * `BackupService.backupNow` for why the backup only grows. Worth reporting because it is the
   * difference between the two counts a user can otherwise not explain.
   */
  readonly cloudOnly: number;
  /** Photos in the backup once this run finished. */
  readonly total: number;
}

export interface RestoreReport {
  readonly restored: number;
  readonly skipped: number;
}

export interface BackupService {
  hasEnvelope(): Promise<boolean>;
  /** Creates or replaces the envelope. Throws InvalidPassphraseError before any network call. */
  enable(keys: VaultKeys, passphrase: string): Promise<void>;
  /**
   * Uploads what is missing and deletes nothing. Needs the keys to merge the cloud's index with
   * this device's, so blobs kept for photos deleted here stay restorable.
   */
  backupNow(repository: VaultRepository, keys: VaultKeys): Promise<BackupReport>;
  /** Returns the 32-byte master key; the caller MUST zero it. */
  recoverMasterKey(passphrase: string): Promise<Bytes>;
  /** Repository must be open with keys derived from the recovered master key. */
  restoreInto(repository: VaultRepository, keys: VaultKeys): Promise<RestoreReport>;
  /**
   * Restores a backup whose master key is NOT the open vault's, re-encrypting each item on the way
   * in. The vault keeps its own key and its existing photos. Follow it with {@link rebindBackup},
   * or the account is left holding ciphertext under a key this device no longer uses.
   */
  restoreForeignInto(
    repository: VaultRepository,
    keys: VaultKeys,
    backupMaster: Bytes,
  ): Promise<RestoreReport>;
  /** Re-uploads the whole vault and rewraps the envelope under `keys`, keeping the passphrase. */
  rebindBackup(repository: VaultRepository, keys: VaultKeys, passphrase: string): Promise<void>;
  /** Deletes every blob and document for the account. Does not sign out. */
  disable(): Promise<void>;
  /**
   * The same deletion, but checked: it sweeps the account's own prefix, then reads back to confirm
   * nothing survived, and throws {@link AccountDataRemainsError} if anything did.
   *
   * For use immediately before deleting the credential itself. There is no cascade on the server
   * and the rules key on the uid, so data still standing when the account goes is unreachable and
   * undeletable afterwards -- by the user, and by anyone else.
   */
  purgeAccount(): Promise<void>;
}

export const BACKUP_PATHS = {
  /**
   * Everything the account owns lives under here, in Storage and in Firestore alike.
   *
   * Trailing slash on purpose: this one names a folder to list, never an object. The owner check
   * only treats a path as a folder when it ends in one, and `users/<uid>` with no slash is refused
   * outright -- it is the shape a traversal would produce. Firebase normalises it away when the
   * ref is built, so the deployed side sees the same prefix either way.
   */
  account: (uid: string) => `users/${uid}/`,
  envelope: (uid: string) => `users/${uid}/vault/envelope`,
  manifest: (uid: string) => `users/${uid}/vault/manifest`,
  index: (uid: string) => `users/${uid}/index.enc`,
  photo: (uid: string, id: string) => `users/${uid}/photos/${id}.enc`,
  thumb: (uid: string, id: string) => `users/${uid}/thumbs/${id}.enc`,
  photosPrefix: (uid: string) => `users/${uid}/photos`,
  thumbsPrefix: (uid: string) => `users/${uid}/thumbs`,
} as const;

export class BackupNotEnabledError extends Error {
  constructor() {
    super('BackupNotEnabledError');
    this.name = 'BackupNotEnabledError';
  }
}

/**
 * A purge finished with data still filed under the account.
 *
 * It exists to stop the one mistake that cannot be walked back. Deleting the credential is what
 * makes leftovers permanent: storage and Firestore rules grant access by uid, so an object or
 * document that outlives its account can never be read or removed again by anyone. Reporting the
 * failure and leaving the account alive keeps the only credential that could still clean up.
 */
export class AccountDataRemainsError extends Error {
  /** How many objects and documents were still there, for the sentence shown to the user. */
  readonly remaining: number;

  constructor(remaining: number) {
    super('AccountDataRemainsError');
    this.name = 'AccountDataRemainsError';
    this.remaining = remaining;
  }
}

/**
 * The account's backup was written by a vault with a different master key, so this one cannot read
 * its index and must not add to it.
 *
 * It is an ordinary state, not a corruption: any vault erased and set up again produces it, which
 * is exactly what happens after a wipe or a forgotten PIN. `restoreForeignInto` is the way out,
 * and the message the user sees says so -- without this type the failure surfaced as a bare
 * "Something went wrong", which is true, useless, and looks like a bug in the app.
 */
export class ForeignBackupError extends Error {
  constructor() {
    super('ForeignBackupError');
    this.name = 'ForeignBackupError';
  }
}

export class WrongPassphraseError extends Error {
  constructor() {
    super('WrongPassphraseError');
    this.name = 'WrongPassphraseError';
  }
}

export class InvalidPassphraseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPassphraseError';
  }
}
