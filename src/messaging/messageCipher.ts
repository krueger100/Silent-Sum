/**
 * What actually goes in the database: XChaCha20-Poly1305 over the conversation key.
 *
 * The associated data binds every ciphertext to its conversation, its sender and its timestamp.
 * None of those three can be changed after the fact -- not by the other party, not by anyone with
 * write access to Firestore -- because the tag is computed over them. A message lifted out of one
 * conversation and dropped into another does not open, and neither does one whose `from` or
 * `createdAt` was edited in the console.
 */
import { SODIUM_AEAD_NONCE_BYTES, aeadDecrypt, aeadEncrypt } from '@/crypto/sodium';
import type { SecureRandom } from '@/crypto/types';
import { base64Decode, base64Encode } from '@/utils/base64';
import { utf8Decode, utf8Encode, type Bytes } from '@/utils/bytes';

/** Longest message a user may send, in characters of the trimmed text. */
export const MAX_MESSAGE_LENGTH = 2000;

/** The encrypted body as it is stored. */
export interface SealedMessage {
  readonly box: string;
  readonly nonce: string;
}

export interface MessageBinding {
  readonly conversationId: string;
  readonly from: string;
  readonly createdAt: number;
}

/** Exactly what the tag covers. Changing this string is a wire-format change. */
export function messageAad(binding: MessageBinding): string {
  return `silentsum/msg/v1|${binding.conversationId}|${binding.from}|${String(binding.createdAt)}`;
}

export function sealMessage(
  text: string,
  key: Bytes,
  binding: MessageBinding,
  random: SecureRandom,
): SealedMessage {
  const nonce = random.bytes(SODIUM_AEAD_NONCE_BYTES);
  const plain = utf8Encode(text);
  const box = aeadEncrypt(plain, messageAad(binding), nonce, key);
  return { box: base64Encode(box), nonce: base64Encode(nonce) };
}

/**
 * Returns null for anything that does not open: a wrong key (the peer rotated, or this is not
 * our conversation), a tampered record, or a malformed one. A reader never throws over a bad
 * message, because one unreadable row must not take the whole conversation down with it.
 */
export function openMessage(
  sealed: SealedMessage,
  key: Bytes,
  binding: MessageBinding,
): string | null {
  try {
    const nonce = base64Decode(sealed.nonce);
    if (nonce.length !== SODIUM_AEAD_NONCE_BYTES) return null;
    const plain = aeadDecrypt(base64Decode(sealed.box), messageAad(binding), nonce, key);
    return utf8Decode(plain);
  } catch {
    return null;
  }
}
