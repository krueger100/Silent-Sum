/**
 * Boots the REAL app, screens, navigator, lifecycle guard and all, against in-memory fakes.
 *
 * Nothing here stubs a screen or a service interface: the only substitutions are at the platform
 * boundary (file system, secure store, settings file, image codec, clock, CSPRNG cost). That is
 * what makes these tests worth something, because they exercise the same composition the device
 * runs.
 */
import React from 'react';
import { render, type RenderResult } from '@testing-library/react-native';

import { SilentSumApp } from '@/app/SilentSumApp';
import { createServices, type ServiceOverrides, type Services } from '@/app/services';
import { KDF_PRESETS } from '@/crypto/types';
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
import { FakeThumbnailGenerator } from '@/vault/thumbnailGenerator';
import { FakeClock } from '@/utils/clock';

export interface Harness {
  services: Services;
  fs: InMemoryFileSystem;
  secureStore: InMemorySecureStore;
  settingsStore: InMemorySettingsStore;
  clock: FakeClock;
  screenProtection: RecordingScreenProtection;
  cloud: InMemoryCloudBackend | null;
}

export function buildHarness(
  options: { withCloud?: boolean; overrides?: ServiceOverrides } = {},
): Harness {
  const fs = new InMemoryFileSystem();
  const secureStore = new InMemorySecureStore();
  const settingsStore = new InMemorySettingsStore();
  const clock = new FakeClock();
  const screenProtection = new RecordingScreenProtection();
  const cloud = options.withCloud === true ? new InMemoryCloudBackend() : null;

  const firebase: FirebaseServices =
    cloud === null
      ? FIREBASE_UNAVAILABLE
      : {
          available: true,
          crash: new NoopCrashReporter(),
          analytics: new NoopAnalyticsService(),
          cloud,
        };

  const services = createServices({
    fs,
    secureStore,
    settingsStore,
    clock,
    screenProtection,
    firebase,
    thumbnails: new FakeThumbnailGenerator(),
    // A real 32 MiB Argon2id derivation per unlock would make the suite take minutes.
    kdfParams: KDF_PRESETS.forTests,
    ...options.overrides,
  });

  return { services, fs, secureStore, settingsStore, clock, screenProtection, cloud };
}

/**
 * `render` is asynchronous in @testing-library/react-native 14, as are `fireEvent`, `rerender` and
 * `unmount`. Awaiting it is what keeps React's act environment satisfied.
 */
export async function renderApp(harness: Harness): Promise<RenderResult> {
  return render(<SilentSumApp services={harness.services} />);
}

/** Types a number on the calculator keypad, one digit at a time. */
export function digitKeysFor(value: string): string[] {
  return [...value].map((digit) => `calc_key_digit${digit}`);
}
