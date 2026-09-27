/**
 * The gateway is the only place allowed to load a native Firebase module, so these tests replace
 * the RNFirebase packages with fakes. Real Firebase is never initialised, here or anywhere else in
 * the suite.
 */
import type * as GatewayNamespace from '@/firebase/firebaseGateway';
import type { FirebaseServices } from '@/firebase/types';

type Gateway = typeof GatewayNamespace;

const FIREBASE_PACKAGES = [
  '@react-native-firebase/app',
  '@react-native-firebase/app-check',
  '@react-native-firebase/analytics',
  '@react-native-firebase/auth',
  '@react-native-firebase/crashlytics',
  '@react-native-firebase/firestore',
  '@react-native-firebase/storage',
];

function missingNativeModule(): never {
  throw new Error('native module RNFBAppModule not found');
}

/** Re-imports the gateway so the mocks installed by the test are the ones it sees. */
function loadGateway(): Gateway {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@/firebase/firebaseGateway') as Gateway;
}

async function initializeWith(appModule: () => unknown): Promise<FirebaseServices> {
  jest.resetModules();
  jest.doMock('@react-native-firebase/app', appModule);
  return loadGateway().initializeFirebase('prod', { configured: true });
}

function expectUnavailable(services: FirebaseServices): void {
  expect(services.available).toBe(false);
  expect(services.cloud).toBeNull();
}

// The gateway logs one diagnostic line per failure in development; keep the suite output clean.
const warn = jest.spyOn(console, 'warn');

describe('initializeFirebase', () => {
  beforeEach(() => {
    warn.mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const id of FIREBASE_PACKAGES) jest.dontMock(id);
    jest.resetModules();
  });

  afterAll(() => {
    warn.mockRestore();
  });

  it('reports unavailable when the native module cannot be loaded', async () => {
    expectUnavailable(await initializeWith(missingNativeModule));
  });

  it('reports unavailable when no app was configured at launch', async () => {
    expectUnavailable(await initializeWith(() => ({ getApps: () => [] })));
  });

  it('reports unavailable when the app module itself misbehaves', async () => {
    expectUnavailable(
      await initializeWith(() => ({
        getApps: () => {
          throw new Error('bridge not ready');
        },
      })),
    );
  });

  it('reports unavailable when the app module is missing getApps entirely', async () => {
    expectUnavailable(await initializeWith(() => ({})));
  });

  it('hands back working no-ops rather than nulls when unavailable', async () => {
    const services = await initializeWith(() => ({ getApps: () => [] }));
    await expect(services.crash.setEnabled(true)).resolves.toBeUndefined();
    await expect(services.crash.recordError(new Error('boom'))).resolves.toBeUndefined();
    expect(() => services.crash.log('note')).not.toThrow();
    await expect(services.analytics.setEnabled(true)).resolves.toBeUndefined();
  });

  it('never rejects, whatever the environment and options', async () => {
    jest.resetModules();
    jest.doMock('@react-native-firebase/app', missingNativeModule);
    const { initializeFirebase } = loadGateway();

    await expect(initializeFirebase('dev', { configured: true })).resolves.toBeDefined();
    await expect(initializeFirebase('prod', { configured: true })).resolves.toBeDefined();
    await expect(
      initializeFirebase('dev', { configured: true, appCheckDebugToken: 'token' }),
    ).resolves.toBeDefined();
  });

  it('keeps going when the app is configured but the other modules are not installed', async () => {
    jest.resetModules();
    jest.doMock('@react-native-firebase/app', () => ({
      getApps: () => [{ name: '[DEFAULT]' }],
      getApp: () => ({ name: '[DEFAULT]' }),
    }));
    for (const id of FIREBASE_PACKAGES.slice(1)) jest.doMock(id, missingNativeModule);

    expectUnavailable(await loadGateway().initializeFirebase('prod', { configured: true }));
  });
});

describe('the public surface', () => {
  it('loads without pulling in a single native Firebase module', () => {
    jest.resetModules();
    for (const id of FIREBASE_PACKAGES) jest.doMock(id, missingNativeModule);
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('@/firebase');
    }).not.toThrow();
    for (const id of FIREBASE_PACKAGES) jest.dontMock(id);
    jest.resetModules();
  });
});

describe('the unconfigured build', () => {
  /**
   * Wrapping `require` in try/catch is not enough on Metro: a module that throws while loading is
   * handed to `ErrorUtils.reportFatalError` before the caller's catch runs, which kills a release
   * build. So when the build has no Firebase config the gateway must not touch the modules at all.
   */
  it('does not require a single Firebase module', async () => {
    jest.resetModules();
    const required: string[] = [];
    for (const id of FIREBASE_PACKAGES) {
      jest.doMock(id, () => {
        required.push(id);
        throw new Error(`Native module for ${id} is not registered.`);
      });
    }

    const services = await loadGateway().initializeFirebase('prod', { configured: false });

    expectUnavailable(services);
    expect(required).toEqual([]);

    for (const id of FIREBASE_PACKAGES) jest.dontMock(id);
    jest.resetModules();
  });

  it('treats a missing `configured` flag as unconfigured', async () => {
    jest.resetModules();
    const required: string[] = [];
    for (const id of FIREBASE_PACKAGES) {
      jest.doMock(id, () => {
        required.push(id);
        throw new Error('should not be reached');
      });
    }

    expectUnavailable(await loadGateway().initializeFirebase('prod', {}));
    expect(required).toEqual([]);

    for (const id of FIREBASE_PACKAGES) jest.dontMock(id);
    jest.resetModules();
  });
});

/**
 * Billing needs three things from the gateway: a cloud backend to read entitlements through,
 * the project id (or an explicit https override) to find the functions, and not having been
 * switched off. Each of the three is checked on its own.
 */
describe('billing', () => {
  const AVAILABLE_MODULES: Readonly<Record<string, () => unknown>> = {
    '@react-native-firebase/app': () => ({
      getApps: () => [{ name: '[DEFAULT]' }],
      getApp: () => ({ name: '[DEFAULT]', options: { projectId: 'demo-project' } }),
    }),
    '@react-native-firebase/crashlytics': () => ({
      getCrashlytics: () => ({}),
      setCrashlyticsCollectionEnabled: async () => undefined,
      recordError: () => undefined,
      log: () => undefined,
    }),
    '@react-native-firebase/analytics': () => ({
      getAnalytics: () => ({}),
      setAnalyticsCollectionEnabled: async () => undefined,
      logEvent: () => undefined,
    }),
    '@react-native-firebase/app-check': () => ({
      ReactNativeFirebaseAppCheckProvider: class {
        configure(): void {}
      },
      initializeAppCheck: () => undefined,
      getAppCheck: () => ({}),
      getToken: async () => ({ token: 'app-check' }),
    }),
    '@react-native-firebase/auth': () => ({
      getAuth: () => ({ currentUser: null }),
      getIdToken: async () => 'id-token',
    }),
    '@react-native-firebase/firestore': () => ({}),
    '@react-native-firebase/storage': () => ({}),
  };

  async function available(
    options: Parameters<Gateway['initializeFirebase']>[1],
  ): Promise<FirebaseServices> {
    jest.resetModules();
    for (const [id, factory] of Object.entries(AVAILABLE_MODULES)) jest.doMock(id, factory);
    return loadGateway().initializeFirebase('prod', { configured: true, ...options });
  }

  function endpointOf(services: FirebaseServices): string | null | undefined {
    return (services.billing as { endpoint?: string | null } | null | undefined)?.endpoint;
  }

  beforeEach(() => {
    warn.mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const id of FIREBASE_PACKAGES) jest.dontMock(id);
    jest.resetModules();
  });

  it("offers billing against the project's own functions once there is a cloud backend", async () => {
    const services = await available({ storageBucket: 'silentsum-vault' });
    expect(services.available).toBe(true);
    expect(services.cloud).not.toBeNull();
    expect(endpointOf(services)).toBe('https://us-central1-demo-project.cloudfunctions.net');
  });

  it('honours an explicit https functions URL and ignores a plaintext one', async () => {
    const explicit = await available({
      storageBucket: 'silentsum-vault',
      billing: { enabled: true, functionsUrl: 'https://billing.example.test/' },
    });
    expect(endpointOf(explicit)).toBe('https://billing.example.test');

    const plaintext = await available({
      storageBucket: 'silentsum-vault',
      billing: { enabled: true, functionsUrl: 'http://billing.example.test' },
    });
    expect(endpointOf(plaintext)).toBe('https://us-central1-demo-project.cloudfunctions.net');
  });

  it('offers no billing without a cloud backend', async () => {
    const services = await available({});
    expect(services.available).toBe(true);
    expect(services.cloud).toBeNull();
    expect(services.billing).toBeNull();
  });

  it('offers no billing when the build turns it off', async () => {
    const services = await available({
      storageBucket: 'silentsum-vault',
      billing: { enabled: false },
    });
    expect(services.cloud).not.toBeNull();
    expect(services.billing).toBeNull();
  });
});
