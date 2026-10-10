/**
 * One account, two handsets, two different vaults.
 *
 * The mirror image of `threeAccountsOneVault.test.ts`. There, many accounts shared one vault and
 * the question was whether anything leaked between them. Here one account spans two vaults, and
 * the question is the opposite: the second handset derives a key the account has never published,
 * so it can reach none of the conversations until the account's own vault key is recovered onto
 * it.
 *
 * That is by design -- the identity is the vault -- but it is the single least obvious consequence
 * of the design, and nothing proved it. In particular nothing proved the part that matters most:
 * that the second handset, having failed, leaves the first one completely alone. A `publishKey`
 * that rotated instead of refusing is exactly how ten production accounts were stranded, and the
 * only thing standing between that and a user is the refusal asserted below.
 *
 * Everything is real. The correspondent is its own service with its own vault, so a body that
 * comes back in clear was genuinely sealed by somebody else under X25519.
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
import { MESSAGING_PATHS, parsePublishedKey } from '@/messaging/messaging';
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
const PEER = 'peer@example.test';

/** Device 1's vault, device 2's vault, and the correspondent's. All different. */
const VAULT_ONE = 1;
const VAULT_TWO = 2;
const VAULT_PEER = 9;

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

class World {
  readonly store = new InMemoryCloudStore();

  readonly clock = new FakeClock();

  readonly accounts = new Map<string, string>();

  grantPro(uid: string): void {
    this.store.documents.set(
      BILLING_PATHS.entitlements(uid),
      entitlementsToJson({ ...FREE_ENTITLEMENTS, pro: true, proSince: this.clock.now() }),
    );
  }

  keyDoc(uid: string): { publicKey: string; previous: readonly string[] } | null {
    const parsed = parsePublishedKey(
      uid,
      this.store.documents.get(MESSAGING_PATHS.publicKey(uid)) ?? null,
    );
    return parsed === null ? null : { publicKey: parsed.publicKey, previous: parsed.previous };
  }
}

/**
 * One handset: its own cloud session, its own vault, its own service. Two of these over one store
 * is what makes this two devices rather than two tabs.
 */
class Handset {
  readonly cloud: InMemoryCloudBackend;

  readonly entitlements: EntitlementsController;

  readonly messaging: MessagingService;

  identity: MessagingIdentity | null;

  constructor(
    private readonly world: World,
    readonly vaultSeed: number,
  ) {
    this.identity = deriveMessagingIdentity(masterKey(vaultSeed));
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
      random: new SequentialRandom(vaultSeed),
      identity: () => this.identity,
      hidden: new HiddenMessages(new InMemorySecureStore()),
    });
  }

  /** Signs in, grants Pro, and lets `publishKey` do whatever it is going to do. */
  async use(email: string): Promise<string> {
    if (this.cloud.currentUser !== null) await this.cloud.signOut();
    const user = this.world.accounts.has(email)
      ? await this.cloud.signIn(email, PASSWORD)
      : await this.cloud.signUp(email, PASSWORD);
    this.world.accounts.set(email, user.uid);
    this.world.grantPro(user.uid);
    await this.entitlements.refresh();
    await this.messaging.publishKey();
    await flush();
    return user.uid;
  }
}

async function bodies(service: MessagingService, cid: string): Promise<(string | null)[]> {
  const thread = collect<ConversationState>((on) => service.watchConversation(cid, on));
  await flush();
  const seen = thread.last().messages.map((m) => m.body);
  thread.stop();
  // Sorted: the clock does not advance here, so two messages share a `createdAt` and `orderBy`
  // has nothing to separate them. Which bodies opened is the claim; their order is not.
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
 * Account A set up on device 1, one two-way thread with a real correspondent, and device 2 then
 * signing into the same account on a vault of its own.
 */
async function accountOnBothDevices(): Promise<{
  world: World;
  one: Handset;
  two: Handset;
  peer: Handset;
  aUid: string;
  cid: string;
}> {
  const world = new World();
  const peer = new Handset(world, VAULT_PEER);
  await peer.use(PEER);

  const one = new Handset(world, VAULT_ONE);
  const aUid = await one.use(A);
  const cid = await one.messaging.startConversation(PEER);
  await one.messaging.send(cid, 'sent from device one');
  await flush();
  await peer.messaging.send(cid, 'answered by the correspondent');
  await flush();

  const two = new Handset(world, VAULT_TWO);
  await two.use(A);

  return { world, one, two, peer, aUid, cid };
}

describe('the same account on a second device with a different vault', () => {
  /**
   * The refusal that matters. `publishKey` finds a key it did not derive and leaves it exactly
   * where it is -- it does not rotate, which is what silently stranded ten production accounts.
   */
  it('leaves the published key exactly as the first device wrote it', async () => {
    const { world, one, aUid } = await accountOnBothDevices();
    const expected = base64Encode(deriveMessagingIdentity(masterKey(VAULT_ONE)).publicKey);

    expect(world.keyDoc(aUid)).toEqual({ publicKey: expected, previous: [] });
    // And it is device one's key, not device two's.
    expect(expected).not.toBe(base64Encode(deriveMessagingIdentity(masterKey(VAULT_TWO)).publicKey));
    expect(one.vaultSeed).toBe(VAULT_ONE);
  });

  it('knows the vault is not the account’s, and says so', async () => {
    const { two } = await accountOnBothDevices();

    const state = await listState(two.messaging);
    expect(state.foreignVault).toBe(true);
    expect(state.historicalIdentity).toBe(false);
  });

  /** The thread is listed -- reading is never gated -- and every body it cannot open is null. */
  it('lists the conversation but opens none of it', async () => {
    const { two, cid } = await accountOnBothDevices();

    const state = await threadState(two.messaging, cid);
    expect(state.messages).toHaveLength(2);
    expect(state.messages.map((m) => m.body)).toEqual([null, null]);
    expect(state.canSend).toBe(false);
    expect(state.sendBlocked).toBe('foreign-vault');
  });

  it('refuses to send, rather than writing something neither end could read', async () => {
    const { two, cid } = await accountOnBothDevices();

    await expect(two.messaging.send(cid, 'unreadable at both ends')).rejects.toMatchObject({
      code: 'foreign-vault',
    });
  });

  /**
   * THE POINT OF THE REFUSAL: device one carries on as though nothing happened.
   *
   * `publishKey` is called again first, because that is what a real unlock does and it is the
   * only moment device one would ever re-read the published key. Without it the service is simply
   * holding the identity it already had and the assertion is about nothing.
   *
   * What this does NOT pin is the rotation refusal -- the spec above does that, by looking at the
   * document. Running this one against a deliberately rotating `publishKey` showed it still
   * passing, and the reason is worth recording: a rotation appends the replaced key to
   * `previous`, and every peer walks `[current, ...previous]` when opening, so device one's
   * reading and sending go on working. The injury a rotation does is to the published record and
   * to whoever cannot find the retired key later -- not to the device that was holding it.
   */
  it('leaves the first device reading and sending exactly as before, even after it unlocks again', async () => {
    const { one, peer, cid } = await accountOnBothDevices();

    one.messaging.forgetKeys();
    await one.messaging.publishKey();
    await flush();
    expect((await listState(one.messaging)).foreignVault).toBe(false);

    expect(await bodies(one.messaging, cid)).toEqual(
      ['sent from device one', 'answered by the correspondent'].sort(),
    );
    await expect(one.messaging.send(cid, 'still mine to write in')).resolves.toBeDefined();
    await flush();
    expect(await bodies(peer.messaging, cid)).toContain('still mine to write in');
  });
});

describe('recovering the account’s vault onto the second device', () => {
  it('accepts the key the account actually published', async () => {
    const { two } = await accountOnBothDevices();

    await expect(two.messaging.useRecoveredMasterKey(masterKey(VAULT_ONE))).resolves.toBe('ok');
  });

  /** And the thread opens, with the body the correspondent sealed. */
  it('opens the conversation it could not read a moment earlier', async () => {
    const { two, cid } = await accountOnBothDevices();
    expect(await bodies(two.messaging, cid)).toEqual([null, null]);

    await two.messaging.useRecoveredMasterKey(masterKey(VAULT_ONE));
    await flush();

    expect(await bodies(two.messaging, cid)).toEqual(
      ['sent from device one', 'answered by the correspondent'].sort(),
    );
  });

  it('clears the foreign flag and lets the composer work', async () => {
    const { two, cid } = await accountOnBothDevices();
    await two.messaging.useRecoveredMasterKey(masterKey(VAULT_ONE));
    await flush();

    expect((await listState(two.messaging)).foreignVault).toBe(false);
    const state = await threadState(two.messaging, cid);
    expect(state.canSend).toBe(true);
    expect(state.sendBlocked).toBeNull();
  });

  /**
   * Both devices on one account at once, which is the state the whole exercise is for. What
   * device two sends is readable by the correspondent AND by device one -- so recovery produced
   * a genuinely shared identity, not a second one that happens to decrypt the past.
   */
  it('lets both devices send into the same thread, each reading the other', async () => {
    const { one, two, peer, cid } = await accountOnBothDevices();
    await two.messaging.useRecoveredMasterKey(masterKey(VAULT_ONE));
    await flush();

    await two.messaging.send(cid, 'sent from device two');
    await flush();

    expect(await bodies(peer.messaging, cid)).toContain('sent from device two');
    expect(await bodies(one.messaging, cid)).toContain('sent from device two');
  });

  /** Recovery writes nothing: it gives this device the account's key, never the reverse. */
  it('publishes nothing and rotates nothing', async () => {
    const { world, two, aUid } = await accountOnBothDevices();
    const before = structuredClone(world.store.documents.get(MESSAGING_PATHS.publicKey(aUid)));

    await two.messaging.useRecoveredMasterKey(masterKey(VAULT_ONE));
    await two.messaging.publishKey();
    await flush();

    expect(world.store.documents.get(MESSAGING_PATHS.publicKey(aUid))).toEqual(before);
  });

  it('does not disturb the first device', async () => {
    const { one, two, cid } = await accountOnBothDevices();
    await two.messaging.useRecoveredMasterKey(masterKey(VAULT_ONE));
    await flush();

    expect((await listState(one.messaging)).foreignVault).toBe(false);
    expect(await bodies(one.messaging, cid)).toEqual(
      ['sent from device one', 'answered by the correspondent'].sort(),
    );
  });

  /** A wrong vault is still refused: recovery is not a way in, it is a way back. */
  it('still refuses a vault that is nobody’s', async () => {
    const { two, cid } = await accountOnBothDevices();

    await expect(two.messaging.useRecoveredMasterKey(masterKey(31))).resolves.toBe('mismatch');
    expect(await bodies(two.messaging, cid)).toEqual([null, null]);
  });
});

describe('the first device switching accounts while the second stays signed in', () => {
  /**
   * Device 1 has a second account of its own on the same vault. Moving between them must not
   * touch account A's published key, which device 2 is depending on.
   */
  it('does not disturb account A, which the other device is using', async () => {
    const { world, one, two, aUid, cid } = await accountOnBothDevices();
    await two.messaging.useRecoveredMasterKey(masterKey(VAULT_ONE));
    await flush();
    const before = structuredClone(world.store.documents.get(MESSAGING_PATHS.publicKey(aUid)));

    const bUid = await one.use(B);
    await one.use(A);
    await flush();

    expect(world.store.documents.get(MESSAGING_PATHS.publicKey(aUid))).toEqual(before);
    // B published its own document on the same vault; A's is untouched.
    expect(world.keyDoc(bUid)?.publicKey).toBe(world.keyDoc(aUid)?.publicKey);
    expect(bUid).not.toBe(aUid);
    // And device two, which never moved, still reads the thread.
    expect(await bodies(two.messaging, cid)).toEqual(
      ['sent from device one', 'answered by the correspondent'].sort(),
    );
  });

  /** The recovered identity belongs to the account it was recovered for, and goes with it. */
  it('does not carry the second device’s recovered key into another account', async () => {
    const { two, cid } = await accountOnBothDevices();
    await two.messaging.useRecoveredMasterKey(masterKey(VAULT_ONE));
    await flush();
    expect((await threadState(two.messaging, cid)).canSend).toBe(true);

    // The second handset signs into its own other account. Its own vault derives that account's
    // key, so nothing is foreign -- and A's recovered key must not have come along.
    await two.use(B);

    expect((await listState(two.messaging)).foreignVault).toBe(false);
    await two.use(A);
    // Back on A, the recovered key is gone and the device is foreign again until it recovers.
    expect((await listState(two.messaging)).foreignVault).toBe(true);
  });
});
