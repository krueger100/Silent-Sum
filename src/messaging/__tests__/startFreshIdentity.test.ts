/**
 * The way back for an account whose messaging vault is gone.
 *
 * `publishKey` refuses to replace a key this vault did not derive, and that refusal is right:
 * done automatically it hands the account's identity to whichever vault opened Messages last,
 * which is how ten production accounts were quietly broken. But it assumes a remedy exists --
 * "recover the vault that set this up" -- and sometimes none does. An account found in
 * production had published a key from a vault it no longer has, with NO `previous` history and
 * no escrow, because the escrow rules went live after the damage. Moving vault ownership
 * rewrote its backup envelope, so the recovery passphrase yields a different key, recovery
 * correctly reports a mismatch, and the panel said "Nothing was changed" and stopped.
 *
 * The account was then locked out of MESSAGING, not merely out of its old threads: `canSend` is
 * false while `foreignVault` holds, and only recovering a key that exists nowhere could clear
 * it. `startFreshIdentity` is the write `publishKey` refuses, made deliberately instead of
 * silently.
 *
 * What is pinned here is both halves of that bargain. It must work -- the account sends again.
 * And it must cost exactly what it claims and nothing more: the old messages stay shut, the old
 * key is retired rather than erased, every earlier key survives, the vault still holding the old
 * one degrades to `historical` rather than `foreign`, and `publishKey` is left as strict as it
 * was. A rotation that quietly dropped history would reintroduce the original bug through the
 * door built to escape it.
 */
import { BILLING_PATHS, FREE_ENTITLEMENTS, entitlementsToJson } from '@/billing/entitlements';
import { EntitlementsController } from '@/billing/entitlementsController';
import { SequentialRandom } from '@/crypto/random';
import { MASTER_KEY_LENGTH } from '@/crypto/types';
import { InMemoryCloudBackend, InMemoryCloudStore } from '@/firebase/cloudBackend';
import { CloudError } from '@/firebase/types';
import { InMemoryDirectory } from '@/messaging/directory';
import { HiddenMessages } from '@/messaging/hiddenMessages';
import { deriveMessagingIdentity, type MessagingIdentity } from '@/messaging/identity';
import {
  MAX_PUBLISHED_KEY_HISTORY,
  MESSAGING_PATHS,
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
   * The situation this whole feature exists for: the vault behind the published key is gone.
   *
   * Swapping the identity the service derives from, WITHOUT touching `messagingKeys`, is exactly
   * what a user sees after moving vault ownership -- the account still publishes the old key and
   * nothing on the device can produce it.
   */
  loseTheVault(side: Side, seed: number): void {
    side.identity = deriveMessagingIdentity(masterKey(seed));
    side.messaging.forgetKeys();
  }

  /** A rotation that already happened, written the way an older client left it. */
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
    const parsed = parsePublishedKey(
      uid,
      this.store.documents.get(MESSAGING_PATHS.publicKey(uid)) ?? null,
    );
    if (parsed === null) throw new Error('no published key');
    return { publicKey: parsed.publicKey, previous: parsed.previous };
  }
}

const derivedKey = (side: Side): string => {
  const identity = side.identity;
  if (identity === null) throw new Error('no identity');
  return base64Encode(identity.publicKey);
};

describe('starting fresh when the vault behind a published key is gone', () => {
  it('writes nothing when the account already uses this vault', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1);
    const before = world.keyDoc(alice.uid);

    const put = jest.spyOn(alice.cloud, 'putDocument');
    await expect(alice.messaging.startFreshIdentity()).resolves.toBe('not-needed');

    expect(put).not.toHaveBeenCalled();
    expect(world.keyDoc(alice.uid)).toEqual(before);
    put.mockRestore();
  });

  it('adopts this vault and retires the unreachable key', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1);
    const stranded = world.keyDoc(alice.uid).publicKey;

    world.loseTheVault(alice, 7);
    await expect(alice.messaging.startFreshIdentity()).resolves.toBe('ok');

    expect(world.keyDoc(alice.uid)).toEqual({
      publicKey: derivedKey(alice),
      previous: [stranded],
    });
  });

  /** The point of the whole thing: the account can use messaging again. */
  it('lets the account send again', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1);
    const bob = await world.join(BOB, 2);
    const cid = await alice.messaging.startConversation(BOB);

    world.loseTheVault(alice, 7);
    await alice.messaging.publishKey();
    const locked = collect<ConversationState>((on) =>
      alice.messaging.watchConversation(cid, on),
    );
    await flush();
    expect(locked.last().canSend).toBe(false);
    locked.stop();

    await expect(alice.messaging.startFreshIdentity()).resolves.toBe('ok');
    const freed = collect<ConversationState>((on) => alice.messaging.watchConversation(cid, on));
    await flush();

    expect(freed.last().canSend).toBe(true);
    world.clock.advance(1000);
    await expect(alice.messaging.send(cid, 'after starting fresh')).resolves.not.toThrow();
    freed.stop();

    const thread = collect<ConversationState>((on) => bob.messaging.watchConversation(cid, on));
    await flush();
    expect(thread.last().messages.map((m) => m.body)).toContain('after starting fresh');
    thread.stop();
  });

  it('clears the foreign-vault banner', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1);

    world.loseTheVault(alice, 7);
    await alice.messaging.publishKey();
    const seen = collect<MessagingState>((on) => alice.messaging.watch(on));
    await flush();
    expect(seen.last().foreignVault).toBe(true);

    await alice.messaging.startFreshIdentity();
    await flush();

    expect(seen.last().foreignVault).toBe(false);
    expect(seen.last().historicalIdentity).toBe(false);
    seen.stop();
  });

  /**
   * THE COST, stated as a test so nobody can claim the feature recovers anything.
   *
   * The message was sealed under the old key and the private half went with the vault. Starting
   * fresh does not lose it -- it was lost already -- and this pins that the difference is only
   * ever "locked out of everything" versus "locked out of the old".
   */
  it('does not bring back messages sealed under the retired key', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1);
    await world.join(BOB, 2);
    const cid = await alice.messaging.startConversation(BOB);
    await alice.messaging.send(cid, 'sealed under the old identity');
    await flush();

    world.loseTheVault(alice, 7);
    await alice.messaging.startFreshIdentity();
    const thread = collect<ConversationState>((on) =>
      alice.messaging.watchConversation(cid, on),
    );
    await flush();

    expect(thread.last().messages.map((m) => m.body)).not.toContain(
      'sealed under the old identity',
    );
    thread.stop();
  });

  /**
   * THE REPLY BUG, reproduced.
   *
   * Found on a live account minutes after the first real rotation: everything this account SENT
   * appeared normally, and every reply came back "This message could not be opened on this
   * device". The conversation had been created five minutes AFTER the rotation, so the peer had
   * every chance to read the new key.
   *
   * It never read it. `peerKeys` is populated on first use and cleared only by `forgetKeys` --
   * a vault lock or an account change. Nothing refreshes it, nothing expires it, and nothing
   * invalidates it when a message fails to open. So a peer whose vault has been unlocked since
   * before the rotation goes on sealing to the retired key, and `peerKey` keeps returning it
   * while its own comment promises "whatever this peer publishes now".
   *
   * Every message sent in that window is unreadable FOR GOOD -- the recipient never had the
   * private half -- and neither side is told. That is the same silent permanent loss the rest of
   * this area exists to prevent, and `startFreshIdentity` is what makes it reachable on purpose.
   */
  it('lets a peer whose vault never locked go on replying', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1);
    const bob = await world.join(BOB, 2);
    const cid = await alice.messaging.startConversation(BOB);

    // Bob sends once BEFORE the rotation, which is all it takes to warm his cache of Alice's key.
    await bob.messaging.send(cid, 'before the rotation');
    await flush();

    world.loseTheVault(alice, 7);
    await expect(alice.messaging.startFreshIdentity()).resolves.toBe('ok');

    // Bob's vault never locks, so nothing clears what he cached.
    world.clock.advance(1000);
    await bob.messaging.send(cid, 'a reply after the rotation');
    await flush();

    const thread = collect<ConversationState>((on) =>
      alice.messaging.watchConversation(cid, on),
    );
    await flush();

    expect(thread.last().messages.map((m) => m.body)).toContain('a reply after the rotation');
    thread.stop();
  });

  /**
   * THE REPLY BUG, other direction.
   *
   * `conversationKey` re-reads before sealing, so this device never writes to a retired key. But
   * the keys it OPENS with come from the same cache, filled once and cleared only by a vault
   * lock -- so when the PEER rotates, their new messages arrive sealed under a key this device
   * has never heard of, and read as "could not be opened" until the vault happens to lock.
   */
  it('opens a message from a peer who rotated while the thread was open', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1);
    const bob = await world.join(BOB, 2);
    const cid = await alice.messaging.startConversation(BOB);

    await bob.messaging.send(cid, 'before bob rotated');
    await flush();
    // Alice reads the thread, which is what fills her cache of Bob's key.
    const thread = collect<ConversationState>((on) =>
      alice.messaging.watchConversation(cid, on),
    );
    await flush();
    expect(thread.last().messages.map((m) => m.body)).toEqual(['before bob rotated']);

    // Bob changes vault. Alice's vault never locks, so nothing clears what she cached.
    world.rotate(bob, 7);
    world.clock.advance(1000);
    await bob.messaging.send(cid, 'after bob rotated');
    await flush();
    await flush();

    expect(thread.last().messages.map((m) => m.body)).toEqual([
      'before bob rotated',
      'after bob rotated',
    ]);
    thread.stop();
  });

  /**
   * THE TRAP IN THAT FIX, pinned so it cannot come back.
   *
   * A plain retry-on-failure would be a permanent read loop here. After starting fresh this
   * account holds messages that NO key will ever open -- that is the deliberate cost -- and each
   * emit would see them fail and re-read the peer's keys again, for ever, for nothing.
   *
   * So the refresh is spent per message id, once. A thread full of permanently dead messages
   * must cost a bounded number of reads no matter how many times it emits.
   */
  it('does not re-read the peer key for ever over messages that can never open', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1);
    await world.join(BOB, 2);
    const cid = await alice.messaging.startConversation(BOB);
    await alice.messaging.send(cid, 'sealed under the identity about to be retired');
    await flush();

    world.loseTheVault(alice, 7);
    await alice.messaging.startFreshIdentity();

    const bobKeyPath = MESSAGING_PATHS.publicKey(world.accounts.get(BOB) as string);
    const get = jest.spyOn(alice.cloud, 'getDocument');
    const thread = collect<ConversationState>((on) =>
      alice.messaging.watchConversation(cid, on),
    );
    // Several emits over the same dead message: hiding something, and plenty of turns.
    for (let i = 0; i < 10; i++) await flush();

    const reads = get.mock.calls.filter(([path]) => path === bobKeyPath).length;
    expect(thread.last().messages.map((m) => m.body)).toEqual([null]);
    expect(reads).toBeLessThanOrEqual(2);
    get.mockRestore();
    thread.stop();
  });

  /**
   * What makes this survivable from the other side. A device that still holds the old vault is
   * one rotation behind, not a stranger: `previous` says so, and the service reads it as
   * `historical` -- keeping its threads and losing only the ability to send.
   */
  it('leaves a device still holding the old vault reading as historical, not foreign', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1);
    const oldIdentity = alice.identity;

    world.loseTheVault(alice, 7);
    await alice.messaging.startFreshIdentity();

    // The other device, unchanged, unlocking afterwards.
    alice.identity = oldIdentity;
    alice.messaging.forgetKeys();
    await alice.messaging.publishKey();
    const seen = collect<MessagingState>((on) => alice.messaging.watch(on));
    await flush();

    expect(seen.last().historicalIdentity).toBe(true);
    expect(seen.last().foreignVault).toBe(false);
    seen.stop();
  });

  it('keeps every key already retired', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1);
    const first = world.keyDoc(alice.uid).publicKey;
    world.rotate(alice, 5);
    const second = world.keyDoc(alice.uid).publicKey;

    world.loseTheVault(alice, 9);
    await expect(alice.messaging.startFreshIdentity()).resolves.toBe('ok');

    expect(world.keyDoc(alice.uid)).toEqual({
      publicKey: derivedKey(alice),
      previous: [first, second],
    });
  });

  it('refuses rather than rotate on a read it could not make', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1);
    const before = world.keyDoc(alice.uid);
    world.loseTheVault(alice, 7);

    const get = jest
      .spyOn(alice.cloud, 'getDocument')
      .mockRejectedValue(new CloudError('unavailable', 'no'));
    const put = jest.spyOn(alice.cloud, 'putDocument');
    await expect(alice.messaging.startFreshIdentity()).resolves.toBe('unreachable');

    expect(put).not.toHaveBeenCalled();
    get.mockRestore();
    put.mockRestore();
    expect(world.keyDoc(alice.uid)).toEqual(before);
  });

  /** The rules refusing a stale append: two devices rotating at once, the loser a key behind. */
  it('reports a refused write and leaves the document alone', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1);
    const before = world.keyDoc(alice.uid);
    world.loseTheVault(alice, 7);

    const put = jest
      .spyOn(alice.cloud, 'putDocument')
      .mockRejectedValue(new CloudError('permission-denied', 'no'));
    await expect(alice.messaging.startFreshIdentity()).resolves.toBe('raced');

    put.mockRestore();
    expect(world.keyDoc(alice.uid)).toEqual(before);
  });

  /**
   * At the cap the rules refuse the append, which would drop a key if the client tried to make
   * room. Failing before the write is the safe direction, and it can say why.
   */
  it('refuses once the history is full rather than dropping a key', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1);
    const current = world.keyDoc(alice.uid).publicKey;
    const full = Array.from({ length: MAX_PUBLISHED_KEY_HISTORY }, (_unused, i) => `retired-${i}`);
    world.store.documents.set(MESSAGING_PATHS.publicKey(alice.uid), {
      v: 1,
      uid: alice.uid,
      publicKey: current,
      previous: full,
      updatedAt: world.clock.now(),
    });

    world.loseTheVault(alice, 7);
    const put = jest.spyOn(alice.cloud, 'putDocument');
    await expect(alice.messaging.startFreshIdentity()).resolves.toBe('history-full');

    expect(put).not.toHaveBeenCalled();
    expect(world.keyDoc(alice.uid).previous).toEqual(full);
    put.mockRestore();
  });

  /**
   * A recovered identity means the account's real key is in hand, so there is nothing broken to
   * repair -- and republishing it would retire the very key the user just got back.
   */
  it('will not rotate while the account’s own identity has been recovered', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1);
    const before = world.keyDoc(alice.uid);
    const real = masterKey(1);

    world.loseTheVault(alice, 7);
    await expect(alice.messaging.useRecoveredMasterKey(real)).resolves.toBe('ok');

    const put = jest.spyOn(alice.cloud, 'putDocument');
    await expect(alice.messaging.startFreshIdentity()).resolves.toBe('not-needed');

    expect(put).not.toHaveBeenCalled();
    expect(world.keyDoc(alice.uid)).toEqual(before);
    put.mockRestore();
  });

  /**
   * The guard on the guard. This feature is a deliberate, confirmed, user-initiated write; it
   * must not have made the AUTOMATIC path any softer. `publishKey` runs on every unlock, and a
   * `publishKey` that rotated would be the original ten-account bug, restored.
   */
  it('leaves publishKey as strict as it was', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1);
    const before = world.keyDoc(alice.uid);

    world.loseTheVault(alice, 7);
    const put = jest.spyOn(alice.cloud, 'putDocument');
    await alice.messaging.publishKey();
    await alice.messaging.publishKey();

    expect(put).not.toHaveBeenCalled();
    expect(world.keyDoc(alice.uid)).toEqual(before);
    put.mockRestore();
  });
});
