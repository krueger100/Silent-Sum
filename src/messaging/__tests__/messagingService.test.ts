/**
 * Two accounts, one database.
 *
 * Each side gets its own `InMemoryCloudBackend` over a shared `InMemoryCloudStore`, which is as
 * close to two phones as a unit test gets: separate sessions, separate authorisation, one set of
 * documents, and listeners that really do fire across the divide.
 */
import {
  BILLING_PATHS,
  FREE_ENTITLEMENTS,
  FREE_TIER,
  entitlementsToJson,
} from '@/billing/entitlements';
import { EntitlementsController } from '@/billing/entitlementsController';
import { SequentialRandom } from '@/crypto/random';
import { MASTER_KEY_LENGTH } from '@/crypto/types';
import { InMemoryCloudBackend, InMemoryCloudStore } from '@/firebase/cloudBackend';
import { InMemorySecureStore } from '@/secure-storage/secureStore';
import { InMemoryConversationAdmin } from '@/messaging/conversationAdmin';
import { InMemoryDirectory } from '@/messaging/directory';
import { MAX_PHOTO_BYTES, MAX_THUMB_BYTES } from '@/messaging/media';
import type { TransferState } from '@/messaging/mediaProgress';
import { HiddenMessages } from '@/messaging/hiddenMessages';
import { deriveMessagingIdentity, type MessagingIdentity } from '@/messaging/identity';
import {
  MESSAGING_PATHS,
  conversationIdFor,
  type DecryptedMessage,
} from '@/messaging/messaging';
import {
  MessagingError,
  MessagingService,
  type ConversationState,
  type MessagingState,
} from '@/messaging/messagingService';
import { InMemoryFileSystem } from '@/storage/inMemoryFileSystem';
import { SecureDelete } from '@/storage/secureDelete';
import { PlaybackScratch } from '@/vault/playbackScratch';
import { FakeThumbnailGenerator } from '@/vault/thumbnailGenerator';
import { FakeVideoThumbnailGenerator } from '@/vault/videoThumbnailGenerator';
import type {
  AddPhotoOptions,
  ImageInput,
  PhotoEntry,
  VideoInput,
} from '@/vault/types';
import { FakeClock } from '@/utils/clock';

const ALICE = 'alice@example.test';
const BOB = 'bob@example.test';
const PASSWORD = 'account-password';

function masterKey(seed: number): Uint8Array {
  const bytes = new Uint8Array(MASTER_KEY_LENGTH);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (seed + i * 11) & 0xff;
  return bytes;
}

interface Side {
  readonly cloud: InMemoryCloudBackend;
  readonly entitlements: EntitlementsController;
  readonly messaging: MessagingService;
  readonly directory: InMemoryDirectory;
  readonly fs: InMemoryFileSystem;
  readonly thumbnails: FakeThumbnailGenerator;
  readonly videoThumbnails: FakeVideoThumbnailGenerator;
  identity: MessagingIdentity | null;
  uid: string;
}

class World {
  readonly store = new InMemoryCloudStore();
  readonly clock = new FakeClock();
  /** e-mail -> uid, exactly what the deployed lookup callable answers with. */
  readonly accounts = new Map<string, string>();

  async join(email: string, seed: number, options: { pro: boolean }): Promise<Side> {
    // Each side gets its own device: its own filesystem and scratch space, sharing only the
    // database. That is what makes "the other side can open it" a real assertion rather than one
    // device reading back what it just wrote.
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
      fs,
      thumbnails: undefined as unknown as FakeThumbnailGenerator,
      videoThumbnails: undefined as unknown as FakeVideoThumbnailGenerator,
      entitlements,
      directory: new InMemoryDirectory(
        this.accounts,
        () => entitlements.isPro(),
        // The reverse lookup's whole gate is membership, so the fake checks the conversations
        // that actually exist rather than waving it through.
        (peerUid) =>
          this.store.documents.has(`conversations/${[user.uid, peerUid].sort().join('__')}`),
      ),
      identity: deriveMessagingIdentity(masterKey(seed)),
      uid: user.uid,
      messaging: undefined as unknown as MessagingService,
    };
    const secureDelete = new SecureDelete(fs);
    const random = new SequentialRandom(seed);
    const thumbnails = new FakeThumbnailGenerator();
    const videoThumbnails = new FakeVideoThumbnailGenerator();
    Object.assign(side, {
      fs,
      thumbnails,
      videoThumbnails,
      messaging: new MessagingService({
        cloud,
        directory: side.directory,
        entitlements,
        clock: this.clock,
        random,
        identity: () => side.identity,
        // One per side, like the filesystem above: "delete for me" is a property of a device, so
        // a shared store would make the two sides wrongly agree about what is hidden.
        hidden: new HiddenMessages(new InMemorySecureStore()),
        // Stands in for the callable. It purges through the backend rather than the raw maps so
        // that both sides' open listeners fire, which is the behaviour under test.
        conversationAdmin: new InMemoryConversationAdmin(
          () => side.uid,
          async (cid) => {
            for (const path of [...this.store.documents.keys()]) {
              if (path === `conversations/${cid}` || path.startsWith(`conversations/${cid}/`)) {
                await cloud.deleteDocument(path);
              }
            }
            for (const key of [...this.store.blobs.keys()]) {
              if (key.startsWith(`messages/${cid}/`)) await cloud.deleteBlob(key);
            }
            for (const uid of cid.split('__')) {
              const peer = cid.split('__').find((u) => u !== uid);
              this.store.documents.delete(`users/${uid}/contacts/${peer ?? ''}`);
            }
          },
        ),
        media: {
          fs,
          secureDelete,
          thumbnails,
          videoThumbnails,
          scratch: new PlaybackScratch({ fs, secureDelete, random }),
        },
      }),
    });
    if (options.pro) this.grantPro(user.uid);
    await entitlements.refresh();
    await side.messaging.publishKey();
    return side;
  }

  grantPro(uid: string): void {
    this.store.documents.set(
      BILLING_PATHS.entitlements(uid),
      entitlementsToJson({ ...FREE_ENTITLEMENTS, pro: true, proSince: this.clock.now() }),
    );
  }
}

/**
 * Lets every pending microtask run. Opening a conversation fetches the peer key before it can
 * decrypt anything, so a single tick is not enough to see the bodies.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/** Collects every state a watcher is given, newest last. */
function collect<T>(subscribe: (onChange: (state: T) => void) => () => void): {
  states: T[];
  last: () => T;
  stop: () => void;
} {
  const states: T[] = [];
  const stop = subscribe((state) => states.push(state));
  return {
    states,
    last: () => {
      const value = states.at(-1);
      if (value === undefined) throw new Error('no state was delivered');
      return value;
    },
    stop,
  };
}

describe('two users talking to each other', () => {
  it('carries a conversation both ways, in real time, encrypted at rest', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1, { pro: true });
    const bob = await world.join(BOB, 2, { pro: true });

    const conversationId = await alice.messaging.startConversation(BOB);
    expect(conversationId).toBe(conversationIdFor(alice.uid, bob.uid));

    // Bob is watching his list and his side of the conversation the whole time.
    const bobList = collect<MessagingState>((on) => bob.messaging.watch(on));
    const bobThread = collect<ConversationState>((on) =>
      bob.messaging.watchConversation(conversationId, on),
    );
    await flush();

    await alice.messaging.send(conversationId, 'Hey, are you available?');
    await flush();

    expect(bobThread.last().messages.map((m) => m.body)).toEqual(['Hey, are you available?']);
    expect(bobThread.last().messages[0]?.mine).toBe(false);
    expect(bobList.last().conversations[0]?.unread).toBe(1);
    expect(bobList.last().totalUnread).toBe(1);

    world.clock.advance(1000);
    await bob.messaging.send(conversationId, 'Yes, what’s up?');
    await flush();

    const aliceThread = collect<ConversationState>((on) =>
      alice.messaging.watchConversation(conversationId, on),
    );
    await flush();
    expect(aliceThread.last().messages.map((m) => m.body)).toEqual([
      'Hey, are you available?',
      'Yes, what’s up?',
    ]);
    expect(aliceThread.last().messages.map((m) => m.mine)).toEqual([true, false]);

    // Nothing readable was stored.
    const raw = world.store.documents.get(
      MESSAGING_PATHS.message(conversationId, bobThread.last().messages[0]?.id ?? ''),
    );
    expect(JSON.stringify(raw)).not.toContain('available');
    expect(raw).toMatchObject({ v: 1, from: alice.uid });
    expect(Object.keys(raw ?? {})).toEqual(['v', 'from', 'box', 'nonce', 'createdAt']);

    bobList.stop();
    bobThread.stop();
    aliceThread.stop();
  });

  it('keeps several conversations apart', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1, { pro: true });
    const bob = await world.join(BOB, 2, { pro: true });
    const carol = await world.join('carol@example.test', 3, { pro: true });

    const withBob = await alice.messaging.startConversation(BOB);
    world.clock.advance(10);
    const withCarol = await alice.messaging.startConversation('carol@example.test');
    await alice.messaging.send(withBob, 'for bob');
    world.clock.advance(10);
    await alice.messaging.send(withCarol, 'for carol');

    const bobThread = collect<ConversationState>((on) =>
      bob.messaging.watchConversation(withBob, on),
    );
    const carolThread = collect<ConversationState>((on) =>
      carol.messaging.watchConversation(withCarol, on),
    );
    await flush();
    expect(bobThread.last().messages.map((m) => m.body)).toEqual(['for bob']);
    expect(carolThread.last().messages.map((m) => m.body)).toEqual(['for carol']);

    const list = collect<MessagingState>((on) => alice.messaging.watch(on));
    await flush();
    // Newest first.
    expect(list.last().conversations.map((c) => c.id)).toEqual([withCarol, withBob]);
    expect(list.last().conversations.map((c) => c.label)).toEqual([
      'carol@example.test',
      BOB,
    ]);
    bobThread.stop();
    carolThread.stop();
    list.stop();
  });

  it('counts unread until the conversation is opened, then clears it', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1, { pro: true });
    const bob = await world.join(BOB, 2, { pro: true });
    const conversationId = await alice.messaging.startConversation(BOB);

    const bobList = collect<MessagingState>((on) => bob.messaging.watch(on));
    await flush();
    for (const text of ['one', 'two', 'three']) {
      world.clock.advance(5);
      await alice.messaging.send(conversationId, text);
    }
    await flush();
    expect(bobList.last().conversations[0]?.unread).toBe(3);
    // Alice's own badge never moves for her own messages.
    const aliceList = collect<MessagingState>((on) => alice.messaging.watch(on));
    await flush();
    expect(aliceList.last().totalUnread).toBe(0);

    await bob.messaging.markRead(conversationId);
    await flush();
    expect(bobList.last().conversations[0]?.unread).toBe(0);
    expect(bobList.last().conversations[0]?.readAt).toBe(world.clock.now());
    // Reading did not disturb the history.
    expect(bobList.last().conversations[0]?.lastMessageAt).toBeGreaterThan(0);
    bobList.stop();
    aliceList.stop();
  });

  it('stops delivering after unsubscribe', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1, { pro: true });
    const bob = await world.join(BOB, 2, { pro: true });
    const conversationId = await alice.messaging.startConversation(BOB);

    const bobThread = collect<ConversationState>((on) =>
      bob.messaging.watchConversation(conversationId, on),
    );
    await flush();
    const before = bobThread.states.length;
    bobThread.stop();
    await alice.messaging.send(conversationId, 'after you left');
    await flush();
    expect(bobThread.states.length).toBe(before);
  });
});

describe('Pro', () => {
  it('refuses to start or send without it, and says which', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1, { pro: false });
    await world.join(BOB, 2, { pro: true });

    await expect(alice.messaging.startConversation(BOB)).rejects.toMatchObject({
      code: 'pro-required',
    });
    expect(alice.messaging.canMessage()).toBe(false);
    // Nothing was written on the way to the refusal.
    expect([...world.store.documents.keys()].filter((k) => k.startsWith('conversations/'))).toEqual(
      [],
    );
  });

  it('lets a lapsed account keep reading what it already has', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1, { pro: true });
    const bob = await world.join(BOB, 2, { pro: false });
    const conversationId = await alice.messaging.startConversation(BOB);
    await alice.messaging.send(conversationId, 'still readable');

    const thread = collect<ConversationState>((on) =>
      bob.messaging.watchConversation(conversationId, on),
    );
    await flush();
    expect(thread.last().messages.map((m) => m.body)).toEqual(['still readable']);
    expect(thread.last().canSend).toBe(false);
    await expect(bob.messaging.send(conversationId, 'nope')).rejects.toMatchObject({
      code: 'pro-required',
    });
    // Its own badge still clears.
    await bob.messaging.markRead(conversationId);
    thread.stop();
  });

  it('opens everything in a build that sells nothing', async () => {
    const store = new InMemoryCloudStore();
    const clock = new FakeClock();
    const cloud = new InMemoryCloudBackend(null, store);
    await cloud.signUp(ALICE, PASSWORD);
    const entitlements = new EntitlementsController({
      secureStore: new InMemorySecureStore(),
      clock,
      cloud,
      enforced: false,
    });
    await entitlements.refresh();
    const messaging = new MessagingService({
      cloud,
      directory: new InMemoryDirectory(new Map(), () => false),
      entitlements,
      clock,
      random: new SequentialRandom(1),
      identity: () => deriveMessagingIdentity(masterKey(1)),
    });
    expect(messaging.canMessage()).toBe(true);
  });
});

describe('refusals', () => {
  it('refuses an address nobody uses, and your own', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1, { pro: true });
    await expect(alice.messaging.startConversation('ghost@example.test')).rejects.toMatchObject({
      code: 'no-such-user',
    });
    await expect(alice.messaging.startConversation(ALICE)).rejects.toMatchObject({ code: 'self' });
  });

  it('refuses someone who has never opened messaging, and writes nothing', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1, { pro: true });
    const bob = await world.join(BOB, 2, { pro: true });
    world.store.documents.delete(MESSAGING_PATHS.publicKey(bob.uid));

    await expect(alice.messaging.startConversation(BOB)).rejects.toMatchObject({
      code: 'peer-has-no-key',
    });
    expect([...world.store.documents.keys()].filter((k) => k.startsWith('conversations/'))).toEqual(
      [],
    );
  });

  it('refuses text that must never leave the device, before writing anything', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1, { pro: true });
    await world.join(BOB, 2, { pro: true });
    const conversationId = await alice.messaging.startConversation(BOB);

    await expect(alice.messaging.send(conversationId, 'my pin is 4821')).rejects.toMatchObject({
      code: 'rejected',
      problem: 'pin',
    });
    const messages = [...world.store.documents.keys()].filter((key) =>
      key.startsWith(MESSAGING_PATHS.messages(conversationId)),
    );
    expect(messages).toEqual([]);
  });

  it('refuses everything while the vault is locked', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1, { pro: true });
    await world.join(BOB, 2, { pro: true });
    const conversationId = await alice.messaging.startConversation(BOB);

    alice.identity?.dispose();
    alice.identity = null;
    alice.messaging.forgetKeys();

    expect(alice.messaging.canMessage()).toBe(false);
    await expect(alice.messaging.send(conversationId, 'hello')).rejects.toMatchObject({
      code: 'locked',
    });
    await expect(alice.messaging.startConversation(BOB)).rejects.toMatchObject({ code: 'locked' });

    // The list still loads; the bodies are simply not readable.
    const thread = collect<ConversationState>((on) =>
      alice.messaging.watchConversation(conversationId, on),
    );
    await flush();
    expect(thread.last().problem).toBe('locked');
    thread.stop();
  });

  it('refuses a conversation this account is not part of', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1, { pro: true });
    await expect(alice.messaging.send('xxx__yyy', 'hello')).rejects.toBeInstanceOf(MessagingError);
    expect(() =>
      alice.cloud.watchCollection(
        MESSAGING_PATHS.messages('xxx__yyy'),
        { orderBy: 'createdAt' },
        () => undefined,
      ),
    ).toThrow();
  });

  it('refuses an unfiltered listing of every conversation in the database', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1, { pro: true });
    expect(() =>
      alice.cloud.watchCollection('conversations', { orderBy: 'lastMessageAt' }, () => undefined),
    ).toThrow();
    expect(() =>
      alice.cloud.watchCollection(
        'conversations',
        { arrayContains: { field: 'members', value: 'someone-else' } },
        () => undefined,
      ),
    ).toThrow();
  });
});

describe('published keys', () => {
  it('publishes once and does not rewrite an unchanged key', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1, { pro: true });
    const path = MESSAGING_PATHS.publicKey(alice.uid);
    const first = world.store.documents.get(path);
    expect(first).toMatchObject({ v: 1, uid: alice.uid });

    world.clock.advance(5000);
    await alice.messaging.publishKey();
    expect(world.store.documents.get(path)?.updatedAt).toBe(first?.updatedAt);
  });

  it('is readable by another account, because that is the point of a public key', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1, { pro: true });
    const bob = await world.join(BOB, 2, { pro: true });
    await expect(bob.cloud.getDocument(MESSAGING_PATHS.publicKey(alice.uid))).resolves.toMatchObject(
      { uid: alice.uid },
    );
    // But not writable by them.
    await expect(
      bob.cloud.putDocument(MESSAGING_PATHS.publicKey(alice.uid), { v: 1 }),
    ).rejects.toThrow();
  });
});

/**
 * The receiving side has no address for anybody: whoever starts a conversation is the one who
 * typed an address, and the shared document carries none. These cover the reverse lookup that
 * puts a name on the row afterwards.
 */
describe('naming the other side', () => {
  it('learns the address of whoever started the conversation', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1, { pro: true });
    const bob = await world.join(BOB, 2, { pro: true });
    const conversationId = await alice.messaging.startConversation(BOB);
    await alice.messaging.send(conversationId, 'hello');
    await flush();

    // Bob has looked nobody up, so before watching he holds nothing but a uid.
    const list = collect<MessagingState>((on) => bob.messaging.watch(on));
    await flush();
    await flush();

    expect(list.last().conversations[0]?.label).toBe(ALICE);
    expect(bob.directory.reverseLookups).toEqual([alice.uid]);
  });

  it('asks once per peer, however often the list changes', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1, { pro: true });
    const bob = await world.join(BOB, 2, { pro: true });
    const conversationId = await alice.messaging.startConversation(BOB);
    await flush();

    const list = collect<MessagingState>((on) => bob.messaging.watch(on));
    await flush();
    await flush();
    await alice.messaging.send(conversationId, 'one');
    await flush();
    await alice.messaging.send(conversationId, 'two');
    await flush();

    expect(bob.directory.reverseLookups).toEqual([alice.uid]);
    expect(list.last().conversations[0]?.label).toBe(ALICE);
  });

  it('does not ask about a peer it already has a name for', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1, { pro: true });
    await world.join(BOB, 2, { pro: true });
    await alice.messaging.startConversation(BOB);
    await flush();

    // Alice typed the address, so she already has the contact.
    collect<MessagingState>((on) => alice.messaging.watch(on));
    await flush();
    await flush();

    expect(alice.directory.reverseLookups).toEqual([]);
  });

  it('keeps showing the id when the vault is locked', async () => {
    const world = new World();
    const alice = await world.join(ALICE, 1, { pro: true });
    const bob = await world.join(BOB, 2, { pro: true });
    await alice.messaging.startConversation(BOB);
    await flush();

    bob.identity = null;
    const list = collect<MessagingState>((on) => bob.messaging.watch(on));
    await flush();
    await flush();

    expect(bob.directory.reverseLookups).toEqual([]);
    expect(list.last().conversations[0]?.label).toBeNull();
  });
});

describe('media messages', () => {
  const PHOTO = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3, 4, 5, 6, 7]);

  async function pair(): Promise<{
    world: World;
    alice: Side;
    bob: Side;
    conversationId: string;
  }> {
    const world = new World();
    const alice = await world.join('alice@example.test', 1, { pro: true });
    const bob = await world.join('bob@example.test', 2, { pro: true });
    await bob.messaging.publishKey();
    await alice.messaging.publishKey();
    const conversationId = await alice.messaging.startConversation('bob@example.test');
    await alice.fs.writeBytes('file:///photo.jpg', PHOTO);
    return { world, alice, bob, conversationId };
  }

  it('sends a photo the other side can open, with nothing readable at rest', async () => {
    const { alice, bob, conversationId } = await pair();

    const sent = await alice.messaging.sendMedia(conversationId, {
      uri: 'file:///photo.jpg',
      kind: 'photo',
    });
    await flush();

    expect(sent.kind).toBe('photo');
    expect(sent.object).toBe(`messages/${conversationId}/photo/${sent.id}`);

    // Nothing stored anywhere contains the plaintext.
    for (const blob of alice.cloud.blobs.values()) {
      expect(Buffer.from(blob).includes(Buffer.from(PHOTO))).toBe(false);
    }

    const thread = collect<ConversationState>((on) =>
      bob.messaging.watchConversation(conversationId, on),
    );
    await flush();
    const received = thread.last().messages[0];
    if (received === undefined) throw new Error('expected the message');
    expect(received.kind).toBe('photo');

    const uri = await bob.messaging.fetchMedia(conversationId, received);
    expect(await bob.fs.readBytes(uri)).toEqual(PHOTO);
  });

  it('reports the download, and then the phase that has no percentage to give', async () => {
    const { alice, bob, conversationId } = await pair();
    await alice.messaging.sendMedia(conversationId, { uri: 'file:///photo.jpg', kind: 'photo' });
    await flush();

    const thread = collect<ConversationState>((on) =>
      bob.messaging.watchConversation(conversationId, on),
    );
    await flush();
    const received = thread.last().messages[0];
    if (received === undefined) throw new Error('expected the message');

    const states: TransferState[] = [];
    await bob.messaging.fetchMedia(conversationId, received, (state) => {
      states.push(state);
    });

    // The transfer says how big the object is, which is what lets the viewer show a percentage
    // instead of the featureless spinner that made a two-minute fetch look like a hang.
    expect(states.some((state) => (state.total ?? 0) > 0)).toBe(true);
    // And the LAST thing it says is that the bytes are in and the open has begun. That phase is
    // one atomic AEAD open with no fraction to report, and on a real video it ran for forty
    // seconds -- announcing it is the only thing that distinguishes it from a stall.
    expect(states.at(-1)).toEqual({ opening: true });
  });

  it('gives the other side a preview without downloading the media', async () => {
    const { alice, bob, conversationId } = await pair();
    await alice.messaging.sendMedia(conversationId, { uri: 'file:///photo.jpg', kind: 'photo' });
    await flush();

    const thread = collect<ConversationState>((on) =>
      bob.messaging.watchConversation(conversationId, on),
    );
    await flush();
    const received = thread.last().messages[0];
    if (received === undefined) throw new Error('expected the message');

    expect(received.thumbObject).toBe(`messages/${conversationId}/thumb/${received.id}`);
    expect(await bob.messaging.fetchThumb(conversationId, received)).not.toBeNull();
  });

  // The preview must be regenerated at the chat size, never reused from the vault's 512px one:
  // a 512px JPEG is typically 40-90 KB, over the 32 KB the Storage rules allow. This mistake
  // would pass every other test here and be refused only on a real device.
  it('generates the thumbnail at the chat size, not the vault size', async () => {
    const { alice, conversationId } = await pair();
    const sent = await alice.messaging.sendMedia(conversationId, {
      uri: 'file:///photo.jpg',
      kind: 'photo',
    });

    expect(alice.thumbnails.calls).toBe(1);
    expect(alice.thumbnails.lastMaxDimension).toBe(256);
    const thumb = alice.cloud.blobs.get(`messages/${conversationId}/thumb/${sent.id}`);
    expect(thumb).toBeDefined();
    expect(thumb?.length ?? 0).toBeLessThan(32 * 1024);
  });

  /**
   * The photo nobody could send.
   *
   * The picker is opened with `quality: 1`, so a photo arrives at whatever size the camera wrote --
   * on a recent phone routinely 6-8 MB against an 8 MB ceiling. The old behaviour refused anything
   * over it, the tray discarded the reason, and the bubble offered a retry that re-ran the identical
   * check. These pin the replacement: make it fit, and when it cannot, say so.
   */
  describe('a photo over its budget', () => {
    /** Over the 8 MB ceiling, which is what the camera hands over on a modern phone. */
    function oversizedPhoto(): Uint8Array {
      const bytes = new Uint8Array(9 * 1024 * 1024);
      for (let i = 0; i < bytes.length; i += 4096) bytes[i] = i & 0xff;
      return bytes;
    }

    it('is re-encoded smaller and sent, rather than refused', async () => {
      const { alice, bob, conversationId } = await pair();
      await alice.fs.writeBytes('file:///big.jpg', oversizedPhoto());
      // Weighs 1 MB at the top rung, so the first re-encode already fits.
      alice.thumbnails.sizeForEdge = (edge) => 1024 * 1024 * (edge / 2048) ** 2;

      const sent = await alice.messaging.sendMedia(conversationId, {
        uri: 'file:///big.jpg',
        kind: 'photo',
      });
      await flush();

      // It reached Storage, and the object is inside the ceiling the rules enforce.
      const object = alice.cloud.blobs.get(sent.object ?? '');
      expect(object).toBeDefined();
      expect(object?.length ?? 0).toBeLessThan(MAX_PHOTO_BYTES);
      // The first rung of the ladder was tried, and the preview came after it.
      expect(alice.thumbnails.edges).toEqual([2048, 256]);

      // And the other side can open what arrived.
      const thread = collect<ConversationState>((on) =>
        bob.messaging.watchConversation(conversationId, on),
      );
      await flush();
      const received = thread.last().messages[0];
      if (received === undefined) throw new Error('expected the message');
      expect((await bob.messaging.fetchMediaBytes(conversationId, received)).length).toBeGreaterThan(
        0,
      );
    });

    it('leaves a photo already inside its budget untouched', async () => {
      const { alice, conversationId } = await pair();
      alice.thumbnails.sizeForEdge = (edge) => 1024 * (edge / 2048) ** 2;

      await alice.messaging.sendMedia(conversationId, {
        uri: 'file:///photo.jpg',
        kind: 'photo',
      });

      // One generation, for the preview. Nothing re-encoded the photo itself.
      expect(alice.thumbnails.edges).toEqual([256]);
    });

    it('refuses one that will not shrink, with a reason no retry could fix', async () => {
      const { world, alice, conversationId } = await pair();
      await alice.fs.writeBytes('file:///big.jpg', oversizedPhoto());
      // Incompressible at every rung.
      alice.thumbnails.sizeForEdge = () => 9 * 1024 * 1024;

      await expect(
        alice.messaging.sendMedia(conversationId, { uri: 'file:///big.jpg', kind: 'photo' }),
      ).rejects.toMatchObject({ code: 'rejected', problem: 'photo-too-large' });

      // Nothing was uploaded and nothing was written: the refusal happens before the network.
      expect([...alice.cloud.blobs.keys()]).toEqual([]);
      expect(
        [...world.store.documents.keys()].filter((key) =>
          key.startsWith(MESSAGING_PATHS.messages(conversationId)),
        ),
      ).toEqual([]);
    });

    /**
     * A video is read whole into memory, so the order of these two steps is the difference between
     * refusing a 500 MB pick and allocating 500 MB first. There is no transcoder here, so the size
     * the file system reports is the whole answer.
     */
    it('refuses an oversized video from its file size, without reading it', async () => {
      const { alice, conversationId } = await pair();
      await alice.fs.writeBytes('file:///huge.mp4', new Uint8Array(101 * 1024 * 1024));
      const read = jest.spyOn(alice.fs, 'readBytes');

      await expect(
        alice.messaging.sendMedia(conversationId, { uri: 'file:///huge.mp4', kind: 'video' }),
      ).rejects.toMatchObject({ code: 'rejected', problem: 'video-too-large' });

      expect(read).not.toHaveBeenCalled();
      expect(alice.cloud.blobWrites).toEqual([]);
      read.mockRestore();
    });

    it('reads a video that fits, exactly once', async () => {
      const { alice, conversationId } = await pair();
      await alice.fs.writeBytes('file:///clip.mp4', new Uint8Array(1024));
      const read = jest.spyOn(alice.fs, 'readBytes');

      const sent = await alice.messaging.sendMedia(conversationId, {
        uri: 'file:///clip.mp4',
        kind: 'video',
      });

      expect(read).toHaveBeenCalledTimes(1);
      expect(alice.cloud.blobs.get(sent.object ?? '')).toBeDefined();
      read.mockRestore();
    });

    /**
     * A vault photo arrives as bytes under a `vault://` pseudo-URI, which names no file. The
     * preflight must not try to stat it: there is nothing there, and the bytes are already in hand.
     */
    it('consults no file for a source that carries its own bytes', async () => {
      const { alice, conversationId } = await pair();
      const size = jest.spyOn(alice.fs, 'size');
      const read = jest.spyOn(alice.fs, 'readBytes');

      await alice.messaging.sendMedia(conversationId, {
        uri: 'vault://entry-1',
        kind: 'photo',
        bytes: new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]),
      });

      expect(size).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      size.mockRestore();
      read.mockRestore();
    });

    it('refuses an oversized VIDEO outright, because nothing here can transcode one', async () => {
      const { alice, conversationId } = await pair();
      await alice.fs.writeBytes('file:///big.mp4', new Uint8Array(101 * 1024 * 1024));

      await expect(
        alice.messaging.sendMedia(conversationId, { uri: 'file:///big.mp4', kind: 'video' }),
      ).rejects.toMatchObject({ code: 'rejected', problem: 'video-too-large' });
      expect(alice.thumbnails.calls).toBe(0);
    });

    it('writes no plaintext of its own to disk', async () => {
      const { alice, conversationId } = await pair();
      await alice.fs.writeBytes('file:///big.jpg', oversizedPhoto());
      alice.thumbnails.sizeForEdge = (edge) => 1024 * 1024 * (edge / 2048) ** 2;
      const before = [...alice.fs.allFiles.keys()].sort();

      await alice.messaging.sendMedia(conversationId, { uri: 'file:///big.jpg', kind: 'photo' });

      // The source is still there for a retry, and the reduction left nothing behind: it works on
      // bytes in memory, and the real generator securely deletes its own cache file before it
      // returns. (`ExpoThumbnailGenerator` does that in a `finally`.)
      expect([...alice.fs.allFiles.keys()].sort()).toEqual(before);
      expect(await alice.fs.exists('file:///big.jpg')).toBe(true);
    });
  });

  /**
   * The preview has its own ceiling, 32 KB, and it is enforced by the Storage rules on the object.
   * Nothing enforced it locally, so a preview that compressed badly took the WHOLE send down with
   * it: `putBlob` has no try/catch around it, and the photo upload never happened.
   */
  it('shrinks a preview that would not fit instead of failing the send', async () => {
    const { alice, conversationId } = await pair();
    // Over the ceiling at the chat size, under it two rungs down.
    alice.thumbnails.sizeForEdge = (edge) => (edge >= 192 ? 40 * 1024 : 20 * 1024);

    const sent = await alice.messaging.sendMedia(conversationId, {
      uri: 'file:///photo.jpg',
      kind: 'photo',
    });

    expect(alice.thumbnails.edges).toEqual([256, 192, 160]);
    const thumb = alice.cloud.blobs.get(sent.thumbObject ?? '');
    expect(thumb).toBeDefined();
    expect(thumb?.length ?? 0).toBeLessThan(MAX_THUMB_BYTES);
    // The photo still went, which is the point: a preview is a nicety, the photo is the message.
    expect(alice.cloud.blobs.get(sent.object ?? '')).toBeDefined();
  });

  it('sends with no preview at all rather than refusing, when none can be made to fit', async () => {
    const { alice, conversationId } = await pair();
    alice.thumbnails.sizeForEdge = () => 40 * 1024;

    const sent = await alice.messaging.sendMedia(conversationId, {
      uri: 'file:///photo.jpg',
      kind: 'photo',
    });

    expect(sent.thumbObject).toBeNull();
    expect(alice.cloud.blobs.get(sent.object ?? '')).toBeDefined();
  });

  // A bubble pointing at an object that is not there can never be fixed; an orphaned object is
  // invisible and expires on its own. So the upload must land before the document does.
  it('writes no document when the upload fails', async () => {
    const { world, alice, conversationId } = await pair();
    alice.cloud.failNextBlobUpload();

    await expect(
      alice.messaging.sendMedia(conversationId, { uri: 'file:///photo.jpg', kind: 'photo' }),
    ).rejects.toThrow();

    const messages = [...world.store.documents.keys()].filter((k) =>
      k.startsWith(`conversations/${conversationId}/messages/`),
    );
    expect(messages).toEqual([]);
  });

  it('refuses media without Pro, exactly as it refuses text', async () => {
    const world = new World();
    const bob = await world.join('bob@example.test', 2, { pro: true });
    await bob.messaging.publishKey();
    // Pro from the start so the conversation can exist, then joined again without it: the same
    // account on a device whose entitlement has gone, which is what a lapsed reader looks like.
    const pro = await world.join('alice@example.test', 1, { pro: true });
    await pro.messaging.publishKey();
    const conversationId = await pro.messaging.startConversation('bob@example.test');

    const free = await world.join('carol@example.test', 3, { pro: false });
    await free.fs.writeBytes('file:///photo.jpg', PHOTO);

    await expect(
      free.messaging.sendMedia(conversationId, { uri: 'file:///photo.jpg', kind: 'photo' }),
    ).rejects.toMatchObject({ code: 'pro-required' });
    expect(free.cloud.blobWrites).toEqual([]);
  });

  /**
   * An oversized photo is no longer refused -- it is re-encoded smaller first, and only a photo
   * that will not shrink is refused. What has not changed, and is what this always guarded, is that
   * a refusal uploads nothing: the check runs before the first byte leaves the device.
   */
  it('uploads nothing when an item cannot be sent at all', async () => {
    const { alice, conversationId } = await pair();
    const huge = new Uint8Array(9 * 1024 * 1024);
    await alice.fs.writeBytes('file:///huge.jpg', huge);
    // Incompressible: every rung of the ladder comes back over the ceiling.
    alice.thumbnails.sizeForEdge = () => 9 * 1024 * 1024;

    await expect(
      alice.messaging.sendMedia(conversationId, { uri: 'file:///huge.jpg', kind: 'photo' }),
    ).rejects.toMatchObject({ code: 'rejected', problem: 'photo-too-large' });
    expect(alice.cloud.blobWrites).toEqual([]);
  });

  it('re-encodes an oversized photo instead of refusing it', async () => {
    const { alice, conversationId } = await pair();
    await alice.fs.writeBytes('file:///huge.jpg', new Uint8Array(9 * 1024 * 1024));

    const sent = await alice.messaging.sendMedia(conversationId, {
      uri: 'file:///huge.jpg',
      kind: 'photo',
    });

    expect(alice.cloud.blobWrites.length).toBeGreaterThan(0);
    expect(alice.cloud.blobs.get(sent.object ?? '')?.length ?? 0).toBeLessThan(MAX_PHOTO_BYTES);
  });

  // What a 30-day-old photo does: the bubble stays, the imagery is gone, preview included.
  it('reports both the media and its thumbnail as expired once swept', async () => {
    const { alice, bob, conversationId } = await pair();
    await alice.messaging.sendMedia(conversationId, { uri: 'file:///photo.jpg', kind: 'photo' });
    await flush();

    const thread = collect<ConversationState>((on) =>
      bob.messaging.watchConversation(conversationId, on),
    );
    await flush();
    const received = thread.last().messages[0];
    if (received === undefined) throw new Error('expected the message');

    bob.cloud.expireBlobsUnder(`messages/${conversationId}/`);

    expect(await bob.messaging.fetchThumb(conversationId, received)).toBeNull();
    await expect(bob.messaging.fetchMedia(conversationId, received)).rejects.toMatchObject({
      code: 'expired',
    });
    // The record itself survives: the conversation history is not rewritten.
    expect(thread.last().messages[0]?.kind).toBe('photo');
  });

  // The cross-plan guard: chat media belongs to Pro, not to the Cloud backup allowance.
  it('sends media with no Cloud term at all', async () => {
    const { alice, conversationId } = await pair();
    expect(alice.entitlements.isCloudActive()).toBe(false);

    await expect(
      alice.messaging.sendMedia(conversationId, { uri: 'file:///photo.jpg', kind: 'photo' }),
    ).resolves.toMatchObject({ kind: 'photo' });
  });
});

describe('saving received media into the vault', () => {
  const PHOTO = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3, 4, 5, 6, 7]);

  async function received(): Promise<{
    bob: Side;
    conversationId: string;
    message: DecryptedMessage;
    vault: FakeRepository;
  }> {
    const world = new World();
    const alice = await world.join('alice@example.test', 1, { pro: true });
    const bob = await world.join('bob@example.test', 2, { pro: true });
    await bob.messaging.publishKey();
    await alice.messaging.publishKey();
    const conversationId = await alice.messaging.startConversation('bob@example.test');
    await alice.fs.writeBytes('file:///photo.jpg', PHOTO);
    await alice.messaging.sendMedia(conversationId, { uri: 'file:///photo.jpg', kind: 'photo' });
    await flush();

    const thread = collect<ConversationState>((on) =>
      bob.messaging.watchConversation(conversationId, on),
    );
    await flush();
    const message = thread.last().messages[0];
    if (message === undefined) throw new Error('expected the message');
    return { bob, conversationId, message, vault: new FakeRepository() };
  }

  it('saves a received photo into the vault as an ordinary item', async () => {
    const { bob, conversationId, message, vault } = await received();

    await bob.messaging.saveToVault(conversationId, message, vault);

    expect(vault.photos).toHaveLength(1);
    expect(vault.added[0]?.source).toBe('import');
  });

  // A received item is an ordinary vault item. No special case, no bypass -- otherwise chat
  // would be a free channel for filling a free vault past its 50 items.
  it('refuses when the free vault is full, and says which limit bit', async () => {
    const { bob, conversationId, message, vault } = await received();
    vault.fill(FREE_TIER.maxItems);

    await expect(bob.messaging.saveToVault(conversationId, message, vault)).rejects.toMatchObject({
      code: 'vault-refused',
      problem: 'itemLimit',
    });
    expect(vault.photos).toHaveLength(FREE_TIER.maxItems);
  });

  it('reports an expired item as expired rather than as a vault error', async () => {
    const { bob, conversationId, message, vault } = await received();
    bob.cloud.expireBlobsUnder(`messages/${conversationId}/`);

    await expect(bob.messaging.saveToVault(conversationId, message, vault)).rejects.toMatchObject({
      code: 'expired',
    });
  });

  // A refused save must not leave a decrypted copy of somebody's photo in the cache directory.
  it('leaves no plaintext behind when the vault refuses', async () => {
    const { bob, conversationId, message, vault } = await received();
    vault.fill(FREE_TIER.maxItems);
    const before = [...bob.fs.allFiles.keys()];

    await expect(bob.messaging.saveToVault(conversationId, message, vault)).rejects.toThrow();

    expect([...bob.fs.allFiles.keys()]).toEqual(before);
  });
});

/**
 * The vault's surface as `saveToVault` uses it. A real `EncryptedVaultRepository` would drag the
 * whole cipher and key stack into a messaging spec; what is under test here is the gate and the
 * cleanup, not the vault's own storage, which has its own suite.
 */
class FakeRepository {
  readonly added: { source: string; kind: 'photo' | 'video' }[] = [];

  private count = 0;

  get photos(): readonly PhotoEntry[] {
    return new Array<PhotoEntry>(this.count + this.added.length).fill(
      {} as unknown as PhotoEntry,
    );
  }

  fill(n: number): void {
    this.count = n;
  }

  async addPhoto(_image: ImageInput, options: AddPhotoOptions): Promise<PhotoEntry> {
    this.added.push({ source: options.source, kind: 'photo' });
    return {} as unknown as PhotoEntry;
  }

  async addVideo(_video: VideoInput, options: AddPhotoOptions): Promise<PhotoEntry> {
    this.added.push({ source: options.source, kind: 'video' });
    return {} as unknown as PhotoEntry;
  }
}

describe('opening received media', () => {
  const PHOTO = new Uint8Array([0xff, 0xd8, 0xff, 9, 8, 7, 6, 5]);

  async function sent(kind: 'photo' | 'video'): Promise<{
    bob: Side;
    conversationId: string;
    message: DecryptedMessage;
  }> {
    const world = new World();
    const alice = await world.join('alice@example.test', 1, { pro: true });
    const bob = await world.join('bob@example.test', 2, { pro: true });
    await bob.messaging.publishKey();
    await alice.messaging.publishKey();
    const conversationId = await alice.messaging.startConversation('bob@example.test');
    await alice.fs.writeBytes('file:///item', PHOTO);
    await alice.messaging.sendMedia(conversationId, { uri: 'file:///item', kind });
    await flush();

    const thread = collect<ConversationState>((on) =>
      bob.messaging.watchConversation(conversationId, on),
    );
    await flush();
    const message = thread.last().messages[0];
    if (message === undefined) throw new Error('expected the message');
    return { bob, conversationId, message };
  }

  // The vault never writes a plaintext photo to disk, and a chat photo is no less sensitive.
  it('returns a photo as bytes without writing it anywhere', async () => {
    const { bob, conversationId, message } = await sent('photo');
    const before = [...bob.fs.allFiles.keys()];

    expect(await bob.messaging.fetchMediaBytes(conversationId, message)).toEqual(PHOTO);

    expect([...bob.fs.allFiles.keys()]).toEqual(before);
  });

  // Video is the exception: a player needs a file it can seek, which is what the scratch is for.
  it('writes a video to scratch, and nowhere else', async () => {
    const { bob, conversationId, message } = await sent('video');

    const uri = await bob.messaging.fetchMedia(conversationId, message);

    expect(uri).toContain(bob.fs.cacheDirectory);
    expect(await bob.fs.readBytes(uri)).toEqual(PHOTO);
  });

  it('reports an expired item as expired from the bytes path too', async () => {
    const { bob, conversationId, message } = await sent('photo');
    bob.cloud.expireBlobsUnder(`messages/${conversationId}/`);

    await expect(
      bob.messaging.fetchMediaBytes(conversationId, message),
    ).rejects.toMatchObject({ code: 'expired' });
  });
});

describe('deleting messages', () => {
  async function pair() {
    const world = new World();
    const alice = await world.join(ALICE, 1, { pro: true });
    const bob = await world.join(BOB, 2, { pro: true });
    const conversationId = await alice.messaging.startConversation(BOB);
    return { world, alice, bob, conversationId };
  }

  function threadOf(side: Side, conversationId: string) {
    return collect<ConversationState>((on) =>
      side.messaging.watchConversation(conversationId, on),
    );
  }

  describe('for me', () => {
    it('hides it on this device and leaves the other side untouched', async () => {
      const { alice, bob, conversationId } = await pair();
      await alice.messaging.send(conversationId, 'only I will stop seeing this');
      await flush();

      const hers = threadOf(alice, conversationId);
      const his = threadOf(bob, conversationId);
      await flush();
      const message = hers.last().messages[0];
      if (message === undefined) throw new Error('nothing to delete');

      await alice.messaging.deleteForMe(conversationId, message.id);
      await flush();

      // Gone from her OPEN thread, without reopening it, and still ordinary for him.
      expect(hers.last().messages).toEqual([]);
      expect(his.last().messages.map((m) => m.body)).toEqual(['only I will stop seeing this']);
      expect(his.last().messages[0]?.deleted).toBe(false);
      hers.stop();
      his.stop();
    });

    // The requirement is that it STAYS hidden, so this reopens the thread rather than trusting
    // the in-memory listener proved above.
    it('stays hidden when the thread is opened again', async () => {
      const { alice, conversationId } = await pair();
      await alice.messaging.send(conversationId, 'hidden');
      await flush();
      const first = threadOf(alice, conversationId);
      await flush();
      await alice.messaging.deleteForMe(conversationId, first.last().messages[0]?.id ?? '');
      first.stop();

      const reopened = threadOf(alice, conversationId);
      await flush();
      expect(reopened.last().messages).toEqual([]);
      reopened.stop();
    });

    it('can hide the other side of the conversation too', async () => {
      const { alice, bob, conversationId } = await pair();
      await bob.messaging.send(conversationId, 'from him');
      await flush();
      const hers = threadOf(alice, conversationId);
      await flush();
      await alice.messaging.deleteForMe(conversationId, hers.last().messages[0]?.id ?? '');
      await flush();
      expect(hers.last().messages).toEqual([]);
      hers.stop();
    });

    it('never writes anything the server could read', async () => {
      const { world, alice, conversationId } = await pair();
      await alice.messaging.send(conversationId, 'private decision');
      await flush();
      const hers = threadOf(alice, conversationId);
      await flush();
      const before = JSON.stringify([...world.store.documents.entries()]);
      await alice.messaging.deleteForMe(conversationId, hers.last().messages[0]?.id ?? '');
      await flush();
      expect(JSON.stringify([...world.store.documents.entries()])).toBe(before);
      hers.stop();
    });
  });

  describe('for everyone', () => {
    it('replaces the message for both sides with a withdrawn marker', async () => {
      const { alice, bob, conversationId } = await pair();
      await alice.messaging.send(conversationId, 'said too much');
      await flush();
      const hers = threadOf(alice, conversationId);
      const his = threadOf(bob, conversationId);
      await flush();
      const message = hers.last().messages[0];
      if (message === undefined) throw new Error('nothing to delete');

      await alice.messaging.deleteForEveryone(conversationId, message);
      await flush();

      for (const side of [hers, his]) {
        expect(side.last().messages).toHaveLength(1);
        expect(side.last().messages[0]?.deleted).toBe(true);
        expect(side.last().messages[0]?.body).toBeNull();
      }
      hers.stop();
      his.stop();
    });

    // The point of replacing rather than flagging: no ciphertext is left in the database for any
    // client, or anyone reading it directly, to decrypt later.
    it('leaves no ciphertext behind in the stored document', async () => {
      const { world, alice, conversationId } = await pair();
      await alice.messaging.send(conversationId, 'unrecoverable');
      await flush();
      const hers = threadOf(alice, conversationId);
      await flush();
      const message = hers.last().messages[0];
      if (message === undefined) throw new Error('nothing to delete');
      const path = MESSAGING_PATHS.message(conversationId, message.id);
      expect(world.store.documents.get(path)).toHaveProperty('box');

      await alice.messaging.deleteForEveryone(conversationId, message);
      const stored = world.store.documents.get(path) ?? {};
      expect(Object.keys(stored).sort()).toEqual(['createdAt', 'deletedAt', 'from', 'v']);
      hers.stop();
    });

    it('refuses to withdraw a message this account did not send', async () => {
      const { alice, bob, conversationId } = await pair();
      await alice.messaging.send(conversationId, 'hers to withdraw, not his');
      await flush();
      const his = threadOf(bob, conversationId);
      await flush();
      const message = his.last().messages[0];
      if (message === undefined) throw new Error('nothing to delete');

      await expect(bob.messaging.deleteForEveryone(conversationId, message)).rejects.toMatchObject({
        code: 'not-mine',
      });
      expect(his.last().messages[0]?.deleted).toBe(false);
      his.stop();
    });

    it('is idempotent: withdrawing an already withdrawn message changes nothing', async () => {
      const { world, alice, conversationId } = await pair();
      await alice.messaging.send(conversationId, 'twice');
      await flush();
      const hers = threadOf(alice, conversationId);
      await flush();
      const message = hers.last().messages[0];
      if (message === undefined) throw new Error('nothing to delete');
      await alice.messaging.deleteForEveryone(conversationId, message);
      await flush();

      const withdrawn = hers.last().messages[0];
      if (withdrawn === undefined) throw new Error('the placeholder vanished');
      const path = MESSAGING_PATHS.message(conversationId, message.id);
      const after = JSON.stringify(world.store.documents.get(path));
      await alice.messaging.deleteForEveryone(conversationId, withdrawn);
      expect(JSON.stringify(world.store.documents.get(path))).toBe(after);
      hers.stop();
    });

    it('removes the whole conversation for both sides, with no placeholder left', async () => {
      const { world, alice, bob, conversationId } = await pair();
      await alice.messaging.send(conversationId, 'first');
      await bob.messaging.send(conversationId, 'second');
      await flush();

      const herList = collect<MessagingState>((on) => alice.messaging.watch(on));
      const hisList = collect<MessagingState>((on) => bob.messaging.watch(on));
      const hisThread = threadOf(bob, conversationId);
      await flush();
      expect(herList.last().conversations).toHaveLength(1);
      expect(hisThread.last().messages).toHaveLength(2);

      await alice.messaging.deleteConversation(conversationId);
      await flush();

      // Gone from BOTH lists -- this is the one action that reaches into the other person's copy.
      expect(herList.last().conversations).toEqual([]);
      expect(hisList.last().conversations).toEqual([]);
      // And nothing of it is left in the database.
      const leftovers = [...world.store.documents.keys()].filter((p) => p.includes(conversationId));
      expect(leftovers).toEqual([]);
      herList.stop();
      hisList.stop();
      hisThread.stop();
    });

    it('refuses a conversation this account is not in, and deletes nothing', async () => {
      const { world, alice, conversationId } = await pair();
      await alice.messaging.send(conversationId, 'still here');
      await flush();
      const before = [...world.store.documents.keys()].filter((p) => p.includes(conversationId));
      expect(before.length).toBeGreaterThan(0);

      // A conversation between two other accounts.
      const theirs = ['zzz-other-one', 'zzz-other-two'].sort().join('__');
      await expect(alice.messaging.deleteConversation(theirs)).rejects.toMatchObject({
        code: 'unavailable',
      });
      expect(
        [...world.store.documents.keys()].filter((p) => p.includes(conversationId)),
      ).toEqual(before);
    });

    it('takes the media objects with it', async () => {
      const { world, alice, conversationId } = await pair();
      await alice.fs.writeBytes('file:///photo.jpg', new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]));
      const sent = await alice.messaging.sendMedia(conversationId, {
        uri: 'file:///photo.jpg',
        kind: 'photo',
      });
      await flush();
      expect(world.store.blobs.has(sent.object ?? '')).toBe(true);

      await alice.messaging.deleteForEveryone(conversationId, sent);
      expect(world.store.blobs.has(sent.object ?? '')).toBe(false);
      if (sent.thumbObject !== null) expect(world.store.blobs.has(sent.thumbObject)).toBe(false);
    });
  });
});
