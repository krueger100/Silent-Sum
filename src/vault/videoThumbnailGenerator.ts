/**
 * Poster frames for vault videos.
 *
 * `expo-video-thumbnails` pulls a single frame out of the recording with the platform's own media
 * extractor and writes it to a cache file. That file is a plaintext still of the video, so it is
 * securely deleted the moment its bytes have been read -- the same rule the photo thumbnail
 * pipeline follows, for the same reason.
 *
 * The frame is then handed to the ORDINARY {@link ThumbnailGenerator}: it is resized and
 * re-encoded by exactly the code that makes photo thumbnails, so a video tile in the gallery is
 * the same kind of JPEG, at the same size and quality, inside the same `thumbs/<id>.enc` blob. The
 * gallery needs no second rendering path, and a poster frame gets the same confidentiality as
 * everything else in the vault.
 *
 * The frame is not taken at t=0: the first frame of a recording is frequently black while exposure
 * settles, and a vault full of black tiles would be useless.
 */
import type { SecureDelete } from '@/storage/secureDelete';
import type { FileSystem } from '@/storage/fileSystem';
import {
  ImageDecodeError,
  THUMBNAIL,
  type ThumbnailGenerator,
  type ThumbnailResult,
  type VideoThumbnailGenerator,
} from '@/vault/types';
import { zeroBytes } from '@/utils/bytes';

/** Far enough in to be past the first exposure, short enough to exist in a one-second clip. */
const POSTER_TIME_MS = 300;

interface ThumbnailsModule {
  getThumbnailAsync(
    source: string,
    options?: { time?: number; quality?: number },
  ): Promise<{ uri: string; width: number; height: number }>;
}

function loadThumbnails(): ThumbnailsModule {
  // Required lazily so a missing native module surfaces as a decode failure on the one screen that
  // needs it, rather than crashing app startup.

  return require('expo-video-thumbnails') as ThumbnailsModule;
}

export class ExpoVideoThumbnailGenerator implements VideoThumbnailGenerator {
  constructor(
    private readonly fs: FileSystem,
    private readonly secureDelete: SecureDelete,
    private readonly thumbnails: ThumbnailGenerator,
  ) {}

  async generate(
    videoUri: string,
    maxDimension: number = THUMBNAIL.defaultMaxDimension,
  ): Promise<ThumbnailResult> {
    const module = loadThumbnails();
    let posterUri: string | null = null;
    try {
      // A clip shorter than the requested time yields its last frame rather than failing, but a
      // player that refuses outright still has to leave us with a tile, so t=0 is the fallback.
      let frame;
      try {
        frame = await module.getThumbnailAsync(videoUri, { time: POSTER_TIME_MS, quality: 1 });
      } catch {
        frame = await module.getThumbnailAsync(videoUri, { time: 0, quality: 1 });
      }
      posterUri = frame.uri;

      const bytes = await this.fs.readBytes(frame.uri);
      try {
        const result = await this.thumbnails.generate({ bytes, uri: frame.uri }, maxDimension);
        // The extractor knows the video frame size; the manipulator only sees a still. They agree
        // in practice, and preferring the extractor keeps the stored dimensions the video's own.
        return frame.width > 0 && frame.height > 0
          ? { ...result, sourceWidth: frame.width, sourceHeight: frame.height }
          : result;
      } finally {
        zeroBytes(bytes);
      }
    } catch (cause) {
      if (cause instanceof ImageDecodeError) throw cause;
      throw new ImageDecodeError(cause);
    } finally {
      // The extractor's output file is a plaintext frame of the video; it must not outlive this call.
      if (posterUri !== null) await this.secureDelete.file(posterUri);
    }
  }
}

/** Deterministic generator for tests: no native codecs, no files. */
export class FakeVideoThumbnailGenerator implements VideoThumbnailGenerator {
  constructor(
    private readonly sourceWidth = 1280,
    private readonly sourceHeight = 720,
  ) {}

  calls = 0;
  failOnNextCall = false;

  async generate(
    _videoUri: string,
    maxDimension: number = THUMBNAIL.defaultMaxDimension,
  ): Promise<ThumbnailResult> {
    this.calls += 1;
    if (this.failOnNextCall) {
      this.failOnNextCall = false;
      throw new ImageDecodeError('fake poster failure');
    }
    const scale = Math.min(1, maxDimension / Math.max(this.sourceWidth, this.sourceHeight));
    const jpegBytes = new Uint8Array(96);
    jpegBytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
    for (let i = 4; i < jpegBytes.length; i++) jpegBytes[i] = (i * 7) & 0xff;
    return {
      jpegBytes,
      thumbWidth: Math.max(1, Math.round(this.sourceWidth * scale)),
      thumbHeight: Math.max(1, Math.round(this.sourceHeight * scale)),
      sourceWidth: this.sourceWidth,
      sourceHeight: this.sourceHeight,
    };
  }
}
