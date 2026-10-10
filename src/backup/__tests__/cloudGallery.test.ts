/**
 * The Local Gallery and the Cloud Gallery, and why they are not the same list.
 *
 * The vault on the device is the master copy: unlimited, private, and never uploaded by itself.
 * The cloud holds whatever subset the user explicitly chose, and the account's own encrypted
 * index is the ONLY record of which subset that is.
 *
 * That is what makes these specs short. There is no device-level "backed up" flag to keep in step
 * with the cloud, and none per account either, so isolation between accounts is not something the
 * code enforces -- it falls out of asking a different account for its own index, sealed under its
 * own key. These are written to fail if that ever stops being true.
 */
import { BackupService } from '@/backup/backupService';
import { VaultOwnerStore } from '@/backup/vaultOwner';
import {
  BACKUP_PATHS,
  type BackupProgress,
  type BackupReport,
  type BackupService as BackupServiceContract,
} from '@/backup/types';
import {
  Argon2idKeyDerivation,
  KDF_PRESETS,
  SodiumKeyWrapping,
  SodiumSecureRandom,
  Ssv1FileCipher,
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
import type { VaultKeys } from '@/crypto/types';
import type { PhotoEntry, VaultRepository } from '@/vault/types';
import { utf8Encode, type Bytes } from '@/utils/bytes';
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

interface Device {
  readonly store: InMemoryCloudStore;
  readonly backend: InMemoryCloudBackend;
  readonly repository: VaultRepository;
  readonly keys: VaultKeys;
  readonly service: BackupServiceContract;
}

/** One physical device: one vault, one secure store, one backup service. */
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
    owner: new VaultOwnerStore(new InMemorySecureStore()),
    kdfParams: KDF_PRESETS.forTests,
  });
  return { store, backend, repository, keys, service };
}

/** The ids the Cloud Gallery would show, or the reason it cannot show a list at all. */
async function cloudIds(device: Device): Promise<string[] | 'foreign' | 'none'> {
  const contents = await device.service.cloudContents(device.keys);
  if (contents.kind !== 'listed') return contents.kind;
  return contents.entries.map((entry) => entry.id).sort();
}

function localIds(device: Device): string[] {
  return device.repository.photos.map((photo) => photo.id).sort();
}

/** True when this id's ciphertext sits anywhere in the store, under any account. */
function anywhereInCloud(device: Device, id: string): boolean {
  return [...device.store.blobs.keys()].some((key) => key.includes(id));
}

describe('choosing what goes to the cloud', () => {
  it('uploads only the photos named, leaving the rest of the vault local', async () => {
    const store = new InMemoryCloudStore();
    const device = await makeDevice(store);
    await device.backend.signUp(ALICE, PASSWORD);
    const kept = await device.repository.addPhoto({ bytes: image('LOCAL') }, { source: 'camera' });
    const sent = await device.repository.addPhoto({ bytes: image('CLOUD') }, { source: 'camera' });
    await device.service.enable(device.keys, PASSPHRASE_A);

    await device.service.backupNow(device.repository, device.keys, { ids: [sent.id] });

    // The Cloud Gallery shows one photo; the Local Gallery still shows both.
    expect(await cloudIds(device)).toEqual([sent.id]);
    expect(localIds(device)).toEqual([kept.id, sent.id].sort());
    // And the one that stayed behind has no bytes in the account at all.
    expect(anywhereInCloud(device, kept.id)).toBe(false);
  });

  it('is empty before anything has been chosen, even with backup switched on', async () => {
    const store = new InMemoryCloudStore();
    const device = await makeDevice(store);
    await device.backend.signUp(ALICE, PASSWORD);
    const only = await device.repository.addPhoto({ bytes: image('LOCAL') }, { source: 'camera' });
    await device.service.enable(device.keys, PASSPHRASE_A);

    // Switching backup on uploads nothing by itself. That is the whole opt-in promise.
    expect(await cloudIds(device)).toBe('none');
    expect(localIds(device)).toEqual([only.id]);
    expect(anywhereInCloud(device, only.id)).toBe(false);
  });

  it('adds to the cloud set rather than replacing it', async () => {
    const store = new InMemoryCloudStore();
    const device = await makeDevice(store);
    await device.backend.signUp(ALICE, PASSWORD);
    const first = await device.repository.addPhoto({ bytes: image('ONE') }, { source: 'camera' });
    const second = await device.repository.addPhoto({ bytes: image('TWO') }, { source: 'camera' });
    await device.service.enable(device.keys, PASSPHRASE_A);

    await device.service.backupNow(device.repository, device.keys, { ids: [first.id] });
    await device.service.backupNow(device.repository, device.keys, { ids: [second.id] });

    expect(await cloudIds(device)).toEqual([first.id, second.id].sort());
  });

  /** The old meaning has to survive: a rebind and every existing spec depend on it. */
  it('still backs up the whole vault when no ids are given', async () => {
    const store = new InMemoryCloudStore();
    const device = await makeDevice(store);
    await device.backend.signUp(ALICE, PASSWORD);
    const a = await device.repository.addPhoto({ bytes: image('ONE') }, { source: 'camera' });
    const b = await device.repository.addPhoto({ bytes: image('TWO') }, { source: 'camera' });
    await device.service.enable(device.keys, PASSPHRASE_A);

    await device.service.backupNow(device.repository, device.keys);

    expect(await cloudIds(device)).toEqual([a.id, b.id].sort());
  });
});

describe('two accounts on one device', () => {
  interface Both {
    readonly device: Device;
    readonly aliceId: string;
    readonly bobId: string;
    readonly localOnlyId: string;
  }

  /** Alice backs one photo up and signs out; Bob signs in and backs a different one up. */
  async function bothAccounts(): Promise<Both> {
    const store = new InMemoryCloudStore();
    const device = await makeDevice(store);
    const localOnly = await device.repository.addPhoto(
      { bytes: image('NEVER-UPLOADED') },
      { source: 'camera' },
    );

    await device.backend.signUp(ALICE, PASSWORD);
    const alicePhoto = await device.repository.addPhoto({ bytes: image('A') }, { source: 'camera' });
    await device.service.enable(device.keys, PASSPHRASE_A);
    await device.service.backupNow(device.repository, device.keys, { ids: [alicePhoto.id] });
    await device.backend.signOut();

    await device.backend.signUp(BOB, PASSWORD);
    const bobPhoto = await device.repository.addPhoto({ bytes: image('B') }, { source: 'camera' });
    await device.service.enable(device.keys, PASSPHRASE_B, { confirmedCrossAccount: true });
    await device.service.backupNow(device.repository, device.keys, {
      ids: [bobPhoto.id],
      confirmedCrossAccount: true,
    });

    return { device, aliceId: alicePhoto.id, bobId: bobPhoto.id, localOnlyId: localOnly.id };
  }

  it('never shows the first account’s cloud photo in the second’s Cloud Gallery', async () => {
    const { device, aliceId, bobId } = await bothAccounts();

    // Signed in as Bob.
    const bobsGallery = await cloudIds(device);
    expect(bobsGallery).toEqual([bobId]);
    expect(bobsGallery).not.toContain(aliceId);
  });

  it('never shows the second account’s cloud photo in the first’s Cloud Gallery', async () => {
    const { device, aliceId, bobId } = await bothAccounts();

    await device.backend.signOut();
    await device.backend.signIn(ALICE, PASSWORD);

    const alicesGallery = await cloudIds(device);
    expect(alicesGallery).toEqual([aliceId]);
    expect(alicesGallery).not.toContain(bobId);
  });

  /**
   * The Local Gallery belongs to the device, not to an account. Switching who is signed in must
   * not take anything out of it -- that is the behaviour asked for explicitly, and the one a
   * per-account vault would have broken.
   */
  it('leaves the local gallery whole across the switch, never-uploaded photo included', async () => {
    const { device, aliceId, bobId, localOnlyId } = await bothAccounts();
    const expected = [localOnlyId, aliceId, bobId].sort();

    expect(localIds(device)).toEqual(expected);

    await device.backend.signOut();
    expect(localIds(device)).toEqual(expected);

    await device.backend.signIn(ALICE, PASSWORD);
    expect(localIds(device)).toEqual(expected);
  });

  it('keeps a local-only photo out of both accounts', async () => {
    const { device, localOnlyId } = await bothAccounts();

    expect(await cloudIds(device)).not.toContain(localOnlyId);
    await device.backend.signOut();
    await device.backend.signIn(ALICE, PASSWORD);
    expect(await cloudIds(device)).not.toContain(localOnlyId);
    expect(anywhereInCloud(device, localOnlyId)).toBe(false);
  });

  /** Signed out there is no account, so there is no Cloud Gallery to show. */
  it('has no Cloud Gallery at all while signed out, and still has the local one', async () => {
    const { device, localOnlyId, aliceId, bobId } = await bothAccounts();

    await device.backend.signOut();

    await expect(device.service.cloudContents(device.keys)).rejects.toThrow();
    expect(localIds(device)).toEqual([localOnlyId, aliceId, bobId].sort());
  });
});

describe('a backup this vault did not write', () => {
  it('reports foreign rather than an empty gallery', async () => {
    const store = new InMemoryCloudStore();
    const first = await makeDevice(store);
    await first.backend.signUp(ALICE, PASSWORD);
    const photo = await first.repository.addPhoto({ bytes: image('A') }, { source: 'camera' });
    await first.service.enable(first.keys, PASSPHRASE_A);
    await first.service.backupNow(first.repository, first.keys, { ids: [photo.id] });

    // A second device, another vault, signing into the same account.
    const second = await makeDevice(store);
    await second.backend.signIn(ALICE, PASSWORD);

    // Not 'none': "nothing is backed up" would be the opposite of the truth.
    expect(await cloudIds(second)).toBe('foreign');
  });
});

describe('deleting from one side only', () => {
  it('removing from the cloud leaves the local photo exactly where it was', async () => {
    const store = new InMemoryCloudStore();
    const device = await makeDevice(store);
    const user = await device.backend.signUp(ALICE, PASSWORD);
    const bytes = image('KEEP-ME');
    const photo = await device.repository.addPhoto({ bytes }, { source: 'camera' });
    await device.service.enable(device.keys, PASSPHRASE_A);
    await device.service.backupNow(device.repository, device.keys, { ids: [photo.id] });

    const removed = await device.service.removeFromCloud(device.keys, [photo.id]);

    expect(removed).toBe(1);
    expect(await cloudIds(device)).toBe('none');
    // The local copy still opens, byte for byte.
    expect(localIds(device)).toEqual([photo.id]);
    expect(await device.repository.readFullImage(photo.id)).toEqual(bytes);
    // And its ciphertext is gone from the account.
    expect(store.blobs.has(BACKUP_PATHS.photo(user.uid, photo.id))).toBe(false);
    expect(store.blobs.has(BACKUP_PATHS.thumb(user.uid, photo.id))).toBe(false);
  });

  it('deleting locally leaves the cloud copy listed and its bytes in place', async () => {
    const store = new InMemoryCloudStore();
    const device = await makeDevice(store);
    const user = await device.backend.signUp(ALICE, PASSWORD);
    const photo = await device.repository.addPhoto({ bytes: image('A') }, { source: 'camera' });
    await device.service.enable(device.keys, PASSPHRASE_A);
    await device.service.backupNow(device.repository, device.keys, { ids: [photo.id] });

    await device.repository.deletePhotos([photo.id]);

    expect(localIds(device)).toEqual([]);
    // Still in the cloud: deleting here was never a statement about the backup.
    expect(await cloudIds(device)).toEqual([photo.id]);
    expect(store.blobs.has(BACKUP_PATHS.photo(user.uid, photo.id))).toBe(true);
  });

  it('removes nothing, and says so, when asked for an id the cloud does not hold', async () => {
    const store = new InMemoryCloudStore();
    const device = await makeDevice(store);
    await device.backend.signUp(ALICE, PASSWORD);
    const photo = await device.repository.addPhoto({ bytes: image('A') }, { source: 'camera' });
    await device.service.enable(device.keys, PASSPHRASE_A);
    await device.service.backupNow(device.repository, device.keys, { ids: [photo.id] });

    expect(await device.service.removeFromCloud(device.keys, ['not-a-real-id'])).toBe(0);
    expect(await cloudIds(device)).toEqual([photo.id]);
  });

  /** A removal leaves the rest of the backup intact and still restorable. */
  it('takes out only what was named', async () => {
    const store = new InMemoryCloudStore();
    const device = await makeDevice(store);
    await device.backend.signUp(ALICE, PASSWORD);
    const gone = await device.repository.addPhoto({ bytes: image('GONE') }, { source: 'camera' });
    const stays = await device.repository.addPhoto({ bytes: image('STAYS') }, { source: 'camera' });
    await device.service.enable(device.keys, PASSPHRASE_A);
    await device.service.backupNow(device.repository, device.keys, { ids: [gone.id, stays.id] });

    await device.service.removeFromCloud(device.keys, [gone.id]);

    expect(await cloudIds(device)).toEqual([stays.id]);
    expect(anywhereInCloud(device, gone.id)).toBe(false);
    expect(anywhereInCloud(device, stays.id)).toBe(true);
  });
});


/**
 * "Back up now", which repairs and never promotes.
 *
 * The index says what the user CHOSE for the cloud; Storage says which of those bytes are still
 * there. The button closes the gap between the two and does nothing else -- in particular it
 * cannot move a Local Gallery item into the Cloud Gallery, however many times it is pressed.
 *
 * This is why the skip set is a Storage listing rather than the manifest. The manifest is written
 * from the same list as the index, so a selection drawn from the index is always a subset of it:
 * trusting it skipped every candidate and left the button unable to repair anything at all.
 */
describe('repairing what is already in the cloud', () => {
  interface Fixture {
    readonly device: Device;
    readonly store: InMemoryCloudStore;
    readonly uid: string;
    readonly all: readonly PhotoEntry[];
    readonly chosen: readonly string[];
  }

  /** `localCount` photos in the vault, the first `cloudCount` of them chosen for the cloud. */
  async function withCloudSet(localCount: number, cloudCount: number): Promise<Fixture> {
    const store = new InMemoryCloudStore();
    const device = await makeDevice(store);
    const user = await device.backend.signUp(ALICE, PASSWORD);
    const all: PhotoEntry[] = [];
    for (let n = 0; n < localCount; n++) {
      all.push(
        await device.repository.addPhoto({ bytes: image(`P${String(n)}`) }, { source: 'camera' }),
      );
    }
    await device.service.enable(device.keys, PASSPHRASE_A);
    const chosen = all.slice(0, cloudCount).map((photo) => photo.id);
    await device.service.backupNow(device.repository, device.keys, { ids: chosen });
    return { device, store, uid: user.uid, all, chosen };
  }

  /** Exactly what the button does: the chosen set, re-offered. */
  async function pressBackUpNow(device: Device): Promise<number> {
    const contents = await device.service.cloudContents(device.keys);
    const ids = contents.kind === 'listed' ? contents.entries.map((entry) => entry.id) : [];
    const report = await device.service.backupNow(device.repository, device.keys, { ids });
    return report.uploaded;
  }

  it('uploads nothing when every chosen item is present', async () => {
    const { device } = await withCloudSet(5, 5);

    expect(await pressBackUpNow(device)).toBe(0);
  });

  it('re-uploads exactly the one whose photo blob went missing', async () => {
    const { device, store, uid, chosen } = await withCloudSet(5, 5);
    const gone = chosen[0];
    if (gone === undefined) throw new Error('no chosen photo');
    store.blobs.delete(BACKUP_PATHS.photo(uid, gone));

    expect(await pressBackUpNow(device)).toBe(1);
    expect(store.blobs.has(BACKUP_PATHS.photo(uid, gone))).toBe(true);
  });

  /** Half-uploaded counts as missing, or the gallery lists something it cannot draw. */
  it('repairs an item whose thumbnail alone went missing', async () => {
    const { device, store, uid, chosen } = await withCloudSet(5, 5);
    const gone = chosen[1];
    if (gone === undefined) throw new Error('no chosen photo');
    store.blobs.delete(BACKUP_PATHS.thumb(uid, gone));

    expect(await pressBackUpNow(device)).toBe(1);
    expect(store.blobs.has(BACKUP_PATHS.thumb(uid, gone))).toBe(true);
  });

  /** The invariant this whole change exists for. */
  it('never promotes a Local Gallery item, however many times it runs', async () => {
    const { device, store, uid, all, chosen } = await withCloudSet(20, 5);
    const notChosen = all.filter((photo) => !chosen.includes(photo.id));

    await pressBackUpNow(device);
    await pressBackUpNow(device);
    await pressBackUpNow(device);

    expect(notChosen).toHaveLength(15);
    for (const photo of notChosen) {
      expect(store.blobs.has(BACKUP_PATHS.photo(uid, photo.id))).toBe(false);
      expect(store.blobs.has(BACKUP_PATHS.thumb(uid, photo.id))).toBe(false);
    }
  });

  it('does not upload a photo added after the choice was made', async () => {
    const { device, store, uid } = await withCloudSet(5, 5);
    const added = await device.repository.addPhoto(
      { bytes: image('LATE') },
      { source: 'import' },
    );

    await pressBackUpNow(device);

    expect(store.blobs.has(BACKUP_PATHS.photo(uid, added.id))).toBe(false);
  });

  it('leaves Cloud Gallery membership exactly as it was', async () => {
    const { device, store, uid, chosen } = await withCloudSet(20, 5);
    const before = await cloudIds(device);
    const gone = chosen[2];
    if (gone === undefined) throw new Error('no chosen photo');
    store.blobs.delete(BACKUP_PATHS.photo(uid, gone));

    await pressBackUpNow(device);

    expect(await cloudIds(device)).toEqual(before);
    expect(await cloudIds(device)).toEqual([...chosen].sort());
  });

  it('repairs only the signed-in account, never the other one', async () => {
    const store = new InMemoryCloudStore();
    const device = await makeDevice(store);

    const alice = await device.backend.signUp(ALICE, PASSWORD);
    const hers = await device.repository.addPhoto({ bytes: image('A') }, { source: 'camera' });
    await device.service.enable(device.keys, PASSPHRASE_A);
    await device.service.backupNow(device.repository, device.keys, { ids: [hers.id] });
    await device.backend.signOut();

    const bob = await device.backend.signUp(BOB, PASSWORD);
    const his = await device.repository.addPhoto({ bytes: image('B') }, { source: 'camera' });
    await device.service.enable(device.keys, PASSPHRASE_B, { confirmedCrossAccount: true });
    await device.service.backupNow(device.repository, device.keys, {
      ids: [his.id],
      confirmedCrossAccount: true,
    });

    // Break one blob in EACH account, then repair as Bob. Only Bob's may come back.
    store.blobs.delete(BACKUP_PATHS.photo(alice.uid, hers.id));
    store.blobs.delete(BACKUP_PATHS.photo(bob.uid, his.id));

    expect(await pressBackUpNow(device)).toBe(1);
    expect(store.blobs.has(BACKUP_PATHS.photo(bob.uid, his.id))).toBe(true);
    expect(store.blobs.has(BACKUP_PATHS.photo(alice.uid, hers.id))).toBe(false);
  });

  it('cannot run at all while signed out', async () => {
    const { device } = await withCloudSet(5, 5);
    await device.backend.signOut();

    await expect(
      device.service.backupNow(device.repository, device.keys, { ids: [] }),
    ).rejects.toThrow();
  });

  /** A repaired blob is ciphertext, exactly as the first upload was. */
  it('re-uploads ciphertext, never the plain image', async () => {
    const { device, store, uid, chosen } = await withCloudSet(3, 3);
    const gone = chosen[0];
    if (gone === undefined) throw new Error('no chosen photo');
    store.blobs.delete(BACKUP_PATHS.photo(uid, gone));

    await pressBackUpNow(device);

    const bytes = store.blobs.get(BACKUP_PATHS.photo(uid, gone));
    if (bytes === undefined) throw new Error('repair did not write the blob');
    // The fixtures start with a readable marker; ciphertext must not carry it through.
    const marker = utf8Encode('P0');
    expect(marker.every((byte, at) => bytes[at] === byte)).toBe(false);
  });
});

/**
 * Telling three kinds of "no photo here" apart.
 *
 * The index records what the user CHOSE for the cloud. It is not evidence that the files are
 * still there, and the gap between the two is where this screen used to go quiet: an entry whose
 * bytes had gone drew the same grey square as one that simply lives on this device, and "Back up
 * now" printed "nothing needed repairing" over the top of it.
 *
 * So Storage is asked, and the answer is split by whether this device can still do anything about
 * it. A missing file with a local copy is repairable. A missing file without one is lost, and
 * being told so is the only thing left that is worth anything.
 */
describe('what the cloud is actually still holding', () => {
  interface Fixture {
    readonly device: Device;
    readonly store: InMemoryCloudStore;
    readonly uid: string;
    readonly all: readonly PhotoEntry[];
    readonly chosen: readonly string[];
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** `local` photos in the vault, the first `cloud` of them chosen for the cloud. */
  async function withChosen(local: number, cloud: number): Promise<Fixture> {
    const store = new InMemoryCloudStore();
    const device = await makeDevice(store);
    const user = await device.backend.signUp(ALICE, PASSWORD);
    const all: PhotoEntry[] = [];
    for (let n = 0; n < local; n++) {
      all.push(
        await device.repository.addPhoto({ bytes: image(`Q${String(n)}`) }, { source: 'camera' }),
      );
    }
    await device.service.enable(device.keys, PASSPHRASE_A);
    const chosen = all.slice(0, cloud).map((photo) => photo.id);
    await device.service.backupNow(device.repository, device.keys, { ids: chosen });
    return { device, store, uid: user.uid, all, chosen };
  }

  /** What the gallery would mark, or `not-listed` when there is no list to mark up. */
  async function missingIds(device: Device): Promise<readonly string[] | null | 'not-listed'> {
    const contents = await device.service.cloudContents(device.keys);
    return contents.kind === 'listed' ? contents.missing : 'not-listed';
  }

  /** Exactly what the "Back up now" button does: the chosen set, re-offered. */
  async function pressBackUpNow(device: Device): Promise<BackupReport> {
    const contents = await device.service.cloudContents(device.keys);
    const ids = contents.kind === 'listed' ? contents.entries.map((entry) => entry.id) : [];
    return device.service.backupNow(device.repository, device.keys, { ids });
  }

  function one(ids: readonly string[], at: number): string {
    const id = ids[at];
    if (id === undefined) throw new Error('no chosen photo at that position');
    return id;
  }

  it('reports nothing missing while every file is where it should be', async () => {
    const { device } = await withChosen(5, 3);

    expect(await missingIds(device)).toEqual([]);
  });

  it('names an entry whose photo file went missing', async () => {
    const { device, store, uid, chosen } = await withChosen(5, 3);
    const gone = one(chosen, 0);
    store.blobs.delete(BACKUP_PATHS.photo(uid, gone));

    expect(await missingIds(device)).toEqual([gone]);
  });

  /** Half-uploaded counts as missing: a photo with no thumbnail is a tile nothing can draw. */
  it('names an entry whose thumbnail alone went missing', async () => {
    const { device, store, uid, chosen } = await withChosen(5, 3);
    const gone = one(chosen, 1);
    store.blobs.delete(BACKUP_PATHS.thumb(uid, gone));

    expect(await missingIds(device)).toEqual([gone]);
  });

  /** A Local Gallery photo is not in the index, so it is not the cloud's to be missing. */
  it('never counts a Local Gallery photo as a missing cloud file', async () => {
    const { device } = await withChosen(20, 3);

    expect(await missingIds(device)).toEqual([]);
    expect(localIds(device)).toHaveLength(20);
  });

  /**
   * Offline, or refused. The honest answer is "I do not know", and it has to stay distinguishable
   * from "everything is fine": the second promises a photo is safe at the one moment the app
   * cannot see the cloud at all.
   */
  it('says the check did not run, rather than that nothing is missing', async () => {
    const { device } = await withChosen(5, 3);
    jest.spyOn(device.backend, 'listBlobs').mockRejectedValue(new CloudError('unavailable'));

    expect(await missingIds(device)).toBeNull();
  });

  it('still lists what is backed up when the check could not run', async () => {
    const { device, chosen } = await withChosen(5, 3);
    jest.spyOn(device.backend, 'listBlobs').mockRejectedValue(new CloudError('unavailable'));

    expect(await cloudIds(device)).toEqual([...chosen].sort());
  });

  it('keeps each account to its own missing set', async () => {
    const store = new InMemoryCloudStore();
    const device = await makeDevice(store);

    const alice = await device.backend.signUp(ALICE, PASSWORD);
    const hers = await device.repository.addPhoto({ bytes: image('A') }, { source: 'camera' });
    await device.service.enable(device.keys, PASSPHRASE_A);
    await device.service.backupNow(device.repository, device.keys, { ids: [hers.id] });
    await device.backend.signOut();

    const bob = await device.backend.signUp(BOB, PASSWORD);
    const his = await device.repository.addPhoto({ bytes: image('B') }, { source: 'camera' });
    await device.service.enable(device.keys, PASSPHRASE_B, { confirmedCrossAccount: true });
    await device.service.backupNow(device.repository, device.keys, {
      ids: [his.id],
      confirmedCrossAccount: true,
    });

    // Break ALICE's file while BOB is signed in. Bob's gallery must not notice, and must not
    // report somebody else's damage as its own.
    store.blobs.delete(BACKUP_PATHS.photo(alice.uid, hers.id));

    expect(await missingIds(device)).toEqual([]);

    store.blobs.delete(BACKUP_PATHS.photo(bob.uid, his.id));
    expect(await missingIds(device)).toEqual([his.id]);
  });

  it('reports a missing file as repairable while the photo is still on the device', async () => {
    const { device, store, uid, chosen } = await withChosen(5, 3);
    const gone = one(chosen, 0);
    store.blobs.delete(BACKUP_PATHS.photo(uid, gone));

    const report = await pressBackUpNow(device);

    expect(report.uploaded).toBe(1);
    expect(report.unrepairable).toBe(0);
    expect(await missingIds(device)).toEqual([]);
  });

  /**
   * The case that used to pass in silence: no file in the cloud, no copy on the device. The run
   * uploads nothing, exactly as a perfectly healthy one does, which is why the count alone could
   * never be trusted to mean success.
   */
  it('reports an entry as unrepairable once the local copy is gone too', async () => {
    const { device, store, uid, chosen } = await withChosen(5, 3);
    const gone = one(chosen, 0);
    store.blobs.delete(BACKUP_PATHS.photo(uid, gone));
    store.blobs.delete(BACKUP_PATHS.thumb(uid, gone));
    await device.repository.deletePhotos([gone]);

    const report = await pressBackUpNow(device);

    expect(report.uploaded).toBe(0);
    expect(report.unrepairable).toBe(1);
  });

  it('repairs what it can and reports what it cannot, in the same run', async () => {
    const { device, store, uid, chosen } = await withChosen(5, 3);
    const fixable = one(chosen, 0);
    const lost = one(chosen, 1);
    store.blobs.delete(BACKUP_PATHS.photo(uid, fixable));
    store.blobs.delete(BACKUP_PATHS.photo(uid, lost));
    store.blobs.delete(BACKUP_PATHS.thumb(uid, lost));
    await device.repository.deletePhotos([lost]);

    const report = await pressBackUpNow(device);

    expect(report.uploaded).toBe(1);
    expect(report.unrepairable).toBe(1);
    expect(store.blobs.has(BACKUP_PATHS.photo(uid, fixable))).toBe(true);
  });

  /**
   * An entry nothing can recover is still the record of a choice the user made, so it stays.
   * Dropping it would destroy the only evidence the photo was ever meant to be in the cloud, and
   * would do it at the exact moment the user most needs to be told something went wrong.
   */
  it('leaves an unrepairable entry in the index rather than quietly dropping it', async () => {
    const { device, store, uid, chosen } = await withChosen(5, 3);
    const lost = one(chosen, 0);
    store.blobs.delete(BACKUP_PATHS.photo(uid, lost));
    store.blobs.delete(BACKUP_PATHS.thumb(uid, lost));
    await device.repository.deletePhotos([lost]);

    await pressBackUpNow(device);

    expect(await cloudIds(device)).toEqual([...chosen].sort());
    expect(await missingIds(device)).toEqual([lost]);
  });

  /**
   * A failed listing must stop the repair, not proceed with an empty skip set -- that would
   * re-upload every item in the Cloud Gallery because it could not tell they were already there.
   */
  it('refuses to repair at all when it cannot see what Storage holds', async () => {
    const { device, chosen } = await withChosen(5, 3);
    jest
      .spyOn(device.backend, 'listBlobs')
      .mockRejectedValue(new CloudError('unavailable'));

    await expect(
      device.service.backupNow(device.repository, device.keys, { ids: [...chosen] }),
    ).rejects.toBeInstanceOf(CloudError);
  });

  /**
   * The un-named path is untouched, and reports nothing unrepairable because nothing was named.
   * It still exists for the first enable and for a rebind, which deliberately DO mean "the whole
   * vault"; the Cloud Gallery never reaches it.
   */
  it('reports nothing unrepairable when no selection was named', async () => {
    const { device } = await withChosen(5, 3);

    const report = await device.service.backupNow(device.repository, device.keys);

    expect(report.unrepairable).toBe(0);
  });
});

/**
 * Telling the user how far along a long operation is.
 *
 * These operations run for minutes over a phone connection, and until now they reported one bit:
 * a spinning circle, identical at photo 3 of 300 and at a run that had quietly stalled. The
 * progress channel exists so a screen can say "12 of 73" instead, and these specs pin the two
 * things that make that number worth printing -- that it starts immediately, and that it counts
 * the work actually being done rather than the work that was offered.
 */
describe('telling the user how far along it is', () => {
  /** Every (done, total) pair an operation emitted, in order. */
  function recorder(): { readonly calls: [number, number][]; readonly onProgress: BackupProgress } {
    const calls: [number, number][] = [];
    return {
      calls,
      onProgress: (done, total) => {
        calls.push([done, total]);
      },
    };
  }

  async function deviceWith(count: number): Promise<{
    readonly store: InMemoryCloudStore;
    readonly device: Device;
    readonly uid: string;
    readonly ids: string[];
  }> {
    const store = new InMemoryCloudStore();
    const device = await makeDevice(store);
    const user = await device.backend.signUp(ALICE, PASSWORD);
    const ids: string[] = [];
    for (let n = 0; n < count; n++) {
      const photo = await device.repository.addPhoto(
        { bytes: image(`U${String(n)}`) },
        { source: 'camera' },
      );
      ids.push(photo.id);
    }
    await device.service.enable(device.keys, PASSPHRASE_A);
    return { store, device, uid: user.uid, ids };
  }

  it('counts every upload, and starts at zero so the bar is real immediately', async () => {
    const { device, ids } = await deviceWith(3);
    const { calls, onProgress } = recorder();

    await device.service.backupNow(device.repository, device.keys, { ids, onProgress });

    expect(calls).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  /**
   * The total is the work REMAINING, not the size of the selection. Counting the photos already
   * uploaded would start the bar two thirds full and leave it there for the whole run.
   */
  it('counts only what still needs uploading', async () => {
    const { device, store, uid, ids } = await deviceWith(3);
    await device.service.backupNow(device.repository, device.keys, { ids });
    const gone = ids[0];
    if (gone === undefined) throw new Error('no photo');
    store.blobs.delete(BACKUP_PATHS.photo(uid, gone));
    const { calls, onProgress } = recorder();

    await device.service.backupNow(device.repository, device.keys, { ids, onProgress });

    expect(calls).toEqual([
      [0, 1],
      [1, 1],
    ]);
  });

  /** Nothing to do is said plainly, rather than by a bar that never moves. */
  it('reports zero of zero when everything is already uploaded', async () => {
    const { device, ids } = await deviceWith(3);
    await device.service.backupNow(device.repository, device.keys, { ids });
    const { calls, onProgress } = recorder();

    await device.service.backupNow(device.repository, device.keys, { ids, onProgress });

    expect(calls).toEqual([[0, 0]]);
  });

  it('counts a restore, including the photos that were already here', async () => {
    const { device, ids } = await deviceWith(3);
    await device.service.backupNow(device.repository, device.keys, { ids });
    const gone = ids[0];
    if (gone === undefined) throw new Error('no photo');
    // One comes back off the network; two are skipped instantly. All three are progress.
    await device.repository.deletePhotos([gone]);
    const { calls, onProgress } = recorder();

    const report = await device.service.restoreInto(device.repository, device.keys, onProgress);

    expect(report.restored).toBe(1);
    expect(report.skipped).toBe(2);
    expect(calls).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it('counts a foreign restore the same way', async () => {
    const { device, store, ids } = await deviceWith(3);
    await device.service.backupNow(device.repository, device.keys, { ids });

    // A second device, its own vault key, signing in to the same account. Its keys cannot read
    // that index, which is what makes this the foreign path.
    const other = await makeDevice(store);
    await other.backend.signIn(ALICE, PASSWORD);
    const master = await other.service.recoverMasterKey(PASSPHRASE_A);
    const { calls, onProgress } = recorder();

    const report = await other.service.restoreForeignInto(
      other.repository,
      other.keys,
      master,
      onProgress,
    );

    expect(report.restored).toBe(ids.length);
    expect(calls[0]).toEqual([0, 3]);
    expect(calls[calls.length - 1]).toEqual([3, 3]);
  });

  /** Whatever the path, the number only ever climbs and never overshoots. */
  it('never goes backwards and never passes the total', async () => {
    const { device, ids } = await deviceWith(5);
    const { calls, onProgress } = recorder();

    await device.service.backupNow(device.repository, device.keys, { ids, onProgress });

    let previous = -1;
    for (const [done, total] of calls) {
      expect(done).toBeGreaterThan(previous);
      expect(done).toBeLessThanOrEqual(total);
      previous = done;
    }
    expect(previous).toBe(5);
  });
});
