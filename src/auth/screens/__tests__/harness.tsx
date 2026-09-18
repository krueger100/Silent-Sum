/**
 * Boots the whole app composition root against in-memory adapters and renders a screen inside it.
 *
 * Screens only ever see `Services`, so this is the real wiring - real Argon2id (on the deliberately
 * weak test preset), real XChaCha20, real vault repository - with the platform edges swapped out.
 */
import React, { type ReactElement } from 'react';
import { render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';

import { ServicesProvider } from '@/app/ServicesProvider';
import { createServices, type ServiceOverrides, type Services } from '@/app/services';
import { KDF_PRESETS } from '@/crypto';
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
  readonly secureStore: InMemorySecureStore;
  readonly settingsStore: InMemorySettingsStore;
  readonly clock: FakeClock;
  readonly screenProtection: RecordingScreenProtection;
}

export function buildHarness(overrides: ServiceOverrides = {}): Harness {
  const fs = new InMemoryFileSystem();
  const secureStore = new InMemorySecureStore();
  const settingsStore = new InMemorySettingsStore();
  const clock = new FakeClock();
  const screenProtection = new RecordingScreenProtection();
  const services = createServices({
    fs,
    secureStore,
    settingsStore,
    clock,
    screenProtection,
    thumbnails: new FakeThumbnailGenerator(),
    kdfParams: KDF_PRESETS.forTests,
    ...overrides,
  });
  return { services, fs, secureStore, settingsStore, clock, screenProtection };
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
