/**
 * Which backup account this device's vault belongs to.
 *
 * The vault is device-scoped and the cloud is account-scoped, and nothing used to connect the two.
 * That gap is what let one account's photos be uploaded into another's: sign out of A, sign into
 * B, and the only thing the backup service could see was "a vault" and "an account", with no way
 * to notice they had never met. Every write path now consults this record first.
 *
 * It holds a uid and a timestamp. The uid is not a secret -- it is the account the user signed in
 * with, on their own device -- but it lives in the secure store rather than app settings because
 * that is where the vault's own lifecycle is: {@link ALL_SECURE_STORE_KEYS} is what the wipe
 * clears, and erasing a vault must forget which account it was backed up to.
 *
 * It is deliberately NOT a vault identity. A uid cannot tell this device's vault apart from a
 * different vault on a different device that happens to use the same account; that needs a
 * `vaultId` derived from the master key and recorded in the cloud, which is a schema change and a
 * Firestore rules deploy. Until then the cryptographic check already in `readCloudIndex` -- the
 * cloud index either decrypts under this vault's key or it does not -- is what covers the
 * cross-DEVICE case, and this record covers the cross-ACCOUNT case on one device.
 */
import { SECURE_STORE_KEYS, type SecureStore } from '@/secure-storage/secureStore';

/** The account this device's vault was last backed up to. */
export interface VaultOwner {
  readonly uid: string;
  /** Epoch ms UTC, for diagnostics; nothing branches on it. */
  readonly boundAt: number;
}

/**
 * What the record says about the account that is signed in now.
 *
 * `unbound` is not a weaker form of `other-account`: it means this vault has never been backed up
 * anywhere, so there is no other account whose photos could be disturbed and the first backup is
 * an ordinary first backup rather than a transfer.
 */
export type Ownership =
  | { readonly kind: 'unbound' }
  | { readonly kind: 'owned' }
  | { readonly kind: 'other-account'; readonly ownerUid: string };

export function ownershipFor(owner: VaultOwner | null, uid: string): Ownership {
  if (owner === null) return { kind: 'unbound' };
  if (owner.uid === uid) return { kind: 'owned' };
  return { kind: 'other-account', ownerUid: owner.uid };
}

/** A record that exists but cannot be read is treated as a mismatch, never as "no owner". */
const UNREADABLE: VaultOwner = { uid: '', boundAt: 0 };

export class VaultOwnerStore {
  constructor(private readonly store: SecureStore) {}

  /**
   * Null only when nothing has ever been written. A present but malformed record resolves to an
   * owner whose uid matches nobody, so the caller fails closed and asks rather than silently
   * treating a damaged record as permission.
   */
  async read(): Promise<VaultOwner | null> {
    const raw = await this.store.read(SECURE_STORE_KEYS.vaultOwner);
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return UNREADABLE;
      const uid = (parsed as { uid?: unknown }).uid;
      const boundAt = (parsed as { boundAt?: unknown }).boundAt;
      if (typeof uid !== 'string' || uid === '') return UNREADABLE;
      return { uid, boundAt: typeof boundAt === 'number' ? boundAt : 0 };
    } catch {
      return UNREADABLE;
    }
  }

  /** Records that `uid`'s cloud backup now holds this vault. Overwrites any previous owner. */
  async bind(uid: string, now: number): Promise<void> {
    await this.store.write(
      SECURE_STORE_KEYS.vaultOwner,
      JSON.stringify({ uid, boundAt: now } satisfies VaultOwner),
    );
  }

  /** Used when an account's cloud data is deleted, so the vault is unowned again. */
  async clear(): Promise<void> {
    await this.store.delete(SECURE_STORE_KEYS.vaultOwner);
  }
}
