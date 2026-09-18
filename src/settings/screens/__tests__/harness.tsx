/**
 * Settings screens run against the real composition root with in-memory adapters, so a toggle test
 * proves the value actually reaches the persistent store, not just the zustand store.
 */
import React, { type ReactElement } from 'react';
import { render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';

import { ServicesProvider } from '@/app/ServicesProvider';
import { ThemeProvider } from '@/app/ThemeProvider';
import { createServices, type ServiceOverrides, type Services } from '@/app/services';
import { KDF_PRESETS } from '@/crypto';
import { NoopAnalyticsService, NoopCrashReporter, type FirebaseServices } from '@/firebase/types';
import { RecordingScreenProtection } from '@/privacy/types';
import { InMemorySecureStore } from '@/secure-storage/secureStore';
import { InMemorySettingsStore } from '@/settings/appSettings';
import { InMemoryFileSystem } from '@/storage/inMemoryFileSystem';
import { FakeClock } from '@/utils/clock';
import { FakeThumbnailGenerator } from '@/vault/thumbnailGenerator';

export const TEST_METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

export interface Harness {
  readonly services: Services;
  readonly settingsStore: InMemorySettingsStore;
  readonly screenProtection: RecordingScreenProtection;
  readonly crash: NoopCrashReporter;
  readonly analytics: NoopAnalyticsService;
}

export function buildHarness(
  options: { firebaseAvailable?: boolean } & ServiceOverrides = {},
): Harness {
  const { firebaseAvailable = false, ...overrides } = options;
  const settingsStore = new InMemorySettingsStore();
  const screenProtection = new RecordingScreenProtection();
  const crash = new NoopCrashReporter();
  const analytics = new NoopAnalyticsService();
  const firebase: FirebaseServices = {
    available: firebaseAvailable,
    crash,
    analytics,
    cloud: null,
  };
  const services = createServices({
    fs: new InMemoryFileSystem(),
    secureStore: new InMemorySecureStore(),
    settingsStore,
    clock: new FakeClock(),
    screenProtection,
    thumbnails: new FakeThumbnailGenerator(),
    kdfParams: KDF_PRESETS.forTests,
    firebase,
    ...overrides,
  });
  return { services, settingsStore, screenProtection, crash, analytics };
}

export function renderWithServices(
  services: Services,
  element: ReactElement,
): ReturnType<typeof render> {
  return render(
    <SafeAreaProvider initialMetrics={TEST_METRICS}>
      <ServicesProvider services={services}>
        <ThemeProvider>{element}</ThemeProvider>
      </ServicesProvider>
    </SafeAreaProvider>,
  );
}
