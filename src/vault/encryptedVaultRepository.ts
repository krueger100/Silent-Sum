/**
 * The encrypted photo store for one unlocked session.
 *
 * Every operation uses the `VaultKeys` handed over at construction. When the session locks those
 * keys are disposed, and every call here then throws instead of quietly succeeding: failing
 * closed is the intended behaviour, and it is why UI visibility is never the security boundary.
 *
 * Index writes are serialised. Adding a photo, deleting a selection and restoring from backup all
 * do read-modify-write on the same index, and without a queue two concurrent operations would
 * each write their own view and lose the other's entries.
 */
import {
  VaultKeyId,
  WrongKeyError,
  FileCipherFormatError,
  RecordFormatError,
  type FileCipher,
  type SecureRandom,
  type StreamCipher,
  type VaultKeys,
} from '@/crypto/types';
import { writeFileAtomically } from '@/storage/atomicWrite';
import type { FileSystem } from '@/storage/fileSystem';
import type { SecureDelete } from '@/storage/secureDelete';
import { DecryptedImageCache } from '@/vault/decryptedImageCache';
import { isVideo, payloadKeyId, VIDEO_MIME_TYPE } from '@/vault/mediaKind';
import { withSource } from '@/vault/photoEntry';
import type { VaultPaths } from '@/vault/vaultPaths';
import {
  EMPTY_INDEX,
  decodeIndex,
  encodeIndex,
  findById,
  sortedNewestFirst,
  withPhoto,
  withoutPhotos,
} from '@/vault/vaultIndex';
import {
  RepositoryNotOpenError,
  VaultDataUnreadableError,
  type AddPhotoOptions,
  type ImageInput,
  type PhotoEntry,
  type PhotosListener,
  type ThumbnailGenerator,
  type VaultIndex,
  type VaultRepository,
  type VideoInput,
  type VideoThumbnailGenerator,
} from '@/vault/types';
import { utf8Decode, utf8Encode, zeroBytes, type Bytes } from '@/utils/bytes';
import type { Clock } from '@/utils/clock';
import type { ProgressReport } from '@/utils/progress';

const THUMBNAIL_CACHE_BYTES = 24 * 1024 * 1024;
const FULL_IMAGE_CACHE_BYTES = 48 * 1024 * 1024;

export interface EncryptedVaultRepositoryOptions {
  fs: FileSystem;
  paths: VaultPaths;
  keys: VaultKeys;
  cipher: FileCipher;
  /** The chunked container, used for video payloads only. */
  streamCipher: StreamCipher;
  thumbnails: ThumbnailGenerator;
  videoThumbnails: VideoThumbnailGenerator;
  secureDelete: SecureDelete;
  clock: Clock;
  random: SecureRandom;
  thumbnailCacheBytes?: number;
  fullImageCacheBytes?: number;
}

/** Videos are never held in the decrypted-payload cache; only their poster thumbnails are. */
export class NotAPhotoError extends Error {
  constructor() {
    super('NotAPhotoError');
    this.name = 'NotAPhotoError';
  }
}

export class EncryptedVaultRepository implements VaultRepository {
  private readonly fs: FileSystem;
  private readonly paths: VaultPaths;
  private readonly keys: VaultKeys;
  private readonly cipher: FileCipher;
  private readonly streamCipher: StreamCipher;
  private readonly thumbnails: ThumbnailGenerator;
  private readonly videoThumbnails: VideoThumbnailGenerator;
  private readonly secureDelete: SecureDelete;
  private readonly clock: Clock;
  private readonly random: SecureRandom;
  private readonly thumbCache: DecryptedImageCache;
  private readonly fullCache: DecryptedImageCache;

  private index: VaultIndex = EMPTY_INDEX;
  private opened = false;
  private closed = false;
  private readonly listeners = new Set<PhotosListener>();
  /** Tail of the serialised mutation chain. */
  private mutations: Promise<unknown> = Promise.resolve();

  constructor(options: EncryptedVaultRepositoryOptions) {
    this.fs = options.fs;
    this.paths = options.paths;
    this.keys = options.keys;
    this.cipher = options.cipher;
    this.streamCipher = options.streamCipher;
    this.thumbnails = options.thumbnails;
    this.videoThumbnails = options.videoThumbnails;
    this.secureDelete = options.secureDelete;
    this.clock = options.clock;
    this.random = options.random;
    this.thumbCache = new DecryptedImageCache(
      options.thumbnailCacheBytes ?? THUMBNAIL_CACHE_BYTES,
    );
    this.fullCache = new DecryptedImageCache(options.fullImageCacheBytes ?? FULL_IMAGE_CACHE_BYTES);
  }

  async open(): Promise<void> {
    await this.paths.ensure(this.fs);
    if (await this.fs.exists(this.paths.index)) {
      const blob = await this.fs.readBytes(this.paths.index);
      let json: Bytes;
      try {
        json = await this.cipher.decrypt(
          blob,
          this.keys.keyFor(VaultKeyId.manifest),
          VaultKeyId.manifest,
        );
      } catch (cause) {
        // Foreign vault data, a corrupted file, or credentials that were reset out from under it.
        if (cause instanceof WrongKeyError || cause instanceof FileCipherFormatError) {
          throw new VaultDataUnreadableError(cause);
        }
        throw cause;
      }
      try {
        this.index = decodeIndex(utf8Decode(json));
      } catch (cause) {
        if (cause instanceof RecordFormatError) throw new VaultDataUnreadableError(cause);
        throw cause;
      } finally {
        zeroBytes(json);
      }
    }
    this.opened = true;
  }

  get photos(): readonly PhotoEntry[] {
    return this.index.photos;
  }

  watchPhotos(listener: PhotosListener): () => void {
    this.listeners.add(listener);
    listener(this.index.photos);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async addPhoto(image: ImageInput, options: AddPhotoOptions): Promise<PhotoEntry> {
    this.ensureOpen();
    const thumb = await this.thumbnails.generate(image);
    const photoBlob = await this.cipher.encrypt(
      image.bytes,
      this.keys.keyFor(VaultKeyId.photo),
      VaultKeyId.photo,
    );
    const thumbBlob = await this.cipher.encrypt(
      thumb.jpegBytes,
      this.keys.keyFor(VaultKeyId.thumb),
      VaultKeyId.thumb,
    );
    const id = this.random.hexId();
    const photoUri = this.paths.photoFile(id);
    const thumbUri = this.paths.thumbFile(id);

    return this.serialized(async () => {
      try {
        await writeFileAtomically(this.fs, photoUri, photoBlob);
        await writeFileAtomically(this.fs, thumbUri, thumbBlob);
        const entry: PhotoEntry = {
          id,
          createdAt: this.clock.now(),
          width: thumb.sourceWidth,
          height: thumb.sourceHeight,
          sizeBytes: image.bytes.length,
          source: options.source,
          mimeType: options.mimeType ?? 'image/jpeg',
          originalName: options.originalName ?? null,
          durationMs: null,
        };
        await this.commitIndex(withPhoto(this.index, entry));
        this.thumbCache.put(id, thumb.jpegBytes);
        return entry;
      } catch (error) {
        // Never leave an orphan blob behind if the index write failed.
        await this.secureDelete.file(photoUri);
        await this.secureDelete.file(thumbUri);
        throw error;
      }
    });
  }

  /**
   * A recording goes into the vault without ever being a `Uint8Array`: the cipher reads the cache
   * file and writes the blob a chunk at a time. The poster frame is produced first, because a
   * video whose frame cannot be extracted is a video the gallery could not show, and failing
   * before anything is written keeps the vault free of items with no tile.
   *
   * The caller still owns `video.uri` and securely deletes it; this method never does, so a
   * failure here leaves the recording where the user can be told about it rather than silently
   * destroying it.
   */
  async addVideo(video: VideoInput, options: AddPhotoOptions): Promise<PhotoEntry> {
    this.ensureOpen();
    const poster = await this.videoThumbnails.generate(video.uri);
    const thumbBlob = await this.cipher.encrypt(
      poster.jpegBytes,
      this.keys.keyFor(VaultKeyId.thumb),
      VaultKeyId.thumb,
    );
    const id = this.random.hexId();
    const payloadUri = this.paths.photoFile(id);
    const thumbUri = this.paths.thumbFile(id);

    return this.serialized(async () => {
      try {
        const written = await this.streamCipher.encryptFile(
          video.uri,
          payloadUri,
          this.keys.keyFor(VaultKeyId.video),
          VaultKeyId.video,
        );
        await writeFileAtomically(this.fs, thumbUri, thumbBlob);
        const entry: PhotoEntry = {
          id,
          createdAt: this.clock.now(),
          width: poster.sourceWidth,
          height: poster.sourceHeight,
          sizeBytes: written.plainBytes,
          source: options.source,
          mimeType: options.mimeType ?? VIDEO_MIME_TYPE,
          originalName: options.originalName ?? null,
          durationMs: video.durationMs,
        };
        await this.commitIndex(withPhoto(this.index, entry));
        this.thumbCache.put(id, poster.jpegBytes);
        return entry;
      } catch (error) {
        await this.secureDelete.file(payloadUri);
        await this.secureDelete.file(thumbUri);
        throw error;
      }
    });
  }

  async readThumbnail(id: string): Promise<Bytes> {
    this.ensureOpen();
    const cached = this.thumbCache.get(id);
    if (cached !== null) return cached;
    const blob = await this.fs.readBytes(this.paths.thumbFile(id));
    const bytes = await this.cipher.decrypt(
      blob,
      this.keys.keyFor(VaultKeyId.thumb),
      VaultKeyId.thumb,
    );
    this.thumbCache.put(id, bytes);
    return bytes;
  }

  async readFullImage(id: string): Promise<Bytes> {
    this.ensureOpen();
    // A video payload is not something to hand back as bytes at any size, so this refuses rather
    // than letting a caller allocate a few hundred megabytes by accident.
    const entry = findById(this.index, id);
    if (entry !== null && isVideo(entry)) throw new NotAPhotoError();
    const cached = this.fullCache.get(id);
    if (cached !== null) return cached;
    const blob = await this.fs.readBytes(this.paths.photoFile(id));
    const bytes = await this.cipher.decrypt(
      blob,
      this.keys.keyFor(VaultKeyId.photo),
      VaultKeyId.photo,
    );
    this.fullCache.put(id, bytes);
    return bytes;
  }

  async readVideoToFile(id: string, targetUri: string): Promise<void> {
    this.ensureOpen();
    const entry = findById(this.index, id);
    if (entry === null || !isVideo(entry)) throw new NotAPhotoError();
    await this.streamCipher.decryptFile(
      this.paths.photoFile(id),
      targetUri,
      this.keys.keyFor(VaultKeyId.video),
      VaultKeyId.video,
    );
  }

  async deletePhotos(ids: Iterable<string>, onProgress?: ProgressReport): Promise<void> {
    this.ensureOpen();
    const set = new Set(ids);
    if (set.size === 0) return;
    await this.serialized(async () => {
      // The index goes first: if the process dies mid-delete the photo is already unreachable.
      await this.commitIndex(withoutPhotos(this.index, set));
      // Reported from here rather than from the caller: secure deletion overwrites before it
      // unlinks, so a selection of videos takes real time and only this loop knows how far in
      // it is. The index is already committed by now, so the count is of erasure, not of
      // whether the photos are gone -- they are, from the first line above.
      const total = set.size;
      let done = 0;
      onProgress?.(0, total);
      for (const id of set) {
        this.thumbCache.remove(id);
        this.fullCache.remove(id);
        await this.secureDelete.file(this.paths.photoFile(id));
        await this.secureDelete.file(this.paths.thumbFile(id));
        done += 1;
        onProgress?.(done, total);
      }
    });
  }

  async readEncryptedPhoto(id: string): Promise<Bytes> {
    return this.fs.readBytes(this.paths.photoFile(id));
  }

  encryptedPayloadUri(id: string): string {
    return this.paths.photoFile(id);
  }

  async readEncryptedThumbnail(id: string): Promise<Bytes> {
    return this.fs.readBytes(this.paths.thumbFile(id));
  }

  async readEncryptedIndex(): Promise<Bytes | null> {
    if (!(await this.fs.exists(this.paths.index))) return null;
    return this.fs.readBytes(this.paths.index);
  }

  /**
   * Accepts ciphertext that was produced by this vault's own keys (a restore from cloud backup).
   * Both blobs are authenticated BEFORE anything is written, so a tampered or foreign blob is
   * rejected rather than stored and discovered later when the user opens the photo.
   */
  async importEncrypted(input: {
    entry: PhotoEntry;
    photoBlob: Bytes;
    thumbnailBlob: Bytes;
  }): Promise<void> {
    this.ensureOpen();
    const thumbPlain = await this.cipher.decrypt(
      input.thumbnailBlob,
      this.keys.keyFor(VaultKeyId.thumb),
      VaultKeyId.thumb,
    );
    zeroBytes(thumbPlain);
    const keyId = payloadKeyId(input.entry);
    if (keyId !== VaultKeyId.photo) throw new NotAPhotoError();
    const photoPlain = await this.cipher.decrypt(
      input.photoBlob,
      this.keys.keyFor(VaultKeyId.photo),
      VaultKeyId.photo,
    );
    zeroBytes(photoPlain);

    await this.serialized(async () => {
      await writeFileAtomically(this.fs, this.paths.photoFile(input.entry.id), input.photoBlob);
      await writeFileAtomically(this.fs, this.paths.thumbFile(input.entry.id), input.thumbnailBlob);
      await this.recordRestored(input.entry);
    });
  }

  /**
   * The video form of {@link importEncrypted}: the payload has already been downloaded to a file,
   * because a video blob must not pass through JS memory on its way back from the cloud either.
   *
   * It is authenticated the same way -- every chunk verified, with nothing kept -- BEFORE the file
   * is moved into the vault, so a tampered or foreign blob is rejected rather than stored and
   * discovered when the user presses play.
   */
  async importEncryptedFile(input: {
    entry: PhotoEntry;
    payloadUri: string;
    thumbnailBlob: Bytes;
  }): Promise<void> {
    this.ensureOpen();
    const thumbPlain = await this.cipher.decrypt(
      input.thumbnailBlob,
      this.keys.keyFor(VaultKeyId.thumb),
      VaultKeyId.thumb,
    );
    zeroBytes(thumbPlain);
    const keyId = payloadKeyId(input.entry);
    if (keyId === VaultKeyId.video) {
      await this.streamCipher.verifyFile(input.payloadUri, this.keys.keyFor(keyId), keyId);
    } else {
      const plain = await this.cipher.decrypt(
        await this.fs.readBytes(input.payloadUri),
        this.keys.keyFor(keyId),
        keyId,
      );
      zeroBytes(plain);
    }

    await this.serialized(async () => {
      await this.fs.move(input.payloadUri, this.paths.photoFile(input.entry.id));
      await writeFileAtomically(this.fs, this.paths.thumbFile(input.entry.id), input.thumbnailBlob);
      await this.recordRestored(input.entry);
    });
  }

  private async recordRestored(entry: PhotoEntry): Promise<void> {
    const without = withoutPhotos(this.index, new Set([entry.id]));
    const photos = sortedNewestFirst([...without.photos, withSource(entry, 'restore')]);
    await this.commitIndex({ version: without.version, photos });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.thumbCache.clear();
    this.fullCache.clear();
    this.listeners.clear();
  }

  private ensureOpen(): void {
    if (!this.opened || this.closed) throw new RepositoryNotOpenError();
  }

  private async commitIndex(next: VaultIndex): Promise<void> {
    const json = utf8Encode(encodeIndex(next));
    const blob = await this.cipher.encrypt(
      json,
      this.keys.keyFor(VaultKeyId.manifest),
      VaultKeyId.manifest,
    );
    zeroBytes(json);
    await writeFileAtomically(this.fs, this.paths.index, blob);
    this.index = next;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.index.photos);
  }

  /** Chains `action` after every mutation already queued, whether they resolved or rejected. */
  private serialized<T>(action: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(action, action);
    // Swallow rejections on the chain itself so one failure does not poison later mutations.
    this.mutations = result.catch(() => undefined);
    return result;
  }
}
