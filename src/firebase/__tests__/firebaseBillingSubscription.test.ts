/**
 * `FirebaseBillingService.startCloudSubscription`, and the error mapping the screen depends on.
 *
 * The mapping is load-bearing in a way the checkout path's is not. A backend that cannot take a
 * subscription -- PayMongo has not enabled the feature on the merchant account, which is the
 * state of every deployment today -- must reach the screen as `unsupported`, because that is the
 * one code the screen reacts to by falling back to a one-off term. Get it wrong and Cloud either
 * shows an error instead of selling, or silently sells the wrong billing model.
 */
import { BillingError } from '@/billing/billingService';
import { CallableError, type CallableInvoker } from '@/firebase/callableClient';
import { FirebaseBillingService } from '@/firebase/firebaseBillingService';
import type { CloudUser } from '@/firebase/types';

const USER: CloudUser = { uid: 'u1', email: 'u@example.test' };

const ANSWER = {
  subscriptionId: 'sub_1',
  authorizeUrl: 'https://auth.paymongo.com/pi_1',
  priceCentavos: 9900,
  bandLabel: '64 GB',
};

interface Call {
  name: string;
  data: unknown;
}

function rig(
  answer: () => unknown,
  user: CloudUser | null = USER,
): { service: FirebaseBillingService; calls: Call[] } {
  const calls: Call[] = [];
  const invoker: CallableInvoker = {
    async call<T>(name: string, data: unknown): Promise<T> {
      calls.push({ name, data });
      return answer() as T;
    },
  };
  return { service: new FirebaseBillingService(invoker, () => user), calls };
}

function refusing(code: string, details?: unknown) {
  return rig(() => {
    throw new CallableError(code, 'nope', details);
  });
}

async function codeOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return error instanceof BillingError ? error.code : `not-a-billing-error: ${String(error)}`;
  }
  return 'did-not-throw';
}

describe('FirebaseBillingService.startCloudSubscription', () => {
  it('calls the subscription callable with an EMPTY body and returns what it was given', async () => {
    const { service, calls } = rig(() => ANSWER);

    const start = await service.startCloudSubscription();

    expect(start).toEqual(ANSWER);
    // Nothing is sent. The band and the price are the server's measurement, and a body the
    // client could fill is a body the client could use to choose its own price.
    expect(calls).toEqual([{ name: 'silentsumStartCloudSubscription', data: {} }]);
  });

  it('refuses an authorisation page that is not https', async () => {
    const plain = rig(() => ({ ...ANSWER, authorizeUrl: 'http://evil.example/pi_1' }));
    expect(await codeOf(() => plain.service.startCloudSubscription())).toBe('internal');
    const missing = rig(() => ({ ...ANSWER, authorizeUrl: undefined }));
    expect(await codeOf(() => missing.service.startCloudSubscription())).toBe('internal');
  });

  it('refuses a price that could be shown to someone as what they are about to pay', async () => {
    for (const priceCentavos of [0, -9900, Number.NaN, '9900', null]) {
      const bad = rig(() => ({ ...ANSWER, priceCentavos }));
      expect(await codeOf(() => bad.service.startCloudSubscription())).toBe('internal');
    }
  });

  it('refuses an answer with no band label or no subscription id', async () => {
    const noLabel = rig(() => ({ ...ANSWER, bandLabel: '' }));
    expect(await codeOf(() => noLabel.service.startCloudSubscription())).toBe('internal');
    const noId = rig(() => ({ ...ANSWER, subscriptionId: '' }));
    expect(await codeOf(() => noId.service.startCloudSubscription())).toBe('internal');
  });

  it('reports a PayMongo refusal as unsupported, which is what triggers the term fallback', async () => {
    // The backend maps any provider refusal to `internal`. "Subscriptions are not enabled on
    // this account" arrives that way, and it is not an error the user can do anything about --
    // it means use the other path.
    expect(await codeOf(() => refusing('internal').service.startCloudSubscription())).toBe(
      'unsupported',
    );
  });

  it('reports a callable that is not deployed as unsupported too', async () => {
    // A build newer than its backend. Falling back is right; a crash is not.
    expect(await codeOf(() => refusing('not-found').service.startCloudSubscription())).toBe(
      'unsupported',
    );
  });

  it('tells the failed-precondition reasons apart by their details', async () => {
    // One callable code, several situations, each needing a different sentence. The backend
    // distinguishes them in `details.reason` rather than in prose, which is the only way the
    // client can act on them without matching on message text.
    expect(
      await codeOf(() =>
        refusing('failed-precondition', { reason: 'already-subscribed' }).service.startCloudSubscription(),
      ),
    ).toBe('already-subscribed');
    expect(
      await codeOf(() =>
        refusing('failed-precondition', { reason: 'no-email' }).service.startCloudSubscription(),
      ),
    ).toBe('no-email');
    expect(
      await codeOf(() =>
        refusing('failed-precondition', { reason: 'storage-unmeasured' }).service.startCloudSubscription(),
      ),
    ).toBe('unsupported');
    // No reason at all keeps the old meaning, which is what the Pro path sends.
    expect(
      await codeOf(() => refusing('failed-precondition').service.startCloudSubscription()),
    ).toBe('already-owned');
  });

  it('keeps unavailable as unavailable, so a flat network is not read as a missing feature', async () => {
    // Falling back to a one-off term on a dead connection would just fail again, having told
    // the user the wrong thing about why.
    expect(await codeOf(() => refusing('unavailable').service.startCloudSubscription())).toBe(
      'unavailable',
    );
    expect(await codeOf(() => refusing('deadline-exceeded').service.startCloudSubscription())).toBe(
      'unavailable',
    );
  });

  it('demands a signed-in account before calling anything', async () => {
    const { service, calls } = rig(() => ANSWER, null);
    expect(await codeOf(() => service.startCloudSubscription())).toBe('unauthenticated');
    expect(calls).toHaveLength(0);
  });

  it('distinguishes App Check from not signed in, as the other calls do', async () => {
    const { service } = rig(() => {
      throw new CallableError('unauthenticated', 'nope');
    });
    expect(await codeOf(() => service.startCloudSubscription())).toBe('app-check');
  });
});
