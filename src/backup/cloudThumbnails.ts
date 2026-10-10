/**
 * Thumbnails for Cloud Gallery tiles whose photo is no longer on this device.
 *
 * The Cloud Gallery lists what an account holds in the cloud, and the ordinary case is that the
 * photo is still here too -- those tiles read the vault and never come near this. The ones that do
 * not are the backup doing its job: the user deleted the local copy and the cloud kept it. Those
 * tiles used to draw the error placeholder, so a photo that was safe looked exactly like one that
 * was corrupt.
 *
 * NOTHING NEW IS TRUSTED TO MAKE THAT WORK. The thumbnail blob in Storage is the vault's own
 * ciphertext, uploaded verbatim under `VaultKeyId.thumb`, and the gallery only lists an account
 * whose index decrypted under this vault's manifest key -- which proves the master key matches,
 * and so proves the thumb key does. A backup made by another vault is reported `foreign` and never
 * listed, so no key is ever borrowed, shared or relaxed to show a tile.
 *
 * What IS new is that plaintext for photos this device does not hold now exists in memory while
 * the gallery is open. That is why this class exists rather than a `Map` in a screen:
 *
 *   - the plaintext lives in a bounded {@link DecryptedImageCache}, which zeroes on `clear`;
 *   - the vault lock clears it, through the same `onLock` that closes the repository;
 *   - a fetch that lands after a clear is zeroed instead of cached, so locking cannot be raced;
 *   - nothing is ever written to disk -- `getBlob`, never `getBlobToFile`, and the tile hands the
 *     bytes to expo-image with `cachePolicy="memory"`;
 *   - a change of account empties it, so one account's thumbnails cannot outlive its session.
 */
import type { VaultKeys } from '@/crypto/types';
import { CloudError } from '@/firebase/types';
import type { Bytes } from '@/utils/bytes';
import { zeroBytes } from '@/utils/bytes';
import { DecryptedImageCache } from '@/vault/decryptedImageCache';

/**
 * Smaller than the vault's own 24 MB: this holds only the cloud-only tiles of one gallery, and
 * every byte in it is plaintext for a photo the device chose not to keep.
 */
const CLOUD_THUMBNAIL_CACHE_BYTES = 8 * 1024 * 1024;

/**
 * How many thumbnails may be in flight at once.
 *
 * A FlatList window mounts a screenful of tiles in one pass, and twenty-five simultaneous
 * downloads is both rude to the network and slower than four, because none of them finishes
 * early enough to draw.
 */
const MAX_PARALLEL = 4;

/**
 * The one method of `BackupService` this needs.
 *
 * Narrower than the service on purpose: nothing here may upload, enable, remove or rebind, and a
 * dependency that cannot express those is a better guarantee of it than a comment. `BackupService` satisfies it
 * structurally, so the composition root passes the real one unchanged.
 */
export interface CloudThumbnailSource {
  readCloudThumbnail(keys: VaultKeys, id: string): Promise<Bytes>;
}

export interface CloudThumbnailDeps {
  /** Null in a build with no cloud backend, where there is no Cloud Gallery to draw. */
  readonly backup: () => CloudThumbnailSource | null;
  /** Whose account is signed in now. Null when nobody is. */
  readonly uid: () => string | null;
  readonly maxBytes?: number;
  readonly maxParallel?: number;
}

export class CloudThumbnails {
  private readonly cache: DecryptedImageCache;
  private readonly maxParallel: number;
  /** Whose thumbnails the cache currently holds, so another account's cannot be served. */
  private account: string | null = null;
  private inFlight = 0;
  private readonly waiting: (() => void)[] = [];
  /**
   * Bumped by every `clear`.
   *
   * A download in progress when the vault locks resolves after the cache has been emptied. Its
   * generation no longer matches, so the bytes are zeroed and dropped rather than quietly put
   * back into a cache the lock had just wiped.
   */
  private generation = 0;

  constructor(private readonly deps: CloudThumbnailDeps) {
    this.cache = new DecryptedImageCache(deps.maxBytes ?? CLOUD_THUMBNAIL_CACHE_BYTES);
    this.maxParallel = deps.maxParallel ?? MAX_PARALLEL;
  }

  /** For tests and diagnostics: how many thumbnails are held. Never the bytes themselves. */
  get size(): number {
    return this.cache.size;
  }

  /**
   * The decrypted thumbnail for one backed-up photo.
   *
   * Throws rather than returning a placeholder of its own: the tile already knows what to draw
   * when a thumbnail cannot be had, and an offline device must not be made to look like a
   * damaged backup.
   */
  async read(keys: VaultKeys, id: string): Promise<Bytes> {
    const backup = this.deps.backup();
    const uid = this.deps.uid();
    if (backup === null || uid === null) throw new CloudError('unavailable');
    this.syncAccount(uid);

    const cached = this.cache.get(id);
    if (cached !== null) return cached;

    const generation = this.generation;
    await this.acquire();
    try {
      // Another tile may have fetched the same id while this one waited for a slot -- two tiles
      // for one photo is what a re-render during a scroll looks like.
      const second = this.cache.get(id);
      if (second !== null) return second;
      const bytes = await backup.readCloudThumbnail(keys, id);
      if (generation !== this.generation) {
        // Locked, or the account changed, while this was in the air.
        zeroBytes(bytes);
        throw new CloudError('unavailable');
      }
      this.cache.put(id, bytes);
      return bytes;
    } finally {
      this.release();
    }
  }

  /** The vault locked, or the account went away: wipe every plaintext byte. */
  clear(): void {
    this.generation += 1;
    this.account = null;
    this.cache.clear();
  }

  /**
   * Empties the cache when the signed-in account is not the one it was filled for.
   *
   * Ids come from a CSPRNG and would not collide across accounts, so this is not what stops a
   * wrong-account hit. It is what stops one account's plaintext sitting in memory through the
   * next account's session.
   */
  private syncAccount(uid: string): void {
    if (this.account === uid) return;
    this.clear();
    this.account = uid;
  }

  private async acquire(): Promise<void> {
    if (this.inFlight < this.maxParallel) {
      this.inFlight += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  /**
   * Hands the slot straight to the next waiter rather than freeing it.
   *
   * Decrementing first would let a caller arriving in that instant take a slot the waiter was
   * already promised, so the limit could be exceeded while someone queued.
   */
  private release(): void {
    const next = this.waiting.shift();
    if (next === undefined) {
      this.inFlight -= 1;
      return;
    }
    next();
  }
}
