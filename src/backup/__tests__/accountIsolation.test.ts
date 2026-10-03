/**
 * Two accounts, one device, one vault.
 *
 * The vault is device-scoped and the cloud is account-scoped, and nothing used to connect them.
 * Sign out of A, sign into B, press a button, and A's photos went into B's cloud storage -- then
 * B's envelope was rewrapped around the device vault's master key, so B's recovery passphrase
 * could unwrap A's photos. Neither step asked anything.
 *
 * These specs are written from the user's side of that: whose photos ended up in whose account.
 * Several assert a NEGATIVE -- that an upload did not happen -- which is the only way to state
 * "nothing leaked", so each is paired with a positive showing the same call does work once the
 * user has said yes. Otherwise a method that threw unconditionally would pass the whole file.
 */
import { BackupService } from '@/backup/backupService';
import { VaultOwnerStore } from '@/backup/vaultOwner';
import {
  BACKUP_PATHS,
  ForeignBackupError,
  ForeignVaultError,
  VaultIdMismatchError,
  type BackupService as BackupServiceContract,
} from '@/backup/types';
import {
  Argon2idKeyDerivation,
  KDF_PRESETS,
  SodiumKeyWrapping,
  SodiumSecureRandom,
  Ssv1FileCipher,
  deriveVaultId,
  deriveVaultKeys,
} from '@/crypto';
import { Ssv2StreamCipher } from '@/crypto/streamCipher';
import { InMemoryCloudBackend, InMemoryCloudStore } from '@/firebase/cloudBackend';
import { CloudError } from '@/firebase/types';
import { InMemorySecureStore } from '@/secure-storage/secureStore';
import { InMemoryFileSystem } from '@/storage/inMemoryFileSystem';
import { SecureDelete } from '@/storage/secureDelete';
import { EncryptedVaultRepository } from '@/vault/encryptedVaultRepository';
import { FakeThumbnailGenerator } from '@/vault/thumbnailGenerator';
import { FakeVideoThumbnailGenerator } from '@/vault/videoThumbnailGenerator';
import { VaultPaths } from '@/vault/vaultPaths';
import { VaultKeyId, type VaultKeys } from '@/crypto/types';
import type { VaultRepository } from '@/vault/types';
import { toHex, utf8Encode, type Bytes } from '@/utils/bytes';
import { FakeClock } from '@/utils/clock';

const random = new SodiumSecureRandom();
const PASSPHRASE_A = 'correct horse battery staple';
const PASSPHRASE_B = 'seven green bicycles upstream';
const PASSWORD = 'cloud-account-password';
const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';

function image(marker: string): Bytes {
  const bytes = random.bytes(512);
  bytes.set(utf8Encode(marker), 0);
  return bytes;
}

/** One physical device: one vault, one secure store, one backup service. */
interface Device {
  readonly backend: InMemoryCloudBackend;
  readonly repository: VaultRepository;
  readonly keys: VaultKeys;
  readonly service: BackupServiceContract;
  readonly owner: VaultOwnerStore;
  readonly masterKey: Bytes;
}

async function makeDevice(store: InMemoryCloudStore, masterKey = random.bytes(32)): Promise<Device> {
  const fs = new InMemoryFileSystem();
  const keys = deriveVaultKeys(masterKey);
  const repository: VaultRepository = new EncryptedVaultRepository({
    fs,
    paths: new VaultPaths(fs.documentDirectory),
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

  const backend = new InMemoryCloudBackend(null, store);
  const owner = new VaultOwnerStore(new InMemorySecureStore());
  const service = new BackupService({
    backend,
    kdf: new Argon2idKeyDerivation(),
    wrapping: new SodiumKeyWrapping(),
    cipher: new Ssv1FileCipher(),
    streamCipher: new Ssv2StreamCipher({ fs, chunkExponent: 10 }),
    clock: new FakeClock(),
    random,
    fs,
    secureDelete: new SecureDelete(fs),
    owner,
    kdfParams: KDF_PRESETS.forTests,
  });
  return { backend, repository, keys, service, owner, masterKey };
}

/** Blob paths that exist under one account, so a spec can say whose photos are where. */
function photosIn(store: InMemoryCloudStore, uid: string): string[] {
  return [...store.blobs.keys()].filter((key) => key.startsWith(`users/${uid}/photos/`));
}

function idsIn(store: InMemoryCloudStore, uid: string): string[] {
  return photosIn(store, uid).map((key) => key.split('/').pop()?.replace('.enc', '') ?? '');
}

/**
 * Every byte and every document one account owns, as one comparable string.
 *
 * `idsIn` proves which photos are there; this proves nothing else moved either -- a refusal that
 * rewrote an envelope or re-encrypted a blob would pass the id check and still have damaged the
 * account it refused to write to.
 */
function cloudFootprint(store: InMemoryCloudStore, uid: string): string {
  const prefix = `users/${uid}/`;
  const lines = [
    ...[...store.blobs.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, bytes]) => `blob ${key} = ${toHex(bytes)}`),
    ...[...store.documents.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, document]) => `doc  ${key} = ${JSON.stringify(document)}`),
  ];
  return lines.sort().join('\n'
);
}

describe('one device, two accounts', () => {
  /** The scenario in full: A backs up, signs out, B signs in and presses Back up now. */
  it('refuses to upload account A’s photos into account B', async () => {
    const store = new InMemoryCloudStore();
    const device = await makeDevice(store);
    const { backend, repository, keys, service } = device;

    const alice = await backend.signUp(ALICE, PASSWORD);
    const aPhoto = await repository.addPhoto({ bytes: image('ALICE-PIXELS') }, { source: 'camera' });
    await service.enable(keys, PASSPHRASE_A);
    await service.backupNow(repository, keys);
    expect(idsIn(store, alice.uid)).toEqual([aPhoto.id]);

    await backend.signOut();
    const bob = await backend.signUp(BOB, PASSWORD);

    // Bob turning backup on is itself refused: an envelope would let his passphrase unwrap the
    // vault key that opens Alice's photos.
    await expect(service.enable(keys, PASSPHRASE_B)).rejects.toBeInstanceOf(ForeignVaultError);
    expect(photosIn(store, bob.uid)).toEqual([]);
    expect(await backend.getDocument(BACKUP_PATHS.envelope(bob.uid))).toBeNull();

    // And Alice's account is exactly as she left it.
    expect(idsIn(store, alice.uid)).toEqual([aPhoto.id]);
  });

  it('uploads into account B once the user has explicitly confirmed', async () => {
    const store = new InMemoryCloudStore();
    const { backend, repository, keys, service } = await makeDevice(store);

    const alice = await backend.signUp(ALICE, PASSWORD);
    const aPhoto = await repository.addPhoto({ bytes: image('ALICE-PIXELS') }, { source: 'camera' });
    await service.enable(keys, PASSPHRASE_A);
    await service.backupNow(repository, keys);

    await backend.signOut();
    const bob = await backend.signUp(BOB, PASSWORD);

    await service.enable(keys, PASSPHRASE_B, { confirmedCrossAccount: true });
    await service.backupNow(repository, keys, { confirmedCrossAccount: true });

    // The user asked for this, so it happened -- which is what makes the refusal above meaningful
    // rather than a method that simply never works.
    expect(idsIn(store, bob.uid)).toEqual([aPhoto.id]);
    // Alice's copy is untouched either way.
    expect(idsIn(store, alice.uid)).toEqual([aPhoto.id]);
  });

  it('lets the same account on the same device carry on with no questions', async () => {
    const store = new InMemoryCloudStore();
    const { backend, repository, keys, service } = await makeDevice(store);
    const alice = await backend.signUp(ALICE, PASSWORD);

    await repository.addPhoto({ bytes: image('ONE') }, { source: 'camera' });
    await service.enable(keys, PASSPHRASE_A);
    await service.backupNow(repository, keys);

    // Sign out and back into the SAME account: the binding matches, so nothing is asked.
    await backend.signOut();
    await backend.signIn(ALICE, PASSWORD);
    const second = await repository.addPhoto({ bytes: image('TWO') }, { source: 'camera' });

    const report = await service.backupNow(repository, keys);

    expect(report.uploaded).toBe(1);
    expect(idsIn(store, alice.uid)).toContain(second.id);
    expect(await service.ownership()).toEqual({ kind: 'owned' });
  });

  it('reports the mismatch to the screen before anything is attempted', async () => {
    const store = new InMemoryCloudStore();
    const { backend, repository, keys, service } = await makeDevice(store);

    await backend.signUp(ALICE, PASSWORD);
    await repository.addPhoto({ bytes: image('ALICE') }, { source: 'camera' });
    await service.enable(keys, PASSPHRASE_A);
    expect(await service.ownership()).toEqual({ kind: 'owned' });

    const alice = backend.currentUser;
    await backend.signOut();
    await backend.signUp(BOB, PASSWORD);

    expect(await service.ownership()).toEqual({
      kind: 'other-account',
      ownerUid: alice?.uid ?? '',
    });
  });

  it('treats a vault that has never been backed up anywhere as nobody’s', async () => {
    const store = new InMemoryCloudStore();
    const { backend, repository, keys, service } = await makeDevice(store);
    const bob = await backend.signUp(BOB, PASSWORD);
    const photo = await repository.addPhoto({ bytes: image('FIRST') }, { source: 'camera' });

    // No other account can be harmed, so the first backup is an ordinary first backup.
    expect(await service.ownership()).toEqual({ kind: 'unbound' });
    await service.enable(keys, PASSPHRASE_B);
    await service.backupNow(repository, keys);

    expect(idsIn(store, bob.uid)).toEqual([photo.id]);
  });
});

describe('restoring account B onto a device that holds account A’s photos', () => {
  /**
   * The restore itself is additive and must stay that way: A's photos are not deleted, not
   * re-encrypted, not uploaded anywhere, and the vault keeps its own master key.
   */
  it('adds B’s photos without touching A’s or uploading anything', async () => {
    const store = new InMemoryCloudStore();

    // Bob's backup is made on his OWN device, so it arrives under a foreign master key.
    const bobDevice = await makeDevice(store);
    const bob = await bobDevice.backend.signUp(BOB, PASSWORD);
    const bPhoto = await bobDevice.repository.addPhoto(
      { bytes: image('BOB-PIXELS') },
      { source: 'camera' },
    );
    await bobDevice.service.enable(bobDevice.keys, PASSPHRASE_B);
    await bobDevice.service.backupNow(bobDevice.repository, bobDevice.keys);

    // Alice's device: her own vault, her own account, her own photo.
    const device = await makeDevice(store);
    const alice = await device.backend.signUp(ALICE, PASSWORD);
    const aPhoto = await device.repository.addPhoto(
      { bytes: image('ALICE-PIXELS') },
      { source: 'camera' },
    );
    await device.service.enable(device.keys, PASSPHRASE_A);
    await device.service.backupNow(device.repository, device.keys);
    const aliceCloudBefore = idsIn(store, alice.uid);

    // Now Bob signs in on Alice's device and restores his backup.
    await device.backend.signOut();
    await device.backend.signIn(BOB, PASSWORD);
    const recovered = await device.service.recoverMasterKey(PASSPHRASE_B);
    const report = await device.service.restoreForeignInto(
      device.repository,
      device.keys,
      recovered,
    );

    // Bob's photo arrived; Alice's is still here and still hers.
    expect(report.restored).toBe(1);
    const localIds = device.repository.photos.map((p) => p.id);
    expect(localIds).toContain(bPhoto.id);
    expect(localIds).toContain(aPhoto.id);
    // The restore reports only what the ACCOUNT holds, which is what a rebind may re-upload.
    expect(report.cloudIds).toEqual([bPhoto.id]);
    // Nothing went up. Bob's account still holds exactly his own photo.
    expect(idsIn(store, bob.uid)).toEqual([bPhoto.id]);
    expect(idsIn(store, alice.uid)).toEqual(aliceCloudBefore);
  });

  it('does not rebind the account by itself', async () => {
    const store = new InMemoryCloudStore();
    const bobDevice = await makeDevice(store);
    const bob = await bobDevice.backend.signUp(BOB, PASSWORD);
    await bobDevice.repository.addPhoto({ bytes: image('BOB') }, { source: 'camera' });
    await bobDevice.service.enable(bobDevice.keys, PASSPHRASE_B);
    await bobDevice.service.backupNow(bobDevice.repository, bobDevice.keys);
    const envelopeBefore = await store.documents.get(BACKUP_PATHS.envelope(bob.uid));

    const device = await makeDevice(store);
    await device.backend.signUp(ALICE, PASSWORD);
    await device.repository.addPhoto({ bytes: image('ALICE') }, { source: 'camera' });
    await device.service.enable(device.keys, PASSPHRASE_A);
    await device.backend.signOut();
    await device.backend.signIn(BOB, PASSWORD);

    const recovered = await device.service.recoverMasterKey(PASSPHRASE_B);
    await device.service.restoreForeignInto(device.repository, device.keys, recovered);

    // The envelope is byte-identical: restoring did not re-point the account at this vault.
    expect(store.documents.get(BACKUP_PATHS.envelope(bob.uid))).toEqual(envelopeBefore);
  });

  it('rebinds only the account’s own photos, and only when asked', async () => {
    const store = new InMemoryCloudStore();
    const bobDevice = await makeDevice(store);
    const bob = await bobDevice.backend.signUp(BOB, PASSWORD);
    const bPhoto = await bobDevice.repository.addPhoto({ bytes: image('BOB') }, { source: 'camera' });
    await bobDevice.service.enable(bobDevice.keys, PASSPHRASE_B);
    await bobDevice.service.backupNow(bobDevice.repository, bobDevice.keys);

    const device = await makeDevice(store);
    await device.backend.signUp(ALICE, PASSWORD);
    const aPhoto = await device.repository.addPhoto({ bytes: image('ALICE') }, { source: 'camera' });
    await device.service.enable(device.keys, PASSPHRASE_A);
    await device.backend.signOut();
    await device.backend.signIn(BOB, PASSWORD);

    const recovered = await device.service.recoverMasterKey(PASSPHRASE_B);
    const report = await device.service.restoreForeignInto(
      device.repository,
      device.keys,
      recovered,
    );

    await device.service.rebindBackup(device.repository, device.keys, PASSPHRASE_B, report.cloudIds);

    // Bob's account holds Bob's photo and NOT Alice's, even though both are in the vault that
    // just rewrote it. This is the exact line the old code crossed.
    expect(idsIn(store, bob.uid).sort()).toEqual([bPhoto.id]);
    expect(idsIn(store, bob.uid)).not.toContain(aPhoto.id);
    // And the account now follows this device, so an ordinary backup works again.
    await expect(device.service.backupNow(device.repository, device.keys)).resolves.toBeDefined();
  });

  it('leaves account A fully recoverable afterwards', async () => {
    const store = new InMemoryCloudStore();
    const bobDevice = await makeDevice(store);
    await bobDevice.backend.signUp(BOB, PASSWORD);
    await bobDevice.repository.addPhoto({ bytes: image('BOB') }, { source: 'camera' });
    await bobDevice.service.enable(bobDevice.keys, PASSPHRASE_B);
    await bobDevice.service.backupNow(bobDevice.repository, bobDevice.keys);

    const device = await makeDevice(store);
    const alice = await device.backend.signUp(ALICE, PASSWORD);
    const aBytes = image('ALICE-PIXELS');
    const aPhoto = await device.repository.addPhoto({ bytes: aBytes }, { source: 'camera' });
    await device.service.enable(device.keys, PASSPHRASE_A);
    await device.service.backupNow(device.repository, device.keys);

    await device.backend.signOut();
    await device.backend.signIn(BOB, PASSWORD);
    const recovered = await device.service.recoverMasterKey(PASSPHRASE_B);
    const report = await device.service.restoreForeignInto(
      device.repository,
      device.keys,
      recovered,
    );
    await device.service.rebindBackup(device.repository, device.keys, PASSPHRASE_B, report.cloudIds);

    // Alice's local photo still opens with the vault's own key...
    expect(await device.repository.readFullImage(aPhoto.id)).toEqual(aBytes);
    // ...her cloud backup still has her photo and her envelope...
    expect(idsIn(store, alice.uid)).toEqual([aPhoto.id]);
    expect(await store.documents.get(BACKUP_PATHS.envelope(alice.uid))).toBeDefined();
    // ...and her passphrase still unwraps a key that opens her account's index.
    await device.backend.signOut();
    await device.backend.signIn(ALICE, PASSWORD);
    const hers = await device.service.recoverMasterKey(PASSPHRASE_A);
    const restored = await device.service.restoreInto(device.repository, deriveVaultKeys(hers));
    expect(restored.cloudIds).toEqual([aPhoto.id]);
  });

  it('refuses a foreign backup by the id it states', async () => {
    const store = new InMemoryCloudStore();
    const bobDevice = await makeDevice(store);
    await bobDevice.backend.signUp(BOB, PASSWORD);
    await bobDevice.repository.addPhoto({ bytes: image('BOB') }, { source: 'camera' });
    await bobDevice.service.enable(bobDevice.keys, PASSPHRASE_B);
    await bobDevice.service.backupNow(bobDevice.repository, bobDevice.keys);

    // A second device whose vault has never been bound anywhere, so the cross-account gate is
    // open and the only thing standing in the way is the key check itself.
    const device = await makeDevice(store);
    await device.backend.signIn(BOB, PASSWORD);
    await device.repository.addPhoto({ bytes: image('LOCAL') }, { source: 'camera' });

    await expect(device.service.backupNow(device.repository, device.keys)).rejects.toBeInstanceOf(
      VaultIdMismatchError,
    );
  });

  /**
   * The same refusal for an account whose backup predates the id, where the only evidence is that
   * the index will not decrypt. This is the path every existing user is on until their next
   * backup, so it has to keep working on its own.
   */
  it('still refuses a foreign backup that states no id at all', async () => {
    const store = new InMemoryCloudStore();
    const bobDevice = await makeDevice(store);
    const uid = (await bobDevice.backend.signUp(BOB, PASSWORD)).uid;
    await bobDevice.repository.addPhoto({ bytes: image('BOB') }, { source: 'camera' });
    await bobDevice.service.enable(bobDevice.keys, PASSPHRASE_B);
    await bobDevice.service.backupNow(bobDevice.repository, bobDevice.keys);

    // Age the account to the pre-`vaultId` shape.
    for (const path of [BACKUP_PATHS.envelope(uid), BACKUP_PATHS.manifest(uid)]) {
      const document = { ...(store.documents.get(path) ?? {}) };
      delete document.vaultId;
      store.documents.set(path, document);
    }

    const device = await makeDevice(store);
    await device.backend.signIn(BOB, PASSWORD);
    await device.repository.addPhoto({ bytes: image('LOCAL') }, { source: 'camera' });
    const blobsBefore = [...store.blobs.keys()].sort();

    await expect(device.service.backupNow(device.repository, device.keys)).rejects.toBeInstanceOf(
      ForeignBackupError,
    );
    expect([...store.blobs.keys()].sort()).toEqual(blobsBefore);
  });
});

describe('turning backup off', () => {
  /**
   * `disable` is the one operation that removes an account's cloud copy entirely. Afterwards this
   * vault is backed up nowhere, so the next account is an ordinary first backup rather than a
   * transfer -- there is no longer another account whose photos could be disturbed.
   */
  it('releases the vault, so the next account is not treated as a transfer', async () => {
    const store = new InMemoryCloudStore();
    const { backend, repository, keys, service } = await makeDevice(store);

    await backend.signUp(ALICE, PASSWORD);
    const photo = await repository.addPhoto({ bytes: image('ALICE') }, { source: 'camera' });
    await service.enable(keys, PASSPHRASE_A);
    await service.backupNow(repository, keys);
    expect(await service.ownership()).toEqual({ kind: 'owned' });

    await service.disable();

    await backend.signOut();
    const bob = await backend.signUp(BOB, PASSWORD);
    expect(await service.ownership()).toEqual({ kind: 'unbound' });

    // No confirmation needed: Alice's backup no longer exists to be protected.
    await service.enable(keys, PASSPHRASE_B);
    await service.backupNow(repository, keys);
    expect(idsIn(store, bob.uid)).toEqual([photo.id]);
  });
});

describe('the vault id, which names a vault across devices', () => {
  it('is derived from the master key, stable, and reveals nothing about it', () => {
    const master = random.bytes(32);
    const id = deriveVaultId(master);

    // Same key, same name -- which is what lets a restored vault keep its identity.
    expect(deriveVaultId(Uint8Array.from(master))).toBe(id);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    // A different vault is a different name.
    expect(deriveVaultId(random.bytes(32))).not.toBe(id);
    // And the name is not the key, nor any sub-key derived from it.
    expect(id).not.toContain(toHex(master).slice(0, 8));
    const keys = deriveVaultKeys(master);
    for (const sub of [VaultKeyId.photo, VaultKeyId.thumb, VaultKeyId.manifest, VaultKeyId.video]) {
      expect(toHex(keys.keyFor(sub))).not.toContain(id);
    }
  });

  it('is recorded on the envelope and the manifest when backup is enabled', async () => {
    const store = new InMemoryCloudStore();
    const { backend, repository, keys, service, masterKey } = await makeDevice(store);
    const uid = (await backend.signUp(ALICE, PASSWORD)).uid;
    await repository.addPhoto({ bytes: image('ONE') }, { source: 'camera' });

    await service.enable(keys, PASSPHRASE_A);
    await service.backupNow(repository, keys);

    const expected = deriveVaultId(masterKey);
    expect(store.documents.get(BACKUP_PATHS.envelope(uid))?.vaultId).toBe(expected);
    expect(store.documents.get(BACKUP_PATHS.manifest(uid))?.vaultId).toBe(expected);
  });

  /**
   * The cross-DEVICE case, which the uid binding cannot see: a second device, its own vault, the
   * same account. It is refused from the stated identity alone -- before the index is fetched, and
   * without needing the passphrase.
   */
  it('refuses a second device that does not own the account’s backup', async () => {
    const store = new InMemoryCloudStore();
    const first = await makeDevice(store);
    await first.backend.signUp(ALICE, PASSWORD);
    await first.repository.addPhoto({ bytes: image('FIRST') }, { source: 'camera' });
    await first.service.enable(first.keys, PASSPHRASE_A);
    await first.service.backupNow(first.repository, first.keys);

    // A different device: different vault, same account, and nothing bound locally yet.
    const second = await makeDevice(store);
    await second.backend.signIn(ALICE, PASSWORD);
    await second.repository.addPhoto({ bytes: image('SECOND') }, { source: 'camera' });
    const blobsBefore = [...store.blobs.keys()].sort();

    const refusal = await second.service
      .backupNow(second.repository, second.keys)
      .then(() => null)
      .catch((cause: unknown) => cause);

    expect(refusal).toBeInstanceOf(VaultIdMismatchError);
    // It names both, which is what makes the situation diagnosable rather than mysterious.
    expect((refusal as VaultIdMismatchError).accountVaultId).toBe(deriveVaultId(first.masterKey));
    expect((refusal as VaultIdMismatchError).deviceVaultId).toBe(deriveVaultId(second.masterKey));
    // And nothing moved.
    expect([...store.blobs.keys()].sort()).toEqual(blobsBefore);
  });

  it('says nothing about an envelope written before the field existed', async () => {
    const store = new InMemoryCloudStore();
    const { backend, repository, keys, service } = await makeDevice(store);
    const uid = (await backend.signUp(ALICE, PASSWORD)).uid;
    await repository.addPhoto({ bytes: image('ONE') }, { source: 'camera' });
    await service.enable(keys, PASSPHRASE_A);
    await service.backupNow(repository, keys);

    // Age the account: strip the field, exactly as every pre-existing backup has it.
    for (const path of [BACKUP_PATHS.envelope(uid), BACKUP_PATHS.manifest(uid)]) {
      const document = { ...(store.documents.get(path) ?? {}) };
      delete document.vaultId;
      store.documents.set(path, document);
    }

    // Unknown is not a mismatch: the owning device carries on, and writes the id back.
    await expect(service.backupNow(repository, keys)).resolves.toBeDefined();
    expect(store.documents.get(BACKUP_PATHS.envelope(uid))?.vaultId).toBeUndefined();
    expect(store.documents.get(BACKUP_PATHS.manifest(uid))?.vaultId).toBeDefined();
  });

  /**
   * The rules have to be deployed before an app may write this field, and the two cannot land at
   * the same instant. A build that is ahead of its rules must degrade, not break every backup on
   * every device.
   */
  it('still backs up when the rules have not been deployed yet', async () => {
    const store = new InMemoryCloudStore();
    const { backend, repository, keys, service } = await makeDevice(store);
    const uid = (await backend.signUp(ALICE, PASSWORD)).uid;
    const photo = await repository.addPhoto({ bytes: image('ONE') }, { source: 'camera' });

    // A ruleset that refuses any document carrying the new field, which is what the live one does
    // until `firebase/firestore.deploy.rules` is deployed.
    const real = backend.putDocument.bind(backend);
    jest
      .spyOn(backend, 'putDocument')
      .mockImplementation(async (path: string, document: Record<string, unknown>, options?) => {
        if ('vaultId' in document) throw new CloudError('permission-denied');
        return options === undefined ? real(path, document) : real(path, document, options);
      });

    await service.enable(keys, PASSPHRASE_A);
    await service.backupNow(repository, keys);

    // The backup happened, without the field.
    expect(idsIn(store, uid)).toEqual([photo.id]);
    expect(store.documents.get(BACKUP_PATHS.envelope(uid))?.vaultId).toBeUndefined();
    expect(store.documents.get(BACKUP_PATHS.manifest(uid))?.vaultId).toBeUndefined();
  });
});

/**
 * The scenarios this whole mechanism exists for, each named the way it was reported rather than
 * the way it is implemented. The blocks above test the parts; these test the situations.
 */
describe('the situations that made this necessary', () => {
  /**
   * A backs up, signs out, B signs in and presses Back up now.
   *
   * The refusal has to leave A's cloud copy untouched to the byte. A device that may not write
   * must also not damage what it may not write to.
   */
  it('refuses B and leaves A’s cloud copy byte-identical', async () => {
    const store = new InMemoryCloudStore();
    const { backend, repository, keys, service } = await makeDevice(store);

    const alice = await backend.signUp(ALICE, PASSWORD);
    await repository.addPhoto({ bytes: image('ALICE') }, { source: 'camera' });
    await service.enable(keys, PASSPHRASE_A);
    await service.backupNow(repository, keys);
    const footprint = cloudFootprint(store, alice.uid);

    await backend.signOut();
    const bob = await backend.signUp(BOB, PASSWORD);

    await expect(service.enable(keys, PASSPHRASE_B)).rejects.toBeInstanceOf(ForeignVaultError);

    // Nothing of A's moved, and B got nothing at all.
    expect(cloudFootprint(store, alice.uid)).toBe(footprint);
    expect(cloudFootprint(store, bob.uid)).toBe('');
  });

  /**
   * An account whose envelope and data set come from DIFFERENT vaults: the real shape of the
   * account that could neither back up nor restore. It has to fail closed from either side, and
   * the two sides fail for different reasons -- which is the point of keeping both checks.
   */
  it('fails closed on an account whose envelope and data set disagree', async () => {
    const store = new InMemoryCloudStore();

    // Vault A owns Alice's account properly.
    const vaultA = await makeDevice(store);
    const alice = await vaultA.backend.signUp(ALICE, PASSWORD);
    await vaultA.repository.addPhoto({ bytes: image('A-PIXELS') }, { source: 'camera' });
    await vaultA.service.enable(vaultA.keys, PASSPHRASE_A);
    await vaultA.service.backupNow(vaultA.repository, vaultA.keys);

    // Vault B builds a healthy backup of its own, under its own account.
    const vaultB = await makeDevice(store);
    const bob = await vaultB.backend.signUp(BOB, PASSWORD);
    await vaultB.repository.addPhoto({ bytes: image('B-PIXELS') }, { source: 'camera' });
    await vaultB.service.enable(vaultB.keys, PASSPHRASE_B);
    await vaultB.service.backupNow(vaultB.repository, vaultB.keys);

    // Splice vault B's index and manifest onto Alice, who keeps her own vault A envelope.
    const bIndex = store.blobs.get(BACKUP_PATHS.index(bob.uid));
    const bManifest = store.documents.get(BACKUP_PATHS.manifest(bob.uid));
    expect(bIndex).toBeDefined();
    expect(bManifest).toBeDefined();
    store.blobs.set(BACKUP_PATHS.index(alice.uid), bIndex as Bytes);
    store.documents.set(BACKUP_PATHS.manifest(alice.uid), { ...(bManifest ?? {}) });

    // The two documents now name two different vaults, which is the fact a reader can see.
    expect(store.documents.get(BACKUP_PATHS.envelope(alice.uid))?.vaultId).toBe(
      deriveVaultId(vaultA.masterKey),
    );
    expect(store.documents.get(BACKUP_PATHS.manifest(alice.uid))?.vaultId).toBe(
      deriveVaultId(vaultB.masterKey),
    );
    const footprint = cloudFootprint(store, alice.uid);

    // Vault A, which owns the envelope: the id check passes, so the INDEX is what refuses.
    await expect(
      vaultA.service.backupNow(vaultA.repository, vaultA.keys),
    ).rejects.toBeInstanceOf(ForeignBackupError);
    expect(cloudFootprint(store, alice.uid)).toBe(footprint);

    // Vault B, on a device bound to nothing, signing into Alice: the envelope id refuses first,
    // so it never even reads the index it could in fact decrypt.
    const freshB = await makeDevice(store, vaultB.masterKey);
    await freshB.backend.signIn(ALICE, PASSWORD);
    await expect(
      freshB.service.backupNow(freshB.repository, freshB.keys),
    ).rejects.toBeInstanceOf(VaultIdMismatchError);
    expect(cloudFootprint(store, alice.uid)).toBe(footprint);
  });

  /**
   * A legacy account carries no ids at all. It must keep working, and it must heal -- but each
   * document only heals when something rewrites it, and the envelope is not rewritten by a
   * backup. Stated exactly, because "the next write backfills it" is true of the manifest and
   * not of the envelope, and a reader who assumed otherwise would wait for a repair that never
   * comes.
   */
  it('keeps a legacy account working, and backfills each id when that document is rewritten', async () => {
    const store = new InMemoryCloudStore();
    const { backend, repository, keys, service } = await makeDevice(store);
    const uid = (await backend.signUp(ALICE, PASSWORD)).uid;
    await repository.addPhoto({ bytes: image('ONE') }, { source: 'camera' });
    await service.enable(keys, PASSPHRASE_A);
    await service.backupNow(repository, keys);

    // Age the account into its pre-Phase-1 state.
    for (const path of [BACKUP_PATHS.envelope(uid), BACKUP_PATHS.manifest(uid)]) {
      const document = { ...(store.documents.get(path) ?? {}) };
      delete document.vaultId;
      store.documents.set(path, document);
    }

    // It still restores, on the legacy proof: the envelope unwraps and the index decrypts.
    await expect(service.recoverMasterKey(PASSPHRASE_A)).resolves.toBeDefined();

    // A backup rewrites the manifest, so that one gains its id; the envelope is left alone.
    await repository.addPhoto({ bytes: image('TWO') }, { source: 'camera' });
    await expect(service.backupNow(repository, keys)).resolves.toBeDefined();
    expect(store.documents.get(BACKUP_PATHS.manifest(uid))?.vaultId).toBe(
      deriveVaultId(keys.masterKey),
    );
    expect(store.documents.get(BACKUP_PATHS.envelope(uid))?.vaultId).toBeUndefined();

    // The envelope gains its id the next time anything writes an envelope.
    await service.enable(keys, PASSPHRASE_A);
    expect(store.documents.get(BACKUP_PATHS.envelope(uid))?.vaultId).toBe(
      deriveVaultId(keys.masterKey),
    );
  });

  /**
   * The leak itself, stated as a bound rather than as an example: `rebindBackup` uploads the ids
   * it was handed and nothing else, however much else the vault happens to hold. The old code
   * passed `repository.photos` here, so a device with a thousand private photos published all of
   * them into whichever account had just been restored.
   */
  it('uploads only the ids rebind was handed, never the rest of the vault', async () => {
    const store = new InMemoryCloudStore();
    const bobDevice = await makeDevice(store);
    const bob = await bobDevice.backend.signUp(BOB, PASSWORD);
    const bPhoto = await bobDevice.repository.addPhoto(
      { bytes: image('BOB') },
      { source: 'camera' },
    );
    await bobDevice.service.enable(bobDevice.keys, PASSPHRASE_B);
    await bobDevice.service.backupNow(bobDevice.repository, bobDevice.keys);

    // A device whose vault holds far more than this account's backup ever did.
    const device = await makeDevice(store);
    await device.backend.signUp(ALICE, PASSWORD);
    const privateIds: string[] = [];
    for (const marker of ['ONE', 'TWO', 'THREE', 'FOUR']) {
      const photo = await device.repository.addPhoto(
        { bytes: image(marker) },
        { source: 'camera' },
      );
      privateIds.push(photo.id);
    }
    await device.service.enable(device.keys, PASSPHRASE_A);
    await device.backend.signOut();
    await device.backend.signIn(BOB, PASSWORD);

    const recovered = await device.service.recoverMasterKey(PASSPHRASE_B);
    const report = await device.service.restoreForeignInto(
      device.repository,
      device.keys,
      recovered,
    );
    expect(report.cloudIds).toEqual([bPhoto.id]);

    await device.service.rebindBackup(
      device.repository,
      device.keys,
      PASSPHRASE_B,
      report.cloudIds,
    );

    // Five photos in the vault, one of them the account’s. One photo in the cloud.
    expect(device.repository.photos.length).toBe(5);
    expect(idsIn(store, bob.uid)).toHaveLength(1);
    for (const id of privateIds) expect(idsIn(store, bob.uid)).not.toContain(id);
  });
});
