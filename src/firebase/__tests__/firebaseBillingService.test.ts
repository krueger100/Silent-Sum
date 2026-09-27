import { BillingError } from '@/billing/billingService';
import { CallableError, type CallableInvoker } from '@/firebase/callableClient';
import { FirebaseBillingService } from '@/firebase/firebaseBillingService';
import type { CloudUser } from '@/firebase/types';

interface Call {
  name: string;
  data: unknown;
}

function rig(
  answer: (name: string, data: unknown) => unknown,
  user: CloudUser | null = { uid: 'u1', email: 'u@example.test' },
): { service: FirebaseBillingService; calls: Call[] } {
  const calls: Call[] = [];
  const invoker: CallableInvoker = {
    async call<T>(name: string, data: unknown): Promise<T> {
      calls.push({ name, data });
      return answer(name, data) as T;
    },
  };
  return { service: new FirebaseBillingService(invoker, () => user), calls };
}

function failing(code: string, user: CloudUser | null = { uid: 'u1', email: null }) {
  return rig(() => {
    throw new CallableError(code, 'nope');
  }, user);
}

async function codeOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return error instanceof BillingError ? error.code : `not-a-billing-error: ${String(error)}`;
  }
  return 'did-not-throw';
}

describe('FirebaseBillingService', () => {
  it('asks the backend for a checkout and returns the page it was given', async () => {
    const { service, calls } = rig(() => ({
      checkoutId: 'cs_1',
      checkoutUrl: 'https://checkout.paymongo.com/cs_1',
    }));
    const start = await service.createCheckout('cloud');
    expect(start).toEqual({
      checkoutId: 'cs_1',
      checkoutUrl: 'https://checkout.paymongo.com/cs_1',
    });
    expect(calls).toEqual([{ name: 'silentsumCreateCheckout', data: { product: 'cloud' } }]);
  });

  it('refuses a checkout answer that is not a hosted https page', async () => {
    const bad = rig(() => ({ checkoutId: 'cs_1', checkoutUrl: 'http://evil.example/cs_1' }));
    expect(await codeOf(() => bad.service.createCheckout('pro'))).toBe('internal');
    const missing = rig(() => ({ checkoutId: 'cs_1' }));
    expect(await codeOf(() => missing.service.createCheckout('pro'))).toBe('internal');
  });

  it('never calls the backend without a signed-in account', async () => {
    const { service, calls } = rig(() => ({}), null);
    expect(await codeOf(() => service.createCheckout('pro'))).toBe('unauthenticated');
    expect(await codeOf(() => service.syncCheckout('cs_1'))).toBe('unauthenticated');
    expect(await codeOf(() => service.cancelCloud())).toBe('unauthenticated');
    expect(calls).toHaveLength(0);
  });

  it('relays a sync outcome and treats anything unexpected as unknown', async () => {
    const paid = rig(() => ({ outcome: 'paid' }));
    expect(await paid.service.syncCheckout('cs_1')).toBe('paid');
    expect(paid.calls).toEqual([{ name: 'silentsumSyncCheckout', data: { checkoutId: 'cs_1' } }]);
    const odd = rig(() => ({ outcome: 'sideways' }));
    expect(await odd.service.syncCheckout('cs_1')).toBe('unknown');
  });

  it('cancels through the backend', async () => {
    const { service, calls } = rig(() => ({ ok: true }));
    await service.cancelCloud();
    expect(calls).toEqual([{ name: 'silentsumCancelCloud', data: {} }]);
  });

  it.each([
    ['failed-precondition', 'already-owned'],
    ['invalid-argument', 'invalid-argument'],
    ['permission-denied', 'permission-denied'],
    ['unavailable', 'unavailable'],
    ['deadline-exceeded', 'unavailable'],
    ['internal', 'internal'],
    ['resource-exhausted', 'unknown'],
  ])('maps the callable code %s to %s', async (from, to) => {
    const { service } = failing(from);
    expect(await codeOf(() => service.createCheckout('pro'))).toBe(to);
  });

  it('reads an unauthenticated refusal for a signed-in user as an App Check refusal', async () => {
    const { service } = failing('unauthenticated');
    expect(await codeOf(() => service.createCheckout('pro'))).toBe('app-check');
  });
});
