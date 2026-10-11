/**
 * How many bytes an account's vault occupies, measured on the SERVER.
 *
 * This is the one number the banded price depends on, so it cannot come from the app: a client
 * that reports its own storage decides its own bill. It is measured by listing the account's
 * objects in SilentSum's bucket and adding up the sizes the storage layer reports -- the same
 * figure the bucket is billed for, not a figure derived from the vault manifest (which counts
 * plaintext, excludes the per-object envelope, and lives inside the encrypted index anyway).
 *
 * The listing is prefixed by uid and nothing else. `users/{uid}/` is the account's whole subtree
 * (`envelope`, `manifest`, `index.enc`, `photos/`, `thumbs/`, `vault/messaging`), which is
 * exactly the set the account is responsible for.
 */
import { getStorage } from 'firebase-admin/storage';

export interface StorageMeter {
  /** Total bytes stored for this account, or null when storage is not configured here. */
  measure(uid: string): Promise<number | null>;
}

/** The account's own subtree. A uid is a Firebase uid, so it needs no escaping -- but check. */
const UID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function accountPrefix(uid: string): string {
  if (!UID_PATTERN.test(uid)) throw new Error('not a uid');
  return `users/${uid}/`;
}

/**
 * Adds up `metadata.size`, which the GCS JSON API reports as a STRING of decimal digits. Parsing
 * it as a number is deliberate and so is ignoring anything unparseable: a missing size must
 * contribute zero rather than NaN, because one NaN would poison the total and `bandFor` would
 * then bill the cheapest band for an enormous vault.
 */
export function sumObjectSizes(
  objects: readonly { readonly metadata?: { readonly size?: unknown } }[],
): number {
  let total = 0;
  for (const object of objects) {
    const raw = object.metadata?.size;
    const size = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
    if (Number.isFinite(size) && size > 0) total += size;
  }
  return total;
}

/**
 * The real meter, over SilentSum's bucket.
 *
 * `bucketName` is passed in rather than defaulted, because on this shared Firebase project the
 * DEFAULT bucket belongs to EVPal. A null bucket means this deployment does not measure storage,
 * and every caller treats that as "cannot price a band" rather than as zero bytes.
 */
export class CloudStorageMeter implements StorageMeter {
  constructor(private readonly bucketName: string | null) {}

  async measure(uid: string): Promise<number | null> {
    if (this.bucketName === null) return null;
    const [objects] = await getStorage()
      .bucket(this.bucketName)
      .getFiles({ prefix: accountPrefix(uid) });
    return sumObjectSizes(objects);
  }
}
