import {
  EMPTY_THREAD,
  MAX_MESSAGE_LENGTH,
  SUPPORT_CHAT_PATHS,
  checkMessage,
  describeMessageProblem,
  findSensitiveContent,
  parseMessage,
  parseThread,
  readMillis,
  unreadCount,
} from '@/support/chat/supportChat';

describe('paths', () => {
  it('keeps every conversation under the owning uid', () => {
    expect(SUPPORT_CHAT_PATHS.thread('u1')).toBe('users/u1/support/thread');
    expect(SUPPORT_CHAT_PATHS.messages('u1')).toBe('users/u1/support/thread/messages');
    expect(SUPPORT_CHAT_PATHS.message('u1', 'm1')).toBe(
      'users/u1/support/thread/messages/m1',
    );
  });
});

describe('readMillis', () => {
  it('accepts the shapes Firestore and the fakes produce', () => {
    expect(readMillis(1700)).toBe(1700);
    expect(readMillis('2026-09-21T00:00:00.000Z')).toBe(Date.parse('2026-09-21T00:00:00.000Z'));
    expect(readMillis({ toMillis: () => 4200 })).toBe(4200);
    expect(readMillis({ seconds: 2, nanoseconds: 500_000_000 })).toBe(2500);
    expect(readMillis({ _seconds: 3, _nanoseconds: 0 })).toBe(3000);
  });

  it('refuses anything else', () => {
    expect(readMillis(undefined)).toBeNull();
    expect(readMillis('not a date')).toBeNull();
    expect(readMillis({})).toBeNull();
    expect(readMillis(Number.NaN)).toBeNull();
  });
});

describe('parseMessage', () => {
  it('reads a well-formed message from either side', () => {
    expect(parseMessage('m1', { sender: 'user', body: 'hello', createdAt: 10 })).toEqual({
      id: 'm1',
      sender: 'user',
      body: 'hello',
      createdAt: 10,
    });
    expect(parseMessage('m2', { sender: 'support', body: 'hi', createdAt: 20 })?.sender).toBe(
      'support',
    );
  });

  it('skips anything malformed rather than showing it', () => {
    expect(parseMessage('m', { sender: 'nobody', body: 'x', createdAt: 1 })).toBeNull();
    expect(parseMessage('m', { sender: 'user', body: '   ', createdAt: 1 })).toBeNull();
    expect(parseMessage('m', { sender: 'user', body: 'x' })).toBeNull();
    expect(parseMessage('m', { sender: 'user', body: 7, createdAt: 1 })).toBeNull();
  });
});

describe('parseThread', () => {
  it('treats a missing document as never read', () => {
    expect(parseThread(null)).toEqual(EMPTY_THREAD);
    expect(parseThread({})).toEqual({ userLastReadAt: 0 });
    expect(parseThread({ userLastReadAt: 99 })).toEqual({ userLastReadAt: 99 });
  });
});

describe('unreadCount', () => {
  const messages = [
    { id: 'a', sender: 'user' as const, body: 'q', createdAt: 100 },
    { id: 'b', sender: 'support' as const, body: 'r1', createdAt: 200 },
    { id: 'c', sender: 'support' as const, body: 'r2', createdAt: 300 },
  ];

  it('counts only support messages newer than the read marker', () => {
    expect(unreadCount(messages, { userLastReadAt: 0 })).toBe(2);
    expect(unreadCount(messages, { userLastReadAt: 200 })).toBe(1);
    expect(unreadCount(messages, { userLastReadAt: 300 })).toBe(0);
  });

  it('never counts the user their own messages', () => {
    const own = [{ id: 'a', sender: 'user' as const, body: 'q', createdAt: 500 }];
    expect(unreadCount(own, { userLastReadAt: 0 })).toBe(0);
  });
});

describe('findSensitiveContent', () => {
  it('refuses vault ciphertext, keys and headers', () => {
    expect(findSensitiveContent('here is my file SSV1 header')).toBe('vault-data');
    expect(findSensitiveContent(`blob ${'A'.repeat(80)}`)).toBe('vault-data');
    expect(findSensitiveContent(`hex ${'a1b2c3d4'.repeat(6)}`)).toBe('vault-data');
  });

  it('refuses a PIN and anything named as key material', () => {
    expect(findSensitiveContent('my PIN is 4821')).toBe('pin');
    expect(findSensitiveContent('pin: 000000 if that helps')).toBe('pin');
    expect(findSensitiveContent('should I send the master key?')).toBe('key-material');
    expect(findSensitiveContent('my recovery code did not work')).toBe('key-material');
  });

  it('refuses something shaped like the recovery passphrase', () => {
    expect(findSensitiveContent('correct horse battery staple ocean marble')).toBe(
      'recovery-passphrase',
    );
  });

  it('lets an ordinary problem report through', () => {
    expect(findSensitiveContent('The app closes when I open the gallery.')).toBeNull();
    expect(findSensitiveContent('Backup failed with error 3 on Android 14.')).toBeNull();
  });
});

describe('checkMessage', () => {
  it('trims and accepts real text', () => {
    expect(checkMessage('  it crashes  ')).toEqual({ ok: true, body: 'it crashes' });
  });

  it('refuses empty, oversized and secret text', () => {
    expect(checkMessage('   ')).toEqual({ ok: false, problem: 'empty' });
    expect(checkMessage('x'.repeat(MAX_MESSAGE_LENGTH + 1))).toEqual({
      ok: false,
      problem: 'too-long',
    });
    expect(checkMessage('my pin is 1234')).toEqual({ ok: false, problem: 'pin' });
  });
});

describe('describeMessageProblem', () => {
  it('names every problem without echoing what was typed', () => {
    const problems = ['empty', 'too-long', 'vault-data', 'pin', 'recovery-passphrase', 'key-material'] as const;
    for (const problem of problems) {
      const copy = describeMessageProblem(problem);
      expect(copy.length).toBeGreaterThan(0);
    }
    expect(describeMessageProblem('pin')).toMatch(/never send your pin/i);
  });
});
