/**
 * One device, two accounts, one vault.
 *
 * The scenario is a person signing out of one backup account and into another on the same phone,
 * without ever locking the vault. `MessagingService` is a singleton that outlives both, so every
 * cache it holds has to be told that the account underneath it changed. Before the fix it was not:
 * the first emission handed the new account the previous one's conversation list and contact
 * names, because `watch` emits synchronously from cache before its listeners attach.
 *
 * The vault is deliberately the SAME on both sides -- one device, one master key -- which is the
 * worst case, since the messaging identity derives from the master key alone and therefore cannot
 * tell the two accounts apart. Nothing here may depend on the key differing.
 *
 * The correspondent is a real account on its own backend, sharing the one store. That is what
 * makes a snapshot a snapshot: writing through a backend notifies live listeners, where writing
 * into the store behind them does not, and a test that quietly skipped the notification would
 * assert nothing about listeners at all.
 */
import { EntitlementsController } from '@/billing/entitlementsController';
import { SequentialRandom } from '@/crypto/random';
import { MASTER_KEY_LENGTH } from '@/crypto/types';
import { InMemoryCloudBackend, InMemoryCloudStore } from '@/firebase/cloudBackend';
import { InMemoryDirectory } from '@/messaging/directory';
import { HiddenMessages } from '@/messaging/hiddenMessages';
import { deriveMessagingIdentity, type MessagingIdentity } from '@/messaging/identity';
import { conversationIdFor, conversationRecord } from '@/messaging/messaging';
import {
  MessagingService,
  type ConversationState,
  type MessagingState,
} from '@/messaging/messagingService';
import { InMemorySecureStore } from '@/secure-storage/secureStore';
import { InMemoryFileSystem } from '@/storage/inMemoryFileSystem';
import { FakeClock } from '@/utils/clock';
import type { CollectionEntry, CollectionQuery, CloudError } from '@/firebase/types';

const PASSWORD = 'account-password';
const A = 'a@example.test';
const B = 'b@example.test';
const A_PEER = 'peer-of-a@example.test';
const B_PEER = 'peer-of-b@example.test';

function masterKey(seed: number): Uint8Array {
  const bytes = new Uint8Array(MASTER_KEY_LENGTH);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (seed + i * 11) & 0xff;
  return bytes;
}

/** Lets every pending microtask run: naming a peer is two awaits deep. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/** Collects every state a watcher is given, oldest first. */
function collect<T>(subscribe: (onChange: (state: T) => void) => () => void): {
  states: T[];
  first: () => T;
  last: () => T;
  stop: () => void;
} {
  const states: T[] = [];
  const stop = subscribe((state) => states.push(state));
  return {
    states,
    first: () => states[0] as T,
    last: () => states[states.length - 1] as T,
    stop,
  };
}

/**
 * One phone: one cloud session that can sign out and in again, one vault, one MessagingService.
 * That last part is the point -- a second account must not be given a second service to be safe.
 */
class Device {
  readonly store = new InMemoryCloudStore();

  readonly clock = new FakeClock();

  readonly fs = new InMemoryFileSystem();

  /** e-mail -> uid, exactly what the deployed lookup callable answers with. */
  readonly accounts = new Map<string, string>();

  readonly cloud: InMemoryCloudBackend;

  /** Somebody else's phone, so a conversation can change while this one is signed in elsewhere. */
  readonly peerCloud: InMemoryCloudBackend;

  readonly directory: InMemoryDirectory;

  readonly messaging: MessagingService;

  identity: MessagingIdentity | null = deriveMessagingIdentity(masterKey(1));

  constructor() {
    this.cloud = new InMemoryCloudBackend(this.fs, this.store);
    this.peerCloud = new InMemoryCloudBackend(new InMemoryFileSystem(), this.store);
    const entitlements = new EntitlementsController({
      secureStore: new InMemorySecureStore(),
      clock: this.clock,
      cloud: this.cloud,
      // Pro is not what is under test, and leaving it enforced would make every assertion about
      // the conversation list depend on the billing mirror as well.
      enforced: false,
    });
    // The reverse-lookup gate is left OPEN on purpose. The deployed directory refuses to name a
    // uid you share no conversation with, so in production that ALSO stops the previous account's
    // peers from being named. Opening it here removes that second line of defence, so what is
    // asserted below is the client-side guard on its own.
    this.directory = new InMemoryDirectory(
      this.accounts,
      () => true,
      () => true,
    );
    this.messaging = new MessagingService({
      cloud: this.cloud,
      directory: this.directory,
      entitlements,
      clock: this.clock,
      random: new SequentialRandom(1),
      identity: () => this.identity,
      hidden: new HiddenMessages(new InMemorySecureStore()),
    });
  }

  async signIn(email: string): Promise<string> {
    const user = this.accounts.has(email)
      ? await this.cloud.signIn(email, PASSWORD)
      : await this.cloud.signUp(email, PASSWORD);
    this.accounts.set(email, user.uid);
    return user.uid;
  }

  /** Brings a correspondent into being on their own device. */
  async joinPeer(email: string): Promise<string> {
    const user = this.accounts.has(email)
      ? await this.peerCloud.signIn(email, PASSWORD)
      : await this.peerCloud.signUp(email, PASSWORD);
    this.accounts.set(email, user.uid);
    return user.uid;
  }

  /**
   * Writes the conversation THROUGH the peer's backend, so every live listener is notified the
   * way a real snapshot would notify them.
   */
  async peerWritesConversation(uid: string, peerUid: string): Promise<string> {
    const cid = conversationIdFor(uid, peerUid);
    await this.peerCloud.putDocument(
      `conversations/${cid}`,
      conversationRecord([uid, peerUid], peerUid, this.clock.now()),
    );
    return cid;
  }
}

/** Signs A in, gives it one conversation, and lets the row and the contact name settle. */
async function accountAWithOneConversation(): Promise<{
  device: Device;
  aUid: string;
  aPeerUid: string;
  cid: string;
}> {
  const device = new Device();
  const aUid = await device.signIn(A);
  const aPeerUid = await device.joinPeer(A_PEER);
  const cid = await device.peerWritesConversation(aUid, aPeerUid);
  const watcher = collect<MessagingState>((on) => device.messaging.watch(on));
  await flush();
  // A really did end up with the row and the name, or nothing below proves anything.
  expect(watcher.last().conversations).toHaveLength(1);
  expect(watcher.last().conversations[0]?.label).toBe(A_PEER);
  expect(watcher.last().loaded).toBe(true);
  watcher.stop();
  return { device, aUid, aPeerUid, cid };
}

describe('signing out of one account and into another on the same device', () => {
  it('never hands account B the conversations of account A', async () => {
    const { device } = await accountAWithOneConversation();

    await device.cloud.signOut();
    await device.signIn(B);

    const watcher = collect<MessagingState>((on) => device.messaging.watch(on));
    // The FIRST emission is the one that leaked: synchronous, straight out of the cache, on the
    // screen before any listener had answered for the new account.
    expect(watcher.first().conversations).toEqual([]);
    await flush();
    expect(watcher.last().conversations).toEqual([]);
    watcher.stop();
  });

  it('never hands account B the contact labels of account A', async () => {
    const { device } = await accountAWithOneConversation();

    await device.cloud.signOut();
    await device.signIn(B);

    const watcher = collect<MessagingState>((on) => device.messaging.watch(on));
    await flush();
    // Not one state, at any point, may carry a name A gave somebody.
    for (const state of watcher.states) {
      for (const conversation of state.conversations) {
        expect(conversation.label).not.toBe(A_PEER);
      }
    }
    watcher.stop();
  });

  it('does not report B as loaded until B has its own answer', async () => {
    const { device } = await accountAWithOneConversation();

    await device.cloud.signOut();
    await device.signIn(B);

    const watcher = collect<MessagingState>((on) => device.messaging.watch(on));
    // Carrying A's `loaded` across is what made the stale rows look like settled data rather than
    // a list still arriving, so the screen had no reason to show anything else.
    expect(watcher.first().loaded).toBe(false);
    expect(watcher.first().signedIn).toBe(true);
    watcher.stop();
  });

  it('clears the list on sign-out alone, with nobody signed in', async () => {
    const { device } = await accountAWithOneConversation();

    await device.cloud.signOut();

    const watcher = collect<MessagingState>((on) => device.messaging.watch(on));
    expect(watcher.first().signedIn).toBe(false);
    expect(watcher.first().conversations).toEqual([]);
    watcher.stop();
  });

  /**
   * The guard that is easiest to drop and hardest to notice. A listener belongs to the account
   * that opened it, and signing out does not unmount the screen holding it, so it stays attached
   * and keeps answering for the old uid while a different account is signed in.
   */
  it('ignores a snapshot that arrives for the account that signed out', async () => {
    const { device, aUid, aPeerUid } = await accountAWithOneConversation();

    // A's screen is still mounted: its listener stays live across the whole switch.
    const stale = collect<MessagingState>((on) => device.messaging.watch(on));
    await flush();
    expect(stale.last().conversations).toHaveLength(1);

    await device.cloud.signOut();
    await device.signIn(B);

    const fresh = collect<MessagingState>((on) => device.messaging.watch(on));
    await flush();
    expect(fresh.last().conversations).toEqual([]);

    // The correspondent sends something, so A's listener really does fire with A's conversation.
    const staleStatesBefore = stale.states.length;
    await device.peerWritesConversation(aUid, aPeerUid);
    await flush();

    // A's watcher is handed NOTHING: the guard returns before `emit`, so the callback belonging
    // to the signed-out account is never called again. Asserting this on `stale` rather than on
    // the cache is what makes it decisive -- B's listener fires on the same notification and
    // would overwrite the evidence a moment later, hiding the leak behind a lucky ordering.
    expect(stale.states.length).toBe(staleStatesBefore);

    // And B sees none of it, now or on a fresh subscribe.
    expect(fresh.last().conversations).toEqual([]);
    const latest = collect<MessagingState>((on) => device.messaging.watch(on));
    expect(latest.first().conversations).toEqual([]);
    latest.stop();
    fresh.stop();
    stale.stop();
  });

  /**
   * Ordering independence, which is the part of V3 that is worth keeping.
   *
   * The contacts snapshot can land before the conversations one, and `nameUnknownPeers` runs off
   * both. Held that way, the old code would have been looking at the previous account's
   * conversation list while filing names under the new account.
   *
   * Honest about what this does and does not show: it did NOT reproduce a leak before the fix,
   * because `namedPeers` still held A's peer and skipped it, and the deployed directory refuses
   * to name a uid you share no conversation with. It pins the invariant rather than a bug.
   */
  it('files nothing under B when the contacts snapshot lands first', async () => {
    const { device, aPeerUid } = await accountAWithOneConversation();
    const lookupsAsA = device.directory.reverseLookups.length;

    await device.cloud.signOut();
    const bUid = await device.signIn(B);

    // Hold the conversations snapshot back so the contacts one is delivered on its own.
    const realWatch = device.cloud.watchCollection.bind(device.cloud);
    // A holder rather than a bare `let`: the assignment happens inside the callback below, which
    // control-flow analysis cannot see, so a plain variable stays narrowed to `null` and the call
    // at the end does not typecheck.
    const deferred: { release: (() => void) | null } = { release: null };
    const spy = jest
      .spyOn(device.cloud, 'watchCollection')
      .mockImplementation(
        (
          path: string,
          query: CollectionQuery,
          onChange: (entries: CollectionEntry[]) => void,
          onError?: (error: CloudError) => void,
        ) => {
          if (path !== 'conversations') return realWatch(path, query, onChange, onError);
          return realWatch(
            path,
            query,
            (entries) => {
              deferred.release = (): void => {
                onChange(entries);
              };
            },
            onError,
          );
        },
      );

    const watcher = collect<MessagingState>((on) => device.messaging.watch(on));
    await flush();
    // Contacts have been processed; conversations have not.
    expect(device.directory.reverseLookups.length).toBe(lookupsAsA);
    expect(device.store.documents.has(`users/${bUid}/contacts/${aPeerUid}`)).toBe(false);

    deferred.release?.();
    await flush();
    expect(device.directory.reverseLookups.length).toBe(lookupsAsA);
    expect(device.store.documents.has(`users/${bUid}/contacts/${aPeerUid}`)).toBe(false);

    watcher.stop();
    spy.mockRestore();
  });

  it('refuses to open a conversation of A’s, and subscribes to nothing', async () => {
    const { device, cid } = await accountAWithOneConversation();

    await device.cloud.signOut();
    await device.signIn(B);

    const watchCollection = jest.spyOn(device.cloud, 'watchCollection');
    const watcher = collect<ConversationState>((on) =>
      device.messaging.watchConversation(cid, on),
    );
    await flush();

    expect(watcher.last().problem).toBe('unavailable');
    expect(watcher.last().messages).toEqual([]);
    expect(watcher.last().label).toBeNull();
    // The refusal has to come BEFORE the listener, or the thread would be read out of the
    // Firestore cache on disk, where no security rule is ever evaluated.
    expect(watchCollection).not.toHaveBeenCalled();
    watcher.stop();
    watchCollection.mockRestore();
  });

  it('gives B its own conversations, which is the point of not simply blanking the screen', async () => {
    const { device } = await accountAWithOneConversation();

    await device.cloud.signOut();
    const bUid = await device.signIn(B);
    const bPeerUid = await device.joinPeer(B_PEER);
    const bCid = await device.peerWritesConversation(bUid, bPeerUid);

    const watcher = collect<MessagingState>((on) => device.messaging.watch(on));
    await flush();

    expect(watcher.last().conversations.map((c) => c.id)).toEqual([bCid]);
    expect(watcher.last().conversations[0]?.label).toBe(B_PEER);
    expect(watcher.last().loaded).toBe(true);
    watcher.stop();
  });

  it('still keeps the list when the SAME account merely locks', async () => {
    const { device } = await accountAWithOneConversation();

    // Locking is a different event from an account change and must keep the list readable --
    // only the keys and the names go, because reading those needs the vault open.
    device.messaging.forgetKeys();
    const watcher = collect<MessagingState>((on) => device.messaging.watch(on));
    expect(watcher.first().conversations).toHaveLength(1);
    expect(watcher.first().conversations[0]?.label).toBeNull();
    watcher.stop();
  });
});
