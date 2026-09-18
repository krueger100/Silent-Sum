/**
 * Platform secure key/value store (Android Keystore-backed / iOS Keychain).
 * Only small strings live here: the wrapped-master-key credential record and the throttle state.
 * The PIN itself is NEVER written anywhere.
 */
export interface SecureStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  containsKey(key: string): Promise<boolean>;
}

export const SECURE_STORE_KEYS = {
  vaultCredentials: 'silentsum.vault.credentials.v1',
  throttleState: 'silentsum.vault.throttle.v1',
  /** The armed wipe PIN, when the user has set one. Absent otherwise. */
  wipePin: 'silentsum.vault.wipe.v1',
} as const;

/** Every key, in erase order (credentials first, then throttle). */
export const ALL_SECURE_STORE_KEYS: readonly string[] = [
  SECURE_STORE_KEYS.vaultCredentials,
  SECURE_STORE_KEYS.throttleState,
  SECURE_STORE_KEYS.wipePin,
];

/** Test double; also handy for snapshot assertions ("no value contains the PIN"). */
export class InMemorySecureStore implements SecureStore {
  private readonly map: Map<string, string>;

  constructor(initial?: Record<string, string>) {
    this.map = new Map(Object.entries(initial ?? {}));
  }

  get snapshot(): Readonly<Record<string, string>> {
    return Object.fromEntries(this.map);
  }

  async read(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }

  async write(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  async containsKey(key: string): Promise<boolean> {
    return this.map.has(key);
  }
}
