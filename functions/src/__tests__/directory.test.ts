import {
  LOOKUP_LIMIT,
  findPeerEmail,
  findUserByEmail,
  type DirectoryStore,
} from '../directory';
import { BillingFailure } from '../errors';

class FakeDirectoryStore implements DirectoryStore {
  readonly consumed: string[] = [];

  constructor(
    private readonly accounts: ReadonlyMap<string, string>,
    private readonly pro: ReadonlySet<string>,
    private budget = LOOKUP_LIMIT,
    /** Conversation ids that exist, in the same `sorted().join('__')` form the app uses. */
    private readonly conversations: ReadonlySet<string> = new Set(),
  ) {}

  async isPro(uid: string): Promise<boolean> {
    return this.pro.has(uid);
  }

  async consumeLookup(uid: string): Promise<boolean> {
    if (this.budget <= 0) return false;
    this.budget -= 1;
    this.consumed.push(uid);
    return true;
  }

  async uidForEmail(email: string): Promise<string | null> {
    return this.accounts.get(email) ?? null;
  }

  async emailForUid(uid: string): Promise<string | null> {
    for (const [email, owner] of this.accounts) if (owner === uid) return email;
    return null;
  }

  async sharesConversation(a: string, b: string): Promise<boolean> {
    return this.conversations.has([a, b].sort().join('__'));
  }
}

const ACCOUNTS = new Map([['bob@example.test', 'uid-bob']]);
const PRO = new Set(['uid-alice']);

function deps(store: DirectoryStore) {
  return { store, now: () => 1_700_000_000_000 };
}

async function failureFrom(action: () => Promise<unknown>): Promise<BillingFailure> {
  try {
    await action();
  } catch (error) {
    if (error instanceof BillingFailure) return error;
    throw error;
  }
  throw new Error('expected a BillingFailure');
}

describe('findUserByEmail', () => {
  it('resolves an exact address for a Pro caller', async () => {
    const store = new FakeDirectoryStore(ACCOUNTS, PRO);
    await expect(
      findUserByEmail(deps(store), { callerUid: 'uid-alice', email: 'bob@example.test' }),
    ).resolves.toEqual({ found: true, uid: 'uid-bob' });
    expect(store.consumed).toEqual(['uid-alice']);
  });

  it('normalises case and surrounding space', async () => {
    const store = new FakeDirectoryStore(ACCOUNTS, PRO);
    await expect(
      findUserByEmail(deps(store), { callerUid: 'uid-alice', email: '  BOB@Example.Test ' }),
    ).resolves.toEqual({ found: true, uid: 'uid-bob' });
  });

  it('answers "no account" without saying anything else', async () => {
    const store = new FakeDirectoryStore(ACCOUNTS, PRO);
    await expect(
      findUserByEmail(deps(store), { callerUid: 'uid-alice', email: 'ghost@example.test' }),
    ).resolves.toEqual({ found: false });
  });

  it('refuses a caller without Pro, and spends none of their budget', async () => {
    const store = new FakeDirectoryStore(ACCOUNTS, PRO);
    const failure = await failureFrom(() =>
      findUserByEmail(deps(store), { callerUid: 'uid-free', email: 'bob@example.test' }),
    );
    expect(failure.code).toBe('permission-denied');
    expect(store.consumed).toEqual([]);
  });

  it('refuses anything that is not an address, before checking anything else', async () => {
    const store = new FakeDirectoryStore(ACCOUNTS, PRO);
    for (const email of [undefined, 42, '', '   ', 'bob', 'bob@example', 'a'.repeat(400)]) {
      const failure = await failureFrom(() =>
        findUserByEmail(deps(store), { callerUid: 'uid-alice', email }),
      );
      expect(failure.code).toBe('invalid-argument');
    }
    expect(store.consumed).toEqual([]);
  });

  it('stops a paid account from walking a list of addresses', async () => {
    const store = new FakeDirectoryStore(ACCOUNTS, PRO, 1);
    await findUserByEmail(deps(store), { callerUid: 'uid-alice', email: 'bob@example.test' });
    const failure = await failureFrom(() =>
      findUserByEmail(deps(store), { callerUid: 'uid-alice', email: 'other@example.test' }),
    );
    expect(failure.code).toBe('resource-exhausted');
  });
});

/**
 * The reverse lookup. Its gate is membership rather than Pro, so these cases are about who is
 * allowed to ask rather than who has paid.
 */
describe('findPeerEmail', () => {
  const CONVERSATION = new Set([['uid-alice', 'uid-bob'].sort().join('__')]);

  function store(budget = LOOKUP_LIMIT): FakeDirectoryStore {
    return new FakeDirectoryStore(ACCOUNTS, PRO, budget, CONVERSATION);
  }

  it('names a correspondent', async () => {
    await expect(
      findPeerEmail(deps(store()), { callerUid: 'uid-alice', uid: 'uid-bob' }),
    ).resolves.toEqual({ found: true, email: 'bob@example.test' });
  });

  it('answers without Pro, because reading never needs it', async () => {
    const shared = new FakeDirectoryStore(ACCOUNTS, new Set(), LOOKUP_LIMIT, CONVERSATION);
    await expect(
      findPeerEmail(deps(shared), { callerUid: 'uid-alice', uid: 'uid-bob' }),
    ).resolves.toEqual({ found: true, email: 'bob@example.test' });
  });

  it('refuses an account the caller is not talking to', async () => {
    const failure = await failureFrom(() =>
      findPeerEmail(deps(store()), { callerUid: 'uid-carol', uid: 'uid-bob' }),
    );
    expect(failure.code).toBe('permission-denied');
  });

  it('spends the lookup budget, and stops when it is gone', async () => {
    const spent = store(0);
    const failure = await failureFrom(() =>
      findPeerEmail(deps(spent), { callerUid: 'uid-alice', uid: 'uid-bob' }),
    );
    expect(failure.code).toBe('resource-exhausted');
  });

  it('checks membership before spending any budget', async () => {
    const shared = store();
    await failureFrom(() =>
      findPeerEmail(deps(shared), { callerUid: 'uid-carol', uid: 'uid-bob' }),
    );
    expect(shared.consumed).toEqual([]);
  });

  it('refuses a caller asking about itself', async () => {
    const failure = await failureFrom(() =>
      findPeerEmail(deps(store()), { callerUid: 'uid-alice', uid: 'uid-alice' }),
    );
    expect(failure.code).toBe('invalid-argument');
  });

  // Empty, the wrong type, something with a path separator in it, and nothing at all.
  it.each<[unknown]>([[''], [42], ['a/b'], [null]])(
    'refuses %p as an account id',
    async (uid) => {
      const failure = await failureFrom(() =>
        findPeerEmail(deps(store()), { callerUid: 'uid-alice', uid }),
      );
      expect(failure.code).toBe('invalid-argument');
    },
  );

  it('reports a correspondent with no address as not found', async () => {
    const noEmail = new FakeDirectoryStore(new Map(), PRO, LOOKUP_LIMIT, CONVERSATION);
    await expect(
      findPeerEmail(deps(noEmail), { callerUid: 'uid-alice', uid: 'uid-bob' }),
    ).resolves.toEqual({ found: false });
  });
});
