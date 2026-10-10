/**
 * End-to-end-encrypted cloud backup.
 *
 * What is uploaded: the payload, thumbnail and index blobs exactly as they sit on disk, which
 * means already encrypted under keys derived from the vault master key, plus a `BackupEnvelope`
 * holding that master key wrapped under the user's recovery passphrase.
 *
 * What is never uploaded: the PIN, the master key in the clear, and any plaintext image or video.
 * The server, and anyone who compromises it, sees opaque bytes and cannot do anything with them.
 *
 * Videos take the same route through a different door. Their ciphertext is far too large to hold
 * in JavaScript, so it is handed to the SDK as a file path on the way up and written straight to a
 * file on the way down. The bytes are the same bytes -- the blob on disk, uploaded verbatim -- and
 * the only difference is that they are never a `Uint8Array`.
 *
 * The local vault never depends on any of this. Backup being unavailable, misconfigured or
 * switched off changes nothing about unlocking or viewing photos.
 */
import { envelopeFromJson, envelopeToJson } from '@/backup/backupEnvelope';
import { keyFingerprint, traceRecovery } from '@/messaging/recoveryTrace';
import {
  escrowFromJson,
  escrowToJson,
  messagingEscrowPath,
  type MessagingEscrow,
} from '@/backup/messagingEscrow';
import { assertValidPassphrase } from '@/backup/passphrasePolicy';
import {
  AccountDataRemainsError,
  BACKUP_PATHS,
  BackupNotEnabledError,
  ForeignBackupError,
  ForeignVaultError,
  VaultIdMismatchError,
  WrongPassphraseError,
  type CrossAccountOptions,
  type BackupProgress,
  type BackupSelection,
  type CloudContents,
  type BackupReport,
  type BackupService as BackupServiceContract,
  type RestoreReport,
} from '@/backup/types';
import {
  AAD,
  KDF_PRESETS,
  VaultKeyId,
  RecordFormatError,
  WrongKeyError,
  type FileCipher,
  type KdfParams,
  type KeyDerivation,
  type KeyWrapping,
  type SecureRandom,
  type StreamCipher,
  type VaultKeys,
} from '@/crypto/types';
import { deriveVaultId, deriveVaultKeys } from '@/crypto/vaultKeys';
import { CloudError, type CloudBackend, type CloudUser } from '@/firebase/types';
import { joinUri, type FileSystem } from '@/storage/fileSystem';
import type { SecureDelete } from '@/storage/secureDelete';
import { isVideo, payloadKeyId } from '@/vault/mediaKind';
import { decodeIndex, encodeIndex, sortedNewestFirst } from '@/vault/vaultIndex';
import type { PhotoEntry, VaultRepository } from '@/vault/types';
import { ownershipFor, type Ownership, type VaultOwnerStore } from '@/backup/vaultOwner';
import { base64Decode, base64Encode, Base64Error } from '@/utils/base64';
import { utf8Decode, utf8Encode, zeroBytes, type Bytes } from '@/utils/bytes';
import type { Clock } from '@/utils/clock';

const SALT_LENGTH = 16;

/**
 * How much base64 index the manifest document will carry as a fallback copy.
 *
 * Firestore rejects a document over 1 MiB outright, so the budget leaves generous room for the
 * id list and field overhead. An index large enough to exceed it belongs to an account with
 * thousands of photos; that backup simply goes without the safety net rather than failing.
 */
const MANIFEST_INDEX_BUDGET = 700_000;

/** Where a downloaded video blob lands before it is authenticated and moved into the vault. */
const RESTORE_DIRECTORY_NAME = 'silentsum-restore-payload';

export interface BackupServiceOptions {
  backend: CloudBackend;
  kdf: KeyDerivation;
  wrapping: KeyWrapping;
  cipher: FileCipher;
  /** Only `restoreForeignInto` needs it: re-encrypting a video is file-to-file, never a buffer. */
  streamCipher: StreamCipher;
  clock: Clock;
  random: SecureRandom;
  /** App-private storage, for payloads that are transferred as files rather than buffers. */
  fs: FileSystem;
  secureDelete: SecureDelete;
  /** Which account this device's vault is backed up to. Not optional: it is a safety gate. */
  owner: VaultOwnerStore;
  kdfParams?: KdfParams;
  /**
   * What this service needs to know about messaging, and nothing more.
   *
   * Two pure questions -- "which public key does this master key produce" and "which one has the
   * account published" -- injected rather than imported, so backup keeps no dependency on the
   * messaging module and a build without messaging simply maintains no escrow. The answers decide
   * only whether the escrow may be WRITTEN; they can never cause one to be destroyed.
   */
  messaging?: MessagingKeyBridge;
}

export interface MessagingKeyBridge {
  /** `deriveMessagingIdentity(masterKey).publicKey`, base64. Must not retain the key. */
  publicKeyFor(masterKey: Bytes): string;
  /** What `messagingKeys/{uid}` holds, or null when the account has published nothing. */
  publishedKey(uid: string): Promise<string | null>;
}

/**
 * Which vault the account's backup belongs to, as its envelope reports it.
 *
 * Deliberately three-valued. The absence of a `vaultId` is not evidence of a mismatch, and
 * collapsing it into either answer would strand the oldest backups or wave through a genuine
 * mismatch.
 */
type EnvelopeOwner =
  | { readonly kind: 'this-vault' }
  | { readonly kind: 'another-vault'; readonly theirs: string; readonly mine: string }
  | { readonly kind: 'unknown' };

export class BackupService implements BackupServiceContract {
  private readonly backend: CloudBackend;
  private readonly kdf: KeyDerivation;
  private readonly wrapping: KeyWrapping;
  private readonly cipher: FileCipher;
  private readonly streamCipher: StreamCipher;
  private readonly clock: Clock;
  private readonly random: SecureRandom;

  private readonly owner: VaultOwnerStore;

  /**
   * Whether this account's Firestore rules have been seen to accept `vaultId`. Starts optimistic
   * and is cleared for the session by the first refusal; a new launch tries again, which costs one
   * extra write only on a project whose rules are still behind.
   */
  private vaultIdWritesAccepted = true;
  private readonly fs: FileSystem;
  private readonly secureDelete: SecureDelete;
  private readonly kdfParams: KdfParams;
  private readonly messaging: MessagingKeyBridge | null;
  /**
   * Whether the rules have been seen to accept the escrow document, same idea as
   * {@link vaultIdWritesAccepted} and for the same reason: `users/{uid}/vault/messaging` needs a
   * rules match that may not be deployed yet, and turning backup on must not start failing the
   * day this ships. A refusal is absorbed once and not retried for the session.
   */
  private escrowWritesAccepted = true;

  constructor(options: BackupServiceOptions) {
    this.backend = options.backend;
    this.kdf = options.kdf;
    this.wrapping = options.wrapping;
    this.cipher = options.cipher;
    this.streamCipher = options.streamCipher;
    this.clock = options.clock;
    this.random = options.random;
    this.fs = options.fs;
    this.secureDelete = options.secureDelete;
    this.kdfParams = options.kdfParams ?? KDF_PRESETS.backup;
    this.owner = options.owner;
    this.messaging = options.messaging ?? null;
  }

  /**
   * Stops and asks before moving this device's photos, or the power to unwrap its master key, into
   * an account that has never held them.
   *
   * A vault nobody has backed up yet is free to be backed up -- there is no other account to
   * disturb -- and a vault this account already owns carries on silently. The interesting case is
   * everything else, and it used to be settled by {@link VaultOwnerStore} alone, which was wrong in
   * two directions that both looked like a broken app:
   *
   *   - the note holds ONE uid, so a person with two of their own accounts on one phone had it
   *     rewritten on every backup and was asked to confirm a cross-account transfer every time they
   *     switched back -- while both accounts' envelopes already named this very vault;
   *   - a note that would not parse resolved to "owned by someone else", so a damaged byte refused
   *     every write, with no way past it but to confirm a transfer that was not happening.
   *
   * So the note is a cache now and the account's own envelope is the authority. `vaultId` is
   * derived from the master key and written by whichever vault owns the backup: if it names this
   * vault, this vault demonstrably owns this account's backup and there is nothing to ask about.
   * The note is corrected and the write proceeds.
   *
   * Only where the cloud CANNOT say -- no envelope yet, an envelope from before `vaultId` existed,
   * or a read that failed -- does the note get the last word, and then only to ask. It never
   * refuses on its own: {@link ForeignVaultError} is a question the UI puts to the user, who
   * answers it with `confirmedCrossAccount`.
   *
   * Costs one document read, and only on the path that was about to interrupt somebody. In
   * `backupNow` that is the same document {@link assertVaultOwnsAccount} reads a moment later; a
   * second read on a path already stopping to ask a human is not worth a cache that could go stale
   * between the two.
   */
  private async assertMayWrite(
    uid: string,
    keys: VaultKeys,
    options?: CrossAccountOptions,
  ): Promise<void> {
    if (options?.confirmedCrossAccount === true) return;
    const ownership = ownershipFor(await this.owner.read(), uid);
    if (ownership.kind === 'owned' || ownership.kind === 'unbound') return;
    if ((await this.envelopeOwner(uid, keys)).kind === 'this-vault') {
      // The cloud says this vault owns this account's backup. The note was behind; correct it
      // rather than interrogating the user about a transfer they consented to some time ago.
      await this.owner.bind(uid, this.clock.now());
      return;
    }
    throw new ForeignVaultError(ownership.kind === 'other-account' ? ownership.ownerUid : null);
  }

  /**
   * Writes a document that may carry `vaultId`, falling back to the same document without it.
   *
   * The live rules validate both of these documents with `hasOnly(...)`, so until
   * `firebase/firestore.deploy.rules` has been deployed a document carrying the field is refused
   * outright. An app that simply wrote it would break every backup on every device the moment it
   * shipped, and an app that waited for a flag would need someone to remember to flip it.
   *
   * So it tries, and on a refusal drops the field, retries once, and stops trying for the rest of
   * the session. If the retry fails too the error propagates untouched -- that is a real
   * permission problem, not a schema one. Once the rules are deployed the first attempt simply
   * succeeds and nothing here ever runs again.
   */
  private async putWithVaultId(
    path: string,
    document: Record<string, unknown>,
    vaultId: string,
  ): Promise<void> {
    if (!this.vaultIdWritesAccepted) {
      await this.backend.putDocument(path, document);
      return;
    }
    try {
      await this.backend.putDocument(path, { ...document, vaultId });
      return;
    } catch (cause) {
      if (!(cause instanceof CloudError) || cause.code !== 'permission-denied') throw cause;
    }
    // One retry, without the field. A second refusal is the caller's problem to report.
    await this.backend.putDocument(path, document);
    this.vaultIdWritesAccepted = false;
  }

  /**
   * Which vault owns this ACCOUNT's backup, according to the account's own envelope.
   *
   * The one fact both write gates are built on, read in one place so they cannot drift apart.
   * `unknown` covers three situations that mean the same thing here -- no envelope, an envelope
   * from before `vaultId` existed, and a read that failed -- because none of them is evidence
   * either way, and treating absence as a mismatch would strand exactly the users with the oldest
   * backups. Those fall through to `readCloudIndex`, whose decrypt has always been the real proof;
   * the id only ever lets a refusal come EARLIER and say more.
   */
  private async envelopeOwner(uid: string, keys: VaultKeys): Promise<EnvelopeOwner> {
    let envelope;
    try {
      const document = await this.backend.getDocument(BACKUP_PATHS.envelope(uid));
      if (document === null) return { kind: 'unknown' };
      envelope = envelopeFromJson(document);
    } catch {
      return { kind: 'unknown' };
    }
    if (envelope.vaultId === null) return { kind: 'unknown' };
    const mine = deriveVaultId(keys.masterKey);
    return envelope.vaultId === mine
      ? { kind: 'this-vault' }
      : { kind: 'another-vault', theirs: envelope.vaultId, mine };
  }

  /**
   * Refuses when this ACCOUNT's backup belongs to a different VAULT.
   *
   * A different question from {@link assertMayWrite}, which asks whether these photos belong in
   * this account. This one asks whether this device can coherently add to what the account already
   * holds, and the two fail for different reasons: one is a question for the user, this one is a
   * fact about the data. It is NOT device state -- a vault id lives in the cloud and travels with
   * the account -- so it stays exactly as strict as it was.
   */
  private async assertVaultOwnsAccount(uid: string, keys: VaultKeys): Promise<void> {
    const owner = await this.envelopeOwner(uid, keys);
    if (owner.kind !== 'another-vault') return;
    throw new VaultIdMismatchError(owner.theirs, owner.mine);
  }

  async ownership(): Promise<Ownership> {
    const user = this.backend.currentUser;
    if (user === null) return { kind: 'unbound' };
    return ownershipFor(await this.owner.read(), user.uid);
  }

  async hasEnvelope(): Promise<boolean> {
    const user = this.requireUser();
    return (await this.backend.getDocument(BACKUP_PATHS.envelope(user.uid))) !== null;
  }

  async enable(
    keys: VaultKeys,
    passphrase: string,
    options?: CrossAccountOptions,
  ): Promise<void> {
    // Validate before touching the network so a weak passphrase never reaches a server log.
    assertValidPassphrase(passphrase);
    const user = this.requireUser();
    // Before the network too: an envelope hands this account's passphrase the power to unwrap this
    // vault's master key, which is a transfer of reach even though no photo moves.
    await this.assertMayWrite(user.uid, keys, options);
    const salt = this.random.bytes(SALT_LENGTH);
    const kek = await this.deriveKek(passphrase, salt, this.kdfParams);
    try {
      const wrappedMasterKey = await this.wrapping.wrap(
        keys.masterKey,
        kek,
        AAD.backupEnvelope,
      );
      const vaultId = deriveVaultId(keys.masterKey);
      await this.putWithVaultId(
        BACKUP_PATHS.envelope(user.uid),
        envelopeToJson({
          version: 1,
          salt,
          kdf: this.kdfParams,
          wrappedMasterKey,
          createdAt: this.clock.now(),
          // Carried separately by `putWithVaultId` so the fallback can drop it; the codec would
          // otherwise bake it into the document shape before the rules have been asked.
          vaultId: null,
        }),
        vaultId,
      );
      await this.owner.bind(user.uid, this.clock.now());
      // After the envelope, and deliberately not inside its try: a failure here must never undo
      // a backup that is now correctly enabled.
      await this.writeMessagingEscrow(user.uid, keys.masterKey, passphrase);
    } finally {
      zeroBytes(kek);
    }
  }

  /**
   * Keeps the account's messaging key recoverable, and -- the whole point -- knows when NOT to.
   *
   * ONE RULE: if the account has published a messaging key that this vault's master key does not
   * produce, this writes nothing at all. That single condition is what makes a rebind safe. A
   * rebind is by definition a vault adopting an account it did not set up, so the published key is
   * not this vault's, so this returns before touching anything, and whatever escrow the real
   * vault left behind survives untouched. There is no branch here that can overwrite a good
   * escrow with a key that cannot read the account's conversations -- not because the code checks
   * for a rebind, but because it cannot tell one from any other foreign vault and refuses them
   * all alike.
   *
   * When the keys DO agree, or the account has published nothing yet, the escrow is written or
   * refreshed. Refreshing matters: changing the recovery passphrase re-wraps the envelope, and an
   * escrow left under the old passphrase would be a key nobody could reach.
   *
   * Best effort throughout. Not having an escrow is the status quo for every account that
   * predates it; failing to turn backup on would be a regression.
   */
  async protectMessagingKey(masterKey: Bytes, passphrase: string): Promise<void> {
    const user = this.backend.currentUser;
    if (user === null || passphrase === '') return;
    try {
      await this.writeMessagingEscrow(user.uid, masterKey, passphrase);
    } catch {
      // Opportunistic. The caller has just finished something that succeeded, and failing to
      // store a convenience copy of a key must not turn that into an error the user sees.
    }
  }

  private async writeMessagingEscrow(
    uid: string,
    masterKey: Bytes,
    passphrase: string,
  ): Promise<void> {
    const messaging = this.messaging;
    if (messaging === null || !this.escrowWritesAccepted) return;
    let mine: string;
    let published: string | null;
    try {
      mine = messaging.publicKeyFor(masterKey);
      published = await messaging.publishedKey(uid);
    } catch {
      // A lookup that failed proves nothing about whose key is stored, and acting on "unknown"
      // is exactly how the original bug destroyed data. Say nothing and write nothing.
      return;
    }
    // THE RULE. A foreign vault never writes here.
    if (published !== null && published !== mine) return;

    const salt = this.random.bytes(SALT_LENGTH);
    const kek = await this.deriveKek(passphrase, salt, this.kdfParams);
    try {
      const wrappedMasterKey = await this.wrapping.wrap(masterKey, kek, AAD.messagingEscrow);
      await this.backend.putDocument(
        messagingEscrowPath(uid),
        escrowToJson({
          version: 1,
          salt,
          kdf: this.kdfParams,
          wrappedMasterKey,
          publicKey: mine,
          createdAt: this.clock.now(),
        }),
      );
    } catch (cause) {
      if (cause instanceof CloudError && cause.code === 'permission-denied') {
        // The rules for this path are not deployed yet. Stop asking for the rest of the session.
        this.escrowWritesAccepted = false;
        return;
      }
      throw cause;
    } finally {
      zeroBytes(kek);
    }
  }

  /**
   * The master key that opens this account's MESSAGING, which is not always the one that opens
   * its photos.
   *
   * Tries the escrow first and falls back to the backup envelope, because the envelope is where
   * the messaging key lives for every account that enabled backup before the escrow existed and
   * has not been rebound since -- which is most of them, and they must keep working.
   *
   * A stale escrow is skipped rather than used: if its `publicKey` is not what the account
   * publishes, unwrapping it would cost an Argon2id run to produce a key the caller would then
   * reject. The envelope is tried instead, which for a never-rebound account is the right answer.
   *
   * The returned key belongs to the caller, which MUST zero it.
   */
  async recoverMessagingKey(passphrase: string): Promise<Bytes> {
    const uid = this.requireUser().uid;
    const escrow = await this.readMessagingEscrow(uid);
    if (escrow === null) traceRecovery('envelope-fallback');
    if (escrow !== null) {
      traceRecovery('escrow-read', keyFingerprint(escrow.publicKey));
      const kek = await this.deriveKek(passphrase, escrow.salt, escrow.kdf);
      try {
        return await this.wrapping.unwrap(escrow.wrappedMasterKey, kek, AAD.messagingEscrow);
      } catch (cause) {
        if (cause instanceof WrongKeyError) throw new WrongPassphraseError();
        throw cause;
      } finally {
        zeroBytes(kek);
      }
    }
    return this.recoverMasterKey(passphrase);
  }

  async messagingKeyIsMine(masterKey: Bytes): Promise<boolean> {
    const messaging = this.messaging;
    if (messaging === null) return true;
    let escrow;
    try {
      const document = await this.backend.getDocument(messagingEscrowPath(this.requireUser().uid));
      if (document === null) return true;
      escrow = escrowFromJson(document);
    } catch {
      return true;
    }
    try {
      return escrow.publicKey === messaging.publicKeyFor(masterKey);
    } catch {
      return true;
    }
  }

  /**
   * The escrow worth using, or null.
   *
   * Null covers three different situations on purpose -- no document, a damaged one, and one that
   * does not match what the account publishes -- because the caller does the same thing in all
   * three: fall back to the envelope and let the public-key check have the final word.
   */
  private async readMessagingEscrow(uid: string): Promise<MessagingEscrow | null> {
    let escrow: MessagingEscrow;
    try {
      const document = await this.backend.getDocument(messagingEscrowPath(uid));
      if (document === null) {
        traceRecovery('escrow-absent');
        return null;
      }
      escrow = escrowFromJson(document);
    } catch (cause) {
      // A refused read and a malformed document are different problems with the same answer --
      // fall back to the envelope -- and telling them apart in a log is the whole point of this.
      traceRecovery('escrow-absent', cause instanceof CloudError ? cause.code : 'malformed');
      return null;
    }
    const messaging = this.messaging;
    if (messaging === null) return escrow;
    let published: string | null;
    try {
      published = await messaging.publishedKey(uid);
    } catch {
      // Offline. The escrow is the best thing available and the caller re-checks it anyway.
      return escrow;
    }
    if (published !== null && published !== escrow.publicKey) {
      traceRecovery('escrow-skipped-stale', keyFingerprint(escrow.publicKey));
      return null;
    }
    return escrow;
  }

  /**
   * Uploads whatever the cloud does not have yet, and takes nothing away.
   *
   * This used to mirror the vault: a photo deleted on the device was deleted from the cloud on the
   * next run, so the backup could never resurrect something the user had removed on purpose. That
   * is the better property for privacy and the wrong one for a backup. The phone is the copy that
   * gets lost, stolen, wiped or mis-tapped, and a backup that faithfully reproduces an accidental
   * deletion has failed at the only job it has. So the cloud copy now only ever grows, and the one
   * way to remove anything from it is {@link disable}, which is explicit, confirmed and total.
   *
   * The cost is real and belongs in the open: a photo deleted on the device stays in the cloud
   * until backup is turned off. `docs/security.md` says so where the old promise used to be.
   *
   * **The index is what makes "kept" mean anything.** Restoring is driven entirely by `index.enc`,
   * so a blob whose entry had been dropped from the index would be bytes nothing could ever read
   * again -- worse than deleting it, because it looks like safety. The uploaded index is therefore
   * the union of what is on this device and what the cloud already had. That is why this needs the
   * keys: merging means decrypting the cloud's copy first.
   */
  async backupNow(
    repository: VaultRepository,
    keys: VaultKeys,
    options?: BackupSelection,
  ): Promise<BackupReport> {
    const user = this.requireUser();
    if (!(await this.hasEnvelope())) throw new BackupNotEnabledError();
    const uid = user.uid;
    // Asked before the cloud index is even read. The index check below proves whether this vault
    // can OPEN this account's backup; this one answers the different question of whether these
    // photos belong in this account, which no key comparison can settle.
    await this.assertMayWrite(uid, keys, options);
    // Cheaper and more specific than the index decrypt below, and it works even when the index is
    // missing: one document read, and the refusal names both vaults.
    await this.assertVaultOwnsAccount(uid, keys);

    // Read the cloud's index FIRST, before a single byte is written.
    //
    // This used to run after `uploadPhotos`, and the ordering was the whole bug: a vault that does
    // not own this account would upload every photo it had, under its own key, and only then reach
    // the decrypt that fails and throws `ForeignBackupError`. The refusal was real but it came too
    // late -- the blobs were already sitting in someone else's account, unreadable by the vault
    // that can open the index and invisible to the index that lists what may be restored. Reading
    // first makes the refusal mean what it says: nothing was written.
    //
    // Entries the cloud has and this device does not. Nothing is ever deleted from the cloud here,
    // so these are the ones that would be stranded if the local index simply replaced the remote.
    const localIds = new Set(repository.photos.map((p) => p.id));
    const cloudBefore = await this.readCloudIndex(uid, keys);
    const carried = cloudBefore.filter((entry) => !localIds.has(entry.id));

    // Which of this device's photos this run is for. Omitting `ids` keeps the original
    // meaning -- the whole vault -- which is what a first backup and every existing spec
    // expect. Passing them is what makes the Cloud Gallery opt-in: the local gallery is
    // unlimited and private, and nothing joins the backup without being named here.
    const wanted = options?.ids === undefined ? null : new Set(options.ids);
    const chosen =
      wanted === null ? repository.photos : repository.photos.filter((p) => wanted.has(p.id));

    // What is ALREADY uploaded, which is the question that decides whether a byte moves.
    //
    // With a selection in hand this has to come from Storage, not from the manifest. The
    // manifest lists exactly what the index lists -- they are written together from one list --
    // so a selection drawn from the index is always a subset of it, every candidate would be
    // skipped, and an item whose bytes went missing could never be put back. Asking Storage
    // costs one listing and answers the question actually being asked: which of these is
    // really there?
    //
    // Without a selection the whole vault is the candidate set and the manifest is both cheaper
    // and sufficient, so that path is left exactly as it was -- down to not paying for a listing
    // it has no use for, and not reading a manifest the other path never looks at.
    let skip: Set<string>;
    let unrepairable = 0;
    if (wanted === null) {
      const manifest = await this.backend.getDocument(BACKUP_PATHS.manifest(uid));
      skip = new Set<string>(readPhotoIds(manifest));
    } else {
      skip = await this.idsFullyUploaded(uid);
      // Named for repair, bytes gone from Storage, and no local copy to put back. Nothing here
      // can fix one of these, and the report has to say so: a run that uploads nothing because
      // everything is healthy and a run that uploads nothing because the bytes are lost on both
      // sides produce the same number and mean opposite things.
      for (const id of wanted) if (!skip.has(id) && !localIds.has(id)) unrepairable += 1;
    }
    const uploaded = await this.uploadPhotos(repository, chosen, uid, skip, options?.onProgress);

    // The index must name exactly what the cloud holds: everything it already had, plus what
    // this run added. Listing the rest of the vault would claim photos are backed up that were
    // never uploaded -- and the index is what a restore trusts.
    const keptById = new Map(cloudBefore.map((entry) => [entry.id, entry]));
    for (const photo of chosen) keptById.set(photo.id, photo);
    const merged = sortedNewestFirst([...keptById.values()]);

    await this.writeIndexAndManifest(uid, keys, merged);
    await this.owner.bind(uid, this.clock.now());
    return { uploaded, cloudOnly: carried.length, total: merged.length, unrepairable };
  }

  /**
   * What this account's backup holds.
   *
   * The index IS the record. There is no local list of "what is backed up" to keep in step,
   * which is the whole reason a Cloud Gallery can be account-scoped without any new state: ask
   * a different account and you read a different account's index, under a different key.
   *
   * A `foreign` answer is not a failure. The index is sealed with the master key of whichever
   * vault wrote it, so a backup made on another device cannot be listed from here at all. Say
   * that, rather than returning an empty list that reads as "nothing is backed up".
   */
  async cloudContents(keys: VaultKeys): Promise<CloudContents> {
    const uid = this.requireUser().uid;
    if (!(await this.hasEnvelope())) return { kind: 'none' };
    let entries: readonly PhotoEntry[];
    try {
      entries = await this.readCloudIndex(uid, keys);
    } catch (cause) {
      if (cause instanceof ForeignBackupError) return { kind: 'foreign' };
      throw cause;
    }
    if (entries.length === 0) return { kind: 'none' };
    return { kind: 'listed', entries, missing: await this.missingFromStorage(uid, entries) };
  }

  /**
   * Which of `entries` Storage no longer holds complete, or null when it could not be asked.
   *
   * The index says what the user chose; this says which of those choices still have bytes behind
   * them. BOTH objects have to be there -- a photo with no thumbnail cannot be drawn, a thumbnail
   * with no photo cannot be restored -- so either one missing makes the entry incomplete.
   *
   * A failed listing returns null rather than an empty array, and the difference matters. Offline
   * is the ordinary reason to fail, and "we could not check" has to stay distinguishable from
   * "everything is there": reporting the latter would promise a photo is safe at the exact moment
   * the app has no idea whether it is.
   */
  private async missingFromStorage(
    uid: string,
    entries: readonly PhotoEntry[],
  ): Promise<readonly string[] | null> {
    let present: Set<string>;
    try {
      present = await this.idsFullyUploaded(uid);
    } catch {
      return null;
    }
    return entries.filter((entry) => !present.has(entry.id)).map((entry) => entry.id);
  }

  /**
   * One thumbnail out of this account's Storage, decrypted with this vault's thumb key.
   *
   * `getBlob`, not `getBlobToFile`: the ciphertext arrives as bytes and the plaintext never
   * becomes a file. A thumbnail is tens of kilobytes, so there is no reason to involve the disk
   * and every reason not to.
   *
   * The path is built from the signed-in uid, so it is account-scoped by construction -- there
   * is no id a caller could pass that reaches another account's object.
   */
  async readCloudThumbnail(keys: VaultKeys, id: string): Promise<Bytes> {
    const uid = this.requireUser().uid;
    const blob = await this.backend.getBlob(BACKUP_PATHS.thumb(uid, id));
    return this.cipher.decrypt(blob, keys.keyFor(VaultKeyId.thumb), VaultKeyId.thumb);
  }

  /**
   * Takes ids out of the cloud. Nothing local is touched, read, or even opened.
   *
   * The index shrinks BEFORE the blobs go. Crashing between the two leaves objects nothing
   * points at -- invisible, and swept by `disable` -- whereas the other order would leave the
   * index naming photos that are already gone, and a restore trusts the index.
   *
   * A blob that has already vanished is not an error: the end state is what was asked for.
   */
  async removeFromCloud(keys: VaultKeys, ids: readonly string[]): Promise<number> {
    const uid = this.requireUser().uid;
    if (ids.length === 0) return 0;
    const wanted = new Set(ids);
    // Throws ForeignBackupError when this vault did not write the index, which is right: an
    // account whose backup belongs to another vault must not have entries removed from it.
    const before = await this.readCloudIndex(uid, keys);
    const kept = before.filter((entry) => !wanted.has(entry.id));
    const removed = before.length - kept.length;
    if (removed === 0) return 0;

    await this.writeIndexAndManifest(uid, keys, kept);
    for (const entry of before) {
      if (!wanted.has(entry.id)) continue;
      for (const path of [BACKUP_PATHS.photo(uid, entry.id), BACKUP_PATHS.thumb(uid, entry.id)]) {
        try {
          await this.backend.deleteBlob(path);
        } catch {
          // Already gone, or gone by another device. Either way the index no longer names it.
        }
      }
    }
    return removed;
  }

  /**
   * Re-points the whole cloud backup at the key this vault is running on, and re-uploads under it.
   *
   * Only {@link restoreForeignInto} needs this, and only straight afterwards, when every photo the
   * cloud held has just been imported here. At that moment the local vault is a superset of the
   * backup, which is what makes a wholesale replacement safe: every path is overwritten with
   * ciphertext under the new key, so nothing is left half-readable and nothing is orphaned.
   *
   * The passphrase does not change. It is the same envelope with the same Argon2id parameters,
   * wrapping a different master key, so the user's written-down passphrase keeps working.
   *
   * There is a crash window, and it is worth being honest about: between the first re-upload and
   * the new envelope the account is inconsistent, and a restore attempted from another device in
   * that gap would fail. Nothing is lost when it happens -- this device holds every photo -- and
   * turning backup off and on rebuilds the account cleanly. Closing it properly needs a two-phase
   * marker in the manifest, which is not worth the complexity for a path this rare.
   */
  async rebindBackup(
    repository: VaultRepository,
    keys: VaultKeys,
    passphrase: string,
    ids: readonly string[],
    onProgress?: BackupProgress,
  ): Promise<void> {
    const uid = this.requireUser().uid;
    // ONLY this account's own photos. `ids` comes from the cloud index that was just restored, so
    // the account is rewritten with exactly what it already had, under the new key. It used to be
    // `repository.photos` -- the whole device vault -- which quietly uploaded every other
    // account's photos into this one and then handed this account's passphrase the key to them.
    const wanted = new Set(ids);
    const entries = repository.photos.filter((photo) => wanted.has(photo.id));
    // Nothing is skipped within that set: every blob is rewritten, because the old ones are under
    // the old key.
    await this.uploadPhotos(repository, entries, uid, new Set(), onProgress);
    await this.writeIndexAndManifest(uid, keys, sortedNewestFirst([...entries]));
    // Last, so the envelope only ever claims a key the rest of the account is already using. The
    // user reached here through an explicit confirmation, so the cross-account gate is satisfied.
    await this.enable(keys, passphrase, { confirmedCrossAccount: true });
  }

  /**
   * Uploads every entry whose id is not in `skip`, adding the ones it uploads to it.
   *
   * The entries are passed in rather than read from the repository, so each caller has to say
   * which photos it means. That is the difference between "back up this device" and "rewrite this
   * account", and reading `repository.photos` here made them the same thing.
   */
  private async uploadPhotos(
    repository: VaultRepository,
    entries: readonly PhotoEntry[],
    uid: string,
    skip: Set<string>,
    onProgress?: BackupProgress,
  ): Promise<number> {
    // Counted BEFORE the loop, because `skip` grows inside it. The total is how many of these
    // entries still need uploading, not how many were offered -- a bar that counted the skipped
    // ones would sit at a third full and never move.
    const total = entries.reduce((count, entry) => (skip.has(entry.id) ? count : count + 1), 0);
    onProgress?.(0, total);
    let uploaded = 0;
    for (const entry of entries) {
      const id = entry.id;
      if (skip.has(id)) continue;
      if (isVideo(entry)) {
        // Uploaded from the blob file itself; the bytes are identical to `readEncryptedPhoto`,
        // they simply never become a buffer.
        await this.backend.putBlobFromFile(
          BACKUP_PATHS.photo(uid, id),
          repository.encryptedPayloadUri(id),
        );
      } else {
        await this.backend.putBlob(
          BACKUP_PATHS.photo(uid, id),
          await repository.readEncryptedPhoto(id),
        );
      }
      await this.backend.putBlob(
        BACKUP_PATHS.thumb(uid, id),
        await repository.readEncryptedThumbnail(id),
      );
      skip.add(id);
      uploaded += 1;
      onProgress?.(uploaded, total);
    }
    return uploaded;
  }

  /**
   * Writes the index blob and the manifest document that describe `photos`.
   *
   * The manifest mirrors the index rather than accumulating on its own, so an id that somehow
   * reached one and not the other is corrected on the next run instead of lingering forever.
   *
   * It also carries a second copy of the index ciphertext, because `index.enc` was a single point
   * of failure: the blobs are findable only through the entries it holds, so losing one small
   * object left every photo in the account unrestorable while looking perfectly healthy. The copy
   * is the identical ciphertext, under the same key in a store with the same owner-only rule, so
   * it widens nothing -- it just means the entries have to be lost twice.
   */
  private async writeIndexAndManifest(
    uid: string,
    keys: VaultKeys,
    photos: readonly PhotoEntry[],
  ): Promise<void> {
    const json = utf8Encode(encodeIndex({ version: 1, photos }));
    let blob: Bytes;
    try {
      blob = await this.cipher.encrypt(json, keys.keyFor(VaultKeyId.manifest), VaultKeyId.manifest);
      await this.backend.putBlob(BACKUP_PATHS.index(uid), blob);
    } finally {
      zeroBytes(json);
    }

    const ids = photos.map((entry) => entry.id);
    // Firestore rejects a document over 1 MiB outright, and a backup must never start failing
    // because its safety net outgrew the document. Past the budget the copy is dropped and the
    // backup proceeds without it -- degraded to exactly today's behaviour, never broken.
    const encoded = base64Encode(blob);
    const manifest = {
      photoIds: ids,
      photoCount: ids.length,
      updatedAt: new Date(this.clock.now()).toISOString(),
    };
    // On the manifest the id names whoever wrote the CURRENT data set, which is a different fact
    // from the envelope's and the one that catches the two drifting apart: an envelope from one
    // vault beside an index from another is exactly the state that makes a backup unrestorable,
    // and it used to be invisible until someone tried to restore it.
    const vaultId = deriveVaultId(keys.masterKey);
    if (encoded.length > MANIFEST_INDEX_BUDGET) {
      await this.putWithVaultId(BACKUP_PATHS.manifest(uid), manifest, vaultId);
      return;
    }
    try {
      await this.putWithVaultId(BACKUP_PATHS.manifest(uid), { ...manifest, index: encoded }, vaultId);
    } catch (cause) {
      // Deployed rules validate the manifest with `hasOnly`, so a ruleset that predates this field
      // rejects the entire document -- and a backup that fails because its safety net is too new
      // is worse than one that goes without it. Devices update before rules do, and sometimes
      // instead of them, so the write is retried in the old shape.
      //
      // This cannot mask a real authorisation problem: that one denies the retry too, and it
      // surfaces exactly as it did before.
      if (!(cause instanceof CloudError && cause.code === 'permission-denied')) throw cause;
      // Through the helper, not around it: reaching here means a document the helper had ALREADY
      // stripped of `vaultId` was still refused, so the field was never what this ruleset objected
      // to -- `index` was. Dropping the id as well would lose it for no reason.
      await this.putWithVaultId(BACKUP_PATHS.manifest(uid), manifest, vaultId);
    }
  }

  /**
   * The encrypted index, from Storage if it is there and from the manifest's copy if it is not.
   *
   * Returns null only when neither holds one, which is a genuinely empty account. A copy that is
   * present but unreadable throws instead of reporting nothing: "there is nothing to restore" is
   * the one answer that must never be a guess, because the user acts on it by giving up.
   */
  private async fetchIndexBlob(uid: string): Promise<Bytes | null> {
    try {
      return await this.backend.getBlob(BACKUP_PATHS.index(uid));
    } catch (cause) {
      if (!(cause instanceof CloudError && cause.code === 'object-not-found')) throw cause;
    }
    const manifest = await this.backend.getDocument(BACKUP_PATHS.manifest(uid));
    if (manifest === null) return null;
    const encoded = manifest.index;
    if (encoded === undefined) return null;
    if (typeof encoded !== 'string') throw new RecordFormatError('manifest index is not a string');
    try {
      return base64Decode(encoded);
    } catch (cause) {
      if (cause instanceof Base64Error) throw new RecordFormatError('manifest index is not base64');
      throw cause;
    }
  }

  /**
   * The entries already in the cloud, or none when this is the first upload.
   *
   * A decryption failure is NOT swallowed. It means these keys do not belong to this account's
   * backup, and the only thing worse than refusing there would be carrying on: the local index
   * would replace the other vault's, and its blobs would survive with nothing pointing at them.
   *
   * It is reported as {@link ForeignBackupError} rather than a raw cipher error, because it is not
   * a fault. Every vault that was erased and set up again lands here, and the user needs to be
   * told which button fixes it -- "Restore from backup", which brings those photos in and moves the
   * account onto this vault's key. Left untyped it reached the screen as "Something went wrong",
   * which reads like the app is broken when nothing is wrong at all.
   */
  private async readCloudIndex(uid: string, keys: VaultKeys): Promise<readonly PhotoEntry[]> {
    const blob = await this.fetchIndexBlob(uid);
    if (blob === null) return [];
    let json: Bytes;
    try {
      json = await this.cipher.decrypt(blob, keys.keyFor(VaultKeyId.manifest), VaultKeyId.manifest);
    } catch (cause) {
      if (cause instanceof WrongKeyError) throw new ForeignBackupError();
      throw cause;
    }
    try {
      return decodeIndex(utf8Decode(json)).photos;
    } finally {
      zeroBytes(json);
    }
  }

  async recoverMasterKey(passphrase: string): Promise<Bytes> {
    const user = this.requireUser();
    const document = await this.backend.getDocument(BACKUP_PATHS.envelope(user.uid));
    if (document === null) throw new BackupNotEnabledError();

    const envelope = envelopeFromJson(document);
    const kek = await this.deriveKek(passphrase, envelope.salt, envelope.kdf);
    try {
      return await this.wrapping.unwrap(envelope.wrappedMasterKey, kek, AAD.backupEnvelope);
    } catch (cause) {
      if (cause instanceof WrongKeyError) throw new WrongPassphraseError();
      throw cause;
    } finally {
      zeroBytes(kek);
    }
  }

  /**
   * Restores a backup made under a DIFFERENT master key into the vault that is already open.
   *
   * This is the case where the envelope's key is not the vault's: a backup that predates an erase
   * and re-create, which is the ordinary situation after a wipe or a forgotten PIN. The photos are
   * perfectly good, they are simply encrypted with a key this vault does not use, so each one is
   * decrypted with the backup's key and re-encrypted with the vault's on the way in. The vault's
   * own key never changes and its existing photos are never touched, which is the whole reason to
   * do it in this direction rather than adopting the backup's key and re-encrypting everything
   * already here.
   *
   * Ids and metadata are carried over, so a photo restored this way is the same photo -- and a
   * second run skips it rather than duplicating it.
   *
   * `importEncrypted` still authenticates everything against the vault's keys before storing it,
   * so a tampered blob is rejected here exactly as it is on the matched-key path. The difference
   * is only which key the ciphertext arrived under.
   */
  async restoreForeignInto(
    repository: VaultRepository,
    keys: VaultKeys,
    backupMaster: Bytes,
    onProgress?: BackupProgress,
  ): Promise<RestoreReport> {
    const uid = this.requireUser().uid;
    const source = deriveVaultKeys(backupMaster);
    try {
      const entries = await this.readCloudIndex(uid, source);
      const existing = new Set(repository.photos.map((p) => p.id));
      // Everything this account's backup holds, whether it was imported now or was already here.
      // A rebind may re-upload exactly these and nothing else.
      const cloudIds = entries.map((entry) => entry.id);
      let restored = 0;
      let skipped = 0;
      /**
       * Ids the index listed whose bytes Storage does not have.
       *
       * Collected rather than counted, because they have to come out of `cloudIds`: a rebind
       * can only re-upload what is on this device, and these are precisely what is not.
       */
      const lost: string[] = [];

      const total = entries.length;
      onProgress?.(0, total);

      // Oldest first, matching `restoreInto`: an interrupted run leaves the newest still to come
      // rather than a random subset.
      for (const entry of [...entries].reverse()) {
        // `finally` rather than a call before each `continue`: both early exits below are items
        // that are done with, and a bar that stopped counting them would stall on a backup whose
        // photos are mostly already on this device.
        try {
          if (existing.has(entry.id)) {
            // Already in this vault: nothing to download, and nothing lost.
            skipped += 1;
            continue;
          }
          try {
            const thumbnailBlob = await this.recrypt(
              await this.backend.getBlob(BACKUP_PATHS.thumb(uid, entry.id)),
              source,
              keys,
              VaultKeyId.thumb,
            );
            if (isVideo(entry)) {
              await this.recryptVideoInto(repository, uid, entry, thumbnailBlob, source, keys);
            } else {
              const photoBlob = await this.recrypt(
                await this.backend.getBlob(BACKUP_PATHS.photo(uid, entry.id)),
                source,
                keys,
                payloadKeyId(entry),
              );
              await repository.importEncrypted({ entry, photoBlob, thumbnailBlob });
            }
            restored += 1;
          } catch (cause) {
            if (cause instanceof CloudError && cause.code === 'object-not-found') {
              // The index says this photo was uploaded and Storage disagrees. Not a skip: there
              // is no copy of it anywhere now, and only the report can say so.
              lost.push(entry.id);
              continue;
            }
            throw cause;
          }
        } finally {
          onProgress?.(restored + skipped + lost.length, total);
        }
      }
      return {
        restored,
        skipped,
        missing: lost.length,
        cloudIds: cloudIds.filter((id) => !lost.includes(id)),
      };
    } finally {
      source.dispose();
    }
  }

  /** Decrypts under `from` and re-encrypts under `to`, holding the plaintext no longer than that. */
  private async recrypt(
    blob: Bytes,
    from: VaultKeys,
    to: VaultKeys,
    id: VaultKeyId,
  ): Promise<Bytes> {
    const plain = await this.cipher.decrypt(blob, from.keyFor(id), id);
    try {
      return await this.cipher.encrypt(plain, to.keyFor(id), id);
    } finally {
      zeroBytes(plain);
    }
  }

  /**
   * The video form: chunked ciphertext is far too large for a buffer, so it goes through two
   * scratch files instead -- down, decrypted, re-encrypted, then handed to the repository.
   *
   * The middle file is PLAINTEXT video sitting in app-private cache, which is the one genuinely
   * uncomfortable moment in this path. It is securely deleted in a `finally` whatever happens,
   * including on a failed import, and it is the same exposure `readVideoToFile` already accepts
   * for playback.
   */
  private async recryptVideoInto(
    repository: VaultRepository,
    uid: string,
    entry: PhotoEntry,
    thumbnailBlob: Bytes,
    from: VaultKeys,
    to: VaultKeys,
  ): Promise<void> {
    const directory = joinUri(this.fs.cacheDirectory, RESTORE_DIRECTORY_NAME);
    await this.fs.makeDirectory(directory);
    const stem = this.random.hexId();
    const downloaded = joinUri(directory, `${stem}.src`);
    const plain = joinUri(directory, `${stem}.raw`);
    const reencrypted = joinUri(directory, `${stem}.enc`);
    try {
      await this.backend.getBlobToFile(BACKUP_PATHS.photo(uid, entry.id), downloaded);
      await this.streamCipher.decryptFile(
        downloaded,
        plain,
        from.keyFor(VaultKeyId.video),
        VaultKeyId.video,
      );
      await this.streamCipher.encryptFile(
        plain,
        reencrypted,
        to.keyFor(VaultKeyId.video),
        VaultKeyId.video,
      );
      await repository.importEncryptedFile({ entry, payloadUri: reencrypted, thumbnailBlob });
    } finally {
      await this.secureDelete.file(downloaded);
      await this.secureDelete.file(plain);
      // A successful import has already moved this one; anything left is a failed attempt.
      await this.secureDelete.file(reencrypted);
    }
  }

  /**
   * Downloads every backed-up photo into an already-open repository whose keys came from the
   * recovered master key. Blobs the repository cannot authenticate are rejected by
   * `importEncrypted`, so a tampered cloud object cannot be planted in the vault.
   */
  async restoreInto(
    repository: VaultRepository,
    keys: VaultKeys,
    onProgress?: BackupProgress,
  ): Promise<RestoreReport> {
    const user = this.requireUser();
    const uid = user.uid;

    const indexBlob = await this.fetchIndexBlob(uid);
    if (indexBlob === null) return { restored: 0, skipped: 0, missing: 0, cloudIds: [] };

    const json = await this.cipher.decrypt(
      indexBlob,
      keys.keyFor(VaultKeyId.manifest),
      VaultKeyId.manifest,
    );
    let index;
    try {
      index = decodeIndex(utf8Decode(json));
    } finally {
      zeroBytes(json);
    }

    const existing = new Set(repository.photos.map((p) => p.id));
    let restored = 0;
    let skipped = 0;
    /** As in {@link restoreForeignInto}: listed, but not in Storage, so not on this device. */
    const lost: string[] = [];

    const total = index.photos.length;
    onProgress?.(0, total);

    // Oldest first, so an interrupted restore leaves the newest photos still to come rather than
    // a random subset.
    for (const entry of [...index.photos].reverse()) {
      // `finally` rather than a call before each `continue`: both early exits below are items
      // that are done with, and a bar that stopped counting them would stall on a backup whose
      // photos are mostly already here.
      try {
        if (existing.has(entry.id)) {
          // Already in this vault: nothing to download, and nothing lost.
          skipped += 1;
          continue;
        }
        try {
          const thumbnailBlob = await this.backend.getBlob(BACKUP_PATHS.thumb(uid, entry.id));
          if (isVideo(entry)) {
            await this.restoreVideo(repository, uid, entry, thumbnailBlob);
          } else {
            const photoBlob = await this.backend.getBlob(BACKUP_PATHS.photo(uid, entry.id));
            await repository.importEncrypted({ entry, photoBlob, thumbnailBlob });
          }
          restored += 1;
        } catch (cause) {
          if (cause instanceof CloudError && cause.code === 'object-not-found') {
            // Counted apart from `skipped`. This is the fresh-device path, where the vault
            // starts empty and every skip would otherwise be a loss wearing a reassuring name.
            lost.push(entry.id);
            continue;
          }
          throw cause;
        }
      } finally {
        onProgress?.(restored + skipped + lost.length, total);
      }
    }
    return {
      restored,
      skipped,
      missing: lost.length,
      cloudIds: index.photos.map((entry) => entry.id).filter((id) => !lost.includes(id)),
    };
  }

  /**
   * Lands the video's ciphertext in app-private storage, hands it to the repository to
   * authenticate and move into the vault, and securely deletes whatever is left either way. The
   * scratch file is ciphertext throughout: it is never decrypted here.
   */
  private async restoreVideo(
    repository: VaultRepository,
    uid: string,
    entry: PhotoEntry,
    thumbnailBlob: Bytes,
  ): Promise<void> {
    const directory = joinUri(this.fs.cacheDirectory, RESTORE_DIRECTORY_NAME);
    await this.fs.makeDirectory(directory);
    const scratch = joinUri(directory, `${this.random.hexId()}.enc`);
    try {
      await this.backend.getBlobToFile(BACKUP_PATHS.photo(uid, entry.id), scratch);
      await repository.importEncryptedFile({ entry, payloadUri: scratch, thumbnailBlob });
    } finally {
      // A successful import has already moved the file; anything still here is a failed attempt.
      await this.secureDelete.file(scratch);
    }
  }

  async disable(): Promise<void> {
    await this.deleteAccountData(this.requireUser().uid);
    // This account holds nothing of this vault's any more, so the vault is unowned again and a
    // different account may back it up without being asked about photos that no longer exist
    // anywhere but here. Last, so a failed deletion leaves the binding -- and its protection --
    // standing.
    await this.owner.clear();
  }

  /**
   * Deletes everything the account owns and then reads back to prove it.
   *
   * The verification is the point. `disable` deletes and trusts itself; this one cannot, because
   * its caller deletes the credential next and that is irreversible. A blob left behind is not
   * merely untidy: the rules grant access by uid, so once the uid has no account the object is
   * unreadable and undeletable forever, and it keeps being billed. Anything still standing is
   * therefore reported rather than ignored, with the account left intact so it can be retried --
   * that account is the only thing in the world that can still remove those bytes.
   */
  async purgeAccount(): Promise<void> {
    const uid = this.requireUser().uid;
    await this.deleteAccountData(uid);

    const blobs = await this.listAccountBlobs(uid);
    const documents: string[] = [];
    for (const path of [BACKUP_PATHS.envelope(uid), BACKUP_PATHS.manifest(uid)]) {
      if ((await this.backend.getDocument(path)) !== null) documents.push(path);
    }
    const remaining = blobs.length + documents.length;
    if (remaining > 0) throw new AccountDataRemainsError(remaining);
  }

  /**
   * The ids whose backup is actually complete in Storage right now.
   *
   * Complete means BOTH objects: an item with a photo but no thumbnail is half-uploaded, and
   * treating it as done would leave the Cloud Gallery listing something it cannot draw. An
   * interrupted upload is the ordinary way that happens.
   *
   * This is the only source of truth for whether bytes are present. The index says what the
   * user CHOSE; Storage says what survived.
   */
  private async idsFullyUploaded(uid: string): Promise<Set<string>> {
    const strip = (name: string): string => (name.endsWith('.enc') ? name.slice(0, -4) : name);
    const photos = new Set(
      (await this.backend.listBlobs(BACKUP_PATHS.photosPrefix(uid))).map(strip),
    );
    const thumbs = new Set(
      (await this.backend.listBlobs(BACKUP_PATHS.thumbsPrefix(uid))).map(strip),
    );
    const complete = new Set<string>();
    for (const id of photos) if (thumbs.has(id)) complete.add(id);
    return complete;
  }

  /**
   * Every object filed under the account, found by sweeping its prefix rather than by rebuilding a
   * list of names from the index. A blob whose index entry was lost is exactly the blob a
   * name-driven delete would walk past, and it is also the one nobody will ever come back for.
   * The account root is swept too, so a stray object beside `index.enc` is not missed.
   */
  private async listAccountBlobs(uid: string): Promise<string[]> {
    const found: string[] = [];
    for (const prefix of [
      BACKUP_PATHS.account(uid),
      BACKUP_PATHS.photosPrefix(uid),
      BACKUP_PATHS.thumbsPrefix(uid),
    ]) {
      const folder = prefix.endsWith('/') ? prefix : `${prefix}/`;
      for (const name of await this.backend.listBlobs(prefix)) {
        found.push(`${folder}${name}`);
      }
    }
    return found;
  }

  /**
   * Removes everything the account owns, ENVELOPE FIRST.
   *
   * The order is the whole point, and it used to be the other way round. This is not atomic: it is
   * a sequence of network calls and it has stopped part-way more than once, and
   * `vaultWipe.deleteCloudBackup` wraps it in `quietly()`, so a partial delete is swallowed
   * without a word. What matters is therefore not whether it can fail but what it leaves behind
   * when it does.
   *
   * Deleting the envelope last left the worst possible remnant: an envelope wrapping the OLD
   * vault's master key, standing over an account whose blobs and index had gone. `hasEnvelope()`
   * still said yes, so the next `backupNow` sailed past `BackupNotEnabledError`, found no index to
   * check itself against, and uploaded under the NEW vault's key. The result was a backup nobody
   * could ever restore -- the passphrase unwraps the envelope to a master key that decrypts none
   * of the blobs beneath it -- and nothing said so until someone tried to restore it.
   *
   * Deleting it first inverts that. Every failure now leaves either an untouched account (nothing
   * had been deleted yet) or one whose envelope is gone, which reads as "backup is off": the next
   * backup refuses with `BackupNotEnabledError` until the user enables it again, and enabling
   * writes a fresh envelope around the key that is actually in use. Orphaned blobs may survive and
   * that is the accepted cost -- they are unreadable bytes that cost storage, which `purgeAccount`
   * sweeps and reports, and which the next enable overwrites. Unreadable bytes are recoverable
   * from; an unrestorable backup is not.
   */
  private async deleteAccountData(uid: string): Promise<void> {
    // First, so that an interrupted delete can never leave a key-mismatched envelope standing.
    await this.backend.deleteDocument(BACKUP_PATHS.envelope(uid));
    await this.backend.deleteDocument(BACKUP_PATHS.manifest(uid));
    // The messaging key goes with the rest of the account's data. Turning backup off is the one
    // explicit, confirmed, total erasure, and leaving a wrapped key behind would make it a lie.
    await this.backend.deleteDocument(messagingEscrowPath(uid));
    // Named explicitly as well as swept: deleting it is the one thing that must not depend on a
    // listing succeeding, because the index is what makes every other blob findable.
    await this.backend.deleteBlob(BACKUP_PATHS.index(uid));
    for (const path of await this.listAccountBlobs(uid)) {
      await this.backend.deleteBlob(path);
    }
  }

  private requireUser(): CloudUser {
    const user = this.backend.currentUser;
    if (user === null) throw new CloudError('unauthenticated');
    return user;
  }

  private async deriveKek(
    passphrase: string,
    salt: Bytes,
    params: KdfParams,
  ): Promise<Bytes> {
    const secret = utf8Encode(passphrase);
    try {
      return await this.kdf.deriveKey(secret, salt, params);
    } finally {
      zeroBytes(secret);
    }
  }
}

function readPhotoIds(manifest: Record<string, unknown> | null): string[] {
  if (manifest === null) return [];
  const ids = manifest.photoIds;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === 'string');
}
