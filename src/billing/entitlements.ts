/**
 * What a user is entitled to, as a value: no I/O, no Firebase, no clock of its own.
 *
 * The document this parses is written only by the backend (Cloud Functions with the Admin SDK);
 * the security rules let the owner READ `users/<uid>/billing/entitlements` and let nobody write
 * it. The app mirrors it, it never authors it. Everything here is therefore about reading that
 * document leniently and deriving display and gate decisions from it.
 *
 * Two independent facts live in it and must stay independent:
 *   - `pro` is a boolean with no expiry. It is set once by a successful ₱299 payment and never
 *     unset. Nothing about Cloud is consulted when deciding Pro.
 *   - `cloud.accessUntil` is the one date that says whether Cloud is on. "Expired" is not a stored
 *     state: it is what a date in the past means, whatever `status` last said.
 */
import { CLOUD_RENEWAL_WINDOW_DAYS } from '@/billing/products';
import { tryParseIso8601 } from '@/utils/iso8601';

export type CloudStatus = 'none' | 'active' | 'past_due' | 'unpaid' | 'cancelled' | 'incomplete';
export type CloudSource = 'term' | 'subscription';

export interface CloudEntitlement {
  readonly status: CloudStatus;
  /** Epoch ms. Cloud is on while this is in the future and `status` still grants access. */
  readonly accessUntil: number | null;
  readonly currentPeriodStart: number | null;
  readonly currentPeriodEnd: number | null;
  /** The user asked for it to stop; access continues to `accessUntil` and is not renewed. */
  readonly cancelAtPeriodEnd: boolean;
  /** `term`: paid month by month through checkout. `subscription`: a PayMongo subscription. */
  readonly source: CloudSource | null;
  readonly subscriptionId: string | null;
}

export interface Entitlements {
  readonly pro: boolean;
  /** Epoch ms of the payment that granted Pro; null while not Pro. */
  readonly proSince: number | null;
  readonly cloud: CloudEntitlement;
  readonly updatedAt: number | null;
}

export const FREE_ENTITLEMENTS: Entitlements = {
  pro: false,
  proSince: null,
  cloud: {
    status: 'none',
    accessUntil: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    source: null,
    subscriptionId: null,
  },
  updatedAt: null,
};

export const BILLING_PATHS = {
  /** Owner-readable, server-written. The only billing document the app ever reads. */
  entitlements: (uid: string) => `users/${uid}/billing/entitlements`,
} as const;

const DAY_MS = 86_400_000;

const CLOUD_STATUSES: readonly CloudStatus[] = [
  'none',
  'active',
  'past_due',
  'unpaid',
  'cancelled',
  'incomplete',
];

/**
 * The statuses under which a future `accessUntil` still means "on". `past_due` keeps what was
 * paid for until it runs out; `cancelled` likewise. `unpaid` and `incomplete` never grant access,
 * whatever date happens to be stored beside them.
 */
const ACCESS_STATUSES: readonly CloudStatus[] = ['active', 'past_due', 'cancelled'];

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * A moment in time from whatever shape it arrived in: epoch millis (the cache), an ISO string
 * (the in-memory backend and hand-written fixtures), or a Firestore `Timestamp` -- which reaches
 * this code as an object with `toMillis()` from the native SDK, and as `{seconds, nanoseconds}`
 * (or the `_`-prefixed pair) once it has been through JSON.
 */
function toMillis(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return tryParseIso8601(value);
  const o = record(value);
  if (o === null) return null;
  if (typeof o.toMillis === 'function') {
    const millis: unknown = (o.toMillis as () => unknown).call(o);
    return typeof millis === 'number' && Number.isFinite(millis) ? millis : null;
  }
  const seconds =
    typeof o.seconds === 'number' ? o.seconds : typeof o._seconds === 'number' ? o._seconds : null;
  if (seconds === null || !Number.isFinite(seconds)) return null;
  const nanos =
    typeof o.nanoseconds === 'number'
      ? o.nanoseconds
      : typeof o._nanoseconds === 'number'
        ? o._nanoseconds
        : 0;
  return seconds * 1000 + Math.floor(nanos / 1_000_000);
}

function cloudStatusFrom(value: unknown): CloudStatus {
  return typeof value === 'string' && (CLOUD_STATUSES as readonly string[]).includes(value)
    ? (value as CloudStatus)
    : 'none';
}

/**
 * Lenient: a missing document is the free tier, and so is any field that does not parse. It
 * never throws, because a malformed billing document must never be able to stop the vault.
 */
export function parseEntitlements(doc: Record<string, unknown> | null | undefined): Entitlements {
  const o = record(doc);
  if (o === null) return FREE_ENTITLEMENTS;
  const pro = o.pro === true;
  const c = record(o.cloud);
  const cloud: CloudEntitlement =
    c === null
      ? FREE_ENTITLEMENTS.cloud
      : {
          status: cloudStatusFrom(c.status),
          accessUntil: toMillis(c.accessUntil),
          currentPeriodStart: toMillis(c.currentPeriodStart),
          currentPeriodEnd: toMillis(c.currentPeriodEnd),
          cancelAtPeriodEnd: c.cancelAtPeriodEnd === true,
          source: c.source === 'term' || c.source === 'subscription' ? c.source : null,
          subscriptionId:
            typeof c.subscriptionId === 'string' && c.subscriptionId !== ''
              ? c.subscriptionId
              : null,
        };
  return {
    pro,
    proSince: pro ? toMillis(o.proSince) : null,
    cloud,
    updatedAt: toMillis(o.updatedAt),
  };
}

/** The cache encoding: plain numbers, so it round-trips through JSON and back through `parse`. */
export function entitlementsToJson(e: Entitlements): Record<string, unknown> {
  return {
    v: 1,
    pro: e.pro,
    proSince: e.proSince,
    cloud: {
      status: e.cloud.status,
      accessUntil: e.cloud.accessUntil,
      currentPeriodStart: e.cloud.currentPeriodStart,
      currentPeriodEnd: e.cloud.currentPeriodEnd,
      cancelAtPeriodEnd: e.cloud.cancelAtPeriodEnd,
      source: e.cloud.source,
      subscriptionId: e.cloud.subscriptionId,
    },
    updatedAt: e.updatedAt,
  };
}

/** Whether Cloud is on right now. The one question every cloud feature asks. */
export function cloudActive(e: Entitlements, nowMs: number): boolean {
  return (
    ACCESS_STATUSES.includes(e.cloud.status) &&
    e.cloud.accessUntil !== null &&
    e.cloud.accessUntil > nowMs
  );
}

export type CloudState =
  | { readonly kind: 'inactive' }
  | {
      readonly kind: 'active';
      readonly until: number;
      readonly daysLeft: number;
      /** Inside the renewal window: the screens offer "Renew" and say so. */
      readonly renewalDue: boolean;
      readonly cancelAtPeriodEnd: boolean;
      readonly pastDue: boolean;
      /**
       * The provider will charge again on its own, so there is nothing for the user to renew.
       *
       * True only for a real PayMongo subscription that has not been cancelled. A `term` is
       * bought one payment at a time and never renews itself, so it is false there -- which is
       * what keeps "Renew" working for the billing SilentSum actually has today.
       */
      readonly autoRenews: boolean;
    }
  | { readonly kind: 'expired'; readonly on: number };

/** The user-facing reading of the cloud fields, for status lines and buttons. */
export function deriveCloudState(e: Entitlements, nowMs: number): CloudState {
  const { cloud } = e;
  if (cloud.accessUntil === null || !ACCESS_STATUSES.includes(cloud.status)) {
    return { kind: 'inactive' };
  }
  if (cloud.accessUntil <= nowMs) return { kind: 'expired', on: cloud.accessUntil };
  const daysLeft = Math.ceil((cloud.accessUntil - nowMs) / DAY_MS);
  const cancelAtPeriodEnd = cloud.cancelAtPeriodEnd || cloud.status === 'cancelled';
  return {
    kind: 'active',
    until: cloud.accessUntil,
    daysLeft,
    renewalDue: daysLeft <= CLOUD_RENEWAL_WINDOW_DAYS,
    cancelAtPeriodEnd,
    pastDue: cloud.status === 'past_due',
    // Both halves matter. A cancelled subscription still has access running to its end, and
    // during that window it does NOT renew -- which is exactly when the user needs "Renew" back.
    autoRenews: cloud.source === 'subscription' && !cancelAtPeriodEnd,
  };
}

/**
 * The free tier. One constant, so that changing the offer is a one-line edit.
 *
 * Gates apply to ADDING items only: nothing already in the vault is ever hidden, locked or
 * deleted by a tier, and a vault that grew past the cap under Pro stays fully readable if Pro
 * were somehow lost. And they apply only in builds that can sell Pro (`enforced`): a build with
 * no billing keeps every feature open, because a gate whose key cannot be bought is not a tier.
 */
export const FREE_TIER = { maxItems: 50 } as const;

/**
 * The largest single item the vault will take, on every tier.
 *
 * It is a device limit, not a plan limit, so paying does not lift it: the item is encrypted into
 * local storage whatever the account has bought. The number matches the per-object ceiling in
 * `firebase/storage.rules`, so anything that can enter the vault can also be backed up -- a user
 * can never create an item that is impossible to protect.
 */
export const MAX_ITEM_BYTES = 100 * 1024 * 1024;

const GIB = 1024 * 1024 * 1024;

/**
 * What a Cloud term costs, by how much the vault actually holds.
 *
 * Cloud used to promise "unlimited", and the word was the whole liability: the product's own
 * limits -- 20,000 manifest entries at `MAX_ITEM_BYTES` -- allowed 1,953 GB against one ₱99
 * payment, which is roughly thirty times what it brings in. Bands replace that with a price
 * that follows the cost, so the customer who costs more pays more and nobody is subsidising
 * anybody.
 *
 * WHERE THE NUMBERS COME FROM. A stored GB costs about $0.0132 a month once Autoclass is on --
 * a backup is written once and read only on a restore, so most of it cools to Coldline and only
 * the last month sits in Standard. Add restore egress and the Autoclass management fee. A ₱99
 * card payment nets $1.28 after PayMongo's 3.5% + ₱15, so ₱99 breaks even somewhere near 97 GB.
 * Each band below is priced to keep roughly 35-65% of its net revenue at the TOP of the band,
 * where a subscriber costs the most.
 *
 * THE PRICES ARE A PROPOSAL, not a decision: they are one table, and the margin maths above is
 * what justifies them. For context they are two to four times Google One per GB (₱89/100 GB,
 * ₱139/200 GB, ₱449/2 TB). SilentSum cannot win on storage price -- retail GCS plus Philippine
 * card fees will not allow it -- so these are sized to be honest rather than competitive, and
 * the thing being sold is the encryption, not the gigabytes.
 *
 * The top band is also the ceiling, because something has to be. It bounds ADDITIONS ONLY,
 * exactly as `FREE_TIER` does: nothing stored is touched, nothing is deleted, and a vault over
 * it stays readable and restorable -- it simply stops taking new items.
 */
export interface CloudBand {
  /** Inclusive upper bound on stored plaintext bytes. */
  readonly maxBytes: number;
  readonly pricePhp: number;
  readonly priceCentavos: number;
  /** For copy: "64 GB". */
  readonly label: string;
}

export const CLOUD_BANDS: readonly CloudBand[] = [
  { maxBytes: 64 * GIB, pricePhp: 99, priceCentavos: 9900, label: '64 GB' },
  { maxBytes: 160 * GIB, pricePhp: 249, priceCentavos: 24900, label: '160 GB' },
  { maxBytes: 512 * GIB, pricePhp: 799, priceCentavos: 79900, label: '512 GB' },
];

/** The ceiling: the top band's bound. Past this the vault takes nothing new. */
export const CLOUD_TIER = {
  maxBytes: CLOUD_BANDS[CLOUD_BANDS.length - 1]?.maxBytes ?? 0,
} as const;

/**
 * The band a vault of this size falls in, or null when it is past the top one.
 *
 * Null is not an error: it is a vault over the ceiling, which keeps everything it has and stops
 * accepting more. Callers must not treat it as "free".
 */
export function bandFor(storedBytes: number): CloudBand | null {
  return CLOUD_BANDS.find((band) => storedBytes <= band.maxBytes) ?? null;
}

/**
 * What the next renewal will cost, in centavos, for a vault of this size.
 *
 * Billed on what is STORED at the moment of charging rather than on a plan chosen up front, so
 * a vault that shrinks costs less next month without anybody having to ask. A vault over the
 * ceiling is charged at the top band -- it cannot grow, and charging nothing for the largest
 * vaults would be exactly backwards.
 */
export function cloudChargeCentavos(storedBytes: number): number {
  const band = bandFor(storedBytes);
  if (band !== null) return band.priceCentavos;
  return CLOUD_BANDS[CLOUD_BANDS.length - 1]?.priceCentavos ?? 0;
}

export type GateReason = 'itemLimit' | 'fileSize' | 'cloudStorageLimit';

export type GateDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: GateReason };

/**
 * Whether one more item may be added to the vault.
 *
 * Photos and video are the same thing here, deliberately: one item is one item, whatever it
 * holds, and a vault of fifty videos is a legitimate way to spend a free vault. The only thing
 * that distinguishes a video is its size, which `MAX_ITEM_BYTES` already bounds for both.
 *
 * There is no Pro input and there must never be one. The vault's size is a Cloud service; Pro
 * buys messaging. An expired term stops new additions and changes nothing already in the vault --
 * every photo, video and key stays exactly where it is, readable offline, forever.
 *
 * `bytes` is 0 when the size is not yet known (a capture that has not been written out). The size
 * check is then skipped here and made by the caller once the file exists.
 */
export function vaultGate(input: {
  readonly cloudActive: boolean;
  readonly enforced: boolean;
  readonly itemCount: number;
  readonly bytes: number;
  /** Everything the vault already holds, in plaintext bytes. See {@link CLOUD_TIER}. */
  readonly storedBytes: number;
}): GateDecision {
  if (!input.enforced) return { allowed: true };
  if (input.bytes > MAX_ITEM_BYTES) return { allowed: false, reason: 'fileSize' };
  if (input.cloudActive) {
    // Measured against what this item WOULD make the total, not what it is now, so the cap is
    // never crossed rather than noticed afterwards.
    return input.storedBytes + input.bytes > CLOUD_TIER.maxBytes
      ? { allowed: false, reason: 'cloudStorageLimit' }
      : { allowed: true };
  }
  if (input.itemCount >= FREE_TIER.maxItems) return { allowed: false, reason: 'itemLimit' };
  return { allowed: true };
}
