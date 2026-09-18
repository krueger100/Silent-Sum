/**
 * expo-secure-store is replaced by an in-memory fake keychain; no native code runs. The point of
 * these tests is the read contract: absent must be `null`, corrupt must REJECT, and the two must
 * never be confused -- reporting a damaged credential record as "nothing stored" would send the
 * caller down the first-run path and destroy the only copy of the wrapped master key.
 */
import * as ExpoSecureStore from 'expo-secure-store';

import { ExpoSecureStoreAdapter, KEYCHAIN_SERVICE } from '@/secure-storage/expoSecureStore';
import { SECURE_STORE_KEYS, type SecureStore } from '@/secure-storage/secureStore';

const mockKeychain = new Map<string, string>();
const mockGetItemAsync = jest.fn(
  async (key: string, _options?: unknown): Promise<string | null> => mockKeychain.get(key) ?? null,
);
const mockSetItemAsync = jest.fn(
  async (key: string, value: string, _options?: unknown): Promise<void> => {
    mockKeychain.set(key, value);
  },
);
const mockDeleteItemAsync = jest.fn(async (key: string, _options?: unknown): Promise<void> => {
  mockKeychain.delete(key);
});

// Hoisted above the imports, so the jest.fn()s are not bound yet when the factory runs: the
// exported functions forward to them lazily instead of capturing them here.
jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK: 1,
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 2,
  WHEN_UNLOCKED: 3,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 4,
  getItemAsync: (key: string, options?: unknown) => mockGetItemAsync(key, options),
  setItemAsync: (key: string, value: string, options?: unknown) =>
    mockSetItemAsync(key, value, options),
  deleteItemAsync: (key: string, options?: unknown) => mockDeleteItemAsync(key, options),
}));

const KEY = SECURE_STORE_KEYS.vaultCredentials;
const RECORD = '{"wrappedKey":"...","kdf":{"alg":"argon2id"}}';

/** Exactly the options every call must carry; anything else makes entries unreachable. */
const EXPECTED_OPTIONS = {
  keychainService: KEYCHAIN_SERVICE,
  keychainAccessible: ExpoSecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

describe('ExpoSecureStoreAdapter', () => {
  let store: SecureStore;

  beforeEach(() => {
    mockKeychain.clear();
    mockGetItemAsync.mockClear();
    mockSetItemAsync.mockClear();
    mockDeleteItemAsync.mockClear();
    store = new ExpoSecureStoreAdapter();
  });

  describe('round trip', () => {
    it('reads back what it wrote', async () => {
      await store.write(KEY, RECORD);
      await expect(store.read(KEY)).resolves.toBe(RECORD);
    });

    it('overwrites an existing entry', async () => {
      await store.write(KEY, RECORD);
      await store.write(KEY, 'replaced');
      await expect(store.read(KEY)).resolves.toBe('replaced');
    });

    it('keeps the throttle state separate from the credentials', async () => {
      await store.write(SECURE_STORE_KEYS.vaultCredentials, RECORD);
      await store.write(SECURE_STORE_KEYS.throttleState, '{"failures":3}');
      await expect(store.read(SECURE_STORE_KEYS.vaultCredentials)).resolves.toBe(RECORD);
      await expect(store.read(SECURE_STORE_KEYS.throttleState)).resolves.toBe('{"failures":3}');
    });

    it('removes an entry on delete', async () => {
      await store.write(KEY, RECORD);
      await store.delete(KEY);
      await expect(store.read(KEY)).resolves.toBeNull();
      await expect(store.containsKey(KEY)).resolves.toBe(false);
    });

    it('treats deleting an absent key as a no-op', async () => {
      await expect(store.delete(KEY)).resolves.toBeUndefined();
    });
  });

  describe('absent vs corrupt', () => {
    it('returns null for a key that was never written', async () => {
      await expect(store.read(KEY)).resolves.toBeNull();
      await expect(store.containsKey(KEY)).resolves.toBe(false);
    });

    it('reports a present key', async () => {
      await store.write(KEY, RECORD);
      await expect(store.containsKey(KEY)).resolves.toBe(true);
    });

    it('propagates a failed retrieval instead of answering null', async () => {
      mockGetItemAsync.mockImplementationOnce(async () => {
        throw new Error('Could not decrypt the value for key');
      });
      await expect(store.read(KEY)).rejects.toThrow('Could not decrypt the value for key');
    });

    it('propagates a failed retrieval from containsKey instead of answering false', async () => {
      mockGetItemAsync.mockImplementationOnce(async () => {
        throw new Error('Could not decrypt the value for key');
      });
      await expect(store.containsKey(KEY)).rejects.toThrow('Could not decrypt the value for key');
    });

    it('propagates a failed write', async () => {
      mockSetItemAsync.mockImplementationOnce(async () => {
        throw new Error('Keystore is not available');
      });
      await expect(store.write(KEY, RECORD)).rejects.toThrow('Keystore is not available');
    });

    it('propagates a failed delete', async () => {
      mockDeleteItemAsync.mockImplementationOnce(async () => {
        throw new Error('Keystore is not available');
      });
      await expect(store.delete(KEY)).rejects.toThrow('Keystore is not available');
    });
  });

  describe('keychain options', () => {
    it('reads with AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY under the vault service', async () => {
      await store.read(KEY);
      expect(mockGetItemAsync).toHaveBeenCalledWith(KEY, EXPECTED_OPTIONS);
    });

    it('writes with the same options, or the entry becomes unreachable', async () => {
      await store.write(KEY, RECORD);
      expect(mockSetItemAsync).toHaveBeenCalledWith(KEY, RECORD, EXPECTED_OPTIONS);
    });

    it('deletes with the same options', async () => {
      await store.delete(KEY);
      expect(mockDeleteItemAsync).toHaveBeenCalledWith(KEY, EXPECTED_OPTIONS);
    });

    it('never asks for device authentication, which would make null ambiguous', async () => {
      await store.write(KEY, RECORD);
      await store.read(KEY);
      expect(mockSetItemAsync).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ requireAuthentication: true }),
      );
      expect(mockGetItemAsync).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ requireAuthentication: true }),
      );
    });

    it('does not use an iCloud-synced accessibility class', () => {
      expect(EXPECTED_OPTIONS.keychainAccessible).not.toBe(ExpoSecureStore.AFTER_FIRST_UNLOCK);
      expect(EXPECTED_OPTIONS.keychainAccessible).not.toBe(ExpoSecureStore.WHEN_UNLOCKED);
      expect(EXPECTED_OPTIONS.keychainAccessible).toBe(
        ExpoSecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      );
    });
  });
});
