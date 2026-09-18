import {
  Ssv1FileCipher,
  SodiumSecureRandom,
  VaultKeyId,
  deriveVaultKeys,
  looksEncrypted,
} from '@/crypto';
import { InMemoryFileSystem } from '@/storage/inMemoryFileSystem';
import { SecureDelete } from '@/storage/secureDelete';
import { Ssv2StreamCipher } from '@/crypto/streamCipher';
import { EncryptedVaultRepository } from '@/vault/encryptedVaultRepository';
import { FakeThumbnailGenerator } from '@/vault/thumbnailGenerator';
import { FakeVideoThumbnailGenerator } from '@/vault/videoThumbnailGenerator';
import { VaultPaths } from '@/vault/vaultPaths';
import { RepositoryNotOpenError, VaultDataUnreadableError, type PhotoEntry } from '@/vault/types';
import { bytesEqual, containsSequence, utf8Encode, type Bytes } from '@/utils/bytes';
import { FakeClock } from '@/utils/clock';

const random = new SodiumSecureRandom();

function makeImage(marker: string, size = 2048): Bytes {
  const bytes = random.bytes(size);
  bytes.set(utf8Encode(marker), 0);
  return bytes;
}

function build(masterKey: Bytes = random.bytes(32)) {
  const fs = new InMemoryFileSystem();
  const paths = new VaultPaths(fs.documentDirectory);
  const keys = deriveVaultKeys(masterKey);
  const clock = new FakeClock();
  const secureDelete = new SecureDelete(fs);
  const thumbnails = new FakeThumbnailGenerator();
  const repository = new EncryptedVaultRepository({
    fs,
    paths,
    keys,
    cipher: new Ssv1FileCipher(),
    streamCipher: new Ssv2StreamCipher({ fs, chunkExponent: 10 }),
    thumbnails,
    videoThumbnails: new FakeVideoThumbnailGenerator(),
    secureDelete,
    clock,
    random,
  });
  return { fs, paths, keys, clock, repository, thumbnails, masterKey };
}

async function opened(masterKey?: Bytes) {
  const context = build(masterKey);
  await context.repository.open();
  return context;
}

describe('EncryptedVaultRepository storage', () => {
  it('stores photos as SSV1 ciphertext with no plaintext anywhere on disk', async () => {
    const { repository, fs, paths } = await opened();
    const image = makeImage('PLAINTEXT-MARKER');

    const entry = await repository.addPhoto({ bytes: image }, { source: 'camera' });

    const photoBlob = await fs.readBytes(paths.photoFile(entry.id));
    const thumbBlob = await fs.readBytes(paths.thumbFile(entry.id));
    const indexBlob = await fs.readBytes(paths.index);

    for (const blob of [photoBlob, thumbBlob, indexBlob]) {
      expect(looksEncrypted(blob)).toBe(true);
    }
    expect(photoBlob[5]).toBe(VaultKeyId.photo);
    expect(thumbBlob[5]).toBe(VaultKeyId.thumb);
    expect(indexBlob[5]).toBe(VaultKeyId.manifest);

    for (const [, stored] of fs.allFiles) {
      expect(containsSequence(stored, image)).toBe(false);
      expect(containsSequence(stored, utf8Encode('PLAINTEXT-MARKER'))).toBe(false);
    }
  });

  it('never writes outside the vault directory', async () => {
    const { repository, fs, paths } = await opened();
    await repository.addPhoto({ bytes: makeImage('a') }, { source: 'camera' });

    for (const uri of fs.allFiles.keys()) {
      expect(uri.startsWith(paths.root)).toBe(true);
    }
  });

  it('round-trips the image and the thumbnail', async () => {
    const { repository } = await opened();
    const image = makeImage('round-trip');

    const entry = await repository.addPhoto({ bytes: image }, { source: 'import' });

    expect(bytesEqual(await repository.readFullImage(entry.id), image)).toBe(true);
    expect((await repository.readThumbnail(entry.id)).length).toBeGreaterThan(0);
  });

  it('records metadata from the thumbnail pipeline and the caller', async () => {
    const { repository, clock } = await opened();
    const image = makeImage('meta', 4096);

    const entry = await repository.addPhoto(
      { bytes: image },
      { source: 'import', originalName: 'holiday.jpg', mimeType: 'image/png' },
    );

    expect(entry).toMatchObject({
      width: 1200,
      height: 900,
      sizeBytes: 4096,
      source: 'import',
      originalName: 'holiday.jpg',
      mimeType: 'image/png',
      createdAt: clock.now(),
    });
    expect(entry.id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('survives a reopen with the same keys and refuses different keys', async () => {
    const master = random.bytes(32);
    const first = await opened(master);
    const entry = await first.repository.addPhoto({ bytes: makeImage('persist') }, { source: 'camera' });

    // Same files, same keys: the index decrypts.
    const reopened = new EncryptedVaultRepository({
      fs: first.fs,
      paths: first.paths,
      keys: deriveVaultKeys(master),
      cipher: new Ssv1FileCipher(),
      streamCipher: new Ssv2StreamCipher({ fs: first.fs, chunkExponent: 10 }),
      thumbnails: new FakeThumbnailGenerator(),
      videoThumbnails: new FakeVideoThumbnailGenerator(),
      secureDelete: new SecureDelete(first.fs),
      clock: new FakeClock(),
      random,
    });
    await reopened.open();
    expect(reopened.photos.map((p) => p.id)).toEqual([entry.id]);

    // Different keys: fail closed, do not silently start an empty vault.
    const foreign = new EncryptedVaultRepository({
      fs: first.fs,
      paths: first.paths,
      keys: deriveVaultKeys(random.bytes(32)),
      cipher: new Ssv1FileCipher(),
      streamCipher: new Ssv2StreamCipher({ fs: first.fs, chunkExponent: 10 }),
      thumbnails: new FakeThumbnailGenerator(),
      videoThumbnails: new FakeVideoThumbnailGenerator(),
      secureDelete: new SecureDelete(first.fs),
      clock: new FakeClock(),
      random,
    });
    await expect(foreign.open()).rejects.toThrow(VaultDataUnreadableError);
  });
});

describe('EncryptedVaultRepository listing', () => {
  it('keeps photos newest first and notifies watchers on every change', async () => {
    const { repository, clock } = await opened();
    const seen: string[][] = [];
    const unsubscribe = repository.watchPhotos((photos) => {
      seen.push(photos.map((p) => p.id));
    });

    const first = await repository.addPhoto({ bytes: makeImage('1') }, { source: 'camera' });
    clock.advance(1000);
    const second = await repository.addPhoto({ bytes: makeImage('2') }, { source: 'camera' });

    expect(repository.photos.map((p) => p.id)).toEqual([second.id, first.id]);
    expect(seen[0]).toEqual([]);
    expect(seen.at(-1)).toEqual([second.id, first.id]);

    unsubscribe();
    await repository.addPhoto({ bytes: makeImage('3') }, { source: 'camera' });
    expect(seen.at(-1)).toEqual([second.id, first.id]);
  });

  it('does not lose entries when photos are added concurrently', async () => {
    const { repository } = await opened();

    const entries = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        repository.addPhoto({ bytes: makeImage(`concurrent-${String(i)}`) }, { source: 'camera' }),
      ),
    );

    const stored = new Set(repository.photos.map((p) => p.id));
    expect(stored.size).toBe(8);
    for (const entry of entries) expect(stored.has(entry.id)).toBe(true);
  });
});

describe('EncryptedVaultRepository deletion', () => {
  it('removes the entry, overwrites the blobs and unlinks them', async () => {
    const { repository, fs, paths } = await opened();
    const image = makeImage('to-be-deleted');
    const entry = await repository.addPhoto({ bytes: image }, { source: 'camera' });
    const before = await fs.readBytes(paths.photoFile(entry.id));

    await repository.deletePhotos([entry.id]);

    expect(repository.photos).toHaveLength(0);
    expect(await fs.exists(paths.photoFile(entry.id))).toBe(false);
    expect(await fs.exists(paths.thumbFile(entry.id))).toBe(false);
    // And the ciphertext that was there is not recoverable from the fake disk either.
    for (const [, stored] of fs.allFiles) {
      expect(containsSequence(stored, before)).toBe(false);
    }
  });

  it('ignores an empty selection and unknown ids', async () => {
    const { repository } = await opened();
    const entry = await repository.addPhoto({ bytes: makeImage('keep') }, { source: 'camera' });

    await repository.deletePhotos([]);
    await repository.deletePhotos(['ffffffffffffffffffffffffffffffff']);

    expect(repository.photos.map((p) => p.id)).toEqual([entry.id]);
  });

});

describe('EncryptedVaultRepository backup interoperation', () => {
  it('hands out ciphertext unchanged and accepts it back', async () => {
    const master = random.bytes(32);
    const source = await opened(master);
    const image = makeImage('backed-up');
    const entry = await source.repository.addPhoto({ bytes: image }, { source: 'camera' });

    const photoBlob = await source.repository.readEncryptedPhoto(entry.id);
    const thumbBlob = await source.repository.readEncryptedThumbnail(entry.id);
    expect(await source.repository.readEncryptedIndex()).not.toBeNull();

    // A different device, same master key recovered from the envelope.
    const target = await opened(master);
    await target.repository.importEncrypted({ entry, photoBlob, thumbnailBlob: thumbBlob });

    expect(target.repository.photos.map((p) => p.id)).toEqual([entry.id]);
    expect(target.repository.photos[0]?.source).toBe('restore');
    expect(bytesEqual(await target.repository.readFullImage(entry.id), image)).toBe(true);
  });

  it('rejects blobs that do not authenticate under this vault, before writing anything', async () => {
    const source = await opened();
    const entry = await source.repository.addPhoto({ bytes: makeImage('x') }, { source: 'camera' });
    const photoBlob = await source.repository.readEncryptedPhoto(entry.id);
    const thumbBlob = await source.repository.readEncryptedThumbnail(entry.id);

    const foreign = await opened();
    await expect(
      foreign.repository.importEncrypted({ entry, photoBlob, thumbnailBlob: thumbBlob }),
    ).rejects.toThrow();

    expect(foreign.repository.photos).toHaveLength(0);
    expect(await foreign.fs.exists(foreign.paths.photoFile(entry.id))).toBe(false);
  });

  it('replaces an existing entry rather than duplicating it', async () => {
    const master = random.bytes(32);
    const context = await opened(master);
    const entry = await context.repository.addPhoto({ bytes: makeImage('dup') }, { source: 'camera' });
    const photoBlob = await context.repository.readEncryptedPhoto(entry.id);
    const thumbBlob = await context.repository.readEncryptedThumbnail(entry.id);

    await context.repository.importEncrypted({ entry, photoBlob, thumbnailBlob: thumbBlob });

    expect(context.repository.photos).toHaveLength(1);
  });
});

describe('EncryptedVaultRepository failing closed', () => {
  it('refuses every operation before open()', async () => {
    const { repository } = build();
    const image = makeImage('nope');
    await expect(repository.addPhoto({ bytes: image }, { source: 'camera' })).rejects.toThrow(
      RepositoryNotOpenError,
    );
    await expect(repository.readThumbnail('a'.repeat(32))).rejects.toThrow(RepositoryNotOpenError);
  });

  it('refuses every operation once the session keys are disposed', async () => {
    const { repository, keys } = await opened();
    const entry = await repository.addPhoto({ bytes: makeImage('locked') }, { source: 'camera' });

    keys.dispose();

    await expect(repository.readFullImage(entry.id)).rejects.toThrow();
    await expect(
      repository.addPhoto({ bytes: makeImage('after-lock') }, { source: 'camera' }),
    ).rejects.toThrow();
  });

  it('leaves no orphan blob when the index write fails', async () => {
    const { repository, fs, paths } = await opened();
    const spy = jest.spyOn(fs, 'move');
    // Let the photo and thumbnail moves succeed, fail the index move.
    spy.mockImplementation(async function (this: unknown, from: string, to: string) {
      if (to === paths.index) throw new Error('disk full');
      return InMemoryFileSystem.prototype.move.call(fs, from, to);
    });

    await expect(
      repository.addPhoto({ bytes: makeImage('orphan') }, { source: 'camera' }),
    ).rejects.toThrow('disk full');
    spy.mockRestore();

    const photoFiles = await fs.list(paths.photos);
    expect(photoFiles).toHaveLength(0);
    expect(repository.photos).toHaveLength(0);
  });

  it('keeps working after one mutation fails', async () => {
    const { repository, thumbnails } = await opened();
    thumbnails.failOnNextCall = true;

    await expect(
      repository.addPhoto({ bytes: makeImage('bad') }, { source: 'import' }),
    ).rejects.toThrow();

    const good: PhotoEntry = await repository.addPhoto(
      { bytes: makeImage('good') },
      { source: 'import' },
    );
    expect(repository.photos.map((p) => p.id)).toEqual([good.id]);
  });
});
