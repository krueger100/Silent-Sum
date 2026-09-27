/**
 * The Ed25519 public key this build trusts for recovery codes.
 *
 * Compiled in from `extra.recoveryPublicKey`, the same way the support address is. A build with no
 * key -- which is every build until someone runs the signing script's `keygen` and sets the
 * environment variable -- simply cannot accept a code, and the About page leaves the whole thing
 * out rather than offering a field that could never work.
 *
 * This is the PUBLIC half. It is meant to be in the bundle, readable by anyone who unzips the APK,
 * and useless to them: it verifies codes and cannot mint them. The private half belongs on the
 * signing machine and must never appear in this repository, in an environment file that gets
 * committed, or in a build.
 *
 * A malformed value is treated as absent rather than raised, because a mistyped build variable
 * must never be able to stop the vault from opening.
 */
import Constants from 'expo-constants';

import { PUBLIC_KEY_BYTES } from '@/support/recoveryCode';
import { base64Decode, Base64Error } from '@/utils/base64';
import type { Bytes } from '@/utils/bytes';

/** Parses a base64 key, or returns null for anything that is not exactly one. */
export function parseRecoveryPublicKey(raw: unknown): Bytes | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  try {
    const decoded = base64Decode(trimmed);
    return decoded.length === PUBLIC_KEY_BYTES ? decoded : null;
  } catch (cause) {
    if (cause instanceof Base64Error) return null;
    throw cause;
  }
}

/** The key compiled into this build, or null when it has none. */
export function readRecoveryPublicKey(): Bytes | null {
  return parseRecoveryPublicKey(Constants.expoConfig?.extra?.recoveryPublicKey);
}
