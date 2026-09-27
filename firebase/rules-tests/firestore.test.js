/**
 * The deployed Firestore rules (`firestore.merged.rules`), exercised against the emulator.
 *
 * What is proved here and nowhere else:
 *   - no client, owner included, can write its own entitlements;
 *   - backup writes need an active Cloud term, read from the server-written document;
 *   - reads and deletes of backup data never need one;
 *   - the server-only billing collections are closed to every client.
 *
 * Run from this folder with `npm test` (starts the emulators around jest).
 */
const fs = require('node:fs');
const path = require('node:path');
const {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} = require('@firebase/rules-unit-testing');
const {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  Timestamp,
  where,
} = require('firebase/firestore');

const PROJECT_ID = 'demo-silentsum';
// `SILENTSUM_RULES_FILE` lets the same suite run against a staged ruleset (see firebase.stage1.json).
const RULES_FILE = process.env.SILENTSUM_RULES_FILE ?? 'firestore.merged.rules';
const RULES = fs.readFileSync(path.resolve(__dirname, '..', RULES_FILE), 'utf8');

const ALICE = 'alice-uid';
const BOB = 'bob-uid';

const ENVELOPE = {
  v: 1,
  salt: 'c2FsdA==',
  kdf: { alg: 'argon2id', m: 65536, t: 3, p: 1, len: 32 },
  wrapped: { nonce: 'bm9uY2U=', ct: 'Y3Q=', mac: 'bWFj' },
  createdAt: '2026-09-21T12:00:00.000Z',
};

const MANIFEST = { photoIds: ['a'], photoCount: 1, updatedAt: '2026-09-21T12:00:00.000Z' };

let env;

beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: PROJECT_ID, firestore: { rules: RULES } });
});

afterAll(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
});

/** What the Cloud Functions do with the Admin SDK: write the entitlement document, rules or no rules. */
async function serverWritesEntitlements(uid, accessUntilMs) {
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), `users/${uid}/billing/entitlements`), {
      v: 1,
      pro: true,
      proSince: Timestamp.fromMillis(Date.now() - 1000),
      proPaymentId: 'pay_1',
      cloud: {
        status: 'active',
        accessUntil: accessUntilMs === null ? null : Timestamp.fromMillis(accessUntilMs),
        currentPeriodStart: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        source: 'term',
        subscriptionId: null,
      },
      updatedAt: Timestamp.now(),
    });
  });
}

function asAlice() {
  return env.authenticatedContext(ALICE).firestore();
}

function asBob() {
  return env.authenticatedContext(BOB).firestore();
}

const DAY = 86_400_000;

describe('entitlements document', () => {
  it('is readable by its owner and by nobody else', async () => {
    await serverWritesEntitlements(ALICE, Date.now() + DAY);
    await assertSucceeds(getDoc(doc(asAlice(), `users/${ALICE}/billing/entitlements`)));
    await assertFails(getDoc(doc(asBob(), `users/${ALICE}/billing/entitlements`)));
    await assertFails(
      getDoc(doc(env.unauthenticatedContext().firestore(), `users/${ALICE}/billing/entitlements`)),
    );
  });

  it('cannot be created, changed or deleted by its owner', async () => {
    const path = `users/${ALICE}/billing/entitlements`;
    await assertFails(
      setDoc(doc(asAlice(), path), { v: 1, pro: true, cloud: { status: 'active' } }),
    );
    await serverWritesEntitlements(ALICE, Date.now() + DAY);
    await assertFails(setDoc(doc(asAlice(), path), { pro: true }, { merge: true }));
    await assertFails(deleteDoc(doc(asAlice(), path)));
  });
});

describe('backup writes need an active Cloud term', () => {
  const envelopePath = `users/${ALICE}/vault/envelope`;
  const manifestPath = `users/${ALICE}/vault/manifest`;

  it('refuses a free account', async () => {
    await assertFails(setDoc(doc(asAlice(), envelopePath), ENVELOPE));
    await assertFails(setDoc(doc(asAlice(), manifestPath), MANIFEST));
  });

  it('refuses a lapsed term', async () => {
    await serverWritesEntitlements(ALICE, Date.now() - 1000);
    await assertFails(setDoc(doc(asAlice(), envelopePath), ENVELOPE));
    await assertFails(setDoc(doc(asAlice(), manifestPath), MANIFEST));
  });

  it('refuses a document with no date at all', async () => {
    await serverWritesEntitlements(ALICE, null);
    await assertFails(setDoc(doc(asAlice(), envelopePath), ENVELOPE));
  });

  it('allows an active term, and still validates the shape', async () => {
    await serverWritesEntitlements(ALICE, Date.now() + DAY);
    await assertSucceeds(setDoc(doc(asAlice(), envelopePath), ENVELOPE));
    await assertSucceeds(setDoc(doc(asAlice(), manifestPath), MANIFEST));
    await assertFails(setDoc(doc(asAlice(), envelopePath), { ...ENVELOPE, extra: 1 }));
    await assertFails(
      setDoc(doc(asAlice(), envelopePath), { ...ENVELOPE, kdf: { ...ENVELOPE.kdf, m: 4096 } }),
    );
  });

  it("never lets one account write another's backup, term or no term", async () => {
    await serverWritesEntitlements(BOB, Date.now() + DAY);
    await assertFails(setDoc(doc(asBob(), envelopePath), ENVELOPE));
  });
});

describe('backup reads and deletes never need a term', () => {
  it('lets a lapsed account read and delete what it has', async () => {
    await serverWritesEntitlements(ALICE, Date.now() + DAY);
    await assertSucceeds(setDoc(doc(asAlice(), `users/${ALICE}/vault/envelope`), ENVELOPE));
    await assertSucceeds(setDoc(doc(asAlice(), `users/${ALICE}/vault/manifest`), MANIFEST));

    await serverWritesEntitlements(ALICE, Date.now() - 1000);
    await assertSucceeds(getDoc(doc(asAlice(), `users/${ALICE}/vault/envelope`)));
    await assertSucceeds(getDoc(doc(asAlice(), `users/${ALICE}/vault/manifest`)));
    await assertSucceeds(deleteDoc(doc(asAlice(), `users/${ALICE}/vault/manifest`)));
    await assertSucceeds(deleteDoc(doc(asAlice(), `users/${ALICE}/vault/envelope`)));
  });

  it('lets an account that never subscribed read (nothing) and delete (nothing)', async () => {
    await assertSucceeds(getDoc(doc(asAlice(), `users/${ALICE}/vault/envelope`)));
    await assertSucceeds(deleteDoc(doc(asAlice(), `users/${ALICE}/vault/envelope`)));
  });
});

describe('server-only billing collections', () => {
  it.each([
    'silentsum_billing_refs/cs_1',
    'silentsum_billing_events/evt_1',
    'silentsum_billing_payments/pay_1',
  ])('%s is closed to clients', async (path) => {
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), path), { uid: ALICE });
    });
    await assertFails(getDoc(doc(asAlice(), path)));
    await assertFails(setDoc(doc(asAlice(), path), { uid: ALICE, pro: true }));
    await assertFails(deleteDoc(doc(asAlice(), path)));
  });
});

describe('the untouched EVPAL block', () => {
  it('still lets a user at their own stripe_customers document', async () => {
    await assertSucceeds(setDoc(doc(asAlice(), `stripe_customers/${ALICE}`), { ok: true }));
    await assertFails(setDoc(doc(asBob(), `stripe_customers/${ALICE}`), { ok: true }));
  });
});

describe('support chat', () => {
  const messages = (uid) => `users/${uid}/support/thread/messages`;
  const threadOf = (uid) => `users/${uid}/support/thread`;

  function userMessage(overrides = {}) {
    return { v: 1, sender: 'user', body: 'the gallery crashes', createdAt: Date.now(), ...overrides };
  }

  it('lets an active Cloud account send, and nobody else read it', async () => {
    await serverWritesEntitlements(ALICE, Date.now() + DAY);
    await assertSucceeds(setDoc(doc(asAlice(), `${messages(ALICE)}/m1`), userMessage()));
    await assertSucceeds(getDoc(doc(asAlice(), `${messages(ALICE)}/m1`)));
    await assertFails(getDoc(doc(asBob(), `${messages(ALICE)}/m1`)));
    await assertFails(setDoc(doc(asBob(), `${messages(ALICE)}/m2`), userMessage()));
  });

  it('refuses a new message with no Cloud term and with a lapsed one', async () => {
    await assertFails(setDoc(doc(asAlice(), `${messages(ALICE)}/m1`), userMessage()));
    await serverWritesEntitlements(ALICE, Date.now() - 1000);
    await assertFails(setDoc(doc(asAlice(), `${messages(ALICE)}/m1`), userMessage()));
  });

  it('still lets a lapsed account READ the whole conversation', async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), `${messages(ALICE)}/r1`), {
        v: 1,
        sender: 'support',
        body: 'we are looking into it',
        createdAt: Date.now(),
      });
    });
    await serverWritesEntitlements(ALICE, Date.now() - 1000);
    await assertSucceeds(getDoc(doc(asAlice(), `${messages(ALICE)}/r1`)));
    await assertSucceeds(getDoc(doc(asAlice(), threadOf(ALICE))));
  });

  it('never lets a client claim to be support, nor edit or delete a message', async () => {
    await serverWritesEntitlements(ALICE, Date.now() + DAY);
    await assertFails(
      setDoc(doc(asAlice(), `${messages(ALICE)}/m1`), userMessage({ sender: 'support' })),
    );
    await assertSucceeds(setDoc(doc(asAlice(), `${messages(ALICE)}/m2`), userMessage()));
    await assertFails(setDoc(doc(asAlice(), `${messages(ALICE)}/m2`), userMessage({ body: 'edited' })));
    await assertFails(deleteDoc(doc(asAlice(), `${messages(ALICE)}/m2`)));
  });

  it('refuses a backdated, postdated, empty, oversized or extra-field message', async () => {
    await serverWritesEntitlements(ALICE, Date.now() + DAY);
    const bad = [
      userMessage({ createdAt: Date.now() - 3_600_000 }),
      userMessage({ createdAt: Date.now() + 3_600_000 }),
      userMessage({ body: '' }),
      userMessage({ body: 'x'.repeat(2001) }),
      userMessage({ authorUid: 'someone' }),
      userMessage({ v: 2 }),
    ];
    for (const [index, payload] of bad.entries()) {
      await assertFails(setDoc(doc(asAlice(), `${messages(ALICE)}/bad${String(index)}`), payload));
    }
  });

  it('lets the owner set only its own read marker on the thread', async () => {
    await assertSucceeds(
      setDoc(doc(asAlice(), threadOf(ALICE)), { v: 1, uid: ALICE, userLastReadAt: Date.now() }),
    );
    await assertFails(
      setDoc(doc(asAlice(), threadOf(ALICE)), { v: 1, uid: BOB, userLastReadAt: Date.now() }),
    );
    await assertFails(
      setDoc(doc(asAlice(), threadOf(ALICE)), {
        v: 1,
        uid: ALICE,
        userLastReadAt: Date.now(),
        supportUnread: 0,
      }),
    );
    await assertFails(setDoc(doc(asBob(), threadOf(ALICE)), { v: 1, uid: ALICE, userLastReadAt: 1 }));
    await assertFails(deleteDoc(doc(asAlice(), threadOf(ALICE))));
  });
});

// ---------------------------------------------------------------------------------------------
// User-to-user messaging
// ---------------------------------------------------------------------------------------------

/** Ids are sorted, so this is the one conversation Alice and Bob can ever have. */
const CONVERSATION = [ALICE, BOB].sort().join('__');
const CAROL = 'carol-uid';

function asCarol() {
  return env.authenticatedContext(CAROL).firestore();
}

/** Pro without a Cloud term: exactly the state messaging requires and backup does not. */
async function serverWritesPro(uid, pro) {
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), `users/${uid}/billing/entitlements`), {
      v: 1,
      pro,
      proSince: pro ? Timestamp.now() : null,
      cloud: {
        status: 'none',
        accessUntil: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        source: null,
        subscriptionId: null,
      },
      updatedAt: Timestamp.now(),
    });
  });
}

function newConversation(createdBy) {
  const members = [ALICE, BOB].sort();
  return {
    v: 1,
    members,
    createdAt: Date.now(),
    createdBy,
    lastMessageAt: Date.now(),
    lastMessageFrom: null,
    unread: { [members[0]]: 0, [members[1]]: 0 },
    readAt: { [members[0]]: 0, [members[1]]: 0 },
  };
}

function message(from) {
  return {
    v: 1,
    from,
    box: 'Y2lwaGVydGV4dA==',
    nonce: 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0',
    createdAt: Date.now(),
  };
}

async function serverCreatesConversation() {
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), `conversations/${CONVERSATION}`), newConversation(ALICE));
  });
}

describe('published messaging keys', () => {
  const keyOf = (uid) => `messagingKeys/${uid}`;
  const key = { v: 1, uid: ALICE, publicKey: 'cHVibGljLWtleQ==', updatedAt: Date.now() };

  it('is written by its owner and readable by any signed-in account', async () => {
    await assertSucceeds(setDoc(doc(asAlice(), keyOf(ALICE)), key));
    await assertSucceeds(getDoc(doc(asBob(), keyOf(ALICE))));
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), keyOf(ALICE))));
  });

  it('cannot be written by anyone else, or deleted at all', async () => {
    await assertFails(setDoc(doc(asBob(), keyOf(ALICE)), { ...key }));
    await assertSucceeds(setDoc(doc(asAlice(), keyOf(ALICE)), key));
    await assertFails(deleteDoc(doc(asAlice(), keyOf(ALICE))));
  });

  it('refuses a malformed or postdated record', async () => {
    await assertFails(setDoc(doc(asAlice(), keyOf(ALICE)), { ...key, uid: BOB }));
    await assertFails(setDoc(doc(asAlice(), keyOf(ALICE)), { ...key, publicKey: '' }));
    await assertFails(setDoc(doc(asAlice(), keyOf(ALICE)), { ...key, extra: 1 }));
    await assertFails(
      setDoc(doc(asAlice(), keyOf(ALICE)), { ...key, updatedAt: Date.now() + 600000 }),
    );
  });
});

describe('conversations need Pro to start and to send', () => {
  it('lets a Pro member create the conversation', async () => {
    await serverWritesPro(ALICE, true);
    await assertSucceeds(
      setDoc(doc(asAlice(), `conversations/${CONVERSATION}`), newConversation(ALICE)),
    );
  });

  it('refuses an account without Pro, however the client feels about it', async () => {
    await serverWritesPro(ALICE, false);
    await assertFails(
      setDoc(doc(asAlice(), `conversations/${CONVERSATION}`), newConversation(ALICE)),
    );
    // And with no entitlement document at all.
    await assertFails(setDoc(doc(asBob(), `conversations/${CONVERSATION}`), newConversation(BOB)));
  });

  it('refuses a conversation whose id does not match its members, or a stranger', async () => {
    await serverWritesPro(ALICE, true);
    await assertFails(
      setDoc(doc(asAlice(), `conversations/${[ALICE, CAROL].sort().join('__')}`), {
        ...newConversation(ALICE),
      }),
    );
    await serverWritesPro(CAROL, true);
    await assertFails(
      setDoc(doc(asCarol(), `conversations/${CONVERSATION}`), newConversation(CAROL)),
    );
  });

  it('refuses a conversation that starts with unread already on the clock', async () => {
    await serverWritesPro(ALICE, true);
    const members = [ALICE, BOB].sort();
    await assertFails(
      setDoc(doc(asAlice(), `conversations/${CONVERSATION}`), {
        ...newConversation(ALICE),
        unread: { [members[0]]: 0, [members[1]]: 5 },
      }),
    );
    await assertFails(
      setDoc(doc(asAlice(), `conversations/${CONVERSATION}`), {
        ...newConversation(ALICE),
        lastMessageFrom: ALICE,
      }),
    );
  });
});

describe('messages', () => {
  const messagePath = (id) => `conversations/${CONVERSATION}/messages/${id}`;

  it('is written by a Pro member and read by both, and by nobody else', async () => {
    await serverCreatesConversation();
    await serverWritesPro(ALICE, true);
    await assertSucceeds(setDoc(doc(asAlice(), messagePath('m1')), message(ALICE)));
    await assertSucceeds(getDoc(doc(asBob(), messagePath('m1'))));
    await assertSucceeds(getDoc(doc(asAlice(), messagePath('m1'))));
    await assertFails(getDoc(doc(asCarol(), messagePath('m1'))));
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), messagePath('m1'))));
  });

  it('cannot be sent without Pro, even by a member', async () => {
    await serverCreatesConversation();
    await serverWritesPro(BOB, false);
    await assertFails(setDoc(doc(asBob(), messagePath('m2')), message(BOB)));
  });

  it('cannot be attributed to the other person', async () => {
    await serverCreatesConversation();
    await serverWritesPro(ALICE, true);
    await assertFails(setDoc(doc(asAlice(), messagePath('m3')), message(BOB)));
  });

  it('cannot be backdated, oversized or reshaped', async () => {
    await serverCreatesConversation();
    await serverWritesPro(ALICE, true);
    await assertFails(
      setDoc(doc(asAlice(), messagePath('m4')), {
        ...message(ALICE),
        createdAt: Date.now() - 3600000,
      }),
    );
    await assertFails(
      setDoc(doc(asAlice(), messagePath('m5')), { ...message(ALICE), box: 'x'.repeat(16001) }),
    );
    await assertFails(
      setDoc(doc(asAlice(), messagePath('m6')), { ...message(ALICE), nonce: 'short' }),
    );
    await assertFails(
      setDoc(doc(asAlice(), messagePath('m7')), { ...message(ALICE), body: 'plaintext' }),
    );
  });

  it('is a record: it cannot be edited or deleted', async () => {
    await serverCreatesConversation();
    await serverWritesPro(ALICE, true);
    await assertSucceeds(setDoc(doc(asAlice(), messagePath('m8')), message(ALICE)));
    await assertFails(setDoc(doc(asAlice(), messagePath('m8')), message(ALICE)));
    await assertFails(deleteDoc(doc(asAlice(), messagePath('m8'))));
    await assertFails(deleteDoc(doc(asBob(), messagePath('m8'))));
  });

  it('cannot be planted in a conversation between two other people', async () => {
    const theirs = [BOB, CAROL].sort().join('__');
    await serverWritesPro(ALICE, true);
    await assertFails(setDoc(doc(asAlice(), `conversations/${theirs}/messages/m9`), message(ALICE)));
  });
});

describe('media messages', () => {
  const messagePath = (id) => `conversations/${CONVERSATION}/messages/${id}`;

  function media(from, overrides = {}) {
    return {
      ...message(from),
      kind: 'photo',
      object: `messages/${CONVERSATION}/photo/m1`,
      bytes: 4096,
      thumbObject: `messages/${CONVERSATION}/thumb/m1`,
      ...overrides,
    };
  }

  it('lets a Pro member send a photo and a video', async () => {
    await serverCreatesConversation();
    await serverWritesPro(ALICE, true);
    await assertSucceeds(setDoc(doc(asAlice(), messagePath('p1')), media(ALICE)));
    await assertSucceeds(
      setDoc(
        doc(asAlice(), messagePath('v1')),
        media(ALICE, { kind: 'video', object: `messages/${CONVERSATION}/video/v1` }),
      ),
    );
  });

  // Media is Pro exactly as text is, and enforced in the same place.
  it('refuses media from a member without Pro', async () => {
    await serverCreatesConversation();
    await serverWritesPro(BOB, false);
    await assertFails(setDoc(doc(asBob(), messagePath('p2')), media(BOB)));
  });

  // Text messages carry no `kind` and must keep working untouched.
  it('still accepts a plain text message with no media fields', async () => {
    await serverCreatesConversation();
    await serverWritesPro(ALICE, true);
    await assertSucceeds(setDoc(doc(asAlice(), messagePath('t1')), message(ALICE)));
  });

  it('refuses a kind it does not recognise', async () => {
    await serverCreatesConversation();
    await serverWritesPro(ALICE, true);
    await assertFails(setDoc(doc(asAlice(), messagePath('p3')), media(ALICE, { kind: 'hologram' })));
  });

  it('refuses a media record with no object to point at', async () => {
    await serverCreatesConversation();
    await serverWritesPro(ALICE, true);
    const { object, ...withoutObject } = media(ALICE);
    await assertFails(setDoc(doc(asAlice(), messagePath('p4')), withoutObject));
  });

  // The object name is the one field a client could use to reach into another conversation's
  // storage, so the rule pins it to this conversation's own prefix.
  it("refuses an object that points outside this conversation", async () => {
    const theirs = [BOB, CAROL].sort().join('__');
    await serverCreatesConversation();
    await serverWritesPro(ALICE, true);
    await assertFails(
      setDoc(doc(asAlice(), messagePath('p5')), media(ALICE, { object: `messages/${theirs}/photo/x` })),
    );
    await assertFails(
      setDoc(
        doc(asAlice(), messagePath('p6')),
        media(ALICE, { thumbObject: `messages/${theirs}/thumb/x` }),
      ),
    );
  });

  it('still refuses an unknown extra field alongside the media ones', async () => {
    await serverCreatesConversation();
    await serverWritesPro(ALICE, true);
    await assertFails(
      setDoc(doc(asAlice(), messagePath('p7')), media(ALICE, { body: 'plaintext' })),
    );
  });

  it('allows a media record with no thumbnail, for a video that produced none', async () => {
    await serverCreatesConversation();
    await serverWritesPro(ALICE, true);
    const { thumbObject, ...withoutThumb } = media(ALICE, {
      kind: 'video',
      object: `messages/${CONVERSATION}/video/v2`,
    });
    await assertSucceeds(setDoc(doc(asAlice(), messagePath('v2')), withoutThumb));
  });
});

describe('unread counts and read markers', () => {
  const conversationPath = `conversations/${CONVERSATION}`;

  it('lets the sender add exactly one to the other side', async () => {
    await serverCreatesConversation();
    await serverWritesPro(ALICE, true);
    await assertSucceeds(
      setDoc(
        doc(asAlice(), conversationPath),
        { lastMessageAt: Date.now(), lastMessageFrom: ALICE, unread: { [BOB]: 1 } },
        { merge: true },
      ),
    );
  });

  it('refuses a sender inflating the count, or signing as the other person', async () => {
    await serverCreatesConversation();
    await serverWritesPro(ALICE, true);
    await assertFails(
      setDoc(
        doc(asAlice(), conversationPath),
        { lastMessageAt: Date.now(), lastMessageFrom: ALICE, unread: { [BOB]: 9 } },
        { merge: true },
      ),
    );
    await assertFails(
      setDoc(
        doc(asAlice(), conversationPath),
        { lastMessageAt: Date.now(), lastMessageFrom: BOB, unread: { [BOB]: 1 } },
        { merge: true },
      ),
    );
  });

  it('lets a member clear only its own badge, Pro or not', async () => {
    // Both sides owe each other something, so clearing the wrong one is a real change.
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), conversationPath), {
        ...newConversation(ALICE),
        unread: { [ALICE]: 3, [BOB]: 2 },
      });
    });
    await serverWritesPro(BOB, false);
    await assertSucceeds(
      setDoc(
        doc(asBob(), conversationPath),
        { unread: { [BOB]: 0 }, readAt: { [BOB]: Date.now() } },
        { merge: true },
      ),
    );
    await assertFails(
      setDoc(
        doc(asBob(), conversationPath),
        { unread: { [ALICE]: 0 }, readAt: { [BOB]: Date.now() } },
        { merge: true },
      ),
    );
    await assertFails(
      setDoc(
        doc(asBob(), conversationPath),
        { unread: { [BOB]: 0 }, readAt: { [ALICE]: Date.now() } },
        { merge: true },
      ),
    );
  });

  it('refuses a member rewriting the membership or deleting the conversation', async () => {
    await serverCreatesConversation();
    await serverWritesPro(ALICE, true);
    await assertFails(
      setDoc(doc(asAlice(), conversationPath), { members: [ALICE, CAROL] }, { merge: true }),
    );
    await assertFails(deleteDoc(doc(asAlice(), conversationPath)));
  });

  it('refuses a stranger touching it at all', async () => {
    await serverCreatesConversation();
    await serverWritesPro(CAROL, true);
    await assertFails(getDoc(doc(asCarol(), conversationPath)));
    await assertFails(
      setDoc(doc(asCarol(), conversationPath), { unread: { [CAROL]: 0 } }, { merge: true }),
    );
  });
});

describe('private contact labels', () => {
  const contact = {
    v: 1,
    box: 'Y2lwaGVy',
    nonce: 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0',
    updatedAt: Date.now(),
  };

  it('is owner-only, both ways', async () => {
    const path = `users/${ALICE}/contacts/${BOB}`;
    await assertSucceeds(setDoc(doc(asAlice(), path), contact));
    await assertSucceeds(getDoc(doc(asAlice(), path)));
    await assertFails(getDoc(doc(asBob(), path)));
    await assertFails(setDoc(doc(asBob(), path), contact));
  });

  it('refuses anything but a sealed label', async () => {
    const path = `users/${ALICE}/contacts/${BOB}`;
    await assertFails(setDoc(doc(asAlice(), path), { ...contact, label: 'bob@example.test' }));
    await assertFails(setDoc(doc(asAlice(), path), { ...contact, nonce: 'short' }));
  });
});

/**
 * Listing conversations, which is a different rule from reading one.
 *
 * These exist because everything else here reads documents by path, and a path-based rule can
 * pass every one of those tests while refusing every query the app actually makes: for a query
 * the engine must satisfy the rule from the query's constraints alone, before it reads anything,
 * and a query cannot constrain a document id. The app's conversation list is a query.
 */
describe('listing conversations', () => {
  const conversations = (db) => collection(db, 'conversations');
  const mine = (db, uid) => query(conversations(db), where('members', 'array-contains', uid));

  beforeEach(async () => {
    await serverCreatesConversation();
  });

  it('lets a member list the conversations they are in', async () => {
    const snapshot = await assertSucceeds(getDocs(mine(asAlice(), ALICE)));
    expect(snapshot.docs.map((d) => d.id)).toEqual([CONVERSATION]);
  });

  it('lets the other member list it too', async () => {
    const snapshot = await assertSucceeds(getDocs(mine(asBob(), BOB)));
    expect(snapshot.docs.map((d) => d.id)).toEqual([CONVERSATION]);
  });

  it('refuses a query that does not narrow to the caller', async () => {
    await assertFails(getDocs(conversations(asAlice())));
  });

  it("refuses a query for somebody else's conversations", async () => {
    await assertFails(getDocs(mine(asAlice(), BOB)));
  });

  it('refuses an outsider narrowing to themselves, because they are in none', async () => {
    const snapshot = await assertSucceeds(getDocs(mine(asCarol(), CAROL)));
    expect(snapshot.empty).toBe(true);
  });

  it('still lets a member read the one document by path', async () => {
    await assertSucceeds(getDoc(doc(asAlice(), `conversations/${CONVERSATION}`)));
    await assertFails(getDoc(doc(asCarol(), `conversations/${CONVERSATION}`)));
  });
});
