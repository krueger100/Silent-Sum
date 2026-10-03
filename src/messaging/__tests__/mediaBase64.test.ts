/**
 * The media cipher must never hand a photo or a video to `utils/base64`.
 *
 * That module says in its own first line that it is for keys, salts and nonces. The media path used
 * to ignore that: it base64-encoded the whole ciphertext on the way out and decoded it again before
 * the upload, with the mirror of that on the way in. For an 8 MB photo the intermediate was an
 * 11-million-character string, and on a 39 MB video the decode showed up as forty seconds of
 * "Decrypting..." that a tester reported as a hang.
 *
 * The helper is replaced here with one that throws, for the whole file. Any reintroduction of it in
 * the media path -- for a payload of any size -- fails this spec rather than quietly costing seconds
 * on a real device.
 */
import { SequentialRandom } from '@/crypto/random';
import {
  openMedia,
  openThumb,
  packSealed,
  sealMedia,
  sealThumb,
  unpackSealed,
  type MediaBinding,
} from '@/messaging/media';

jest.mock('@/utils/base64', () => ({
  base64Encode: () => {
    throw new Error('utils/base64 must not see a media payload: it is for keys and nonces');
  },
  base64Decode: () => {
    throw new Error('utils/base64 must not see a media payload: it is for keys and nonces');
  },
  Base64Error: class Base64Error extends Error {},
}));

const KEY = new Uint8Array(32).fill(9);
const BINDING: MediaBinding = {
  conversationId: 'a__b',
  from: 'a',
  createdAt: 1_700_000_000_000,
  objectPath: 'messages/a__b/video/m1',
};

function payload(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 101) bytes[i] = (i * 7) & 0xff;
  return bytes;
}

describe('the media cipher, with the pure-JS base64 helper sabotaged', () => {
  it('seals and opens a megabyte without calling it', () => {
    const plain = payload(1024 * 1024);

    const packed = packSealed(sealMedia(plain, KEY, BINDING, new SequentialRandom()));
    const unpacked = unpackSealed(packed);
    if (unpacked === null) throw new Error('expected an unpacked record');

    expect(openMedia(unpacked, KEY, BINDING)).toEqual(plain);
  });

  it('does the same for a preview', () => {
    const plain = payload(20 * 1024);

    const packed = packSealed(sealThumb(plain, KEY, BINDING, new SequentialRandom()));
    const unpacked = unpackSealed(packed);
    if (unpacked === null) throw new Error('expected an unpacked record');

    expect(openThumb(unpacked, KEY, BINDING)).toEqual(plain);
  });

  it('still rejects a malformed record rather than throwing', () => {
    expect(openMedia({ box: new Uint8Array(40), nonce: new Uint8Array(2) }, KEY, BINDING)).toBeNull();
  });
});
