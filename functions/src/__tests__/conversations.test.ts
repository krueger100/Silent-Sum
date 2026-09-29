/**
 * The permission check that replaces a security rule.
 *
 * `deleteConversation` runs with the Admin SDK, which bypasses the Firestore rules entirely, so
 * the refusals below are the ONLY thing standing between a caller and someone else's thread. They
 * are tested first and hardest for that reason.
 */
import { BillingFailure } from '../errors';
import { deleteConversation, membersOf, type ConversationStore } from '../conversations';

const ALICE = 'alice-uid';
const BOB = 'bob-uid';
const CAROL = 'carol-uid';
const CID = [ALICE, BOB].sort().join('__');

interface Recorded {
  readonly messages: string[];
  readonly conversations: string[];
  readonly labels: string[];
  readonly media: string[];
}

function rig(): { store: ConversationStore; done: Recorded } {
  const done: Recorded = { messages: [], conversations: [], labels: [], media: [] };
  const store: ConversationStore = {
    deleteMessages: (cid) => {
      done.messages.push(cid);
      return Promise.resolve(3);
    },
    deleteConversation: (cid) => {
      done.conversations.push(cid);
      return Promise.resolve();
    },
    deleteContactLabel: (uid, peerUid) => {
      done.labels.push(`${uid}->${peerUid}`);
      return Promise.resolve();
    },
    deleteMedia: (cid) => {
      done.media.push(cid);
      return Promise.resolve(2);
    },
  };
  return { store, done };
}

async function codeOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return error instanceof BillingFailure ? error.code : `not-a-failure: ${String(error)}`;
  }
  return 'did-not-throw';
}

describe('membersOf', () => {
  it('reads the two accounts out of a conversation id, sorted', () => {
    expect(membersOf(CID)).toEqual([ALICE, BOB].sort());
  });

  it('refuses anything that is not one', () => {
    for (const bad of ['', 'nope', 'a__b__c', `${ALICE}__${ALICE}`, 'a/b__c', 'a.b__c', '__']) {
      expect(membersOf(bad)).toBeNull();
    }
  });
});

describe('deleting a conversation for both sides', () => {
  it('removes media, messages, the conversation and both private labels', async () => {
    const { store, done } = rig();
    const report = await deleteConversation({ store }, { callerUid: ALICE, conversationId: CID });

    expect(report).toEqual({ conversationId: CID, messages: 3, media: 2 });
    expect(done.media).toEqual([CID]);
    expect(done.messages).toEqual([CID]);
    expect(done.conversations).toEqual([CID]);
    expect(done.labels.sort()).toEqual([`${ALICE}->${BOB}`, `${BOB}->${ALICE}`].sort());
  });

  it('lets EITHER member delete it, not only the one who started it', async () => {
    const { store, done } = rig();
    await deleteConversation({ store }, { callerUid: BOB, conversationId: CID });
    expect(done.conversations).toEqual([CID]);
  });

  // The whole reason this module exists. The Admin SDK would happily delete anything; this is
  // what stops it.
  it('refuses a caller who is not in the conversation, and touches nothing', async () => {
    const { store, done } = rig();
    expect(await codeOf(() => deleteConversation({ store }, { callerUid: CAROL, conversationId: CID })))
      .toBe('permission-denied');
    expect(done).toEqual({ messages: [], conversations: [], labels: [], media: [] });
  });

  it('refuses a malformed or missing conversation id, and touches nothing', async () => {
    for (const bad of ['', 'nope', 'a__b__c', 42, null, undefined, `${ALICE}__${ALICE}`]) {
      const { store, done } = rig();
      expect(
        await codeOf(() => deleteConversation({ store }, { callerUid: ALICE, conversationId: bad })),
      ).toBe('invalid-argument');
      expect(done.conversations).toEqual([]);
    }
  });

  // A conversation id is two account ids joined, so logging it would log the social graph.
  it('does not put the conversation id or either uid in the log', async () => {
    const { store } = rig();
    const lines: { message: string; data?: Record<string, unknown> }[] = [];
    await deleteConversation(
      { store, log: (message, data) => lines.push({ message, data }) },
      { callerUid: ALICE, conversationId: CID },
    );
    const dump = JSON.stringify(lines);
    expect(dump).not.toContain(ALICE);
    expect(dump).not.toContain(BOB);
    expect(dump).not.toContain(CID);
  });

  // Media first: the reverse order would leave blobs with nothing left to name them.
  it('deletes the media before the documents that point at it', async () => {
    const order: string[] = [];
    const store: ConversationStore = {
      deleteMedia: (cid) => {
        order.push('media');
        return Promise.resolve(1);
      },
      deleteMessages: (cid) => {
        order.push('messages');
        return Promise.resolve(1);
      },
      deleteConversation: () => {
        order.push('conversation');
        return Promise.resolve();
      },
      deleteContactLabel: () => {
        order.push('label');
        return Promise.resolve();
      },
    };
    await deleteConversation({ store }, { callerUid: ALICE, conversationId: CID });
    expect(order).toEqual(['media', 'messages', 'conversation', 'label', 'label']);
  });
});
