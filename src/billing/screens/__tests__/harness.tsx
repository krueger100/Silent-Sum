/**
 * The plans screen against the real composition root, with the payment provider and the backend
 * played by `InMemoryBillingService`: it hands out a fake hosted page and, on `completePayment`,
 * writes the entitlement document exactly as the webhook does on the server.
 *
 * `renderPlans` also starts the entitlements controller, which the app shell does in production;
 * without it the screen would never hear about a payment landing.
 */
import React, { type ReactElement } from 'react';
import { render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';

import { ServicesProvider } from '@/app/ServicesProvider';
import { ThemeProvider } from '@/app/ThemeProvider';
import { createServices, type ServiceOverrides, type Services } from '@/app/services';
import { InMemoryBillingService } from '@/billing/billingService';
import { KDF_PRESETS } from '@/crypto';
import { InMemoryCloudBackend } from '@/firebase/cloudBackend';
import {
  FIREBASE_UNAVAILABLE,
  NoopAnalyticsService,
  NoopCrashReporter,
  type FirebaseServices,
} from '@/firebase/types';
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

export const EMAIL = 'buyer@example.test';
export const ACCOUNT_PASSWORD = 'account-password';

export interface BillingHarness {
  readonly services: Services;
  readonly cloud: InMemoryCloudBackend;
  readonly billing: InMemoryBillingService;
  readonly clock: FakeClock;
  readonly secureStore: InMemorySecureStore;
  readonly fs: InMemoryFileSystem;
}

/** A build that can sell: cloud backend plus the simulated billing backend. */
export function buildBillingHarness(overrides: ServiceOverrides = {}): BillingHarness {
  const cloud = new InMemoryCloudBackend();
  const clock = new FakeClock();
  const billing = new InMemoryBillingService(cloud, clock);
  const secureStore = new InMemorySecureStore();
  const fs = new InMemoryFileSystem();
  const firebase: FirebaseServices = {
    available: true,
    crash: new NoopCrashReporter(),
    analytics: new NoopAnalyticsService(),
    cloud,
    billing,
  };
  const services = createServices({
    fs,
    clock,
    secureStore,
    settingsStore: new InMemorySettingsStore(),
    screenProtection: new RecordingScreenProtection(),
    thumbnails: new FakeThumbnailGenerator(),
    kdfParams: KDF_PRESETS.forTests,
    firebase,
    ...overrides,
  });
  return { services, cloud, billing, clock, secureStore, fs };
}

/** A build with no Firebase at all: nothing to sell, nothing gated. */
export function buildOfflineHarness(): { services: Services } {
  const services = createServices({
    fs: new InMemoryFileSystem(),
    clock: new FakeClock(),
    secureStore: new InMemorySecureStore(),
    settingsStore: new InMemorySettingsStore(),
    screenProtection: new RecordingScreenProtection(),
    thumbnails: new FakeThumbnailGenerator(),
    kdfParams: KDF_PRESETS.forTests,
    firebase: FIREBASE_UNAVAILABLE,
  });
  return { services };
}

function wrap(services: Services, element: ReactElement): ReactElement {
  return (
    <SafeAreaProvider initialMetrics={TEST_METRICS}>
      <ServicesProvider services={services}>
        <ThemeProvider>{element}</ThemeProvider>
      </ServicesProvider>
    </SafeAreaProvider>
  );
}

export function renderWithServices(
  services: Services,
  element: ReactElement,
): ReturnType<typeof render> {
  return render(wrap(services, element));
}

/**
 * Renders again with a FRESH element. `rerender` with the very same element object is a no-op:
 * React sees identical props and bails out, so a test that advanced the clock would still be
 * looking at the old date.
 */
export async function rerenderWithServices(
  rendered: Awaited<ReturnType<typeof render>>,
  services: Services,
  element: () => ReactElement,
): Promise<void> {
  await rendered.rerender(wrap(services, element()));
}

/** Loads the cache and starts following the account, as the app shell does at boot. */
export async function startEntitlements(services: Services): Promise<() => void> {
  await services.entitlements.load();
  return services.entitlements.start();
}
