/**
 * Thumbnail production.
 *
 * `expo-image-manipulator` uses the platform image codecs, so a 12 MP JPEG is decoded and scaled
 * natively instead of in JavaScript. Its `saveAsync` always writes the result to a cache file,
 * which is a plaintext image, so that file is securely deleted the moment its bytes have been
 * read. Nothing plaintext is left behind by this module.
 *
 * When the caller already has a temporary file (camera capture, picker copy) it passes the URI and
 * the source is read natively. Otherwise the bytes are handed over as a base64 data URI, encoded
 * with the native encoder.
 */
import { toBase64, fromBase64 } from '@/crypto/sodium';
import type { SecureDelete } from '@/storage/secureDelete';
import {
  ImageDecodeError,
  THUMBNAIL,
  type ImageInput,
  type ThumbnailGenerator,
  type ThumbnailResult,
} from '@/vault/types';

interface ManipulatorImage {
  width: number;
  height: number;
  saveAsync(options: {
    format: unknown;
    compress: number;
    base64: boolean;
  }): Promise<{ uri: string; width: number; height: number; base64?: string }>;
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
  // Required lazily so a missing native module surfaces as a decode failure on the one screen
  // that needs it, rather than crashing app startup.

  return require('expo-image-manipulator') as ManipulatorModule;
}

export class ExpoThumbnailGenerator implements ThumbnailGenerator {
  constructor(private readonly secureDelete: SecureDelete) {}

  async generate(
    image: ImageInput,
    maxDimension: number = THUMBNAIL.defaultMaxDimension,
  ): Promise<ThumbnailResult> {
    const { ImageManipulator, SaveFormat } = loadManipulator();
    const source = image.uri ?? `data:image/jpeg;base64,${toBase64(image.bytes)}`;

    let savedUri: string | null = null;
    try {
      // Render once with no actions to learn the orientation-corrected source size.
      const original = await ImageManipulator.manipulate(source).renderAsync();
      const sourceWidth = original.width;
      const sourceHeight = original.height;
      if (sourceWidth <= 0 || sourceHeight <= 0) {
        throw new ImageDecodeError('image reported a zero dimension');
      }

      const longest = Math.max(sourceWidth, sourceHeight);
      const context = ImageManipulator.manipulate(source);
      if (longest > maxDimension) {
        // Constrain the longer edge; the other is scaled to preserve the aspect ratio.
        if (sourceWidth >= sourceHeight) context.resize({ width: maxDimension });
        else context.resize({ height: maxDimension });
      }

      const rendered = await context.renderAsync();
      const saved = await rendered.saveAsync({
        format: SaveFormat.JPEG,
        compress: THUMBNAIL.jpegQuality / 100,
        base64: true,
      });
      savedUri = saved.uri;
      if (saved.base64 === undefined) throw new ImageDecodeError('no base64 in manipulator result');

      return {
        jpegBytes: fromBase64(saved.base64),
        thumbWidth: saved.width,
        thumbHeight: saved.height,
        sourceWidth,
        sourceHeight,
      };
    } catch (cause) {
      if (cause instanceof ImageDecodeError) throw cause;
      throw new ImageDecodeError(cause);
    } finally {
      // The manipulator's own output file is plaintext; it must not outlive this call.
      if (savedUri !== null) await this.secureDelete.file(savedUri);
    }
  }
}

/**
 * Deterministic generator for tests: no native codecs, no files. Produces a byte pattern that
 * stands in for JPEG data and reports the dimensions it was told to report.
 */
export class FakeThumbnailGenerator implements ThumbnailGenerator {
  constructor(
    private readonly sourceWidth = 1200,
    private readonly sourceHeight = 900,
  ) {}

  calls = 0;
  failOnNextCall = false;

  /**
   * The size the last caller asked for. Chat media must regenerate at 256, not reuse the vault's
   * 512px preview -- a mistake that would pass every other check and be refused by the Storage
   * rules on a real device.
   */
  lastMaxDimension: number | null = null;

  async generate(
    image: ImageInput,
    maxDimension: number = THUMBNAIL.defaultMaxDimension,
  ): Promise<ThumbnailResult> {
    this.calls += 1;
    this.lastMaxDimension = maxDimension;
    if (this.failOnNextCall) {
      this.failOnNextCall = false;
      throw new ImageDecodeError('fake decode failure');
    }
    const scale = Math.min(1, maxDimension / Math.max(this.sourceWidth, this.sourceHeight));
    const jpegBytes = new Uint8Array(64);
    jpegBytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
    for (let i = 4; i < jpegBytes.length; i++) {
      jpegBytes[i] = (image.bytes.at(i % Math.max(image.bytes.length, 1)) ?? 0) ^ 0x5a;
    }
    return {
      jpegBytes,
      thumbWidth: Math.max(1, Math.round(this.sourceWidth * scale)),
      thumbHeight: Math.max(1, Math.round(this.sourceHeight * scale)),
      sourceWidth: this.sourceWidth,
      sourceHeight: this.sourceHeight,
    };
  }
}
