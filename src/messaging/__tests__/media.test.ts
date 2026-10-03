import { SequentialRandom } from '@/crypto/random';
import { SODIUM_AEAD_NONCE_BYTES, aeadEncrypt } from '@/crypto/sodium';
import {
  MAX_PHOTO_BYTES,
  MAX_THUMB_BYTES,
  MAX_VIDEO_BYTES,
  THUMB_MAX_EDGE,
  mediaAad,
  openMedia,
  openThumb,
  packSealed,
  sealMedia,
  sealThumb,
  thumbAad,
  unpackSealed,
  type MediaBinding,
} from '@/messaging/media';

const KEY = new Uint8Array(32).fill(7);
const BINDING: MediaBinding = {
  conversationId: 'a__b',
  from: 'a',
  createdAt: 1_700_000_000_000,
  objectPath: 'messages/a__b/photo/m1',
};
const PLAIN = new Uint8Array([1, 2, 3, 4, 5]);

/**
 * Bytes captured from the implementation that preceded the raw-bytes change, under a fixed nonce.
 * They stand in for every object already sitting in Storage.
 */
const FIXTURE_PLAIN_HEX =
  '000b16212c37424d58636e79848f9aa5b0bbc6d1dce7f2fd08131e29343f4a55606b76818c97a2adb8c3ced9e4effa05101b26313c47525d68737e89949faab5';
const FIXTURE_MEDIA_HEX =
  '030a11181f262d343b424950575e656c737a81888f969da4a5fe3b05c685db9a6e47dfd3d3d76ff5878414e7c33564ed43e2b208126f64e722522834358f6905d4dba5f3b01239c359381a315d7cbd8e339e06953fc013137e25bd44365771155589f7d12a1327fb';
const FIXTURE_THUMB_HEX =
  '030a11181f262d343b424950575e656c737a81888f969da4a5fe3b05c685db9a6e47dfd3d3d76ff5878414e7c33564ed43e2b208126f64e722522834358f6905d4dba5f3b01239c359381a315d7cbd8e339e06953fc013133e4b7e9c46c7dac8ac44ba8514658800';

function random() {
  return new SequentialRandom();
}

describe('media cipher', () => {
  it('round trips, and stores nothing readable', () => {
    const sealed = sealMedia(PLAIN, KEY, BINDING, random());
    expect(openMedia(sealed, KEY, BINDING)).toEqual(PLAIN);
  });

  // Binding the object path is what stops a valid ciphertext being re-pointed at another message.
  it('does not open under a different object path', () => {
    const sealed = sealMedia(PLAIN, KEY, BINDING, random());
    expect(
      openMedia(sealed, KEY, { ...BINDING, objectPath: 'messages/a__b/photo/OTHER' }),
    ).toBeNull();
  });

  it.each(['conversationId', 'from', 'createdAt'] as const)(
    'does not open under a different %s',
    (field) => {
      const sealed = sealMedia(PLAIN, KEY, BINDING, random());
      const tampered =
        field === 'createdAt'
          ? { ...BINDING, createdAt: BINDING.createdAt + 1 }
          : { ...BINDING, [field]: 'x' };
      expect(openMedia(sealed, KEY, tampered)).toBeNull();
    },
  );

  it('refuses a different key', () => {
    const sealed = sealMedia(PLAIN, KEY, BINDING, random());
    expect(openMedia(sealed, new Uint8Array(32).fill(8), BINDING)).toBeNull();
  });

  // Separate AAD domains, so neither can be replayed as the other.
  it('will not open a thumbnail as a body, nor a body as a thumbnail', () => {
    const thumb = sealThumb(PLAIN, KEY, BINDING, random());
    expect(openMedia(thumb, KEY, BINDING)).toBeNull();
    const body = sealMedia(PLAIN, KEY, BINDING, random());
    expect(openThumb(body, KEY, BINDING)).toBeNull();
  });

  it('round trips a thumbnail under its own domain', () => {
    const thumb = sealThumb(PLAIN, KEY, BINDING, random());
    expect(openThumb(thumb, KEY, BINDING)).toEqual(PLAIN);
  });

  it('returns null for garbage rather than throwing, like the message cipher', () => {
    // A nonce of the wrong length, a box too short to hold a tag, and an empty record: none of
    // these may throw out of a thread that is merely scrolling.
    expect(openMedia({ box: new Uint8Array(40), nonce: new Uint8Array(4) }, KEY, BINDING)).toBeNull();
    expect(
      openThumb({ box: new Uint8Array(3), nonce: new Uint8Array(SODIUM_AEAD_NONCE_BYTES) }, KEY, BINDING),
    ).toBeNull();
    expect(openMedia({ box: new Uint8Array(0), nonce: new Uint8Array(0) }, KEY, BINDING)).toBeNull();
  });

  /**
   * The stored object is `nonce || ciphertext` and nothing else. These pin the actual bytes rather
   * than a round trip through this module's own functions, because the point of the change that
   * removed the base64 intermediate was that it must not touch the format: everything already in
   * Storage has to keep opening.
   */
  describe('the stored format', () => {
    it('is the nonce followed by the ciphertext, built independently', () => {
      const sealed = sealMedia(PLAIN, KEY, BINDING, random());
      const packed = packSealed(sealed);

      const nonce = packed.slice(0, SODIUM_AEAD_NONCE_BYTES);
      // Encrypted here, with the primitive, with no help from the module under test.
      const expected = aeadEncrypt(PLAIN, mediaAad(BINDING), nonce, KEY);
      expect(packed.slice(SODIUM_AEAD_NONCE_BYTES)).toEqual(expected);
      expect(packed.length).toBe(SODIUM_AEAD_NONCE_BYTES + PLAIN.length + 16);
    });

    it('does the same for a preview, under its own domain', () => {
      const packed = packSealed(sealThumb(PLAIN, KEY, BINDING, random()));
      const nonce = packed.slice(0, SODIUM_AEAD_NONCE_BYTES);
      expect(packed.slice(SODIUM_AEAD_NONCE_BYTES)).toEqual(
        aeadEncrypt(PLAIN, thumbAad(BINDING), nonce, KEY),
      );
    });

    it('opens an object captured from the previous implementation', () => {
      // Produced by the code that still round-tripped through base64, with a fixed nonce and key.
      // If the format had shifted by one byte this would stop opening -- which is exactly what it
      // would mean for every photo and video already in Storage.
      const key = new Uint8Array(32).fill(7);
      const binding: MediaBinding = {
        conversationId: 'uid_a__uid_b',
        from: 'uid_a',
        createdAt: 1767268800000,
        objectPath: 'messages/uid_a__uid_b/photo/m_fixture',
      };
      const plain = Uint8Array.from(Buffer.from(FIXTURE_PLAIN_HEX, 'hex'));

      const media = unpackSealed(Uint8Array.from(Buffer.from(FIXTURE_MEDIA_HEX, 'hex')));
      if (media === null) throw new Error('the fixture did not unpack');
      expect(openMedia(media, key, binding)).toEqual(plain);

      const thumb = unpackSealed(Uint8Array.from(Buffer.from(FIXTURE_THUMB_HEX, 'hex')));
      if (thumb === null) throw new Error('the fixture did not unpack');
      expect(openThumb(thumb, key, binding)).toEqual(plain);

      // And the domains still refuse to open as each other, on real stored bytes.
      expect(openThumb(media, key, binding)).toBeNull();
      expect(openMedia(thumb, key, binding)).toBeNull();
    });

    it('refuses an object too short to carry a nonce', () => {
      expect(unpackSealed(new Uint8Array(SODIUM_AEAD_NONCE_BYTES))).toBeNull();
      expect(unpackSealed(new Uint8Array(0))).toBeNull();
    });
  });

  // A megabyte through the real cipher, as a video does. The guard that this no longer passes
  // through the pure-JS base64 helper lives in `mediaBase64.test.ts`, which has to mock that module
  // for the whole file to do it.
  it('round trips a video-sized payload through the stored format', () => {
    const video = new Uint8Array(1024 * 1024);
    for (let i = 0; i < video.length; i += 1021) video[i] = (i * 3) & 0xff;

    const packed = packSealed(sealMedia(video, KEY, BINDING, random()));
    const unpacked = unpackSealed(packed);
    if (unpacked === null) throw new Error('expected an unpacked record');

    expect(openMedia(unpacked, KEY, BINDING)).toEqual(video);
    expect(packed.length).toBe(SODIUM_AEAD_NONCE_BYTES + video.length + 16);
  });

  it('carries the caps the Storage rules enforce', () => {
    expect(MAX_PHOTO_BYTES).toBe(8 * 1024 * 1024);
    expect(MAX_VIDEO_BYTES).toBe(100 * 1024 * 1024);
    expect(MAX_THUMB_BYTES).toBe(32 * 1024);
    expect(THUMB_MAX_EDGE).toBe(256);
  });
});
