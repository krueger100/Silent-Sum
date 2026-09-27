/**
 * What the backend remembers, and the two guarantees the rest of the code leans on:
 *
 *  - `beginEvent` records a webhook delivery exactly once. A redelivery is `duplicate`.
 *  - `applyPayment` applies a PayMongo payment exactly once. The ledger entry and the entitlement
 *    change are written together (in one transaction on Firestore), keyed by the payment id, so
 *    the same payment cannot be applied twice however it arrives: a retried event, a second event
 *    type for the same payment, or the sync path racing the webhook.
 *
 * Everything is keyed by PayMongo's own ids. `silentsum_billing_refs` maps a checkout session,
 * subscription or customer id back to the account it belongs to, which is how a webhook body is
 * matched to a uid without trusting anything in the body.
 *
 * The Firestore implementation lives in `firestoreStore.ts`; this file has the contract and the
 * in-memory store the tests run against.
 */
import { defaultEntitlements, type Entitlements } from './entitlements';

export type ProductId = 'pro' | 'cloud';

export interface CheckoutRef {
  readonly kind: 'checkout';
  /** The PayMongo checkout session id (`cs_…`). */
  readonly id: string;
  readonly uid: string;
  readonly product: ProductId;
  /** Our own reference, also sent to PayMongo as `reference_number` and in the metadata. */
  readonly ref: string;
  readonly amountCentavos: number;
  readonly currency: string;
  readonly status: 'open' | 'paid' | 'failed' | 'expired';
  readonly createdAt: number;
  readonly paidAt: number | null;
  readonly paymentId: string | null;
}

export interface SubscriptionRef {
  readonly kind: 'subscription';
  /** The PayMongo subscription id (`sub_…`). */
  readonly id: string;
  readonly uid: string;
  readonly createdAt: number;
}

export interface CustomerRef {
  readonly kind: 'customer';
  /** The PayMongo customer id (`cus_…`). */
  readonly id: string;
  readonly uid: string;
  readonly createdAt: number;
}

export type BillingRef = CheckoutRef | SubscriptionRef | CustomerRef;

export interface PaymentRecord {
  readonly paymentId: string;
  readonly uid: string;
  readonly product: ProductId;
  readonly amountCentavos: number;
  readonly currency: string;
  readonly checkoutSessionId: string | null;
  readonly eventId: string | null;
  readonly source: 'webhook' | 'sync';
  readonly paidAt: number;
  readonly appliedAt: number;
  /** What applying it did: `pro_granted`, `pro_already`, `cloud_extended`. */
  readonly outcome: string;
}

export interface EventRecord {
  readonly id: string;
  readonly type: string;
  readonly livemode: boolean;
  readonly receivedAt: number;
  readonly outcome: string | null;
  readonly processedAt: number | null;
}

export type ApplyResult = 'applied' | 'duplicate' | 'unchanged';

export interface BillingStore {
  /** Null when the account has never been granted anything. */
  getEntitlements(uid: string): Promise<Entitlements | null>;
  putRef(ref: BillingRef): Promise<void>;
  getRef(id: string): Promise<BillingRef | null>;
  updateRef(id: string, patch: Partial<Omit<CheckoutRef, 'kind' | 'id'>>): Promise<void>;
  beginEvent(event: Omit<EventRecord, 'outcome' | 'processedAt'>): Promise<'new' | 'duplicate'>;
  finishEvent(id: string, outcome: string, processedAt: number): Promise<void>;
  /**
   * `mutate` receives the current entitlements (the free tier when none exist) and returns the
   * next ones, or null to leave them alone. It runs only for a payment not yet in the ledger.
   */
  applyPayment(input: {
    readonly uid: string;
    readonly record: PaymentRecord;
    readonly mutate: (current: Entitlements) => Entitlements | null;
  }): Promise<ApplyResult>;
  /** The same read-mutate-write for changes that are not payments (cancellation, subscriptions). */
  updateEntitlements(
    uid: string,
    mutate: (current: Entitlements) => Entitlements | null,
  ): Promise<Entitlements>;
}

export class InMemoryBillingStore implements BillingStore {
  readonly entitlements = new Map<string, Entitlements>();
  readonly refs = new Map<string, BillingRef>();
  readonly events = new Map<string, EventRecord>();
  readonly payments = new Map<string, PaymentRecord>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async getEntitlements(uid: string): Promise<Entitlements | null> {
    return this.entitlements.get(uid) ?? null;
  }

  async putRef(ref: BillingRef): Promise<void> {
    this.refs.set(ref.id, { ...ref });
  }

  async getRef(id: string): Promise<BillingRef | null> {
    const ref = this.refs.get(id);
    return ref === undefined ? null : { ...ref };
  }

  async updateRef(id: string, patch: Partial<Omit<CheckoutRef, 'kind' | 'id'>>): Promise<void> {
    const ref = this.refs.get(id);
    if (ref === undefined) return;
    this.refs.set(id, { ...ref, ...patch } as BillingRef);
  }

  /** New, unless this delivery was already recorded -- and not left in `error` by a failed try. */
  async beginEvent(
    event: Omit<EventRecord, 'outcome' | 'processedAt'>,
  ): Promise<'new' | 'duplicate'> {
    const existing = this.events.get(event.id);
    if (existing !== undefined && existing.outcome !== 'error') return 'duplicate';
    this.events.set(event.id, { ...event, outcome: null, processedAt: null });
    return 'new';
  }

  async finishEvent(id: string, outcome: string, processedAt: number): Promise<void> {
    const event = this.events.get(id);
    if (event === undefined) return;
    this.events.set(id, { ...event, outcome, processedAt });
  }

  async applyPayment(input: {
    readonly uid: string;
    readonly record: PaymentRecord;
    readonly mutate: (current: Entitlements) => Entitlements | null;
  }): Promise<ApplyResult> {
    if (this.payments.has(input.record.paymentId)) return 'duplicate';
    const current = this.entitlements.get(input.uid) ?? defaultEntitlements(input.record.appliedAt);
    const next = input.mutate(current);
    if (next !== null) this.entitlements.set(input.uid, next);
    this.payments.set(input.record.paymentId, { ...input.record });
    return next === null ? 'unchanged' : 'applied';
  }

  async updateEntitlements(
    uid: string,
    mutate: (current: Entitlements) => Entitlements | null,
  ): Promise<Entitlements> {
    const current = this.entitlements.get(uid) ?? defaultEntitlements(this.now());
    const next = mutate(current);
    if (next === null) return current;
    this.entitlements.set(uid, next);
    return next;
  }
}
