/**
 * Capture inspection: the gate between the camera and the vault.
 *
 * A camera can hand back a file that is technically an image and visually nothing -- a truncated
 * frame, a frame grabbed before the sensor's exposure loop had converged, or a placeholder that
 * never came from a sensor at all: `expo-camera` shipped a black stand-in for every capture taken
 * on an emulator (see `patches/expo-camera+57.0.5.patch`). Encrypting any of those is worse than
 * failing: the vault is the only copy, so a blank photo is a silently lost photo.
 *
 * So every capture is inspected before `addPhoto` is allowed to see it:
 *
 *  1. The container is parsed in JS -- SOI, a real frame header with non-zero dimensions, and a
 *     terminating EOI. This catches truncation without decoding anything.
 *  2. The pixels are sampled. The full image is never decoded in JavaScript; it is downscaled by
 *     the platform codec to a probe a few dozen pixels wide, and only that probe is decoded. A
 *     frame whose brightest pixel is still essentially black did not capture a scene.
 *
 * The probe file the manipulator writes is plaintext, so it is securely deleted in a `finally`,
 * and the probe bytes are zeroed, exactly like the capture itself.
 */
import { decode } from 'jpeg-js';

import { fromBase64 } from '@/crypto/sodium';
import type { SecureDelete } from '@/storage/secureDelete';
import { zeroBytes, type Bytes } from '@/utils/bytes';

export type CaptureRejection = 'malformed' | 'blank';

export type CaptureVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: CaptureRejection };

export interface CaptureInput {
  /** The capture's own plaintext bytes, already read by the caller. */
  readonly bytes: Bytes;
  /** The plugin's cache file, used for the native downscale. */
  readonly uri: string;
}

export interface CaptureInspector {
  inspect(capture: CaptureInput): Promise<CaptureVerdict>;
}

/** Width of the downscaled probe decoded in JS: small enough to be free, wide enough to sample. */
export const PROBE_WIDTH = 48;

/**
 * Thresholds for "this frame carries no picture".
 *
 * A single bright pixel is not enough to call a frame good: the black frames this emulator's
 * capture pipeline produces still contain a few stray lit pixels in one corner (measured: peak
 * luma 226 over a frame whose mean luma is 0.06 and whose lit pixels are 0.07% of the image). So a
 * frame is blank when nothing is bright anywhere, or when it is dark *and* practically nothing in
 * it is lit. A real photograph of a dark room clears the second test on ambient light alone.
 */
export const BLANK_PEAK_LUMA = 10;
/** Mean luma under which a frame counts as unlit. */
export const BLANK_MEAN_LUMA = 2;
/** Luma above which a pixel counts as carrying signal rather than noise. */
export const LIT_LUMA = 16;
/** Share of lit pixels under which an unlit frame counts as blank. */
export const BLANK_LIT_FRACTION = 0.005;

export interface JpegFrameHeader {
  readonly width: number;
  readonly height: number;
}

/** Start-of-frame markers: baseline, progressive, lossless and their arithmetic variants. */
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/** Markers that stand alone: no length field follows them. */
const STANDALONE_MARKERS = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8]);

function hasEndOfImage(bytes: Bytes): boolean {
  // Encoders may pad after EOI, so look through the tail rather than at the last two bytes.
  const stop = Math.max(0, bytes.length - 32);
  for (let i = bytes.length - 2; i >= stop; i--) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) return true;
  }
  return false;
}

/**
 * Parses the JPEG container far enough to prove it is whole and describes a real image.
 * Returns null for anything that is not a complete JPEG with non-zero dimensions.
 */
export function readJpegFrameHeader(bytes: Bytes): JpegFrameHeader | null {
  if (bytes.length < 4) return null;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  if (!hasEndOfImage(bytes)) return null;

  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    // 0xff may repeat as fill before the marker byte itself.
    let markerAt = offset + 1;
    let marker = bytes[markerAt] ?? 0;
    while (marker === 0xff && markerAt + 1 < bytes.length) {
      markerAt += 1;
      marker = bytes[markerAt] ?? 0;
    }
    if (marker === 0xd9) return null; // EOI before any frame header.
    if (STANDALONE_MARKERS.has(marker)) {
      offset = markerAt + 1;
      continue;
    }
    if (markerAt + 2 >= bytes.length) return null;
    const length = ((bytes[markerAt + 1] ?? 0) << 8) | (bytes[markerAt + 2] ?? 0);
    if (length < 2) return null;
    if (SOF_MARKERS.has(marker)) {
      // length(2) precision(1) height(2) width(2)
      if (markerAt + 8 >= bytes.length) return null;
      const height = ((bytes[markerAt + 4] ?? 0) << 8) | (bytes[markerAt + 5] ?? 0);
      const width = ((bytes[markerAt + 6] ?? 0) << 8) | (bytes[markerAt + 7] ?? 0);
      if (width <= 0 || height <= 0) return null;
      return { width, height };
    }
    if (marker === 0xda) return null; // Scan data reached without a frame header.
    offset = markerAt + 1 + length;
  }
  return null;
}

export interface FrameStats {
  /** Brightest pixel, as ITU-R BT.601 luma. */
  readonly peak: number;
  /** Mean luma across the frame. */
  readonly mean: number;
  /** Share of pixels above {@link LIT_LUMA}, from 0 to 1. */
  readonly litFraction: number;
}

/** Luma statistics of an interleaved 8-bit buffer. */
export function measureFrame(pixels: Uint8Array, channels: number): FrameStats {
  let peak = 0;
  let total = 0;
  let lit = 0;
  let count = 0;
  for (let i = 0; i + channels <= pixels.length; i += channels) {
    const luma =
      ((pixels[i] ?? 0) * 299 + (pixels[i + 1] ?? 0) * 587 + (pixels[i + 2] ?? 0) * 114) / 1000;
    total += luma;
    count += 1;
    if (luma > peak) peak = luma;
    if (luma > LIT_LUMA) lit += 1;
  }
  if (count === 0) return { peak: 0, mean: 0, litFraction: 0 };
  return { peak, mean: total / count, litFraction: lit / count };
}

/** True when the frame shows nothing: no bright pixel at all, or dark with almost nothing lit. */
export function isBlankFrame(stats: FrameStats): boolean {
  if (stats.peak < BLANK_PEAK_LUMA) return true;
  return stats.mean < BLANK_MEAN_LUMA && stats.litFraction < BLANK_LIT_FRACTION;
}

interface ManipulatorImage {
  saveAsync(options: { format: unknown; compress: number; base64: boolean }): Promise<{
    uri: string;
    base64?: string;
  }>;
}

interface ManipulatorContext {
  resize(size: { width?: number | null; height?: number | null }): ManipulatorContext;
  renderAsync(): Promise<ManipulatorImage>;
}

interface ManipulatorModule {
  ImageManipulator: { manipulate(source: string): ManipulatorContext };
  SaveFormat: { JPEG: unknown };
}

function loadManipulator(): ManipulatorModule {
  // Lazily required for the same reason as the thumbnail generator: a missing native module must
  // surface as a rejected capture, not a crash at app startup.

  return require('expo-image-manipulator') as ManipulatorModule;
}

export class ExpoCaptureInspector implements CaptureInspector {
  constructor(private readonly secureDelete: SecureDelete) {}

  async inspect({ bytes, uri }: CaptureInput): Promise<CaptureVerdict> {
    if (readJpegFrameHeader(bytes) === null) return { ok: false, reason: 'malformed' };

    let probeUri: string | null = null;
    let probe: Bytes | null = null;
    try {
      const { ImageManipulator, SaveFormat } = loadManipulator();
      const rendered = await ImageManipulator.manipulate(uri)
        .resize({ width: PROBE_WIDTH })
        .renderAsync();
      const saved = await rendered.saveAsync({
        format: SaveFormat.JPEG,
        compress: 1,
        base64: true,
      });
      probeUri = saved.uri;
      if (saved.base64 === undefined) return { ok: false, reason: 'malformed' };
      probe = fromBase64(saved.base64);
      const decoded = decode(probe, { useTArray: true, formatAsRGBA: false });
      if (decoded.data.length === 0) return { ok: false, reason: 'malformed' };
      return isBlankFrame(measureFrame(decoded.data, 3)) ? { ok: false, reason: 'blank' } : { ok: true };
    } catch {
      // The reason is never surfaced or logged: it can carry the cache file's path.
      return { ok: false, reason: 'malformed' };
    } finally {
      zeroBytes(probe);
      if (probeUri !== null) await this.secureDelete.file(probeUri);
    }
  }
}

/** Accepts anything. Used by tests that are not exercising inspection itself. */
export class AcceptingCaptureInspector implements CaptureInspector {
  calls = 0;

  async inspect(): Promise<CaptureVerdict> {
    this.calls += 1;
    return { ok: true };
  }
}

/** Rejects a fixed number of captures, then accepts. Models a camera that warms up slowly. */
export class ScriptedCaptureInspector implements CaptureInspector {
  calls = 0;

  constructor(
    private readonly rejections: number,
    private readonly reason: CaptureRejection = 'blank',
  ) {}

  async inspect(): Promise<CaptureVerdict> {
    this.calls += 1;
    return this.calls <= this.rejections ? { ok: false, reason: this.reason } : { ok: true };
  }
}
