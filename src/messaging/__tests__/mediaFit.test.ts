/**
 * Making a photo fit, and knowing when it will not.
 *
 * The behaviour that matters most here is the one that does nothing: a photo already inside its
 * budget must be passed through untouched, because re-encoding one costs quality for no reason and
 * the common case has to be free.
 *
 * The byte counts are small on purpose. Only the comparisons matter -- over the cap, under it, and
 * which rung of the ladder produced the result -- so a spec that allocated real 8 MB photos would
 * spend forty seconds proving arithmetic.
 */
import { THUMB_MAX_EDGE } from '@/messaging/media';
import {
  PHOTO_SEND_EDGES,
  THUMB_SEND_EDGES,
  encodeUnderCap,
  fitPhotoForSending,
  type ImageEncoder,
} from '@/messaging/mediaFit';
import { FakeThumbnailGenerator } from '@/vault/thumbnailGenerator';
import { ImageDecodeError } from '@/vault/types';

function photo(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = i & 0xff;
  return bytes;
}

/** Output weight follows the area: halve the long edge, quarter the bytes, as a JPEG roughly does. */
function sized(bytesAtTopEdge: number): FakeThumbnailGenerator {
  const generator = new FakeThumbnailGenerator();
  const top = PHOTO_SEND_EDGES[0] ?? 2048;
  generator.sizeForEdge = (edge) => bytesAtTopEdge * (edge / top) ** 2;
  return generator;
}

describe('fitPhotoForSending', () => {
  it('passes an in-budget photo through without touching the encoder', async () => {
    const generator = sized(1000);
    const bytes = photo(5000);

    const fit = await fitPhotoForSending(bytes, 8000, generator);

    expect(fit).toEqual({ kind: 'as-is', bytes });
    // The same object, not a copy: nothing re-encoded it.
    expect(fit.kind === 'as-is' && fit.bytes).toBe(bytes);
    expect(generator.calls).toBe(0);
  });

  it('treats a photo exactly on its budget as in-budget', async () => {
    const generator = sized(100);
    const bytes = photo(2048);

    expect(await fitPhotoForSending(bytes, 2048, generator)).toEqual({ kind: 'as-is', bytes });
    expect(generator.calls).toBe(0);
  });

  it('re-encodes an oversized photo at the first edge that fits', async () => {
    // 2000 bytes at 2048 px; 1600 px gives ~1220, the first under a 1500-byte budget.
    const generator = sized(2000);

    const fit = await fitPhotoForSending(photo(9000), 1500, generator);

    expect(fit.kind).toBe('reduced');
    if (fit.kind !== 'reduced') throw new Error('expected a reduction');
    expect(fit.edge).toBe(1600);
    expect(fit.bytes.length).toBeLessThanOrEqual(1500);
    expect(generator.edges).toEqual([2048, 1600]);
  });

  it('stops at the first edge when that already fits, so quality is not thrown away', async () => {
    const generator = sized(100);

    const fit = await fitPhotoForSending(photo(10_000), 1000, generator);

    expect(fit.kind === 'reduced' && fit.edge).toBe(2048);
    expect(generator.edges).toEqual([2048]);
  });

  it('reports too-large when even the smallest edge will not fit', async () => {
    const generator = new FakeThumbnailGenerator();
    generator.sizeForEdge = () => 5000;

    const fit = await fitPhotoForSending(photo(6000), 1000, generator);

    expect(fit).toEqual({ kind: 'too-large' });
    // Every rung was tried before giving up.
    expect(generator.edges).toEqual([...PHOTO_SEND_EDGES]);
  });

  it('lets a decode failure through rather than reporting it as too large', async () => {
    // An image the platform cannot read is a different problem from one that will not shrink, and
    // the two have different answers: pick another photo, versus this one cannot be sent at all.
    const generator = new FakeThumbnailGenerator();
    generator.failOnNextCall = true;

    await expect(fitPhotoForSending(photo(9000), 1024, generator)).rejects.toBeInstanceOf(
      ImageDecodeError,
    );
  });
});

describe('encodeUnderCap', () => {
  it('starts the preview ladder at the size a preview is meant to be', () => {
    // An ordinary send must cost exactly one generation, which only holds if the first rung is the
    // chat thumbnail size itself.
    expect(THUMB_SEND_EDGES[0]).toBe(THUMB_MAX_EDGE);
  });

  it('walks down until the output fits', async () => {
    const generator = new FakeThumbnailGenerator();
    generator.sizeForEdge = (edge) => (edge >= 192 ? 400 : 150);

    const encoded = await encodeUnderCap({ bytes: photo(10) }, 200, THUMB_SEND_EDGES, generator);

    expect(encoded).not.toBeNull();
    expect(encoded?.bytes.length).toBeLessThanOrEqual(200);
    expect(encoded?.edge).toBe(160);
    expect(generator.edges).toEqual([256, 192, 160]);
  });

  it('returns null rather than something over the cap', async () => {
    const encoder: ImageEncoder = {
      generate: async () => ({
        jpegBytes: new Uint8Array(5000),
        thumbWidth: 1,
        thumbHeight: 1,
        sourceWidth: 1,
        sourceHeight: 1,
      }),
    };

    expect(await encodeUnderCap({ bytes: photo(10) }, 100, [256, 128], encoder)).toBeNull();
  });
});
