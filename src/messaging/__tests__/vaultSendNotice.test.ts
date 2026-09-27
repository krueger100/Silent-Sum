import { VaultSendNotice } from '@/messaging/vaultSendNotice';
import {
  ALL_SECURE_STORE_KEYS,
  InMemorySecureStore,
  SECURE_STORE_KEYS,
} from '@/secure-storage/secureStore';

describe('VaultSendNotice', () => {
  it('has not been seen in a conversation it has never been shown in', async () => {
    const notice = new VaultSendNotice(new InMemorySecureStore());
    await expect(notice.hasSeen('a__b')).resolves.toBe(false);
  });

  // Who the copy is going to is the part that matters, so a new conversation asks again.
  it('remembers per conversation, not globally', async () => {
    const notice = new VaultSendNotice(new InMemorySecureStore());
    await notice.markSeen('a__b');
    await expect(notice.hasSeen('a__b')).resolves.toBe(true);
    await expect(notice.hasSeen('a__c')).resolves.toBe(false);
  });

  it('survives a restart', async () => {
    const store = new InMemorySecureStore();
    await new VaultSendNotice(store).markSeen('a__b');
    await expect(new VaultSendNotice(store).hasSeen('a__b')).resolves.toBe(true);
  });

  it('does not grow a duplicate when marked twice', async () => {
    const store = new InMemorySecureStore();
    const notice = new VaultSendNotice(store);
    await notice.markSeen('a__b');
    await notice.markSeen('a__b');
    const raw = store.snapshot[SECURE_STORE_KEYS.vaultSendNotice] ?? '{}';
    expect((JSON.parse(raw) as { conversations: string[] }).conversations).toEqual(['a__b']);
  });

  // A corrupt row must not make the app unable to send; it must make it ask again.
  it('treats an unreadable record as nothing seen', async () => {
    const store = new InMemorySecureStore({ [SECURE_STORE_KEYS.vaultSendNotice]: '{not json' });
    await expect(new VaultSendNotice(store).hasSeen('a__b')).resolves.toBe(false);
  });

  it('ignores a record of the wrong shape', async () => {
    const store = new InMemorySecureStore({
      [SECURE_STORE_KEYS.vaultSendNotice]: JSON.stringify({ v: 2, conversations: ['a__b'] }),
    });
    await expect(new VaultSendNotice(store).hasSeen('a__b')).resolves.toBe(false);
  });

  it('is erased with the vault', () => {
    expect(ALL_SECURE_STORE_KEYS).toContain(SECURE_STORE_KEYS.vaultSendNotice);
  });
});
