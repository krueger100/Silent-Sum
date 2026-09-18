/**
 * The one place that decides whether this build has Firebase at all.
 *
 * `app.config.ts` adds the RNFirebase config plugins and `googleServicesFile` only when a native
 * config file for the platform exists, so a build without one has no native Firebase in it. This
 * gateway detects that at runtime and hands the app `FIREBASE_UNAVAILABLE`: no-op crash reporting,
 * no-op analytics, no cloud backend. The calculator and the offline vault are unaffected — Firebase
 * is never required to unlock anything.
 *
 * `initializeFirebase` never throws and never rejects. Every failure mode — a missing native
 * module, no configured app, a plugin that blows up on import, App Check refusing to activate — is
 * a reason to run offline, never a reason to fail app start.
 *
 * The RNFirebase packages are `require`d inside the functions below, with literal specifiers so
 * Metro can still resolve them statically. Importing them at module scope would run native
 * initialisation as a side effect of loading this file, which is exactly what must not happen on an
 * unconfigured build (or under Jest).
 */
import { FirebaseAnalytics, type AnalyticsParams, type AnalyticsPort } from '@/firebase/analytics';
import { FirebaseCrashReporter, type CrashlyticsPort } from '@/firebase/crashReporter';
import {
  FirebaseCloudBackend,
  loadCloudModules,
  type CloudModules,
} from '@/firebase/firebaseCloudBackend';
import { FIREBASE_UNAVAILABLE, type FirebaseServices } from '@/firebase/types';
import type { FileSystem } from '@/storage/fileSystem';
import type * as AnalyticsNamespace from '@react-native-firebase/analytics';
import type * as AppNamespace from '@react-native-firebase/app';
import type * as AppCheckNamespace from '@react-native-firebase/app-check';
import type * as CrashlyticsNamespace from '@react-native-firebase/crashlytics';

export type SilentSumEnv = 'dev' | 'prod';

export interface FirebaseGatewayOptions {
  /**
   * App Check debug token for dev builds. `app.config.ts` exposes it as `extra.appCheckDebugToken`;
   * the composition root reads it from there and passes it in, so this module needs no config
   * dependency of its own. Never set for prod.
   */
  readonly appCheckDebugToken?: string;

  /**
   * Whether this build actually has Firebase compiled in. `app.config.ts` knows at build time and
   * publishes it as `extra.firebaseConfigured`.
   *
   * This must be consulted BEFORE any `require`, because wrapping `require` in try/catch is not
   * enough: when a module throws while loading, Metro hands the error to
   * `ErrorUtils.reportFatalError` before the caller's catch ever runs, which tears down a release
   * build even though the error was "handled". The only safe thing is to never require the module.
   *
   * Defaults to false, so a caller that does not know gets the offline behaviour rather than a
   * crash.
   */
  readonly configured?: boolean;

  /**
   * SilentSum's own Storage bucket, from `extra.firebaseStorageBucket`.
   *
   * Without it there is no cloud backend: backup is simply not offered. See
   * `CloudBackendOptions.storageBucket` for why the project default bucket is not an acceptable
   * fallback. Crash reporting and analytics are unaffected either way.
   */
  readonly storageBucket?: string;

  /** App-private storage for restore downloads; see `CloudBackendOptions.fs`. */
  readonly fs?: FileSystem;
}

type AppModule = typeof AppNamespace;
type CrashlyticsModule = typeof CrashlyticsNamespace;
type AnalyticsModule = typeof AnalyticsNamespace;
type AppCheckModule = typeof AppCheckNamespace;

const DEV = (globalThis as { __DEV__?: boolean }).__DEV__ === true;

function note(message: string): void {
  // Bootstrap diagnostics only, and only in development: this never contains user data.
  if (DEV) console.warn(`[silentsum] ${message}`);
}

/* eslint-disable @typescript-eslint/no-require-imports */
function requireApp(): AppModule | null {
  try {
    return require('@react-native-firebase/app') as AppModule;
  } catch {
    return null;
  }
}

function requireCrashlytics(): CrashlyticsModule | null {
  try {
    return require('@react-native-firebase/crashlytics') as CrashlyticsModule;
  } catch {
    return null;
  }
}

function requireAnalytics(): AnalyticsModule | null {
  try {
    return require('@react-native-firebase/analytics') as AnalyticsModule;
  } catch {
    return null;
  }
}

function requireAppCheck(): AppCheckModule | null {
  try {
    return require('@react-native-firebase/app-check') as AppCheckModule;
  } catch {
    return null;
  }
}
/* eslint-enable @typescript-eslint/no-require-imports */

function requireCloud(): CloudModules | null {
  try {
    return loadCloudModules();
  } catch {
    return null;
  }
}

function crashlyticsPort(module: CrashlyticsModule): CrashlyticsPort {
  const crashlytics = module.getCrashlytics();
  return {
    setCollectionEnabled: async (enabled) => {
      await module.setCrashlyticsCollectionEnabled(crashlytics, enabled);
    },
    recordError: (error, jsErrorName) => {
      module.recordError(crashlytics, error, jsErrorName);
    },
    log: (message) => {
      module.log(crashlytics, message);
    },
  };
}

function analyticsPort(module: AnalyticsModule): AnalyticsPort {
  const analytics = module.getAnalytics();
  return {
    setCollectionEnabled: (enabled) => module.setAnalyticsCollectionEnabled(analytics, enabled),
    // The custom-event overload is fire-and-forget in RNFirebase; the port promises a promise.
    logEvent: async (name: string, params?: AnalyticsParams) => {
      module.logEvent(analytics, name, params);
    },
  };
}

/**
 * Play Integrity / App Attest in prod, the debug providers in dev. Failure is logged and ignored:
 * App Check hardens the backend, and an app that cannot attest should still start, still unlock and
 * still work offline — it will simply be refused by the rules if it tries to sync.
 */
function activateAppCheck(env: SilentSumEnv, app: AppModule, debugToken?: string): void {
  const module = requireAppCheck();
  if (module === null) {
    note('App Check module unavailable, skipping activation');
    return;
  }
  try {
    const isProd = env === 'prod';
    const provider = new module.ReactNativeFirebaseAppCheckProvider();
    provider.configure({
      android: { provider: isProd ? 'playIntegrity' : 'debug', debugToken },
      apple: { provider: isProd ? 'appAttestWithDeviceCheckFallback' : 'debug', debugToken },
    });
    module.initializeAppCheck(app.getApp(), { provider, isTokenAutoRefreshEnabled: true });
  } catch (error) {
    note(`App Check activation failed: ${String(error)}`);
  }
}

/**
 * Returns the Firebase-backed services, or `FIREBASE_UNAVAILABLE` when this build has no usable
 * Firebase. Safe to call unconditionally at app start.
 */
export async function initializeFirebase(
  env: SilentSumEnv,
  options: FirebaseGatewayOptions = {},
): Promise<FirebaseServices> {
  // Checked first and outside the try: see FirebaseGatewayOptions.configured for why a catch
  // around the require below cannot save us.
  if (options.configured !== true) {
    note('Firebase not configured for this build, continuing offline');
    return FIREBASE_UNAVAILABLE;
  }

  try {
    const app = requireApp();
    if (app === null) {
      note('Firebase not compiled into this build, continuing offline');
      return FIREBASE_UNAVAILABLE;
    }

    // No native config file means no default app was registered at launch.
    if (app.getApps().length === 0) {
      note('Firebase not configured, continuing offline');
      return FIREBASE_UNAVAILABLE;
    }

    const crashlytics = requireCrashlytics();
    const analytics = requireAnalytics();
    const cloud = requireCloud();
    if (crashlytics === null || analytics === null || cloud === null) {
      note('Firebase modules incomplete, continuing offline');
      return FIREBASE_UNAVAILABLE;
    }

    activateAppCheck(env, app, options.appCheckDebugToken);

    return {
      available: true,
      crash: new FirebaseCrashReporter(crashlyticsPort(crashlytics)),
      analytics: new FirebaseAnalytics(analyticsPort(analytics)),
      cloud:
        options.storageBucket === undefined || options.storageBucket === ''
          ? null
          : new FirebaseCloudBackend(cloud, {
              storageBucket: options.storageBucket,
              ...(options.fs === undefined ? {} : { fs: options.fs }),
            }),
    };
  } catch (error) {
    note(`Firebase initialisation failed, continuing offline: ${String(error)}`);
    return FIREBASE_UNAVAILABLE;
  }
}
