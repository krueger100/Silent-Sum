/**
 * Published keys, and what happens to old messages when one changes.
 *
 * A conversation key is X25519 over whichever key the peer had published when the message was
 * sent. Replacing a published key therefore does not merely change what happens next: it takes
 * away the only record of how to open everything already sent, for the OTHER side, silently and
 * for good.
 *
 * Two things stand between that and a user, and both are pinned here.
 *
 * Retiring: `messagingKeys/{uid}` keeps every key it has ever had, so a peer can still open what
 * was sent under each one. Production holds accounts that were rotated before this existed, and
 * the read side must go on working for them -- `World.rotate` writes exactly what those accounts
 * look like.
 *
 * Refusing: `publishKey` no longer rotates at all. A vault that did not derive the published key
 * does not get to replace it, because the vault that did is the one that can read the account's
 * conversations. It is recorded as `foreignVault` and the user is asked to recover instead.
 *
 * What neither undoes is stated here too: an account that changes its own vault cannot read its
 * own old messages again. Those need the old master key, which is what recovery is for.
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
import { CloudError } from '@/firebase/types';
import { HiddenMessages } from '@/messaging/hiddenMessages';
import { InMemoryDirectory } from '@/messaging/directory';
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
import { FakeClock, HOUR_MS, MINUTE_MS } from '@/utils/clock';

const ALICE = 'alice@example.test';
const BOB = 'bob@example.test';
const PASSWORD = 'account-password';

function masterKey(seed: number): Uint8Array {
  const bytes = new Uint8Array(MASTER_KEY_LENGTH);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (seed + i * 11) & 0xff;
  return bytes;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function collect<T>(subscribe: (on: (state: T) => void) => () => void): {
  last: () => T;
  stop: () => void;
} {
  const states: T[] = [];
  const stop = subscribe((state) => states.push(state));
  return { last: () => states[states.length - 1] as T, stop };
}

interface Side {
  readonly cloud: InMemoryCloudBackend;
  readonly messaging: MessagingService;
  readonly uid: string;
  identity: MessagingIdentity | null;
}

class World {
  readonly store = new InMemoryCloudStore();

  readonly clock = new FakeClock();

  readonly accounts = new Map<string, string>();

  async join(email: string, seed: number): Promise<Side> {
    const fs = new InMemoryFileSystem();
    const cloud = new InMemoryCloudBackend(fs, this.store);
    const user = this.accounts.has(email)
      ? await cloud.signIn(email, PASSWORD)
      : await cloud.signUp(email, PASSWORD);
    this.accounts.set(email, user.uid);

    const entitlements = new EntitlementsController({
      secureStore: new InMemorySecureStore(),
      clock: this.clock,
      cloud,
      enforced: true,
    });
    const side: Side = {
      cloud,
      uid: user.uid,
      identity: deriveMessagingIdentity(masterKey(seed)),
      messaging: undefined as unknown as MessagingService,
    };
    Object.assign(side, {
      messaging: new MessagingService({
        cloud,
        directory: new InMemoryDirectory(
          this.accounts,
          () => entitlements.isPro(),
          () => true,
        ),
        entitlements,
        clock: this.clock,
        random: new SequentialRandom(seed),
        identity: () => side.identity,
        hidden: new HiddenMessages(new InMemorySecureStore()),
      }),
    });
    this.store.documents.set(
      BILLING_PATHS.entitlements(user.uid),
      entitlementsToJson({ ...FREE_ENTITLEMENTS, pro: true, proSince: this.clock.now() }),
    );
    await entitlements.refresh();
    await side.messaging.publishKey();
    return side;
  }

  /**
   * A vault change that has already happened, written the way the cloud already holds it.
   *
   * `publishKey` will no longer do this -- it refuses to replace a key it did not derive -- but
   * production contains accounts rotated before that check existed, and a peer must still be
   * able to read them. So the document is written directly, exactly as the older client left
   * it: the retired key appended to `previous`, the new one current.
   */
  rotate(side: Side, seed: number): void {
    const before = this.keyDoc(side.uid);
    side.identity = deriveMessagingIdentity(masterKey(seed));
    const identity = side.identity;
    if (identity === null) throw new Error('no identity');
    this.store.documents.set(MESSAGING_PATHS.publicKey(side.uid), {
      v: 1,
      uid: side.uid,
      publicKey: base64Encode(identity.publicKey),
      previous: [...before.previous, before.publicKey],
      updatedAt: this.clock.now(),
    });
  }

  keyDoc(uid: string): { publicKey: string; previous: readonly string[] } {
    const parsed = parsePublishedKey(uid, this.store.documents.get(MESSAGING_PATHS.publicKey(uid)) ?? null);
    if (parsed === null) throw new Error('no published key');
    return { publicKey: parsed.publicKey, previous: parsed.previous };
  }
}

describe('publishing a messaging key', () => {
  it('writes nothing when the derived key is the one already published', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1);
    const before = world.keyDoc(alice.uid);

    const put = jest.spyOn(alice.cloud, 'putDocument');
    await alice.messaging.publishKey();

    expect(put).not.toHaveBeenCalled();
    expect(world.keyDoc(alice.uid)).toEqual(before);
    put.mockRestore();
  });

  it('creates a first key with an empty history', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1);

    expect(world.keyDoc(alice.uid).previous).toEqual([]);
    expect(world.keyDoc(alice.uid).publicKey).not.toBe('');
  });

  /**
   * The rule that replaced rotation.
   *
   * Overwriting looked harmless from one device: the old key was retired, the peer kept reading,
   * nothing was lost. What it actually did was hand the account's identity to whichever vault
   * opened Messages last -- and the other vault took it straight back on its next unlock, each
   * swap stranding the other for everything sent in between. A production audit found ten
   * accounts in exactly that state, rewritten by this code path, with nobody told.
   */
  it('refuses to replace a key this vault did not derive', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1);
    const before = world.keyDoc(alice.uid);

    // A different vault on the same account: new master key, so a different identity.
    alice.identity = deriveMessagingIdentity(masterKey(7));
    const put = jest.spyOn(alice.cloud, 'putDocument');
    await alice.messaging.publishKey();

    expect(put).not.toHaveBeenCalled();
    expect(world.keyDoc(alice.uid)).toEqual(before);
    put.mockRestore();
  });

  it('leaves an existing history untouched when it finds a foreign key', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1);
    // An account that rotated before the refusal existed -- what production already holds.
    world.rotate(alice, 2);
    const inherited = world.keyDoc(alice.uid);

    alice.identity = deriveMessagingIdentity(masterKey(9));
    await alice.messaging.publishKey();

    expect(world.keyDoc(alice.uid)).toEqual(inherited);
    expect(world.keyDoc(alice.uid).previous).toHaveLength(1);
  });

  /**
   * Two devices of one account publishing for the first time at once. The create loses, and the
   * answer is to read again rather than retry the write: the winner's key is now the account's,
   * and this vault is the foreign one.
   */
  it('does not overwrite a key another device created first', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1);
    const a = world.keyDoc(alice.uid).publicKey;

    // This device believes the account has never published...
    const get = jest.spyOn(alice.cloud, 'getDocument').mockImplementationOnce(async () => null);
    // ...so it creates, and the rules refuse a create over a document that already exists.
    const put = jest.spyOn(alice.cloud, 'putDocument').mockImplementationOnce(async () => {
      throw new CloudError('permission-denied');
    });

    alice.identity = deriveMessagingIdentity(masterKey(3));
    await alice.messaging.publishKey();

    // The re-read found the real document and left it exactly as the winner wrote it.
    expect(world.keyDoc(alice.uid).publicKey).toBe(a);
    expect(world.keyDoc(alice.uid).previous).toEqual([]);
    expect(put).toHaveBeenCalledTimes(1);
    get.mockRestore();
    put.mockRestore();
  });

  /** What the screen is told, which is the only form of this that reaches a user. */
  async function reported(side: Side): Promise<boolean> {
    const seen = collect<MessagingState>((on) => side.messaging.watch(on));
    await flush();
    const answer = seen.last().foreignVault;
    seen.stop();
    return answer;
  }

  it('reports a foreign vault, and stops reporting it when the account changes', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1);
    expect(await reported(alice)).toBe(false);

    alice.identity = deriveMessagingIdentity(masterKey(7));
    expect(await reported(alice)).toBe(true);

    // Signing out and in as somebody else must not carry the accusation across.
    await alice.cloud.signOut();
    await alice.cloud.signUp('carol@example.test', PASSWORD);

    expect(await reported(alice)).toBe(false);
  });

  /** A read that failed says nothing about whose key is stored, so it must not accuse one. */
  it('does not call a vault foreign because the lookup failed', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1);

    const get = jest.spyOn(alice.cloud, 'getDocument').mockImplementation(async () => {
      throw new CloudError('unavailable');
    });
    alice.identity = deriveMessagingIdentity(masterKey(7));

    expect(await reported(alice)).toBe(false);
    get.mockRestore();
  });
});

describe('what a foreign vault is allowed to do', () => {
  async function foreign(): Promise<{ world: World; alice: Side; bob: Side; cid: string }> {
    const world = new World();
    const alice = await world.join(ALICE, 1);
    const bob = await world.join(BOB, 2);
    const cid = await alice.messaging.startConversation(BOB);
    await alice.messaging.send(cid, 'written under the original vault');
    await flush();

    // Alice's account, opened on a vault that did not set messaging up.
    alice.identity = deriveMessagingIdentity(masterKey(7));
    alice.messaging.forgetKeys();
    await alice.messaging.publishKey();
    return { world, alice, bob, cid };
  }

  it('cannot send, because neither end could read what it sent', async () => {
    const { alice, cid } = await foreign();
    await expect(alice.messaging.send(cid, 'unreadable at both ends')).rejects.toMatchObject({
      code: 'foreign-vault',
    });
  });

  it('cannot start a conversation the other side could never answer', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1);
    await world.join(BOB, 2);
    alice.identity = deriveMessagingIdentity(masterKey(7));
    await alice.messaging.publishKey();

    await expect(alice.messaging.startConversation(BOB)).rejects.toMatchObject({
      code: 'foreign-vault',
    });
  });

  it('says so in the composer rather than sitting on "getting ready"', async () => {
    const { alice, cid } = await foreign();
    const thread = collect<ConversationState>((on) => alice.messaging.watchConversation(cid, on));
    await flush();

    expect(thread.last().canSend).toBe(false);
    expect(thread.last().sendBlocked).toBe('foreign-vault');
    thread.stop();
  });

  /** Reading is never gated. The rows are still there; the bodies it cannot open are null. */
  it('still shows the conversation it cannot read', async () => {
    const { alice, cid } = await foreign();
    const thread = collect<ConversationState>((on) => alice.messaging.watchConversation(cid, on));
    await flush();

    expect(thread.last().messages).toHaveLength(1);
    expect(thread.last().messages[0]?.body).toBeNull();
    thread.stop();
  });

  /** And the peer is untouched by any of it. */
  it('leaves the peer reading the original thread exactly as before', async () => {
    const { bob, cid } = await foreign();
    bob.messaging.forgetKeys();
    const thread = collect<ConversationState>((on) => bob.messaging.watchConversation(cid, on));
    await flush();

    expect(thread.last().messages[0]?.body).toBe('written under the original vault');
    thread.stop();
  });
});

describe('reading messages across a key rotation', () => {
  it('still opens, for the peer, a message sent before the rotation', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1);
    const bob = await world.join(BOB, 2);

    const cid = await alice.messaging.startConversation(BOB);
    await alice.messaging.send(cid, 'sent before the rotation');
    await flush();

    world.rotate(alice, 7);
    // Bob's cached peer keys go when his vault locks; this is that, without the ceremony.
    bob.messaging.forgetKeys();

    const thread = collect<ConversationState>((on) =>
      bob.messaging.watchConversation(cid, on),
    );
    await flush();

    expect(thread.last().messages.map((m) => m.body)).toEqual(['sent before the rotation']);
    thread.stop();
  });

  it('opens messages from before AND after a rotation in one thread', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1);
    const bob = await world.join(BOB, 2);

    const cid = await alice.messaging.startConversation(BOB);
    await alice.messaging.send(cid, 'before');
    await flush();

    world.rotate(alice, 7);
    bob.messaging.forgetKeys();
    alice.messaging.forgetKeys();
    world.clock.advance(1000);
    await alice.messaging.send(cid, 'after');
    await flush();

    const thread = collect<ConversationState>((on) =>
      bob.messaging.watchConversation(cid, on),
    );
    await flush();

    expect(thread.last().messages.map((m) => m.body)).toEqual(['before', 'after']);
    thread.stop();
  });

  it('opens messages written under three successive identities', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1);
    const bob = await world.join(BOB, 2);

    const cid = await alice.messaging.startConversation(BOB);
    await alice.messaging.send(cid, 'under one');
    await flush();

    world.rotate(alice, 7);
    alice.messaging.forgetKeys();
    world.clock.advance(1000);
    await alice.messaging.send(cid, 'under two');
    await flush();

    world.rotate(alice, 9);
    alice.messaging.forgetKeys();
    world.clock.advance(1000);
    await alice.messaging.send(cid, 'under three');
    await flush();

    bob.messaging.forgetKeys();
    const thread = collect<ConversationState>((on) =>
      bob.messaging.watchConversation(cid, on),
    );
    await flush();

    expect(thread.last().messages.map((m) => m.body)).toEqual([
      'under one',
      'under two',
      'under three',
    ]);
    expect(world.keyDoc(alice.uid).previous).toHaveLength(2);
    thread.stop();
  });

  /**
   * The limit of what key history can do, pinned so it is not mistaken for more.
   *
   * History is a record of PUBLIC keys. Reading one's own old messages needs the old SECRET, which
   * comes from the old master key and lives nowhere but the vault. An account whose vault changed
   * does not get its own history back by publishing -- that is what backup and restore are for.
   */
  it('does not give the rotating account back its own old messages', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1);
    const bob = await world.join(BOB, 2);

    const cid = await alice.messaging.startConversation(BOB);
    await alice.messaging.send(cid, 'written under the old vault');
    await flush();

    world.rotate(alice, 7);
    alice.messaging.forgetKeys();

    const thread = collect<ConversationState>((on) =>
      alice.messaging.watchConversation(cid, on),
    );
    await flush();

    // The row is there; the body is not, because the key that opens it is gone with the vault.
    expect(thread.last().messages).toHaveLength(1);
    expect(thread.last().messages[0]?.body).toBeNull();
    // And the peer is unaffected, which is the whole point of retiring rather than dropping.
    bob.messaging.forgetKeys();
    const bobThread = collect<ConversationState>((on) =>
      bob.messaging.watchConversation(cid, on),
    );
    await flush();
    expect(bobThread.last().messages[0]?.body).toBe('written under the old vault');
    thread.stop();
    bobThread.stop();
  });
});

/**
 * What the gate is actually for: the bytes in `messagingKeys/{uid}`.
 *
 * Everything above reads the gate through behaviour -- a throw, a `sendBlocked`, a peer that can
 * still decrypt. That is the right way round for a rule a user meets. But all of it would pass
 * just as well if the document HAD been rewritten and the peer happened to re-read it in the same
 * breath; behaviour in one process is a weak witness for a record that outlives every process.
 * What the ten production accounts lost was the document, so the document is what these assert.
 */
describe('what a foreign vault leaves behind', () => {
  /** The stored record as JSON, so a comparison catches a field appearing as well as changing. */
  function published(world: World, uid: string): string {
    return JSON.stringify(world.store.documents.get(MESSAGING_PATHS.publicKey(uid)) ?? null);
  }

  function stored(world: World, uid: string): ReturnType<typeof parsePublishedKey> {
    const doc = world.store.documents.get(MESSAGING_PATHS.publicKey(uid)) ?? null;
    return parsePublishedKey(uid, doc);
  }

  /** Alice's account, published by her own vault, then opened on a vault that never derived it. */
  async function openedElsewhere(): Promise<{ world: World; alice: Side; before: string }> {
    const world = new World();
    const alice = await world.join(ALICE, 1); // `join` publishes, as a first unlock would
    await world.join(BOB, 2);
    const before = published(world, alice.uid);

    alice.identity = deriveMessagingIdentity(masterKey(7));
    alice.messaging.forgetKeys();
    // The clock moves, so a write of even the SAME key would show as a different `updatedAt`.
    world.clock.advance(HOUR_MS);
    return { world, alice, before };
  }

  it('leaves the published record byte for byte as it found it', async () => {
    const { world, alice, before } = await openedElsewhere();
    await alice.messaging.publishKey();

    expect(published(world, alice.uid)).toBe(before);
  });

  /**
   * `previous` is the scar a rotation leaves, and the field an audit counts. An entry there says
   * a key was deliberately retired, so a foreign vault adding one would be recording a thing that
   * never happened -- and would make the account indistinguishable from the ten real ones.
   */
  it('never appends to previous[]', async () => {
    const { world, alice } = await openedElsewhere();
    await alice.messaging.publishKey();

    expect(stored(world, alice.uid)?.previous).toEqual([]);
  });

  /**
   * `watch()` publishes on every open, and `publishKey` retries twice within a single call, so
   * erosion would not show up in a one-shot test. This opens the account many times over.
   */
  it('holds however many times the account is opened', async () => {
    const { world, alice, before } = await openedElsewhere();
    for (let open = 0; open < 25; open++) {
      world.clock.advance(MINUTE_MS);
      await alice.messaging.publishKey();
    }

    expect(published(world, alice.uid)).toBe(before);
  });

  /** And it must go on refusing, rather than settling down once the reads stop being new. */
  it('still refuses to start a conversation after many opens', async () => {
    const { alice } = await openedElsewhere();
    for (let open = 0; open < 5; open++) await alice.messaging.publishKey();

    await expect(alice.messaging.startConversation(BOB)).rejects.toMatchObject({
      code: 'foreign-vault',
    });
  });

  /**
   * The other half of the rule, and what a too-eager gate would break: an account that has never
   * published anything still gets to publish. `World.join` is exactly that path.
   */
  it('still lets an account with no key publish its first one', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1);
    const identity = alice.identity;
    if (identity === null) throw new Error('alice has no identity');

    expect(stored(world, alice.uid)?.publicKey).toBe(base64Encode(identity.publicKey));
    expect(stored(world, alice.uid)?.previous).toEqual([]);
  });

  /** The ordinary re-open: the stored key is this vault's own, so nothing is written at all. */
  it('writes nothing when the stored key is the one this vault derived', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1);
    const before = published(world, alice.uid);

    world.clock.advance(HOUR_MS);
    await alice.messaging.publishKey();

    // Same bytes -- `updatedAt` in particular did not move with the clock.
    expect(published(world, alice.uid)).toBe(before);
  });
});

/**
 * The remedy, from the other end.
 *
 * `publishKey` refuses to make the account's key match this device. This makes this device hold
 * the account's key instead -- derived from the same backup passphrase that already unwraps the
 * account's photos. The published record is never touched, so there is no rotation, nothing is
 * retired, and the peer cannot tell the difference: they derive the conversation key from the
 * published key and their own secret, and both are exactly as they were.
 *
 * The whole value of it rests on one thing being true, so it is pinned hardest: NOTHING IS
 * WRITTEN. If any of these ever starts writing to `messagingKeys`, it has become the rotation
 * that stranded ten production accounts, wearing a friendlier name.
 */
describe('recovering an account\'s own messaging key', () => {
  /** Alice's account, open on a vault that did not set messaging up, with one old message. */
  async function stranded(): Promise<{ world: World; alice: Side; bob: Side; cid: string }> {
    const world = new World();
    const alice = await world.join(ALICE, 1);
    const bob = await world.join(BOB, 2);
    const cid = await alice.messaging.startConversation(BOB);
    await alice.messaging.send(cid, 'written under the original vault');
    await flush();

    alice.identity = deriveMessagingIdentity(masterKey(7));
    alice.messaging.forgetKeys();
    await alice.messaging.publishKey();
    return { world, alice, bob, cid };
  }

  async function bodies(side: Side, cid: string): Promise<(string | null)[]> {
    const thread = collect<ConversationState>((on) => side.messaging.watchConversation(cid, on));
    await flush();
    const seen = thread.last().messages.map((m) => m.body);
    thread.stop();
    return seen;
  }

  it('reads the account\'s own old messages again', async () => {
    const { alice, cid } = await stranded();
    expect(await bodies(alice, cid)).toEqual([null]);

    await expect(alice.messaging.useRecoveredMasterKey(masterKey(1))).resolves.toBe('ok');

    expect(await bodies(alice, cid)).toEqual(['written under the original vault']);
  });

  it('sends something the peer can actually open', async () => {
    const { alice, bob, cid } = await stranded();
    await alice.messaging.useRecoveredMasterKey(masterKey(1));

    await alice.messaging.send(cid, 'sent after recovering the key');
    await flush();

    bob.messaging.forgetKeys();
    // Sorted, not ordered: the fake clock does not advance between sends, so both messages
    // carry the same createdAt and their order is not the thing under test. That BOTH open
    // under the peer's unchanged view of the account is.
    expect([...(await bodies(bob, cid))].sort()).toEqual([
      'sent after recovering the key',
      'written under the original vault',
    ]);
  });

  it('unblocks the composer', async () => {
    const { alice, cid } = await stranded();
    const before = collect<ConversationState>((on) => alice.messaging.watchConversation(cid, on));
    await flush();
    expect(before.last().sendBlocked).toBe('foreign-vault');
    before.stop();

    await alice.messaging.useRecoveredMasterKey(masterKey(1));

    const after = collect<ConversationState>((on) => alice.messaging.watchConversation(cid, on));
    await flush();
    expect(after.last().sendBlocked).toBeNull();
    expect(after.last().canSend).toBe(true);
    after.stop();
  });

  /** The invariant the whole design exists to keep. */
  it('writes absolutely nothing to the published key', async () => {
    const { world, alice } = await stranded();
    const before = world.keyDoc(alice.uid);
    const put = jest.spyOn(alice.cloud, 'putDocument');

    await alice.messaging.useRecoveredMasterKey(masterKey(1));

    expect(put).not.toHaveBeenCalled();
    expect(world.keyDoc(alice.uid)).toEqual(before);
    expect(world.keyDoc(alice.uid).previous).toEqual([]);
    put.mockRestore();
  });

  /** And still nothing after it has been used to send, which is where a rotation would hide. */
  it('writes nothing to the published key even after sending', async () => {
    const { world, alice, cid } = await stranded();
    await alice.messaging.useRecoveredMasterKey(masterKey(1));
    const before = world.keyDoc(alice.uid);

    await alice.messaging.send(cid, 'after recovery');
    await alice.messaging.publishKey();
    await flush();

    expect(world.keyDoc(alice.uid)).toEqual(before);
    expect(world.keyDoc(alice.uid).previous).toEqual([]);
  });

  /**
   * A passphrase that opens the BACKUP but yields a different identity means a third vault set
   * this account's messaging up. Accepting it would leave a device that silently reads nothing.
   */
  it('refuses a key that is not the one this account published', async () => {
    const { world, alice, cid } = await stranded();
    const before = world.keyDoc(alice.uid);

    await expect(alice.messaging.useRecoveredMasterKey(masterKey(9))).resolves.toBe('mismatch');

    expect(await bodies(alice, cid)).toEqual([null]);
    expect(world.keyDoc(alice.uid)).toEqual(before);
  });

  it('is dropped when the vault locks, and never written down', async () => {
    const { alice, cid } = await stranded();
    await alice.messaging.useRecoveredMasterKey(masterKey(1));
    expect(await bodies(alice, cid)).toEqual(['written under the original vault']);

    // Exactly what the composition root does on lock.
    alice.messaging.forgetKeys();

    expect(await bodies(alice, cid)).toEqual([null]);
  });

  it('does not follow the user to another account', async () => {
    const { alice } = await stranded();
    await alice.messaging.useRecoveredMasterKey(masterKey(1));

    await alice.cloud.signOut();
    await alice.cloud.signUp('carol@example.test', PASSWORD);
    const seen = collect<MessagingState>((on) => alice.messaging.watch(on));
    await flush();

    // Carol's account is untouched by Alice's recovered key: it has its own identity, and the
    // vault's own derives it, so nothing is foreign and nothing was carried across.
    expect(seen.last().foreignVault).toBe(false);
    seen.stop();
  });

  it('says so rather than guessing when the account has published no key at all', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1);
    world.store.documents.delete(MESSAGING_PATHS.publicKey(alice.uid));

    await expect(alice.messaging.useRecoveredMasterKey(masterKey(1))).resolves.toBe('unavailable');
  });

  /**
   * And as UNREACHABLE rather than as the account having no key. A refused read says nothing
   * whatsoever about what the account has published, and the two want opposite things of the user:
   * wait and retry, or go and set messaging up.
   */
  it('reports a failed lookup as unreachable, not as a mismatch or a missing key', async () => {
    const { alice } = await stranded();
    const get = jest.spyOn(alice.cloud, 'getDocument').mockImplementation(async () => {
      throw new CloudError('unavailable');
    });

    await expect(alice.messaging.useRecoveredMasterKey(masterKey(1))).resolves.toBe('unreachable');
    get.mockRestore();
  });
});

/**
 * A vault holding a key THIS account published earlier.
 *
 * `peerKeyCandidates` has always walked `[publicKey, ...previous]` so a message sealed before a
 * PEER rotated still opens. The two places that asked the same question about this account --
 * `publishKey` and `useRecoveredMasterKey` -- looked only at `publicKey`, so a vault one rotation
 * behind was reported as a different vault entirely and the user was sent to recover a passphrase
 * that would hand back the key already in their hands.
 *
 * Recognising it is not the same as being recovered, and that distinction is the point of most of
 * what follows. The device holding the CURRENT key derives conversation keys from that key alone,
 * so anything sent from here would be invisible to it -- the user's own other device. So the old
 * key reads and does not send.
 */
describe('an earlier key of this same account', () => {
  /** Published K2 with K1 retired, while this device's vault still derives K1. */
  async function rotatedAway(): Promise<{
    world: World;
    alice: Side;
    bob: Side;
    cid: string;
    retired: string;
  }> {
    const world = new World();
    const alice = await world.join(ALICE, 1);
    const bob = await world.join(BOB, 2);
    const cid = await alice.messaging.startConversation(BOB);
    await bob.messaging.send(cid, 'sealed while K1 was current');
    await flush();

    const retired = world.keyDoc(alice.uid).publicKey;
    // The rotation production already contains: K2 current, K1 appended to `previous`.
    world.rotate(alice, 2);
    // ...but THIS device never moved on. Its vault still derives the retired key.
    alice.identity = deriveMessagingIdentity(masterKey(1));
    alice.messaging.forgetKeys();
    return { world, alice, bob, cid, retired };
  }

  it('is recognised as this account\u2019s own, not as a different vault', async () => {
    const { alice } = await rotatedAway();

    await expect(alice.messaging.useRecoveredMasterKey(masterKey(1))).resolves.toBe('historical');
  });

  /** The current key keeps behaving exactly as it did. */
  it('still accepts the key the account publishes now', async () => {
    const { alice } = await rotatedAway();

    await expect(alice.messaging.useRecoveredMasterKey(masterKey(2))).resolves.toBe('ok');
  });

  it('rejects a key that is neither current nor retired', async () => {
    const { alice } = await rotatedAway();

    await expect(alice.messaging.useRecoveredMasterKey(masterKey(9))).resolves.toBe('mismatch');
  });

  /**
   * THE PROOF THAT READING WORKS. Not "may open": the body sealed under the retired key is read
   * back here, on a device whose own vault cannot open it -- which is the situation recovery
   * exists for. The key arrives from the backup envelope, not from the session.
   */
  it('opens the messages sealed under it, on a device that could not before', async () => {
    const { alice, cid } = await rotatedAway();
    // A vault that is nobody's: the thread is there and every body is closed.
    alice.identity = deriveMessagingIdentity(masterKey(31));
    alice.messaging.forgetKeys();
    const thread = collect<ConversationState>((on) => alice.messaging.watchConversation(cid, on));
    await flush();
    expect(thread.last().messages[0]?.body).toBeNull();

    await expect(alice.messaging.useRecoveredMasterKey(masterKey(1))).resolves.toBe('historical');
    await flush();

    expect(thread.last().messages[0]?.body).toBe('sealed while K1 was current');
    thread.stop();
  });

  /** Recognised, and still not the account's identity. The two are reported apart. */
  it('does not report itself as fully recovered', async () => {
    const { alice } = await rotatedAway();
    const seen = collect<MessagingState>((on) => alice.messaging.watch(on));
    await flush();

    await alice.messaging.useRecoveredMasterKey(masterKey(1));
    await flush();

    expect(seen.last().historicalIdentity).toBe(true);
    expect(seen.last().foreignVault).toBe(false);
    seen.stop();
  });

  it('reports the current key as recovered, with no historical flag', async () => {
    const { alice } = await rotatedAway();
    const seen = collect<MessagingState>((on) => alice.messaging.watch(on));
    await flush();

    await alice.messaging.useRecoveredMasterKey(masterKey(2));
    await flush();

    expect(seen.last().historicalIdentity).toBe(false);
    expect(seen.last().foreignVault).toBe(false);
    seen.stop();
  });

  /**
   * Read-only, and for a concrete reason rather than caution: a message sealed with the retired
   * key would be derived by the device holding the current one from the CURRENT key, so that
   * device -- the user's own -- would never open it.
   */
  it('will not send, and says which key is missing', async () => {
    const { alice, cid } = await rotatedAway();
    await alice.messaging.useRecoveredMasterKey(masterKey(1));
    const thread = collect<ConversationState>((on) => alice.messaging.watchConversation(cid, on));
    await flush();

    expect(thread.last().canSend).toBe(false);
    expect(thread.last().sendBlocked).toBe('historical-identity');
    thread.stop();
  });

  /** Nothing is written, so the account's published identity is exactly as it was. */
  it('neither republishes the old key nor rotates anything', async () => {
    const { world, alice } = await rotatedAway();
    const before = structuredClone(world.store.documents.get(MESSAGING_PATHS.publicKey(alice.uid)));

    await alice.messaging.useRecoveredMasterKey(masterKey(1));
    await alice.messaging.publishKey();

    expect(world.store.documents.get(MESSAGING_PATHS.publicKey(alice.uid))).toEqual(before);
  });

  /** The other half of the asymmetry: the startup check reported the same thing wrongly. */
  it('is not called a foreign vault on unlock either', async () => {
    const { alice } = await rotatedAway();
    const seen = collect<MessagingState>((on) => alice.messaging.watch(on));
    await flush();

    await alice.messaging.publishKey();
    await flush();

    expect(seen.last().foreignVault).toBe(false);
    expect(seen.last().historicalIdentity).toBe(true);
    seen.stop();
  });

  /** And a vault belonging to nobody here is still refused, by both paths. */
  it('still refuses a vault whose key the account never published', async () => {
    const { alice } = await rotatedAway();
    alice.identity = deriveMessagingIdentity(masterKey(31));
    alice.messaging.forgetKeys();
    const seen = collect<MessagingState>((on) => alice.messaging.watch(on));
    await flush();

    await alice.messaging.publishKey();
    await flush();

    expect(seen.last().foreignVault).toBe(true);
    expect(seen.last().historicalIdentity).toBe(false);
    seen.stop();
  });

  /**
   * A history is only as good as what wrote it. These are the shapes a document NOT written by
   * this client can take, and none of them may turn into a match.
   */
  it('cannot be bypassed by a malformed history', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1);
    const mine = base64Encode(deriveMessagingIdentity(masterKey(1)).publicKey);
    const other = base64Encode(deriveMessagingIdentity(masterKey(2)).publicKey);
    const path = MESSAGING_PATHS.publicKey(alice.uid);

    for (const previous of [
      'not-a-list',
      [1, 2, 3],
      [null],
      [''],
      [{ publicKey: mine }],
      [[mine]],
    ]) {
      world.store.documents.set(path, {
        v: 1,
        uid: alice.uid,
        publicKey: other,
        previous,
        updatedAt: world.clock.now(),
      });
      alice.messaging.forgetKeys();
      await expect(alice.messaging.useRecoveredMasterKey(masterKey(1))).resolves.toBe('mismatch');
    }
  });

  /** An absent history is the ordinary shape for an account that never rotated. */
  it('treats a document with no history as having none', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1);
    world.store.documents.set(MESSAGING_PATHS.publicKey(alice.uid), {
      v: 1,
      uid: alice.uid,
      publicKey: base64Encode(deriveMessagingIdentity(masterKey(2)).publicKey),
      updatedAt: world.clock.now(),
    });
    alice.messaging.forgetKeys();

    await expect(alice.messaging.useRecoveredMasterKey(masterKey(1))).resolves.toBe('mismatch');
  });

  /** One account's history says nothing about another account's vault. */
  it('does not let one account\u2019s history vouch for another account', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1);
    const bob = await world.join(BOB, 2);
    world.rotate(alice, 3);

    // Bob's vault derives nothing alice published, and alice's retired key is not bob's to use.
    bob.identity = deriveMessagingIdentity(masterKey(1));
    bob.messaging.forgetKeys();

    await expect(bob.messaging.useRecoveredMasterKey(masterKey(1))).resolves.toBe('mismatch');
  });
});
