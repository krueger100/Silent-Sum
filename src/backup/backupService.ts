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
import { assertValidPassphrase } from '@/backup/passphrasePolicy';
import {
  AccountDataRemainsError,
  BACKUP_PATHS,
  BackupNotEnabledError,
  ForeignBackupError,
  WrongPassphraseError,
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
import { deriveVaultKeys } from '@/crypto/vaultKeys';
import { CloudError, type CloudBackend, type CloudUser } from '@/firebase/types';
import { joinUri, type FileSystem } from '@/storage/fileSystem';
import type { SecureDelete } from '@/storage/secureDelete';
import { isVideo, payloadKeyId } from '@/vault/mediaKind';
import { decodeIndex, encodeIndex, sortedNewestFirst } from '@/vault/vaultIndex';
import type { PhotoEntry, VaultRepository } from '@/vault/types';
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
  kdfParams?: KdfParams;
}

export class BackupService implements BackupServiceContract {
  private readonly backend: CloudBackend;
  private readonly kdf: KeyDerivation;
  private readonly wrapping: KeyWrapping;
  private readonly cipher: FileCipher;
  private readonly streamCipher: StreamCipher;
  private readonly clock: Clock;
  private readonly random: SecureRandom;
  private readonly fs: FileSystem;
  private readonly secureDelete: SecureDelete;
  private readonly kdfParams: KdfParams;

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
  }

  async hasEnvelope(): Promise<boolean> {
    const user = this.requireUser();
    return (await this.backend.getDocument(BACKUP_PATHS.envelope(user.uid))) !== null;
  }

  async enable(keys: VaultKeys, passphrase: string): Promise<void> {
    // Validate before touching the network so a weak passphrase never reaches a server log.
    assertValidPassphrase(passphrase);
    const user = this.requireUser();
    const salt = this.random.bytes(SALT_LENGTH);
    const kek = await this.deriveKek(passphrase, salt, this.kdfParams);
    try {
      const wrappedMasterKey = await this.wrapping.wrap(
        keys.masterKey,
        kek,
        AAD.backupEnvelope,
      );
      await this.backend.putDocument(
        BACKUP_PATHS.envelope(user.uid),
        envelopeToJson({
          version: 1,
          salt,
          kdf: this.kdfParams,
          wrappedMasterKey,
          createdAt: this.clock.now(),
        }),
      );
    } finally {
      zeroBytes(kek);
    }
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
  async backupNow(repository: VaultRepository, keys: VaultKeys): Promise<BackupReport> {
    const user = this.requireUser();
    if (!(await this.hasEnvelope())) throw new BackupNotEnabledError();
    const uid = user.uid;

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
    const carried = (await this.readCloudIndex(uid, keys)).filter(
      (entry) => !localIds.has(entry.id),
    );

    const manifest = await this.backend.getDocument(BACKUP_PATHS.manifest(uid));
    const skip = new Set<string>(readPhotoIds(manifest));
    const uploaded = await this.uploadPhotos(repository, uid, skip);

    const merged = sortedNewestFirst([...repository.photos, ...carried]);

    await this.writeIndexAndManifest(uid, keys, merged);
    return { uploaded, cloudOnly: carried.length, total: merged.length };
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
  ): Promise<void> {
    const uid = this.requireUser().uid;
    // Nothing is skipped: every blob is rewritten, because the old ones are under the old key.
    await this.uploadPhotos(repository, uid, new Set());
    await this.writeIndexAndManifest(uid, keys, sortedNewestFirst([...repository.photos]));
    // Last, so the envelope only ever claims a key the rest of the account is already using.
    await this.enable(keys, passphrase);
  }

  /** Uploads every photo whose id is not in `skip`, adding the ones it uploads to it. */
  private async uploadPhotos(
    repository: VaultRepository,
    uid: string,
    skip: Set<string>,
  ): Promise<number> {
    let uploaded = 0;
    for (const entry of repository.photos) {
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
    if (encoded.length > MANIFEST_INDEX_BUDGET) {
      await this.backend.putDocument(BACKUP_PATHS.manifest(uid), manifest);
      return;
    }
    try {
      await this.backend.putDocument(BACKUP_PATHS.manifest(uid), { ...manifest, index: encoded });
    } catch (cause) {
      // Deployed rules validate the manifest with `hasOnly`, so a ruleset that predates this field
      // rejects the entire document -- and a backup that fails because its safety net is too new
      // is worse than one that goes without it. Devices update before rules do, and sometimes
      // instead of them, so the write is retried in the old shape.
      //
      // This cannot mask a real authorisation problem: that one denies the retry too, and it
      // surfaces exactly as it did before.
      if (!(cause instanceof CloudError && cause.code === 'permission-denied')) throw cause;
      await this.backend.putDocument(BACKUP_PATHS.manifest(uid), manifest);
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
  ): Promise<RestoreReport> {
    const uid = this.requireUser().uid;
    const source = deriveVaultKeys(backupMaster);
    try {
      const entries = await this.readCloudIndex(uid, source);
      const existing = new Set(repository.photos.map((p) => p.id));
      let restored = 0;
      let skipped = 0;

      // Oldest first, matching `restoreInto`: an interrupted run leaves the newest still to come
      // rather than a random subset.
      for (const entry of [...entries].reverse()) {
        if (existing.has(entry.id)) {
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
            skipped += 1;
            continue;
          }
          throw cause;
        }
      }
      return { restored, skipped };
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
  async restoreInto(repository: VaultRepository, keys: VaultKeys): Promise<RestoreReport> {
    const user = this.requireUser();
    const uid = user.uid;

    const indexBlob = await this.fetchIndexBlob(uid);
    if (indexBlob === null) return { restored: 0, skipped: 0 };

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

    // Oldest first, so an interrupted restore leaves the newest photos still to come rather than
    // a random subset.
    for (const entry of [...index.photos].reverse()) {
      if (existing.has(entry.id)) {
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
          skipped += 1;
          continue;
        }
        throw cause;
      }
    }
    return { restored, skipped };
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
