/**
 * Two flavours of composition root for the cloud screens:
 *   - `buildHarness()` has no Firebase at all, which is what the "not available" branch must cope
 *     with;
 *   - `buildCloudHarness()` wires an `InMemoryCloudBackend`, which enforces the same owner-only
 *     rules as the deployed Firestore/Storage rules.
 *
 * A single backend instance can be shared between two harnesses to model "the same account on a
 * different device", which is exactly what the restore flow is for.
 */
import React, { type ReactElement } from 'react';
import { render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';

import { ServicesProvider } from '@/app/ServicesProvider';
import { createServices, type ServiceOverrides, type Services } from '@/app/services';
import { KDF_PRESETS } from '@/crypto';
import { InMemoryCloudBackend } from '@/firebase/cloudBackend';
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
  readonly fs: InMemoryFileSystem;
  readonly settingsStore: InMemorySettingsStore;
  readonly clock: FakeClock;
}

export interface CloudHarness extends Harness {
  readonly cloud: InMemoryCloudBackend;
}

export function buildHarness(overrides: ServiceOverrides = {}): Harness {
  const fs = new InMemoryFileSystem();
  const settingsStore = new InMemorySettingsStore();
  const clock = new FakeClock();
  const services = createServices({
    fs,
    settingsStore,
    clock,
    secureStore: new InMemorySecureStore(),
    screenProtection: new RecordingScreenProtection(),
    thumbnails: new FakeThumbnailGenerator(),
    kdfParams: KDF_PRESETS.forTests,
    ...overrides,
  });
  return { services, fs, settingsStore, clock };
}

export function buildCloudHarness(
  cloud: InMemoryCloudBackend = new InMemoryCloudBackend(),
): CloudHarness {
  const firebase: FirebaseServices = {
    available: true,
    crash: new NoopCrashReporter(),
    analytics: new NoopAnalyticsService(),
    cloud,
  };
  return { ...buildHarness({ firebase }), cloud };
}

export function renderWithServices(
  services: Services,
  element: ReactElement,
): ReturnType<typeof render> {
  return render(
    <SafeAreaProvider initialMetrics={TEST_METRICS}>
      <ServicesProvider services={services}>{element}</ServicesProvider>
    </SafeAreaProvider>,
  );
}

/** A vault with `count` photos, unlocked and open, as a signed-out device would have. */
export async function openVaultWithPhotos(
  harness: Harness,
  pin: string,
  count: number,
): Promise<void> {
  const keys = await harness.services.auth.setupPin(pin);
  harness.services.session.adopt(keys);
  const repository = await harness.services.vault.open(keys);
  for (let index = 0; index < count; index++) {
    const bytes = new Uint8Array(512).fill(index + 1);
    await repository.addPhoto({ bytes }, { source: 'import' });
  }
}
