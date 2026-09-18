/**
 * Cloud backup of videos.
 *
 * A video is far too big to go through the buffer-based path, so it is uploaded from its blob file
 * and downloaded straight back to one. That is the only difference. These specs pin down that it
 * really is the only difference: what reaches the server is the identical ciphertext, byte for
 * byte, with no plaintext and no metadata alongside it; what comes back authenticates against the
 * vault's own keys before it is stored; and the restored video decrypts to the original recording.
 */
import {
  Argon2idKeyDerivation,
  KDF_PRESETS,
  SodiumKeyWrapping,
  SodiumSecureRandom,
  Ssv1FileCipher,
  SSV2,
  VaultKeyId,
  deriveVaultKeys,
  looksEncrypted,
} from '@/crypto';
import { Ssv2StreamCipher } from '@/crypto/streamCipher';
import { BackupService } from '@/backup/backupService';
import { BACKUP_PATHS } from '@/backup/types';
import { InMemoryCloudBackend } from '@/firebase/cloudBackend';
import { InMemoryFileSystem } from '@/storage/inMemoryFileSystem';
import { SecureDelete } from '@/storage/secureDelete';
import { EncryptedVaultRepository } from '@/vault/encryptedVaultRepository';
import { FakeThumbnailGenerator } from '@/vault/thumbnailGenerator';
import { FakeVideoThumbnailGenerator } from '@/vault/videoThumbnailGenerator';
import { VaultPaths } from '@/vault/vaultPaths';
import { bytesEqual, containsSequence, utf8Encode, type Bytes } from '@/utils/bytes';
import { FakeClock } from '@/utils/clock';

const random = new SodiumSecureRandom();
const PASSPHRASE = 'correct horse battery staple';
const MARKER = utf8Encode('ftypisom-silentsum-marker');
const CACHE = 'file:///memory/cache';

function recording(size = 6000): Bytes {
  const bytes = new Uint8Array(size);
  bytes.set(MARKER, 0);
  for (let i = MARKER.length; i < size; i++) bytes[i] = (i * 17 + 11) & 0xff;
  return bytes;
}

function vault(fs: InMemoryFileSystem, masterKey: Bytes) {
  const paths = new VaultPaths(fs.documentDirectory);
  return {
    paths,
    keys: deriveVaultKeys(masterKey),
    repository: new EncryptedVaultRepository({
      fs,
      paths,
      keys: deriveVaultKeys(masterKey),
      cipher: new Ssv1FileCipher(),
      streamCipher: new Ssv2StreamCipher({ fs, chunkExponent: 6 }),
      thumbnails: new FakeThumbnailGenerator(),
      videoThumbnails: new FakeVideoThumbnailGenerator(1920, 1080),
      secureDelete: new SecureDelete(fs),
      clock: new FakeClock(),
      random,
    }),
  };
}

function service(backend: InMemoryCloudBackend, fs: InMemoryFileSystem) {
  return new BackupService({
    backend,
    kdf: new Argon2idKeyDerivation(),
    wrapping: new SodiumKeyWrapping(),
    cipher: new Ssv1FileCipher(),
    streamCipher: new Ssv2StreamCipher({ fs, chunkExponent: 6 }),
    clock: new FakeClock(),
    random,
    fs,
    secureDelete: new SecureDelete(fs),
    kdfParams: KDF_PRESETS.forTests,
  });
}

function uidOf(backend: InMemoryCloudBackend): string {
  return backend.currentUser?.uid ?? '';
}

/** A vault holding one video and one photo, backed up to a signed-in in-memory cloud. */
async function backedUp() {
  const fs = new InMemoryFileSystem();
  const backend = new InMemoryCloudBackend(fs);
  await backend.signUp('owner@example.com', 'cloud-account-password');
  const uid = backend.currentUser?.uid ?? '';

  const masterKey = random.bytes(32);
  const { paths, keys, repository } = vault(fs, masterKey);
  await repository.open();

  const plain = recording();
  await fs.writeBytes(`${CACHE}/clip.mp4`, plain);
  const video = await repository.addVideo(
    { uri: `${CACHE}/clip.mp4`, durationMs: 4200 },
    { source: 'camera' },
  );
  const photoBytes = recording(900);
  const photo = await repository.addPhoto({ bytes: photoBytes }, { source: 'camera' });
  await fs.deleteFile(`${CACHE}/clip.mp4`);

  const backup = service(backend, fs);
  await backup.enable(keys, PASSPHRASE);
  const report = await backup.backupNow(repository, keys);

  return {
    fs,
    backend,
    uid,
    masterKey,
    paths,
    keys,
    repository,
    backup,
    video,
    photo,
    plain,
    report,
  };
}

describe('backing a video up to the cloud', () => {
  it('uploads the blob byte for byte, and only the blob', async () => {
    const { fs, backend, uid, paths, video, plain, report } = await backedUp();
    expect(report.uploaded).toBe(2);

    const uploaded = backend.blobs.get(BACKUP_PATHS.photo(uid, video.id));
    if (uploaded === undefined) throw new Error('the video was not uploaded');
    const onDisk = await fs.readBytes(paths.photoFile(video.id));
    expect(bytesEqual(uploaded, onDisk)).toBe(true);

    // ...and what was uploaded is ciphertext, in the chunked container, under the video key.
    expect(looksEncrypted(uploaded)).toBe(true);
    expect(uploaded[4]).toBe(SSV2.version);
    expect(uploaded[5]).toBe(VaultKeyId.video);
    expect(uploaded.length).toBe(
      SSV2.prefixLength + plain.length + 16 * Math.ceil(plain.length / 64),
    );
  });

  it('puts no plaintext, and no filename, anywhere the server can see', async () => {
    const { backend, plain, video } = await backedUp();

    for (const [path, blob] of backend.blobs) {
      expect(containsSequence(blob, MARKER)).toBe(false);
      expect(containsSequence(blob, plain.subarray(2000, 2100))).toBe(false);
      // Paths are hex ids under the owner's own prefix; nothing says "video" or "mp4".
      expect(path).toMatch(/^users\/uid_[0-9a-f]+\/(photos|thumbs)\/[0-9a-f]{32}\.enc$|index\.enc$/);
    }
    // The index itself is encrypted, so duration, dimensions and mime type never leave either.
    const index = backend.blobs.get(`users/${backend.currentUser?.uid ?? ''}/index.enc`);
    if (index === undefined) throw new Error('the index was not uploaded');
    expect(containsSequence(index, utf8Encode('video/mp4'))).toBe(false);
    expect(containsSequence(index, utf8Encode(video.id))).toBe(false);
    expect(containsSequence(index, utf8Encode('durationMs'))).toBe(false);

    // Documents carry ids and counts only -- never bytes.
    for (const document of backend.documents.values()) {
      expect(JSON.stringify(document)).not.toContain('ftypisom');
    }
  });

  it('restores into an empty vault and plays back identically', async () => {
    const { backend, masterKey, plain, video, photo } = await backedUp();

    // A second device: new storage, the same recovery passphrase, nothing local.
    const fresh = new InMemoryFileSystem();
    const restoreBackend = new InMemoryCloudBackend(fresh);
    // The fake mints uids from the e-mail, so the same account on a fresh device is the same uid.
    await restoreBackend.signUp('owner@example.com', 'cloud-account-password');
    for (const [path, blob] of backend.blobs) restoreBackend.blobs.set(path, blob);
    for (const [path, document] of backend.documents) restoreBackend.documents.set(path, document);

    const restore = service(restoreBackend, fresh);
    const recovered = await restore.recoverMasterKey(PASSPHRASE);
    expect(bytesEqual(recovered, masterKey)).toBe(true);

    const target = vault(fresh, recovered);
    await target.repository.open();
    const report = await restore.restoreInto(target.repository, target.keys);
    expect(report).toEqual({ restored: 2, skipped: 0 });

    // The metadata came back...
    const entry = target.repository.photos.find((p) => p.id === video.id);
    expect(entry?.mimeType).toBe('video/mp4');
    expect(entry?.durationMs).toBe(4200);
    expect(entry?.source).toBe('restore');
    expect([entry?.width, entry?.height]).toEqual([1920, 1080]);
    expect(target.repository.photos.map((p) => p.id).sort()).toEqual([photo.id, video.id].sort());

    // ...and so did the recording itself, byte for byte.
    await target.repository.readVideoToFile(video.id, `${CACHE}/played.mp4`);
    expect(bytesEqual(await fresh.readBytes(`${CACHE}/played.mp4`), plain)).toBe(true);

    // The download scratch file is not left behind as a second copy of the ciphertext.
    const strays = [...fresh.allFiles.keys()].filter((uri) => uri.includes('silentsum-restore'));
    expect(strays).toEqual([]);

    expect(bytesEqual(recovered, masterKey)).toBe(true);
    recovered.fill(0);
  });

  it('refuses a cloud object that was edited on the server', async () => {
    const { backend, uid, video } = await backedUp();

    const fresh = new InMemoryFileSystem();
    const restoreBackend = new InMemoryCloudBackend(fresh);
    // The fake mints uids from the e-mail, so the same account on a fresh device is the same uid.
    await restoreBackend.signUp('owner@example.com', 'cloud-account-password');
    for (const [path, blob] of backend.blobs) restoreBackend.blobs.set(path, blob);
    for (const [path, document] of backend.documents) restoreBackend.documents.set(path, document);

    // One byte, deep inside the payload, where an attacker with bucket access could reach.
    const object = restoreBackend.blobs.get(BACKUP_PATHS.photo(uid, video.id));
    if (object === undefined) throw new Error('the video was not uploaded');
    const tampered = Uint8Array.from(object);
    const at = SSV2.prefixLength + 100;
    tampered[at] = (tampered[at] ?? 0) ^ 0x01;
    restoreBackend.blobs.set(BACKUP_PATHS.photo(uid, video.id), tampered);

    const restore = service(restoreBackend, fresh);
    const recovered = await restore.recoverMasterKey(PASSPHRASE);
    const target = vault(fresh, recovered);
    await target.repository.open();

    await expect(restore.restoreInto(target.repository, target.keys)).rejects.toThrow();
    // It was rejected BEFORE being stored: the vault has no video, and no stray download.
    expect(target.repository.photos.some((p) => p.id === video.id)).toBe(false);
    expect(
      [...fresh.allFiles.keys()].filter((uri) => uri.includes('silentsum-restore')),
    ).toEqual([]);
    recovered.fill(0);
  });

  /**
   * A backup whose master key is not the vault's -- the ordinary state after an erase and
   * re-create. The chunked path is the one that cannot simply be re-encrypted in a buffer, so it
   * goes down to a file, is decrypted with the backup's key, re-encrypted with the vault's, and
   * only then handed over. This spec is mostly about what is left behind: a plaintext video in
   * the cache would undo the entire point of the vault.
   */
  it('re-encrypts a foreign-key backup into this vault, video and all', async () => {
    const { backend, plain, video, photo } = await backedUp();

    const fresh = new InMemoryFileSystem();
    const restoreBackend = new InMemoryCloudBackend(fresh);
    await restoreBackend.signUp('owner@example.com', 'cloud-account-password');
    for (const [path, blob] of backend.blobs) restoreBackend.blobs.set(path, blob);
    for (const [path, document] of backend.documents) restoreBackend.documents.set(path, document);

    // A vault with its OWN master key, unrelated to the one the backup was made under.
    const restore = service(restoreBackend, fresh);
    const target = vault(fresh, random.bytes(32));
    await target.repository.open();
    const recovered = await restore.recoverMasterKey(PASSPHRASE);
    expect(bytesEqual(recovered, target.keys.masterKey)).toBe(false);

    const report = await restore.restoreForeignInto(target.repository, target.keys, recovered);
    expect(report).toEqual({ restored: 2, skipped: 0 });
    recovered.fill(0);

    // Both came back with their ids and metadata, readable under THIS vault's keys.
    const entry = target.repository.photos.find((p) => p.id === video.id);
    expect(entry?.durationMs).toBe(4200);
    await target.repository.readVideoToFile(video.id, `${CACHE}/played.mp4`);
    expect(bytesEqual(await fresh.readBytes(`${CACHE}/played.mp4`), plain)).toBe(true);
    expect(bytesEqual(await target.repository.readFullImage(photo.id), recording(900))).toBe(true);

    // The stored ciphertext is under the NEW key, so the old one is genuinely gone from it.
    const stored = await fresh.readBytes(target.paths.photoFile(video.id));
    expect(bytesEqual(stored, backend.blobs.get(BACKUP_PATHS.photo(uidOf(backend), video.id)) ?? stored)).toBe(false);

    // And the scratch files -- including the plaintext middle step -- were all cleaned up.
    expect([...fresh.allFiles.keys()].filter((uri) => uri.includes('silentsum-restore'))).toEqual(
      [],
    );
  });

  it('keeps the cloud copy when the video is deleted locally, and keeps it restorable', async () => {
    const { backend, uid, keys, repository, backup, video } = await backedUp();

    await repository.deletePhotos([video.id]);
    const report = await backup.backupNow(repository, keys);

    // Deleting on the phone no longer reaches the cloud: the backup is the copy you still have
    // after a mistake, and a mirror of a mistake is not a backup. Only `disable()` removes it.
    expect(report.cloudOnly).toBe(1);
    expect(backend.blobs.has(BACKUP_PATHS.photo(uid, video.id))).toBe(true);
    expect(backend.blobs.has(BACKUP_PATHS.thumb(uid, video.id))).toBe(true);

    // And it is still REACHABLE: the uploaded index kept the entry, so a restore finds it. A blob
    // the index has forgotten is worse than a deleted one, because it looks like safety.
    const restored = await backup.restoreInto(repository, keys);
    expect(restored.restored).toBe(1);
    expect(repository.photos.some((photo) => photo.id === video.id)).toBe(true);
  });

  it('wipes every trace of the account when backup is turned off', async () => {
    const { backend, backup } = await backedUp();
    await backup.disable();
    expect([...backend.blobs.keys()]).toEqual([]);
    expect([...backend.documents.keys()]).toEqual([]);
  });
});
