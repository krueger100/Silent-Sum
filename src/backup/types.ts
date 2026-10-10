/**
 * End-to-end encrypted cloud backup contracts. Only ciphertext and a passphrase-wrapped key
 * envelope ever leave the device. Formats: docs/reference/flutter-firebase-backup.md.
 */
import type { Bytes } from '@/utils/bytes';
import type { KdfParams, VaultKeys, WrappedKey } from '@/crypto/types';
import type { PhotoEntry, VaultRepository } from '@/vault/types';
import type { Ownership } from '@/backup/vaultOwner';
import type { ProgressReport } from '@/utils/progress';

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

/**
 * What an account's cloud backup holds, as the Cloud Gallery needs to show it.
 *
 * `foreign` is not an error. The index is encrypted under the master key of whichever vault
 * wrote it, so an account backed up from a DIFFERENT device cannot be listed here at all --
 * not because anything is wrong, but because this vault does not hold the key. The screen says
 * so and offers restore, where showing an empty gallery would claim the opposite of the truth.
 *
 * `none` is the genuinely empty case: backup is on, and nothing has been put in it yet.
 */
export type CloudContents =
  | {
      readonly kind: 'listed';
      readonly entries: readonly PhotoEntry[];
      /**
       * Entries the index names but Storage no longer holds complete, as of this read.
       *
       * The index is a record of what the user CHOSE for the cloud; it is not evidence that the
       * bytes are still there. An interrupted upload, a half-swept account, or a deletion from
       * another device all leave the two disagreeing, and the gallery has to be able to say which
       * tiles it cannot draw and why.
       *
       * `null` means Storage could not be asked -- offline, or the listing was refused. That is
       * NOT the same as "nothing is missing" and must never be presented as reassurance: the only
       * honest thing to show then is that the check did not run.
       */
      readonly missing: readonly string[] | null;
    }
  | { readonly kind: 'foreign' }
  | { readonly kind: 'none' };

/**
 * How far along a long cloud operation is: items finished, and how many there are in all.
 *
 * Items rather than bytes, because items are what the screen can say honestly. The upload side
 * has no byte-level channel at all (`putBlob` takes no progress callback, unlike `getBlob`), so
 * a byte figure would be invented for half of these operations and real for the other half.
 * "12 of 73" is true for every one of them, and it is also the figure that makes a stall visible:
 * a number that stops moving says something a spinning circle cannot.
 *
 * `total` is fired once up front with `done` at 0, so a screen can show a real bar immediately
 * instead of an indeterminate one that snaps to a percentage a moment later.
 */
export type BackupProgress = ProgressReport;

/**
 * Which photos an upload should carry.
 *
 * `ids` is what makes backup opt-in: the Cloud Gallery is the set the user chose, so the whole
 * vault is never uploaded on a single tap. Omitting it keeps the original meaning -- back up
 * everything -- which is what a rebind and the existing specs rely on.
 */
export interface BackupSelection extends CrossAccountOptions {
  readonly ids?: readonly string[];
  /** Called as each photo finishes, for the progress line on screen. */
  readonly onProgress?: BackupProgress;
}
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
  /**
   * Entries this run was asked to repair and could not: their Storage objects are gone AND this
   * device has no local copy to put back.
   *
   * It exists because zero uploads used to be indistinguishable from success. "Back up now"
   * reported "nothing needed repairing" for an item whose bytes had been lost on both sides --
   * the one case where the user genuinely needs telling, because that photo is not coming back
   * and no button on the screen will change it.
   *
   * Always zero when `ids` was omitted: nothing was named, so nothing failed to be repaired.
   */
  readonly unrepairable: number;
}

export interface RestoreReport {
  readonly restored: number;
  /**
   * Photos the vault already held, left exactly as they were.
   *
   * Nothing was downloaded for these and nothing needed to be: the id was already in the
   * repository, so the photo is on this device. Safe, and the word "skipped" is only honest
   * about THIS.
   */
  readonly skipped: number;
  /**
   * Photos the index listed whose bytes are not in Storage.
   *
   * These used to be counted as `skipped`, which made the one outcome the user genuinely needs
   * telling about indistinguishable from the harmless one: "28 photos already on this device,
   * left untouched" was printed for photos that were not on this device and never would be. On
   * the fresh-device restore path it was worse, because there `skipped` can only ever mean this
   * -- a new vault holds nothing to skip -- so every loss was reported in the language of safety.
   *
   * A restore cannot fix it. The index is a record of what was uploaded; if the object behind an
   * entry has been deleted, no passphrase and no retry brings it back, and saying so is the only
   * useful thing left to do.
   */
  readonly missing: number;
  /**
   * The ids this account's cloud index listed that are now present locally. It is the exact
   * set {@link BackupService.rebindBackup} may re-upload: everything else in the vault belongs to
   * this device rather than to this account.
   *
   * The ids counted in {@link missing} are NOT here. They are not on this device, so a rebind
   * has nothing to upload for them, and listing them would make this the set of "ids the index
   * mentioned" rather than the set the name and the rebind both mean.
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
    options?: BackupSelection,
  ): Promise<BackupReport>;
  /**
   * What this account's backup holds, for the Cloud Gallery to list.
   *
   * Reads the account's own index and nothing else, so it is account-scoped by construction:
   * there is no device-level record of "what is backed up" for two accounts to share, and so
   * nothing to get wrong. Signed out there is no account, and no Cloud Gallery.
   */
  cloudContents(keys: VaultKeys): Promise<CloudContents>;
  /**
   * One backed-up thumbnail, decrypted, for a Cloud Gallery tile whose photo is not on this
   * device any more.
   *
   * No new key and no new trust. The thumbnail blob is uploaded verbatim -- the bytes as they sit
   * in the vault, already sealed under `VaultKeyId.thumb` -- and {@link cloudContents} only
   * returns `listed` when the index decrypted under this vault's manifest key, which proves the
   * master key matches and therefore that the thumb key does too. A backup made by another vault
   * is `foreign` and is never listed, so this is never reached for one.
   *
   * Returns plaintext JPEG bytes and writes nothing to disk. The caller owns them, and the only
   * place they may be kept is a cache the vault lock empties.
   */
  readCloudThumbnail(keys: VaultKeys, id: string): Promise<Bytes>;
  /**
   * Removes ids from the cloud and leaves every local copy alone.
   *
   * The two halves are independent on purpose. Taking a photo out of the backup says nothing
   * about the photo on this device, and deleting it here says nothing about the backup. Either
   * can be done without the other; doing both is two acts, never one.
   *
   * Returns how many were actually removed.
   */
  removeFromCloud(keys: VaultKeys, ids: readonly string[]): Promise<number>;
  /** Returns the 32-byte master key; the caller MUST zero it. */
  recoverMasterKey(passphrase: string): Promise<Bytes>;
  /**
   * The master key that opens this account's MESSAGING, which is not always the one that opens
   * its photos.
   *
   * Reads the messaging escrow where there is one, and falls back to the backup envelope where
   * there is not -- which is the right answer for every account that enabled backup before the
   * escrow existed and has never been rebound. The two diverge precisely when this vault is not
   * the one that set the account's messaging up.
   *
   * Returns the 32-byte master key; the caller MUST zero it. Throws WrongPassphraseError on a
   * bad passphrase, exactly as {@link recoverMasterKey} does.
   */
  recoverMessagingKey(passphrase: string): Promise<Bytes>;
  /**
   * Whether `masterKey` is already the one that opens this account's messaging.
   *
   * One document read and no key derivation, for callers that are holding the vault master key
   * and want to know whether {@link recoverMessagingKey} would tell them anything new. True when
   * the account has no escrow, or has one this key produces -- in both cases the key in hand is
   * the answer. False only when the account's messaging belongs to a different vault.
   *
   * Optimistic on failure: an unreadable escrow answers true, because the caller's fallback is
   * the key it already has, which is the same thing this would have told it.
   */
  messagingKeyIsMine(masterKey: Bytes): Promise<boolean>;
  /**
   * Makes this account's messaging key recoverable on a future device, given a key and the
   * passphrase that should protect it.
   *
   * For the accounts the escrow would otherwise never reach: one that turned backup on before the
   * escrow existed never calls {@link enable} again, so nothing would ever write one. Callers
   * invoke this wherever they already hold both -- after a restore, after a successful recovery --
   * so no user is asked for a passphrase they have just typed.
   *
   * Refuses silently, by the same rule {@link enable} uses: if the account publishes a messaging
   * key this `masterKey` does not produce, nothing is written. It can therefore create an escrow
   * but never replace a good one with a key that opens nothing. Best effort; a failure is never
   * the caller's problem.
   */
  protectMessagingKey(masterKey: Bytes, passphrase: string): Promise<void>;
  /** Repository must be open with keys derived from the recovered master key. */
  restoreInto(
    repository: VaultRepository,
    keys: VaultKeys,
    onProgress?: BackupProgress,
  ): Promise<RestoreReport>;
  /**
   * Restores a backup whose master key is NOT the open vault's, re-encrypting each item on the way
   * in. The vault keeps its own key and its existing photos. Follow it with {@link rebindBackup},
   * or the account is left holding ciphertext under a key this device no longer uses.
   */
  restoreForeignInto(
    repository: VaultRepository,
    keys: VaultKeys,
    backupMaster: Bytes,
    onProgress?: BackupProgress,
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
    onProgress?: BackupProgress,
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
  /**
   * `ownerUid` is null when this device's own note of its last backup account could not be read.
   * The question still has to be asked -- nothing has established that these photos belong in this
   * account -- but it must be asked without claiming to know whose they were, which is what the
   * copy on the confirmation used to do on the strength of an unparseable byte.
   */
  constructor(readonly ownerUid: string | null) {
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
