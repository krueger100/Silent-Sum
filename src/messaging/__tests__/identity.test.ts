import { MASTER_KEY_LENGTH } from '@/crypto/types';
import {
  MessagingIdentityDisposedError,
  deriveMessagingIdentity,
} from '@/messaging/identity';
import { bytesEqual } from '@/utils/bytes';

function masterKey(seed: number): Uint8Array {
  const bytes = new Uint8Array(MASTER_KEY_LENGTH);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (seed + i * 7) & 0xff;
  return bytes;
}

describe('deriveMessagingIdentity', () => {
  it('is deterministic, so a restored vault keeps the same identity', () => {
    const first = deriveMessagingIdentity(masterKey(1));
    const second = deriveMessagingIdentity(masterKey(1));
    expect(bytesEqual(first.publicKey, second.publicKey)).toBe(true);
    expect(bytesEqual(first.contactsKey, second.contactsKey)).toBe(true);
  });

  it('gives different vaults different identities', () => {
    const mine = deriveMessagingIdentity(masterKey(1));
    const theirs = deriveMessagingIdentity(masterKey(2));
    expect(bytesEqual(mine.publicKey, theirs.publicKey)).toBe(false);
    expect(bytesEqual(mine.contactsKey, theirs.contactsKey)).toBe(false);
  });

  it('refuses a master key of the wrong length', () => {
    expect(() => deriveMessagingIdentity(new Uint8Array(16))).toThrow(RangeError);
  });

  it('agrees on the conversation key from either side', () => {
    const alice = deriveMessagingIdentity(masterKey(1));
    const bob = deriveMessagingIdentity(masterKey(2));
    const fromAlice = alice.conversationKey(bob.publicKey, 'a__b');
    const fromBob = bob.conversationKey(alice.publicKey, 'a__b');
    expect(bytesEqual(fromAlice, fromBob)).toBe(true);
    expect(fromAlice).toHaveLength(32);
  });

  it('binds the key to the conversation, so one cannot open another', () => {
    const alice = deriveMessagingIdentity(masterKey(1));
    const bob = deriveMessagingIdentity(masterKey(2));
    expect(
      bytesEqual(alice.conversationKey(bob.publicKey, 'a__b'), alice.conversationKey(bob.publicKey, 'a__c')),
    ).toBe(false);
  });

  it('refuses a peer key of the wrong length and an empty conversation', () => {
    const alice = deriveMessagingIdentity(masterKey(1));
    expect(() => alice.conversationKey(new Uint8Array(8), 'a__b')).toThrow(RangeError);
    expect(() => alice.conversationKey(deriveMessagingIdentity(masterKey(2)).publicKey, '')).toThrow(
      RangeError,
    );
  });

  it('zeroes its key material and refuses everything once disposed', () => {
    const alice = deriveMessagingIdentity(masterKey(1));
    const bob = deriveMessagingIdentity(masterKey(2));
    const peer = Uint8Array.from(bob.publicKey);
    alice.dispose();
    expect(alice.isDisposed).toBe(true);
    expect(() => alice.publicKey).toThrow(MessagingIdentityDisposedError);
    expect(() => alice.contactsKey).toThrow(MessagingIdentityDisposedError);
    expect(() => alice.conversationKey(peer, 'a__b')).toThrow(MessagingIdentityDisposedError);
    alice.dispose();
  });
});
