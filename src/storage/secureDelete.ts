/**
 * Best-effort secure deletion: overwrite the file's bytes in place with pseudo-random data, then
 * unlink it.
 *
 * On flash storage with wear levelling the controller may keep stale copies of blocks, so this is
 * not a guarantee and is documented as such. What it does buy is that the simple recovery path,
 * an undelete tool reading unallocated blocks, finds noise instead of the previous contents. For
 * vault blobs the previous contents were already ciphertext; this matters most for the plaintext
 * temp files that the camera and the photo picker hand us.
 *
 * The overwrite pattern only has to differ from the original data, so a fast PRNG is enough; it is
 * deliberately not the CSPRNG, which would be far slower for multi-megabyte files.
 */
import type { FileSystem } from '@/storage/fileSystem';

const CHUNK_SIZE = 64 * 1024;

export class SecureDelete {
  private state: number;

  constructor(
    private readonly fs: FileSystem,
    private readonly chunkSize: number = CHUNK_SIZE,
    seed: number = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0,
  ) {
    this.state = seed === 0 ? 0x9e3779b9 : seed >>> 0;
  }

  /** Overwrites then deletes. A missing file is a no-op; failures never propagate. */
  async file(uri: string): Promise<void> {
    try {
      if (!(await this.fs.exists(uri))) return;
      const length = await this.fs.size(uri);
      if (length > 0) {
        const buffer = new Uint8Array(Math.min(length, this.chunkSize));
        // expo-file-system writes from offset 0 each time; one full-length pass is achieved by
        // building a single buffer of the file's length when it is small, and otherwise by
        // overwriting the leading chunk, which is where headers and key ids live.
        if (length <= this.chunkSize) {
          this.fill(buffer, length);
          await this.fs.overwriteInPlace(uri, buffer.subarray(0, length));
        } else {
          const full = new Uint8Array(length);
          for (let offset = 0; offset < length; offset += this.chunkSize) {
            const n = Math.min(this.chunkSize, length - offset);
            this.fill(buffer, n);
            full.set(buffer.subarray(0, n), offset);
          }
          await this.fs.overwriteInPlace(uri, full);
        }
      }
    } catch {
      // Read-only volume, a race with another deleter, or a platform quirk: still try to unlink.
    }
    try {
      await this.fs.deleteFile(uri);
    } catch {
      // Already gone.
    }
  }

  /** Securely deletes every file under `uri`, depth first, then removes the directories. */
  async directoryContents(uri: string): Promise<void> {
    let entries;
    try {
      entries = await this.fs.list(uri);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory) {
        await this.directoryContents(entry.uri);
        try {
          await this.fs.deleteDirectory(entry.uri);
        } catch {
          // Leave it; the parent wipe will try again.
        }
      } else {
        await this.file(entry.uri);
      }
    }
  }

  /** xorshift32: fast, non-cryptographic, and never all-zero. */
  private fill(buffer: Uint8Array, length: number): void {
    for (let i = 0; i < length; i++) {
      let x = this.state;
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      this.state = x >>> 0;
      buffer[i] = this.state & 0xff;
    }
  }
}
