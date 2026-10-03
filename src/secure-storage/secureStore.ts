/**
 * Platform secure key/value store (Android Keystore-backed `SharedPreferences` / iOS Keychain).
 *
 * Five small strings, and it is worth being exact about them because one of them is the PIN:
 *
 *  - `vaultCredentials` -- the credential record. Holds the Argon2id salt and parameters, the
 *    master key WRAPPED under the PIN-derived key, the PIN length, and **the PIN itself**. The
 *    PIN is there so that a calculator result which is a contiguous PART of the PIN can be
 *    recognised and answered with how many digits are missing; that comparison cannot be made
 *    from a derived key. It is never what grants access -- the vault is opened by deriving a
 *    key from the whole PIN and unwrapping -- but it IS stored, and nothing here should be read
 *    as claiming otherwise. See `VaultCredentials` in `@/auth/types` and docs/security.md.
 *  - `throttleState` -- failed attempts and any lockout, so a restart cannot reset them.
 *  - `wipePin` -- the armed wipe PIN and its scope, when one is set. Also a PIN in cleartext,
 *    and for the same reason: it is matched against what was typed.
 *  - `installRef` -- this installation’s random reference, printed on the About page and signed
 *    into recovery codes. Not a secret.
 *  - `spentRecoveryCodes` -- fingerprints of codes already redeemed. Public bytes.
 *
 * The master key itself is never written in the clear, anywhere, in any of these.
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
  /**
   * Which backup account this device's vault has been backed up to, so signing into a second
   * account cannot silently upload the first account's photos. See `@/backup/vaultOwner`.
   */
  vaultOwner: 'silentsum.vault.owner.v1',
  /**
   * This installation’s random reference, printed on the About page and signed into every
   * recovery code. Not a secret; kept here so that erasing takes it with everything else.
   */
  installRef: 'silentsum.install.ref.v1',
  /** Fingerprints of recovery codes already spent, so single use survives a restart. */
  spentRecoveryCodes: 'silentsum.recovery.spent.v1',
  /**
   * Messages hidden on this device only ("delete for me"). Never uploaded: see
   * `@/messaging/hiddenMessages` for why this is not a server record.
   */
  hiddenMessages: 'silentsum.messaging.hidden.v1',
  /**
   * A mirror of the account's entitlement document (`users/<uid>/billing/entitlements`), so Pro
   * features keep working with no network. Never a source of truth: the server never reads it
   * and the rules never trust it. Erased with the vault; signing in again restores it.
   */
  entitlements: 'silentsum.billing.entitlements.v1',
  /**
   * Conversations in which the vault-send explanation has already been shown. Not a secret, but
   * it belongs to the vault: erasing the vault should also forget who was told what about it.
   */
  vaultSendNotice: 'silentsum.messaging.vaultsend.v1',
} as const;

/** Every key, in erase order (credentials first, then throttle). */
export const ALL_SECURE_STORE_KEYS: readonly string[] = [
  SECURE_STORE_KEYS.vaultCredentials,
  SECURE_STORE_KEYS.throttleState,
  SECURE_STORE_KEYS.wipePin,
  SECURE_STORE_KEYS.vaultOwner,
  SECURE_STORE_KEYS.installRef,
  SECURE_STORE_KEYS.spentRecoveryCodes,
  SECURE_STORE_KEYS.entitlements,
  SECURE_STORE_KEYS.vaultSendNotice,
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
