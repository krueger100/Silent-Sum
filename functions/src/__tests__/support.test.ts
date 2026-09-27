import { BillingFailure } from '../errors';
import { MAX_REPLY_LENGTH, replyToUser, type SupportMessageRecord, type SupportStore } from '../support';

class FakeSupportStore implements SupportStore {
  readonly written: { uid: string; id: string; record: SupportMessageRecord }[] = [];

  constructor(private readonly known: ReadonlySet<string>) {}

  async putSupportMessage(uid: string, id: string, record: SupportMessageRecord): Promise<void> {
    this.written.push({ uid, id, record });
  }

  async userExists(uid: string): Promise<boolean> {
    return this.known.has(uid);
  }
}

function deps(store: SupportStore) {
  let n = 0;
  return {
    store,
    now: () => 1_700_000_000_000,
    newId: () => {
      n += 1;
      return `m_${String(n)}`;
    },
  };
}

const CALLER = { callerUid: 'operator-1', isSupport: true };

async function failureFrom(action: () => Promise<unknown>): Promise<BillingFailure> {
  try {
    await action();
  } catch (error) {
    if (error instanceof BillingFailure) return error;
    throw error;
  }
  throw new Error('expected a BillingFailure');
}

describe('replyToUser', () => {
  it('writes one support message for a known account', async () => {
    const store = new FakeSupportStore(new Set(['user-1']));
    const result = await replyToUser(deps(store), { ...CALLER, uid: 'user-1', body: '  hello  ' });

    expect(result).toEqual({ id: 'm_1', createdAt: 1_700_000_000_000 });
    expect(store.written).toEqual([
      {
        uid: 'user-1',
        id: 'm_1',
        record: {
          v: 1,
          sender: 'support',
          body: 'hello',
          createdAt: 1_700_000_000_000,
          authorUid: 'operator-1',
        },
      },
    ]);
  });

  it('refuses a caller without the support claim, and writes nothing', async () => {
    const store = new FakeSupportStore(new Set(['user-1']));
    const failure = await failureFrom(() =>
      replyToUser(deps(store), {
        callerUid: 'user-1',
        isSupport: false,
        uid: 'user-1',
        body: 'I am support now',
      }),
    );
    expect(failure.code).toBe('permission-denied');
    expect(store.written).toEqual([]);
  });

  it('refuses a missing or malformed target and an empty body', async () => {
    const store = new FakeSupportStore(new Set(['user-1']));
    expect((await failureFrom(() => replyToUser(deps(store), { ...CALLER, uid: '', body: 'x' }))).code).toBe(
      'invalid-argument',
    );
    expect(
      (await failureFrom(() => replyToUser(deps(store), { ...CALLER, uid: 'a/b', body: 'x' }))).code,
    ).toBe('invalid-argument');
    expect(
      (await failureFrom(() => replyToUser(deps(store), { ...CALLER, uid: 'user-1', body: '   ' })))
        .code,
    ).toBe('invalid-argument');
    expect(store.written).toEqual([]);
  });

  it('refuses an unknown account rather than creating an orphan thread', async () => {
    const store = new FakeSupportStore(new Set(['user-1']));
    const failure = await failureFrom(() =>
      replyToUser(deps(store), { ...CALLER, uid: 'ghost', body: 'hello' }),
    );
    expect(failure.code).toBe('invalid-argument');
    expect(store.written).toEqual([]);
  });

  it('refuses a reply past the length limit', async () => {
    const store = new FakeSupportStore(new Set(['user-1']));
    const failure = await failureFrom(() =>
      replyToUser(deps(store), { ...CALLER, uid: 'user-1', body: 'x'.repeat(MAX_REPLY_LENGTH + 1) }),
    );
    expect(failure.code).toBe('invalid-argument');
    expect(store.written).toEqual([]);
  });

  it('always stamps the sender as support, whatever the caller sends', async () => {
    const store = new FakeSupportStore(new Set(['user-1']));
    await replyToUser(deps(store), {
      ...CALLER,
      uid: 'user-1',
      body: 'answer',
    });
    expect(store.written[0]?.record.sender).toBe('support');
  });
});
