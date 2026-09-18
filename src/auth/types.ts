/**
 * Offline authentication contracts. Nothing on this path touches the network.
 * Formats: docs/reference/flutter-authentication.md.
 */
import type { Bytes } from '@/utils/bytes';
import type { KdfParams, VaultKeys, WrappedKey } from '@/crypto/types';

export type PinValidationError =
  | 'tooShort'
  | 'tooLong'
  | 'notDigits'
  | 'leadingZero'
  /** A wipe PIN identical to the vault PIN: one result cannot mean both things. */
  | 'sameAsVaultPin'
  /** A wipe PIN that overlaps the vault PIN. See `wipePinConflict`. */
  | 'partOfVaultPin'
  /**
   * The same relation seen from the other side: a VAULT PIN that would collide with an already
   * armed wipe PIN. Checking only at arming time would make the guarantee last exactly until the
   * next Change PIN.
   */
  | 'clashesWithWipePin';

/** What a wipe PIN destroys. The two copies of a vault are separately worth protecting. */
export type WipeScope = 'device' | 'backup' | 'both';

/**
 * The armed wipe PIN. Persisted in the secure store beside the vault credentials; see
 * `wipePin.ts` for why the PIN is held as itself rather than hashed.
 */
export interface WipePinRecord {
  readonly version: 1;
  readonly pin: string;
  readonly scope: WipeScope;
  readonly createdAt: number;
}

export const PIN_POLICY = { minLength: 4, maxLength: 8 } as const;

/** Persisted (in the secure store) as compact JSON under SECURE_STORE_KEYS.vaultCredentials. */
export interface VaultCredentials {
  readonly version: 1;
  readonly salt: Bytes; // 16 bytes
  readonly kdf: KdfParams;
  readonly wrappedMasterKey: WrappedKey;
  readonly pinLength: number; // 4..8, deliberately non-secret
  /**
   * The PIN itself, or null for a record written before partial answers existed.
   *
   * Recognising a contiguous PART of the PIN cannot be done by deriving a key from what was
   * typed, so the app has to be able to read the PIN in order to compare against it. That is the
   * cost of telling the user how many digits are missing, and it is why this record never leaves
   * the platform secure store. It is never what grants access: the vault is still opened by
   * deriving a key from the whole PIN and unwrapping. See docs/security.md.
   *
   * A null here is not an error: such a vault still opens on the whole PIN, and the record is
   * upgraded in place the first time it does.
   */
  readonly pin: string | null;
  readonly createdAt: number; // epoch ms UTC
}

/** JSON: {"v":1,"salt":b64,"kdf":{...},"wrapped":{...},"pinLength":n,"pin":"…","createdAt":iso} */
export interface ThrottleState {
  readonly failedCount: number;
  /** Epoch ms UTC or null. */
  readonly lockedUntil: number | null;
  readonly lastFailureAt: number | null;
}

export const THROTTLE_INITIAL: ThrottleState = { failedCount: 0, lockedUntil: null, lastFailureAt: null };

export type UnlockResult =
  | { kind: 'success'; keys: VaultKeys }
  | { kind: 'wrongPin'; failedCount: number; nextDelayMs: number }
  /**
   * The calculated result is a contiguous part of the PIN, but not all of it. The vault stays
   * shut; the user is told how many digits are still missing. Counts as a failed attempt.
   */
  | { kind: 'partialPin'; digits: string; missingDigits: number }
  | { kind: 'throttled'; remainingMs: number }
  /**
   * The result was the wipe PIN. Nothing is unlocked and nothing ever will be: the caller runs
   * the configured destruction and then shows the user precisely what an unrelated calculation
   * shows, which is nothing at all.
   */
  | { kind: 'wipe'; scope: WipeScope }
  | { kind: 'notConfigured' };

export type ChangePinResult =
  | { kind: 'success' }
  | { kind: 'wrongCurrent'; nextDelayMs: number }
  | { kind: 'throttled'; remainingMs: number }
  | { kind: 'invalidNew'; error: PinValidationError };

export interface PinAuthService {
  isConfigured(): Promise<boolean>;
  configuredPinLength(): Promise<number | null>;
  loadCredentials(): Promise<VaultCredentials | null>;
  throttleState(): Promise<ThrottleState>;
  remainingLockoutMs(): Promise<number>;
  /** First run. Throws InvalidPinError / VaultAlreadyExistsError / CredentialsUnreadableError. */
  setupPin(pin: string): Promise<VaultKeys>;
  unlock(pin: string): Promise<UnlockResult>;
  /**
   * Unlock from a calculated result. Only the whole PIN opens the vault; a contiguous part of it
   * comes back as `partialPin` so the user can be told how many digits are missing. `wrongPin`
   * here means "nothing to do with the PIN", and the calculator keeps that silent so ordinary
   * arithmetic looks like ordinary arithmetic.
   */
  unlockWithCalculatedDigits(digits: string): Promise<UnlockResult>;
  changePin(currentPin: string, newPin: string): Promise<ChangePinResult>;
  /** Cloud restore: wraps a recovered master key under a new PIN. Caller owns `master`. */
  adoptMasterKey(master: Bytes, pin: string, options?: { overwrite?: boolean }): Promise<VaultKeys>;
  /** The armed wipe PIN, or null. Readable only from inside an unlocked vault, by settings. */
  wipePin(): Promise<WipePinRecord | null>;
  /** Arms it. Throws InvalidPinError for a PIN that breaks the policy or overlaps the vault PIN. */
  setWipePin(pin: string, scope: WipeScope): Promise<void>;
  clearWipePin(): Promise<void>;
  eraseCredentials(): Promise<void>;
}

export class InvalidPinError extends Error {
  constructor(readonly error: PinValidationError, message: string) {
    super(message);
    this.name = 'InvalidPinError';
  }
}

export class VaultAlreadyExistsError extends Error {
  constructor() {
    super('A vault PIN already exists');
    this.name = 'VaultAlreadyExistsError';
  }
}

export class NoVaultError extends Error {
  constructor() {
    super('No vault PIN to change');
    this.name = 'NoVaultError';
  }
}

/** Corrupt/unreadable credential record: fail closed, never a silent reset. */
export class CredentialsUnreadableError extends Error {
  constructor(cause?: unknown) {
    super('CredentialsUnreadableError');
    this.name = 'CredentialsUnreadableError';
    this.cause = cause;
  }
}

export interface VaultStatus {
  readonly configured: boolean;
  readonly pinLength: number | null;
  readonly unreadable: boolean;
}

export const VAULT_STATUS_NONE: VaultStatus = { configured: false, pinLength: null, unreadable: false };
