/**
 * `CrashReporter` implementations.
 *
 * `NoopCrashReporter` lives in `@/firebase/types` because `FIREBASE_UNAVAILABLE` needs it; it is
 * re-exported here so the three implementations can be imported from one place.
 *
 * Nothing in this file imports `@react-native-firebase/crashlytics`. The Crashlytics module is
 * reached through `CrashlyticsPort`, which the gateway builds after it has confirmed the native
 * module exists — that keeps a missing native module from crashing app start or the Jest run, and
 * makes the scrubbing testable without any Firebase.
 */
import { scrub } from '@/utils/scrub';
import type { CrashReporter } from '@/firebase/types';

export { NoopCrashReporter } from '@/firebase/types';

/** The slice of `@react-native-firebase/crashlytics` this module uses. */
export interface CrashlyticsPort {
  setCollectionEnabled(enabled: boolean): Promise<void>;
  /** Synchronous in RNFirebase: the report is queued natively. */
  recordError(error: Error, jsErrorName?: string): void;
  log(message: string): void;
}

/** What a caller handed to `recordError`, kept verbatim so tests can assert on it. */
export interface RecordedCrash {
  readonly error: unknown;
  readonly reason?: string;
  readonly fatal: boolean;
}

/** Test double. Records without scrubbing: scrubbing is `FirebaseCrashReporter`'s job. */
export class RecordingCrashReporter implements CrashReporter {
  readonly crashes: RecordedCrash[] = [];
  readonly logs: string[] = [];
  enabled = false;

  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
  }

  async recordError(error: unknown, options?: { reason?: string; fatal?: boolean }): Promise<void> {
    this.crashes.push({ error, reason: options?.reason, fatal: options?.fatal ?? false });
  }

  log(message: string): void {
    this.logs.push(message);
  }
}

interface DescribedError {
  readonly name: string;
  readonly message: string;
  readonly stack: string | undefined;
}

/** Turns anything a `catch` can produce into text, without ever invoking user-supplied getters. */
function describeError(error: unknown): DescribedError {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  if (typeof error === 'string') {
    return { name: 'Error', message: error, stack: undefined };
  }
  if (typeof error === 'object' && error !== null) {
    try {
      return { name: 'Error', message: JSON.stringify(error), stack: undefined };
    } catch {
      // Cyclic or otherwise unserialisable: fall through to String().
    }
  }
  return { name: 'Error', message: String(error), stack: undefined };
}

/**
 * Crashlytics-backed reporter. Every value that reaches the SDK is scrubbed first: the exception
 * name, the exception message and the caller's `reason`. Stack traces are forwarded unchanged (see
 * `scrub.ts`). No user id and no custom keys are ever set.
 *
 * RNFirebase records JS errors as non-fatal; `fatal` is carried into the message as a `[fatal]`
 * marker so the distinction survives without a second reporting path.
 *
 * Every method swallows its own failures. Telemetry must never turn into an app failure, and a
 * rejected promise here would surface in a vault flow that has nothing to do with reporting.
 */
export class FirebaseCrashReporter implements CrashReporter {
  constructor(private readonly crashlytics: CrashlyticsPort) {}

  async setEnabled(enabled: boolean): Promise<void> {
    try {
      await this.crashlytics.setCollectionEnabled(enabled);
    } catch {
      // Collection state is best effort; the vault does not depend on it.
    }
  }

  async recordError(error: unknown, options?: { reason?: string; fatal?: boolean }): Promise<void> {
    try {
      const described = describeError(error);
      const parts: string[] = [];
      if (options?.fatal === true) parts.push('[fatal]');
      if (options?.reason !== undefined) parts.push(scrub(options.reason));
      parts.push(scrub(described.message));

      const forwarded = new Error(parts.join(' '));
      forwarded.name = scrub(described.name);
      if (described.stack !== undefined) forwarded.stack = described.stack;

      this.crashlytics.recordError(forwarded, forwarded.name);
    } catch {
      // A report that cannot be filed is dropped, never propagated.
    }
  }

  log(message: string): void {
    try {
      this.crashlytics.log(scrub(message));
    } catch {
      // Breadcrumbs are best effort.
    }
  }
}
