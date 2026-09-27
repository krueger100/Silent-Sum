/**
 * `CloudBackend` over Firebase Auth, Cloud Firestore and Cloud Storage.
 *
 * Only ciphertext and the passphrase-wrapped key envelope ever pass through here; Auth identifies
 * the backup account and nothing else — it never participates in unlocking the vault.
 *
 * The three RNFirebase packages are `require`d lazily (see `loadCloudModules`). The `import type`
 * lines below are erased by the compiler, so this file still has no runtime import of a native
 * module: it can be loaded — and the whole module graph type-checked — on a build where Firebase
 * was never configured.
 */
import { CLOUD_ERROR_CODES } from '@/firebase/cloudBackend';
import {
  CloudError,
  isFieldIncrement,
  type CloudBackend,
  type CloudUser,
  type CollectionEntry,
  type CollectionQuery,
} from '@/firebase/types';
import { uriDirname, type FileSystem } from '@/storage/fileSystem';
import type { Bytes } from '@/utils/bytes';
import type * as AppNamespace from '@react-native-firebase/app';
import type * as AuthNamespace from '@react-native-firebase/auth';
import type * as FirestoreNamespace from '@react-native-firebase/firestore';
import type * as StorageNamespace from '@react-native-firebase/storage';

type AuthModule = typeof AuthNamespace;
type AppModule = typeof AppNamespace;
type FirestoreModule = typeof FirestoreNamespace;
type StorageModule = typeof StorageNamespace;
type User = AuthNamespace.User;

export interface CloudModules {
  readonly app: AppModule;
  readonly auth: AuthModule;
  readonly firestore: FirestoreModule;
  readonly storage: StorageModule;
}

/** Storage rules require this exact content type; uploading anything else is rejected. */
export const BLOB_CONTENT_TYPE = 'application/octet-stream';

/**
 * Swaps the transport-neutral `FieldIncrement` markers for Firestore's own sentinel, everywhere
 * they appear including inside nested maps. Nothing outside src/firebase knows what a FieldValue
 * is, which is what keeps the rest of the app testable against the in-memory backend.
 */
function withFieldValues(
  data: Record<string, unknown>,
  increment: (n: number) => unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (isFieldIncrement(value)) {
      out[key] = increment(value.__increment);
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      out[key] = withFieldValues(value as Record<string, unknown>, increment);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Loads the three RNFirebase packages. Throws when a native module is missing, which is why the
 * gateway calls it inside its own try/catch — nothing else in the app should call it directly.
 */
export function loadCloudModules(): CloudModules {
  /* eslint-disable @typescript-eslint/no-require-imports */
  return {
    app: require('@react-native-firebase/app') as AppModule,
    auth: require('@react-native-firebase/auth') as AuthModule,
    firestore: require('@react-native-firebase/firestore') as FirestoreModule,
    storage: require('@react-native-firebase/storage') as StorageModule,
  };
  /* eslint-enable @typescript-eslint/no-require-imports */
}

/**
 * Native codes arrive namespaced (`auth/wrong-password`, `storage/object-not-found`). The namespace
 * is dropped so callers branch on one stable vocabulary, and the handful of codes Firebase has
 * renamed are folded onto the name the app already uses: with e-mail enumeration protection on,
 * a bad password comes back as `auth/invalid-credential`.
 */
const CODE_ALIASES: Readonly<Record<string, string>> = {
  'auth/invalid-credential': CLOUD_ERROR_CODES.wrongPassword,
  'auth/invalid-login-credentials': CLOUD_ERROR_CODES.wrongPassword,
  'auth/user-not-found': CLOUD_ERROR_CODES.wrongPassword,
  'auth/no-current-user': CLOUD_ERROR_CODES.unauthenticated,
  // NOT folded onto `unauthenticated`. The user is signed in; the session is merely too old for a
  // sensitive operation, and the fix is to re-enter the account password. Aliasing it produced
  // "Sign in to your backup account first." on a screen showing the signed-in address.
  'auth/requires-recent-login': CLOUD_ERROR_CODES.requiresRecentLogin,
  'storage/unauthenticated': CLOUD_ERROR_CODES.unauthenticated,
  'storage/unauthorized': CLOUD_ERROR_CODES.permissionDenied,
  'firestore/unauthenticated': CLOUD_ERROR_CODES.unauthenticated,
};

function readString(error: unknown, key: string): string | null {
  if (typeof error !== 'object' || error === null || !(key in error)) return null;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Maps any native error onto `CloudError`. Messages are forwarded unscrubbed on purpose: they are
 * SDK text about remote paths, and `FirebaseCrashReporter` scrubs at the reporting boundary.
 */
export function toCloudError(error: unknown): CloudError {
  if (error instanceof CloudError) return error;
  const raw = readString(error, 'code');
  const message = readString(error, 'message') ?? undefined;
  if (raw === null) return new CloudError(CLOUD_ERROR_CODES.unknown, message);
  const aliased = CODE_ALIASES[raw];
  if (aliased !== undefined) return new CloudError(aliased, message);
  const slash = raw.indexOf('/');
  return new CloudError(slash === -1 ? raw : raw.slice(slash + 1), message);
}

async function guard<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw toCloudError(error);
  }
}

/** RNFirebase tasks are thenable but not promises, so they are adapted rather than awaited. */
interface ThenableTask {
  then(onFulfilled: () => void, onRejected: (error: unknown) => void): unknown;
}

function taskDone(task: ThenableTask): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    void task.then(
      () => {
        resolve();
      },
      (error) => {
        reject(toCloudError(error));
      },
    );
  });
}

function toCloudUser(user: User): CloudUser {
  return { uid: user.uid, email: user.email };
}

export interface CloudBackendOptions {
  /**
   * The Storage bucket to keep vault ciphertext in, without the `gs://` prefix.
   *
   * SilentSum uses a bucket of its own rather than the project default. Storage rules are
   * per-bucket and they OR together within one: a project whose default bucket already grants
   * a broad read or write over `/{allPaths=**}` cannot have that narrowed for one prefix, so a
   * stricter owner-only rule for `users/<uid>/**` there would be unenforceable. A dedicated
   * bucket carries its own ruleset and needs no change to anyone else's.
   *
   * Null means the build named no bucket, in which case the gateway offers no cloud backend at
   * all. That is deliberate: falling back to the default bucket would put vault blobs under
   * whatever rules another app happens to have deployed.
   */
  readonly storageBucket?: string | null;

  /**
   * App-private storage, used only to land a downloaded object before it is read.
   *
   * RNFirebase cannot return object bytes in memory - its `getBytes`/`getBlob` throw "not
   * implemented" - so a restore writes to the cache directory and reads straight back. What lands
   * there is the same ciphertext that is in the cloud; it is removed as soon as it has been read.
   */
  readonly fs?: FileSystem;
}

export class FirebaseCloudBackend implements CloudBackend {
  private modules: CloudModules | null;

  private readonly storageBucket: string | null;

  private readonly files: FileSystem | null;

  /** The gateway passes the modules it already loaded; anything else loads them on first use. */
  constructor(modules?: CloudModules, options: CloudBackendOptions = {}) {
    this.modules = modules ?? null;
    this.storageBucket = options.storageBucket ?? null;
    this.files = options.fs ?? null;
  }

  /** Storage, pinned to SilentSum's bucket. See `CloudBackendOptions.storageBucket`. */
  private get storage(): ReturnType<StorageModule['getStorage']> {
    const { app, storage } = this.m;
    return this.storageBucket === null
      ? storage.getStorage()
      : storage.getStorage(app.getApp(), `gs://${this.storageBucket}`);
  }

  private get m(): CloudModules {
    const loaded = this.modules ?? loadCloudModules();
    this.modules = loaded;
    return loaded;
  }

  get currentUser(): CloudUser | null {
    const { auth } = this.m;
    const user = auth.getAuth().currentUser;
    return user === null ? null : toCloudUser(user);
  }

  onAuthStateChanged(listener: (user: CloudUser | null) => void): () => void {
    const { auth } = this.m;
    return auth.onAuthStateChanged(auth.getAuth(), (user: User | null) => {
      listener(user === null ? null : toCloudUser(user));
    });
  }

  async signIn(email: string, password: string): Promise<CloudUser> {
    const { auth } = this.m;
    const credential = await guard(() =>
      auth.signInWithEmailAndPassword(auth.getAuth(), email, password),
    );
    return toCloudUser(credential.user);
  }

  async signUp(email: string, password: string): Promise<CloudUser> {
    const { auth } = this.m;
    const credential = await guard(() =>
      auth.createUserWithEmailAndPassword(auth.getAuth(), email, password),
    );
    return toCloudUser(credential.user);
  }

  /**
   * Mails a reset link. Deliberately callable while signed out -- that is the whole situation it
   * exists for -- and it is the only auth call in this file that needs no current user.
   *
   * With e-mail enumeration protection on (the Firebase default for new projects) this resolves
   * for an address that has no account, which is the behaviour the screens are written against.
   */
  async sendPasswordReset(email: string): Promise<void> {
    const { auth } = this.m;
    await guard(() => auth.sendPasswordResetEmail(auth.getAuth(), email));
  }

  async signOut(): Promise<void> {
    const { auth } = this.m;
    await guard(() => auth.signOut(auth.getAuth()));
  }

  /**
   * Re-proves the account password for the signed-in user, refreshing what the provider counts as
   * a recent login. The credential is built from the account's own e-mail, never from anything the
   * caller supplies, so this can only ever re-authenticate the user already in session.
   */
  async reauthenticate(password: string): Promise<void> {
    const { auth } = this.m;
    const user = auth.getAuth().currentUser;
    if (user === null || user.email === null) {
      throw new CloudError(CLOUD_ERROR_CODES.unauthenticated);
    }
    const credential = auth.EmailAuthProvider.credential(user.email, password);
    await guard(() => auth.reauthenticateWithCredential(user, credential));
  }

  /**
   * Deletes the auth account only. Stored documents and blobs are removed by `BackupService.disable`
   * before this is called; the server has no cascade.
   */
  async deleteAccount(): Promise<void> {
    const { auth } = this.m;
    const user = auth.getAuth().currentUser;
    if (user === null) throw new CloudError(CLOUD_ERROR_CODES.unauthenticated);
    await guard(() => auth.deleteUser(user));
  }

  async putDocument(
    path: string,
    data: Record<string, unknown>,
    options?: { readonly merge?: boolean },
  ): Promise<void> {
    const { firestore } = this.m;
    const payload = withFieldValues(data, firestore.increment);
    const reference = firestore.doc(firestore.getFirestore(), path);
    await guard(() =>
      options?.merge === true
        ? firestore.setDoc(reference, payload, { merge: true })
        : firestore.setDoc(reference, payload),
    );
  }

  async getDocument(path: string): Promise<Record<string, unknown> | null> {
    const { firestore } = this.m;
    const snapshot = await guard(() =>
      firestore.getDoc(firestore.doc(firestore.getFirestore(), path)),
    );
    const data = snapshot.data();
    return data === undefined ? null : data;
  }

  async deleteDocument(path: string): Promise<void> {
    const { firestore } = this.m;
    await guard(() => firestore.deleteDoc(firestore.doc(firestore.getFirestore(), path)));
  }

  /**
   * A live listener on one document. Firestore delivers the current value first, then every
   * change, which is exactly the contract; a permission refusal arrives through `onError`.
   */
  watchDocument(
    path: string,
    onChange: (doc: Record<string, unknown> | null) => void,
    onError?: (error: CloudError) => void,
  ): () => void {
    const { firestore } = this.m;
    return firestore.onSnapshot(
      firestore.doc(firestore.getFirestore(), path),
      (snapshot) => {
        const data = snapshot.data();
        onChange(data === undefined ? null : data);
      },
      (error: unknown) => {
        onError?.(toCloudError(error));
      },
    );
  }

  /**
   * The collection form. Firestore needs an index for nothing here: one `orderBy` on a single
   * collection is served by the automatic single-field index.
   */
  watchCollection(
    path: string,
    query: CollectionQuery,
    onChange: (entries: CollectionEntry[]) => void,
    onError?: (error: CloudError) => void,
  ): () => void {
    const { firestore } = this.m;
    let built = firestore.query(firestore.collection(firestore.getFirestore(), path));
    const filter = query.arrayContains;
    if (filter !== undefined) {
      built = firestore.query(built, firestore.where(filter.field, 'array-contains', filter.value));
    }
    if (query.orderBy !== undefined) {
      built = firestore.query(built, firestore.orderBy(query.orderBy, query.direction ?? 'asc'));
    }
    if (query.limit !== undefined) {
      built = firestore.query(built, firestore.limit(query.limit));
    }
    return firestore.onSnapshot(
      built,
      (snapshot) => {
        onChange(snapshot.docs.map((entry) => ({ id: entry.id, data: entry.data() })));
      },
      (error: unknown) => {
        onError?.(toCloudError(error));
      },
    );
  }

  async putBlob(path: string, bytes: Bytes): Promise<void> {
    const { storage } = this.m;
    const reference = storage.ref(this.storage, path);
    await guard(() =>
      taskDone(storage.uploadBytesResumable(reference, bytes, { contentType: BLOB_CONTENT_TYPE })),
    );
  }

  /**
   * The file form of the same upload. `putFile` streams from disk inside the native SDK, so a
   * 300 MB encrypted video is transferred without ever being a `Uint8Array` in JavaScript -- which
   * is the only reason videos of that size can be backed up from a phone at all.
   */
  async putBlobFromFile(path: string, localUri: string): Promise<void> {
    const { storage } = this.m;
    const reference = storage.ref(this.storage, path);
    await guard(() =>
      taskDone(storage.putFile(reference, localUri, { contentType: BLOB_CONTENT_TYPE })),
    );
  }

  /**
   * The file form of the same download, and the primitive `getBlob` is itself built on: the object
   * lands directly where the caller wants it and is never read into memory here.
   */
  async getBlobToFile(path: string, localUri: string): Promise<void> {
    const files = this.files;
    if (files !== null) await files.makeDirectory(uriDirname(localUri));
    const { storage } = this.m;
    await guard(() => taskDone(storage.writeToFile(storage.ref(this.storage, path), localUri)));
  }

  /**
   * Downloads through the Storage SDK, which authenticates the request with the signed-in user's
   * own token and is checked against the bucket's rules like any other call.
   *
   * It deliberately does NOT use `getDownloadURL`. That mints a download token into the object's
   * metadata and hands back a URL that is a bearer credential for the object - anyone who obtains
   * it can read that object, with no sign-in, until the token is rotated. Nothing else in this
   * app hands out a credential like that, and a backup does not need one.
   *
   * RNFirebase has no in-memory download (`getBytes` throws "not implemented"), so the object
   * lands in the app-private cache and is read and deleted immediately. It is ciphertext the whole
   * way: the same bytes that sit in the vault on disk.
   */
  async getBlob(path: string): Promise<Bytes> {
    const files = this.files;
    if (files === null) {
      throw new CloudError(CLOUD_ERROR_CODES.unknown, 'downloads need app-private storage');
    }
    const { storage } = this.m;
    const directory = `${files.cacheDirectory.replace(/\/$/, '')}/silentsum-restore`;
    const target = `${directory}/${path.replace(/[^A-Za-z0-9.]+/g, '_')}`;
    await files.makeDirectory(directory);
    try {
      await guard(() => taskDone(storage.writeToFile(storage.ref(this.storage, path), target)));
      return await files.readBytes(target);
    } finally {
      await files.deleteFile(target).catch(() => undefined);
    }
  }

  /** A blob that is already gone is not an error: deletion is idempotent for the backup sweep. */
  async deleteBlob(path: string): Promise<void> {
    const { storage } = this.m;
    try {
      await storage.deleteObject(storage.ref(this.storage, path));
    } catch (error) {
      const mapped = toCloudError(error);
      if (mapped.code !== CLOUD_ERROR_CODES.objectNotFound) throw mapped;
    }
  }

  /** Immediate children only; `listAll` sub-folder prefixes are ignored, as the contract requires. */
  async listBlobs(prefix: string): Promise<string[]> {
    const { storage } = this.m;
    const result = await guard(() => storage.listAll(storage.ref(this.storage, prefix)));
    return result.items.map((item) => item.name);
  }
}
