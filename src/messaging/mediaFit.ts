/**
 * Making media small enough to send, instead of refusing it.
 *
 * The chat ceilings are not arbitrary: the Storage rules enforce them on the object itself, so a
 * photo over the limit is not a preference the client can override. But refusing the send was the
 * wrong answer, because what the user was asked to do about it -- "choose a smaller photo" -- is
 * not something a camera roll offers. The picker is opened with `quality: 1`, so a photo arrives at
 * whatever size the camera wrote it, and on a recent phone that is routinely 6-8 MB with the 8 MB
 * cap a few hundred kilobytes away.
 *
 * So an oversized photo is re-encoded smaller, here, before anything is encrypted or uploaded, and
 * only the reduced copy is sent. Three things follow from that:
 *
 *  - A photo already inside its budget is passed through UNTOUCHED. Re-encoding one would cost
 *    quality for nothing, and the cheapest path has to be the one that does nothing.
 *  - The reduction happens on bytes in memory, through the same `ThumbnailGenerator` the vault
 *    already uses. That generator writes its output to a cache file and securely deletes it before
 *    returning, so no plaintext copy of anybody's photo outlives the call.
 *  - The original file is never modified or removed. A retry re-reads it and re-derives the
 *    reduced copy, which is why nothing has to hold plaintext between attempts.
 *
 * Video has no path through here. There is no transcoder in this app, so its ceiling stays hard and
 * the screen says so instead of pretending a retry could help.
 */
import { THUMB_MAX_EDGE } from '@/messaging/media';
import type { Bytes } from '@/utils/bytes';
import type { ImageInput, ThumbnailGenerator } from '@/vault/types';

/**
 * Long edges tried in order for a photo that must be made smaller.
 *
 * It starts at 2048 because that is still a photo -- larger than any phone screen shows a chat
 * image at -- and a 2048px JPEG at the generator's quality 82 lands well under a megabyte for
 * ordinary subject matter. Each step down is about 20%, so the common case is one re-encode and
 * the list only matters for an image that compresses unusually badly.
 */
export const PHOTO_SEND_EDGES: readonly number[] = [2048, 1600, 1280, 1024, 800];

/**
 * The same ladder for a chat preview, starting at the size a preview is supposed to be.
 *
 * The first entry must stay `THUMB_MAX_EDGE`: an in-budget preview has to come out of the first
 * attempt, so a normal send still costs exactly one generation.
 */
export const THUMB_SEND_EDGES: readonly number[] = [THUMB_MAX_EDGE, 192, 160, 128];

/** Just the part of the generator this needs, so a spec can hand in anything that re-encodes. */
export type ImageEncoder = Pick<ThumbnailGenerator, 'generate'>;

export interface Encoded {
  readonly bytes: Bytes;
  /** The long edge that produced it, for the log line and for tests to assert against. */
  readonly edge: number;
}

/**
 * Re-encodes `image` at successively smaller long edges and returns the first result that fits
 * `cap`, or null when even the smallest does not.
 *
 * A decode failure is NOT caught here. An image the platform cannot read is a different problem
 * from one that will not shrink, and the caller tells them apart -- `ImageDecodeError` is
 * classified as a permanent failure with its own wording.
 */
export async function encodeUnderCap(
  image: ImageInput,
  cap: number,
  edges: readonly number[],
  encoder: ImageEncoder,
): Promise<Encoded | null> {
  for (const edge of edges) {
    const result = await encoder.generate(image, edge);
    if (result.jpegBytes.length <= cap) return { bytes: result.jpegBytes, edge };
  }
  return null;
}

export type PhotoFit =
  /** Already within budget. These are the original bytes, not a re-encode of them. */
  | { readonly kind: 'as-is'; readonly bytes: Bytes }
  | { readonly kind: 'reduced'; readonly bytes: Bytes; readonly edge: number }
  /** Not even the smallest edge fits. Nothing about trying again changes that. */
  | { readonly kind: 'too-large' };

export async function fitPhotoForSending(
  plain: Bytes,
  cap: number,
  encoder: ImageEncoder,
): Promise<PhotoFit> {
  if (plain.length <= cap) return { kind: 'as-is', bytes: plain };
  const encoded = await encodeUnderCap({ bytes: plain }, cap, PHOTO_SEND_EDGES, encoder);
  return encoded === null ? { kind: 'too-large' } : { kind: 'reduced', ...encoded };
}
