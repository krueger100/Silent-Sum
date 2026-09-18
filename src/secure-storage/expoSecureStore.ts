/**
 * `SecureStore` on top of expo-secure-store (Android Keystore-backed `SharedPreferences`,
 * iOS Keychain). Only small strings live here: the wrapped-master-key credential record and the
 * unlock throttle state. The PIN itself is never written anywhere.
 *
 * iOS configuration:
 *
 * - `keychainAccessible: AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`. "After first unlock" because the
 *   throttle state has to be readable when the app is relaunched into a locked device;
 *   "this device only" is what keeps the item out of iCloud Keychain and out of encrypted device
 *   backups, so a restore onto another device cannot carry the wrapped key -- or a stale throttle
 *   counter -- with it. expo-secure-store never sets `kSecAttrSynchronizable`, so no additional
 *   flag is needed to disable iCloud sync.
 * - A fixed `keychainService`, which on Android is the key-pair alias and on iOS the item's
 *   `kSecAttrService`. It is part of the item's identity: the same value must be used for every
 *   read, write and delete or the entries become unreachable.
 * - `requireAuthentication` is deliberately NOT used. Under that option a key invalidated by a
 *   biometric enrolment change makes `getItemAsync` resolve `null` -- indistinguishable from
 *   "never stored" -- and this store would then report a still-present vault as absent, i.e. fail
 *   open. Access is gated by the PIN-derived key instead, which is the thing that actually
 *   protects the vault.
 *
 * Read semantics, which callers rely on to fail closed:
 *
 * - The key is absent  -> `read` resolves `null` and `containsKey` resolves `false`.
 * - The entry exists but cannot be produced (corrupt ciphertext, Keystore entry invalidated or
 *   damaged, decryption failure) -> `getItemAsync` REJECTS, and that error is propagated
 *   unchanged by both `read` and `containsKey`. It is never converted into `null`/`false`:
 *   reporting a damaged credential record as "no vault here" would send the caller down the
 *   first-run path and overwrite the user's only copy of the wrapped master key.
 * - `write` and `delete` propagate failures for the same reason. Deleting a key that is not
 *   present is not an error.
 */
import * as ExpoSecureStore from 'expo-secure-store';

import type { SecureStore } from '@/secure-storage/secureStore';

/** Android key-pair alias / iOS `kSecAttrService`. Part of every entry's identity: never change. */
export const KEYCHAIN_SERVICE = 'silentsum.vault';

export class ExpoSecureStoreAdapter implements SecureStore {
  /**
   * Built per call rather than at module scope: the accessibility constants are read from the
   * native module, which must not be touched merely by importing this file.
   */
  private options(): ExpoSecureStore.SecureStoreOptions {
    return {
      keychainService: KEYCHAIN_SERVICE,
      keychainAccessible: ExpoSecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    };
  }

  /** `null` only when the key is absent; a failed retrieval rejects. See the note above. */
  async read(key: string): Promise<string | null> {
    return await ExpoSecureStore.getItemAsync(key, this.options());
  }

  async write(key: string, value: string): Promise<void> {
    await ExpoSecureStore.setItemAsync(key, value, this.options());
  }

  /** Deleting an absent key is a no-op; a failed deletion rejects. */
  async delete(key: string): Promise<void> {
    await ExpoSecureStore.deleteItemAsync(key, this.options());
  }

  /**
   * `false` means "definitely nothing stored under this key". A corrupt or unreadable entry
   * rejects with the underlying error instead of answering `false`.
   */
  async containsKey(key: string): Promise<boolean> {
    return (await this.read(key)) !== null;
  }
}
