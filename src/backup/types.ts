/**
 * End-to-end encrypted cloud backup contracts. Only ciphertext and a passphrase-wrapped key
 * envelope ever leave the device. Formats: docs/reference/flutter-firebase-backup.md.
 */
import type { Bytes } from '@/utils/bytes';
import type { KdfParams, VaultKeys, WrappedKey } from '@/crypto/types';
import type { VaultRepository } from '@/vault/types';
import type { Ownership } from '@/backup/vaultOwner';

export interface BackupEnvelope {
  readonly version: 1;
  readonly salt: Bytes; // 16 bytes
  readonly kdf: KdfParams; // KDF_PRESETS.backup when created here
  readonly wrappedMasterKey: WrappedKey; // AAD = AAD.backupEnvelope
  readonly createdAt: number; // epoch ms UTC
  /**
   * Which vault this account's backup belongs to: `deriveVaultId` of the key inside `wrapped`.
   *
   * Null on every envelope written before this field existed, and null is NOT a mismatch -- it
   * means "unknown", and the caller falls back to the cryptographic check it has always used.
   * Writing it needs the Firestore rules to allow the field; see `BackupService` for how a build
   * whose rules have not caught up degrades instead of failing.
   */
  readonly vaultId: string | null;
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
  /**
   * The ids this account's cloud index listed, which are now all present locally. It is the exact
   * set {@link BackupService.rebindBackup} may re-upload: everything else in the vault belongs to
   * this device rather than to this account.
   */
  readonly cloudIds: readonly string[];
}

export interface BackupService {
  hasEnvelope(): Promise<boolean>;
  /**
   * What this device's vault binding says about the account signed in now. For presentation only:
   * every write path re-checks it, so a screen that forgot to look cannot cause a cross-account
   * upload.
   */
  ownership(): Promise<Ownership>;
  /**
   * Creates or replaces the envelope. Throws InvalidPassphraseError before any network call, and
   * ForeignVaultError when this vault is already backed up to another account -- turning backup on
   * hands that account's passphrase the power to unwrap this vault's master key, so it is a
   * cross-account act even though it uploads no photo.
   */
  enable(keys: VaultKeys, passphrase: string, options?: CrossAccountOptions): Promise<void>;
  /**
   * Uploads what is missing and deletes nothing. Needs the keys to merge the cloud's index with
   * this device's, so blobs kept for photos deleted here stay restorable.
   */
  backupNow(
    repository: VaultRepository,
    keys: VaultKeys,
    options?: CrossAccountOptions,
  ): Promise<BackupReport>;
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
  /**
   * Re-uploads the photos named by `ids` under `keys` and rewraps the envelope, keeping the
   * passphrase. `ids` is the set that came from THIS account's own backup -- never the whole
   * vault, or photos belonging to another account would be uploaded with them.
   */
  rebindBackup(
    repository: VaultRepository,
    keys: VaultKeys,
    passphrase: string,
    ids: readonly string[],
  ): Promise<void>;
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

/**
 * Consent for an operation that would move this device's photos into an account that does not
 * already hold them. Absent or false means "ask me first", which is the default everywhere.
 */
export interface CrossAccountOptions {
  readonly confirmedCrossAccount?: boolean;
}

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

/**
 * This device's vault has already been backed up to a DIFFERENT account, and the operation asked
 * for would have put its photos into the account signed in now.
 *
 * Not a fault and not a refusal of last resort: it is a question. The caller re-runs the same
 * operation with `confirmedCrossAccount` once the user has been told whose photos are about to
 * move where. Distinct from {@link ForeignBackupError}, which is about a KEY that cannot open an
 * account's data; this one is about photos that have no business being in that account at all.
 */
export class ForeignVaultError extends Error {
  constructor(readonly ownerUid: string) {
    super('ForeignVaultError');
    this.name = 'ForeignVaultError';
  }
}

/**
 * This account's backup names a different vault than the one open on this device.
 *
 * The stronger, earlier sibling of {@link ForeignBackupError}: that one is discovered by a decrypt
 * failing, after the index has been fetched, and only when the data happens to be reachable. This
 * one is a stated identity that does not match, so it can refuse before a byte moves and can say
 * which vault the account belongs to.
 */
export class VaultIdMismatchError extends Error {
  constructor(
    readonly accountVaultId: string,
    readonly deviceVaultId: string,
  ) {
    super('VaultIdMismatchError');
    this.name = 'VaultIdMismatchError';
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
