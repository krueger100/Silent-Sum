import { CLOUD_ERROR_CODES, InMemoryCloudBackend, ownerPrefix } from '@/firebase/cloudBackend';
import { toCloudError } from '@/firebase/firebaseCloudBackend';
import { BACKUP_PATHS } from '@/backup/types';
import { CloudError, type CloudUser } from '@/firebase/types';

const EMAIL = 'backup@example.test';
const PASSWORD = 'correct horse battery staple';

/** Returns the CloudError code an action fails with, or a marker describing why it did not. */
async function codeOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return error instanceof CloudError ? error.code : `not-a-cloud-error: ${String(error)}`;
  }
  return 'did-not-throw';
}

async function signedIn(): Promise<{ backend: InMemoryCloudBackend; user: CloudUser }> {
  const backend = new InMemoryCloudBackend();
  const user = await backend.signUp(EMAIL, PASSWORD);
  return { backend, user };
}

describe('InMemoryCloudBackend auth', () => {
  it('starts signed out', () => {
    expect(new InMemoryCloudBackend().currentUser).toBeNull();
  });

  it('signs up, signs out and signs back in as the same uid', async () => {
    const backend = new InMemoryCloudBackend();
    const created = await backend.signUp(EMAIL, PASSWORD);
    expect(backend.currentUser).toEqual(created);
    expect(created.email).toBe(EMAIL);

    await backend.signOut();
    expect(backend.currentUser).toBeNull();

    const returning = await backend.signIn(EMAIL, PASSWORD);
    expect(returning.uid).toBe(created.uid);
  });

  it('rejects a wrong password and an unknown account with wrong-password', async () => {
    const { backend } = await signedIn();
    await backend.signOut();
    expect(await codeOf(() => backend.signIn(EMAIL, 'nope'))).toBe(CLOUD_ERROR_CODES.wrongPassword);
    expect(await codeOf(() => backend.signIn('nobody@example.test', PASSWORD))).toBe(
      CLOUD_ERROR_CODES.wrongPassword,
    );
  });

  it('rejects a duplicate sign-up with email-already-in-use', async () => {
    const { backend } = await signedIn();
    expect(await codeOf(() => backend.signUp(EMAIL, PASSWORD))).toBe(
      CLOUD_ERROR_CODES.emailAlreadyInUse,
    );
  });

  it('notifies listeners of the current user and of every change', async () => {
    const backend = new InMemoryCloudBackend();
    const seen: (string | null)[] = [];
    const unsubscribe = backend.onAuthStateChanged((user) => seen.push(user?.uid ?? null));

    const user = await backend.signUp(EMAIL, PASSWORD);
    await backend.signOut();
    unsubscribe();
    await backend.signIn(EMAIL, PASSWORD);

    expect(seen).toEqual([null, user.uid, null]);
  });
});

describe('InMemoryCloudBackend owner scoping', () => {
  it('refuses every operation while signed out', async () => {
    const backend = new InMemoryCloudBackend();
    const path = 'users/someone/vault/envelope';
    const expected = CLOUD_ERROR_CODES.unauthenticated;

    expect(await codeOf(() => backend.putDocument(path, { v: 1 }))).toBe(expected);
    expect(await codeOf(() => backend.getDocument(path))).toBe(expected);
    expect(await codeOf(() => backend.deleteDocument(path))).toBe(expected);
    expect(await codeOf(() => backend.putBlob(path, new Uint8Array([1])))).toBe(expected);
    expect(await codeOf(() => backend.getBlob(path))).toBe(expected);
    expect(await codeOf(() => backend.deleteBlob(path))).toBe(expected);
    expect(await codeOf(() => backend.listBlobs('users/someone/photos'))).toBe(expected);
    expect(await codeOf(() => backend.deleteAccount())).toBe(expected);
  });

  it.each([
    ['another user', 'users/someone-else/index.enc'],
    ['the users collection root', 'users/index.enc'],
    ['no prefix at all', 'index.enc'],
    ['the uid without a trailing slash', 'users/UID'],
    ['a uid that merely starts the same way', 'users/UIDX/index.enc'],
    ['a parent traversal', 'users/UID/../other/index.enc'],
  ])('refuses %s with permission-denied', async (_label, template) => {
    const { backend, user } = await signedIn();
    const path = template.replace('UID', user.uid);
    const expected = CLOUD_ERROR_CODES.permissionDenied;

    expect(await codeOf(() => backend.putDocument(path, { v: 1 }))).toBe(expected);
    expect(await codeOf(() => backend.getDocument(path))).toBe(expected);
    expect(await codeOf(() => backend.deleteDocument(path))).toBe(expected);
    expect(await codeOf(() => backend.putBlob(path, new Uint8Array([1])))).toBe(expected);
    expect(await codeOf(() => backend.getBlob(path))).toBe(expected);
    expect(await codeOf(() => backend.deleteBlob(path))).toBe(expected);
    expect(await codeOf(() => backend.listBlobs(path))).toBe(expected);
  });

  it('allows everything under the signed-in user own prefix', async () => {
    const { backend, user } = await signedIn();
    const path = `${ownerPrefix(user.uid)}vault/envelope`;
    await expect(backend.putDocument(path, { v: 1 })).resolves.toBeUndefined();
    expect(await backend.getDocument(path)).toEqual({ v: 1 });
  });
});

describe('InMemoryCloudBackend documents', () => {
  it('returns null for a document that was never written', async () => {
    const { backend, user } = await signedIn();
    expect(await backend.getDocument(`${ownerPrefix(user.uid)}vault/envelope`)).toBeNull();
  });

  it('replaces rather than merges, and hands back copies', async () => {
    const { backend, user } = await signedIn();
    const path = `${ownerPrefix(user.uid)}vault/manifest`;

    const written = { v: 1, ids: ['a'] };
    await backend.putDocument(path, written);
    written.v = 99;

    const read = await backend.getDocument(path);
    expect(read).toEqual({ v: 1, ids: ['a'] });
    if (read !== null) read.v = 42;
    expect(await backend.getDocument(path)).toEqual({ v: 1, ids: ['a'] });

    await backend.putDocument(path, { v: 2 });
    expect(await backend.getDocument(path)).toEqual({ v: 2 });
  });

  it('treats deleting a missing document as success', async () => {
    const { backend, user } = await signedIn();
    await expect(
      backend.deleteDocument(`${ownerPrefix(user.uid)}vault/gone`),
    ).resolves.toBeUndefined();
  });
});

describe('InMemoryCloudBackend blobs', () => {
  it('round-trips bytes by value, not by reference', async () => {
    const { backend, user } = await signedIn();
    const path = `${ownerPrefix(user.uid)}photos/a.enc`;
    const source = new Uint8Array([1, 2, 3]);

    await backend.putBlob(path, source);
    source[0] = 9;

    const stored = await backend.getBlob(path);
    expect(Array.from(stored)).toEqual([1, 2, 3]);
    stored[1] = 9;
    expect(Array.from(await backend.getBlob(path))).toEqual([1, 2, 3]);
  });

  it('reports a missing blob as object-not-found but a missing delete as success', async () => {
    const { backend, user } = await signedIn();
    expect(await codeOf(() => backend.getBlob(`${ownerPrefix(user.uid)}photos/gone.enc`))).toBe(
      CLOUD_ERROR_CODES.objectNotFound,
    );
    await expect(
      backend.deleteBlob(`${ownerPrefix(user.uid)}photos/gone.enc`),
    ).resolves.toBeUndefined();
  });

  it('lists immediate children only', async () => {
    const { backend, user } = await signedIn();
    const prefix = ownerPrefix(user.uid);
    for (const path of [
      `${prefix}photos/a.enc`,
      `${prefix}photos/b.enc`,
      `${prefix}photos/nested/c.enc`,
      `${prefix}thumbs/a.enc`,
      `${prefix}photosx/d.enc`,
    ]) {
      await backend.putBlob(path, new Uint8Array([0]));
    }

    expect((await backend.listBlobs(`${prefix}photos`)).sort()).toEqual(['a.enc', 'b.enc']);
    expect((await backend.listBlobs(`${prefix}photos/`)).sort()).toEqual(['a.enc', 'b.enc']);
    expect(await backend.listBlobs(`${prefix}empty`)).toEqual([]);
  });
});

describe('InMemoryCloudBackend deleteAccount', () => {
  it('wipes the owner subtree, drops the account and signs out', async () => {
    const { backend, user } = await signedIn();
    const prefix = ownerPrefix(user.uid);
    await backend.putDocument(`${prefix}vault/envelope`, { v: 1 });
    await backend.putBlob(`${prefix}photos/a.enc`, new Uint8Array([1]));
    backend.documents.set('users/other/vault/envelope', { v: 1 });
    backend.blobs.set('users/other/photos/a.enc', new Uint8Array([1]));

    await backend.deleteAccount();

    expect(backend.currentUser).toBeNull();
    expect([...backend.documents.keys()]).toEqual(['users/other/vault/envelope']);
    expect([...backend.blobs.keys()]).toEqual(['users/other/photos/a.enc']);
    // The e-mail is free again, and the old password no longer works.
    expect(await codeOf(() => backend.signIn(EMAIL, PASSWORD))).toBe(
      CLOUD_ERROR_CODES.wrongPassword,
    );
    await expect(backend.signUp(EMAIL, PASSWORD)).resolves.toBeDefined();
  });
});

describe('toCloudError', () => {
  it('drops the service namespace from native codes', () => {
    expect(toCloudError({ code: 'storage/object-not-found', message: 'gone' }).code).toBe(
      CLOUD_ERROR_CODES.objectNotFound,
    );
    expect(toCloudError({ code: 'firestore/permission-denied' }).code).toBe(
      CLOUD_ERROR_CODES.permissionDenied,
    );
    expect(toCloudError({ code: 'auth/email-already-in-use' }).code).toBe(
      CLOUD_ERROR_CODES.emailAlreadyInUse,
    );
    expect(toCloudError({ code: 'auth/wrong-password' }).code).toBe(
      CLOUD_ERROR_CODES.wrongPassword,
    );
  });

  it('folds the renamed auth codes onto the stable ones', () => {
    expect(toCloudError({ code: 'auth/invalid-credential' }).code).toBe(
      CLOUD_ERROR_CODES.wrongPassword,
    );
    expect(toCloudError({ code: 'auth/user-not-found' }).code).toBe(
      CLOUD_ERROR_CODES.wrongPassword,
    );
    expect(toCloudError({ code: 'storage/unauthorized' }).code).toBe(
      CLOUD_ERROR_CODES.permissionDenied,
    );
    expect(toCloudError({ code: 'auth/no-current-user' }).code).toBe(
      CLOUD_ERROR_CODES.unauthenticated,
    );
  });

  /**
   * This one used to fold onto `unauthenticated`, which was harmless until an operation existed
   * that actually provokes it. Deleting an account does: Firebase refused it on a session a few
   * minutes old, and the screen told a visibly signed-in user to "Sign in to your backup account
   * first." The two states need different answers, so they keep different codes.
   */
  it('keeps a stale session distinct from having no session at all', () => {
    expect(toCloudError({ code: 'auth/requires-recent-login' }).code).toBe(
      CLOUD_ERROR_CODES.requiresRecentLogin,
    );
    expect(toCloudError({ code: 'auth/requires-recent-login' }).code).not.toBe(
      CLOUD_ERROR_CODES.unauthenticated,
    );
  });

  it('falls back to unknown and never re-wraps a CloudError', () => {
    expect(toCloudError(new Error('offline')).code).toBe(CLOUD_ERROR_CODES.unknown);
    expect(toCloudError('offline').code).toBe(CLOUD_ERROR_CODES.unknown);
    expect(toCloudError(null).code).toBe(CLOUD_ERROR_CODES.unknown);
    const original = new CloudError(CLOUD_ERROR_CODES.objectNotFound);
    expect(toCloudError(original)).toBe(original);
  });
});

/**
 * The uid is the whole of the access control: it is an address, never a key. These are the same
 * boundaries the deployed Firestore and Storage rules enforce, checked here so a change to the
 * app's path building cannot quietly step outside them.
 */
describe('InMemoryCloudBackend uid isolation', () => {
  const CIPHERTEXT = new Uint8Array([1, 2, 3, 4]);

  async function twoAccounts(): Promise<{ alice: CloudUser; bob: CloudUser; backend: InMemoryCloudBackend }> {
    const backend = new InMemoryCloudBackend();
    const alice = await backend.signUp('alice@example.test', 'alice-password');
    await backend.putDocument(BACKUP_PATHS.envelope(alice.uid), { v: 1 });
    await backend.putBlob(BACKUP_PATHS.photo(alice.uid, 'p1'), CIPHERTEXT);
    await backend.signOut();
    const bob = await backend.signUp('bob@example.test', 'bob-password');
    return { alice, bob, backend };
  }

  it('gives two accounts two different uids', async () => {
    const { alice, bob } = await twoAccounts();
    expect(bob.uid).not.toBe(alice.uid);
  });

  it('denies every operation on another account paths, exact path or not', async () => {
    const { alice, backend } = await twoAccounts();

    for (const action of [
      () => backend.getDocument(BACKUP_PATHS.envelope(alice.uid)),
      () => backend.putDocument(BACKUP_PATHS.envelope(alice.uid), { v: 1 }),
      () => backend.deleteDocument(BACKUP_PATHS.envelope(alice.uid)),
      () => backend.getBlob(BACKUP_PATHS.photo(alice.uid, 'p1')),
      () => backend.putBlob(BACKUP_PATHS.photo(alice.uid, 'p1'), CIPHERTEXT),
      () => backend.deleteBlob(BACKUP_PATHS.photo(alice.uid, 'p1')),
      () => backend.listBlobs(BACKUP_PATHS.photosPrefix(alice.uid)),
    ]) {
      expect(await codeOf(action)).toBe(CLOUD_ERROR_CODES.permissionDenied);
    }
  });

  it('is not fooled by a path that climbs out of the owner prefix', async () => {
    const { alice, bob, backend } = await twoAccounts();

    const traversal = `${ownerPrefix(bob.uid)}../${alice.uid}/vault/envelope`;
    expect(await codeOf(() => backend.getDocument(traversal))).toBe(
      CLOUD_ERROR_CODES.permissionDenied,
    );
  });

  it('leaves the other account data untouched after all of that', async () => {
    const { alice, backend } = await twoAccounts();
    await backend.signOut();
    await backend.signIn('alice@example.test', 'alice-password');

    expect(await backend.getDocument(BACKUP_PATHS.envelope(alice.uid))).toEqual({ v: 1 });
    expect(await backend.getBlob(BACKUP_PATHS.photo(alice.uid, 'p1'))).toEqual(CIPHERTEXT);
  });
});
