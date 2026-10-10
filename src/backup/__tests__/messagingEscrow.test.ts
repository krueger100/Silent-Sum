/**
 * Getting an account's messages back, and the one thing that must never take them away.
 *
 * An account's messaging identity is `deriveMessagingIdentity(masterKey)` and the account never
 * rotates the published half, so exactly one key can ever read its conversations. Until the escrow
 * existed that key had one recoverable copy -- the backup envelope -- and `rebindBackup` ends by
 * REPLACING the envelope with the rebinding device's vault key. One rebind destroyed the account's
 * messages permanently, silently, with the failure surfacing weeks later as a refusal.
 *
 * So these specs are two halves. The first is that recovery works across the situations a user
 * actually meets: a new device, a reinstall, a second account, a restored backup. The second, and
 * the one worth distrusting, is that no path writes over a good escrow -- asserted on the stored
 * document itself, byte for byte, because an escrow that is merely *present* after a rebind but
 * holds the rebinding vault's key would pass every test about recovery and still have lost the
 * user's conversations.
 *
 * Driven through `createServices`, so the bridge under test is the one the app wires.
 */
import { messagingEscrowPath } from '@/backup/messagingEscrow';
import { BACKUP_PATHS, type BackupService } from '@/backup/types';
import { CloudError } from '@/firebase/types';
import { deriveMessagingIdentity } from '@/messaging/identity';
import { restoreMessagingIdentity } from '@/messaging/identityRecovery';
import { MESSAGING_PATHS, parsePublishedKey } from '@/messaging/messaging';
import {
  ALICE,
  BOB,
  MessagingWorld,
  PASSWORD,
  flush,
  vaultKeysFor,
  type Account,
} from '@/messaging/screens/__tests__/harness';
import { base64Encode } from '@/utils/base64';
import { zeroBytes } from '@/utils/bytes';

const PASSPHRASE = 'correct horse battery staple';
const OTHER_PASSPHRASE = 'seven green bicycles upstream';
const CAROL = 'carol@example.test';

/** Alice's vault, which is the one that set her messaging up. */
const ALICE_VAULT = 1;
/** A different device entirely: its own master key, so its messaging identity is not Alice's. */
const OTHER_VAULT = 7;

function backupOf(account: Account): BackupService {
  const backup = account.services.backup;
  if (backup === null) throw new Error('expected a backup service');
  return backup;
}

interface Established {
  readonly world: MessagingWorld;
  readonly alice: Account;
  readonly bob: Account;
  readonly conversationId: string;
}

/**
 * Alice, on her own vault, with Cloud backup on and one message sent to Bob.
 *
 * This is the state every real account reaches before anything goes wrong, and the state the
 * escrow is written in.
 */
async function established(): Promise<Established> {
  const world = new MessagingWorld();
  const alice = await world.join(ALICE, ALICE_VAULT);
  const bob = await world.join(BOB, 2);
  await backupOf(alice).enable(alice.services.session.requireKeys(), PASSPHRASE);
  const conversationId = await alice.messaging.startConversation(BOB);
  await alice.messaging.send(conversationId, 'written under the original vault');
  await flush();
  return { world, alice, bob, conversationId };
}

/**
 * Alice's account opened on a DIFFERENT vault -- a new phone, a reinstall, or a second account on
 * a device that already had one. Her own device is left untouched and still signed in.
 */
async function onAnotherDevice(world: MessagingWorld): Promise<Account> {
  const other = await world.join(CAROL, OTHER_VAULT);
  await other.cloud.signOut();
  await other.cloud.signIn(ALICE, PASSWORD);
  return other;
}

function escrowDoc(world: MessagingWorld, uid: string): Record<string, unknown> | undefined {
  return world.store.documents.get(messagingEscrowPath(uid));
}

function publishedKeyOf(world: MessagingWorld, uid: string): string | null {
  const doc = world.store.documents.get(MESSAGING_PATHS.publicKey(uid)) ?? null;
  return parsePublishedKey(uid, doc)?.publicKey ?? null;
}

/** What a thread actually shows, which is the only question that matters to a user. */
async function bodies(account: Account, conversationId: string): Promise<(string | null)[]> {
  let seen: (string | null)[] = [];
  const stop = account.messaging.watchConversation(conversationId, (state) => {
    seen = state.messages.map((message) => message.body);
  });
  await flush();
  stop();
  return seen;
}

describe('the messaging escrow', () => {
  it('is written by the vault that set the account up, holding that vault’s public key', async () => {
    const { world, alice } = await established();

    const stored = escrowDoc(world, alice.uid);
    expect(stored).toBeDefined();
    expect(stored?.publicKey).toBe(publishedKeyOf(world, alice.uid));
    // And it is not the envelope wearing another name: its own salt, its own wrapped key.
    const envelope = world.store.documents.get(BACKUP_PATHS.envelope(alice.uid));
    expect(stored?.salt).not.toEqual(envelope?.salt);
    expect(stored?.wrapped).not.toEqual(envelope?.wrapped);
  });

  /** Changing the passphrase must carry the escrow with it, or it becomes a key nobody can reach. */
  it('is re-wrapped when the recovery passphrase changes', async () => {
    const { world, alice } = await established();
    const before = escrowDoc(world, alice.uid);

    await backupOf(alice).enable(alice.services.session.requireKeys(), OTHER_PASSPHRASE);

    const after = escrowDoc(world, alice.uid);
    expect(after?.wrapped).not.toEqual(before?.wrapped);
    expect(after?.publicKey).toBe(before?.publicKey);

    // And the new passphrase is the one that opens it.
    const key = await backupOf(alice).recoverMessagingKey(OTHER_PASSPHRASE);
    try {
      expect(base64Encode(deriveMessagingIdentity(key).publicKey)).toBe(
        publishedKeyOf(world, alice.uid),
      );
    } finally {
      zeroBytes(key);
    }
  });

  it('is deleted along with everything else when backup is turned off', async () => {
    const { world, alice } = await established();
    expect(escrowDoc(world, alice.uid)).toBeDefined();

    await backupOf(alice).disable();

    expect(escrowDoc(world, alice.uid)).toBeUndefined();
  });

  /**
   * The rules for `users/{uid}/vault/messaging` may not be deployed. Turning backup on must not
   * start failing the day this ships.
   */
  it('does not break enabling backup when the rules refuse it', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, ALICE_VAULT);
    const put = jest
      .spyOn(alice.cloud, 'putDocument')
      .mockImplementation(async (path: string, document: Record<string, unknown>) => {
        if (path === messagingEscrowPath(alice.uid)) throw new CloudError('permission-denied');
        return Object.getPrototypeOf(alice.cloud).putDocument.call(alice.cloud, path, document);
      });

    await expect(
      backupOf(alice).enable(alice.services.session.requireKeys(), PASSPHRASE),
    ).resolves.toBeUndefined();

    expect(world.store.documents.get(BACKUP_PATHS.envelope(alice.uid))).toBeDefined();
    expect(escrowDoc(world, alice.uid)).toBeUndefined();
    put.mockRestore();
  });
});

describe('a rebind', () => {
  /**
   * THE REGRESSION. `rebindBackup` ends with `enable(keys, passphrase)`, which rewrites the
   * envelope with the rebinding vault's key. If it did the same to the escrow, this account's
   * messages would be gone for good and nothing would say so.
   */
  it('leaves the escrow exactly as it was', async () => {
    const { world, alice, conversationId } = await established();
    const before = structuredClone(escrowDoc(world, alice.uid));
    const other = await onAnotherDevice(world);
    const backup = backupOf(other);

    const recovered = await backup.recoverMasterKey(PASSPHRASE);
    const report = await backup.restoreForeignInto(
      other.services.vault.current ?? (await other.services.vault.open(vaultKeysFor(OTHER_VAULT))),
      other.services.session.requireKeys(),
      recovered,
    );
    zeroBytes(recovered);
    await backup.rebindBackup(
      other.services.vault.requireRepository(),
      other.services.session.requireKeys(),
      PASSPHRASE,
      report.cloudIds,
    );

    // The envelope moved, which is what a rebind is for.
    const envelope = world.store.documents.get(BACKUP_PATHS.envelope(alice.uid));
    expect(envelope?.wrapped).toBeDefined();
    // The escrow did not.
    expect(escrowDoc(world, alice.uid)).toEqual(before);
    expect(escrowDoc(world, alice.uid)?.publicKey).toBe(publishedKeyOf(world, alice.uid));

    // And the messages are still reachable on the rebinding device, which is the point.
    await expect(restoreMessagingIdentity(backup, other.messaging, PASSPHRASE)).resolves.toBe('ok');
    expect(await bodies(other, conversationId)).toEqual(['written under the original vault']);
  });

  /** A foreign vault writes no escrow at all, even when the account has none to protect. */
  it('writes no escrow from a vault that is not the account’s', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, ALICE_VAULT);
    await world.join(BOB, 2);
    // Alice published from her own vault, but never enabled backup, so there is no escrow.
    expect(escrowDoc(world, alice.uid)).toBeUndefined();

    const other = await onAnotherDevice(world);
    await backupOf(other).enable(other.services.session.requireKeys(), PASSPHRASE, {
      confirmedCrossAccount: true,
    });

    // Writing this vault's key here would be a lie: it cannot read a single one of Alice's
    // messages, and an escrow that claims otherwise is worse than none.
    expect(escrowDoc(world, alice.uid)).toBeUndefined();
  });
});

describe('recovering messaging on another device', () => {
  it('restores the identity, the thread and the ability to send', async () => {
    const { world, alice, bob, conversationId } = await established();
    const other = await onAnotherDevice(world);
    expect(await bodies(other, conversationId)).toEqual([null]);

    await expect(
      restoreMessagingIdentity(backupOf(other), other.messaging, PASSPHRASE),
    ).resolves.toBe('ok');

    expect(await bodies(other, conversationId)).toEqual(['written under the original vault']);
    // Not just reading: what it sends from here opens on the peer's device, under the key the
    // account published, with no rotation and nothing for Bob to do.
    await other.messaging.send(conversationId, 'sent from the new device');
    await flush();
    bob.messaging.forgetKeys();
    // Order-independent: the harness clock does not advance, so both messages carry the same
    // timestamp and their order is not defined. What is being proved is that BOTH open.
    expect([...(await bodies(bob, conversationId))].sort()).toEqual([
      'sent from the new device',
      'written under the original vault',
    ]);
    expect(publishedKeyOf(world, alice.uid)).toBe(escrowDoc(world, alice.uid)?.publicKey);
  });

  /** A restore already holds the vault key; on a never-rebound account that IS the messaging key. */
  it('uses a key the caller already has rather than deriving a second one', async () => {
    const { alice } = await established();
    const backup = backupOf(alice);
    const recover = jest.spyOn(backup, 'recoverMessagingKey');
    const keys = alice.services.session.requireKeys();

    await expect(
      restoreMessagingIdentity(backup, alice.messaging, PASSPHRASE, {
        vaultMasterKey: keys.masterKey,
      }),
    ).resolves.toBe('ok');

    expect(recover).not.toHaveBeenCalled();
    recover.mockRestore();
  });

  /** Accounts that enabled backup before the escrow existed, and were never rebound. */
  it('falls back to the backup envelope when there is no escrow', async () => {
    const { world, alice, conversationId } = await established();
    world.store.documents.delete(messagingEscrowPath(alice.uid));
    const other = await onAnotherDevice(world);

    await expect(
      restoreMessagingIdentity(backupOf(other), other.messaging, PASSPHRASE),
    ).resolves.toBe('ok');

    expect(await bodies(other, conversationId)).toEqual(['written under the original vault']);
  });

  /** A rebound envelope plus a stale escrow: the escrow is skipped, not used to lie. */
  it('ignores an escrow that is not the key this account publishes', async () => {
    const { world, alice, conversationId } = await established();
    const mine = escrowDoc(world, alice.uid);
    if (mine === undefined) throw new Error('expected an escrow');
    // Someone else's escrow, under the same passphrase: the shape is right and the key is wrong.
    world.store.documents.set(messagingEscrowPath(alice.uid), {
      ...mine,
      publicKey: base64Encode(
        deriveMessagingIdentity(vaultKeysFor(OTHER_VAULT).masterKey).publicKey,
      ),
    });
    const other = await onAnotherDevice(world);

    // The envelope still holds the right key, so the fallback is the correct answer here.
    await expect(
      restoreMessagingIdentity(backupOf(other), other.messaging, PASSPHRASE),
    ).resolves.toBe('ok');
    expect(await bodies(other, conversationId)).toEqual(['written under the original vault']);
  });

  it('says a wrong passphrase is wrong rather than reporting a mismatch', async () => {
    const { world } = await established();
    const other = await onAnotherDevice(world);

    await expect(
      restoreMessagingIdentity(backupOf(other), other.messaging, 'not the passphrase at all'),
    ).rejects.toThrow();
  });

  /**
   * The honest dead end: the escrow never existed AND the envelope has been rebound, which is
   * every account broken before this shipped. There is no key left to find and the refusal says
   * so rather than inventing one.
   */
  it('reports a mismatch when neither the escrow nor the envelope holds the key', async () => {
    const { world, alice, conversationId } = await established();
    world.store.documents.delete(messagingEscrowPath(alice.uid));
    const other = await onAnotherDevice(world);
    // Exactly what a rebind leaves behind: the envelope now wraps the other vault's key.
    await backupOf(other).enable(other.services.session.requireKeys(), PASSPHRASE, {
      confirmedCrossAccount: true,
    });

    await expect(
      restoreMessagingIdentity(backupOf(other), other.messaging, PASSPHRASE),
    ).resolves.toBe('mismatch');

    expect(await bodies(other, conversationId)).toEqual([null]);
    // Nothing was written to the published key, which is the invariant the whole design keeps.
    expect(publishedKeyOf(world, alice.uid)).toBe(
      base64Encode(deriveMessagingIdentity(vaultKeysFor(ALICE_VAULT).masterKey).publicKey),
    );
  });
});

/**
 * The fresh-device flow clears the recovery passphrase the moment it has unwrapped the envelope,
 * which is the right thing to do with it -- and meant a first attempt at this handed the recovery
 * helper an empty string. It passed every test, because the vault key is tried first and on a
 * never-rebound account that key IS the messaging key, so the escrow path was never reached.
 *
 * These two pin the case where it IS reached: the envelope and the escrow hold different keys.
 */
describe('an account whose envelope is not its messaging key', () => {
  /** What the fresh-device screen asks before deciding whether to spend a second Argon2id. */
  it('says the vault key is not the messaging key', async () => {
    const { world, alice } = await established();
    const other = await onAnotherDevice(world);
    // Exactly what a rebind leaves: the envelope now wraps the other vault’s key.
    await backupOf(other).enable(other.services.session.requireKeys(), PASSPHRASE, {
      confirmedCrossAccount: true,
    });

    const envelopeKey = await backupOf(other).recoverMasterKey(PASSPHRASE);
    try {
      await expect(backupOf(other).messagingKeyIsMine(envelopeKey)).resolves.toBe(false);
    } finally {
      zeroBytes(envelopeKey);
    }
    expect(escrowDoc(world, alice.uid)?.publicKey).toBe(publishedKeyOf(world, alice.uid));
  });

  /** And the key it points at is the one that actually opens the thread. */
  it('recovers the messages the envelope cannot open', async () => {
    const { world, conversationId } = await established();
    const other = await onAnotherDevice(world);
    await backupOf(other).enable(other.services.session.requireKeys(), PASSPHRASE, {
      confirmedCrossAccount: true,
    });
    const backup = backupOf(other);

    // Precisely what the screen does: derive while the passphrase is in hand, then use the key.
    const messagingKey = await backup.recoverMessagingKey(PASSPHRASE);
    try {
      await expect(
        restoreMessagingIdentity(backup, other.messaging, '', { messagingMasterKey: messagingKey }),
      ).resolves.toBe('ok');
    } finally {
      zeroBytes(messagingKey);
    }

    expect(await bodies(other, conversationId)).toEqual(['written under the original vault']);
  });
});

/**
 * Contacts come back with the identity, because they were never a separate thing.
 *
 * `deriveMessagingIdentity` yields the X25519 keypair AND the contacts key, both HKDF’d from
 * the same master key, and the labels at `users/{uid}/contacts/{peerUid}` are sealed under the
 * second one. So "restore my contacts" is not a step a user should ever have to find: it is the
 * same recovery, and if it were not, the address book would silently stay blank next to threads
 * that had started working again.
 */
describe('contact labels', () => {
  it('are readable again once the identity is recovered, with no separate step', async () => {
    const { world, conversationId } = await established();
    const other = await onAnotherDevice(world);
    // The conversation LIST is what subscribes to contacts, exactly as the app does before a
    // thread can be opened at all. Without it there is no address book to recover.
    const stopList = other.messaging.watch(() => undefined);
    await flush();

    const labelNow = async (): Promise<string | null> => {
      let label: string | null = null;
      const stop = other.messaging.watchConversation(conversationId, (state) => {
        label = state.label;
      });
      await flush();
      stop();
      return label;
    };

    // Sealed under the identity this vault does not have.
    expect(await labelNow()).toBeNull();

    await restoreMessagingIdentity(backupOf(other), other.messaging, PASSPHRASE);

    expect(await labelNow()).toBe(BOB);
    stopList();
  });
});

/**
 * Found on a device, not in a test: an account whose backup holds no photos.
 *
 * A user restoring such an account is usually doing it to get their MESSAGES back, and that is
 * precisely the shape where the status line used to say "There was nothing in the backup to
 * restore." and throw the messaging result away along with the rest of the sentence.
 */
describe('an account whose backup holds no photos', () => {
  it('still recovers messaging from the envelope', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, ALICE_VAULT);
    await world.join(BOB, 2);
    // Backup on, messages sent, but not one photo ever uploaded.
    await backupOf(alice).enable(alice.services.session.requireKeys(), PASSPHRASE);
    const conversationId = await alice.messaging.startConversation(BOB);
    await alice.messaging.send(conversationId, 'written under the original vault');
    await flush();

    const other = await onAnotherDevice(world);
    const backup = backupOf(other);
    const recovered = await backup.recoverMasterKey(PASSPHRASE);
    try {
      await expect(
        restoreMessagingIdentity(backup, other.messaging, PASSPHRASE, {
          vaultMasterKey: recovered,
        }),
      ).resolves.toBe('ok');
    } finally {
      zeroBytes(recovered);
    }

    expect(await bodies(other, conversationId)).toEqual(['written under the original vault']);
  });

  /**
   * With no escrow, `recoverMessagingKey` IS `recoverMasterKey`, so a second derivation can only
   * hand back the key that was just refused. On a phone that is a slow spinner bought for nothing.
   */
  it('does not buy the same refusal twice when there is no escrow', async () => {
    const { world, alice } = await established();
    world.store.documents.delete(messagingEscrowPath(alice.uid));
    const other = await onAnotherDevice(world);
    const backup = backupOf(other);
    const recover = jest.spyOn(backup, 'recoverMessagingKey');

    await expect(
      restoreMessagingIdentity(backup, other.messaging, PASSPHRASE, {
        vaultMasterKey: vaultKeysFor(OTHER_VAULT).masterKey,
      }),
    ).resolves.toBe('mismatch');

    expect(recover).not.toHaveBeenCalled();
    recover.mockRestore();
  });
});

/**
 * Reaching the accounts `enable` never will.
 *
 * The escrow was only written when backup was turned on or the passphrase changed. An account
 * that already had backup on therefore never got one -- which is most of them, and exactly the
 * ones still stuck on the device that set them up. No ownership CHECK caused that: the key
 * simply existed nowhere a second device could reach.
 *
 * It cannot be made without the passphrase. What can be avoided is asking twice, so it is
 * written at the moments the passphrase is already in hand.
 */
describe('protecting the messaging key outside enable()', () => {
  it('creates an escrow for an account that never had one', async () => {
    const { world, alice } = await established();
    world.store.documents.delete(messagingEscrowPath(alice.uid));
    expect(escrowDoc(world, alice.uid)).toBeUndefined();

    const backup = backupOf(alice);
    const master = await backup.recoverMasterKey(PASSPHRASE);
    try {
      await backup.protectMessagingKey(master, PASSPHRASE);
    } finally {
      zeroBytes(master);
    }

    const written = escrowDoc(world, alice.uid);
    expect(written).toBeDefined();
    expect(written?.publicKey).toBe(publishedKeyOf(world, alice.uid));
  });

  /** The rule that makes a rebind safe applies here too: a foreign vault writes nothing. */
  it('refuses to write a key the account does not publish', async () => {
    const { world, alice } = await established();
    world.store.documents.delete(messagingEscrowPath(alice.uid));
    const other = await onAnotherDevice(world);

    await backupOf(other).protectMessagingKey(vaultKeysFor(OTHER_VAULT).masterKey, PASSPHRASE);

    expect(escrowDoc(world, alice.uid)).toBeUndefined();
  });

  /** And it never clobbers a good escrow with a wrong one. */
  it('leaves an existing escrow untouched when the key is not the account’s', async () => {
    const { world, alice } = await established();
    const before = structuredClone(escrowDoc(world, alice.uid));
    const other = await onAnotherDevice(world);

    await backupOf(other).protectMessagingKey(vaultKeysFor(OTHER_VAULT).masterKey, PASSPHRASE);

    expect(escrowDoc(world, alice.uid)).toEqual(before);
  });

  /**
   * The point of all of it: once an escrow exists, a REBIND can no longer end recovery. Before
   * this, an account on its original device had no escrow, so the first rebind was fatal.
   */
  it('survives a rebind that would previously have ended recovery', async () => {
    const { world, alice, conversationId } = await established();
    // An account from before the escrow existed, now protected at a moment it already had the
    // passphrase.
    world.store.documents.delete(messagingEscrowPath(alice.uid));
    const own = await backupOf(alice).recoverMasterKey(PASSPHRASE);
    try {
      await backupOf(alice).protectMessagingKey(own, PASSPHRASE);
    } finally {
      zeroBytes(own);
    }

    // Now the rebind: a different vault adopts the account and rewrites the envelope.
    const other = await onAnotherDevice(world);
    await backupOf(other).enable(other.services.session.requireKeys(), PASSPHRASE, {
      confirmedCrossAccount: true,
    });

    // The envelope is no longer the messaging key -- and recovery works anyway.
    await expect(
      restoreMessagingIdentity(backupOf(other), other.messaging, PASSPHRASE),
    ).resolves.toBe('ok');
    expect(await bodies(other, conversationId)).toEqual(['written under the original vault']);
  });

  it('does nothing with nobody signed in', async () => {
    const { world, alice } = await established();
    const before = structuredClone(escrowDoc(world, alice.uid));
    await alice.cloud.signOut();

    await expect(
      backupOf(alice).protectMessagingKey(vaultKeysFor(ALICE_VAULT).masterKey, PASSPHRASE),
    ).resolves.toBeUndefined();

    expect(escrowDoc(world, alice.uid)).toEqual(before);
  });
});

describe('account isolation', () => {
  /** One account's escrow must never become another account's messaging key. */
  it('does not let one account’s escrow reach another account', async () => {
    const { world, alice } = await established();
    const other = await onAnotherDevice(world);
    await restoreMessagingIdentity(backupOf(other), other.messaging, PASSPHRASE);

    // The same device now signs in as Carol, who has her own vault and her own identity.
    await other.cloud.signOut();
    await other.cloud.signIn(CAROL, PASSWORD);
    await other.messaging.publishKey();
    await flush();

    // Carol's published key is her own vault's, not Alice's recovered one.
    const carolUid = world.accounts.get(CAROL) ?? '';
    expect(publishedKeyOf(world, carolUid)).toBe(
      base64Encode(deriveMessagingIdentity(vaultKeysFor(OTHER_VAULT).masterKey).publicKey),
    );
    expect(publishedKeyOf(world, carolUid)).not.toBe(publishedKeyOf(world, alice.uid));
    // And Carol's account has no escrow of Alice's to read.
    expect(escrowDoc(world, carolUid)).toBeUndefined();
  });

  /** The escrow is addressed by uid, so there is no id a caller could pass to reach another. */
  it('reads only the signed-in account’s escrow', async () => {
    const { world, alice } = await established();
    const other = await onAnotherDevice(world);
    await other.cloud.signOut();
    await other.cloud.signIn(CAROL, PASSWORD);

    // Carol has no backup at all, so there is nothing to recover -- not Alice's, not anyone's.
    await expect(backupOf(other).recoverMessagingKey(PASSPHRASE)).rejects.toThrow();
    expect(escrowDoc(world, alice.uid)).toBeDefined();
  });
});
