import {
  InvalidUidError,
  MESSAGING_PATHS,
  byRecency,
  checkMessage,
  conversationIdFor,
  conversationRecord,
  deletedMessageRecord,
  looksLikeEmail,
  membersOf,
  parseConversation,
  parsePublishedKey,
  parseStoredMessage,
  peerOf,
  type Conversation,
} from '@/messaging/messaging';

const A = 'aaa111';
const B = 'bbb222';
const CID = 'aaa111__bbb222';

describe('conversation ids', () => {
  it('is the same id whichever side asks', () => {
    expect(conversationIdFor(A, B)).toBe(CID);
    expect(conversationIdFor(B, A)).toBe(CID);
  });

  it('refuses ids that would make a path ambiguous, and talking to yourself', () => {
    expect(() => conversationIdFor(A, A)).toThrow(InvalidUidError);
    expect(() => conversationIdFor('', B)).toThrow(InvalidUidError);
    expect(() => conversationIdFor('a/b', B)).toThrow(InvalidUidError);
    expect(() => conversationIdFor('a__b', B)).toThrow(InvalidUidError);
    expect(() => conversationIdFor('a.b', B)).toThrow(InvalidUidError);
  });

  it('reads the membership back out, and rejects anything else', () => {
    expect(membersOf(CID)).toEqual([A, B]);
    expect(peerOf(CID, A)).toBe(B);
    expect(peerOf(CID, B)).toBe(A);
    expect(peerOf(CID, 'someone-else')).toBeNull();
    expect(membersOf('nonsense')).toBeNull();
    expect(membersOf('a__b__c')).toBeNull();
    expect(membersOf('same__same')).toBeNull();
  });

  it('puts every document under its own collection', () => {
    expect(MESSAGING_PATHS.conversation(CID)).toBe(`conversations/${CID}`);
    expect(MESSAGING_PATHS.messages(CID)).toBe(`conversations/${CID}/messages`);
    expect(MESSAGING_PATHS.message(CID, 'm1')).toBe(`conversations/${CID}/messages/m1`);
    expect(MESSAGING_PATHS.publicKey(A)).toBe(`messagingKeys/${A}`);
    expect(MESSAGING_PATHS.mediaObject(CID, 'photo', 'm1')).toBe(`messages/${CID}/photo/m1`);
    expect(MESSAGING_PATHS.thumbObject(CID, 'm1')).toBe(`messages/${CID}/thumb/m1`);
    // Nothing may land in the support conversation's subtree.
    const built = [
      MESSAGING_PATHS.publicKey(A),
      MESSAGING_PATHS.conversations(),
      MESSAGING_PATHS.conversation(CID),
      MESSAGING_PATHS.messages(CID),
      MESSAGING_PATHS.message(CID, 'm1'),
      MESSAGING_PATHS.mediaObject(CID, 'video', 'm1'),
      MESSAGING_PATHS.thumbObject(CID, 'm1'),
      MESSAGING_PATHS.mediaPrefix(CID),
    ];
    for (const path of built) {
      expect(path).not.toContain('/support/');
    }
  });
});

describe('parsing', () => {
  const record = conversationRecord([A, B], A, 1000);

  it('reads a conversation from the side that is asking', () => {
    const mine = parseConversation(CID, { ...record, unread: { [A]: 2, [B]: 0 } }, A);
    expect(mine).toMatchObject({ peerUid: B, unread: 2, lastMessageAt: 1000 });
    const theirs = parseConversation(CID, { ...record, unread: { [A]: 2, [B]: 0 } }, B);
    expect(theirs).toMatchObject({ peerUid: A, unread: 0 });
  });

  it('refuses a conversation this account is not in, or whose members disagree with the id', () => {
    expect(parseConversation(CID, record, 'ccc333')).toBeNull();
    expect(parseConversation(CID, { ...record, members: [A, 'ccc333'] }, A)).toBeNull();
    expect(parseConversation(CID, { ...record, members: [A] }, A)).toBeNull();
  });

  it('treats a missing or nonsense unread count as zero', () => {
    expect(parseConversation(CID, { ...record, unread: {} }, A)?.unread).toBe(0);
    expect(parseConversation(CID, { ...record, unread: { [A]: -3 } }, A)?.unread).toBe(0);
    expect(parseConversation(CID, { ...record, unread: 'nope' }, A)?.unread).toBe(0);
  });

  it('keeps only well-formed messages', () => {
    expect(
      parseStoredMessage('m1', { v: 1, from: A, box: 'Ym94', nonce: 'bm9uY2U=', createdAt: 5 }),
    ).toEqual({
      id: 'm1',
      from: A,
      box: 'Ym94',
      nonce: 'bm9uY2U=',
      createdAt: 5,
      kind: null,
      object: null,
      bytes: 0,
      thumbObject: null,
      deleted: false,
    });
    expect(parseStoredMessage('m1', { from: A, box: '', nonce: 'n', createdAt: 5 })).toBeNull();
    expect(parseStoredMessage('m1', { from: A, box: 'b', nonce: 'n' })).toBeNull();
    expect(parseStoredMessage('m1', { box: 'b', nonce: 'n', createdAt: 5 })).toBeNull();
  });

  describe('withdrawn messages', () => {
    const tombstone = { v: 1, from: A, createdAt: 5, deletedAt: 9 };

    // The alternative -- dropping it -- leaves a hole the reader cannot tell from "they never
    // wrote", which is the one failure the placeholder exists to prevent.
    it('is kept and marked rather than dropped, even with no ciphertext left', () => {
      expect(parseStoredMessage('m1', tombstone)).toEqual({
        id: 'm1',
        from: A,
        box: '',
        nonce: '',
        createdAt: 5,
        kind: null,
        object: null,
        bytes: 0,
        thumbObject: null,
        deleted: true,
      });
    });

    // The tombstone wins over anything else in the document, so a record that somehow still
    // carried ciphertext could not be rendered as readable by this client.
    it('never surfaces content that survived beside the tombstone', () => {
      const parsed = parseStoredMessage('m1', {
        ...tombstone,
        box: 'Ym94',
        nonce: 'bm9uY2U=',
        kind: 'photo',
        object: `messages/${CID}/photo/m1`,
        bytes: 1234,
        thumbObject: `messages/${CID}/thumb/m1`,
      });
      expect(parsed?.deleted).toBe(true);
      expect(parsed?.box).toBe('');
      expect(parsed?.nonce).toBe('');
      expect(parsed?.object).toBeNull();
      expect(parsed?.thumbObject).toBeNull();
      expect(parsed?.kind).toBeNull();
    });

    it('still refuses one with no sender or no timestamp', () => {
      expect(parseStoredMessage('m1', { v: 1, createdAt: 5, deletedAt: 9 })).toBeNull();
      expect(parseStoredMessage('m1', { v: 1, from: A, deletedAt: 9 })).toBeNull();
    });

    it('writes a record with nothing in it but who and when', () => {
      expect(deletedMessageRecord(A, 5, 9)).toEqual({ v: 1, from: A, createdAt: 5, deletedAt: 9 });
    });
  });

  describe('media records', () => {
    const text = { v: 1, from: A, box: 'Ym94', nonce: 'bm9uY2U=', createdAt: 5 };
    const photo = {
      ...text,
      kind: 'photo',
      object: `messages/${CID}/photo/m2`,
      bytes: 1234,
      thumbObject: `messages/${CID}/thumb/m2`,
    };

    // Nothing sent before this feature existed carries a kind, and all of it must keep working.
    it('reads a record with no kind as text', () => {
      expect(parseStoredMessage('m1', text)).toMatchObject({ kind: null, object: null });
    });

    it('reads a photo record', () => {
      expect(parseStoredMessage('m2', photo)).toMatchObject({
        kind: 'photo',
        object: `messages/${CID}/photo/m2`,
        bytes: 1234,
        thumbObject: `messages/${CID}/thumb/m2`,
      });
    });

    // An unknown kind must not be dropped: a silent gap is the one failure a user cannot tell
    // from "they never wrote". It parses, and the UI shows it as unopenable.
    it('keeps a record whose kind it does not understand', () => {
      const parsed = parseStoredMessage('m3', { ...photo, kind: 'hologram' });
      expect(parsed).not.toBeNull();
      expect(parsed?.kind).toBe('unknown');
    });

    it('refuses a media record with no object', () => {
      const { object: _object, ...withoutObject } = photo;
      expect(parseStoredMessage('m4', withoutObject)).toBeNull();
    });

    // A video whose thumbnail could not be generated is still a valid message.
    it('accepts a media record with no thumbnail', () => {
      const { thumbObject: _thumbObject, ...withoutThumb } = photo;
      expect(parseStoredMessage('m5', withoutThumb)).toMatchObject({
        kind: 'photo',
        thumbObject: null,
      });
    });

    // No image bytes may live in Firestore: they would survive the Storage lifecycle sweep and
    // leave a preview of an expired photo behind for ever.
    it('carries a pointer to the thumbnail, never the thumbnail', () => {
      const parsed = parseStoredMessage('m2', photo);
      expect(parsed).not.toHaveProperty('thumb');
      expect(parsed).not.toHaveProperty('thumbBytes');
    });
  });

  it('keeps only a published key that has one', () => {
    expect(parsePublishedKey(A, { publicKey: 'cHVi', updatedAt: 3 })).toEqual({
      uid: A,
      publicKey: 'cHVi',
      updatedAt: 3,
    });
    expect(parsePublishedKey(A, null)).toBeNull();
    expect(parsePublishedKey(A, { publicKey: '' })).toBeNull();
  });

  it('sorts newest first, with a stable tie-break', () => {
    const one = { id: 'b', lastMessageAt: 10 } as Conversation;
    const two = { id: 'a', lastMessageAt: 20 } as Conversation;
    const three = { id: 'a2', lastMessageAt: 10 } as Conversation;
    expect([one, two, three].sort(byRecency).map((c) => c.id)).toEqual(['a', 'a2', 'b']);
  });
});

describe('what may be sent', () => {
  it('trims, and refuses empty or over-long text', () => {
    expect(checkMessage('  hello  ')).toEqual({ ok: true, body: 'hello' });
    expect(checkMessage('   ')).toEqual({ ok: false, problem: 'empty' });
    expect(checkMessage('x'.repeat(2001))).toEqual({ ok: false, problem: 'too-long' });
  });

  it('refuses the things that must never leave the device, even encrypted', () => {
    expect(checkMessage('my pin is 4821')).toEqual({ ok: false, problem: 'pin' });
    expect(checkMessage('here is my recovery passphrase: alpha bravo charlie delta echo foxtrot')).
      toMatchObject({ ok: false });
  });

  it('checks an address only loosely enough to catch a typo', () => {
    expect(looksLikeEmail('someone@example.com')).toBe(true);
    expect(looksLikeEmail('  someone@example.com  ')).toBe(true);
    expect(looksLikeEmail('someone')).toBe(false);
    expect(looksLikeEmail('someone@example')).toBe(false);
    expect(looksLikeEmail('')).toBe(false);
  });
});
