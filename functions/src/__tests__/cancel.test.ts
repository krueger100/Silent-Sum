import { cancelCloud, type CancelDeps } from '../cancel';
import { DAY_MS, applySubscriptionEvent, extendCloudTerm } from '../entitlements';
import { PayMongoApiError } from '../paymongo/client';
import { InMemoryBillingStore } from '../store';

const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);

function rig(cancelSubscription?: (id: string, reason: string) => Promise<void>): {
  deps: CancelDeps;
  store: InMemoryBillingStore;
  calls: { id: string; reason: string }[];
} {
  const store = new InMemoryBillingStore(() => NOW);
  const calls: { id: string; reason: string }[] = [];
  const deps: CancelDeps = {
    store,
    paymongo: {
      cancelSubscription: async (id, reason) => {
        calls.push({ id, reason });
        await cancelSubscription?.(id, reason);
      },
    },
    now: () => NOW,
  };
  return { deps, store, calls };
}

describe('cancelCloud', () => {
  it('stops a paid term from renewing and keeps the access already paid for', async () => {
    const { deps, store, calls } = rig();
    await store.updateEntitlements('u1', (current) =>
      extendCloudTerm(current, { now: NOW, termDays: 30 }),
    );

    const result = await cancelCloud(deps, { uid: 'u1' });

    expect(result).toEqual({ ok: true, accessUntil: NOW + 30 * DAY_MS });
    expect((await store.getEntitlements('u1'))?.cloud).toMatchObject({
      status: 'cancelled',
      cancelAtPeriodEnd: true,
      accessUntil: NOW + 30 * DAY_MS,
    });
    expect(calls).toHaveLength(0);
  });

  it('is harmless for an account with no Cloud', async () => {
    const { deps, store } = rig();
    expect(await cancelCloud(deps, { uid: 'u1' })).toEqual({ ok: true, accessUntil: null });
    expect((await store.getEntitlements('u1'))?.cloud.status ?? 'none').toBe('none');
  });

  it('cancels a native PayMongo subscription with PayMongo first, then mirrors it', async () => {
    const { deps, store, calls } = rig();
    await store.updateEntitlements('u1', (current) =>
      applySubscriptionEvent(current, {
        kind: 'invoice.paid',
        subscriptionId: 'sub_1',
        periodEndMs: NOW + 30 * DAY_MS,
        now: NOW,
      }),
    );

    await cancelCloud(deps, { uid: 'u1' });

    expect(calls).toEqual([{ id: 'sub_1', reason: 'unused' }]);
    expect((await store.getEntitlements('u1'))?.cloud).toMatchObject({
      status: 'cancelled',
      cancelAtPeriodEnd: true,
    });
  });

  it('leaves the document alone when PayMongo refuses the cancellation', async () => {
    const { deps, store } = rig(async () => {
      throw new PayMongoApiError(503, null, 'Service Unavailable');
    });
    await store.updateEntitlements('u1', (current) =>
      applySubscriptionEvent(current, {
        kind: 'invoice.paid',
        subscriptionId: 'sub_1',
        periodEndMs: NOW + 30 * DAY_MS,
        now: NOW,
      }),
    );

    await expect(cancelCloud(deps, { uid: 'u1' })).rejects.toMatchObject({ code: 'unavailable' });
    expect((await store.getEntitlements('u1'))?.cloud.status).toBe('active');
  });
});
