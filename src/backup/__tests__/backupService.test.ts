import { BackupService } from '@/backup/backupService';
import { envelopeFromJson } from '@/backup/backupEnvelope';
import {
  AccountDataRemainsError,
  BACKUP_PATHS,
  BackupNotEnabledError,
  ForeignBackupError,
  InvalidPassphraseError,
  WrongPassphraseError,
} from '@/backup/types';
import {
  Argon2idKeyDerivation,
  KDF_PRESETS,
  SodiumKeyWrapping,
  SodiumSecureRandom,
  RecordFormatError,
  Ssv1FileCipher,
  WrongKeyError,
  deriveVaultKeys,
  looksEncrypted,
} from '@/crypto';
import { CloudError } from '@/firebase/types';
import { InMemoryCloudBackend } from '@/firebase/cloudBackend';
import type { FileSystem } from '@/storage/fileSystem';
import { InMemoryFileSystem } from '@/storage/inMemoryFileSystem';
import { SecureDelete } from '@/storage/secureDelete';
import { Ssv2StreamCipher } from '@/crypto/streamCipher';
import { EncryptedVaultRepository } from '@/vault/encryptedVaultRepository';
import { FakeVideoThumbnailGenerator } from '@/vault/videoThumbnailGenerator';
import { FakeThumbnailGenerator } from '@/vault/thumbnailGenerator';
import { VaultPaths } from '@/vault/vaultPaths';
import type { VaultRepository } from '@/vault/types';
import { base64Decode } from '@/utils/base64';
import { containsSequence, toHex, utf8Encode, type Bytes } from '@/utils/bytes';
import { FakeClock } from '@/utils/clock';

const random = new SodiumSecureRandom();
const PASSPHRASE = 'correct horse battery staple';

function makeImage(marker: string): Bytes {
  const bytes = random.bytes(1024);
  bytes.set(utf8Encode(marker), 0);
  return bytes;
}

async function makeVault(masterKey: Bytes) {
  const fs = new InMemoryFileSystem();
  const paths = new VaultPaths(fs.documentDirectory);
  const keys = deriveVaultKeys(masterKey);
  const repository: VaultRepository = new EncryptedVaultRepository({
    fs,
    paths,
    keys,
    cipher: new Ssv1FileCipher(),
    streamCipher: new Ssv2StreamCipher({ fs, chunkExponent: 10 }),
    thumbnails: new FakeThumbnailGenerator(),
    videoThumbnails: new FakeVideoThumbnailGenerator(),
    secureDelete: new SecureDelete(fs),
    clock: new FakeClock(),
    random,
  });
  await repository.open();
  return { fs, paths, keys, repository };
}

function makeService(backend: InMemoryCloudBackend, fs: FileSystem = new InMemoryFileSystem()) {
  return new BackupService({
    backend,
    kdf: new Argon2idKeyDerivation(),
    wrapping: new SodiumKeyWrapping(),
    cipher: new Ssv1FileCipher(),
    streamCipher: new Ssv2StreamCipher({ fs, chunkExponent: 10 }),
    clock: new FakeClock(),
    random,
    fs,
    secureDelete: new SecureDelete(fs),
    kdfParams: KDF_PRESETS.forTests,
  });
}

async function signedInBackend() {
  const backend = new InMemoryCloudBackend();
  await backend.signUp('owner@example.com', 'cloud-account-password');
  return backend;
}

describe('BackupService enabling', () => {
  it('stores only a passphrase-wrapped envelope, never the master key', async () => {
    const master = random.bytes(32);
    const { keys } = await makeVault(master);
    const backend = await signedInBackend();
    const service = makeService(backend);

    await service.enable(keys, PASSPHRASE);

    const uid = backend.currentUser?.uid ?? '';
    const document = await backend.getDocument(BACKUP_PATHS.envelope(uid));
    expect(document).not.toBeNull();

    const serialised = JSON.stringify(document);
    expect(serialised).not.toContain(PASSPHRASE);
    expect(serialised).not.toContain(toHex(master));

    const envelope = envelopeFromJson(document);
    expect(envelope.version).toBe(1);
    expect(envelope.salt).toHaveLength(16);
    expect(envelope.wrappedMasterKey.cipherText).toHaveLength(32);
    expect(containsSequence(envelope.wrappedMasterKey.cipherText, master)).toBe(false);
  });

  it('rejects a weak passphrase before touching the network', async () => {
    const { keys } = await makeVault(random.bytes(32));
    const backend = await signedInBackend();
    const service = makeService(backend);
    const spy = jest.spyOn(backend, 'putDocument');

    await expect(service.enable(keys, 'short')).rejects.toThrow(InvalidPassphraseError);
    await expect(service.enable(keys, '  padded passphrase  ')).rejects.toThrow(
      InvalidPassphraseError,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses to do anything while signed out', async () => {
    const { keys, repository } = await makeVault(random.bytes(32));
    const service = makeService(new InMemoryCloudBackend());

    await expect(service.enable(keys, PASSPHRASE)).rejects.toThrow(CloudError);
    await expect(service.backupNow(repository, keys)).rejects.toThrow(CloudError);
    await expect(service.hasEnvelope()).rejects.toThrow(CloudError);
  });

  it('will not back up before the envelope exists', async () => {
    const { keys, repository } = await makeVault(random.bytes(32));
    const service = makeService(await signedInBackend());
    await expect(service.backupNow(repository, keys)).rejects.toThrow(BackupNotEnabledError);
  });
});

describe('BackupService uploading', () => {
  it('uploads ciphertext only, byte-identical to what is on disk', async () => {
    const master = random.bytes(32);
    const { keys, repository } = await makeVault(master);
    const image = makeImage('SECRET-PIXELS');
    const entry = await repository.addPhoto({ bytes: image }, { source: 'camera' });

    const backend = await signedInBackend();
    const service = makeService(backend);
    await service.enable(keys, PASSPHRASE);

    const report = await service.backupNow(repository, keys);
    expect(report).toEqual({ uploaded: 1, cloudOnly: 0, total: 1 });

    const uid = backend.currentUser?.uid ?? '';
    const uploaded = await backend.getBlob(BACKUP_PATHS.photo(uid, entry.id));
    expect(looksEncrypted(uploaded)).toBe(true);
    expect(toHex(uploaded)).toBe(toHex(await repository.readEncryptedPhoto(entry.id)));

    for (const [, blob] of backend.blobs) {
      expect(containsSequence(blob, image)).toBe(false);
      expect(containsSequence(blob, utf8Encode('SECRET-PIXELS'))).toBe(false);
    }
  });

  it('only uploads what is missing on a second run', async () => {
    const { keys, repository } = await makeVault(random.bytes(32));
    await repository.addPhoto({ bytes: makeImage('a') }, { source: 'camera' });
    const service = makeService(await signedInBackend());
    await service.enable(keys, PASSPHRASE);

    expect((await service.backupNow(repository, keys)).uploaded).toBe(1);
    expect(await service.backupNow(repository, keys)).toEqual({
      uploaded: 0,
      cloudOnly: 0,
      total: 1,
    });

    await repository.addPhoto({ bytes: makeImage('b') }, { source: 'camera' });
    expect(await service.backupNow(repository, keys)).toEqual({
      uploaded: 1,
      cloudOnly: 0,
      total: 2,
    });
  });

  /**
   * The backup deliberately does NOT mirror local deletions any more.
   *
   * It used to, so that a photo removed on purpose could not be resurrected. The phone is the copy
   * that gets lost, stolen, wiped or mis-tapped though, and a backup that faithfully reproduces an
   * accidental deletion has failed at its only job. `disable()` is now the one way to remove
   * anything from the cloud, and it is explicit, confirmed and total.
   */
  it('keeps a photo deleted locally, and keeps it in the index so it can be restored', async () => {
    const { keys, repository } = await makeVault(random.bytes(32));
    const kept = await repository.addPhoto({ bytes: makeImage('kept') }, { source: 'camera' });
    const gone = await repository.addPhoto({ bytes: makeImage('gone') }, { source: 'camera' });
    const backend = await signedInBackend();
    const service = makeService(backend);
    await service.enable(keys, PASSPHRASE);
    await service.backupNow(repository, keys);

    await repository.deletePhotos([gone.id]);
    const report = await service.backupNow(repository, keys);

    expect(report).toEqual({ uploaded: 0, cloudOnly: 1, total: 2 });
    const uid = backend.currentUser?.uid ?? '';
    await expect(backend.getBlob(BACKUP_PATHS.photo(uid, gone.id))).resolves.toBeDefined();

    // The index was merged rather than replaced, so the kept blob is still reachable. Without the
    // merge it would be an orphan: present, paid for, and invisible to every restore.
    expect(await service.restoreInto(repository, keys)).toEqual({ restored: 1, skipped: 1 });
    expect(new Set(repository.photos.map((p) => p.id))).toEqual(new Set([kept.id, gone.id]));
  });

  /**
   * A vault that was erased and set up again shares the account but not the key. Backing up from
   * it must refuse -- uploading its index would leave the other vault's blobs unreachable -- and it
   * must refuse in a way the screen can explain, because this is an ordinary situation with an
   * ordinary fix ("Restore from backup"), not a malfunction.
   */
  it('refuses to back up into an account whose backup belongs to another vault', async () => {
    const backend = await signedInBackend();
    const service = makeService(backend);
    const first = await makeVault(random.bytes(32));
    await first.repository.addPhoto({ bytes: makeImage('theirs') }, { source: 'camera' });
    await service.enable(first.keys, PASSPHRASE);
    await service.backupNow(first.repository, first.keys);
    const before = new Map(backend.blobs);

    const second = await makeVault(random.bytes(32));
    await second.repository.addPhoto({ bytes: makeImage('mine') }, { source: 'camera' });

    await expect(service.backupNow(second.repository, second.keys)).rejects.toThrow(
      ForeignBackupError,
    );
    // The other vault's index is untouched, which is the entire reason for refusing.
    const uid = backend.currentUser?.uid ?? '';
    expect(toHex(await backend.getBlob(BACKUP_PATHS.index(uid)))).toBe(
      toHex(before.get(BACKUP_PATHS.index(uid)) ?? new Uint8Array()),
    );
  });

  it('does not strand the cloud index when a device with fewer photos uploads', async () => {
    const master = random.bytes(32);
    const first = await makeVault(master);
    const shared = await first.repository.addPhoto(
      { bytes: makeImage('shared') },
      { source: 'camera' },
    );
    const backend = await signedInBackend();
    const service = makeService(backend);
    await service.enable(first.keys, PASSPHRASE);
    await service.backupNow(first.repository, first.keys);

    // A second device on the same vault that never saw `shared`, uploading something of its own.
    const second = await makeVault(master);
    const fresh = await second.repository.addPhoto(
      { bytes: makeImage('fresh') },
      { source: 'camera' },
    );
    const report = await service.backupNow(second.repository, second.keys);

    expect(report).toEqual({ uploaded: 1, cloudOnly: 1, total: 2 });
    const target = await makeVault(master);
    expect(await service.restoreInto(target.repository, target.keys)).toEqual({
      restored: 2,
      skipped: 0,
    });
    expect(new Set(target.repository.photos.map((p) => p.id))).toEqual(
      new Set([shared.id, fresh.id]),
    );
  });

  it('keeps every object under the signed-in account prefix', async () => {
    const { keys, repository } = await makeVault(random.bytes(32));
    await repository.addPhoto({ bytes: makeImage('scope') }, { source: 'camera' });
    const backend = await signedInBackend();
    const service = makeService(backend);
    await service.enable(keys, PASSPHRASE);
    await service.backupNow(repository, keys);

    const uid = backend.currentUser?.uid ?? '';
    for (const path of [...backend.blobs.keys(), ...backend.documents.keys()]) {
      expect(path.startsWith(`users/${uid}/`)).toBe(true);
    }
  });
});

describe('BackupService recovery', () => {
  it('recovers the master key with the passphrase and rejects any other', async () => {
    const master = random.bytes(32);
    const { keys } = await makeVault(master);
    const service = makeService(await signedInBackend());
    await service.enable(keys, PASSPHRASE);

    expect(toHex(await service.recoverMasterKey(PASSPHRASE))).toBe(toHex(master));
    await expect(service.recoverMasterKey('a different passphrase')).rejects.toThrow(
      WrongPassphraseError,
    );
  });

  it('restores every photo onto a fresh device', async () => {
    const master = random.bytes(32);
    const source = await makeVault(master);
    const first = await source.repository.addPhoto({ bytes: makeImage('one') }, { source: 'camera' });
    const second = await source.repository.addPhoto({ bytes: makeImage('two') }, { source: 'import' });

    const backend = await signedInBackend();
    const service = makeService(backend);
    await service.enable(source.keys, PASSPHRASE);
    await service.backupNow(source.repository, source.keys);

    // A new device: recover the key, then rebuild the vault from ciphertext.
    const recovered = await service.recoverMasterKey(PASSPHRASE);
    const target = await makeVault(recovered);
    const report = await service.restoreInto(target.repository, target.keys);

    expect(report).toEqual({ restored: 2, skipped: 0 });
    expect(new Set(target.repository.photos.map((p) => p.id))).toEqual(
      new Set([first.id, second.id]),
    );
    expect(target.repository.photos.every((p) => p.source === 'restore')).toBe(true);
  });

  it('skips photos already present and reports an empty backup', async () => {
    const master = random.bytes(32);
    const source = await makeVault(master);
    await source.repository.addPhoto({ bytes: makeImage('dup') }, { source: 'camera' });
    const service = makeService(await signedInBackend());
    await service.enable(source.keys, PASSPHRASE);
    await service.backupNow(source.repository, source.keys);

    // Restoring into the same vault finds everything already there.
    expect(await service.restoreInto(source.repository, source.keys)).toEqual({
      restored: 0,
      skipped: 1,
    });
  });

  it('returns an empty report when nothing was ever uploaded', async () => {
    const master = random.bytes(32);
    const { keys, repository } = await makeVault(master);
    const service = makeService(await signedInBackend());
    await service.enable(keys, PASSPHRASE);

    expect(await service.restoreInto(repository, keys)).toEqual({ restored: 0, skipped: 0 });
  });

  it('skips an object that disappeared from the cloud rather than failing the whole restore', async () => {
    const master = random.bytes(32);
    const source = await makeVault(master);
    const kept = await source.repository.addPhoto({ bytes: makeImage('kept') }, { source: 'camera' });
    const lost = await source.repository.addPhoto({ bytes: makeImage('lost') }, { source: 'camera' });

    const backend = await signedInBackend();
    const service = makeService(backend);
    await service.enable(source.keys, PASSPHRASE);
    await service.backupNow(source.repository, source.keys);

    const uid = backend.currentUser?.uid ?? '';
    await backend.deleteBlob(BACKUP_PATHS.photo(uid, lost.id));

    const target = await makeVault(master);
    const report = await service.restoreInto(target.repository, target.keys);

    expect(report).toEqual({ restored: 1, skipped: 1 });
    expect(target.repository.photos.map((p) => p.id)).toEqual([kept.id]);
  });
});

describe('BackupService disabling', () => {
  it('removes every object and document for the account', async () => {
    const { keys, repository } = await makeVault(random.bytes(32));
    await repository.addPhoto({ bytes: makeImage('bye') }, { source: 'camera' });
    const backend = await signedInBackend();
    const service = makeService(backend);
    await service.enable(keys, PASSPHRASE);
    await service.backupNow(repository, keys);

    await service.disable();

    expect(backend.blobs.size).toBe(0);
    expect(backend.documents.size).toBe(0);
    expect(await service.hasEnvelope()).toBe(false);
  });

  it('leaves the local vault completely intact', async () => {
    const { keys, repository } = await makeVault(random.bytes(32));
    const entry = await repository.addPhoto({ bytes: makeImage('local') }, { source: 'camera' });
    const service = makeService(await signedInBackend());
    await service.enable(keys, PASSPHRASE);
    await service.backupNow(repository, keys);

    await service.disable();

    expect(repository.photos.map((p) => p.id)).toEqual([entry.id]);
    await expect(repository.readFullImage(entry.id)).resolves.toBeDefined();
  });
});

/**
 * Purging an account before its credential is deleted.
 *
 * These assert the two properties the account-deletion flow leans on: the sweep finds blobs the
 * index never mentions, and the verification refuses to report success while anything survives.
 */
describe('BackupService purgeAccount', () => {
  it('removes blobs the index does not know about', async () => {
    const master = random.bytes(32);
    const { repository, keys } = await makeVault(master);
    await repository.addPhoto({ bytes: makeImage('kept') }, { source: 'camera' });
    const backend = await signedInBackend();
    const service = makeService(backend);
    await service.enable(keys, PASSPHRASE);
    await service.backupNow(repository, keys);

    const uid = backend.currentUser?.uid ?? '';
    // An orphan: bytes filed under the account that no index entry points at. A name-driven delete
    // would walk straight past it, and nobody could ever remove it once the account was gone.
    backend.blobs.set(BACKUP_PATHS.photo(uid, 'deadbeefdeadbeefdeadbeefdeadbeef'), random.bytes(32));
    expect(backend.blobs.size).toBeGreaterThan(1);

    await service.purgeAccount();

    expect(backend.blobs.size).toBe(0);
    expect(backend.documents.size).toBe(0);
  });

  it('refuses to report success while a blob survives, and keeps the account usable', async () => {
    const master = random.bytes(32);
    const { repository, keys } = await makeVault(master);
    await repository.addPhoto({ bytes: makeImage('kept') }, { source: 'camera' });
    const backend = await signedInBackend();
    const service = makeService(backend);
    await service.enable(keys, PASSPHRASE);
    await service.backupNow(repository, keys);

    const uid = backend.currentUser?.uid ?? '';
    const survivor = BACKUP_PATHS.photo(uid, 'deadbeefdeadbeefdeadbeefdeadbeef');
    // A delete that quietly does nothing is exactly the failure this check exists to catch.
    jest.spyOn(backend, 'deleteBlob').mockImplementation(async (path: string) => {
      if (path !== survivor) backend.blobs.delete(path);
    });
    backend.blobs.set(survivor, random.bytes(32));

    await expect(service.purgeAccount()).rejects.toThrow(AccountDataRemainsError);
    expect(backend.currentUser).not.toBeNull();
    expect(backend.blobs.has(survivor)).toBe(true);
  });

  it('empties an account that has a backup, documents and all', async () => {
    const master = random.bytes(32);
    const { repository, keys } = await makeVault(master);
    await repository.addPhoto({ bytes: makeImage('a') }, { source: 'camera' });
    await repository.addPhoto({ bytes: makeImage('b') }, { source: 'camera' });
    const backend = await signedInBackend();
    const service = makeService(backend);
    await service.enable(keys, PASSPHRASE);
    await service.backupNow(repository, keys);

    const uid = backend.currentUser?.uid ?? '';
    expect(backend.documents.has(BACKUP_PATHS.envelope(uid))).toBe(true);
    expect(backend.documents.has(BACKUP_PATHS.manifest(uid))).toBe(true);
    expect(backend.blobs.has(BACKUP_PATHS.index(uid))).toBe(true);

    await service.purgeAccount();

    expect(backend.blobs.size).toBe(0);
    expect(backend.documents.size).toBe(0);
    // The local vault is untouched: purging is a cloud operation only.
    expect(repository.photos).toHaveLength(2);
  });
});

/**
 * `index.enc` used to be a single point of failure: it is the only thing that maps an account's
 * blobs back to entries, so losing one small object left every photo present, paid for, and
 * unrestorable -- while the account looked perfectly healthy. The manifest now carries a second
 * copy of the same ciphertext.
 */
describe('BackupService index fallback', () => {
  it('restores from the manifest copy when the index blob is gone', async () => {
    const master = random.bytes(32);
    const source = await makeVault(master);
    await source.repository.addPhoto({ bytes: makeImage('one') }, { source: 'camera' });
    await source.repository.addPhoto({ bytes: makeImage('two') }, { source: 'camera' });
    const backend = await signedInBackend();
    const service = makeService(backend);
    await service.enable(source.keys, PASSPHRASE);
    await service.backupNow(source.repository, source.keys);

    const uid = backend.currentUser?.uid ?? '';
    // Exactly the disaster being defended against: the index object disappears, blobs remain.
    backend.blobs.delete(BACKUP_PATHS.index(uid));
    expect(backend.blobs.has(BACKUP_PATHS.index(uid))).toBe(false);

    const target = await makeVault(master);
    const report = await makeService(backend, target.fs).restoreInto(
      target.repository,
      target.keys,
    );

    expect(report.restored).toBe(2);
    expect(target.repository.photos).toHaveLength(2);
  });

  it('keeps uploading coherent when only the manifest copy survives', async () => {
    const master = random.bytes(32);
    const { repository, keys } = await makeVault(master);
    await repository.addPhoto({ bytes: makeImage('first') }, { source: 'camera' });
    const backend = await signedInBackend();
    const service = makeService(backend);
    await service.enable(keys, PASSPHRASE);
    await service.backupNow(repository, keys);

    const uid = backend.currentUser?.uid ?? '';
    backend.blobs.delete(BACKUP_PATHS.index(uid));

    // A second run has to read the existing entries to merge them; the fallback supplies them, so
    // the index is rebuilt rather than silently replaced by a one-photo one.
    await repository.addPhoto({ bytes: makeImage('second') }, { source: 'camera' });
    const report = await service.backupNow(repository, keys);

    expect(report.total).toBe(2);
    expect(backend.blobs.has(BACKUP_PATHS.index(uid))).toBe(true);
  });

  it('reports nothing to restore only when neither copy exists', async () => {
    const master = random.bytes(32);
    const { repository, keys } = await makeVault(master);
    await repository.addPhoto({ bytes: makeImage('one') }, { source: 'camera' });
    const backend = await signedInBackend();
    const service = makeService(backend);
    await service.enable(keys, PASSPHRASE);
    await service.backupNow(repository, keys);

    const uid = backend.currentUser?.uid ?? '';
    backend.blobs.delete(BACKUP_PATHS.index(uid));
    backend.documents.delete(BACKUP_PATHS.manifest(uid));

    const target = await makeVault(master);
    const report = await makeService(backend, target.fs).restoreInto(
      target.repository,
      target.keys,
    );
    expect(report).toEqual({ restored: 0, skipped: 0 });
  });

  it('refuses to call a corrupt fallback an empty account', async () => {
    const master = random.bytes(32);
    const { repository, keys } = await makeVault(master);
    await repository.addPhoto({ bytes: makeImage('one') }, { source: 'camera' });
    const backend = await signedInBackend();
    const service = makeService(backend);
    await service.enable(keys, PASSPHRASE);
    await service.backupNow(repository, keys);

    const uid = backend.currentUser?.uid ?? '';
    backend.blobs.delete(BACKUP_PATHS.index(uid));
    const manifest = backend.documents.get(BACKUP_PATHS.manifest(uid)) ?? {};
    backend.documents.set(BACKUP_PATHS.manifest(uid), { ...manifest, index: 'not base64 !!!' });

    const target = await makeVault(master);
    // "Nothing to restore" is the one answer that must never be a guess: the user acts on it by
    // giving up on photos that are still sitting in the bucket.
    await expect(
      makeService(backend, target.fs).restoreInto(target.repository, target.keys),
    ).rejects.toThrow(RecordFormatError);
  });

  it('stores the copy as the identical ciphertext, not a second encryption', async () => {
    const master = random.bytes(32);
    const { repository, keys } = await makeVault(master);
    await repository.addPhoto({ bytes: makeImage('one') }, { source: 'camera' });
    const backend = await signedInBackend();
    const service = makeService(backend);
    await service.enable(keys, PASSPHRASE);
    await service.backupNow(repository, keys);

    const uid = backend.currentUser?.uid ?? '';
    const blob = backend.blobs.get(BACKUP_PATHS.index(uid));
    const copy = backend.documents.get(BACKUP_PATHS.manifest(uid))?.index;
    expect(typeof copy).toBe('string');
    expect(base64Decode(copy as string)).toEqual(blob);
    // Ciphertext, not anything readable: the copy is no weaker than the object it mirrors.
    expect(looksEncrypted(base64Decode(copy as string))).toBe(true);
  });
});

/**
 * Devices update before security rules do, and sometimes instead of them. A client that only works
 * against the newest ruleset turns "I added a field" into "nobody can back up", which is exactly
 * what happened on 2026-09-18: the deployed `hasOnly` validator rejected the whole manifest and
 * "Back up now" started failing with permission-denied.
 */
describe('BackupService manifest against older rules', () => {
  it('still backs up when the server rejects the fallback field', async () => {
    const master = random.bytes(32);
    const { repository, keys } = await makeVault(master);
    await repository.addPhoto({ bytes: makeImage('one') }, { source: 'camera' });
    const backend = await signedInBackend();
    const service = makeService(backend);
    await service.enable(keys, PASSPHRASE);

    const uid = backend.currentUser?.uid ?? '';
    const real = backend.putDocument.bind(backend);
    // Stands in for a ruleset that predates `index`: the document is refused whole.
    jest
      .spyOn(backend, 'putDocument')
      .mockImplementation(async (path: string, data: Record<string, unknown>) => {
        if (path === BACKUP_PATHS.manifest(uid) && 'index' in data) {
          throw new CloudError('permission-denied');
        }
        await real(path, data);
      });

    const report = await service.backupNow(repository, keys);

    expect(report).toEqual({ uploaded: 1, cloudOnly: 0, total: 1 });
    const manifest = backend.documents.get(BACKUP_PATHS.manifest(uid));
    expect(manifest?.photoCount).toBe(1);
    expect(manifest?.index).toBeUndefined();
    // The primary copy is untouched by any of this.
    expect(backend.blobs.has(BACKUP_PATHS.index(uid))).toBe(true);
  });

  it('does not hide a genuine permission failure behind the retry', async () => {
    const master = random.bytes(32);
    const { repository, keys } = await makeVault(master);
    await repository.addPhoto({ bytes: makeImage('one') }, { source: 'camera' });
    const backend = await signedInBackend();
    const service = makeService(backend);
    await service.enable(keys, PASSPHRASE);

    const uid = backend.currentUser?.uid ?? '';
    // Refused whatever the shape: an actual authorisation problem, not a stale validator.
    jest.spyOn(backend, 'putDocument').mockImplementation(async (path: string) => {
      if (path === BACKUP_PATHS.manifest(uid)) throw new CloudError('permission-denied');
    });

    await expect(service.backupNow(repository, keys)).rejects.toThrow(CloudError);
  });
});

/**
 * The manifest's `index` copy, checked against the rules it has to satisfy and the promise it has
 * to keep: a string, opaque, authenticated, and small enough that adding it can never push the
 * document past Firestore's 1 MiB ceiling.
 */
describe('BackupService manifest index field', () => {
  it('is a string of ciphertext that leaks no plaintext from the vault', async () => {
    const master = random.bytes(32);
    const { repository, keys } = await makeVault(master);
    const image = makeImage('PIXELS-IN-THE-CLEAR');
    await repository.addPhoto(
      { bytes: image },
      { source: 'import', originalName: 'holiday-in-reykjavik.jpg', mimeType: 'image/jpeg' },
    );
    const backend = await signedInBackend();
    const service = makeService(backend);
    await service.enable(keys, PASSPHRASE);
    await service.backupNow(repository, keys);

    const uid = backend.currentUser?.uid ?? '';
    const manifest = backend.documents.get(BACKUP_PATHS.manifest(uid));
    expect(typeof manifest?.index).toBe('string');

    const serialised = JSON.stringify(manifest);
    // The file name lives in the index JSON, so if anything were stored unencrypted it would show.
    expect(serialised).not.toContain('holiday-in-reykjavik');
    expect(serialised).not.toContain('PIXELS-IN-THE-CLEAR');
    expect(serialised).not.toContain(toHex(master));

    const decoded = base64Decode(manifest?.index as string);
    expect(looksEncrypted(decoded)).toBe(true);
    expect(containsSequence(decoded, image)).toBe(false);
    expect(containsSequence(decoded, utf8Encode('holiday-in-reykjavik.jpg'))).toBe(false);
  });

  it('is authenticated: a flipped bit is rejected rather than half-decoded', async () => {
    const master = random.bytes(32);
    const { repository, keys } = await makeVault(master);
    await repository.addPhoto({ bytes: makeImage('one') }, { source: 'camera' });
    const backend = await signedInBackend();
    const service = makeService(backend);
    await service.enable(keys, PASSPHRASE);
    await service.backupNow(repository, keys);

    const uid = backend.currentUser?.uid ?? '';
    backend.blobs.delete(BACKUP_PATHS.index(uid));
    const manifest = backend.documents.get(BACKUP_PATHS.manifest(uid)) ?? {};
    const tampered = base64Decode(manifest.index as string);
    const last = tampered.length - 1;
    tampered[last] = (tampered[last] ?? 0) ^ 0x01;
    backend.documents.set(BACKUP_PATHS.manifest(uid), {
      ...manifest,
      index: Buffer.from(tampered).toString('base64'),
    });

    const target = await makeVault(master);
    await expect(
      makeService(backend, target.fs).restoreInto(target.repository, target.keys),
    ).rejects.toThrow(WrongKeyError);
    expect(target.repository.photos).toHaveLength(0);
  });

  /**
   * The budget has to do two jobs: leave the copy useful for a realistic library, and make an
   * oversized document impossible. Both sides are bounded here, because the client catches a rules
   * refusal but NOT Firestore's hard 1 MiB rejection -- so the numbers have to rule that out.
   */
  it('cannot push the document past the 1 MiB document limit', () => {
    const FIRESTORE_LIMIT = 1024 * 1024;
    const ID_FIELD_BYTES = 45; // 32 hex chars plus list-entry overhead
    const MAX_IDS = 20000; // the ceiling the rules enforce

    // Measured: 190 B of index JSON for a photo with no file name, 252 B with a 60-char one.
    // base64 inflates ciphertext by 4/3, so the widest entry costs about 336 B of budget.
    const WIDEST_ENTRY_BASE64 = 336;
    const photosThatFit = Math.floor(700_000 / WIDEST_ENTRY_BASE64);
    expect(photosThatFit).toBeGreaterThan(2000);

    // Case 1: the index is carried. Ids and index grow together, so this is the true worst case.
    expect(700_000 + photosThatFit * ID_FIELD_BYTES).toBeLessThan(FIRESTORE_LIMIT);
    // Case 2: the index was too big and dropped. Only the id list remains, at its rules ceiling.
    expect(MAX_IDS * ID_FIELD_BYTES).toBeLessThan(FIRESTORE_LIMIT);
  });
});
