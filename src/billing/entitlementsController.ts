/**
 * The app's view of what the account has paid for.
 *
 * Three sources feed one store, in a strict order of trust:
 *
 *  1. The LIVE document `users/<uid>/billing/entitlements`, followed with a Firestore listener
 *     while a backup account is signed in. Only the backend writes it; the app only ever reads.
 *  2. A one-off read of the same document (`refresh`), for screens that must know NOW rather
 *     than after the next snapshot -- the restore flow, straight after sign-in.
 *  3. A CACHE of the last document seen, in the secure store. It exists for one reason: Pro is a
 *     permanent, local entitlement, and a phone in airplane mode must still be Pro. It is a
 *     mirror, never an authority. Nothing on the server reads it, the security rules never trust
 *     it, and every Cloud feature checks the live document before it acts.
 *
 * Signing out does NOT clear the cache: the device that bought Pro stays Pro, which is the
 * promise made at purchase. Signing in as a DIFFERENT account replaces it, because entitlements
 * are filed under the account and a stale mirror of someone else's would be a lie. Erasing the
 * vault removes it with everything else (see `ALL_SECURE_STORE_KEYS`).
 *
 * Gates (`gate`) apply only when `enforced`: a build that cannot sell Pro has nothing to gate.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';

import {
  BILLING_PATHS,
  FREE_ENTITLEMENTS,
  cloudActive,
  deriveCloudState,
  entitlementsToJson,
  parseEntitlements,
  vaultGate,
  type CloudState,
  type Entitlements,
  type GateDecision,
} from '@/billing/entitlements';
import type { CloudBackend, CloudUser } from '@/firebase/types';
import { SECURE_STORE_KEYS, type SecureStore } from '@/secure-storage/secureStore';
import type { Clock } from '@/utils/clock';

export interface EntitlementsState {
  readonly entitlements: Entitlements;
  /** The account the entitlements belong to, or null when nothing has ever been seen. */
  readonly uid: string | null;
  /** True once the live document has been read in this session; false while running on cache. */
  readonly synced: boolean;
  /** Whether the free tier is enforced in this build (i.e. Pro can actually be bought here). */
  readonly enforced: boolean;
}

export interface EntitlementsDeps {
  readonly secureStore: SecureStore;
  readonly clock: Clock;
  /** Null when the build has no cloud: the controller then only ever reports the cache. */
  readonly cloud: CloudBackend | null;
  readonly enforced: boolean;
}

interface CacheRecord {
  readonly v: 1;
  readonly uid: string;
  readonly entitlements: Record<string, unknown>;
  readonly cachedAt: number;
}

export class EntitlementsController {
  readonly store: StoreApi<EntitlementsState>;

  private readonly deps: EntitlementsDeps;
  private stopDocument: (() => void) | null = null;
  /** The last cache write, so callers (tests, mostly) can wait for it. */
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(deps: EntitlementsDeps) {
    this.deps = deps;
    this.store = createStore<EntitlementsState>()(() => ({
      entitlements: FREE_ENTITLEMENTS,
      uid: null,
      synced: false,
      enforced: deps.enforced,
    }));
  }

  get current(): Entitlements {
    return this.store.getState().entitlements;
  }

  get enforced(): boolean {
    return this.deps.enforced;
  }

  isPro(): boolean {
    return this.current.pro;
  }

  isCloudActive(): boolean {
    return cloudActive(this.current, this.deps.clock.now());
  }

  cloudState(): CloudState {
    return deriveCloudState(this.current, this.deps.clock.now());
  }

  /** Whether one more item of `bytes` may be added when the vault already holds `itemCount`. */
  gate(itemCount: number, bytes: number): GateDecision {
    return vaultGate({
      cloudActive: this.isCloudActive(),
      enforced: this.deps.enforced,
      itemCount,
      bytes,
    });
  }

  /** Reads the cache once at startup. A missing or unreadable cache means the free tier. */
  async load(): Promise<void> {
    const cached = await this.readCache();
    if (cached === null) return;
    this.store.setState({ entitlements: cached.entitlements, uid: cached.uid, synced: false });
  }

  /**
   * Follows the signed-in account: subscribes to its document, re-subscribes when the account
   * changes, and stops when it signs out. Returns the function that ends all of it.
   */
  start(): () => void {
    const cloud = this.deps.cloud;
    if (cloud === null) return () => undefined;
    const stopAuth = cloud.onAuthStateChanged((user) => {
      this.follow(cloud, user);
    });
    return () => {
      stopAuth();
      this.unfollow();
    };
  }

  /**
   * One read of the live document for the signed-in user, applied to the store and the cache.
   * With nobody signed in, or when the read fails, the current (cached) value is returned and
   * `synced` is left as it was: a failed read is not knowledge.
   */
  async refresh(): Promise<Entitlements> {
    const cloud = this.deps.cloud;
    const user = cloud?.currentUser ?? null;
    if (cloud === null || user === null) return this.current;
    let doc: Record<string, unknown> | null;
    try {
      doc = await cloud.getDocument(BILLING_PATHS.entitlements(user.uid));
    } catch {
      return this.current;
    }
    return this.apply(user.uid, parseEntitlements(doc));
  }

  /** Vault erase: forget the mirror along with everything else. */
  async reset(): Promise<void> {
    this.store.setState({ entitlements: FREE_ENTITLEMENTS, uid: null, synced: false });
    try {
      await this.deps.secureStore.delete(SECURE_STORE_KEYS.entitlements);
    } catch {
      // The in-memory state is already free; a stale cache row is harmless and read-only.
    }
  }

  /** Waits for the most recent cache write. */
  async flush(): Promise<void> {
    await this.pendingWrite;
  }

  private follow(cloud: CloudBackend, user: CloudUser | null): void {
    this.unfollow();
    if (user === null) {
      this.store.setState({ synced: false });
      return;
    }
    if (this.store.getState().uid !== user.uid) {
      // Another account: whatever the mirror said belonged to someone else.
      this.apply(user.uid, FREE_ENTITLEMENTS, false);
    }
    try {
      this.stopDocument = cloud.watchDocument(
        BILLING_PATHS.entitlements(user.uid),
        (doc) => {
          this.apply(user.uid, parseEntitlements(doc));
        },
        () => {
          // A refused or failed listener changes nothing: the last known value stands, unsynced.
          this.store.setState({ synced: false });
        },
      );
    } catch {
      this.store.setState({ synced: false });
    }
  }

  private unfollow(): void {
    const stop = this.stopDocument;
    this.stopDocument = null;
    stop?.();
  }

  private apply(uid: string, entitlements: Entitlements, synced = true): Entitlements {
    this.store.setState({ entitlements, uid, synced });
    this.pendingWrite = this.writeCache(uid, entitlements);
    return entitlements;
  }

  private async writeCache(uid: string, entitlements: Entitlements): Promise<void> {
    const record: CacheRecord = {
      v: 1,
      uid,
      entitlements: entitlementsToJson(entitlements),
      cachedAt: this.deps.clock.now(),
    };
    try {
      await this.deps.secureStore.write(SECURE_STORE_KEYS.entitlements, JSON.stringify(record));
    } catch {
      // The store already has the value for this session; the mirror is best effort.
    }
  }

  private async readCache(): Promise<{ uid: string; entitlements: Entitlements } | null> {
    let raw: string | null;
    try {
      raw = await this.deps.secureStore.read(SECURE_STORE_KEYS.entitlements);
    } catch {
      return null;
    }
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return null;
      const record = parsed as Partial<CacheRecord>;
      if (record.v !== 1 || typeof record.uid !== 'string' || record.uid === '') return null;
      if (typeof record.entitlements !== 'object' || record.entitlements === null) return null;
      return { uid: record.uid, entitlements: parseEntitlements(record.entitlements) };
    } catch {
      return null;
    }
  }
}
