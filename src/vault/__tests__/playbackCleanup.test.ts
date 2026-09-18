/**
 * The decrypted video file, and how little of its life it gets.
 *
 * This is the one place the vault puts plaintext on disk, so it is the one place where "we deleted
 * it afterwards" has to be demonstrated rather than asserted in a comment. The four exits are:
 * playback ending, the vault locking, the app being backgrounded, and the app having been killed
 * without any of the above (covered by wiping the directory on the next open).
 */
import { createServices } from '@/app/services';
import { KDF_PRESETS, SodiumSecureRandom } from '@/crypto';
import { InMemorySecureStore } from '@/secure-storage/secureStore';
import { InMemorySettingsStore } from '@/settings/appSettings';
import { InMemoryFileSystem } from '@/storage/inMemoryFileSystem';
import { SecureDelete } from '@/storage/secureDelete';
import { PLAYBACK_DIRECTORY_NAME, PlaybackScratch } from '@/vault/playbackScratch';
import { FakeThumbnailGenerator } from '@/vault/thumbnailGenerator';
import { FakeVideoThumbnailGenerator } from '@/vault/videoThumbnailGenerator';
import { bytesEqual, containsSequence, utf8Encode } from '@/utils/bytes';
import { FakeClock } from '@/utils/clock';

const random = new SodiumSecureRandom();
const PLAINTEXT = utf8Encode('ftypisom plaintext recording that must not survive');

function scratchOnly() {
  const fs = new InMemoryFileSystem();
  return {
    fs,
    scratch: new PlaybackScratch({ fs, secureDelete: new SecureDelete(fs), random }),
  };
}

describe('the playback scratch directory', () => {
  it('hands out unique paths inside its own directory, named after nothing', async () => {
    const { fs, scratch } = scratchOnly();
    const first = await scratch.allocate();
    const second = await scratch.allocate();

    expect(first).not.toBe(second);
    for (const uri of [first, second]) {
      expect(uri.startsWith(`${fs.cacheDirectory}/${PLAYBACK_DIRECTORY_NAME}/`)).toBe(true);
      // A random name, not the vault id: the listing must not say which items have been watched.
      expect(uri).toMatch(/\/[0-9a-f]{32}\.mp4$/);
    }
    expect(scratch.outstanding).toHaveLength(2);
  });

  it('overwrites the file before unlinking it when playback ends', async () => {
    const { fs, scratch } = scratchOnly();
    const uri = await scratch.allocate();
    await fs.writeBytes(uri, PLAINTEXT);
    // A handle on the stored buffer, which secure delete scribbles over in place.
    const stored = fs.peek(uri);
    if (stored === undefined) throw new Error('expected the file');

    await scratch.release(uri);

    expect(await fs.exists(uri)).toBe(false);
    expect(scratch.outstanding).toEqual([]);
    expect(bytesEqual(stored, PLAINTEXT)).toBe(false);
    expect(containsSequence(stored, utf8Encode('ftypisom'))).toBe(false);
  });

  it('wipes files a previous run never released', async () => {
    const { fs, scratch } = scratchOnly();
    // As if the app had been killed with a video on screen.
    const stranded = `${fs.cacheDirectory}/${PLAYBACK_DIRECTORY_NAME}/deadbeef.mp4`;
    await fs.writeBytes(stranded, PLAINTEXT);
    const stored = fs.peek(stranded);
    if (stored === undefined) throw new Error('expected the file');

    await scratch.purge();

    expect(await fs.exists(stranded)).toBe(false);
    expect(containsSequence(stored, utf8Encode('ftypisom'))).toBe(false);
  });

  it('never throws, so teardown cannot be blocked by it', async () => {
    const { scratch } = scratchOnly();
    await expect(scratch.purge()).resolves.toBeUndefined();
    // Releasing something that was never allocated, or already gone, is a no-op.
    await expect(scratch.release('file:///memory/cache/playback/missing.mp4')).resolves
      .toBeUndefined();
  });
});

describe('the vault lifecycle', () => {
  async function unlocked() {
    const fs = new InMemoryFileSystem();
    const services = createServices({
      fs,
      thumbnails: new FakeThumbnailGenerator(),
      videoThumbnails: new FakeVideoThumbnailGenerator(),
      clock: new FakeClock(),
      secureStore: new InMemorySecureStore(),
      settingsStore: new InMemorySettingsStore(),
      kdfParams: KDF_PRESETS.forTests,
    });
    const keys = await services.auth.setupPin('1234');
    services.session.adopt(keys);
    await services.vault.open(keys);
    return { fs, services };
  }

  it('wipes a decrypted video when the vault locks', async () => {
    const { fs, services } = await unlocked();
    const uri = await services.playbackScratch.allocate();
    await fs.writeBytes(uri, PLAINTEXT);
    const stored = fs.peek(uri);
    if (stored === undefined) throw new Error('expected the file');

    // Locking is the authority: nothing has to remember to clean up first.
    services.session.lock();
    // The lock listener closes the vault, which purges; give that microtask chain a turn.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(services.vault.current).toBeNull();
    expect(await fs.exists(uri)).toBe(false);
    expect(containsSequence(stored, utf8Encode('ftypisom'))).toBe(false);
  });

  it('wipes anything left over when the vault is opened again', async () => {
    const { fs, services } = await unlocked();
    const stranded = `${fs.cacheDirectory}/${PLAYBACK_DIRECTORY_NAME}/from-a-dead-process.mp4`;
    await fs.writeBytes(stranded, PLAINTEXT);

    const result = await services.auth.unlock('1234');
    if (result.kind !== 'success') throw new Error('expected the PIN to unlock');
    await services.vault.open(result.keys);

    expect(await fs.exists(stranded)).toBe(false);
  });

  it('empties the observable vault state before it finishes tidying up', async () => {
    const { services } = await unlocked();
    services.session.lock();
    // Not "eventually": a screen still mounted must never re-render against a live-looking vault.
    expect(services.vault.store.getState()).toEqual({
      photos: [],
      isOpen: false,
      unreadable: false,
    });
  });
});
