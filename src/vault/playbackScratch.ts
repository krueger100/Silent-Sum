/**
 * The one place a decrypted video is allowed to exist.
 *
 * A photo is shown from memory as a `data:` URI and never touches disk. A video cannot be: every
 * player on both platforms takes a URL, and handing one a few hundred megabytes of base64 is not a
 * thing a phone can do. So playback decrypts to a real file -- and the whole design of this module
 * is about making that file short-lived and impossible to forget about:
 *
 *  - It lives in an app-private cache sub-directory of its own. Nothing else writes there, so
 *    "delete everything in it" is always a safe thing to do.
 *  - Its name is random, not the vault id, so the directory listing does not even reveal which
 *    vault items have been watched.
 *  - It is securely deleted when playback ends, and `purge()` wipes the whole directory when the
 *    vault locks, when the app goes to the background, and again the next time the vault opens --
 *    which is what covers the case the app cannot observe at all, being killed mid-playback.
 *
 * `purge()` never throws: it is called from teardown paths where a failure must not stop the vault
 * from locking.
 */
import type { SecureRandom } from '@/crypto/types';
import { joinUri, type FileSystem } from '@/storage/fileSystem';
import type { SecureDelete } from '@/storage/secureDelete';

export const PLAYBACK_DIRECTORY_NAME = 'playback';

export interface PlaybackScratchOptions {
  fs: FileSystem;
  secureDelete: SecureDelete;
  random: SecureRandom;
}

export class PlaybackScratch {
  private readonly fs: FileSystem;
  private readonly secureDelete: SecureDelete;
  private readonly random: SecureRandom;
  private readonly live = new Set<string>();

  constructor(options: PlaybackScratchOptions) {
    this.fs = options.fs;
    this.secureDelete = options.secureDelete;
    this.random = options.random;
  }

  get directory(): string {
    return joinUri(this.fs.cacheDirectory, PLAYBACK_DIRECTORY_NAME);
  }

  /** A fresh, unused path. Nothing is written yet; the caller decrypts into it. */
  async allocate(extension = 'mp4'): Promise<string> {
    await this.fs.makeDirectory(this.directory);
    const uri = joinUri(this.directory, `${this.random.hexId()}.${extension}`);
    this.live.add(uri);
    return uri;
  }

  /**
   * A fresh path whose FILE NAME is exactly `fileName`.
   *
   * For the one case where the name outlives the file: a gallery export takes its display name
   * from the file handed to MediaStore, so a random name here would put a 32-character hex string
   * in the user's gallery. Uniqueness comes from a random DIRECTORY instead, which keeps the
   * guarantee `allocate` makes -- two exports never collide -- without choosing the name.
   *
   * The directory listing does reveal this name, where `allocate` reveals nothing. That is the
   * deliberate trade: the same name is about to be written to the gallery, where it is permanent
   * and visible to every app, so hiding it in app-private cache for the few hundred milliseconds
   * in between would protect nothing.
   */
  async allocateNamed(fileName: string): Promise<string> {
    const directory = joinUri(this.directory, this.random.hexId());
    await this.fs.makeDirectory(directory);
    const uri = joinUri(directory, fileName);
    this.live.add(uri);
    return uri;
  }

  /** Playback finished, the page unmounted, or the decrypt failed. Idempotent. */
  async release(uri: string): Promise<void> {
    this.live.delete(uri);
    await this.secureDelete.file(uri);
    // `allocateNamed` puts its file in a directory of its own; drop that too, so the scratch
    // directory does not fill with empty husks between purges.
    const parent = uri.slice(0, Math.max(0, uri.lastIndexOf('/')));
    if (parent !== '' && parent !== this.directory && parent.startsWith(`${this.directory}/`)) {
      try {
        await this.fs.deleteDirectory(parent);
      } catch {
        // Not ours to insist on; `purge()` wipes the whole tree anyway.
      }
    }
  }

  /** Everything in the directory, including files a previous process never got to release. */
  async purge(): Promise<void> {
    this.live.clear();
    try {
      await this.secureDelete.directoryContents(this.directory);
    } catch {
      // Teardown must not fail because a cache directory could not be listed.
    }
  }

  /** Paths handed out and not yet released. Used by tests to prove cleanup actually happened. */
  get outstanding(): readonly string[] {
    return [...this.live];
  }
}
