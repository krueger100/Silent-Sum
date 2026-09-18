/**
 * Shared setup for the vault media screens: a real composition root wired to in-memory fakes, and
 * a render helper that puts a component under the providers it expects.
 *
 * Not a test file (jest only collects `*.test.tsx`). The camera specs import it from here rather
 * than keeping a second copy.
 */
import { render, type RenderResult } from '@testing-library/react-native';
import React, { type ReactElement } from 'react';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';

import { ServicesProvider } from '@/app/ServicesProvider';
import { AcceptingCaptureInspector, type CaptureInspector } from '@/camera/captureInspector';
import { createServices, type ServiceOverrides, type Services } from '@/app/services';
import { KDF_PRESETS } from '@/crypto';
import { InMemorySecureStore } from '@/secure-storage/secureStore';
import { InMemorySettingsStore } from '@/settings/appSettings';
import { InMemoryFileSystem } from '@/storage/inMemoryFileSystem';
import { FakeThumbnailGenerator } from '@/vault/thumbnailGenerator';
import { FakeVideoThumbnailGenerator } from '@/vault/videoThumbnailGenerator';
import {
  ImageDecodeError,
  type ImageInput,
  type ThumbnailGenerator,
  type ThumbnailResult,
  type VaultRepository,
} from '@/vault/types';
import { FakeClock } from '@/utils/clock';
import type { Bytes } from '@/utils/bytes';

/** `SafeAreaProvider` renders nothing until it has metrics, which never arrive under Jest. */
export const TEST_METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

/** First byte of an image the fake generator refuses to decode. */
export const UNDECODABLE = 0xff;

/**
 * Fails for images whose first byte is {@link UNDECODABLE}, so a spec can put one bad picture in
 * the middle of a good selection without reaching into call counters.
 */
export class MarkedThumbnailGenerator implements ThumbnailGenerator {
  private readonly delegate = new FakeThumbnailGenerator();

  async generate(image: ImageInput, maxDimension?: number): Promise<ThumbnailResult> {
    if (image.bytes[0] === UNDECODABLE) throw new ImageDecodeError('marked as undecodable');
    return this.delegate.generate(image, maxDimension);
  }
}

export interface VaultHarness {
  readonly services: Services;
  readonly fs: InMemoryFileSystem;
  readonly repository: VaultRepository;
}

export function buildServices(
  thumbnails: ThumbnailGenerator = new MarkedThumbnailGenerator(),
  // The real inspector decodes a JPEG through the native codecs; specs that are not about
  // inspection hand over fixture bytes, so the default here accepts them.
  captureInspector: CaptureInspector = new AcceptingCaptureInspector(),
  /** For the few specs that need a cloud backend wired in, or another edge replaced. */
  overrides: ServiceOverrides = {},
): {
  services: Services;
  fs: InMemoryFileSystem;
} {
  const fs = new InMemoryFileSystem();
  const services = createServices({
    fs,
    thumbnails,
    // The real one pulls a frame out of a recording with the platform extractor; there is no
    // recording, and no extractor, under Jest.
    videoThumbnails: new FakeVideoThumbnailGenerator(),
    captureInspector,
    clock: new FakeClock(),
    secureStore: new InMemorySecureStore(),
    settingsStore: new InMemorySettingsStore(),
    kdfParams: KDF_PRESETS.forTests,
    ...overrides,
  });
  return { services, fs };
}

/** A configured PIN, an adopted session and an open repository. */
export async function unlockedVault(
  thumbnails: ThumbnailGenerator = new MarkedThumbnailGenerator(),
  captureInspector: CaptureInspector = new AcceptingCaptureInspector(),
): Promise<VaultHarness> {
  const { services, fs } = buildServices(thumbnails, captureInspector);
  const keys = await services.auth.setupPin('1234');
  services.session.adopt(keys);
  const repository = await services.vault.open(keys);
  return { services, fs, repository };
}

/**
 * Deterministic stand-in for a recording: a recognisable MP4-ish header so a spec can search disk
 * and cloud storage for it and prove it is not there.
 */
export function videoBytes(size = 4096): Bytes {
  const bytes = new Uint8Array(size);
  bytes.set([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d], 0);
  for (let i = 12; i < size; i++) bytes[i] = (i * 13 + 5) & 0xff;
  return bytes;
}

/** Deterministic stand-in for image bytes; `firstByte` selects decodability. */
export function imageBytes(firstByte = 0x01, size = 256): Bytes {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 7 + 3) & 0xff;
  bytes[0] = firstByte;
  return bytes;
}

/** `render` is asynchronous in @testing-library/react-native 14; every caller must await it. */
export function renderInVault(services: Services, ui: ReactElement): Promise<RenderResult> {
  return render(
    <SafeAreaProvider initialMetrics={TEST_METRICS}>
      <ServicesProvider services={services}>{ui}</ServicesProvider>
    </SafeAreaProvider>,
  );
}
