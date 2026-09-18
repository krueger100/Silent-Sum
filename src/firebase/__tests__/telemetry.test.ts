import {
  FirebaseAnalytics,
  RecordingAnalytics,
  type AnalyticsParams,
  type AnalyticsPort,
} from '@/firebase/analytics';
import {
  FirebaseCrashReporter,
  RecordingCrashReporter,
  type CrashlyticsPort,
} from '@/firebase/crashReporter';
import {
  ANALYTICS_EVENTS,
  NoopAnalyticsService,
  NoopCrashReporter,
  logEventSafely,
  type AnalyticsService,
  type CrashReporter,
} from '@/firebase/types';

class FakeCrashlytics implements CrashlyticsPort {
  enabled: boolean | null = null;
  readonly errors: Error[] = [];
  readonly names: (string | undefined)[] = [];
  readonly logs: string[] = [];

  async setCollectionEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
  }

  recordError(error: Error, jsErrorName?: string): void {
    this.errors.push(error);
    this.names.push(jsErrorName);
  }

  log(message: string): void {
    this.logs.push(message);
  }
}

/** Every method fails, the way a native module can once the process is in a bad state. */
const brokenCrashlytics: CrashlyticsPort = {
  setCollectionEnabled: () => Promise.reject(new Error('native bridge gone')),
  recordError: () => {
    throw new Error('native bridge gone');
  },
  log: () => {
    throw new Error('native bridge gone');
  },
};

function lastMessage(crashlytics: FakeCrashlytics): string {
  return crashlytics.errors[crashlytics.errors.length - 1]?.message ?? '';
}

describe('FirebaseCrashReporter', () => {
  it('forwards the collection flag', async () => {
    const crashlytics = new FakeCrashlytics();
    await new FirebaseCrashReporter(crashlytics).setEnabled(true);
    expect(crashlytics.enabled).toBe(true);
  });

  it('scrubs the exception, its name and the reason', async () => {
    const crashlytics = new FakeCrashlytics();
    const reporter = new FirebaseCrashReporter(crashlytics);
    const error = new Error('cannot open /data/user/0/app/vault/4821.enc');
    error.name = 'VaultError at /data/user/0/app/vault';

    await reporter.recordError(error, { reason: 'unlock with pin 4821 failed' });

    const message = lastMessage(crashlytics);
    expect(message).not.toContain('4821');
    expect(message).not.toContain('/data');
    expect(message).toBe('unlock with pin [redacted] failed cannot open [path]');
    expect(crashlytics.errors[0]?.name).toBe('VaultError at [path]');
    expect(crashlytics.names[0]).toBe('VaultError at [path]');
  });

  it('marks fatal reports without a second reporting path', async () => {
    const crashlytics = new FakeCrashlytics();
    const reporter = new FirebaseCrashReporter(crashlytics);

    await reporter.recordError(new Error('boom'), { fatal: true });
    expect(lastMessage(crashlytics)).toBe('[fatal] boom');

    await reporter.recordError(new Error('boom'));
    expect(lastMessage(crashlytics)).toBe('boom');
  });

  it('keeps the original stack so reports stay symbolicable', async () => {
    const crashlytics = new FakeCrashlytics();
    const error = new Error('boom');
    error.stack = 'Error: boom\n    at vaultRepository (/data/app/index.bundle:1:1)';

    await new FirebaseCrashReporter(crashlytics).recordError(error);

    expect(crashlytics.errors[0]?.stack).toBe(error.stack);
  });

  it('scrubs breadcrumbs', () => {
    const crashlytics = new FakeCrashlytics();
    new FirebaseCrashReporter(crashlytics).log('pin 4821 entered');
    expect(crashlytics.logs).toEqual(['pin [redacted] entered']);
  });

  it.each<[string, unknown]>([
    ['a string', 'failed on /data/user/0/app/vault/x.enc'],
    ['a plain object', { path: '/data/user/0/app/vault/x.enc', pin: 4821 }],
    ['null', null],
    ['undefined', undefined],
  ])('scrubs %s thrown as a non-Error', async (_label, thrown) => {
    const crashlytics = new FakeCrashlytics();
    await new FirebaseCrashReporter(crashlytics).recordError(thrown);
    const message = lastMessage(crashlytics);
    expect(message).not.toContain('4821');
    expect(message).not.toContain('/data');
  });

  it('never rejects and never throws when the SDK fails', async () => {
    const reporter = new FirebaseCrashReporter(brokenCrashlytics);
    await expect(reporter.setEnabled(true)).resolves.toBeUndefined();
    await expect(reporter.recordError(new Error('boom'))).resolves.toBeUndefined();
    expect(() => reporter.log('note')).not.toThrow();
  });

  it('has a no-op sibling that does nothing at all', async () => {
    const reporter: CrashReporter = new NoopCrashReporter();
    await expect(reporter.setEnabled(true)).resolves.toBeUndefined();
    await expect(reporter.recordError(new Error('boom'))).resolves.toBeUndefined();
    expect(() => reporter.log('note')).not.toThrow();
  });
});

describe('RecordingCrashReporter', () => {
  it('captures what the caller passed, unscrubbed', async () => {
    const reporter = new RecordingCrashReporter();
    const error = new Error('boom');
    await reporter.setEnabled(true);
    await reporter.recordError(error, { reason: 'why', fatal: true });
    reporter.log('breadcrumb');

    expect(reporter.enabled).toBe(true);
    expect(reporter.crashes).toEqual([{ error, reason: 'why', fatal: true }]);
    expect(reporter.logs).toEqual(['breadcrumb']);
  });
});

class FakeAnalytics implements AnalyticsPort {
  enabled: boolean | null = null;
  readonly events: { name: string; params?: AnalyticsParams }[] = [];

  async setCollectionEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
  }

  async logEvent(name: string, params?: AnalyticsParams): Promise<void> {
    this.events.push({ name, params });
  }
}

describe('FirebaseAnalytics', () => {
  it('logs nothing until it is enabled, and stops again when disabled', async () => {
    const sink = new FakeAnalytics();
    const analytics = new FirebaseAnalytics(sink);

    await analytics.logEvent(ANALYTICS_EVENTS.vaultUnlock);
    expect(sink.events).toEqual([]);

    await analytics.setEnabled(true);
    await analytics.logEvent(ANALYTICS_EVENTS.photoAdded, { source: 'camera' });
    expect(sink.events).toEqual([{ name: 'vault_photo_added', params: { source: 'camera' } }]);

    await analytics.setEnabled(false);
    await analytics.logEvent(ANALYTICS_EVENTS.vaultUnlock);
    expect(sink.events).toHaveLength(1);
    expect(sink.enabled).toBe(false);
  });

  it('stays disabled when the SDK refuses to enable collection', async () => {
    const analytics = new FirebaseAnalytics({
      setCollectionEnabled: () => Promise.reject(new Error('no consent')),
      logEvent: () => Promise.reject(new Error('unreachable')),
    });
    await expect(analytics.setEnabled(false)).resolves.toBeUndefined();
    await expect(analytics.logEvent(ANALYTICS_EVENTS.vaultUnlock)).resolves.toBeUndefined();
  });

  it('has a no-op sibling that does nothing at all', async () => {
    const analytics: AnalyticsService = new NoopAnalyticsService();
    await expect(analytics.setEnabled(true)).resolves.toBeUndefined();
    await expect(analytics.logEvent(ANALYTICS_EVENTS.vaultUnlock)).resolves.toBeUndefined();
  });
});

describe('RecordingAnalytics', () => {
  it('records only while enabled', async () => {
    const analytics = new RecordingAnalytics();
    await analytics.logEvent(ANALYTICS_EVENTS.vaultUnlock);
    await analytics.setEnabled(true);
    await analytics.logEvent(ANALYTICS_EVENTS.backupCompleted, { count: 3 });

    expect(analytics.events).toEqual([{ name: 'vault_backup_completed', params: { count: 3 } }]);
  });
});

describe('logEventSafely', () => {
  it('swallows a rejection instead of surfacing it to the caller', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    const failing: AnalyticsService = {
      setEnabled: async () => undefined,
      logEvent: () => Promise.reject(new Error('analytics is down')),
    };

    expect(() => logEventSafely(failing, ANALYTICS_EVENTS.vaultUnlock)).not.toThrow();
    // Two turns: one for the rejected logEvent, one for the catch handler.
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));

    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
  });

  it('returns before the event is logged instead of blocking the caller', async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    const slow: AnalyticsService = {
      setEnabled: async () => undefined,
      logEvent: () =>
        new Promise<void>((resolve) => {
          release = () => {
            order.push('logged');
            resolve();
          };
        }),
    };

    logEventSafely(slow, ANALYTICS_EVENTS.vaultSetup);
    order.push('caller continued');
    release?.();
    await new Promise((resolve) => setImmediate(resolve));

    expect(order).toEqual(['caller continued', 'logged']);
  });

  it('delivers the event and its coarse params when nothing fails', async () => {
    const analytics = new RecordingAnalytics();
    await analytics.setEnabled(true);

    logEventSafely(analytics, ANALYTICS_EVENTS.restoreCompleted, { count: 12 });
    await new Promise((resolve) => setImmediate(resolve));

    expect(analytics.events).toEqual([{ name: 'vault_restore_completed', params: { count: 12 } }]);
  });
});
