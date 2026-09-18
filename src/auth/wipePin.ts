/**
 * The wipe PIN: a second PIN that destroys instead of opening.
 *
 * It exists for coercion. Someone who has the phone and is demanding it be opened gets a working
 * calculator; the owner types the wipe PIN, answers the one question it asks, and the configured
 * destruction runs in the background while the screen goes back to being a calculator and never
 * admits that anything happened.
 *
 * Three scopes, because the two copies are separately valuable. Destroying the device copy leaves
 * a user who can still recover from the cloud with their recovery passphrase; destroying the cloud
 * copy leaves the photos on the phone; destroying both leaves nothing, anywhere, for anyone.
 *
 * **Which scope is armed is never inferred.** {@link WIPE_SCOPE_LABEL} holds the only words the app
 * may use for a scope, and any screen showing one has to have read it from the stored record. A
 * picker's selection is a draft, not a fact. Conflating the two is not hypothetical: a default tick
 * sitting where the armed scope belonged once let an owner believe `device` was armed while the
 * record said `both`, and the wipe took their cloud backup with it. `WipePinScreen` keeps the
 * armed scope and the draft visually and structurally separate for exactly that reason.
 *
 * **Why the PIN is stored as itself.** The vault credential record already holds the vault PIN in
 * the clear, because recognising a contiguous PART of it cannot be done by deriving a key (see
 * `vaultCredentials.ts`). Hashing only this one would be theatre: an attacker who can read the
 * platform secure store already has the more valuable secret sitting next to it. So this record
 * matches that one -- same store, same protection, same documented cost.
 *
 * **Why it must never overlap the vault PIN.** The vault opens on a contiguous run of the PIN
 * spread across several calculations. If the wipe PIN were a substring of the vault PIN, a user
 * entering their own PIN in pieces would destroy their vault on the way in. {@link wipePinConflict}
 * refuses that arrangement, and the wipe PIN is matched on a whole result only, never a fragment.
 */
import { PIN_POLICY, type PinValidationError, type WipePinRecord, type WipeScope } from '@/auth/types';
import { validatePin } from '@/auth/pinPolicy';
import { RecordFormatError } from '@/crypto/types';
import { parseIso8601, toIso8601Utc } from '@/utils/iso8601';

export const WIPE_SCOPES: readonly WipeScope[] = ['device', 'backup', 'both'];

/**
 * The name of each scope, and the only one the app is allowed to print.
 *
 * These are used verbatim -- never lower-cased into a sentence, never abbreviated, never
 * paraphrased -- so that the words on the confirmation a user answers are character-for-character
 * the words on the line that later tells them what is armed. Anything looser makes "I chose this
 * device" and "the record says both" impossible to tell apart afterwards.
 */
export const WIPE_SCOPE_LABEL: Readonly<Record<WipeScope, string>> = {
  device: 'This device',
  backup: 'Cloud backup',
  both: 'Both',
};

/**
 * Whether a scope reaches the cloud at all.
 *
 * `device` never does, and `performScopedWipe` enforces that by short-circuiting before
 * `deleteCloudBackup` is so much as called. This predicate is the UI's copy of that same fact: it
 * decides which confirmations have to carry {@link WIPE_SCOPE_CLOUD_WARNING}.
 */
export function scopeDeletesCloud(scope: WipeScope): boolean {
  return scope !== 'device';
}

/**
 * The sentence a user has to have read before arming anything that deletes the cloud copy.
 *
 * It says "permanent" because it is. The envelope holds the only passphrase-wrapped copy of the
 * master key; once it is gone the blobs are noise, and no passphrase, support request or account
 * recovery brings them back. A scope picker that merely said "deletes the cloud backup" would be
 * true and still not convey that.
 */
export const WIPE_SCOPE_CLOUD_WARNING =
  'PERMANENT. Deleting the cloud backup also deletes the envelope holding your master key, so ' +
  'the encrypted copies become unreadable noise. Your recovery passphrase cannot bring them ' +
  'back, and neither can we. Nobody can.';

/** What each scope actually destroys, in the terms the user will care about afterwards. */
export const WIPE_SCOPE_DETAIL: Readonly<Record<WipeScope, string>> = {
  device:
    'Photos, videos, thumbnails, the index, the PIN and every decrypted temporary file are ' +
    'destroyed here. Your cloud backup is left alone, so you could still restore it later with ' +
    'your recovery passphrase.',
  backup:
    'The encrypted backup is deleted from the cloud, including the envelope that holds your key. ' +
    'Everything on this device stays exactly as it is.',
  both:
    'Everything, in both places. Nothing is left to restore from, by you or by anyone else. This ' +
    'is the only scope that leaves no copy anywhere.',
};

/** A stored name, or null when the value is not a scope this build knows. */
export function wipeScopeFromName(name: unknown): WipeScope | null {
  return typeof name === 'string' && (WIPE_SCOPES as readonly string[]).includes(name)
    ? (name as WipeScope)
    : null;
}

export function wipePinToJson(record: WipePinRecord): Record<string, unknown> {
  return {
    v: record.version,
    pin: record.pin,
    scope: record.scope,
    createdAt: toIso8601Utc(record.createdAt),
  };
}

export function wipePinFromJson(value: unknown): WipePinRecord {
  if (typeof value !== 'object' || value === null) {
    throw new RecordFormatError('wipe pin record is not an object');
  }
  const source = value as Record<string, unknown>;

  const version = source.v === undefined ? 1 : source.v;
  if (version !== 1) throw new RecordFormatError('unsupported wipe pin version');

  if (typeof source.pin !== 'string') throw new RecordFormatError('pin is not a string');
  if (validatePin(source.pin) !== null) {
    throw new RecordFormatError('stored wipe pin does not match policy');
  }

  const scope = wipeScopeFromName(source.scope);
  if (scope === null) throw new RecordFormatError('unknown wipe scope');

  return { version: 1, pin: source.pin, scope, createdAt: parseIso8601(source.createdAt) };
}

export function encodeWipePin(record: WipePinRecord): string {
  return JSON.stringify(wipePinToJson(record));
}

export function decodeWipePin(raw: string): WipePinRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RecordFormatError('wipe pin record is not valid JSON');
  }
  return wipePinFromJson(parsed);
}

/**
 * Whether a candidate wipe PIN can coexist with the vault PIN, or null when it can.
 *
 * Overlap in either direction is refused. A wipe PIN inside the vault PIN would fire while the
 * owner assembled their own PIN across calculations, which is the worst bug this feature could
 * have. The other direction is not dangerous -- the wipe PIN is checked first, so the vault PIN
 * could never be reached through it -- but it is confusing enough to be worth refusing too.
 *
 * A vault record written before the PIN was stored has nothing to compare against; there is no
 * safe check to make, so the caller is allowed to proceed.
 */
export function wipePinConflict(
  candidate: string,
  vaultPin: string | null,
): PinValidationError | null {
  if (vaultPin === null) return null;
  if (candidate === vaultPin) return 'sameAsVaultPin';
  if (vaultPin.includes(candidate) || candidate.includes(vaultPin)) return 'partOfVaultPin';
  return null;
}

/** The policy line shown under the PIN field, so the rules are not a guessing game. */
export const WIPE_PIN_RULE =
  `${String(PIN_POLICY.minLength)} to ${String(PIN_POLICY.maxLength)} digits, not starting with ` +
  '0, and it cannot be part of your vault PIN.';
