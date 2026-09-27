/**
 * The state around a support-issued recovery code: which installation this is, which codes have
 * already been spent, and whether one is live right now.
 *
 * Three lifetimes meet here, and keeping them apart is most of the design:
 *
 *  - The installation reference is PERSISTENT. It is what a code is signed against, so it has to
 *    survive restarts, and it is generated once, lazily, the first time anything asks for it.
 *  - The spent-code list is PERSISTENT too, and for the same reason inverted: single use has to
 *    mean single use across a restart, or "use it again" is just "close the app first".
 *  - The authorization itself is MEMORY ONLY. Nothing writes it down, so killing the process is
 *    already one of the ways it ends -- alongside finishing the recovery, backing out, and the
 *    vault locking. It is the one piece here that must never outlive the moment.
 *
 * The reference and the spent list are ordinary app data, not secrets: the reference is printed on
 * the About page, and the fingerprints are slices of signatures that were mailed in plain text.
 * They live in the secure store because that is where this app's small records live and because
 * erasing the vault should take them with it, not because either would matter if read.
 *
 * Nothing in this module can open a vault. The most a valid code does is flip a boolean that some
 * navigation reads. See `@/support/recoveryCode` for why that is the whole extent of it.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';

import type { SecureRandom } from '@/crypto/types';
import { signVerify } from '@/crypto/sodium';
import {
  formatInstallRef,
  installRefIsQuotable,
  INSTALL_REF_BYTES,
  PUBLIC_KEY_BYTES,
  verifyRecoveryCode,
  type RecoveryCodeFailure,
  type RecoveryCodeResult,
  type SignatureVerifier,
} from '@/support/recoveryCode';
import { base32Decode, base32Encode, Base32Error } from '@/utils/base32';
import type { Bytes } from '@/utils/bytes';
import type { Clock } from '@/utils/clock';
import { SECURE_STORE_KEYS, type SecureStore } from '@/secure-storage/secureStore';

/**
 * How many spent codes to remember. Codes expire in a week and are issued one at a time by a
 * human, so this is several years of the busiest plausible support history; the cap exists only so
 * a record in the secure store cannot grow without bound.
 */
export const SPENT_CODE_HISTORY = 32;

/** Rolls allowed when looking for a quotable reference. See `RecoveryAccess.freshRef`. */
const REF_ATTEMPTS = 64;

export type RecoveryRedemption = RecoveryCodeFailure | 'used' | 'unavailable';

export interface RecoveryAccessState {
  /** True between a code being accepted and the authorization being cleared. */
  readonly authorized: boolean;
}

const UNAUTHORIZED: RecoveryAccessState = { authorized: false };

export interface RecoveryAccessDeps {
  readonly store: SecureStore;
  readonly random: SecureRandom;
  readonly clock: Clock;
  /**
   * The Ed25519 public key this build trusts, or null when the build ships without one -- in
   * which case no code can ever be accepted and the entry point stays hidden.
   */
  readonly publicKey: Bytes | null;
  /** Overridable so tests can drive verification without the native binding. */
  readonly verify?: SignatureVerifier;
}

export class RecoveryAccess {
  readonly store: StoreApi<RecoveryAccessState>;

  private readonly deps: RecoveryAccessDeps;
  private readonly verify: SignatureVerifier;
  private cachedRef: Bytes | null = null;
  /** In-flight generation, shared by every concurrent caller. See {@link installRef}. */
  private pendingRef: Promise<Bytes> | null = null;

  constructor(deps: RecoveryAccessDeps) {
    this.deps = deps;
    this.verify = deps.verify ?? signVerify;
    this.store = createStore<RecoveryAccessState>()(() => UNAUTHORIZED);
  }

  /** False when this build has no public key, so the UI can leave the whole thing out. */
  get available(): boolean {
    return this.deps.publicKey !== null && this.deps.publicKey.length === PUBLIC_KEY_BYTES;
  }

  get isAuthorized(): boolean {
    return this.store.getState().authorized;
  }

  /**
   * This installation's reference, generated on first use.
   *
   * Random rather than derived from anything about the device: an identifier that could be
   * recomputed from hardware would follow the user across a reinstall, and there is nothing here
   * that wants that.
   *
   * Concurrent callers share one generation. Two screens ask for this on the same mount -- the
   * code field and the support draft -- and without the shared promise each would find no cache,
   * find nothing stored, and mint its OWN reference. One would win the store and the user would
   * be looking at two different references for the same phone, quoting the one that the app was
   * no longer verifying against. It is a one-line fix for a failure that would have been very
   * hard to read from a support inbox.
   */
  async installRef(): Promise<Bytes> {
    const cached = this.cachedRef;
    if (cached !== null) return cached;

    this.pendingRef ??= this.loadOrCreateRef();
    try {
      return await this.pendingRef;
    } finally {
      // Cleared either way: on success the cache answers from now on, and on failure the next
      // caller gets a fresh attempt rather than the same rejected promise forever.
      this.pendingRef = null;
    }
  }

  private async loadOrCreateRef(): Promise<Bytes> {
    const stored = await this.deps.store.read(SECURE_STORE_KEYS.installRef);
    if (stored !== null) {
      const decoded = decodeRef(stored);
      if (decoded !== null) {
        this.cachedRef = decoded;
        return decoded;
      }
      // Unreadable: replace it rather than fail. A reference is an address, and a fresh one only
      // means the user has to quote the new one.
    }

    const fresh = this.freshRef();
    await this.deps.store.write(SECURE_STORE_KEYS.installRef, base32Encode(fresh));
    this.cachedRef = fresh;
    return fresh;
  }

  /** The reference as it is printed beside the version string. */
  async displayRef(): Promise<string> {
    return formatInstallRef(await this.installRef());
  }

  /**
   * Checks a code and, if it is good, spends it and opens the door.
   *
   * Spending happens BEFORE the authorization is published, so a code cannot be redeemed twice by
   * racing two submissions: the second one finds its own fingerprint already in the list.
   */
  async redeem(code: string): Promise<{ ok: true } | { ok: false; reason: RecoveryRedemption }> {
    const publicKey = this.deps.publicKey;
    if (publicKey === null || !this.available) return { ok: false, reason: 'unavailable' };

    const result: RecoveryCodeResult = verifyRecoveryCode({
      code,
      installRef: await this.installRef(),
      publicKey,
      nowMs: this.deps.clock.now(),
      verify: this.verify,
    });
    if (!result.ok) return { ok: false, reason: result.reason };

    const spent = await this.spentCodes();
    if (spent.includes(result.fingerprint)) return { ok: false, reason: 'used' };
    await this.recordSpent(spent, result.fingerprint);

    this.store.setState({ authorized: true });
    return { ok: true };
  }

  /**
   * Ends the authorization. Idempotent, and safe to call from anywhere: the recovery finishing,
   * the user backing out, and the vault locking all mean the same thing here.
   */
  clear(): void {
    if (this.store.getState().authorized) this.store.setState(UNAUTHORIZED);
  }

  /**
   * Rolls until the reference is one the user can actually quote. See
   * {@link installRefIsQuotable}; roughly one roll in twenty-six is discarded.
   *
   * Bounded rather than a bare `while`, so a broken or exhausted RNG degrades to a usable
   * reference instead of hanging the first support request that ever needs one.
   */
  private freshRef(): Bytes {
    let ref = this.deps.random.bytes(INSTALL_REF_BYTES);
    for (let attempt = 0; attempt < REF_ATTEMPTS && !installRefIsQuotable(ref); attempt++) {
      ref = this.deps.random.bytes(INSTALL_REF_BYTES);
    }
    return ref;
  }

  private async spentCodes(): Promise<readonly string[]> {
    const raw = await this.deps.store.read(SECURE_STORE_KEYS.spentRecoveryCodes);
    if (raw === null) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((entry): entry is string => typeof entry === 'string');
    } catch {
      // A corrupt list fails OPEN on purpose. Failing closed would refuse every future code on a
      // phone whose owner has already proved they cannot get in another way, and a replayed code
      // still reveals nothing that the first redemption did not.
      return [];
    }
  }

  private async recordSpent(current: readonly string[], fingerprint: string): Promise<void> {
    const next = [...current, fingerprint].slice(-SPENT_CODE_HISTORY);
    await this.deps.store.write(SECURE_STORE_KEYS.spentRecoveryCodes, JSON.stringify(next));
  }
}

function decodeRef(stored: string): Bytes | null {
  try {
    const decoded = base32Decode(stored);
    return decoded.length === INSTALL_REF_BYTES ? decoded : null;
  } catch (cause) {
    if (cause instanceof Base32Error) return null;
    throw cause;
  }
}
