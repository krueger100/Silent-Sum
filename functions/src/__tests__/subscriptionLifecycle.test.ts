/**
 * One Cloud subscription from subscribing to cancelled, driven only through the two doors the
 * real thing has: the callable that starts it, and signed webhook deliveries.
 *
 * This is the lifecycle test. The monthly charge is not simulated by calling an internal
 * function -- it arrives as `subscription.invoice.paid`, exactly as PayMongo delivers it, with a
 * signature that has to verify first. What is asserted at each step is the thing the user
 * actually experiences: whether Cloud is on, and whether the screen will say "renews
 * automatically" or offer a Renew button.
 *
 * `cloudActive` and `source === 'subscription' && !cancelAtPeriodEnd` are the two facts the app
 * renders from, so they are checked after every event rather than only at the end.
 */
import { createHmac } from 'node:crypto';

import { cancelCloud } from '../cancel';
import { readConfig } from '../config';
import { DAY_MS, cloudActive, type Entitlements } from '../entitlements';
import type { StorageMeter } from '../storageMeter';
import { InMemoryBillingStore } from '../store';
import { rerateCloudSubscription, startCloudSubscription, type SubscriptionPayMongo } from '../subscription';
import { handleWebhook, type WebhookDeps } from '../webhook';

const SECRET = 'whsk-test-secret-value';
const GIB = 1024 * 1024 * 1024;
const UID = 'u1';

/** A clock the test moves forward a month at a time. */
let now = Date.UTC(2026, 9, 11, 9, 0, 0);
const clock = () => now;

/** `YYYY-MM-DD`, which is the only date format PayMongo's subscription fields use. */
function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The same date as UTC midnight -- what the backend stores for a period end.
 *
 * PayMongo's `next_billing_schedule` is a DATE, with no time of day, so a period that is paid
 * for at 09:00 ends at 00:00 on the billing date: nine hours EARLIER than "thirty days later".
 * That is the real behaviour, and the three grace days (`SUBSCRIPTION_GRACE_DAYS`) are what stop
 * the slack from cutting anybody off mid-day while a retry is still in flight.
 */
function midnight(ms: number): number {
  return Date.parse(`${isoDate(ms)}T00:00:00.000Z`);
}

interface Harness {
  readonly store: InMemoryBillingStore;
  readonly webhook: WebhookDeps;
  readonly subscriptions: Parameters<typeof startCloudSubscription>[0];
  /** What the vault holds; the test writes to it to make a band change happen. */
  bytes: number;
  readonly planChanges: string[];
  readonly cancellations: string[];
  readonly logs: { message: string; data?: Record<string, unknown> }[];
}

function harness(): Harness {
  const store = new InMemoryBillingStore(clock);
  const planChanges: string[] = [];
  const cancellations: string[] = [];
  const logs: { message: string; data?: Record<string, unknown> }[] = [];
  const state = { bytes: 10 * GIB, planId: '' };

  const paymongo: SubscriptionPayMongo & { cancelSubscription: (id: string, reason: string) => Promise<void> } = {
    createPlan: async (input) => `plan_${String(input.amountCentavos)}`,
    createCustomer: async () => 'cus_1',
    createSubscription: async (input) => {
      state.planId = input.planId;
      return {
        id: 'sub_1',
        type: 'subscription',
        attributes: {
          status: 'incomplete',
          customer_id: input.customerId,
          plan: { id: input.planId },
          latest_invoice: {
            id: 'in_1',
            status: 'open',
            payment_intent: { id: 'pi_1', status: 'awaiting_payment_method' },
          },
        },
      };
    },
    retrieveSubscription: async (id) => ({
      id,
      type: 'subscription',
      attributes: { status: 'active', customer_id: 'cus_1', plan: { id: state.planId } },
    }),
    createWalletMethod: async () => 'pm_1',
    attachPaymentIntent: async (input) => ({
      id: input.paymentIntentId,
      type: 'payment_intent',
      attributes: {
        status: 'awaiting_next_action',
        next_action: { type: 'redirect', redirect: { url: 'https://auth.paymongo.test/pi_1' } },
      },
    }),
    changeSubscriptionPlan: async (id, planId) => {
      planChanges.push(planId);
      state.planId = planId;
    },
    cancelSubscription: async (id, reason) => {
      cancellations.push(`${id}:${reason}`);
    },
  };

  const meter: StorageMeter = { measure: async () => state.bytes };
  const config = readConfig({});
  const subscriptions = {
    store,
    paymongo,
    meter,
    config,
    now: clock,
    returnUrl: (outcome: 'success' | 'cancel') => `https://return.test/?outcome=${outcome}`,
    accountEmail: async () => 'u1@example.test',
  };

  return {
    store,
    subscriptions,
    planChanges,
    cancellations,
    logs,
    get bytes() {
      return state.bytes;
    },
    set bytes(value: number) {
      state.bytes = value;
    },
    webhook: {
      store,
      config,
      webhookSecret: SECRET,
      now: clock,
      log: (message, data) => {
        logs.push({ message, data });
      },
      rerate: (input) => rerateCloudSubscription(subscriptions, input),
    },
  };
}

function signed(body: unknown) {
  const rawBody = JSON.stringify(body);
  const t = Math.floor(now / 1000);
  const signature = createHmac('sha256', SECRET).update(`${String(t)}.${rawBody}`).digest('hex');
  return { rawBody, signatureHeader: `t=${String(t)},te=${signature}` };
}

function event(id: string, type: string, resource: Record<string, unknown>): unknown {
  return {
    data: {
      id,
      type: 'event',
      attributes: { type, livemode: false, created_at: Math.floor(now / 1000), data: resource },
    },
  };
}

/** An invoice as the `subscription.invoice.*` events carry it: the subscription is NESTED. */
function invoiceResource(input: { status: string; nextBilling: number; subStatus: string }) {
  return {
    id: `in_${String(input.nextBilling)}`,
    type: 'invoice',
    attributes: {
      status: input.status,
      customer_id: 'cus_1',
      subscription: {
        id: 'sub_1',
        status: input.subStatus,
        next_billing_schedule: isoDate(input.nextBilling),
      },
    },
  };
}

function subscriptionResource(status: string, nextBilling?: number) {
  return {
    id: 'sub_1',
    type: 'subscription',
    attributes: {
      status,
      customer_id: 'cus_1',
      ...(nextBilling === undefined
        ? {}
        : { next_billing_schedule: isoDate(nextBilling) }),
    },
  };
}

/** What the app renders from: on or off, and whether the Renew button is disabled. */
function view(e: Entitlements | null): {
  active: boolean;
  status: string;
  autoRenews: boolean;
} {
  if (e === null) return { active: false, status: 'none', autoRenews: false };
  return {
    active: cloudActive(e, now),
    status: e.cloud.status,
    autoRenews: e.cloud.source === 'subscription' && !e.cloud.cancelAtPeriodEnd,
  };
}

describe('a Cloud subscription, from subscribing to cancelled', () => {
  beforeEach(() => {
    now = Date.UTC(2026, 9, 11, 9, 0, 0);
  });

  it('grants nothing until the first invoice is actually paid', async () => {
    const h = harness();

    const start = await startCloudSubscription(h.subscriptions, { uid: UID });

    expect(start.authorizeUrl).toBe('https://auth.paymongo.test/pi_1');
    // Subscribing is not paying. Until PayMongo says an invoice was paid, Cloud is off.
    expect(view(await h.store.getEntitlements(UID))).toEqual({
      active: false,
      status: 'none',
      autoRenews: false,
    });
  });

  it('runs the whole lifecycle: first charge, two renewals, a band change, a failure, cancellation', async () => {
    const h = harness();
    await startCloudSubscription(h.subscriptions, { uid: UID });

    const send = async (id: string, type: string, resource: Record<string, unknown>) =>
      handleWebhook(h.webhook, signed(event(id, type, resource)));

    // --- cycle 1: the customer authorises, PayMongo charges, Cloud comes on -----------------
    const cycle1End = now + 30 * DAY_MS;
    let response = await send(
      'evt_paid_1',
      'subscription.invoice.paid',
      invoiceResource({ status: 'paid', nextBilling: cycle1End, subStatus: 'active' }),
    );
    expect(response.body).toEqual({ received: true, outcome: 'subscription:invoice.paid' });
    expect(view(await h.store.getEntitlements(UID))).toEqual({
      active: true,
      status: 'active',
      autoRenews: true,
    });

    // `subscription.activated` carries no new fact, but PayMongo sends it and it must not
    // undo anything.
    await send('evt_act', 'subscription.activated', subscriptionResource('active', cycle1End));
    expect(view(await h.store.getEntitlements(UID))).toMatchObject({ active: true, autoRenews: true });

    // --- the month passes. Nothing is asked of the user; the charge simply happens. ---------
    now = cycle1End - DAY_MS;
    // A draft invoice grants nothing: it has not been paid.
    const drafted = await send(
      'evt_created_2',
      'subscription.invoice.created',
      invoiceResource({ status: 'draft', nextBilling: cycle1End, subStatus: 'active' }),
    );
    expect(drafted.body).toEqual({ received: true, outcome: 'noted-invoice' });
    const afterDraft = await h.store.getEntitlements(UID);
    expect(afterDraft?.cloud.currentPeriodEnd).toBe(midnight(cycle1End));

    now = cycle1End;
    const cycle2End = cycle1End + 30 * DAY_MS;
    await send(
      'evt_paid_2',
      'subscription.invoice.paid',
      invoiceResource({ status: 'paid', nextBilling: cycle2End, subStatus: 'active' }),
    );
    const renewed = await h.store.getEntitlements(UID);
    expect(view(renewed)).toEqual({ active: true, status: 'active', autoRenews: true });
    // The renewal moved the period on, and access runs to the period end plus the grace days.
    expect(renewed?.cloud.currentPeriodEnd).toBe(midnight(cycle2End));
    expect(renewed?.cloud.accessUntil).toBe(midnight(cycle2End) + 3 * DAY_MS);
    // A 10 GiB vault is still in the first band, so nothing was re-priced.
    expect(h.planChanges).toEqual([]);

    // --- the vault grows past 160 GB. The NEXT charge is the bigger one. --------------------
    h.bytes = 300 * GIB;
    now = cycle2End;
    const cycle3End = cycle2End + 30 * DAY_MS;
    await send(
      'evt_paid_3',
      'subscription.invoice.paid',
      invoiceResource({ status: 'paid', nextBilling: cycle3End, subStatus: 'active' }),
    );
    expect(h.planChanges).toEqual(['plan_79900']);
    expect(h.logs.some((l) => l.message === 'subscription re-rated')).toBe(true);

    // --- a charge fails. Access is NOT cut: PayMongo retries for three days. ----------------
    now = cycle3End;
    await send(
      'evt_failed',
      'subscription.invoice.payment_failed',
      invoiceResource({ status: 'open', nextBilling: cycle3End, subStatus: 'past_due' }),
    );
    const pastDue = await h.store.getEntitlements(UID);
    expect(pastDue?.cloud.status).toBe('past_due');
    expect(cloudActive(pastDue!, now)).toBe(true);

    // --- the retries run out. Access stops the moment PayMongo gives up. -------------------
    await send('evt_unpaid', 'subscription.unpaid', subscriptionResource('unpaid'));
    const unpaid = await h.store.getEntitlements(UID);
    expect(unpaid?.cloud.status).toBe('unpaid');
    expect(cloudActive(unpaid!, now)).toBe(false);
  });

  it('cancels at PayMongo first, keeps the paid period, and re-enables Renew', async () => {
    const h = harness();
    await startCloudSubscription(h.subscriptions, { uid: UID });
    const periodEnd = now + 30 * DAY_MS;
    await handleWebhook(
      h.webhook,
      signed(
        event(
          'evt_paid_1',
          'subscription.invoice.paid',
          invoiceResource({ status: 'paid', nextBilling: periodEnd, subStatus: 'active' }),
        ),
      ),
    );
    expect(view(await h.store.getEntitlements(UID)).autoRenews).toBe(true);

    const result = await cancelCloud(
      { store: h.store, paymongo: h.subscriptions.paymongo as never, now: clock },
      { uid: UID },
    );

    // PayMongo is told, with one of the five reasons its API accepts.
    expect(h.cancellations).toEqual(['sub_1:unused']);
    const cancelled = await h.store.getEntitlements(UID);
    // Still on, still paid for -- and the Renew button is back, which is the whole point.
    expect(view(cancelled)).toEqual({ active: true, status: 'cancelled', autoRenews: false });
    expect(result.accessUntil).toBe(midnight(periodEnd) + 3 * DAY_MS);

    // And it stays on until the period actually ends.
    now = periodEnd + 2 * DAY_MS;
    expect(cloudActive(cancelled!, now)).toBe(true);
    now = periodEnd + 4 * DAY_MS;
    expect(cloudActive(cancelled!, now)).toBe(false);
  });

  it('finds the account from the customer when an event beats the subscription reference', async () => {
    // PayMongo creates the first invoice the instant the subscription exists, so its events can
    // arrive before `startCloudSubscription` has finished writing. The customer reference is
    // written first, and it is enough.
    const h = harness();
    await h.store.putRef({ kind: 'customer', id: 'cus_1', uid: UID, createdAt: now });

    const response = await handleWebhook(
      h.webhook,
      signed(
        event(
          'evt_early',
          'subscription.invoice.paid',
          invoiceResource({ status: 'paid', nextBilling: now + 30 * DAY_MS, subStatus: 'active' }),
        ),
      ),
    );

    expect(response.body).toEqual({ received: true, outcome: 'subscription:invoice.paid' });
    expect(view(await h.store.getEntitlements(UID))).toMatchObject({ active: true, autoRenews: true });
    // And it healed itself, so the fallback is needed at most once.
    expect(await h.store.getRef('sub_1')).toMatchObject({ kind: 'subscription', uid: UID });
  });

  it('still applies a paid invoice when re-pricing the next cycle fails', async () => {
    // The money has arrived. A failure to work out next month's band must not throw away this
    // month's entitlement, and must not make PayMongo redeliver a payment already applied.
    const h = harness();
    await startCloudSubscription(h.subscriptions, { uid: UID });
    const broken: WebhookDeps = {
      ...h.webhook,
      rerate: async () => {
        throw new Error('storage listing failed');
      },
    };

    const response = await handleWebhook(
      broken,
      signed(
        event(
          'evt_paid_1',
          'subscription.invoice.paid',
          invoiceResource({ status: 'paid', nextBilling: now + 30 * DAY_MS, subStatus: 'active' }),
        ),
      ),
    );

    expect(response.status).toBe(200);
    expect(view(await h.store.getEntitlements(UID))).toMatchObject({ active: true, autoRenews: true });
    expect(h.logs.some((l) => l.message === 'subscription re-rate failed')).toBe(true);
  });
});
