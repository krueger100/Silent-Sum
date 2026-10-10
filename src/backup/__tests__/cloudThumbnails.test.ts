/**
 * Drawing a photo this device no longer holds, without becoming a place plaintext accumulates.
 *
 * Two things are being proved here and they pull in opposite directions. The thumbnail has to be
 * fetchable at all -- the cloud blob is the vault's own ciphertext and this vault's key opens it,
 * which is the entire reason no new key handling was needed. And it must not survive the session:
 * these are photos the user chose to delete from the device, so their plaintext existing in memory
 * for longer than the gallery is open would be a worse bargain than the grey square it replaced.
 *
 * Driven through the real composition root, so the lock hook under test is the one the app wires.
 */
import {
  buildCloudHarness,
  openVaultWithPhotos,
  type CloudHarness,
} from '@/backup/screens/__tests__/harness';
import { BACKUP_PATHS, type BackupService } from '@/backup/types';
import { CloudThumbnails } from '@/backup/cloudThumbnails';
import { deriveVaultKeys } from '@/crypto';
import { CloudError } from '@/firebase/types';
import type { Bytes } from '@/utils/bytes';
import type { VaultRepository } from '@/vault/types';

const PIN = '2468';
const EMAIL = 'vault@example.test';
const OTHER_EMAIL = 'someone-else@example.test';
const ACCOUNT_PASSWORD = 'account-password';
const PASSPHRASE = 'correct horse battery staple';

interface Device {
  readonly harness: CloudHarness;
  readonly repository: VaultRepository;
  readonly backup: BackupService;
  readonly uid: string;
  readonly ids: readonly string[];
}

/** A signed-in device whose photos are all backed up, as the Cloud Gallery finds it. */
async function backedUp(count: number): Promise<Device> {
  const harness = buildCloudHarness();
  await openVaultWithPhotos(harness, PIN, count);
  await harness.cloud.signUp(EMAIL, ACCOUNT_PASSWORD);
  const backup = harness.services.backup;
  const repository = harness.services.vault.current;
  if (backup === null) throw new Error('expected a backup service');
  if (repository === null) throw new Error('expected an open vault');
  const keys = harness.services.session.requireKeys();
  await backup.enable(keys, PASSPHRASE);
  const ids = repository.photos.map((photo) => photo.id);
  await backup.backupNow(repository, keys, { ids });
  return { harness, repository, backup, uid: harness.cloud.currentUser?.uid ?? '', ids };
}

function first(ids: readonly string[]): string {
  const id = ids[0];
  if (id === undefined) throw new Error('no photo');
  return id;
}

/** A promise with its resolver, for holding a download open while something else is tested. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('a thumbnail that is only in the cloud', () => {
  /**
   * The claim the whole design rests on: the blob was uploaded verbatim under this vault's thumb
   * key, so the bytes that come back are the bytes the vault itself would have read. If this ever
   * fails, something started re-encrypting on upload and the gallery's key assumption is void.
   */
  it('decrypts to exactly what the local thumbnail was', async () => {
    const { harness, repository, ids } = await backedUp(2);
    const id = first(ids);
    const local = Uint8Array.from(await repository.readThumbnail(id));
    const keys = harness.services.session.requireKeys();

    // The local copy goes, exactly as a user clearing space off their device would leave it.
    await repository.deletePhotos([id]);

    const fromCloud = await harness.services.cloudThumbnails.read(keys, id);

    expect(Uint8Array.from(fromCloud)).toEqual(local);
  });

  it('asks Storage once and serves the rest from memory', async () => {
    const { harness, repository, ids } = await backedUp(1);
    const id = first(ids);
    const keys = harness.services.session.requireKeys();
    await repository.deletePhotos([id]);
    const getBlob = jest.spyOn(harness.cloud, 'getBlob');

    await harness.services.cloudThumbnails.read(keys, id);
    await harness.services.cloudThumbnails.read(keys, id);
    await harness.services.cloudThumbnails.read(keys, id);

    expect(getBlob).toHaveBeenCalledTimes(1);
    expect(harness.services.cloudThumbnails.size).toBe(1);
  });

  /** Nothing may reach the disk: the plaintext of a photo the user deleted from this device. */
  it('writes nothing to the filesystem', async () => {
    const { harness, repository, ids } = await backedUp(1);
    const id = first(ids);
    const keys = harness.services.session.requireKeys();
    await repository.deletePhotos([id]);
    const writeBytes = jest.spyOn(harness.fs, 'writeBytes');
    const openWrite = jest.spyOn(harness.fs, 'openWrite');
    const move = jest.spyOn(harness.fs, 'move');

    await harness.services.cloudThumbnails.read(keys, id);

    expect(writeBytes).not.toHaveBeenCalled();
    expect(openWrite).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();
  });

  it('reports a missing object rather than inventing a thumbnail', async () => {
    const { harness, repository, uid, ids } = await backedUp(1);
    const id = first(ids);
    const keys = harness.services.session.requireKeys();
    await repository.deletePhotos([id]);
    harness.cloud.blobs.delete(BACKUP_PATHS.thumb(uid, id));

    await expect(harness.services.cloudThumbnails.read(keys, id)).rejects.toBeInstanceOf(
      CloudError,
    );
    expect(harness.services.cloudThumbnails.size).toBe(0);
  });
});

describe('locking the vault', () => {
  /** The hook under test is the one `createServices` wires, not one this spec invented. */
  it('empties the cache', async () => {
    const { harness, repository, ids } = await backedUp(1);
    const id = first(ids);
    const keys = harness.services.session.requireKeys();
    await repository.deletePhotos([id]);
    await harness.services.cloudThumbnails.read(keys, id);
    expect(harness.services.cloudThumbnails.size).toBe(1);

    harness.services.session.lock();

    expect(harness.services.cloudThumbnails.size).toBe(0);
  });

  /**
   * A download still in the air when the lock happens.
   *
   * Two things stop it, and the first is not this class: locking disposes the session keys, so the
   * decrypt cannot run at all and no plaintext is ever produced. That is why the rejection is not
   * pinned to a type here -- asserting `CloudError` would quietly turn a stronger guarantee
   * (`KeysDisposedError`, thrown before the cipher is touched) into a failure.
   */
  it('cannot finish a download that lands after the lock', async () => {
    const { harness, repository, ids } = await backedUp(1);
    const id = first(ids);
    const keys = harness.services.session.requireKeys();
    await repository.deletePhotos([id]);

    const blob = harness.cloud.blobs.get(
      BACKUP_PATHS.thumb(harness.cloud.currentUser?.uid ?? '', id),
    );
    if (blob === undefined) throw new Error('expected an uploaded thumbnail');
    const held = deferred<Bytes>();
    jest.spyOn(harness.cloud, 'getBlob').mockReturnValue(held.promise);

    const pending = harness.services.cloudThumbnails.read(keys, id);
    harness.services.session.lock();
    held.resolve(blob);

    await expect(pending).rejects.toThrow();
    expect(harness.services.cloudThumbnails.size).toBe(0);
  });

  /**
   * The second line of defence, on its own: a decrypt that DID complete, racing a clear.
   *
   * The keys being disposed covers the ordinary lock. This covers the window between a successful
   * decrypt and the `put` that would follow it -- where plaintext exists and the cache has just
   * been wiped. Caching it there would leave bytes behind a lock that had emptied everything, with
   * nothing to clear them until the next one.
   */
  it('zeroes plaintext that arrives after a clear rather than caching it', async () => {
    const keys = deriveVaultKeys(new Uint8Array(32).fill(7));
    const held = deferred<Bytes>();
    const thumbs = new CloudThumbnails({
      backup: () => ({ readCloudThumbnail: () => held.promise }),
      uid: () => 'account-1',
    });

    const pending = thumbs.read(keys, 'photo-1');
    await Promise.resolve();
    thumbs.clear();
    const plaintext = new Uint8Array([9, 9, 9, 9]);
    held.resolve(plaintext);

    await expect(pending).rejects.toBeInstanceOf(CloudError);
    expect(thumbs.size).toBe(0);
    // Wiped, not merely dropped for the collector to deal with eventually.
    expect([...plaintext]).toEqual([0, 0, 0, 0]);
    keys.dispose();
  });
});

describe('a different account on the same device', () => {
  /** One account's plaintext must not sit in memory through the next account's session. */
  it('empties the cache before reading anything', async () => {
    const { harness, repository, ids } = await backedUp(1);
    const id = first(ids);
    const keys = harness.services.session.requireKeys();
    await repository.deletePhotos([id]);
    await harness.services.cloudThumbnails.read(keys, id);
    expect(harness.services.cloudThumbnails.size).toBe(1);

    await harness.cloud.signOut();
    await harness.cloud.signUp(OTHER_EMAIL, ACCOUNT_PASSWORD);

    // The other account has no such object, so this fails -- and the point is what it leaves
    // behind, which is nothing.
    await expect(harness.services.cloudThumbnails.read(keys, id)).rejects.toBeInstanceOf(
      CloudError,
    );
    expect(harness.services.cloudThumbnails.size).toBe(0);
  });

  it('refuses to read with nobody signed in', async () => {
    const { harness, ids } = await backedUp(1);
    const keys = harness.services.session.requireKeys();
    await harness.cloud.signOut();

    await expect(harness.services.cloudThumbnails.read(keys, first(ids))).rejects.toBeInstanceOf(
      CloudError,
    );
  });
});

describe('a screenful of tiles arriving at once', () => {
  /**
   * A FlatList window mounts a whole screen of tiles in one pass. Twenty-five parallel downloads
   * is both rude and slower than four, because none of them finishes early enough to draw.
   */
  it('keeps no more than the cap in flight', async () => {
    const { harness } = await backedUp(1);
    const keys = harness.services.session.requireKeys();
    const held = deferred<Bytes>();
    const getBlob = jest.spyOn(harness.cloud, 'getBlob').mockReturnValue(held.promise);
    const thumbs = new CloudThumbnails({
      backup: () => harness.services.backup,
      uid: () => harness.cloud.currentUser?.uid ?? null,
      maxParallel: 4,
    });

    const reads = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) =>
      thumbs.read(keys, id).catch(() => undefined),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(getBlob).toHaveBeenCalledTimes(4);

    held.resolve(new Uint8Array(4));
    await Promise.all(reads);
    // The queued two were handed the slots as they came free, so every one was attempted.
    expect(getBlob).toHaveBeenCalledTimes(6);
  });
});
