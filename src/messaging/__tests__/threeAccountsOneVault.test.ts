/**
 * Three Firebase accounts, one phone, one vault.
 *
 * The messaging identity is `deriveMessagingIdentity(masterKey)` with no uid in it, so every
 * account signed in on one device derives the SAME X25519 keypair and the SAME contacts key. That
 * is deliberate, and it means the cryptography does not separate the accounts from each other at
 * all: what separates them is the uid in the path and the membership check in the rules. These
 * specs exist because an architecture whose isolation rests on a check rather than on a key has
 * to have that check demonstrated, not reasoned about.
 *
 * Everything here is real: the correspondents are their own `MessagingService` instances with
 * their own identities, so a body that comes back decrypted was genuinely sealed by somebody else
 * under X25519 and opened here. Nothing is mocked to return a plaintext.
 *
 * Pro is ENFORCED, unlike `accountSwitch.test.ts`, because whether an entitlement follows the
 * account or the device is one of the questions.
 */
import {
  BILLING_PATHS,
  FREE_ENTITLEMENTS,
  entitlementsToJson,
} from '@/billing/entitlements';
import { EntitlementsController } from '@/billing/entitlementsController';
import { SequentialRandom } from '@/crypto/random';
import { MASTER_KEY_LENGTH } from '@/crypto/types';
import { InMemoryCloudBackend, InMemoryCloudStore } from '@/firebase/cloudBackend';
import { InMemoryDirectory } from '@/messaging/directory';
import { HiddenMessages } from '@/messaging/hiddenMessages';
import { deriveMessagingIdentity, type MessagingIdentity } from '@/messaging/identity';
import {
  MESSAGING_PATHS,
  conversationIdFor,
  conversationRecord,
  parsePublishedKey,
} from '@/messaging/messaging';
import {
  MessagingService,
  type ConversationState,
  type MessagingState,
} from '@/messaging/messagingService';
import { InMemorySecureStore } from '@/secure-storage/secureStore';
import { InMemoryFileSystem } from '@/storage/inMemoryFileSystem';
import { base64Encode } from '@/utils/base64';
import { FakeClock } from '@/utils/clock';

const PASSWORD = 'account-password';
const A = 'a@example.test';
const B = 'b@example.test';
const C = 'c@example.test';
const PEER_A = 'peer-a@example.test';
const PEER_B = 'peer-b@example.test';
const PEER_C = 'peer-c@example.test';

/** The one vault behind all three accounts. */
const VAULT_SEED = 1;

function masterKey(seed: number): Uint8Array {
  const bytes = new Uint8Array(MASTER_KEY_LENGTH);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (seed + i * 11) & 0xff;
  return bytes;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function collect<T>(subscribe: (on: (state: T) => void) => () => void): {
  last: () => T;
  stop: () => void;
} {
  const states: T[] = [];
  const stop = subscribe((state) => states.push(state));
  return { last: () => states[states.length - 1] as T, stop };
}

/**
 * One world, one store. Everything in it talks to the same Firestore fake, which is what makes a
 * message written by a correspondent arrive here as a snapshot rather than as a fixture.
 */
class World {
  readonly store = new InMemoryCloudStore();

  readonly clock = new FakeClock();

  /** e-mail -> uid, as the deployed lookup callable answers. */
  readonly accounts = new Map<string, string>();

  /** Grants Pro to one ACCOUNT. Per uid, which is the point of several of these specs. */
  grantPro(uid: string): void {
    this.store.documents.set(
      BILLING_PATHS.entitlements(uid),
      entitlementsToJson({ ...FREE_ENTITLEMENTS, pro: true, proSince: this.clock.now() }),
    );
  }
}

/**
 * The phone. ONE service and ONE vault identity across every account it signs into -- a second
 * account must not be handed a second service, or none of this proves anything.
 */
class Phone {
  readonly cloud: InMemoryCloudBackend;

  readonly entitlements: EntitlementsController;

  readonly messaging: MessagingService;

  identity: MessagingIdentity | null = deriveMessagingIdentity(masterKey(VAULT_SEED));

  constructor(private readonly world: World) {
    this.cloud = new InMemoryCloudBackend(new InMemoryFileSystem(), world.store);
    this.entitlements = new EntitlementsController({
      secureStore: new InMemorySecureStore(),
      clock: world.clock,
      cloud: this.cloud,
      enforced: true,
    });
    this.messaging = new MessagingService({
      cloud: this.cloud,
      directory: new InMemoryDirectory(
        world.accounts,
        () => this.entitlements.isPro(),
        () => true,
      ),
      entitlements: this.entitlements,
      clock: world.clock,
      random: new SequentialRandom(VAULT_SEED),
      identity: () => this.identity,
      hidden: new HiddenMessages(new InMemorySecureStore()),
    });
  }

  /** Signs in, publishes this vault's key for that account, and settles the entitlement. */
  async use(email: string): Promise<string> {
    if (this.cloud.currentUser !== null) await this.cloud.signOut();
    const user = this.world.accounts.has(email)
      ? await this.cloud.signIn(email, PASSWORD)
      : await this.cloud.signUp(email, PASSWORD);
    this.world.accounts.set(email, user.uid);
    await this.entitlements.refresh();
    await this.messaging.publishKey();
    await flush();
    return user.uid;
  }
}

/** A correspondent on their own phone, with their own vault, who really encrypts. */
class Correspondent {
  readonly cloud: InMemoryCloudBackend;

  readonly messaging: MessagingService;

  identity: MessagingIdentity;

  private constructor(
    world: World,
    seed: number,
    readonly uid: string,
    entitlements: EntitlementsController,
    cloud: InMemoryCloudBackend,
  ) {
    this.cloud = cloud;
    this.identity = deriveMessagingIdentity(masterKey(seed));
    this.messaging = new MessagingService({
      cloud,
      directory: new InMemoryDirectory(
        world.accounts,
        () => entitlements.isPro(),
        () => true,
      ),
      entitlements,
      clock: world.clock,
      random: new SequentialRandom(seed),
      identity: () => this.identity,
      hidden: new HiddenMessages(new InMemorySecureStore()),
    });
  }

  static async join(world: World, email: string, seed: number): Promise<Correspondent> {
    const cloud = new InMemoryCloudBackend(new InMemoryFileSystem(), world.store);
    const user = world.accounts.has(email)
      ? await cloud.signIn(email, PASSWORD)
      : await cloud.signUp(email, PASSWORD);
    world.accounts.set(email, user.uid);
    world.grantPro(user.uid);
    const entitlements = new EntitlementsController({
      secureStore: new InMemorySecureStore(),
      clock: world.clock,
      cloud,
      enforced: true,
    });
    await entitlements.refresh();
    const made = new Correspondent(world, seed, user.uid, entitlements, cloud);
    await made.messaging.publishKey();
    return made;
  }
}

/**
 * The bodies a thread shows, sorted.
 *
 * Sorted because the clock does not advance in this harness: two messages written in the same
 * test share a `createdAt`, so `orderBy` has nothing to separate them and either order is a
 * correct answer. What matters here is which bodies came back in clear, and that is asserted in
 * full; ordering is a claim this fixture is not entitled to make.
 */
async function bodies(service: MessagingService, cid: string): Promise<(string | null)[]> {
  const thread = collect<ConversationState>((on) => service.watchConversation(cid, on));
  await flush();
  const seen = thread.last().messages.map((m) => m.body);
  thread.stop();
  return [...seen].sort();
}

async function threadState(service: MessagingService, cid: string): Promise<ConversationState> {
  const thread = collect<ConversationState>((on) => service.watchConversation(cid, on));
  await flush();
  const last = thread.last();
  thread.stop();
  return last;
}

async function listState(service: MessagingService): Promise<MessagingState> {
  const watcher = collect<MessagingState>((on) => service.watch(on));
  await flush();
  const last = watcher.last();
  watcher.stop();
  return last;
}

/**
 * All three accounts established on the one vault, each Pro, each with its own correspondent and
 * its own two-way thread. Every body here was sealed by the other side's service.
 */
async function threeAccounts(): Promise<{
  world: World;
  phone: Phone;
  uids: { a: string; b: string; c: string };
  peers: { a: Correspondent; b: Correspondent; c: Correspondent };
  cids: { a: string; b: string; c: string };
}> {
  const world = new World();
  const phone = new Phone(world);

  // Correspondents first, so each account has somebody to resolve and a published key to seal to.
  const peerA = await Correspondent.join(world, PEER_A, 11);
  const peerB = await Correspondent.join(world, PEER_B, 12);
  const peerC = await Correspondent.join(world, PEER_C, 13);

  // Each account signs in once to publish this vault's key for itself, and is given Pro.
  const a = await phone.use(A);
  world.grantPro(a);
  const b = await phone.use(B);
  world.grantPro(b);
  const c = await phone.use(C);
  world.grantPro(c);

  const cids = { a: '', b: '', c: '' };
  const pairs: [string, Correspondent, 'a' | 'b' | 'c'][] = [
    [A, peerA, 'a'],
    [B, peerB, 'b'],
    [C, peerC, 'c'],
  ];
  for (const [email, peer, key] of pairs) {
    await phone.use(email);
    const cid = await phone.messaging.startConversation(peerEmail(key));
    await phone.messaging.send(cid, `${key}: from the phone`);
    await flush();
    // ...and the other side answers, so the phone has something it did not seal itself.
    await peer.messaging.send(cid, `${key}: from the correspondent`);
    await flush();
    cids[key] = cid;
  }

  return { world, phone, uids: { a, b, c }, peers: { a: peerA, b: peerB, c: peerC }, cids };
}

function peerEmail(key: 'a' | 'b' | 'c'): string {
  return key === 'a' ? PEER_A : key === 'b' ? PEER_B : PEER_C;
}

describe('three accounts sharing one vault', () => {
  it('derive the same messaging key, and each publishes its own document', async () => {
    const world = new World();
    const phone = new Phone(world);
    const a = await phone.use(A);
    const b = await phone.use(B);
    const c = await phone.use(C);

    const mine = base64Encode(deriveMessagingIdentity(masterKey(VAULT_SEED)).publicKey);
    for (const uid of [a, b, c]) {
      const doc = parsePublishedKey(uid, world.store.documents.get(MESSAGING_PATHS.publicKey(uid)) ?? null);
      expect(doc).not.toBeNull();
      expect(doc?.publicKey).toBe(mine);
      // Its own document, under its own uid, with no history: nothing rotated anything.
      expect(doc?.uid).toBe(uid);
      expect(doc?.previous).toEqual([]);
    }
    // Three separate documents, not one shared one.
    expect(new Set([a, b, c]).size).toBe(3);
  });

  /** None of them is foreign: the vault is the one that published, for all three. */
  it('are each at home on the vault, none of them foreign', async () => {
    const world = new World();
    const phone = new Phone(world);
    for (const email of [A, B, C]) {
      await phone.use(email);
      const state = await listState(phone.messaging);
      expect(state.foreignVault).toBe(false);
      expect(state.historicalIdentity).toBe(false);
    }
  });

  /**
   * The headline. Each account holds a real two-way thread, and the body sealed by the OTHER side
   * comes back in clear -- so this is X25519 interop, not a fixture being read back.
   */
  it('each send and read their own thread, with real encryption both ways', async () => {
    const { phone, cids } = await threeAccounts();

    for (const key of ['a', 'b', 'c'] as const) {
      await phone.use(key === 'a' ? A : key === 'b' ? B : C);
      expect(await bodies(phone.messaging, cids[key])).toEqual(
        [`${key}: from the phone`, `${key}: from the correspondent`].sort(),
      );
    }
  });

  /** And the correspondents read what the phone sealed, which is the other half of interop. */
  it('are read by their correspondents, each seeing only their own thread', async () => {
    const { peers, cids } = await threeAccounts();

    expect(await bodies(peers.a.messaging, cids.a)).toEqual(
      ['a: from the phone', 'a: from the correspondent'].sort(),
    );
    expect(await bodies(peers.b.messaging, cids.b)).toEqual(
      ['b: from the phone', 'b: from the correspondent'].sort(),
    );
  });

  /** A -> B -> C -> A. Returning to an account finds its own thread, not the last one's. */
  it('survive switching back and forth, each returning to its own conversation', async () => {
    const { phone, cids } = await threeAccounts();

    for (const key of ['a', 'b', 'c', 'a', 'c', 'b', 'a'] as const) {
      await phone.use(key === 'a' ? A : key === 'b' ? B : C);
      const state = await listState(phone.messaging);
      expect(state.conversations.map((row) => row.id)).toEqual([cids[key]]);
      expect(await bodies(phone.messaging, cids[key])).toEqual(
        [`${key}: from the phone`, `${key}: from the correspondent`].sort(),
      );
    }
  });

  /**
   * THE SECURITY CLAIM. The vault opens all three threads equally well -- that is what sharing a
   * key means -- so the only thing between account B and account A's conversation is the
   * membership check. If this ever passes, the architecture has no isolation left.
   */
  it('cannot open one another’s conversations, though the key would', async () => {
    const { world, phone, cids } = await threeAccounts();

    await phone.use(B);
    for (const stranger of [cids.a, cids.c]) {
      const state = await threadState(phone.messaging, stranger);
      expect(state.messages).toEqual([]);
      expect(state.problem).toBe('unavailable');
      expect(state.canSend).toBe(false);
    }
    // The ciphertext is still there; the refusal is a decision, not an empty store.
    const stored = [...world.store.documents.keys()].filter((path) =>
      path.startsWith(`conversations/${cids.a}/messages/`),
    );
    expect(stored.length).toBeGreaterThan(0);
  });

  it('refuse to send into one another’s conversations', async () => {
    const { phone, cids } = await threeAccounts();
    await phone.use(C);

    await expect(phone.messaging.send(cids.a, 'not mine to write in')).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  /** Nothing of the previous account survives the switch: rows, names, or cached peer keys. */
  it('carry no cached conversations, labels or peer keys across a switch', async () => {
    const { phone, cids, uids } = await threeAccounts();

    await phone.use(A);
    const beforeSwitch = await listState(phone.messaging);
    expect(beforeSwitch.conversations[0]?.id).toBe(cids.a);

    // Every published-key read after the switch, to show the peer cache was dropped rather than
    // reused across accounts.
    const reads: string[] = [];
    const original = phone.cloud.getDocument.bind(phone.cloud);
    const get = jest.spyOn(phone.cloud, 'getDocument').mockImplementation(async (path: string) => {
      if (path.startsWith('messagingKeys/')) reads.push(path);
      return original(path);
    });

    await phone.use(B);
    const after = await listState(phone.messaging);
    await bodies(phone.messaging, cids.b);
    get.mockRestore();

    expect(after.conversations.map((row) => row.id)).toEqual([cids.b]);
    expect(after.conversations[0]?.label).not.toBe(PEER_A);
    // B's own key document and B's peer were fetched fresh for this account.
    expect(reads.some((path) => path === MESSAGING_PATHS.publicKey(uids.b))).toBe(true);
  });
});

describe('Pro follows the account, not the vault', () => {
  /**
   * One vault, three accounts, and only two of them have paid. The middle one must be read-only
   * even though the device it is on has a Pro account signed in a moment earlier.
   */
  async function proOnlyForAAndC(): Promise<{ world: World; phone: Phone; peer: Correspondent }> {
    const world = new World();
    const phone = new Phone(world);
    const peer = await Correspondent.join(world, PEER_A, 11);
    const a = await phone.use(A);
    world.grantPro(a);
    await phone.use(B); // deliberately not granted
    const c = await phone.use(C);
    world.grantPro(c);
    return { world, phone, peer };
  }

  it('lets the Pro accounts send', async () => {
    const { phone, peer } = await proOnlyForAAndC();

    for (const email of [A, C]) {
      await phone.use(email);
      expect(phone.messaging.canMessage()).toBe(true);
      const cid = await phone.messaging.startConversation(PEER_A);
      await expect(phone.messaging.send(cid, 'paid for')).resolves.toBeDefined();
      await flush();
      expect(await bodies(peer.messaging, cid)).toContain('paid for');
    }
  });

  it('refuses the account that has not, on the same vault and the same device', async () => {
    const { phone } = await proOnlyForAAndC();
    await phone.use(B);

    expect(phone.messaging.canMessage()).toBe(false);
    await expect(phone.messaging.startConversation(PEER_A)).rejects.toMatchObject({
      code: 'pro-required',
    });
  });

  /** And says which of the two reasons it is, rather than leaving the composer unexplained. */
  it('tells the unpaid account why, without blaming the vault', async () => {
    const { world, phone, peer } = await proOnlyForAAndC();
    // A thread B is genuinely a member of, so the refusal is about Pro and nothing else.
    await phone.use(A);
    const aCid = await phone.messaging.startConversation(PEER_A);
    await phone.messaging.send(aCid, 'hello');
    const bUid = world.accounts.get(B) ?? '';
    const peerUid = world.accounts.get(PEER_A) ?? '';
    const bCid = conversationIdFor(bUid, peerUid);
    // Written through the CORRESPONDENT's backend: they are a member of it and the phone, signed
    // in as A at this moment, is not. The fake authorises writes exactly as the rules do.
    await peer.cloud.putDocument(
      `conversations/${bCid}`,
      conversationRecord([bUid, peerUid], peerUid, world.clock.now()),
    );

    await phone.use(B);
    const state = await threadState(phone.messaging, bCid);

    expect(state.canSend).toBe(false);
    expect(state.sendBlocked).toBe('pro-required');
    // Not blamed on the vault, which is the same one the Pro accounts are using happily.
    expect(state.sendBlocked).not.toBe('foreign-vault');
  });

  /** Entitlement does not linger from the account signed in before. */
  it('does not carry a Pro entitlement across a switch', async () => {
    const { phone } = await proOnlyForAAndC();
    await phone.use(A);
    expect(phone.messaging.canMessage()).toBe(true);

    await phone.use(B);

    expect(phone.messaging.canMessage()).toBe(false);
  });
});

describe('two accounts that share a vault, talking to each other', () => {
  /**
   * The shape production already contains: two of one person's accounts, on one device, in a
   * conversation. Both sides derive the SAME keypair, so the conversation key is an X25519
   * exchange with itself -- which is well defined, and the conversation id is what keeps it
   * distinct from every other thread either account has.
   */
  it('can hold a conversation, each side reading what the other sealed', async () => {
    const world = new World();
    const phone = new Phone(world);
    const a = await phone.use(A);
    world.grantPro(a);
    const b = await phone.use(B);
    world.grantPro(b);

    await phone.use(A);
    const cid = await phone.messaging.startConversation(B);
    await phone.messaging.send(cid, 'from my other account');
    await flush();

    await phone.use(B);
    expect(await bodies(phone.messaging, cid)).toEqual(['from my other account']);

    await phone.messaging.send(cid, 'and back again');
    await flush();

    await phone.use(A);
    expect(await bodies(phone.messaging, cid)).toEqual(
      ['from my other account', 'and back again'].sort(),
    );
    expect(conversationIdFor(a, b)).toBe(cid);

    // And what is actually stored is ciphertext: no body appears anywhere in the documents.
    const written = [...world.store.documents.entries()].filter(([path]) =>
      path.startsWith(`conversations/${cid}/messages/`),
    );
    expect(written).toHaveLength(2);
    const serialised = JSON.stringify(written);
    expect(serialised).not.toContain('from my other account');
    expect(serialised).not.toContain('and back again');
  });
});

describe('a rotated account among unrotated ones', () => {
  /**
   * One account on this vault has an older key in its history -- the shape a pre-refusal build
   * left behind. Switching to it and away again must not touch what the other accounts publish,
   * and must not describe an unchanged vault as foreign.
   */
  it('does not disturb the other accounts on the same vault', async () => {
    const world = new World();
    const phone = new Phone(world);
    const a = await phone.use(A);
    const b = await phone.use(B);
    const mine = base64Encode(deriveMessagingIdentity(masterKey(VAULT_SEED)).publicKey);
    const retired = base64Encode(deriveMessagingIdentity(masterKey(77)).publicKey);

    // B rotated onto this vault at some point: the retired key is in its history.
    world.store.documents.set(MESSAGING_PATHS.publicKey(b), {
      v: 1,
      uid: b,
      publicKey: mine,
      previous: [retired],
      updatedAt: world.clock.now(),
    });

    await phone.use(B);
    const bState = await listState(phone.messaging);
    expect(bState.foreignVault).toBe(false);
    expect(bState.historicalIdentity).toBe(false);

    await phone.use(A);
    const aState = await listState(phone.messaging);
    expect(aState.foreignVault).toBe(false);

    // Neither document moved: A has no history, B keeps exactly the one entry it had.
    expect(parsePublishedKey(a, world.store.documents.get(MESSAGING_PATHS.publicKey(a)) ?? null))
      .toMatchObject({ publicKey: mine, previous: [] });
    expect(parsePublishedKey(b, world.store.documents.get(MESSAGING_PATHS.publicKey(b)) ?? null))
      .toMatchObject({ publicKey: mine, previous: [retired] });
  });
});
