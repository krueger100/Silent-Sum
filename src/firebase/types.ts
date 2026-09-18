/**
 * Firebase is an OPTIONAL remote layer. Everything outside src/firebase talks to these interfaces;
 * only src/firebase/* imports @react-native-firebase packages. When Firebase is not configured the
 * app receives `FIREBASE_UNAVAILABLE` (no-op crash/analytics, no cloud backend).
 */
import type { Bytes } from '@/utils/bytes';

export interface CrashReporter {
  setEnabled(enabled: boolean): Promise<void>;
  /** `error` is stringified and scrubbed before it leaves the device. */
  recordError(error: unknown, options?: { reason?: string; fatal?: boolean }): Promise<void>;
  /** Free-text breadcrumb; scrubbed. */
  log(message: string): void;
}

export interface AnalyticsService {
  setEnabled(enabled: boolean): Promise<void>;
  /** No-op while disabled. Only names from ANALYTICS_EVENTS with coarse params are ever logged. */
  logEvent(name: AnalyticsEventName, params?: Record<string, string | number>): Promise<void>;
}

export const ANALYTICS_EVENTS = {
  vaultSetup: 'vault_setup_completed',
  vaultUnlock: 'vault_unlocked',
  photoAdded: 'vault_photo_added',
  backupCompleted: 'vault_backup_completed',
  restoreCompleted: 'vault_restore_completed',
} as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS];

/** Fire-and-forget: never awaited by callers, never throws. */
export function logEventSafely(
  analytics: AnalyticsService,
  name: AnalyticsEventName,
  params?: Record<string, string | number>,
): void {
  void analytics.logEvent(name, params).catch(() => undefined);
}

export interface CloudUser {
  readonly uid: string;
  readonly email: string | null;
}

export class CloudError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ? `CloudError(${code}: ${message})` : `CloudError(${code})`);
    this.name = 'CloudError';
  }
}

/** Auth + document store + blob store, owner-scoped under `users/<uid>/...`. */
export interface CloudBackend {
  readonly currentUser: CloudUser | null;
  /** Emits on every auth change; returns unsubscribe. */
  onAuthStateChanged(listener: (user: CloudUser | null) => void): () => void;
  signIn(email: string, password: string): Promise<CloudUser>;
  signUp(email: string, password: string): Promise<CloudUser>;
  /**
   * Proves the account password again for the user who is already signed in, which is what makes
   * the session "recent" enough for a sensitive operation.
   *
   * Deleting an account is refused on a stale session, and a session goes stale in minutes. Anything
   * irreversible should call this FIRST, so the refusal arrives before the destruction rather than
   * after it -- the alternative is data already deleted and an account that will not go with it.
   */
  reauthenticate(password: string): Promise<void>;
  /**
   * Asks the provider to mail a password-reset link for `email`.
   *
   * It touches the ACCOUNT and nothing else. The account password wraps no key: the master key is
   * wrapped under the vault PIN locally and under the recovery passphrase in the backup envelope,
   * and neither is derived from, or recoverable through, this. A reset therefore leaves the vault,
   * the envelope and every uploaded blob exactly as they were -- what changes is only what the
   * user types to sign in next time.
   *
   * No sign-in is required to call it, which is the point: the user has lost the password.
   */
  sendPasswordReset(email: string): Promise<void>;
  signOut(): Promise<void>;
  deleteAccount(): Promise<void>;
  putDocument(path: string, data: Record<string, unknown>): Promise<void>;
  getDocument(path: string): Promise<Record<string, unknown> | null>;
  deleteDocument(path: string): Promise<void>;
  /** Uploads with contentType application/octet-stream (required by storage rules). */
  putBlob(path: string, bytes: Bytes): Promise<void>;
  /**
   * The same upload, reading from a local file instead of a buffer. Video ciphertext is hundreds
   * of megabytes and must not pass through JS memory in either direction.
   */
  putBlobFromFile(path: string, localUri: string): Promise<void>;
  /** Throws CloudError('object-not-found') when absent. */
  getBlob(path: string): Promise<Bytes>;
  /** The same download, landing in a local file. Throws CloudError('object-not-found') when absent. */
  getBlobToFile(path: string, localUri: string): Promise<void>;
  /** Missing blob is not an error. */
  deleteBlob(path: string): Promise<void>;
  /** Names (last path segment) of blobs directly under `prefix`. */
  listBlobs(prefix: string): Promise<string[]>;
}

export interface FirebaseServices {
  readonly available: boolean;
  readonly crash: CrashReporter;
  readonly analytics: AnalyticsService;
  readonly cloud: CloudBackend | null;
}

export class NoopCrashReporter implements CrashReporter {
  async setEnabled(): Promise<void> {}
  async recordError(): Promise<void> {}
  log(): void {}
}

export class NoopAnalyticsService implements AnalyticsService {
  async setEnabled(): Promise<void> {}
  async logEvent(): Promise<void> {}
}

export const FIREBASE_UNAVAILABLE: FirebaseServices = {
  available: false,
  crash: new NoopCrashReporter(),
  analytics: new NoopAnalyticsService(),
  cloud: null,
};
