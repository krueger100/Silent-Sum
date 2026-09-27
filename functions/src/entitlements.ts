/**
 * The entitlement document and every transition it can make. Pure: no Firestore, no clock of
 * its own, no PayMongo. The store (`store.ts`) turns these values into documents and back.
 *
 * Two facts, kept apart on purpose:
 *   - `pro` is set once by a successful payment and never unset. No transition here reads or
 *     writes it except `grantPro`.
 *   - `cloud.accessUntil` is the one date that decides whether Cloud is on. It is what the
 *     security rules compare with `request.time`, so it must always be a real timestamp in the
 *     document (the store converts).
 *
 * Time is epoch milliseconds throughout.
 */
export const DAY_MS = 86_400_000;

/** Days of access granted by one Cloud payment when the config does not say otherwise. */
export const DEFAULT_CLOUD_TERM_DAYS = 30;

/** Assumed billing period for a paid subscription invoice that names no next billing date. */
const ASSUMED_SUBSCRIPTION_PERIOD_DAYS = 31;

/** Days of access past a subscription period end, so a slow retry does not cut Cloud mid-day. */
export const SUBSCRIPTION_GRACE_DAYS = 3;

export type CloudStatus = 'none' | 'active' | 'past_due' | 'unpaid' | 'cancelled' | 'incomplete';
export type CloudSource = 'term' | 'subscription';

export interface CloudEntitlement {
  readonly status: CloudStatus;
  readonly accessUntil: number | null;
  readonly currentPeriodStart: number | null;
  readonly currentPeriodEnd: number | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly source: CloudSource | null;
  readonly subscriptionId: string | null;
}

export interface Entitlements {
  readonly v: 1;
  readonly pro: boolean;
  readonly proSince: number | null;
  readonly proPaymentId: string | null;
  readonly cloud: CloudEntitlement;
  readonly updatedAt: number;
}

const NO_CLOUD: CloudEntitlement = {
  status: 'none',
  accessUntil: null,
  currentPeriodStart: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  source: null,
  subscriptionId: null,
};

export function defaultEntitlements(now: number): Entitlements {
  return { v: 1, pro: false, proSince: null, proPaymentId: null, cloud: NO_CLOUD, updatedAt: now };
}

/** The statuses under which a future `accessUntil` still means "on". */
const ACCESS_STATUSES: readonly CloudStatus[] = ['active', 'past_due', 'cancelled'];

export function cloudActive(e: Entitlements, now: number): boolean {
  return (
    ACCESS_STATUSES.includes(e.cloud.status) &&
    e.cloud.accessUntil !== null &&
    e.cloud.accessUntil > now
  );
}

/** Pro, once. A second payment for an account that has it changes nothing and says so. */
export function grantPro(
  current: Entitlements,
  input: { readonly paymentId: string; readonly now: number },
): { readonly next: Entitlements; readonly changed: boolean } {
  if (current.pro) return { next: current, changed: false };
  return {
    next: {
      ...current,
      pro: true,
      proSince: input.now,
      proPaymentId: input.paymentId,
      updatedAt: input.now,
    },
    changed: true,
  };
}

/**
 * One paid term of Cloud, added to whatever time was already paid for. A lapsed term starts
 * again from now rather than being back-dated, and paying again withdraws any cancellation.
 */
export function extendCloudTerm(
  current: Entitlements,
  input: { readonly now: number; readonly termDays: number },
): Entitlements {
  const paidUntil = current.cloud.accessUntil ?? input.now;
  const start = Math.max(input.now, paidUntil);
  const end = start + input.termDays * DAY_MS;
  return {
    ...current,
    cloud: {
      status: 'active',
      accessUntil: end,
      currentPeriodStart: start,
      currentPeriodEnd: end,
      cancelAtPeriodEnd: false,
      source: 'term',
      subscriptionId: current.cloud.subscriptionId,
    },
    updatedAt: input.now,
  };
}

/** Stops renewal; what was paid for stays. Nothing to cancel is nothing to change. */
export function cancelCloudAtPeriodEnd(current: Entitlements, now: number): Entitlements {
  if (current.cloud.status === 'none' && current.cloud.accessUntil === null) return current;
  return {
    ...current,
    cloud: { ...current.cloud, status: 'cancelled', cancelAtPeriodEnd: true },
    updatedAt: now,
  };
}

export type SubscriptionEventKind =
  'invoice.paid' | 'invoice.payment_failed' | 'past_due' | 'unpaid' | 'updated';

export interface SubscriptionEventInput {
  readonly kind: SubscriptionEventKind;
  readonly subscriptionId: string;
  /** For `updated`: the subscription's status as PayMongo reports it. */
  readonly status?: string | null;
  /** For `invoice.paid`: the end of the period the invoice covers, when the event carries it. */
  readonly periodEndMs?: number | null;
  readonly now: number;
  readonly graceDays?: number;
}

/**
 * How a PayMongo subscription event moves the document. These are the semantics the app is
 * written against; the term-based path above produces the same shape, which is what lets a
 * merchant switch to native subscriptions later without a migration.
 */
export function applySubscriptionEvent(
  current: Entitlements,
  ev: SubscriptionEventInput,
): Entitlements {
  const grace = (ev.graceDays ?? SUBSCRIPTION_GRACE_DAYS) * DAY_MS;
  const cloud = current.cloud;
  switch (ev.kind) {
    case 'invoice.paid': {
      const periodEnd = ev.periodEndMs ?? ev.now + ASSUMED_SUBSCRIPTION_PERIOD_DAYS * DAY_MS;
      return {
        ...current,
        cloud: {
          status: 'active',
          accessUntil: periodEnd + grace,
          currentPeriodStart: ev.now,
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd: false,
          source: 'subscription',
          subscriptionId: ev.subscriptionId,
        },
        updatedAt: ev.now,
      };
    }
    case 'past_due':
    case 'invoice.payment_failed':
      return {
        ...current,
        cloud: { ...cloud, status: 'past_due', subscriptionId: ev.subscriptionId },
        updatedAt: ev.now,
      };
    case 'unpaid':
      return {
        ...current,
        cloud: {
          ...cloud,
          status: 'unpaid',
          accessUntil: Math.min(cloud.accessUntil ?? ev.now, ev.now),
          subscriptionId: ev.subscriptionId,
        },
        updatedAt: ev.now,
      };
    case 'updated':
      return applySubscriptionStatus(current, ev);
  }
}

function applySubscriptionStatus(current: Entitlements, ev: SubscriptionEventInput): Entitlements {
  const cloud = current.cloud;
  const updated = (patch: Partial<CloudEntitlement>): Entitlements => ({
    ...current,
    cloud: { ...cloud, ...patch, subscriptionId: ev.subscriptionId },
    updatedAt: ev.now,
  });
  switch (ev.status) {
    case 'active':
      return updated({ status: 'active' });
    case 'past_due':
      return updated({ status: 'past_due' });
    case 'unpaid':
      return updated({
        status: 'unpaid',
        accessUntil: Math.min(cloud.accessUntil ?? ev.now, ev.now),
      });
    case 'cancelled':
      // What was paid for stays; it simply is not renewed.
      return updated({ status: 'cancelled', cancelAtPeriodEnd: true });
    case 'incomplete':
      return updated({ status: 'incomplete' });
    case 'incomplete_cancelled':
      // Never paid: there was nothing to keep.
      return updated({ status: 'none', accessUntil: null, cancelAtPeriodEnd: false });
    default:
      return current;
  }
}
