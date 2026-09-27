/**
 * The live unlocked session.
 *
 * The key material is deliberately NOT part of the observable state. It lives in a private field
 * that no selector, no React devtool and no serialiser can reach; components only ever observe
 * the boolean `isUnlocked`. That keeps decrypted keys out of anything that might snapshot,
 * persist or log application state.
 *
 * Sessions are never written to disk, so a process restart always starts locked.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';

import type { VaultKeys } from '@/crypto/types';
import { VaultLockedError } from '@/vault/types';

export interface VaultSessionState {
  readonly isUnlocked: boolean;
  /** Monotonic milliseconds at unlock, for display only. */
  readonly unlockedAtMs: number | null;
}

const LOCKED: VaultSessionState = { isUnlocked: false, unlockedAtMs: null };

export class VaultSession {
  readonly store: StoreApi<VaultSessionState>;

  private keys: VaultKeys | null = null;
  private readonly lockListeners = new Set<() => void>();
  private readonly unlockListeners = new Set<() => void>();

  constructor(private readonly monotonicMs: () => number) {
    this.store = createStore<VaultSessionState>()(() => LOCKED);
  }

  get isUnlocked(): boolean {
    return this.store.getState().isUnlocked;
  }

  /** Throws when locked, so every sensitive operation fails closed by construction. */
  requireKeys(): VaultKeys {
    const keys = this.keys;
    if (keys === null || keys.isDisposed) throw new VaultLockedError();
    return keys;
  }

  /** The keys, or null. Prefer {@link requireKeys} unless "maybe" is genuinely meaningful. */
  peekKeys(): VaultKeys | null {
    return this.keys !== null && !this.keys.isDisposed ? this.keys : null;
  }

  /** Takes ownership of `keys`; locking will dispose them. Replacing a session locks the old one. */
  adopt(keys: VaultKeys): void {
    if (this.keys !== null && this.keys !== keys) this.lock();
    this.keys = keys;
    this.store.setState({ isUnlocked: true, unlockedAtMs: this.monotonicMs() });
    // After the keys are in place, so a listener may derive from them straight away.
    for (const listener of this.unlockListeners) listener();
  }

  /** Wipes the key material and notifies listeners so caches can be cleared. Idempotent. */
  lock(): void {
    const keys = this.keys;
    this.keys = null;
    if (keys !== null) keys.dispose();
    if (this.store.getState().isUnlocked) this.store.setState(LOCKED);
    if (keys !== null) {
      for (const listener of this.lockListeners) listener();
    }
  }

  /** Called after the keys are already gone, so listeners cannot resurrect a session. */
  onLock(listener: () => void): () => void {
    this.lockListeners.add(listener);
    return () => {
      this.lockListeners.delete(listener);
    };
  }

  /**
   * Called after a session begins, for the things derived from the master key rather than stored
   * beside it. A listener that throws would break unlocking, so listeners must not.
   */
  onUnlock(listener: () => void): () => void {
    this.unlockListeners.add(listener);
    return () => {
      this.unlockListeners.delete(listener);
    };
  }
}
