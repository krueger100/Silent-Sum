/**
 * Putting a name on a row, and asking again when that did not work.
 *
 * A conversation row shows the correspondent's address. The address is never in the conversation
 * document -- messaging stores no plaintext addresses, deliberately -- so it is asked of the
 * directory once and filed in this account's encrypted contacts, from where the contacts listener
 * delivers it like any other label.
 *
 * "Once" was the bug. The peer was marked as asked-about BEFORE the lookup, and nothing unmarked
 * it when the lookup failed, so a single refusal meant that row showed a raw account id for the
 * life of the process. Reopening Messages did not retry. Signing out and back in did not retry.
 * Only killing the app did -- which is how a plain App Check registration problem came to look
 * like a vault or an account problem, and cost an afternoon of looking in the wrong place.
 *
 * The mark is still taken before the lookup, because two snapshots arriving together must ask
 * once between them. It is now given back when nothing was learned.
 */
import { EntitlementsController } from '@/billing/entitlementsController';
import { SequentialRandom } from '@/crypto/random';
import { MASTER_KEY_LENGTH } from '@/crypto/types';
import { InMemoryCloudBackend, InMemoryCloudStore } from '@/firebase/cloudBackend';
import { DirectoryError, InMemoryDirectory, type Directory } from '@/messaging/directory';
import { deriveMessagingIdentity } from '@/messaging/identity';
import { MessagingService, type MessagingState } from '@/messaging/messagingService';
import { InMemorySecureStore } from '@/secure-storage/secureStore';
import { InMemoryFileSystem } from '@/storage/inMemoryFileSystem';
import { FakeClock } from '@/utils/clock';

const ME = 'me@example.test';
const PEER = 'peer@example.test';
const PASSWORD = 'account-password';

function masterKey(seed: number): Uint8Array {
  const bytes = new Uint8Array(MASTER_KEY_LENGTH);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (seed + i * 11) & 0xff;
  return bytes;
}

/** Naming a peer is several awaits deep: lookup, then the contacts write, then the snapshot. */
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

/** A `let` assigned inside a closure narrows to `never`, so the flaky directory is held here. */
interface Held {
  directory: (Directory & { attempts: () => number }) | null;
}

/**
 * A directory that refuses the reverse lookup a given number of times, then works.
 *
 * `refusal` is what the real one throws when App Check has not vouched for the build -- the
 * failure this was all found through.
 */
function flaky(
  inner: Directory,
  failures: number,
  refusal: () => DirectoryError,
): Directory & { attempts: () => number } {
  let attempts = 0;
  return {
    findByEmail: (email) => inner.findByEmail(email),
    emailForUid: async (uid) => {
      attempts += 1;
      if (attempts <= failures) throw refusal();
      return inner.emailForUid(uid);
    },
    attempts: () => attempts,
  };
}

class World {
  readonly store = new InMemoryCloudStore();

  readonly clock = new FakeClock();

  readonly accounts = new Map<string, string>();

  /** Builds one side. `directory` wraps the shared one so a test can make it misbehave. */
  async join(
    email: string,
    seed: number,
    wrap: (inner: Directory) => Directory = (inner) => inner,
  ): Promise<{ cloud: InMemoryCloudBackend; messaging: MessagingService; uid: string }> {
    const cloud = new InMemoryCloudBackend(new InMemoryFileSystem(), this.store);
    const user = this.accounts.has(email)
      ? await cloud.signIn(email, PASSWORD)
      : await cloud.signUp(email, PASSWORD);
    this.accounts.set(email, user.uid);

    const entitlements = new EntitlementsController({
      secureStore: new InMemorySecureStore(),
      clock: this.clock,
      cloud,
      enforced: false,
    });
    const messaging = new MessagingService({
      cloud,
      directory: wrap(new InMemoryDirectory(this.accounts, () => true, () => true)),
      entitlements,
      clock: this.clock,
      random: new SequentialRandom(seed),
      identity: () => deriveMessagingIdentity(masterKey(seed)),
    });
    return { cloud, messaging, uid: user.uid };
  }
}

/** Opens the Messages list, waits for it to settle, and closes it again. */
async function openMessagesOnce(messaging: MessagingService): Promise<MessagingState> {
  const states: MessagingState[] = [];
  const stop = messaging.watch((state) => states.push(state));
  await flush();
  stop();
  return states[states.length - 1] as MessagingState;
}

function labelOf(state: MessagingState, peerUid: string): string | null {
  return state.conversations.find((one) => one.peerUid === peerUid)?.label ?? null;
}

/**
 * The receiving side of a conversation somebody else started.
 *
 * It has to be this way round. Whoever starts a conversation typed the address, so it is filed
 * on the spot and the directory is never asked. The side with nothing but an account id -- the
 * one that was written to -- is the only one that needs naming, and the only one the bug ever
 * showed on.
 */
async function received(
  wrap: (inner: Directory) => Directory = (inner) => inner,
): Promise<{ me: MessagingService; peerUid: string }> {
  const world = new World();
  const me = await world.join(ME, 1, wrap);
  const peer = await world.join(PEER, 2);
  await me.messaging.publishKey();
  await peer.messaging.startConversation(ME);
  return { me: me.messaging, peerUid: peer.uid };
}

describe('naming the other side of a conversation', () => {
  it('names the peer on the first try when the directory answers', async () => {
    const { me, peerUid } = await received();

    expect(labelOf(await openMessagesOnce(me), peerUid)).toBe(PEER);
  });

  /**
   * The case that was broken. One refusal, then reopening the screen -- which is the only thing
   * a user can actually do -- must produce the name.
   */
  it('asks again the next time the list is opened, after a refusal', async () => {
    // Held in an object: assigned inside a closure, TypeScript narrows a plain `let` to `never`.
    const held: Held = { directory: null };
    const { me, peerUid } = await received((inner) => {
      held.directory = flaky(inner, 1, () => new DirectoryError('attestation'));
      return held.directory;
    });

    // First open: the lookup is refused, so the row keeps showing the account id.
    expect(labelOf(await openMessagesOnce(me), peerUid)).toBeNull();
    expect(held.directory?.attempts()).toBe(1);

    // Second open: asked again, and this time answered.
    expect(labelOf(await openMessagesOnce(me), peerUid)).toBe(PEER);
    expect(held.directory?.attempts()).toBe(2);
  });

  it('keeps asking across several refusals rather than giving up after the first', async () => {
    const held: Held = { directory: null };
    const { me, peerUid } = await received((inner) => {
      held.directory = flaky(inner, 3, () => new DirectoryError('offline'));
      return held.directory;
    });

    for (let open = 0; open < 3; open++) {
      expect(labelOf(await openMessagesOnce(me), peerUid)).toBeNull();
    }
    expect(labelOf(await openMessagesOnce(me), peerUid)).toBe(PEER);
    expect(held.directory?.attempts()).toBe(4);
  });

  /**
   * `rate-limited` is the one refusal that means what the mark says. The hourly budget is spent,
   * and it was spent by asking -- so asking again is both futile and the thing that caused it.
   */
  it('stops asking for the hour when the budget is what ran out', async () => {
    const held: Held = { directory: null };
    const { me } = await received((inner) => {
      held.directory = flaky(inner, 1, () => new DirectoryError('rate-limited'));
      return held.directory;
    });

    await openMessagesOnce(me);
    await openMessagesOnce(me);
    await openMessagesOnce(me);

    expect(held.directory?.attempts()).toBe(1);
  });

  /**
   * A server that answered "nobody" is settled, and re-asking would spend the budget on a
   * question already answered. Only a refusal earns another go.
   */
  it('does not ask again when the directory answered that it has no address', async () => {
    let asked = 0;
    const { me } = await received((inner) => ({
      findByEmail: (email) => inner.findByEmail(email),
      emailForUid: async () => {
        asked += 1;
        return null;
      },
    }));

    await openMessagesOnce(me);
    await openMessagesOnce(me);

    expect(asked).toBe(1);
  });

  /** Two snapshots landing together still ask once between them, which is why the mark exists. */
  it('asks once when the conversations and contacts snapshots arrive together', async () => {
    let asked = 0;
    const gate: { release: () => void } = { release: () => undefined };
    const waiting = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const { me } = await received((inner) => ({
      findByEmail: (email) => inner.findByEmail(email),
      emailForUid: async (uid) => {
        asked += 1;
        await waiting;
        return inner.emailForUid(uid);
      },
    }));

    const stop = me.watch(() => undefined);
    await flush();
    gate.release();
    await flush();
    stop();

    expect(asked).toBe(1);
  });
});
