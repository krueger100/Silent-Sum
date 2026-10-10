/**
 * Signing back into an account you already had, on the device you already had it on.
 *
 * `accountSwitch.test.ts` proves the SAFETY half of switching: that B is never handed A's
 * conversations, contacts or keys. Nothing proved the other half -- that A gets its own back --
 * and the two are not the same claim. A service that blanked everything forever would pass every
 * isolation spec in that file and leave the user with an empty app.
 *
 * One services instance throughout, because that is what one device is: one vault, one master
 * key, one `MessagingService` outliving both sign-ins.
 */
import { EntitlementsController } from '@/billing/entitlementsController';
import { deriveVaultKeys } from '@/crypto';
import { SodiumSecureRandom } from '@/crypto/random';
import { InMemoryCloudBackend, InMemoryCloudStore } from '@/firebase/cloudBackend';
import { InMemoryDirectory } from '@/messaging/directory';
import { HiddenMessages } from '@/messaging/hiddenMessages';
import { deriveMessagingIdentity, type MessagingIdentity } from '@/messaging/identity';
import { MessagingService, type ConversationState } from '@/messaging/messagingService';
import { InMemorySecureStore } from '@/secure-storage/secureStore';
import { FakeClock } from '@/utils/clock';

const random = new SodiumSecureRandom();
const PASSWORD = 'account-password';
const ALICE = 'alice@example.test';
const CAROL = 'carol@example.test';
const BOB = 'bob@example.test';

function masterKey(seed: number): Uint8Array {
  return new Uint8Array(32).fill(seed);
}

interface Device {
  readonly messaging: MessagingService;
  readonly cloud: InMemoryCloudBackend;
  readonly identity: MessagingIdentity;
}

/**
 * One phone. The identity is derived ONCE from the vault's master key and never re-derived,
 * exactly as the composition root does it: the vault does not change when the account does.
 */
function makeDevice(
  store: InMemoryCloudStore,
  accounts: Map<string, string>,
  seed: number,
): Device {
  const cloud = new InMemoryCloudBackend(null, store);
  const clock = new FakeClock();
  const identity = deriveMessagingIdentity(deriveVaultKeys(masterKey(seed)).masterKey);
  const entitlements = new EntitlementsController({
    secureStore: new InMemorySecureStore(),
    clock,
    cloud,
    enforced: false,
  });
  const messaging = new MessagingService({
    cloud,
    directory: new InMemoryDirectory(
      accounts,
      () => true,
      () => false,
    ),
    conversationAdmin: null,
    entitlements,
    clock,
    random,
    identity: () => identity,
    hidden: new HiddenMessages(new InMemorySecureStore()),
  });
  return { messaging, cloud, identity };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

/** The bodies a thread shows right now. `null` is a message this device cannot open. */
async function bodies(device: Device, conversationId: string): Promise<(string | null)[]> {
  let seen: (string | null)[] = [];
  const stop = device.messaging.watchConversation(conversationId, (state: ConversationState) => {
    seen = state.messages.map((message) => message.body);
  });
  await flush();
  stop();
  return seen;
}

describe('signing back into an account on the same device', () => {
  /**
   * SCENARIO A. One vault, two accounts, and the user going back to the first.
   *
   * The identity derives from the vault's master key alone, and the vault has not moved, so the
   * key that sealed these messages is the key this device still holds. Nothing needs recovering
   * and nothing may be in the way.
   */
  it('gives the account its own messages back', async () => {
    const store = new InMemoryCloudStore();
    const accounts = new Map<string, string>();

    const device = makeDevice(store, accounts, 1);
    const peerDevice = makeDevice(store, accounts, 2);

    const alice = await device.cloud.signUp(ALICE, PASSWORD);
    accounts.set(ALICE, alice.uid);
    const bob = await peerDevice.cloud.signUp(BOB, PASSWORD);
    accounts.set(BOB, bob.uid);
    await peerDevice.messaging.publishKey();
    await device.messaging.publishKey();

    const conversationId = await device.messaging.startConversation(BOB);
    await device.messaging.send(conversationId, 'written while signed in as Alice');
    await flush();
    expect(await bodies(device, conversationId)).toEqual(['written while signed in as Alice']);

    // Away to another account on the SAME vault, and back again.
    await device.cloud.signOut();
    const carol = await device.cloud.signUp(CAROL, PASSWORD);
    accounts.set(CAROL, carol.uid);
    await device.messaging.publishKey();
    await flush();

    await device.cloud.signOut();
    await device.cloud.signIn(ALICE, PASSWORD);
    await device.messaging.publishKey();
    await flush();

    expect(await bodies(device, conversationId)).toEqual(['written while signed in as Alice']);
  });

  /** And the composer is open again, not stuck behind a foreign-vault refusal. */
  it('does not call the account foreign on the vault that set it up', async () => {
    const store = new InMemoryCloudStore();
    const accounts = new Map<string, string>();
    const device = makeDevice(store, accounts, 1);
    const peerDevice = makeDevice(store, accounts, 2);

    const alice = await device.cloud.signUp(ALICE, PASSWORD);
    accounts.set(ALICE, alice.uid);
    const bob = await peerDevice.cloud.signUp(BOB, PASSWORD);
    accounts.set(BOB, bob.uid);
    await peerDevice.messaging.publishKey();
    await device.messaging.publishKey();
    const conversationId = await device.messaging.startConversation(BOB);
    await flush();

    await device.cloud.signOut();
    const carol = await device.cloud.signUp(CAROL, PASSWORD);
    accounts.set(CAROL, carol.uid);
    await device.messaging.publishKey();
    await flush();
    await device.cloud.signOut();
    await device.cloud.signIn(ALICE, PASSWORD);
    await device.messaging.publishKey();
    await flush();

    let state: ConversationState | undefined;
    const stop = device.messaging.watchConversation(conversationId, (next) => {
      state = next;
    });
    await flush();
    stop();

    expect(state).toBeDefined();
    expect(state?.sendBlocked).toBeNull();
    expect(state?.canSend).toBe(true);
  });

  /**
   * SCENARIO D, from the other side. Carol is on the same vault, so she derives the SAME
   * messaging identity as Alice -- the derivation takes the master key and no uid. That must not
   * become a way to read Alice's messages.
   */
  it('does not let the other account on the same vault read the first one’s thread', async () => {
    const store = new InMemoryCloudStore();
    const accounts = new Map<string, string>();
    const device = makeDevice(store, accounts, 1);
    const peerDevice = makeDevice(store, accounts, 2);

    const alice = await device.cloud.signUp(ALICE, PASSWORD);
    accounts.set(ALICE, alice.uid);
    const bob = await peerDevice.cloud.signUp(BOB, PASSWORD);
    accounts.set(BOB, bob.uid);
    await peerDevice.messaging.publishKey();
    await device.messaging.publishKey();
    const conversationId = await device.messaging.startConversation(BOB);
    await device.messaging.send(conversationId, 'written while signed in as Alice');
    await flush();

    await device.cloud.signOut();
    const carol = await device.cloud.signUp(CAROL, PASSWORD);
    accounts.set(CAROL, carol.uid);
    await device.messaging.publishKey();
    await flush();

    // Carol is not a member, so the conversation is not hers to open at all.
    await expect(bodies(device, conversationId)).resolves.not.toContain(
      'written while signed in as Alice',
    );
  });
});
