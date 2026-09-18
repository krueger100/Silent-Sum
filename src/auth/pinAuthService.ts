/**
 * Offline vault authentication.
 *
 * Setup generates a random 32-byte master key and wraps it under a key derived from the PIN with
 * Argon2id. Unlock re-derives that key and unwraps; the Poly1305 tag is the only verifier, so a
 * wrong PIN simply fails to unwrap and there is nothing cheaper than a full Argon2id derivation
 * to attack offline.
 *
 * Nothing on this path can reach the network. Firebase is never consulted, and the vault opens
 * identically in airplane mode, on a device that has never seen a network, or with Firebase
 * entirely absent from the build.
 */
import {
  CredentialsUnreadableError,
  InvalidPinError,
  NoVaultError,
  THROTTLE_INITIAL,
  VaultAlreadyExistsError,
  type ChangePinResult,
  type PinAuthService as PinAuthServiceContract,
  type ThrottleState,
  type UnlockResult,
  type VaultCredentials,
  type WipePinRecord,
  type WipeScope,
} from '@/auth/types';
import {
  delayAfterMs,
  recordFailure,
  recordSuccess,
  remainingMs,
  throttleStateFromJson,
  throttleStateToJson,
} from '@/auth/attemptThrottle';
import { describePinError, isValidPin, validatePin } from '@/auth/pinPolicy';
import { coverWith, emptyProgress, type PinProgress } from '@/auth/pinMatching';
import {
  SALT_LENGTH,
  decodeCredentials,
  encodeCredentials,
} from '@/auth/vaultCredentials';
import { decodeWipePin, encodeWipePin, wipePinConflict } from '@/auth/wipePin';
import { deriveVaultKeys } from '@/crypto/vaultKeys';
import {
  KDF_PRESETS,
  MASTER_KEY_LENGTH,
  RecordFormatError,
  WrongKeyError,
  type KdfParams,
  type KeyDerivation,
  type KeyWrapping,
  type SecureRandom,
  type VaultKeys,
} from '@/crypto/types';
import { SECURE_STORE_KEYS, type SecureStore } from '@/secure-storage/secureStore';
import { utf8Encode, zeroBytes, type Bytes } from '@/utils/bytes';
import type { Clock } from '@/utils/clock';

export interface PinAuthServiceOptions {
  store: SecureStore;
  kdf: KeyDerivation;
  wrapping: KeyWrapping;
  clock: Clock;
  random: SecureRandom;
  kdfParams?: KdfParams;
}

export class PinAuthService implements PinAuthServiceContract {
  private readonly store: SecureStore;
  private readonly kdf: KeyDerivation;
  private readonly wrapping: KeyWrapping;
  private readonly clock: Clock;
  private readonly random: SecureRandom;
  private readonly kdfParams: KdfParams;

  /**
   * Lockout deadline on the MONOTONIC clock, held only in this process.
   *
   * The persisted deadline uses wall-clock time so it survives a restart, but wall-clock time is
   * user editable. Keeping a monotonic deadline alongside it means that winding the system clock
   * forward while the app is running cannot shorten a lockout.
   */
  private monotonicLockedUntil: number | null = null;

  /**
   * How much of the PIN the current run of calculations has spelled out, or null for nothing.
   *
   * In memory only, and deliberately so: it is a convenience for someone entering their PIN in
   * pieces, not a credential. It dies with the process, and is cleared on every successful unlock.
   */
  private progress: PinProgress | null = null;

  constructor(options: PinAuthServiceOptions) {
    this.store = options.store;
    this.kdf = options.kdf;
    this.wrapping = options.wrapping;
    this.clock = options.clock;
    this.random = options.random;
    this.kdfParams = options.kdfParams ?? KDF_PRESETS.defaults;
  }

  async isConfigured(): Promise<boolean> {
    return (await this.loadCredentials()) !== null;
  }

  async configuredPinLength(): Promise<number | null> {
    return (await this.loadCredentials())?.pinLength ?? null;
  }

  /**
   * Reads and validates the stored record.
   *
   * A record that exists but cannot be parsed is an error, never a silent "no vault": treating a
   * corrupt record as "not configured" would let the setup flow overwrite a vault whose files are
   * still on disk.
   */
  async loadCredentials(): Promise<VaultCredentials | null> {
    let raw: string | null;
    try {
      raw = await this.store.read(SECURE_STORE_KEYS.vaultCredentials);
    } catch (cause) {
      throw new CredentialsUnreadableError(cause);
    }
    if (raw === null) return null;
    try {
      return decodeCredentials(raw);
    } catch (cause) {
      throw new CredentialsUnreadableError(cause);
    }
  }

  /** Tolerant by design: a damaged throttle record must not lock the user out permanently. */
  async throttleState(): Promise<ThrottleState> {
    let raw: string | null;
    try {
      raw = await this.store.read(SECURE_STORE_KEYS.throttleState);
    } catch {
      return THROTTLE_INITIAL;
    }
    if (raw === null) return THROTTLE_INITIAL;
    try {
      return throttleStateFromJson(JSON.parse(raw));
    } catch {
      return THROTTLE_INITIAL;
    }
  }

  async remainingLockoutMs(): Promise<number> {
    return this.effectiveRemainingMs(await this.throttleState());
  }

  async setupPin(pin: string): Promise<VaultKeys> {
    const error = validatePin(pin);
    if (error !== null) throw new InvalidPinError(error, describePinError(error));
    if (await this.isConfigured()) throw new VaultAlreadyExistsError();
    await this.assertNoWipeClash(pin);

    const master = this.random.bytes(MASTER_KEY_LENGTH);
    try {
      const credentials = await this.wrapMaster(master, pin);
      await this.store.write(SECURE_STORE_KEYS.vaultCredentials, encodeCredentials(credentials));
      await this.saveThrottle(THROTTLE_INITIAL);
      this.monotonicLockedUntil = null;
      // Derive before the finally below zeroes `master`.
      return deriveVaultKeys(master);
    } finally {
      zeroBytes(master);
    }
  }

  async unlock(pin: string): Promise<UnlockResult> {
    const credentials = await this.loadCredentials();
    if (credentials === null) return { kind: 'notConfigured' };

    const throttle = await this.throttleState();
    const remaining = this.effectiveRemainingMs(throttle);
    if (remaining > 0) {
      // Refused before the KDF runs, so a locked-out attacker cannot even spend our CPU.
      return { kind: 'throttled', remainingMs: remaining };
    }

    const master = await this.tryUnwrap(credentials, pin);
    if (master === null) return await this.recordWrongAttempt(throttle);

    try {
      await this.saveThrottle(recordSuccess());
      this.monotonicLockedUntil = null;
      return { kind: 'success', keys: deriveVaultKeys(master) };
    } finally {
      zeroBytes(master);
    }
  }

  /**
   * Unlock from a calculated result.
   *
   * A result that is a contiguous run inside the PIN covers the digits it spells, and the vault
   * opens once the covered digits account for the whole PIN - in one calculation if the user typed
   * all of it, or across several if they built it up. Opening it is still the same operation it
   * has always been: Argon2id over the whole PIN, unwrap, Poly1305 tag as the only verifier. The
   * stored PIN decides what a result MEANS, never what is granted.
   *
   * Two rules keep the throttle useful without making the feature unusable. A result that is part
   * of the PIN does not count as a failed attempt - the user is on their way in, and counting it
   * would lock them out halfway - but nothing is confirmed, and no progress is made, while a
   * lockout is already running. A result that has nothing to do with the PIN does count, silently:
   * a calculator that answered "locked out, try again in 5 seconds" to 7 x 7 would give the vault
   * away.
   */
  async unlockWithCalculatedDigits(digits: string): Promise<UnlockResult> {
    // The wipe PIN is consulted first, and matched against the WHOLE result only.
    //
    // First, because it is the emergency path and nothing may be allowed to disarm it: not an
    // active lockout, not a credential record that has stopped parsing. The person typing it is
    // being watched by someone who wants the vault opened, and this is the one moment it has to
    // work.
    //
    // Whole result only, because the substring rule that lets the vault open across several
    // calculations would otherwise let a wipe fire on a fragment. `setWipePin` also refuses any
    // PIN that overlaps the vault PIN, so no single result can ever mean both things.
    const wipe = await this.wipePin();
    if (wipe !== null && digits === wipe.pin) return { kind: 'wipe', scope: wipe.scope };

    const credentials = await this.loadCredentials();
    if (credentials === null) return { kind: 'notConfigured' };

    // A vault created before any of this has no stored PIN to compare against, so a result of the
    // right length is simply tried. Opening one writes the PIN in; until then it can say nothing
    // about a part of it.
    const pin = credentials.pin;
    if (pin === null) {
      if (digits.length !== credentials.pinLength) return await this.countSilentFailure();
      const result = await this.unlock(digits);
      if (result.kind === 'success') await this.rememberPin(credentials, digits);
      return result;
    }

    if (this.progress === null || this.progress.pin !== pin) this.progress = emptyProgress(pin);
    const step = coverWith(this.progress, digits);
    if (step.kind === 'none') return await this.countSilentFailure();

    const throttle = await this.throttleState();
    const remaining = this.effectiveRemainingMs(throttle);
    // Confirming digits during a lockout would hand back precisely what the lockout withholds, so
    // the result is refused outright and buys the attacker no progress either.
    if (remaining > 0) return { kind: 'throttled', remainingMs: remaining };

    this.progress = step.progress;
    if (step.kind === 'partial') {
      return { kind: 'partialPin', digits, missingDigits: step.missingDigits };
    }

    const result = await this.unlock(pin);
    // Start the next visit from nothing, so an unlocked-then-locked vault cannot be reopened by
    // one more digit off the back of the previous run.
    if (result.kind === 'success') this.progress = null;
    return result;
  }

  /** A result with nothing to do with the PIN: counted, never announced, never extends a lockout. */
  private async countSilentFailure(): Promise<UnlockResult> {
    const throttle = await this.throttleState();
    if (this.effectiveRemainingMs(throttle) > 0) {
      return { kind: 'wrongPin', failedCount: throttle.failedCount, nextDelayMs: 0 };
    }
    return await this.recordWrongAttempt(throttle);
  }

  /** Upgrades a record written before partial answers, keeping salt, KDF params and wrapped key. */
  private async rememberPin(credentials: VaultCredentials, pin: string): Promise<void> {
    await this.store.write(
      SECURE_STORE_KEYS.vaultCredentials,
      encodeCredentials({ ...credentials, pin, pinLength: pin.length }),
    );
  }

  /** Re-wraps the same master key under a new PIN. Stored files are not re-encrypted. */
  async changePin(currentPin: string, newPin: string): Promise<ChangePinResult> {
    const error = validatePin(newPin);
    if (error !== null) return { kind: 'invalidNew', error };
    if (await this.clashesWithWipePin(newPin)) {
      return { kind: 'invalidNew', error: 'clashesWithWipePin' };
    }

    const result = await this.unlock(currentPin);
    switch (result.kind) {
      case 'success': {
        try {
          const credentials = await this.wrapMaster(result.keys.masterKey, newPin);
          await this.store.write(
            SECURE_STORE_KEYS.vaultCredentials,
            encodeCredentials(credentials),
          );
          return { kind: 'success' };
        } finally {
          result.keys.dispose();
        }
      }
      case 'wrongPin':
        return { kind: 'wrongCurrent', nextDelayMs: result.nextDelayMs };
      case 'throttled':
        return { kind: 'throttled', remainingMs: result.remainingMs };
      case 'notConfigured':
        throw new NoVaultError();
      default:
        throw new NoVaultError();
    }
  }

  /**
   * Wraps a master key recovered from a cloud backup under a freshly chosen local PIN. Refuses to
   * replace an existing vault unless the caller explicitly opts in, so a restore can never
   * silently orphan the photos already on the device.
   */
  async adoptMasterKey(
    master: Bytes,
    pin: string,
    options?: { overwrite?: boolean },
  ): Promise<VaultKeys> {
    const error = validatePin(pin);
    if (error !== null) throw new InvalidPinError(error, describePinError(error));
    if (master.length !== MASTER_KEY_LENGTH) {
      throw new RangeError(`master key must be ${String(MASTER_KEY_LENGTH)} bytes`);
    }
    if (options?.overwrite !== true && (await this.isConfigured())) {
      throw new VaultAlreadyExistsError();
    }
    await this.assertNoWipeClash(pin);
    const credentials = await this.wrapMaster(master, pin);
    await this.store.write(SECURE_STORE_KEYS.vaultCredentials, encodeCredentials(credentials));
    await this.saveThrottle(THROTTLE_INITIAL);
    this.monotonicLockedUntil = null;
    return deriveVaultKeys(master);
  }

  /**
   * The armed wipe PIN, or null.
   *
   * A record that will not parse is reported as "none" rather than raised. The credential record
   * fails closed by refusing to OPEN the vault; this one fails closed by refusing to DESTROY it,
   * which is the same instinct pointing the other way.
   */
  async wipePin(): Promise<WipePinRecord | null> {
    const raw = await this.store.read(SECURE_STORE_KEYS.wipePin);
    if (raw === null) return null;
    try {
      return decodeWipePin(raw);
    } catch {
      return null;
    }
  }

  /**
   * Arms the wipe PIN. Refuses anything that breaks the PIN policy, and anything that overlaps
   * the vault PIN -- a wipe PIN hiding inside the vault PIN would fire while its owner was
   * unlocking.
   */
  async setWipePin(pin: string, scope: WipeScope): Promise<void> {
    const error = validatePin(pin);
    if (error !== null) throw new InvalidPinError(error, describePinError(error));

    const credentials = await this.loadCredentials();
    const conflict = wipePinConflict(pin, credentials?.pin ?? null);
    if (conflict !== null) throw new InvalidPinError(conflict, describePinError(conflict));

    await this.store.write(
      SECURE_STORE_KEYS.wipePin,
      encodeWipePin({ version: 1, pin, scope, createdAt: this.clock.now() }),
    );
  }

  async clearWipePin(): Promise<void> {
    await this.store.delete(SECURE_STORE_KEYS.wipePin);
  }

  /**
   * Whether a candidate VAULT PIN would collide with the armed wipe PIN.
   *
   * `setWipePin` runs this same relation in the other direction. It has to exist on both sides or
   * the guarantee lasts exactly until the next Change PIN: a vault PIN that contained the wipe PIN
   * would destroy the vault on the way into it, since the wipe PIN is matched first. That is the
   * precise failure `wipePinConflict` exists to prevent, arrived at from the other end.
   */
  private async clashesWithWipePin(pin: string): Promise<boolean> {
    const wipe = await this.wipePin();
    return wipe !== null && wipePinConflict(wipe.pin, pin) !== null;
  }

  private async assertNoWipeClash(pin: string): Promise<void> {
    if (!(await this.clashesWithWipePin(pin))) return;
    throw new InvalidPinError('clashesWithWipePin', describePinError('clashesWithWipePin'));
  }

  /**
   * Removes the credential record, the throttle state and the armed wipe PIN. Vault files are
   * wiped separately.
   *
   * The wipe PIN goes with the rest on purpose: once this vault is gone the trap has nothing left
   * to destroy, and leaving it armed would point it at whatever vault is created next.
   */
  async eraseCredentials(): Promise<void> {
    await this.store.delete(SECURE_STORE_KEYS.vaultCredentials);
    await this.store.delete(SECURE_STORE_KEYS.throttleState);
    await this.store.delete(SECURE_STORE_KEYS.wipePin);
    this.monotonicLockedUntil = null;
    this.progress = null;
  }

  /** Counts one failed attempt and arms both lockout deadlines. */
  private async recordWrongAttempt(previous: ThrottleState): Promise<UnlockResult> {
    const throttle = recordFailure(previous, this.clock.now());
    await this.saveThrottle(throttle);
    const nextDelayMs = delayAfterMs(throttle.failedCount);
    this.monotonicLockedUntil = nextDelayMs === 0 ? null : this.clock.monotonicMs() + nextDelayMs;
    return { kind: 'wrongPin', failedCount: throttle.failedCount, nextDelayMs };
  }

  /** The stricter of the persisted wall-clock deadline and the in-process monotonic one. */
  private effectiveRemainingMs(state: ThrottleState): number {
    const wall = remainingMs(state, this.clock.now());
    const deadline = this.monotonicLockedUntil;
    const mono = deadline === null ? 0 : Math.max(0, deadline - this.clock.monotonicMs());
    return Math.max(wall, mono);
  }

  private async wrapMaster(master: Bytes, pin: string): Promise<VaultCredentials> {
    const salt = this.random.bytes(SALT_LENGTH);
    const kek = await this.deriveKek(pin, salt, this.kdfParams);
    try {
      return {
        version: 1,
        salt,
        kdf: this.kdfParams,
        wrappedMasterKey: await this.wrapping.wrap(master, kek),
        pinLength: pin.length,
        pin,
        createdAt: this.clock.now(),
      };
    } finally {
      zeroBytes(kek);
    }
  }

  /**
   * Returns null for a wrong PIN. A malformed record is a different failure and is raised, so the
   * UI can offer erase/restore instead of counting it as a failed guess.
   */
  private async tryUnwrap(credentials: VaultCredentials, pin: string): Promise<Bytes | null> {
    if (pin.length !== credentials.pinLength || !isValidPin(pin)) return null;
    const kek = await this.deriveKek(pin, credentials.salt, credentials.kdf);
    try {
      return await this.wrapping.unwrap(credentials.wrappedMasterKey, kek);
    } catch (cause) {
      if (cause instanceof WrongKeyError) return null;
      throw new CredentialsUnreadableError(cause);
    } finally {
      zeroBytes(kek);
    }
  }

  private async deriveKek(pin: string, salt: Bytes, params: KdfParams): Promise<Bytes> {
    const secret = utf8Encode(pin);
    try {
      return await this.kdf.deriveKey(secret, salt, params);
    } catch (cause) {
      if (cause instanceof RecordFormatError) throw new CredentialsUnreadableError(cause);
      throw cause;
    } finally {
      zeroBytes(secret);
    }
  }

  private async saveThrottle(state: ThrottleState): Promise<void> {
    await this.store.write(
      SECURE_STORE_KEYS.throttleState,
      JSON.stringify(throttleStateToJson(state)),
    );
  }
}
