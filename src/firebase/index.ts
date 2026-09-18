/**
 * Public surface of the optional Firebase layer. Import from here, never from a leaf module and
 * never from `@react-native-firebase/*` outside `src/firebase`.
 *
 * Nothing exported here loads a native module at import time: `initializeFirebase` is the only
 * entry point that touches Firebase, and it returns `FIREBASE_UNAVAILABLE` rather than failing when
 * the build has none.
 */
export {
  ANALYTICS_EVENTS,
  CloudError,
  FIREBASE_UNAVAILABLE,
  NoopAnalyticsService,
  NoopCrashReporter,
  logEventSafely,
} from '@/firebase/types';
export type {
  AnalyticsEventName,
  AnalyticsService,
  CloudBackend,
  CloudUser,
  CrashReporter,
  FirebaseServices,
} from '@/firebase/types';

export { PIN_MAX_DIGITS, PIN_MIN_DIGITS, scrub } from '@/utils/scrub';

export { FirebaseCrashReporter, RecordingCrashReporter } from '@/firebase/crashReporter';
export type { CrashlyticsPort, RecordedCrash } from '@/firebase/crashReporter';

export { FirebaseAnalytics, RecordingAnalytics } from '@/firebase/analytics';
export type { AnalyticsParams, AnalyticsPort, RecordedEvent } from '@/firebase/analytics';

export { CLOUD_ERROR_CODES, InMemoryCloudBackend, ownerPrefix } from '@/firebase/cloudBackend';
export type { CloudErrorCode } from '@/firebase/cloudBackend';

export {
  BLOB_CONTENT_TYPE,
  FirebaseCloudBackend,
  toCloudError,
} from '@/firebase/firebaseCloudBackend';
export type { CloudModules } from '@/firebase/firebaseCloudBackend';

export { initializeFirebase } from '@/firebase/firebaseGateway';
export type { FirebaseGatewayOptions, SilentSumEnv } from '@/firebase/firebaseGateway';
