/**
 * `BillingStore` on Cloud Firestore through the Admin SDK.
 *
 * Layout (see `firebase/firestore.merged.rules` for who may read what):
 *   users/{uid}/billing/entitlements       owner-readable, written only from here
 *   silentsum_billing_refs/{paymongoId}    server-only: which account a PayMongo id belongs to
 *   silentsum_billing_events/{eventId}     server-only: every webhook delivery, once
 *   silentsum_billing_payments/{paymentId} server-only: every payment applied, once
 *   silentsum_billing_plans/{bandKey}      server-only: the PayMongo plan for one price band
 *   silentsum_billing_customers/{uid}      server-only: the account's PayMongo customer id
 *
 * Dates are stored as Firestore `Timestamp`s, because the security rules compare
 * `cloud.accessUntil` with `request.time`; the domain works in epoch milliseconds, and the
 * conversion happens here and only here. `applyPayment` is one transaction: the ledger entry
 * and the entitlement change land together or not at all.
 */
import {
  Timestamp,
  type DocumentData,
  type Firestore,
  type Transaction,
} from 'firebase-admin/firestore';

import { defaultEntitlements, type CloudStatus, type Entitlements } from './entitlements';
import type { ApplyResult, BillingRef, BillingStore, EventRecord, PaymentRecord } from './store';

export const COLLECTIONS = {
  refs: 'silentsum_billing_refs',
  events: 'silentsum_billing_events',
  payments: 'silentsum_billing_payments',
  plans: 'silentsum_billing_plans',
  customers: 'silentsum_billing_customers',
} as const;

export function entitlementsPath(uid: string): string {
  return `users/${uid}/billing/entitlements`;
}

function stamp(ms: number | null): Timestamp | null {
  return ms === null ? null : Timestamp.fromMillis(ms);
}

function millis(value: unknown): number | null {
  if (value instanceof Timestamp) return value.toMillis();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

const CLOUD_STATUSES: readonly CloudStatus[] = [
  'none',
  'active',
  'past_due',
  'unpaid',
  'cancelled',
  'incomplete',
];

export function entitlementsToDocument(e: Entitlements): DocumentData {
  return {
    v: 1,
    pro: e.pro,
    proSince: stamp(e.proSince),
    proPaymentId: e.proPaymentId,
    cloud: {
      status: e.cloud.status,
      accessUntil: stamp(e.cloud.accessUntil),
      currentPeriodStart: stamp(e.cloud.currentPeriodStart),
      currentPeriodEnd: stamp(e.cloud.currentPeriodEnd),
      cancelAtPeriodEnd: e.cloud.cancelAtPeriodEnd,
      source: e.cloud.source,
      subscriptionId: e.cloud.subscriptionId,
    },
    updatedAt: stamp(e.updatedAt),
  };
}

/** Lenient on the way in, like the app's own parser: a damaged document reads as the free tier. */
export function entitlementsFromDocument(
  data: DocumentData | undefined,
  now: number,
): Entitlements {
  const base = defaultEntitlements(now);
  if (data === undefined) return base;
  const cloud =
    typeof data.cloud === 'object' && data.cloud !== null ? (data.cloud as DocumentData) : {};
  const status = CLOUD_STATUSES.includes(cloud.status as CloudStatus)
    ? (cloud.status as CloudStatus)
    : 'none';
  const pro = data.pro === true;
  return {
    v: 1,
    pro,
    proSince: pro ? millis(data.proSince) : null,
    proPaymentId: pro && typeof data.proPaymentId === 'string' ? data.proPaymentId : null,
    cloud: {
      status,
      accessUntil: millis(cloud.accessUntil),
      currentPeriodStart: millis(cloud.currentPeriodStart),
      currentPeriodEnd: millis(cloud.currentPeriodEnd),
      cancelAtPeriodEnd: cloud.cancelAtPeriodEnd === true,
      source: cloud.source === 'term' || cloud.source === 'subscription' ? cloud.source : null,
      subscriptionId: typeof cloud.subscriptionId === 'string' ? cloud.subscriptionId : null,
    },
    updatedAt: millis(data.updatedAt) ?? now,
  };
}

function refToDocument(ref: BillingRef): DocumentData {
  switch (ref.kind) {
    case 'checkout':
      return {
        kind: ref.kind,
        uid: ref.uid,
        product: ref.product,
        ref: ref.ref,
        amountCentavos: ref.amountCentavos,
        currency: ref.currency,
        status: ref.status,
        createdAt: stamp(ref.createdAt),
        paidAt: stamp(ref.paidAt),
        paymentId: ref.paymentId,
      };
    case 'subscription':
    case 'customer':
      return { kind: ref.kind, uid: ref.uid, createdAt: stamp(ref.createdAt) };
  }
}

function refFromDocument(id: string, data: DocumentData): BillingRef | null {
  if (typeof data.uid !== 'string') return null;
  const createdAt = millis(data.createdAt) ?? 0;
  if (data.kind === 'subscription' || data.kind === 'customer') {
    return { kind: data.kind, id, uid: data.uid, createdAt };
  }
  if (data.kind !== 'checkout' || (data.product !== 'pro' && data.product !== 'cloud')) return null;
  const status = data.status;
  return {
    kind: 'checkout',
    id,
    uid: data.uid,
    product: data.product,
    ref: typeof data.ref === 'string' ? data.ref : '',
    amountCentavos: typeof data.amountCentavos === 'number' ? data.amountCentavos : 0,
    currency: typeof data.currency === 'string' ? data.currency : 'PHP',
    status: status === 'paid' || status === 'failed' || status === 'expired' ? status : 'open',
    createdAt,
    paidAt: millis(data.paidAt),
    paymentId: typeof data.paymentId === 'string' ? data.paymentId : null,
  };
}

function paymentToDocument(record: PaymentRecord): DocumentData {
  return {
    uid: record.uid,
    product: record.product,
    amountCentavos: record.amountCentavos,
    currency: record.currency,
    checkoutSessionId: record.checkoutSessionId,
    eventId: record.eventId,
    source: record.source,
    paidAt: stamp(record.paidAt),
    appliedAt: stamp(record.appliedAt),
    outcome: record.outcome,
  };
}

export class FirestoreBillingStore implements BillingStore {
  constructor(
    private readonly db: Firestore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async getEntitlements(uid: string): Promise<Entitlements | null> {
    const snapshot = await this.db.doc(entitlementsPath(uid)).get();
    return snapshot.exists ? entitlementsFromDocument(snapshot.data(), this.now()) : null;
  }

  async putRef(ref: BillingRef): Promise<void> {
    await this.db.collection(COLLECTIONS.refs).doc(ref.id).set(refToDocument(ref));
  }

  async getRef(id: string): Promise<BillingRef | null> {
    const snapshot = await this.db.collection(COLLECTIONS.refs).doc(id).get();
    const data = snapshot.data();
    return snapshot.exists && data !== undefined ? refFromDocument(id, data) : null;
  }

  async updateRef(id: string, patch: Partial<Omit<BillingRef, 'kind' | 'id'>>): Promise<void> {
    const data: DocumentData = {};
    for (const [key, value] of Object.entries(patch)) {
      data[key] = key === 'paidAt' || key === 'createdAt' ? stamp(value as number | null) : value;
    }
    await this.db.collection(COLLECTIONS.refs).doc(id).set(data, { merge: true });
  }

  async getPlanId(key: string): Promise<string | null> {
    const snapshot = await this.db.collection(COLLECTIONS.plans).doc(key).get();
    const planId = snapshot.data()?.planId;
    return typeof planId === 'string' && planId !== '' ? planId : null;
  }

  async putPlanId(key: string, planId: string, createdAt: number): Promise<void> {
    await this.db
      .collection(COLLECTIONS.plans)
      .doc(key)
      .set({ planId, createdAt: stamp(createdAt) });
  }

  async getCustomerId(uid: string): Promise<string | null> {
    const snapshot = await this.db.collection(COLLECTIONS.customers).doc(uid).get();
    const customerId = snapshot.data()?.customerId;
    return typeof customerId === 'string' && customerId !== '' ? customerId : null;
  }

  async putCustomerId(uid: string, customerId: string, createdAt: number): Promise<void> {
    await this.db
      .collection(COLLECTIONS.customers)
      .doc(uid)
      .set({ customerId, createdAt: stamp(createdAt) });
  }

  /** New, unless this delivery was already recorded -- and not left in `error` by a failed try. */
  async beginEvent(
    event: Omit<EventRecord, 'outcome' | 'processedAt'>,
  ): Promise<'new' | 'duplicate'> {
    const doc = this.db.collection(COLLECTIONS.events).doc(event.id);
    return this.db.runTransaction(async (tx: Transaction) => {
      const snapshot = await tx.get(doc);
      if (snapshot.exists && snapshot.data()?.outcome !== 'error') return 'duplicate';
      tx.set(doc, {
        type: event.type,
        livemode: event.livemode,
        receivedAt: stamp(event.receivedAt),
        outcome: null,
        processedAt: null,
      });
      return 'new';
    });
  }

  async finishEvent(id: string, outcome: string, processedAt: number): Promise<void> {
    await this.db
      .collection(COLLECTIONS.events)
      .doc(id)
      .set({ outcome, processedAt: stamp(processedAt) }, { merge: true });
  }

  async applyPayment(input: {
    readonly uid: string;
    readonly record: PaymentRecord;
    readonly mutate: (current: Entitlements) => Entitlements | null;
  }): Promise<ApplyResult> {
    const paymentDoc = this.db.collection(COLLECTIONS.payments).doc(input.record.paymentId);
    const entitlementsDoc = this.db.doc(entitlementsPath(input.uid));
    return this.db.runTransaction(async (tx: Transaction) => {
      const [paymentSnapshot, entitlementsSnapshot] = await Promise.all([
        tx.get(paymentDoc),
        tx.get(entitlementsDoc),
      ]);
      if (paymentSnapshot.exists) return 'duplicate';
      const current = entitlementsSnapshot.exists
        ? entitlementsFromDocument(entitlementsSnapshot.data(), input.record.appliedAt)
        : defaultEntitlements(input.record.appliedAt);
      const next = input.mutate(current);
      if (next !== null) tx.set(entitlementsDoc, entitlementsToDocument(next));
      tx.set(paymentDoc, paymentToDocument(input.record));
      return next === null ? 'unchanged' : 'applied';
    });
  }

  async updateEntitlements(
    uid: string,
    mutate: (current: Entitlements) => Entitlements | null,
  ): Promise<Entitlements> {
    const doc = this.db.doc(entitlementsPath(uid));
    return this.db.runTransaction(async (tx: Transaction) => {
      const snapshot = await tx.get(doc);
      const now = this.now();
      const current = snapshot.exists
        ? entitlementsFromDocument(snapshot.data(), now)
        : defaultEntitlements(now);
      const next = mutate(current);
      if (next === null) return current;
      tx.set(doc, entitlementsToDocument(next));
      return next;
    });
  }
}
