/**
 * The one way an item leaves the vault.
 *
 * Everything else in the gallery works to keep plaintext from existing: photos are shown from
 * memory as a `data:` URI, videos decrypt to a scratch file that is securely deleted the moment
 * the page scrolls away. An export is the deliberate opposite -- it writes a plaintext copy
 * somewhere the user, and every other app on the phone, can read it. So the job here is to make
 * that copy the only one, and to make it short-lived:
 *
 *  - Permission is asked FIRST. A refusal must not leave a decrypted file behind, and it cannot
 *    if nothing was decrypted yet.
 *  - The decrypt goes to `PlaybackScratch`, the same random-named, app-private, securely-deleted
 *    directory videos already use. Handing the OS a path inside the vault is not an option: the
 *    vault holds ciphertext, and the gallery would import the ciphertext.
 *  - The scratch file is released in a `finally`, so a failed save is as clean as a successful
 *    one. Once the OS has copied the asset, our copy has no reason to exist.
 *
 * The caller decides whether to ask the user first; this module only performs an export that has
 * already been decided on.
 */
import type { FileSystem } from '@/storage/fileSystem';
import { isVideo } from '@/vault/mediaKind';
import type { PlaybackScratch } from '@/vault/playbackScratch';
import type { PhotoEntry, VaultRepository } from '@/vault/types';

/**
 * `denied` and `failed` are kept apart because only one of them is worth a retry: a denial is the
 * user's own answer and the UI should say so, a failure is ours.
 */
export type GalleryExportOutcome = 'saved' | 'denied' | 'failed';

/** The device gallery, as the one thing this module needs it to be. */
export interface GalleryWriter {
  /** Resolves true when the app may add to the gallery. May show a system prompt. */
  requestWriteAccess(): Promise<boolean>;
  /** Copies a finished plaintext file into the gallery. The path must carry a real extension. */
  save(fileUri: string): Promise<void>;
}

export interface GalleryExportDeps {
  readonly repository: Pick<VaultRepository, 'readFullImage' | 'readVideoToFile'>;
  readonly scratch: Pick<PlaybackScratch, 'allocateNamed' | 'release'>;
  readonly fs: Pick<FileSystem, 'writeBytes'>;
  readonly writer: GalleryWriter;
}

/**
 * MediaStore types an asset from the file extension, not from anything we tell it, so a photo
 * written as `.bin` lands in the gallery as an unopenable file rather than a picture.
 */
export function galleryFileExtension(mimeType: string): string {
  const [type] = mimeType.split(';');
  const subtype = (type ?? '').split('/')[1] ?? '';
  // `image/svg+xml` and friends: the suffix after `+` is a structure hint, not a file type.
  const bare = (subtype.split('+')[0] ?? '').trim().toLowerCase();
  if (!/^[a-z0-9]+$/.test(bare)) return 'bin';
  return bare === 'jpeg' ? 'jpg' : bare;
}

/** Two digits, so a filename sorts the way a date does. */
function pad(value: number): string {
  return value < 10 ? `0${String(value)}` : String(value);
}

/**
 * The name the item will carry in the gallery.
 *
 * MediaStore takes the display name from the file, so this is what the user sees forever after.
 * The vault's own name for an item is a 32-character hex id, which would be useless to them.
 *
 * The original file name is preferred when the vault still has one, stripped back to characters
 * that are safe in a file name and re-extended from the MIME type rather than trusting whatever
 * the old extension claimed. Failing that, `IMG_<date>_<time>` -- which is what a camera would
 * have called it, and says nothing about where it came from. Nothing here is allowed to name the
 * app: a gallery full of `SilentSum_*.jpg` would undo the disguise from the outside.
 */
export function galleryFileName(entry: PhotoEntry): string {
  const extension = galleryFileExtension(entry.mimeType);
  const original = entry.originalName ?? '';
  // Any directory part is dropped before sanitising, so "../../etc/passwd" cannot survive as a
  // traversal; what is left is a single path segment or nothing.
  const lastSegment = original.split(/[\\/]/).pop() ?? '';
  const withoutExtension = lastSegment.replace(/\.[^.]*$/, '');
  const safe = withoutExtension.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '').slice(0, 64);
  if (safe !== '') return `${safe}.${extension}`;

  const taken = new Date(entry.createdAt);
  const date = `${String(taken.getFullYear())}${pad(taken.getMonth() + 1)}${pad(taken.getDate())}`;
  const time = `${pad(taken.getHours())}${pad(taken.getMinutes())}${pad(taken.getSeconds())}`;
  return `IMG_${date}_${time}.${extension}`;
}

export async function exportToGallery(
  entry: PhotoEntry,
  deps: GalleryExportDeps,
): Promise<GalleryExportOutcome> {
  // Before anything is decrypted: a refused prompt then costs nothing and leaves nothing.
  let granted = false;
  try {
    granted = await deps.writer.requestWriteAccess();
  } catch {
    return 'failed';
  }
  if (!granted) return 'denied';

  const target = await deps.scratch.allocateNamed(galleryFileName(entry));
  try {
    if (isVideo(entry)) {
      // Chunked, because a recording does not fit in the JS heap.
      await deps.repository.readVideoToFile(entry.id, target);
    } else {
      await deps.fs.writeBytes(target, await deps.repository.readFullImage(entry.id));
    }
    await deps.writer.save(target);
    return 'saved';
  } catch {
    return 'failed';
  } finally {
    // The gallery has its own copy now (or the export failed and there should be none at all).
    await deps.scratch.release(target);
  }
}
