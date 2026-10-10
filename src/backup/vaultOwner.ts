/**
 * A local note of which backup account this device's vault was last backed up to.
 *
 * The vault is device-scoped and the cloud is account-scoped, and nothing used to connect the two.
 * That gap is what let one account's photos be uploaded into another's: sign out of A, sign into
 * B, and the only thing the backup service could see was "a vault" and "an account", with no way
 * to notice they had never met.
 *
 * **It is a cache, not an authority.** That distinction is the whole design and it was not here
 * originally. This record holds one uid, so it cannot represent a vault that legitimately owns the
 * backups of two accounts -- which is an ordinary thing for one person with two accounts on one
 * phone to have. Treated as an authority it refused a write every time they switched, and it
 * refused everything outright when the stored value could not be parsed, neither of which is a
 * fact about anyone's data. The account's own envelope carries a `vaultId` derived from the master
 * key, and THAT is the record that says whether a vault owns an account's backup. Where the two
 * disagree, the cloud is right and this gets rewritten; where the cloud has nothing to say, this
 * decides whether to ASK, never whether to refuse. See `BackupService.assertMayWrite`.
 *
 * The uid is not a secret -- it is the account the user signed in with, on their own device -- but
 * it lives in the secure store rather than app settings because that is where the vault's own
 * lifecycle is: {@link ALL_SECURE_STORE_KEYS} is what the wipe clears, and erasing a vault must
 * forget which account it was backed up to.
 */
import { SECURE_STORE_KEYS, type SecureStore } from '@/secure-storage/secureStore';

/** The account this device's vault was last backed up to. */
export interface VaultOwner {
  readonly uid: string;
  /** Epoch ms UTC, for diagnostics; nothing branches on it. */
  readonly boundAt: number;
}

/**
 * What the stored record amounts to.
 *
 * `unreadable` is kept apart from the other two on purpose. It used to be folded into "owned by
 * somebody else", which reads a damaged byte as a statement about another account's photos; it is
 * no such thing, and a user whose record got corrupted was refused every backup on the strength of
 * it. It now means only what it says: this device cannot tell.
 */
export type VaultOwnerRecord =
  | { readonly kind: 'none' }
  | { readonly kind: 'bound'; readonly owner: VaultOwner }
  | { readonly kind: 'unreadable' };

/**
 * What the record says about the account that is signed in now.
 *
 * `unbound` is not a weaker form of `other-account`: it means this vault has never been backed up
 * anywhere, so there is no other account whose photos could be disturbed and the first backup is
 * an ordinary first backup rather than a transfer. `unknown` is weaker than both -- the note is
 * unreadable, so nothing at all follows from it.
 */
export type Ownership =
  | { readonly kind: 'unbound' }
  | { readonly kind: 'owned' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'other-account'; readonly ownerUid: string };

export function ownershipFor(record: VaultOwnerRecord, uid: string): Ownership {
  switch (record.kind) {
    case 'none':
      return { kind: 'unbound' };
    case 'unreadable':
      return { kind: 'unknown' };
    case 'bound':
      return record.owner.uid === uid
        ? { kind: 'owned' }
        : { kind: 'other-account', ownerUid: record.owner.uid };
  }
}

export class VaultOwnerStore {
  constructor(private readonly store: SecureStore) {}

  /**
   * `none` only when nothing has ever been written; `unreadable` when something was written and
   * cannot be understood. The caller is expected to verify against the cloud rather than act on
   * either as though it settled anything.
   */
  async read(): Promise<VaultOwnerRecord> {
    const raw = await this.store.read(SECURE_STORE_KEYS.vaultOwner);
    if (raw === null) return { kind: 'none' };
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return { kind: 'unreadable' };
      const uid = (parsed as { uid?: unknown }).uid;
      const boundAt = (parsed as { boundAt?: unknown }).boundAt;
      if (typeof uid !== 'string' || uid === '') return { kind: 'unreadable' };
      return { kind: 'bound', owner: { uid, boundAt: typeof boundAt === 'number' ? boundAt : 0 } };
    } catch {
      return { kind: 'unreadable' };
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
