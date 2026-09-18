/**
 * The whole storage pipeline, measured in pixels rather than in promises.
 *
 * This exists because a capture came back black and the storage layer was the suspect. It takes a
 * real JPEG -- encoded here, decoded here -- and follows it through the production cipher, the
 * vault's own files, a cloud backend and the restore path, checking at every hop that the bytes
 * are unchanged and that what comes out still decodes to the same non-black image. Nothing here is
 * mocked except the thumbnail codec, which is native, and the photo blob never passes through it.
 *
 * If this test ever fails, the vault is corrupting images. While it passes, a black photo did not
 * become black in here.
 */
import { sha256 } from '@noble/hashes/sha2';
import { decode, encode } from 'jpeg-js';

import { unlockedVault } from '@/gallery/__tests__/vaultHarness';
import { BACKUP_PATHS } from '@/backup/types';
import { InMemoryCloudBackend } from '@/firebase/cloudBackend';
// The harness default refuses any image starting with 0xff -- which every real JPEG does.
import { FakeThumbnailGenerator } from '@/vault/thumbnailGenerator';
import type { Bytes } from '@/utils/bytes';

/** A real JPEG with structure in it: a bright gradient and a dark corner, so "black" is testable. */
function photoJpeg(width = 160, height = 120): Bytes {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = Math.round((255 * x) / (width - 1));
      data[i + 1] = Math.round((255 * y) / (height - 1));
      data[i + 2] = x < width / 8 && y < height / 8 ? 0 : 180;
      data[i + 3] = 255;
    }
  }
  return new Uint8Array(encode({ data, width, height }, 92).data);
}

interface Pixels {
  readonly width: number;
  readonly height: number;
  readonly peak: number;
  readonly mean: number;
}

/** Decodes a JPEG and measures it, the same way the capture inspector judges a frame. */
function measure(jpeg: Bytes): Pixels {
  const image = decode(jpeg, { useTArray: true, formatAsRGBA: false });
  let peak = 0;
  let total = 0;
  let count = 0;
  for (let i = 0; i + 3 <= image.data.length; i += 3) {
    const luma =
      ((image.data[i] ?? 0) * 299 + (image.data[i + 1] ?? 0) * 587 + (image.data[i + 2] ?? 0) * 114) /
      1000;
    total += luma;
    count += 1;
    if (luma > peak) peak = luma;
  }
  return { width: image.width, height: image.height, peak, mean: total / Math.max(1, count) };
}

function digest(bytes: Bytes): string {
  return Buffer.from(sha256(bytes)).toString('hex');
}

/** SSV1 photo container: magic, format version, key id. See docs/security.md. */
const SSV1_PHOTO_HEADER = [0x53, 0x53, 0x56, 0x31, 0x01, 0x01];

describe('a real photo through the vault', () => {
  it('survives encryption, storage, a cloud round trip and restore with its pixels intact', async () => {
    const original = photoJpeg();
    const originalDigest = digest(original);
    const before = measure(original);
    // The control the camera capture fails: this image is demonstrably not black.
    expect(before.mean).toBeGreaterThan(100);

    const { services, repository } = await unlockedVault(new FakeThumbnailGenerator());
    const entry = await repository.addPhoto(
      { bytes: Uint8Array.from(original) },
      { source: 'camera' },
    );

    // --- what is actually written to disk -------------------------------------------------
    const encrypted = await repository.readEncryptedPhoto(entry.id);
    expect([...encrypted.subarray(0, 6)]).toEqual(SSV1_PHOTO_HEADER);
    // No JPEG signature anywhere in the file, and it is longer than the plaintext by exactly the
    // header, the XChaCha20 nonce and the Poly1305 tag.
    expect(encrypted.length).toBe(original.length + 6 + 24 + 16);
    expect(Buffer.from(encrypted).includes(Buffer.from([0xff, 0xd8, 0xff]))).toBe(false);

    // --- decryption gives back the exact bytes -------------------------------------------
    const decrypted = await repository.readFullImage(entry.id);
    expect(digest(decrypted)).toBe(originalDigest);
    expect(Buffer.compare(Buffer.from(decrypted), Buffer.from(original))).toBe(0);
    expect(measure(decrypted)).toEqual(before);

    // --- the cloud leg carries the ciphertext verbatim ------------------------------------
    const backend = new InMemoryCloudBackend();
    const user = await backend.signUp('someone@example.test', 'correct horse battery staple');
    // The real upload path, so the backend's owner-only rule is exercised too.
    const path = BACKUP_PATHS.photo(user.uid, entry.id);
    await backend.putBlob(path, encrypted);
    const fetched = await backend.getBlob(path);
    expect(digest(fetched)).toBe(digest(encrypted));

    // --- restore: the downloaded blob decrypts to the same image --------------------------
    const thumbnailBlob = await repository.readEncryptedThumbnail(entry.id);
    await repository.deletePhotos([entry.id]);
    expect(repository.photos).toHaveLength(0);
    await repository.importEncrypted({ entry, photoBlob: fetched, thumbnailBlob });

    const restored = await repository.readFullImage(entry.id);
    expect(digest(restored)).toBe(originalDigest);
    const after = measure(restored);
    expect(after).toEqual(before);
    // Said plainly, because this is the property the bug report was about.
    expect(after.mean).toBeGreaterThan(100);

    await services.vault.close();
  });

  it('keeps the photo blob independent of the thumbnail blob', async () => {
    const original = photoJpeg();
    const { repository } = await unlockedVault(new FakeThumbnailGenerator());
    const entry = await repository.addPhoto(
      { bytes: Uint8Array.from(original) },
      { source: 'camera' },
    );

    // A thumbnail is a second, separately encrypted blob under its own key id; whatever the
    // thumbnail codec does, it cannot reach the stored photo.
    const photoBlob = await repository.readEncryptedPhoto(entry.id);
    const thumbBlob = await repository.readEncryptedThumbnail(entry.id);
    expect([...photoBlob.subarray(0, 6)]).toEqual(SSV1_PHOTO_HEADER);
    expect([...thumbBlob.subarray(0, 6)]).toEqual([0x53, 0x53, 0x56, 0x31, 0x01, 0x02]);
    expect(Buffer.compare(Buffer.from(await repository.readFullImage(entry.id)), Buffer.from(original))).toBe(0);
  });
});
