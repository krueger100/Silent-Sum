/**
 * The cipher for photos and video in a conversation: XChaCha20-Poly1305 over the same
 * conversation key that text already uses, with the object path bound in.
 *
 * This is `messageCipher.ts` over bytes instead of text, and deliberately shaped the same way --
 * same sealed record, same "returns null on any failure" discipline for the open functions,
 * because one unreadable item must never take a whole conversation down with it.
 *
 * Two things differ, and both matter:
 *
 *  1. **The object path is part of the associated data.** A message's ciphertext lives in Storage
 *     under a name the message document points at. Without the path in the tag, a member could
 *     re-point one message's document at another message's object and the result would still
 *     open. With it, a ciphertext only opens under the exact path it was sealed for.
 *  2. **Thumbnails have their own AAD domain.** A preview and a full image are both opaque
 *     ciphertext under the same key, so without separate domains a 32 KB preview could be served
 *     in place of the 8 MB original, or the reverse. The domains make each refuse to open as the
 *     other.
 *
 * EVERYTHING HERE IS BYTES. Text messages carry their ciphertext in a Firestore field, so
 * `messageCipher` base64-encodes it and must. Media does not: it goes to Storage as raw bytes, and
 * the nonce travels with it. Encoding on the way out only to decode again before the upload cost a
 * pure-JS pass over the whole payload in each direction, plus a UTF-16 string twice its size --
 * 11 million characters for an 8 MB photo, and `utils/base64` says in its own first line that it is
 * for keys and nonces, not images. On a 39 MB video that intermediate was the forty seconds of
 * "Decrypting..." a tester reported as a hang.
 *
 * The bytes on the wire are unchanged by that: `nonce || ciphertext`, exactly as before, so
 * everything already in Storage still opens.
 */
import {
  SODIUM_AEAD_NONCE_BYTES,
  SODIUM_AEAD_TAG_BYTES,
  aeadDecrypt,
  aeadEncrypt,
} from '@/crypto/sodium';
import type { SecureRandom } from '@/crypto/types';
import type { Bytes } from '@/utils/bytes';

/**
 * What one message may carry. These are enforced three times over: here before anything is
 * uploaded, by the Storage rules on the object itself, and by the picker where it can be.
 * The Storage rules are the only one of the three that an attacker cannot skip.
 */
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
export const MAX_THUMB_BYTES = 32 * 1024;

/**
 * The long edge of a chat thumbnail, in pixels.
 *
 * Note this is NOT the vault's own thumbnail size: the vault generates at 512px/q82
 * (`THUMBNAIL.defaultMaxDimension` in `src/vault/types.ts`), which is typically 40-90 KB and over
 * `MAX_THUMB_BYTES`. Sending a vault item therefore regenerates its preview at this size rather
 * than reusing the one the vault already holds.
 */
export const THUMB_MAX_EDGE = 256;

export type MediaKind = 'photo' | 'video';

/**
 * The encrypted object, in the two parts `packSealed` joins.
 *
 * Both are raw bytes. Nothing between here and Storage needs them as text, and making them text
 * was the whole cost this module used to carry.
 */
export interface SealedMedia {
  readonly box: Bytes;
  readonly nonce: Bytes;
}

export interface MediaBinding {
  readonly conversationId: string;
  readonly from: string;
  readonly createdAt: number;
  /** The full Storage path this ciphertext lives at, e.g. `messages/a__b/photo/m1`. */
  readonly objectPath: string;
}

const MEDIA_AAD = 'silentsum/media/v1';
const THUMB_AAD = 'silentsum/mediathumb/v1';

/** Exactly what the tag covers. Changing either string is a wire-format change. */
export function mediaAad(binding: MediaBinding): string {
  return [
    MEDIA_AAD,
    binding.conversationId,
    binding.from,
    String(binding.createdAt),
    binding.objectPath,
  ].join('|');
}

export function thumbAad(binding: MediaBinding): string {
  return [
    THUMB_AAD,
    binding.conversationId,
    binding.from,
    String(binding.createdAt),
    binding.objectPath,
  ].join('|');
}

function seal(plain: Bytes, key: Bytes, aad: string, random: SecureRandom): SealedMedia {
  const nonce = random.bytes(SODIUM_AEAD_NONCE_BYTES);
  return { box: aeadEncrypt(plain, aad, nonce, key), nonce };
}

function open(sealed: SealedMedia, key: Bytes, aad: string): Bytes | null {
  try {
    if (sealed.nonce.length !== SODIUM_AEAD_NONCE_BYTES) return null;
    // Shorter than a tag is not ciphertext at all. An empty plaintext seals to exactly one tag,
    // so the comparison has to admit that length rather than reject it.
    if (sealed.box.length < SODIUM_AEAD_TAG_BYTES) return null;
    return aeadDecrypt(sealed.box, aad, sealed.nonce, key);
  } catch {
    return null;
  }
}

export function sealMedia(
  plain: Bytes,
  key: Bytes,
  binding: MediaBinding,
  random: SecureRandom,
): SealedMedia {
  return seal(plain, key, mediaAad(binding), random);
}

/** Null for anything that does not open, exactly as `openMessage` does for text. */
export function openMedia(sealed: SealedMedia, key: Bytes, binding: MediaBinding): Bytes | null {
  return open(sealed, key, mediaAad(binding));
}

export function sealThumb(
  plain: Bytes,
  key: Bytes,
  binding: MediaBinding,
  random: SecureRandom,
): SealedMedia {
  return seal(plain, key, thumbAad(binding), random);
}

export function openThumb(sealed: SealedMedia, key: Bytes, binding: MediaBinding): Bytes | null {
  return open(sealed, key, thumbAad(binding));
}

/** The cap that applies to one item of this kind. */
export function capFor(kind: MediaKind): number {
  return kind === 'photo' ? MAX_PHOTO_BYTES : MAX_VIDEO_BYTES;
}

/**
 * What `packSealed` adds to a plaintext: the nonce it prefixes, and the tag the AEAD appends.
 *
 * Every local budget has to leave room for it, because the Storage rules measure the OBJECT. A
 * photo of a few bytes under 8 MB otherwise passes every check on the device and is refused by the
 * server -- the one kind of failure a retry can never get past.
 */
export const SEALED_OVERHEAD_BYTES = SODIUM_AEAD_NONCE_BYTES + SODIUM_AEAD_TAG_BYTES;

/** The largest plaintext of this kind whose sealed object still fits the Storage ceiling. */
export function plaintextBudget(kind: MediaKind): number {
  return capFor(kind) - SEALED_OVERHEAD_BYTES;
}

/** The same, for a chat preview. */
export const THUMB_PLAINTEXT_BUDGET = MAX_THUMB_BYTES - SEALED_OVERHEAD_BYTES;

/**
 * The stored object is `nonce || ciphertext`, as raw bytes.
 *
 * The nonce travels with the object rather than in the message document, and that is the only
 * arrangement that works: there are two ciphertexts per message (the media and its preview) and
 * the document has one `nonce` field. Putting each nonce in its own object also means the
 * receiving device needs nothing but the object to open it, and that a thumbnail which expired
 * while its media survived cannot leave a nonce behind pointing at nothing.
 *
 * A nonce is not a secret -- it is the one part of an AEAD that may travel in the clear -- so
 * prefixing it costs 24 bytes and reveals nothing.
 */
export function packSealed(sealed: SealedMedia): Bytes {
  const packed = new Uint8Array(sealed.nonce.length + sealed.box.length);
  packed.set(sealed.nonce, 0);
  packed.set(sealed.box, sealed.nonce.length);
  return packed;
}

/** Null for anything too short to hold a nonce, which is not a valid object. */
export function unpackSealed(packed: Bytes): SealedMedia | null {
  if (packed.length <= SODIUM_AEAD_NONCE_BYTES) return null;
  return {
    nonce: packed.slice(0, SODIUM_AEAD_NONCE_BYTES),
    box: packed.slice(SODIUM_AEAD_NONCE_BYTES),
  };
}
