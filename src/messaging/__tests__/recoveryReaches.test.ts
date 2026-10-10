/**
 * Recovery has to reach the user, and reach every screen when it lands.
 *
 * The crypto worked before these specs and the user still could not get their messages. Two
 * reasons, both about reachability rather than keys:
 *
 *   - `foreignVault` was published by the service and read by no screen, so the only way to the
 *     recovery panel was to open one conversation and scroll past the messages it had just failed
 *     to open. A list of five broken threads gave no hint that one passphrase fixed all five.
 *   - Recovery writes nothing to the server -- deliberately -- so nothing re-emitted afterwards.
 *     One screen worked around that with a counter of its own; the list had none, so recovering
 *     from the list would have left the list exactly as it was.
 *
 * These pin the service half. `ConversationsScreen` reading `state.foreignVault` is pinned in its
 * own screen spec.
 */
import { BOB, MessagingWorld, flush, vaultKeysFor } from '@/messaging/screens/__tests__/harness';
import type { Account } from '@/messaging/screens/__tests__/harness';
import { ALICE } from '@/messaging/screens/__tests__/harness';
import type { ConversationState, MessagingState } from '@/messaging/messagingService';

/**
 * The trace specs below need a build whose diagnostics are switched on. That is decided by
 * `extra.silentsumEnv`, not `__DEV__` -- deliberately, so a dev-environment RELEASE apk still
 * talks -- and Jest's `extra` is empty, so the flag is supplied here.
 */
jest.mock('expo-constants', () => {
  const actual = jest.requireActual('expo-constants') as {
    readonly default: { readonly expoConfig?: Record<string, unknown> };
  };
  return {
    // Spreading the real module drops this: it is defined non-enumerably, and without it the
    // default-import interop hands back the whole namespace instead of `default`.
    __esModule: true,
    ...actual,
    default: {
      ...actual.default,
      expoConfig: { ...actual.default.expoConfig, extra: { silentsumEnv: 'dev' } },
    },
  };
});

const OWN_VAULT = 1;
const OTHER_VAULT = 7;

/**
 * Alice's account, with one message, now open on a vault that did not set its messaging up.
 *
 * The vault is swapped underneath the session rather than a second device being built, because
 * what is under test is the service's own notification, not the composition root.
 */
async function stranded(): Promise<{ alice: Account; conversationId: string }> {
  const world = new MessagingWorld();
  const alice = await world.join(ALICE, OWN_VAULT);
  await world.join(BOB, 2);
  const conversationId = await alice.messaging.startConversation(BOB);
  await alice.messaging.send(conversationId, 'written under the original vault');
  await flush();

  alice.services.session.lock();
  alice.services.session.adopt(vaultKeysFor(OTHER_VAULT));
  await alice.messaging.publishKey();
  await flush();
  return { alice, conversationId };
}

describe('an account whose messaging belongs to another vault', () => {
  /** What the LIST knows, which is what the list has to be able to say. */
  it('tells the conversation list, not only an opened thread', async () => {
    const { alice } = await stranded();

    let seen: MessagingState | undefined;
    const stop = alice.messaging.watch((next) => {
      seen = next;
    });
    await flush();
    stop();

    expect(seen?.foreignVault).toBe(true);
  });

  /**
   * The notifier. An OPEN thread must re-read when the identity is recovered -- the conversation
   * key is HKDF(ECDH(peer, mine)) and "mine" has just changed, so the same stored ciphertext
   * opens under a different key with nothing arriving from the server to say so.
   */
  it('re-reads an already-open thread the moment the identity is recovered', async () => {
    const { alice, conversationId } = await stranded();

    const seen: (string | null)[][] = [];
    const stop = alice.messaging.watchConversation(conversationId, (state: ConversationState) => {
      seen.push(state.messages.map((message) => message.body));
    });
    await flush();
    expect(seen[seen.length - 1]).toEqual([null]);

    // No re-subscribe, no remount: the thread is left exactly as the user left it.
    await alice.messaging.useRecoveredMasterKey(vaultKeysFor(OWN_VAULT).masterKey);
    await flush();

    expect(seen[seen.length - 1]).toEqual(['written under the original vault']);
    stop();
  });

  /** And the composer in that same open thread stops being blocked. */
  it('unblocks an already-open composer without a remount', async () => {
    const { alice, conversationId } = await stranded();

    let state: ConversationState | undefined;
    const stop = alice.messaging.watchConversation(conversationId, (next) => {
      state = next;
    });
    await flush();
    expect(state?.sendBlocked).toBe('foreign-vault');

    await alice.messaging.useRecoveredMasterKey(vaultKeysFor(OWN_VAULT).masterKey);
    await flush();

    expect(state?.sendBlocked).toBeNull();
    expect(state?.canSend).toBe(true);
    stop();
  });

  /** An open LIST clears its own banner, which is what makes recovering from it coherent. */
  it('re-emits the list so its banner goes when recovery succeeds', async () => {
    const { alice } = await stranded();

    let seen: MessagingState | undefined;
    const stop = alice.messaging.watch((next) => {
      seen = next;
    });
    await flush();
    expect(seen?.foreignVault).toBe(true);

    await alice.messaging.useRecoveredMasterKey(vaultKeysFor(OWN_VAULT).masterKey);
    await flush();

    expect(seen?.foreignVault).toBe(false);
    stop();
  });

  /** A refused recovery must not quietly clear the banner it could not fix. */
  it('leaves the banner standing when the key is not the account’s', async () => {
    const { alice } = await stranded();

    let seen: MessagingState | undefined;
    const stop = alice.messaging.watch((next) => {
      seen = next;
    });
    await flush();

    await expect(alice.messaging.useRecoveredMasterKey(vaultKeysFor(9).masterKey)).resolves.toBe(
      'mismatch',
    );
    await flush();

    expect(seen?.foreignVault).toBe(true);
    stop();
  });

  /** Nothing is left subscribed after the screens close. */
  it('stops notifying a thread and a list that have gone away', async () => {
    const { alice, conversationId } = await stranded();

    let threadEmits = 0;
    let listEmits = 0;
    const stopThread = alice.messaging.watchConversation(conversationId, () => {
      threadEmits += 1;
    });
    const stopList = alice.messaging.watch(() => {
      listEmits += 1;
    });
    await flush();
    stopThread();
    stopList();
    const threadBefore = threadEmits;
    const listBefore = listEmits;

    await alice.messaging.useRecoveredMasterKey(vaultKeysFor(OWN_VAULT).masterKey);
    await flush();

    expect(threadEmits).toBe(threadBefore);
    expect(listEmits).toBe(listBefore);
  });
});

/**
 * The trace exists so a developer can tell a refused escrow from a stale one from a wrong
 * passphrase. It must do that without becoming the thing it is diagnosing.
 *
 * Asserted against the ACTUAL bytes of the key and the ACTUAL message body rather than a pattern,
 * because a pattern only catches the leak somebody already thought of.
 */
describe('the recovery trace', () => {
  it('names the stages without printing a key, a passphrase or a message', async () => {
    const { alice, conversationId } = await stranded();
    const lines: string[] = [];
    const warn = jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(' '));
    });

    const master = vaultKeysFor(OWN_VAULT).masterKey;
    await alice.messaging.useRecoveredMasterKey(master);
    await flush();
    const bodies = await (async () => {
      let seen: (string | null)[] = [];
      const stop = alice.messaging.watchConversation(conversationId, (state) => {
        seen = state.messages.map((m) => m.body);
      });
      await flush();
      stop();
      return seen;
    })();
    warn.mockRestore();

    const transcript = lines.join('\n');
    // It said something useful.
    expect(transcript).toMatch(/\[silentsum\/recovery\]/);
    expect(transcript).toMatch(/key-matched/);
    expect(transcript).toMatch(/applied/);

    // And nothing it should not have. The master key, in every encoding it could plausibly be
    // written in.
    const hex = [...master].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(transcript).not.toContain(hex);
    expect(transcript).not.toContain(Buffer.from(master).toString('base64'));
    expect(transcript).not.toContain([...master].join(','));
    // The message that had just become readable.
    expect(bodies).toEqual(['written under the original vault']);
    expect(transcript).not.toContain('written under the original vault');
  });

  /** A refusal is the case most likely to tempt somebody into printing the key that failed. */
  it('says a mismatch happened without printing either key in full', async () => {
    const { alice } = await stranded();
    const lines: string[] = [];
    const warn = jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      lines.push(args.map((a) => String(a)).join(' '));
    });

    const wrong = vaultKeysFor(9).masterKey;
    await expect(alice.messaging.useRecoveredMasterKey(wrong)).resolves.toBe('mismatch');
    warn.mockRestore();

    const transcript = lines.join('\n');
    expect(transcript).toMatch(/key-mismatched/);
    const hex = [...wrong].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect(transcript).not.toContain(hex);
    expect(transcript).not.toContain(Buffer.from(wrong).toString('base64'));
  });
});
