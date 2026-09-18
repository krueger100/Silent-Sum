/**
 * `AnalyticsService` implementations.
 *
 * The event catalogue (`ANALYTICS_EVENTS`), the no-op service and `logEventSafely` live in
 * `@/firebase/types` — `FIREBASE_UNAVAILABLE` needs the no-op, and typing `logEvent` against the
 * catalogue is what stops a free-text event name from ever being logged. They are re-exported here
 * so the whole analytics surface can be imported from one module.
 *
 * Analytics is opt-in and coarse by construction: five fixed event names, parameters limited to
 * `string | number`, and no user id, photo id, file name or e-mail anywhere. Nothing in this file
 * imports `@react-native-firebase/analytics`; the SDK is reached through `AnalyticsPort`, which the
 * gateway builds only after the native module is known to exist.
 */
import type { AnalyticsEventName, AnalyticsService } from '@/firebase/types';

export { ANALYTICS_EVENTS, NoopAnalyticsService, logEventSafely } from '@/firebase/types';

/** Parameters an event may carry. Deliberately not `unknown`: only coarse scalars are allowed. */
export type AnalyticsParams = Record<string, string | number>;

/** The slice of `@react-native-firebase/analytics` this module uses. */
export interface AnalyticsPort {
  setCollectionEnabled(enabled: boolean): Promise<void>;
  logEvent(name: string, params?: AnalyticsParams): Promise<void>;
}

export interface RecordedEvent {
  readonly name: AnalyticsEventName;
  readonly params?: AnalyticsParams;
}

/** Test double. Mirrors the real gating: nothing is recorded until analytics is enabled. */
export class RecordingAnalytics implements AnalyticsService {
  readonly events: RecordedEvent[] = [];
  enabled = false;

  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
  }

  async logEvent(name: AnalyticsEventName, params?: AnalyticsParams): Promise<void> {
    if (this.enabled) this.events.push({ name, params });
  }
}

/**
 * Firebase Analytics, off until `setEnabled(true)`.
 *
 * The flag is checked in JS before the SDK is called, so a disabled build makes no native call at
 * all — the manifest already disables collection, and this keeps it that way even if the native
 * default ever changes. `setEnabled` swallows SDK failures (a consent toggle must not be able to
 * fail); `logEvent` does not, because callers reach it through `logEventSafely`.
 */
export class FirebaseAnalytics implements AnalyticsService {
  private enabled = false;

  constructor(private readonly analytics: AnalyticsPort) {}

  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    try {
      await this.analytics.setCollectionEnabled(enabled);
    } catch {
      // Collection state is best effort; the local flag above still gates every event.
    }
  }

  async logEvent(name: AnalyticsEventName, params?: AnalyticsParams): Promise<void> {
    if (!this.enabled) return;
    await this.analytics.logEvent(name, params);
  }
}
