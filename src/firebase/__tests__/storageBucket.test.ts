/**
 * Vault ciphertext must land in SilentSum's own Storage bucket, never the project default.
 *
 * The project this app is registered in has a default bucket whose deployed rules allow public
 * read and any-signed-in write over every path. Storage rules OR together within a bucket, so a
 * stricter owner-only rule for `users/<uid>/**` there could not take those grants away. The only
 * arrangement that gives SilentSum owner-only access without editing rules another app relies on
 * is a bucket of its own, which carries its own ruleset - hence these tests.
 */
import { FirebaseCloudBackend, type CloudModules } from '@/firebase/firebaseCloudBackend';
import type * as GatewayNamespace from '@/firebase/firebaseGateway';
import { InMemoryFileSystem } from '@/storage/inMemoryFileSystem';
import { CloudError } from '@/firebase/types';

const BUCKET = 'silentsum-vault.firebasestorage.app';

interface StorageCall {
  readonly app: unknown;
  readonly bucketUrl: unknown;
}

const APP = { name: '[DEFAULT]' };

function stubModules(calls: StorageCall[]): CloudModules {
  const storage = {
    getStorage: (app?: unknown, bucketUrl?: unknown) => {
      calls.push({ app, bucketUrl });
      return { kind: 'storage' };
    },
    ref: (instance: unknown, path: string) => ({ instance, path }),
    listAll: async () => ({ items: [] }),
    deleteObject: async () => undefined,
  };
  return {
    app: { getApp: () => APP },
    auth: {},
    firestore: {},
    storage,
  } as unknown as CloudModules;
}

describe('FirebaseCloudBackend storage bucket', () => {
  it('addresses the bucket the build names, not the project default', async () => {
    const calls: StorageCall[] = [];
    const backend = new FirebaseCloudBackend(stubModules(calls), { storageBucket: BUCKET });

    await backend.listBlobs('users/abc/photos');

    expect(calls).toEqual([{ app: APP, bucketUrl: `gs://${BUCKET}` }]);
  });

  it('uses the same bucket for every blob operation', async () => {
    const calls: StorageCall[] = [];
    const backend = new FirebaseCloudBackend(stubModules(calls), { storageBucket: BUCKET });

    await backend.listBlobs('users/abc/photos');
    await backend.deleteBlob('users/abc/photos/1.enc');

    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.bucketUrl).toBe(`gs://${BUCKET}`);
  });

  it('falls back to the default bucket only when no bucket was named at all', async () => {
    const calls: StorageCall[] = [];

    await new FirebaseCloudBackend(stubModules(calls)).listBlobs('users/abc/photos');

    expect(calls).toEqual([{ app: undefined, bucketUrl: undefined }]);
  });
});

/** The gateway is what makes sure that fallback is never reachable in a real build. */
describe('initializeFirebase storage bucket', () => {
  const PACKAGES: Readonly<Record<string, () => unknown>> = {
    '@react-native-firebase/app': () => ({ getApps: () => [APP], getApp: () => APP }),
    '@react-native-firebase/crashlytics': () => ({
      getCrashlytics: () => ({}),
      setCrashlyticsCollectionEnabled: jest.fn(),
      recordError: jest.fn(),
      log: jest.fn(),
    }),
    '@react-native-firebase/analytics': () => ({
      getAnalytics: () => ({}),
      setAnalyticsCollectionEnabled: jest.fn(),
      logEvent: jest.fn(),
    }),
    '@react-native-firebase/app-check': () => ({
      ReactNativeFirebaseAppCheckProvider: class {
        configure(): void {
          // no-op
        }
      },
      initializeAppCheck: jest.fn(),
    }),
    '@react-native-firebase/auth': () => ({}),
    '@react-native-firebase/firestore': () => ({}),
    '@react-native-firebase/storage': () => ({ getStorage: () => ({}) }),
  };

  function loadGatewayWithMocks(): typeof GatewayNamespace {
    jest.resetModules();
    for (const [id, factory] of Object.entries(PACKAGES)) jest.doMock(id, factory);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@/firebase/firebaseGateway') as typeof GatewayNamespace;
  }

  afterEach(() => {
    for (const id of Object.keys(PACKAGES)) jest.dontMock(id);
    jest.resetModules();
  });

  it('offers no cloud backend at all when the build names no bucket', async () => {
    const services = await loadGatewayWithMocks().initializeFirebase('prod', { configured: true });

    // Crash reporting and analytics still work; only backup is withheld.
    expect(services.available).toBe(true);
    expect(services.cloud).toBeNull();
  });

  it('treats an empty bucket name as no bucket', async () => {
    const services = await loadGatewayWithMocks().initializeFirebase('prod', {
      configured: true,
      storageBucket: '',
    });

    expect(services.cloud).toBeNull();
  });

  it('gives back a cloud backend once a bucket is named', async () => {
    const services = await loadGatewayWithMocks().initializeFirebase('prod', {
      configured: true,
      storageBucket: BUCKET,
    });

    expect(services.available).toBe(true);
    expect(services.cloud).not.toBeNull();
  });
});

/**
 * Restore downloads go through the SDK, authenticated as the signed-in user. `getDownloadURL`
 * mints a bearer credential into the object's metadata that reads the object with no sign-in at
 * all, for as long as the token lives - nothing else in this app hands one out, and a backup does
 * not need one.
 */
describe('FirebaseCloudBackend downloads', () => {
  const PAYLOAD = new Uint8Array([0x53, 0x53, 0x56, 0x31, 0x01, 0x01, 0x99]);

  interface Seen {
    urls: number;
    targets: string[];
  }

  function downloadModules(files: InMemoryFileSystem, seen: Seen): CloudModules {
    const storage = {
      getStorage: () => ({ kind: 'storage' }),
      ref: (_instance: unknown, path: string) => ({ path }),
      getDownloadURL: () => {
        seen.urls += 1;
        return Promise.resolve('https://example.test/bearer-token');
      },
      writeToFile: (_ref: unknown, target: string) => {
        seen.targets.push(target);
        const done = files.writeBytes(target, PAYLOAD);
        return {
          then: (ok: () => void, err: (error: unknown) => void) => {
            void done.then(ok, err);
          },
        };
      },
    };
    return {
      app: { getApp: () => APP },
      auth: {},
      firestore: {},
      storage,
    } as unknown as CloudModules;
  }

  it('reads the object through the SDK and never mints a download URL', async () => {
    const files = new InMemoryFileSystem();
    const seen: Seen = { urls: 0, targets: [] };
    const backend = new FirebaseCloudBackend(downloadModules(files, seen), {
      storageBucket: BUCKET,
      fs: files,
    });

    const bytes = await backend.getBlob('users/abc/photos/1.enc');

    expect(bytes).toEqual(PAYLOAD);
    expect(seen.urls).toBe(0);
    expect(seen.targets).toHaveLength(1);
  });

  it('leaves nothing behind on disk once the bytes have been read', async () => {
    const files = new InMemoryFileSystem();
    const seen: Seen = { urls: 0, targets: [] };
    const backend = new FirebaseCloudBackend(downloadModules(files, seen), {
      storageBucket: BUCKET,
      fs: files,
    });

    await backend.getBlob('users/abc/photos/1.enc');

    const target = seen.targets[0];
    if (target === undefined) throw new Error('nothing was downloaded');
    expect(target.startsWith(files.cacheDirectory.replace(/\/$/, ''))).toBe(true);
    expect(target).toContain('silentsum-restore');
    expect(await files.exists(target)).toBe(false);
  });

  it('refuses to download at all with nowhere app-private to put the bytes', async () => {
    const files = new InMemoryFileSystem();
    const seen: Seen = { urls: 0, targets: [] };
    const backend = new FirebaseCloudBackend(downloadModules(files, seen), {
      storageBucket: BUCKET,
    });

    await expect(backend.getBlob('users/abc/photos/1.enc')).rejects.toBeInstanceOf(CloudError);
    expect(seen.targets).toHaveLength(0);
  });
});
