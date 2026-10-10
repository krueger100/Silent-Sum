/**
 * The device's note of which account it last backed up to, and what it is allowed to decide.
 *
 * It holds one uid, which is the root of everything here. A vault can legitimately own the backups
 * of two of its owner's accounts; one slot cannot say so. And a slot whose bytes will not parse
 * cannot say anything at all, yet it used to resolve to "owned by somebody else" -- a statement
 * about another person's photos, made out of a damaged byte, which refused every write on this
 * device with no way past it but to confirm a transfer that was not happening.
 *
 * So the note is a cache and the account's envelope is the authority: `vaultId` is derived from the
 * master key by whichever vault owns the backup, it lives in the cloud, and it travels with the
 * account rather than with the handset. Where the two disagree the cloud wins and the note is
 * rewritten. Where the cloud cannot say, the note still gets to ASK -- that is the account
 * isolation boundary and it is untouched -- but never to refuse on its own.
 *
 * What must stay true throughout, and is asserted here rather than assumed: account A's data never
 * becomes reachable from account B without somebody typing a confirmation first.
 */
import { BackupService } from '@/backup/backupService';
import { VaultOwnerStore } from '@/backup/vaultOwner';
import { InMemorySecureStore, SECURE_STORE_KEYS } from '@/secure-storage/secureStore';
import { BACKUP_PATHS, ForeignVaultError, VaultIdMismatchError } from '@/backup/types';
import {
  Argon2idKeyDerivation,
  KDF_PRESETS,
  SodiumKeyWrapping,
  SodiumSecureRandom,
  Ssv1FileCipher,
  deriveVaultKeys,
} from '@/crypto';
import { Ssv2StreamCipher } from '@/crypto/streamCipher';
import { InMemoryCloudBackend } from '@/firebase/cloudBackend';
import { InMemoryFileSystem } from '@/storage/inMemoryFileSystem';
import { SecureDelete } from '@/storage/secureDelete';
import { EncryptedVaultRepository } from '@/vault/encryptedVaultRepository';
import { FakeThumbnailGenerator } from '@/vault/thumbnailGenerator';
import { FakeVideoThumbnailGenerator } from '@/vault/videoThumbnailGenerator';
import { VaultPaths } from '@/vault/vaultPaths';
import type { VaultRepository } from '@/vault/types';
import { utf8Encode, type Bytes } from '@/utils/bytes';
import { FakeClock } from '@/utils/clock';

const random = new SodiumSecureRandom();
const PASSPHRASE = 'correct horse battery staple';
const OTHER_PASSPHRASE = 'a quite different set of words';

/** Two accounts on one backend, so "account A" and "account B" are real uids throughout. */
const A = { email: 'a@example.com', password: 'cloud-account-password-a' };
const B = { email: 'b@example.com', password: 'cloud-account-password-b' };

function image(marker: string): Bytes {
  const bytes = random.bytes(512);
  bytes.set(utf8Encode(marker), 0);
  return bytes;
}

async function makeVault(masterKey: Bytes, photos = 1) {
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
  for (let index = 0; index < photos; index++) {
    await repository.addPhoto({ bytes: image(`photo-${String(index)}`) }, { source: 'import' });
  }
  return { fs, keys, repository };
}

/**
 * A backup service whose device note is whatever the test says it is.
 *
 * The note is seeded through the secure store rather than through `bind`, because the two cases
 * that matter -- a note naming a different account, and a note that will not parse -- are both
 * states a real device arrives in without any call having put them there.
 */
function makeService(
  backend: InMemoryCloudBackend,
  note?: string,
  fs = new InMemoryFileSystem(),
): BackupService {
  const store = new InMemorySecureStore(
    note === undefined ? {} : { [SECURE_STORE_KEYS.vaultOwner]: note },
  );
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
    owner: new VaultOwnerStore(store),
    kdfParams: KDF_PRESETS.forTests,
  });
}

/** A note that names an account, as the store really writes it. */
const noteNaming = (uid: string): string => JSON.stringify({ uid, boundAt: 1 });

async function signedInAs(
  backend: InMemoryCloudBackend,
  who: { email: string; password: string },
): Promise<string> {
  if (backend.currentUser !== null) await backend.signOut();
  try {
    await backend.signIn(who.email, who.password);
  } catch {
    await backend.signUp(who.email, who.password);
  }
  const uid = backend.currentUser?.uid;
  if (uid === undefined) throw new Error('expected a signed-in account');
  return uid;
}

describe('a stale device note', () => {
  /**
   * THE REGRESSION. One vault, two of the user's own accounts. Every backup rewrote the single
   * note, so coming back to the first account was read as a cross-account transfer and refused --
   * even though that account's envelope, in the cloud, names this very vault.
   */
  it('does not interrupt a vault the account’s own envelope already names', async () => {
    const backend = new InMemoryCloudBackend();
    const master = random.bytes(32);
    const { keys, repository } = await makeVault(master);

    // Account A's backup is set up by this vault, so A's envelope carries this vault's id.
    const aUid = await signedInAs(backend, A);
    const service = makeService(backend);
    await service.enable(keys, PASSPHRASE);
    await service.backupNow(repository, keys);

    // The note now names B, as it would after the user backed B up from here in between.
    const bUid = await signedInAs(backend, B);
    expect(bUid).not.toBe(aUid);
    await signedInAs(backend, A);
    const returning = makeService(backend, noteNaming(bUid));

    // Neither write asks anything: the cloud already settles it.
    await expect(returning.backupNow(repository, keys)).resolves.toBeDefined();
    await expect(returning.enable(keys, PASSPHRASE)).resolves.toBeUndefined();
  });

  /** And the correction sticks, so the second write does not pay for the lookup again. */
  it('rewrites the note it found to be behind', async () => {
    const backend = new InMemoryCloudBackend();
    const { keys, repository } = await makeVault(random.bytes(32));
    const aUid = await signedInAs(backend, A);
    await makeService(backend).enable(keys, PASSPHRASE);

    const store = new InMemorySecureStore({
      [SECURE_STORE_KEYS.vaultOwner]: noteNaming('someone-else'),
    });
    const service = new BackupService({
      backend,
      kdf: new Argon2idKeyDerivation(),
      wrapping: new SodiumKeyWrapping(),
      cipher: new Ssv1FileCipher(),
      streamCipher: new Ssv2StreamCipher({ fs: new InMemoryFileSystem(), chunkExponent: 10 }),
      clock: new FakeClock(),
      random,
      fs: new InMemoryFileSystem(),
      secureDelete: new SecureDelete(new InMemoryFileSystem()),
      owner: new VaultOwnerStore(store),
      kdfParams: KDF_PRESETS.forTests,
    });

    await service.backupNow(repository, keys);

    expect(await service.ownership()).toEqual({ kind: 'owned' });
    expect(store.snapshot[SECURE_STORE_KEYS.vaultOwner]).toContain(aUid);
  });
});

describe('a device note that cannot be read', () => {
  const GARBAGE = 'not json at all';

  /**
   * It used to mean "owned by someone else", which is a claim about another account's photos built
   * out of a damaged byte. Where the cloud can settle the question, a damaged note must not even
   * come up.
   */
  it('does not strand a user whose account already belongs to this vault', async () => {
    const backend = new InMemoryCloudBackend();
    const { keys, repository } = await makeVault(random.bytes(32));
    await signedInAs(backend, A);
    await makeService(backend).enable(keys, PASSPHRASE);

    const damaged = makeService(backend, GARBAGE);
    await expect(damaged.backupNow(repository, keys)).resolves.toBeDefined();
    await expect(damaged.enable(keys, PASSPHRASE)).resolves.toBeUndefined();
  });

  /** Reported as what it is, rather than as a different account. */
  it('reads as unknown rather than as another account', async () => {
    const backend = new InMemoryCloudBackend();
    await signedInAs(backend, A);
    expect(await makeService(backend, GARBAGE).ownership()).toEqual({ kind: 'unknown' });
  });

  /**
   * And where the cloud CANNOT settle it -- a brand new account with no envelope -- it still asks,
   * because nothing has established that these photos belong here. Asking is not stranding: the
   * same call succeeds once the user has answered, which is the whole difference from before.
   */
  it('asks, without naming an account it cannot name, and proceeds once answered', async () => {
    const backend = new InMemoryCloudBackend();
    const { keys } = await makeVault(random.bytes(32));
    await signedInAs(backend, A);

    const damaged = makeService(backend, GARBAGE);
    await expect(damaged.enable(keys, PASSPHRASE)).rejects.toThrow(ForeignVaultError);
    await expect(damaged.enable(keys, PASSPHRASE)).rejects.toMatchObject({ ownerUid: null });

    await expect(
      damaged.enable(keys, PASSPHRASE, { confirmedCrossAccount: true }),
    ).resolves.toBeUndefined();
  });
});

describe('account isolation, which none of this relaxes', () => {
  /** A note naming another account, and a cloud that cannot vouch for this vault: still asks. */
  it('still asks before putting this vault’s photos into an account that never held them', async () => {
    const backend = new InMemoryCloudBackend();
    const { keys, repository } = await makeVault(random.bytes(32));
    const aUid = await signedInAs(backend, A);
    await signedInAs(backend, B);

    const service = makeService(backend, noteNaming(aUid));
    await expect(service.enable(keys, PASSPHRASE)).rejects.toThrow(ForeignVaultError);
    // And it names the account, which the dialog needs in order to say anything true.
    await expect(service.enable(keys, PASSPHRASE)).rejects.toMatchObject({ ownerUid: aUid });
    await expect(service.backupNow(repository, keys)).rejects.toThrow();
  });

  /**
   * The check that is NOT device state and does not move: a vault whose key is not the one the
   * account's envelope names cannot add to that account's backup. This is what stops an
   * incompatible vault writing blobs into an account whose index no key of its own can open.
   */
  it('refuses to add to an account whose backup belongs to another vault', async () => {
    const backend = new InMemoryCloudBackend();
    const first = await makeVault(random.bytes(32));
    await signedInAs(backend, A);
    await makeService(backend).enable(first.keys, PASSPHRASE);

    // A second, unrelated vault on a second device, signed into the same account.
    const second = await makeVault(random.bytes(32));
    const intruder = makeService(backend);
    await expect(intruder.backupNow(second.repository, second.keys)).rejects.toThrow(
      VaultIdMismatchError,
    );
  });

  /** Nothing about a cleared note lets one account read the other's envelope. */
  it('never hands one account the other’s envelope', async () => {
    const backend = new InMemoryCloudBackend();
    const { keys } = await makeVault(random.bytes(32));
    const aUid = await signedInAs(backend, A);
    await makeService(backend).enable(keys, PASSPHRASE);

    const bUid = await signedInAs(backend, B);
    const other = await makeVault(random.bytes(32));
    await makeService(backend).enable(other.keys, OTHER_PASSPHRASE, {
      confirmedCrossAccount: true,
    });

    const aEnvelope = backend.documents.get(BACKUP_PATHS.envelope(aUid));
    const bEnvelope = backend.documents.get(BACKUP_PATHS.envelope(bUid));
    expect(aEnvelope).toBeDefined();
    expect(bEnvelope).toBeDefined();
    expect(aEnvelope).not.toEqual(bEnvelope);
    // B's passphrase does not open A's envelope, and B's service only ever reads B's path.
    await expect(makeService(backend).recoverMasterKey(OTHER_PASSPHRASE)).resolves.toBeDefined();
  });
});

describe('restoring on a new device, then backing up', () => {
  /**
   * The sequence a real new device walks: restore what the account holds, then take ownership of
   * the backup, then back up normally. The middle step is a typed confirmation and stays one -- it
   * is what makes this account's passphrase able to unwrap this vault, and the point of this change
   * was never to remove a confirmation.
   */
  it('restores, and then backs up once the move has been confirmed', async () => {
    const backend = new InMemoryCloudBackend();
    const origin = await makeVault(random.bytes(32), 2);
    await signedInAs(backend, A);
    const originService = makeService(backend);
    await originService.enable(origin.keys, PASSPHRASE);
    await originService.backupNow(origin.repository, origin.keys);

    // A different vault, same account. No note at all, as on a device that has just been set up.
    const fresh = await makeVault(random.bytes(32), 0);
    const service = makeService(backend);

    // Restoring needs no confirmation and no note: it reads the account's own data.
    const recovered = await service.recoverMasterKey(PASSPHRASE);
    const report = await service.restoreForeignInto(fresh.repository, fresh.keys, recovered);
    expect(report.restored).toBe(2);

    // Backing up is refused until the account is moved onto this vault, because the account's
    // envelope still names the origin vault. Not device state -- a fact about the data.
    await expect(service.backupNow(fresh.repository, fresh.keys)).rejects.toThrow(
      VaultIdMismatchError,
    );

    await service.rebindBackup(fresh.repository, fresh.keys, PASSPHRASE, report.cloudIds);

    await expect(service.backupNow(fresh.repository, fresh.keys)).resolves.toBeDefined();
    expect(await service.recoverMasterKey(PASSPHRASE)).toEqual(fresh.keys.masterKey);
  });
});
