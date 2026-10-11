/**
 * Vault domain contracts: photo metadata, encrypted index, repository, thumbnails, caches.
 * On-disk formats are shared with the Flutter reference (docs/reference/flutter-vault-gallery-camera.md).
 */
import type { Bytes } from '@/utils/bytes';
import type { ProgressReport } from '@/utils/progress';

export type PhotoSource = 'camera' | 'import' | 'restore';

/**
 * Photos and videos are one kind of vault item, not two stores. They share the index, the id
 * space, the blob layout, the thumbnail pipeline, the gallery, deletion and cloud backup; what
 * differs is the sub-key the payload is encrypted under, the container format (a video is chunked
 * so it never has to fit in memory) and how it is presented.
 *
 * The kind is derived from `mimeType` rather than stored twice -- see `@/vault/mediaKind`.
 */
export type MediaKind = 'photo' | 'video';

export interface PhotoEntry {
  /** 32 lower-case hex chars (16 random bytes). Identity of a photo. */
  readonly id: string;
  /** Epoch ms (UTC). Serialised as ISO-8601 `...SSSZ`. */
  readonly createdAt: number;
  /** Orientation-corrected source dimensions. */
  readonly width: number;
  readonly height: number;
  /** Byte length of the ORIGINAL plaintext image. */
  readonly sizeBytes: number;
  readonly source: PhotoSource;
  readonly mimeType: string; // default 'image/jpeg'
  readonly originalName: string | null;
  /**
   * Recording length for videos; null for photos, and left out of the JSON entirely, so a vault of
   * photos serialises byte-for-byte the way it did before videos existed.
   */
  readonly durationMs: number | null;
}

/** JSON shape (key order matters for byte-identical output with the reference): */
export interface PhotoEntryJson {
  id: string;
  createdAt: string;
  width: number;
  height: number;
  sizeBytes: number;
  source: PhotoSource;
  mimeType: string;
  originalName: string | null;
  durationMs?: number;
}

export interface VaultIndex {
  readonly version: 1;
  /** Newest first. */
  readonly photos: readonly PhotoEntry[];
}

export interface VaultIndexJson {
  version: number;
  photos: PhotoEntryJson[];
}

export interface ThumbnailResult {
  readonly jpegBytes: Bytes;
  readonly thumbWidth: number;
  readonly thumbHeight: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
}

export const THUMBNAIL = {
  defaultMaxDimension: 512,
  jpegQuality: 82,
} as const;

/**
 * Image input for the repository. `bytes` is the original image; `uri` optionally points at the
 * same image as a temporary file (camera/picker output) so the native thumbnail pipeline can read
 * it without us writing plaintext ourselves. The caller securely deletes `uri` afterwards.
 */
export interface ImageInput {
  readonly bytes: Bytes;
  readonly uri?: string;
}

/**
 * Video input for the repository. A video is referenced by URI ONLY: the recording is read from
 * the app-private cache file straight into the cipher a chunk at a time, so its bytes are never a
 * `Uint8Array` in JS. The caller securely deletes `uri` afterwards, exactly as for a photo.
 */
export interface VideoInput {
  readonly uri: string;
  /** Measured by the recorder; null when it could not be determined. */
  readonly durationMs: number | null;
  readonly mimeType?: string; // default 'video/mp4'
}

export interface ThumbnailGenerator {
  /** Throws ImageDecodeError for undecodable input. Output is always JPEG (quality 82). */
  generate(image: ImageInput, maxDimension?: number): Promise<ThumbnailResult>;
}

/**
 * A poster frame for a video, already reduced to thumbnail size and JPEG-encoded, so a video tile
 * is the same encrypted `thumbs/<id>.enc` blob as a photo tile and the gallery needs no second
 * path. `sourceWidth`/`sourceHeight` are the video frame dimensions.
 */
export interface VideoThumbnailGenerator {
  /** Throws ImageDecodeError when no frame can be extracted. */
  generate(videoUri: string, maxDimension?: number): Promise<ThumbnailResult>;
}

export interface AddPhotoOptions {
  readonly source: PhotoSource;
  readonly originalName?: string | null;
  readonly mimeType?: string;
}

/**
 * What the vault holds, in plaintext bytes.
 *
 * Summed from the index rather than tracked as a running total, because a running total drifts:
 * one missed decrement and the vault believes it is fuller than it is, for ever, with nothing to
 * reconcile against. The index is the record, and twenty thousand additions is nothing to add up.
 */
export function storedBytesOf(photos: readonly PhotoEntry[]): number {
  return photos.reduce((total, photo) => total + photo.sizeBytes, 0);
}

export type PhotosListener = (photos: readonly PhotoEntry[]) => void;

/**
 * All methods use the keys of the live session; after lock every crypto call fails closed.
 * `open()` must be awaited before add/read/delete/importEncrypted.
 */
export interface VaultRepository {
  open(): Promise<void>;
  readonly photos: readonly PhotoEntry[];
  /** Emits the current list immediately, then after every change. Returns an unsubscribe. */
  watchPhotos(listener: PhotosListener): () => void;
  addPhoto(image: ImageInput, options: AddPhotoOptions): Promise<PhotoEntry>;
  /**
   * Encrypts a recording from its cache file straight into the vault, chunk by chunk. Returns once
   * the blob, its poster thumbnail and the index entry are all committed.
   */
  addVideo(video: VideoInput, options: AddPhotoOptions): Promise<PhotoEntry>;
  readThumbnail(id: string): Promise<Bytes>;
  /** Photos only. A video would not fit in memory, and this throws instead of trying. */
  readFullImage(id: string): Promise<Bytes>;
  /**
   * Decrypts a video to `targetUri` a chunk at a time. The target is plaintext and belongs to the
   * caller, which must delete it as soon as playback ends (see `@/vault/playbackScratch`).
   */
  readVideoToFile(id: string, targetUri: string): Promise<void>;
  /**
   * Removes photos and securely erases their files. `onProgress` fires per id, because a
   * selection of videos is slow enough that a silent screen reads as a frozen one.
   */
  deletePhotos(ids: Iterable<string>, onProgress?: ProgressReport): Promise<void>;
  readEncryptedPhoto(id: string): Promise<Bytes>;
  readEncryptedThumbnail(id: string): Promise<Bytes>;
  /** Where a payload blob sits on disk, for transfers that must not pass through JS memory. */
  encryptedPayloadUri(id: string): string;
  readEncryptedIndex(): Promise<Bytes | null>;
  importEncrypted(input: {
    entry: PhotoEntry;
    photoBlob: Bytes;
    thumbnailBlob: Bytes;
  }): Promise<void>;
  /**
   * The same as `importEncrypted`, with the payload already downloaded to `payloadUri` instead of
   * held in memory. Used for videos, whose ciphertext must not be a `Uint8Array`. The file is
   * consumed (moved into the vault) on success and left where it is on failure.
   */
  importEncryptedFile(input: {
    entry: PhotoEntry;
    payloadUri: string;
    thumbnailBlob: Bytes;
  }): Promise<void>;
  close(): Promise<void>;
}

export class ImageDecodeError extends Error {
  constructor(cause?: unknown) {
    super('ImageDecodeError');
    this.name = 'ImageDecodeError';
    this.cause = cause;
  }
}

export class VaultDataUnreadableError extends Error {
  constructor(cause?: unknown) {
    super('VaultDataUnreadableError');
    this.name = 'VaultDataUnreadableError';
    this.cause = cause;
  }
}

export class VaultLockedError extends Error {
  constructor() {
    super('VaultLockedError');
    this.name = 'VaultLockedError';
  }
}

export class RepositoryNotOpenError extends Error {
  constructor() {
    super('VaultRepository.open() was not awaited');
    this.name = 'RepositoryNotOpenError';
  }
}
