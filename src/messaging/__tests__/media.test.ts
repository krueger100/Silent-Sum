import { SequentialRandom } from '@/crypto/random';
import {
  MAX_PHOTO_BYTES,
  MAX_THUMB_BYTES,
  MAX_VIDEO_BYTES,
  THUMB_MAX_EDGE,
  openMedia,
  openThumb,
  sealMedia,
  sealThumb,
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
    expect(openMedia({ box: 'not-base64!!', nonce: 'nope' }, KEY, BINDING)).toBeNull();
    expect(openThumb({ box: '', nonce: '' }, KEY, BINDING)).toBeNull();
  });

  it('carries the caps the Storage rules enforce', () => {
    expect(MAX_PHOTO_BYTES).toBe(8 * 1024 * 1024);
    expect(MAX_VIDEO_BYTES).toBe(100 * 1024 * 1024);
    expect(MAX_THUMB_BYTES).toBe(32 * 1024);
    expect(THUMB_MAX_EDGE).toBe(256);
  });
});
