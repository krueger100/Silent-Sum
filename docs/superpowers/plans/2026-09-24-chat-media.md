# Chat media (photos and video) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Pro users send end-to-end encrypted photos and video inside a conversation — from the camera, the photo library, or the vault — and save what they receive back into the vault, with no Cloud requirement anywhere.

**Architecture:** The ciphertext goes to Firebase Storage under a new shared `messages/{cid}/` prefix, as **two objects** — the full media and its encrypted thumbnail — with the Firestore message document holding only pointers. Encryption reuses the conversation key both participants already derive. Pro is enforced where it already is — on the message document — so the Storage rules check membership only. Putting the thumbnail in Storage rather than inline in Firestore is what lets the single 30-day lifecycle rule expire **both**, so nothing survives the expiry.

**Tech Stack:** TypeScript (strict), `@noble/curves` + `react-native-libsodium` (existing crypto), Firebase Storage rules, expo-image-picker, Jest + RNTL, `@firebase/rules-unit-testing`.

**Spec:** `docs/superpowers/specs/2026-09-24-chat-media-design.md`

## Global Constraints

- **All chat media is Pro.** Photos and video alike. There must be no `cloudActive` check anywhere in this feature, in any layer.
- **Cloud expiry must not affect it.** A Pro account with a lapsed or absent Cloud term sends and opens media normally.
- **Receiving and viewing require nothing** — not Pro, not Cloud.
- **Chat media must never count against the 500 MB free backup allowance.** It lives under `messages/`, which `accountForObject` in `functions/src/storageUsage.ts` already excludes (Plan 2, Task 1).
- Caps: photo ≤ **8 MB**, video ≤ **100 MB**, thumbnail ≤ **32 KB**, thumbnail long edge **256 px**.
- **Media and thumbnails both expire at 30 days.** No preview may outlive its media. Both live under `messages/` so one lifecycle rule sweeps both; no thumbnail is ever stored inline in Firestore. The Firestore message record survives the expiry and the bubble remains in the thread — the history stays, the imagery does not.
- **The 30-day object-lifecycle rule is mandatory** and must be applied before the feature reaches users. It is the only bound on storage cost for this feature.
- **The bucket is shared with EVPAL.** The lifecycle rule must not be applied until the live bucket has been inspected and `messages/` confirmed to be SilentSum's alone (Task 9, Step 1). That step is a gate, not a formality: if the prefix is not exclusively ours, stop and report rather than adapting the rule.
- **Three sources, one pipeline.** Camera, photo library and vault all converge on `sendMedia`, which takes a local file and a kind and does not know where they came from. No source may acquire its own send path.
- **A vault send is a copy, never a move.** The vault's own item is never altered or removed, and the first vault send in each conversation shows a one-time explanation before it happens.
- **A vault thumbnail is never reused as a chat thumbnail.** The vault generates at 512px/q82; chat caps at 256px/32 KB. Regenerate, always.
- **Save to vault goes through `vaultGate`**, with no special case for chat: a received item is an ordinary vault item subject to the 50-item and 100 MB limits.
- Existing text messages must keep working with no migration: a record with no `kind` is text.
- Run `npx tsc --noEmit -p tsconfig.json`, `npm run lint`, `npx jest`, and `cd firebase/rules-tests && npm test` before each commit.

## Dependencies between the three plans

**Confirmed order: Plan 1 → this plan → Plan 2.** This plan is second.

- **Now genuinely depends on Plan 1** (free-tier vault video), which it did not when first written. Task 8 (save to vault) calls `vaultGate` with the item's byte length, and that `bytes`-based signature arrives in Plan 1 Task 1. Tasks 1–7 are still independent of it, so only the last app task is blocked — but the agreed order already satisfies this and it must not be reordered to put this plan first.
- **One shared assumption with Plan 2**: the usage triggers must ignore `messages/`. That is built in Plan 2 Task 1, which has not shipped when this plan lands — so on the day this ships **chat media is uncounted because nothing counts anything yet**, and it stays uncounted when Plan 2 arrives. The intended end state either way.
- **What the chosen order means for Plan 2's backfill:** it will run in a bucket that already contains `messages/` objects. It lists with `prefix: 'users/'` and filters through `accountForObject`, so those objects are invisible to it twice over. Verified, not assumed — but it is the reason Plan 2's Task 6 must not be "simplified" into listing the whole bucket.
- Nothing here depends on either plan's code.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `firebase/rules-tests/storage.test.js` | the `split()` probe, then the real rules tests | Modify |
| `firebase/storage.rules` | the `messages/` block | Modify |
| `src/messaging/media.ts` | pure: caps, AAD, seal/open for media and thumbnails | Create |
| `src/messaging/messaging.ts` | `kind`, the media record and its parser | Modify |
| `src/messaging/messagingService.ts` | `sendMedia`, `fetchMedia`, `fetchThumb`, `saveToVault` | Modify |
| `src/firebase/cloudBackend.ts` | test seams: `blobWrites`, `failNextBlobUpload`, `expireBlobsUnder` | Modify |
| `src/messaging/screens/ConversationScreen.tsx` | attach button, media bubbles, the three sources | Modify |
| `src/messaging/screens/MediaBubble.tsx` | one media bubble and its states | Create |
| `src/messaging/screens/AttachSheet.tsx` | the three-row source chooser | Create |
| `src/messaging/screens/VaultPickerSheet.tsx` | single-select over vault items, no delete | Create |
| `src/messaging/vaultSendNotice.ts` | pure: which conversations have seen the warning | Create |
| `src/secure-storage/secureStore.ts` | one new key, added to `ALL_SECURE_STORE_KEYS` | Modify |
| `firebase/storage-lifecycle.json` | the 30-day rule, as configuration | Create |
| `firebase/README.md` | verifying the bucket, then applying the rule | Modify |
| `docs/messaging.md` | what a message can now carry, and what expires | Modify |

---

### Task 1: Prove what Storage rules can actually do

**Files:**
- Modify: `firebase/rules-tests/storage.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: an answer that decides Task 2's rule shape. No production code.

The Firestore rules read conversation membership from the document id with `cid.split('__')`.
Whether the **Storage** rules language supports `split()` is not assumed here. Two defects on
2026-09-24 came from assuming a capability the real service did not have (`docs/messaging.md`,
"three device-only failures"), and this is the same shape of assumption.

- [ ] **Step 1: Write the probe**

Add to `firebase/rules-tests/storage.test.js`, temporarily, a rules string that uses `split()` and
a test that exercises it. `initializeTestEnvironment` takes the rules as a string, so this needs no
file on disk:

```js
describe('PROBE: does the Storage rules language support split()', () => {
  it('reports whether a path-derived membership check compiles and evaluates', async () => {
    const probe = `
      rules_version = '2';
      service firebase.storage {
        match /b/{bucket}/o {
          match /messages/{cid}/{allPaths=**} {
            allow read, write: if request.auth != null
              && request.auth.uid in cid.split('__');
          }
        }
      }`;
    const probeEnv = await initializeTestEnvironment({
      projectId: 'demo-probe',
      storage: { rules: probe },
    });
    try {
      const cid = [ALICE, BOB].sort().join('__');
      const member = probeEnv.authenticatedContext(ALICE).storage();
      const outsider = probeEnv.authenticatedContext('carol-uid').storage();
      await assertSucceeds(uploadBytes(ref(member, `messages/${cid}/photo/m1`), BLOB));
      await assertFails(uploadBytes(ref(outsider, `messages/${cid}/photo/m2`), BLOB));
    } finally {
      await probeEnv.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run it and record the answer**

Run: `cd firebase/rules-tests && npm test -t PROBE`

- **If it passes**, `split()` works. Task 2 uses the path-derived form, which costs no document read.
- **If it fails to compile or always denies**, `split()` is unavailable. Task 2 uses the fallback:

  ```
  firestore.get(/databases/(default)/documents/conversations/$(cid)).data.members
  ```

  which is proven — `cloudActive()` in this same file already performs a cross-service Firestore
  read. The cost is one Firestore read per object access, which is acceptable.

Write the outcome into the probe's `describe` name as a one-line note, then **delete the probe**
before committing — its job is to answer a question, not to become a test of Google's rules engine.

- [ ] **Step 3: Commit the decision, not the probe**

Record the answer in `docs/superpowers/specs/2026-09-24-chat-media-design.md` §6, replacing the
"One unknown" paragraph with what was actually observed.

```bash
git add docs/superpowers/specs/2026-09-24-chat-media-design.md
git commit -m "docs(messaging): settle how Storage rules can check conversation membership"
```

---

### Task 2: The `messages/` Storage block

**Files:**
- Modify: `firebase/storage.rules`
- Modify: `firebase/rules-tests/storage.test.js`

**Interfaces:**
- Consumes: Task 1's answer.
- Produces: the object paths `messages/{cid}/photo/{objectId}`, `messages/{cid}/video/{objectId}` and `messages/{cid}/thumb/{objectId}`.

All three sit under `messages/`, which is what lets one lifecycle rule expire media and previews
together.

- [ ] **Step 1: Write the failing tests**

```js
describe('chat media objects', () => {
  const cid = [ALICE, BOB].sort().join('__');
  const photo = (uid) => ref(storageAs(uid), `messages/${cid}/photo/m1`);
  const video = (uid) => ref(storageAs(uid), `messages/${cid}/video/m2`);
  const thumb = (uid) => ref(storageAs(uid), `messages/${cid}/thumb/m1`);

  it('lets either member write and read all three kinds', async () => {
    await assertSucceeds(uploadBytes(photo(ALICE), BLOB));
    await assertSucceeds(uploadBytes(video(ALICE), BLOB));
    await assertSucceeds(uploadBytes(thumb(ALICE), BLOB));
    await assertSucceeds(getBytes(photo(BOB)));
    await assertSucceeds(getBytes(video(BOB)));
    await assertSucceeds(getBytes(thumb(BOB)));
  });

  // The thumbnail is a preview of the image and is exactly as sensitive as it.
  it('refuses an outsider the thumbnail too', async () => {
    await assertFails(uploadBytes(thumb('carol-uid'), BLOB));
  });

  it('holds the thumbnail to 32 KB', async () => {
    await assertFails(uploadBytes(thumb(ALICE), new Uint8Array(33 * 1024)));
  });

  it('refuses an outsider entirely', async () => {
    await assertFails(uploadBytes(photo('carol-uid'), BLOB));
    await env.withSecurityRulesDisabled(async (context) => {
      await uploadBytes(ref(context.storage(), `messages/${cid}/photo/m1`), BLOB);
    });
    await assertFails(getBytes(ref(storageAs('carol-uid'), `messages/${cid}/photo/m1`)));
  });

  // The whole point of the revised model: no entitlement is read in this block at all.
  it('lets a member with no Cloud term write both kinds', async () => {
    // No entitlement document is written for ALICE in this test at all.
    await assertSucceeds(uploadBytes(photo(ALICE), BLOB));
    await assertSucceeds(uploadBytes(video(ALICE), BLOB));
  });

  it('keeps the free backup allowance out of it', async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), `users/${ALICE}/billing/usage`), {
        v: 1, bytes: 500 * 1024 * 1024, objects: 1, updatedAt: Timestamp.now(),
      });
    });
    await assertSucceeds(uploadBytes(photo(ALICE), BLOB));
  });
});
```

The fourth test is the cross-plan guard: a user at their Cloud backup ceiling must still be able to
send a photo, because the two budgets are separate.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd firebase/rules-tests && npm test -t 'chat media objects'`
Expected: FAIL — the catch-all `match /{allPaths=**} { allow read, write: if false; }` denies everything under `messages/`.

- [ ] **Step 3: Add the block**

Before the catch-all in `firebase/storage.rules`, using whichever membership form Task 1 established:

```
    // Chat media: the Storage half of `conversations/{cid}` in Firestore. Both participants read
    // and write; nobody else touches it.
    //
    // No entitlement is checked here, deliberately. Pro is enforced on the message DOCUMENT by
    // `ssProActive` in the Firestore rules, and an object with no document pointing at it is
    // invisible to every reader and is swept by the 30-day lifecycle rule -- so there is nothing
    // to gain by uploading one. Cloud is not checked because chat media is not a Cloud feature:
    // an account with no term, or a lapsed one, sends and receives normally.
    //
    // The caps are resource limits, not a security boundary. The object is opaque ciphertext, so
    // the server cannot tell a photo from a video by inspection; the paths differ only so the two
    // ceilings can.
    match /messages/{cid}/photo/{objectId} {
      allow read, delete: if ssConvMember(cid);
      allow create, update: if ssConvMember(cid)
        && request.resource.size < 8 * 1024 * 1024
        && request.resource.contentType == 'application/octet-stream';
    }
    match /messages/{cid}/video/{objectId} {
      allow read, delete: if ssConvMember(cid);
      allow create, update: if ssConvMember(cid)
        && request.resource.size < 100 * 1024 * 1024
        && request.resource.contentType == 'application/octet-stream';
    }
    // The preview, stored rather than inlined in Firestore so that the same 30-day lifecycle rule
    // expires it with the media it previews. A preview that outlived its photo would mean an
    // "expired" image still showing a recognisable 256 px copy of itself for ever.
    match /messages/{cid}/thumb/{objectId} {
      allow read, delete: if ssConvMember(cid);
      allow create, update: if ssConvMember(cid)
        && request.resource.size < 32 * 1024
        && request.resource.contentType == 'application/octet-stream';
    }
```

with `ssConvMember(cid)` defined per Task 1 — either `request.auth != null && request.auth.uid in
cid.split('__')`, or the `firestore.get(...).data.members` fallback.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd firebase/rules-tests && npm test`
Expected: PASS, with every pre-existing storage test still passing.

- [ ] **Step 5: Commit**

```bash
git add firebase/storage.rules firebase/rules-tests/storage.test.js
git commit -m "feat(rules): shared Storage paths for end-to-end encrypted chat media"
```

---

### Task 3: The media cipher

**Files:**
- Create: `src/messaging/media.ts`
- Create: `src/messaging/__tests__/media.test.ts`

**Interfaces:**
- Consumes: `aeadEncrypt`, `aeadDecrypt`, `SODIUM_AEAD_NONCE_BYTES` from `@/crypto/sodium`; `base64Encode`/`base64Decode` from `@/utils/base64`.
- Produces: `MAX_PHOTO_BYTES`, `MAX_VIDEO_BYTES`, `MAX_THUMB_BYTES`, `THUMB_MAX_EDGE`; `type MediaKind = 'photo' | 'video'`; `mediaAad(binding)`, `thumbAad(binding)`, `sealMedia(bytes, key, binding)`, `openMedia(sealed, key, binding)`, `sealThumb`, `openThumb`.

Mirror `src/messaging/messageCipher.ts` exactly — same shapes, same "returns null on any failure"
discipline for the open functions.

- [ ] **Step 1: Write the failing test**

```ts
describe('media cipher', () => {
  const key = new Uint8Array(32).fill(7);
  const binding = {
    conversationId: 'a__b',
    from: 'a',
    createdAt: 1_700_000_000_000,
    objectPath: 'messages/a__b/photo/m1',
  };

  it('round trips', () => {
    const sealed = sealMedia(new Uint8Array([1, 2, 3]), key, binding, nonce);
    expect(openMedia(sealed, key, binding)).toEqual(new Uint8Array([1, 2, 3]));
  });

  // Binding the object path is what stops a valid ciphertext being re-pointed at another message.
  it('does not open under a different object path', () => {
    const sealed = sealMedia(new Uint8Array([1, 2, 3]), key, binding, nonce);
    expect(
      openMedia(sealed, key, { ...binding, objectPath: 'messages/a__b/photo/OTHER' }),
    ).toBeNull();
  });

  it.each(['conversationId', 'from', 'createdAt'] as const)(
    'does not open under a different %s',
    (field) => {
      const sealed = sealMedia(new Uint8Array([1, 2, 3]), key, binding, nonce);
      const tampered = { ...binding, [field]: field === 'createdAt' ? 1 : 'x' };
      expect(openMedia(sealed, key, tampered)).toBeNull();
    },
  );

  // Separate AAD domains, so neither can be replayed as the other.
  it('will not open a thumbnail as a body', () => {
    const thumb = sealThumb(new Uint8Array([9]), key, binding, nonce);
    expect(openMedia(thumb, key, binding)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/messaging/__tests__/media.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Follow `messageCipher.ts`. The AAD strings are:

```ts
const MEDIA_AAD = 'silentsum/media/v1';
const THUMB_AAD = 'silentsum/mediathumb/v1';

export function mediaAad(b: MediaBinding): string {
  return `${MEDIA_AAD}|${b.conversationId}|${b.from}|${String(b.createdAt)}|${b.objectPath}`;
}
```

with `thumbAad` identical but for `THUMB_AAD`. Caps:

```ts
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
export const MAX_THUMB_BYTES = 32 * 1024;
export const THUMB_MAX_EDGE = 256;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/messaging/__tests__/media.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/messaging/media.ts src/messaging/__tests__/media.test.ts
git commit -m "feat(messaging): media cipher bound to conversation, sender and object path"
```

---

### Task 4: A message that is not text

**Files:**
- Modify: `src/messaging/messaging.ts:192-223` (`parseStoredMessage`, `messageRecord`, `DecryptedMessage`)
- Modify: `src/messaging/__tests__/messaging.test.ts`

**Interfaces:**
- Consumes: `MediaKind` from Task 3.
- Produces: `StoredMessage` gains `kind: MediaKind | null`, `object: string | null`, `bytes: number`, `thumbObject: string | null`. `DecryptedMessage` gains `kind`, `object`, `thumbObject`. `mediaRecord(...)` beside `messageRecord(...)`.

The record stores a **pointer** to the thumbnail, never the thumbnail itself. Firestore holds no
image bytes at all, which is what makes the Storage lifecycle rule a complete expiry rather than a
partial one.

- [ ] **Step 1: Write the failing test**

```ts
describe('parseStoredMessage', () => {
  it('reads a record with no kind as text, so nothing already sent breaks', () => {
    const parsed = parseStoredMessage('m1', {
      v: 1, from: 'a', box: 'Yg==', nonce: 'bg==', createdAt: 1,
    });
    expect(parsed).toMatchObject({ kind: null, object: null });
  });

  it('reads a photo record', () => {
    const parsed = parseStoredMessage('m2', {
      v: 1, kind: 'photo', from: 'a', box: 'Yg==', nonce: 'bg==', createdAt: 1,
      object: 'messages/a__b/photo/m2', bytes: 1234, thumbObject: 'messages/a__b/thumb/m2',
    });
    expect(parsed).toMatchObject({
      kind: 'photo', object: 'messages/a__b/photo/m2', bytes: 1234,
      thumbObject: 'messages/a__b/thumb/m2',
    });
  });

  // No image bytes may live in Firestore: a record carrying them would survive the Storage
  // lifecycle sweep and leave a preview of an "expired" photo behind for ever.
  it('carries a pointer to the thumbnail, never the thumbnail', () => {
    const parsed = parseStoredMessage('m2', {
      v: 1, kind: 'photo', from: 'a', box: 'Yg==', nonce: 'bg==', createdAt: 1,
      object: 'messages/a__b/photo/m2', bytes: 1234, thumbObject: 'messages/a__b/thumb/m2',
    });
    expect(parsed).not.toHaveProperty('thumb');
    expect(parsed).not.toHaveProperty('thumbBytes');
  });

  // An unknown kind must not be dropped: a silent gap is the one failure a user cannot tell
  // from "they never wrote". It parses, and the UI shows it as unopenable.
  it('keeps a record whose kind it does not understand', () => {
    const parsed = parseStoredMessage('m3', {
      v: 1, kind: 'hologram', from: 'a', box: 'Yg==', nonce: 'bg==', createdAt: 1,
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.kind).toBe('unknown');
  });

  it('refuses a media record with no object', () => {
    expect(parseStoredMessage('m4', {
      v: 1, kind: 'photo', from: 'a', box: 'Yg==', nonce: 'bg==', createdAt: 1,
    })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/messaging/__tests__/messaging.test.ts -t parseStoredMessage`
Expected: FAIL — `kind` is not on `StoredMessage`.

- [ ] **Step 3: Extend the parser and the record builders**

Keep `messageRecord` byte-identical for text — it must not start writing a `kind` field, or every
existing reader sees a change it did not need. Add `mediaRecord(from, kind, sealed, object, bytes,
thumbObject, now)` beside it. In the parser, treat a missing `kind` as text (`null`), a known kind
as itself, and anything else as `'unknown'`.

`thumbObject` is nullable on purpose: a video whose thumbnail could not be generated is still a
valid message, and after 30 days every media record points at objects that no longer exist. Neither
case may make the record unparseable — the bubble must still render, as expired.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/messaging/__tests__/messaging.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/messaging/messaging.ts src/messaging/__tests__/messaging.test.ts
git commit -m "feat(messaging): message records carry a kind, defaulting to text"
```

---

### Task 5: Sending and fetching

**Files:**
- Modify: `src/messaging/messagingService.ts`
- Modify: `src/messaging/__tests__/messagingService.test.ts`

**Interfaces:**
- Consumes: Tasks 3 and 4; `CloudBackend.putBlobFromFile`, `getBlobToFile`, `putBlob`, `getBlob`, `deleteBlob`; `ThumbnailGenerator.generate(image, maxDimension)` returning `ThumbnailResult { jpegBytes, … }`.
- Produces: `MessagingService.sendMedia(conversationId, source: { uri: string; kind: MediaKind; bytes: number }): Promise<void>`; `MessagingService.fetchMedia(conversationId, message: DecryptedMessage): Promise<string>` returning a local file uri; `MessagingService.fetchThumb(conversationId, message: DecryptedMessage): Promise<Bytes | null>` returning `null` once the thumbnail has expired.

The thumbnail is small enough for the byte-level API (`putBlob` / `getBlob`), which already exists
on `CloudBackend` alongside the file-level pair the full media uses. `CLOUD_ERROR_CODES.objectNotFound`
is what both fetches map onto `'expired'`.

**Ordering is load-bearing.** Upload both objects first — thumbnail, then media — and write the
document last. A document pointing at an object that does not exist is a permanently broken bubble;
an object with no document is invisible to every reader and the lifecycle rule sweeps it within 30
days. So every partial failure leaves litter that expires, never a bubble that cannot be repaired.

- [ ] **Step 1: Write the failing test**

```ts
it('sends a photo the other side can open, with nothing readable at rest', async () => {
  const world = new World();
  const alice = await world.join(ALICE, 1, { pro: true });
  const bob = await world.join(BOB, 2, { pro: true });
  const conversationId = await alice.messaging.startConversation(BOB);

  await alice.messaging.sendMedia(conversationId, {
    uri: 'file://photo.jpg', kind: 'photo', bytes: 4096,
  });
  await flush();

  const thread = collect((on) => bob.messaging.watchConversation(conversationId, on));
  await flush();
  const message = thread.last().messages[0];
  expect(message?.kind).toBe('photo');
  expect(message?.thumbObject).toMatch(/^messages\/.+\/thumb\//);
  expect(await bob.messaging.fetchThumb(conversationId, message)).not.toBeNull();

  const uri = await bob.messaging.fetchMedia(conversationId, message);
  expect(await bob.cloud.readFile(uri)).toEqual(PHOTO_BYTES);
});

// Everything the expiry has to remove must be in Storage. Anything left in Firestore outlives the
// lifecycle rule for ever.
it('puts no image bytes in the message document', async () => {
  const world = new World();
  const alice = await world.join(ALICE, 1, { pro: true });
  await world.join(BOB, 2, { pro: true });
  const conversationId = await alice.messaging.startConversation(BOB);

  await alice.messaging.sendMedia(conversationId, {
    uri: 'file://photo.jpg', kind: 'photo', bytes: 4096,
  });
  await flush();

  const [, record] = [...world.store.documents.entries()]
    .find(([key]) => key.includes('/messages/')) ?? [];
  expect(record).not.toHaveProperty('thumb');
  expect(record).not.toHaveProperty('thumbNonce');
  expect(record?.thumbObject).toContain('/thumb/');
});

// What a 30-day-old photo does. The bubble stays; the imagery is gone, preview included.
it('reports both the media and its thumbnail as expired once swept', async () => {
  const world = new World();
  const alice = await world.join(ALICE, 1, { pro: true });
  const bob = await world.join(BOB, 2, { pro: true });
  const conversationId = await alice.messaging.startConversation(BOB);
  await alice.messaging.sendMedia(conversationId, {
    uri: 'file://photo.jpg', kind: 'photo', bytes: 4096,
  });
  await flush();

  const thread = collect((on) => bob.messaging.watchConversation(conversationId, on));
  await flush();
  const message = thread.last().messages[0];
  world.store.expireBlobsUnder(`messages/${conversationId}/`); // what the lifecycle rule does

  expect(await bob.messaging.fetchThumb(conversationId, message)).toBeNull();
  await expect(bob.messaging.fetchMedia(conversationId, message))
    .rejects.toMatchObject({ code: 'expired' });
  // The record itself survives: the conversation history is not rewritten.
  expect(thread.last().messages[0]?.kind).toBe('photo');
});

it('writes no document when the upload fails', async () => {
  // A bubble pointing at an object that is not there can never be fixed; an orphaned object is
  // invisible and expires on its own. So the upload must land before the document does.
  const world = new World();
  const alice = await world.join(ALICE, 1, { pro: true });
  await world.join(BOB, 2, { pro: true });
  const conversationId = await alice.messaging.startConversation(BOB);
  alice.cloud.failNextBlobUpload();

  await expect(
    alice.messaging.sendMedia(conversationId, { uri: 'file://p.jpg', kind: 'photo', bytes: 4096 }),
  ).rejects.toThrow();

  expect([...world.store.documents.keys()].filter((k) => k.includes('/messages/'))).toEqual([]);
});

it('refuses media without Pro, exactly as it refuses text', async () => {
  const world = new World();
  const alice = await world.join(ALICE, 1, { pro: false });
  await world.join(BOB, 2, { pro: true });
  const conversationId = conversationIdFor(alice.uid, world.accounts.get(BOB) ?? '');

  await expect(
    alice.messaging.sendMedia(conversationId, { uri: 'file://p.jpg', kind: 'photo', bytes: 4096 }),
  ).rejects.toMatchObject({ code: 'pro-required' });
});

// The property the earlier draft of the spec got wrong.
it('sends media with no Cloud term at all', async () => {
  const world = new World();
  const alice = await world.join(ALICE, 1, { pro: true }); // Pro only; no cloud.accessUntil
  await world.join(BOB, 2, { pro: true });
  const conversationId = await alice.messaging.startConversation(BOB);

  await expect(
    alice.messaging.sendMedia(conversationId, { uri: 'file://p.jpg', kind: 'photo', bytes: 4096 }),
  ).resolves.toBeUndefined();
});

it.each([
  ['photo', MAX_PHOTO_BYTES + 1],
  ['video', MAX_VIDEO_BYTES + 1],
] as const)('refuses an oversized %s before uploading anything', async (kind, bytes) => {
  const world = new World();
  const alice = await world.join(ALICE, 1, { pro: true });
  await world.join(BOB, 2, { pro: true });
  const conversationId = await alice.messaging.startConversation(BOB);

  await expect(
    alice.messaging.sendMedia(conversationId, { uri: 'file://big', kind, bytes }),
  ).rejects.toMatchObject({ code: 'rejected' });
  expect(alice.cloud.blobWrites).toEqual([]);
});
```

The `World` harness in that file needs three things the fake backend does not have yet. Extend the
in-memory store in `src/firebase/cloudBackend.ts` with:

- `blobWrites` — the paths written, so a test can assert nothing was uploaded.
- `failNextBlobUpload()` — one injected failure, following the style of whatever failure injection
  the class already has.
- `expireBlobsUnder(prefix)` — delete every blob under a prefix, leaving documents untouched. This
  is the only way to test expiry, because the lifecycle rule is bucket configuration that no test
  can run. The loop already exists inline inside `deleteAccount`; lift it into a small helper and
  have `deleteAccount` call it, rather than writing it twice.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/messaging/__tests__/messagingService.test.ts -t media`
Expected: FAIL — `sendMedia` does not exist.

- [ ] **Step 3: Implement**

```ts
  /**
   * Encrypts one photo or video plus its preview, uploads both, then writes the message that
   * points at them.
   *
   * The objects go up BEFORE the document, and that order is not an accident: a document whose
   * object is missing is a bubble that can never be repaired, while an object whose document was
   * never written is invisible to every reader and is removed by the 30-day lifecycle rule. Every
   * partial failure therefore leaves litter that expires on its own.
   *
   * The thumbnail is uploaded, not embedded. Storing it in the message document would put it
   * beyond the reach of the lifecycle rule and leave a recognisable preview of an expired photo in
   * Firestore for ever.
   *
   * Pro is required exactly as it is for text, and nothing here reads a Cloud term.
   */
  async sendMedia(conversationId: string, source: MediaSource): Promise<void> {
    const cloud = this.requireCloud();
    const uid = this.requireUid();
    if (!this.canMessage()) throw new MessagingError('pro-required');
    const cap = source.kind === 'photo' ? MAX_PHOTO_BYTES : MAX_VIDEO_BYTES;
    if (source.bytes > cap) throw new MessagingError('rejected', 'too-long');
    // …derive the conversation key; generate + seal the thumbnail and `putBlob` it to
    // `messages/<cid>/thumb/<id>`; encrypt the file to a scratch path and `putBlobFromFile` it to
    // `messages/<cid>/<kind>/<id>`; only then putDocument(MESSAGING_PATHS.message(...),
    // mediaRecord(...)) with the same lastMessageAt / unread increment merge that `send` performs.
  }
```

`fetchMedia` is the mirror: `getBlobToFile` into a scratch path, decrypt, return the local uri.

`fetchThumb` is the same shape over `getBlob`, with one deliberate difference — it returns `null`
for a missing object instead of throwing. An expired preview is the ordinary end state of every
message older than 30 days, not an error, and a thread scrolling through a year of history would
otherwise be throwing constantly.

Both must distinguish a swept object from a genuine failure: add `'expired'` to
`MessagingErrorCode` and map `CLOUD_ERROR_CODES.objectNotFound` onto it, so the screen can say
"expired" rather than "something went wrong".

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/messaging`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/messaging/messagingService.ts src/firebase/cloudBackend.ts src/messaging/__tests__/
git commit -m "feat(messaging): send and fetch encrypted photos and video"
```

---

### Task 6: The bubble, and attaching from the camera or the library

**Files:**
- Create: `src/messaging/screens/MediaBubble.tsx`
- Create: `src/messaging/screens/AttachSheet.tsx`
- Modify: `src/messaging/screens/ConversationScreen.tsx`
- Modify: `src/messaging/screens/__tests__/ConversationScreen.test.tsx`

**Interfaces:**
- Consumes: `sendMedia`, `fetchMedia`, `fetchThumb` (Task 5); `DecryptedMessage.kind`, `.thumbObject` (Task 4).
- Produces: nothing other tasks rely on.

**The cost of storing thumbnails.** Previews are no longer free to render: each one is a Storage
read and a decrypt. That is the price of making them expire, and it is the right trade — but it
means the bubble must cache. Hold decrypted thumbnails in a `Map<string, Bytes>` on the screen,
keyed by `thumbObject`, so scrolling a thread up and down fetches each preview once per session and
a re-render fetches nothing. Without that cache an inverted `FlatList` re-fetches on every pass.

- [ ] **Step 1: Write the failing test**

```tsx
it('shows a photo bubble from its stored thumbnail', async () => {
  // …render a conversation holding one photo message
  expect(await screen.findByTestId('conversation_media_m1')).toBeTruthy();
  // The preview, not the full media: opening a thread must not pull megabytes.
  expect(alice.cloud.blobReads).toEqual(['messages/a__b/thumb/m1']);
});

it('fetches each thumbnail once however often the row re-renders', async () => {
  // …render, then force a re-render of the list
  expect(alice.cloud.blobReads.filter((p) => p.includes('/thumb/'))).toHaveLength(1);
});

// After 30 days nothing visual remains -- that is the point of expiring the preview too.
it('shows an expired photo with no preview at all', async () => {
  // …both objects swept, document still present
  expect(await screen.findByTestId('conversation_media_expired_m1'))
    .toHaveTextContent(/expired/i);
  expect(screen.queryByTestId('conversation_media_m1')).toBeNull();
});

it('offers no attach button without Pro', async () => {
  // …a non-Pro account viewing a conversation
  expect(screen.queryByTestId('conversation_attach')).toBeNull();
  expect(screen.getByTestId('conversation_cannot_send')).toHaveTextContent(/part of SilentSum Pro/i);
});

it('offers all three sources', async () => {
  fireEvent.press(screen.getByTestId('conversation_attach'));
  expect(screen.getByTestId('attach_camera')).toBeTruthy();
  expect(screen.getByTestId('attach_library')).toBeTruthy();
  expect(screen.getByTestId('attach_vault')).toBeTruthy();
});

// The vault's own import picker is images-only (Plan 1). A message may carry video from anywhere,
// so this call site differs on purpose -- stated as a test so it is not "fixed" into consistency.
it('opens the library with video allowed', async () => {
  fireEvent.press(screen.getByTestId('conversation_attach'));
  fireEvent.press(screen.getByTestId('attach_library'));
  expect(launchImageLibrary).toHaveBeenCalledWith(
    expect.objectContaining({ mediaTypes: ['images', 'videos'] }),
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/messaging/screens/__tests__/ConversationScreen.test.tsx`
Expected: FAIL — no attach button, no media bubble.

- [ ] **Step 3: Implement**

`MediaBubble` renders the decrypted thumbnail at the bubble's width with the same tail treatment
`Bubble` already uses, a play badge for video, a progress ring while uploading, a retry affordance
on failure, and four states in all:

| State | What it shows |
| --- | --- |
| loading | a placeholder at the bubble's size — never a collapsing row, or the list jumps as previews land |
| ready | the decrypted preview |
| expired | a dimmed placeholder reading "This photo has expired", **with no preview** |
| failed | the same placeholder with a retry affordance, worded so it is not mistaken for expiry |

The distinction between the last two matters: `fetchThumb` returning `null` means the object is
gone and no retry will ever help, while a thrown error means the network failed and a retry may.
Showing "expired" for a dropped connection would tell the user their photo is destroyed when it is
not.

In `ConversationScreen`, add an attach button inside the composer row, rendered under the same
condition as the composer itself (`state?.canSend === true`) so Pro gating needs no new logic. It
opens `AttachSheet`, which offers three rows — **Camera**, **Photo library**, **From the vault**.

Wire the first two here:

- **Camera** — the existing `CameraSheet`, which already handles photo and video.
- **Photo library** — `expo-image-picker` through the `LaunchImageLibrary` type already exported
  from `src/gallery/importService.ts`, called with `mediaTypes: ['images', 'videos']`.

Both already suspend auto-lock, which matters more here than in the vault because an upload can
outlast a picker.

The third row is wired in Task 7. Until then it may render disabled or simply do nothing when
pressed — but it must already be *present*, because the sheet's layout and the test above are
settled here and changing a three-row sheet into a three-row sheet later is no work at all, while
growing a two-row sheet is.

Tapping a bubble calls `fetchMedia` and opens the result — the existing photo viewer for images,
and `PlaybackScratch.allocate()` / `release()` for video, exactly as the vault's video playback does.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsc --noEmit -p tsconfig.json && npm run lint && npx jest`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/messaging/screens/
git commit -m "feat(messaging): attach photos and video, and show them in the thread"
```

---

### Task 7: Sending from the vault, and the one-time notice

**Files:**
- Create: `src/messaging/vaultSendNotice.ts`
- Create: `src/messaging/__tests__/vaultSendNotice.test.ts`
- Create: `src/messaging/screens/VaultPickerSheet.tsx`
- Modify: `src/secure-storage/secureStore.ts` (one key, and `ALL_SECURE_STORE_KEYS`)
- Modify: `src/messaging/screens/ConversationScreen.tsx`
- Modify: `src/messaging/screens/__tests__/ConversationScreen.test.tsx`

**Interfaces:**
- Consumes: `sendMedia` (Task 5); `EncryptedVaultRepository.readFullImage`, `.readVideoToFile`; `PlaybackScratch`; `ThumbnailGenerator`; the `AttachSheet` from Task 6.
- Produces: `VaultSendNotice { hasSeen(cid): Promise<boolean>; markSeen(cid): Promise<void> }`.

This is the one route in the app that moves a vault item off the device to somebody else. The
picker is deliberately **not** `GalleryScreen`: that screen carries multi-select and a Delete
action, and a picker must not put a destructive action one mis-tap from a routine one. It reuses
`PhotoTile` and the repository instead, single-select.

- [ ] **Step 1: Write the failing tests**

```ts
// vaultSendNotice.test.ts -- pure, no UI.
describe('VaultSendNotice', () => {
  it('has not been seen in a conversation it has never been shown in', async () => {
    const notice = new VaultSendNotice(new InMemorySecureStore());
    await expect(notice.hasSeen('a__b')).resolves.toBe(false);
  });

  it('remembers per conversation, not globally', async () => {
    const notice = new VaultSendNotice(new InMemorySecureStore());
    await notice.markSeen('a__b');
    await expect(notice.hasSeen('a__b')).resolves.toBe(true);
    // Who the copy is going to is the part that matters, so a new conversation asks again.
    await expect(notice.hasSeen('a__c')).resolves.toBe(false);
  });

  it('survives a restart', async () => {
    const store = new InMemorySecureStore();
    await new VaultSendNotice(store).markSeen('a__b');
    await expect(new VaultSendNotice(store).hasSeen('a__b')).resolves.toBe(true);
  });

  // A corrupt row must not make the app unable to send; it must make it ask again.
  it('treats an unreadable record as nothing seen', async () => {
    const store = new InMemorySecureStore({ [SECURE_STORE_KEYS.vaultSendNotice]: '{not json' });
    await expect(new VaultSendNotice(store).hasSeen('a__b')).resolves.toBe(false);
  });

  it('is erased with the vault', () => {
    expect(ALL_SECURE_STORE_KEYS).toContain(SECURE_STORE_KEYS.vaultSendNotice);
  });
});
```

```tsx
// ConversationScreen.test.tsx
it('explains the first time, and not the second', async () => {
  // …open attach -> From the vault -> pick an item
  expect(await screen.findByTestId('vault_send_notice')).toHaveTextContent(/copy/i);
  fireEvent.press(screen.getByTestId('vault_send_notice_send'));
  await flush();
  expect(alice.messaging.sent).toHaveLength(1);

  // Second send in the same conversation: straight through.
  // …open attach -> From the vault -> pick an item
  expect(screen.queryByTestId('vault_send_notice')).toBeNull();
});

// Cancelling must remember nothing, or a mis-tap silently disables the explanation for ever.
it('remembers nothing when the notice is cancelled', async () => {
  // …reach the notice, then cancel
  fireEvent.press(screen.getByTestId('vault_send_notice_cancel'));
  expect(alice.messaging.sent).toHaveLength(0);
  // …reach it again
  expect(await screen.findByTestId('vault_send_notice')).toBeTruthy();
});

it('offers no delete affordance in the picker', async () => {
  // …open the vault picker
  expect(screen.queryByTestId('vault_picker_delete')).toBeNull();
  expect(screen.queryByText(/delete/i)).toBeNull();
});

// The trap. A 512px vault preview passes every local check and is refused by the Storage rule.
it('regenerates the thumbnail at 256 rather than reusing the vault s 512', async () => {
  // …send a vault photo
  const thumb = alice.cloud.blobs.get(alice.messaging.sent[0].thumbObject);
  expect(thumb.byteLength).toBeLessThan(32 * 1024);
  expect(alice.vault.readThumbnail).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/messaging -t vault`
Expected: FAIL — `vaultSendNotice` does not exist and the vault row does nothing.

- [ ] **Step 3: Implement**

`VaultSendNotice` stores a versioned record — `{ v: 1, conversations: string[] }` — under a new
`SECURE_STORE_KEYS.vaultSendNotice`, added to `ALL_SECURE_STORE_KEYS` so erasing the vault forgets
it with everything else. Every read is wrapped: an unreadable record reads as "nothing seen", which
fails toward asking again rather than toward sending silently.

`VaultPickerSheet` lists the repository's items with `PhotoTile`, single-select, with the same play
badge the gallery uses for video. Picking one resolves with its id and kind; it performs no I/O of
its own beyond the thumbnails it already renders.

In `ConversationScreen`, wire the vault row:

1. Open the picker; get an id and kind.
2. If `!(await notice.hasSeen(cid))`, show the notice. Cancel ends here, remembering nothing.
3. `markSeen(cid)`, then read the item — `readFullImage(id)` for a photo, `readVideoToFile(id,
   scratch)` for video, where `scratch` is a `PlaybackScratch.allocate()` so a decrypted video is
   purged on background like every other one.
4. Regenerate the thumbnail at `THUMB_MAX_EDGE` (256) from the decrypted item. **Do not call
   `readThumbnail`** — the vault's preview is 512px at quality 82 (`src/vault/types.ts`), typically
   40–90 KB, over the 32 KB cap. It would pass every test but the one above and fail on a device.
5. Hand the file and kind to `sendMedia`, which is unchanged.

Suspend auto-lock across the whole sequence, not just the picker: decrypting 100 MB of video and
uploading it can easily outlast the idle timeout.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsc --noEmit -p tsconfig.json && npm run lint && npx jest`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/messaging/ src/secure-storage/secureStore.ts
git commit -m "feat(messaging): send a vault item to a conversation, explained once per thread"
```

---

### Task 8: Saving received media into the vault

**Files:**
- Modify: `src/messaging/messagingService.ts`
- Modify: `src/messaging/__tests__/messagingService.test.ts`
- Modify: `src/messaging/screens/MediaBubble.tsx`
- Modify: `src/messaging/screens/__tests__/ConversationScreen.test.tsx`

**Interfaces:**
- Consumes: `fetchMedia` (Task 5); `EncryptedVaultRepository.addPhoto`/`.addVideo`; `vaultGate` **with the `bytes` signature from Plan 1**; the existing `VaultUpsellDialog`.
- Produces: `MessagingService.saveToVault(conversationId, message): Promise<void>`.

**This task is blocked on Plan 1** and is the only one here that is. `vaultGate` takes `bytes`
rather than `kind` only after Plan 1 Task 1 lands. Tasks 1–7 may proceed regardless; this one may
not, and must not be made to by adding a temporary `kind`-shaped call that then needs unpicking.

It closes the loop the 30-day expiry opens: media disappears from the server after a month, so
anything worth keeping has to be keepable. Without this, the expiry is lossy rather than tidy.

- [ ] **Step 1: Write the failing tests**

```ts
it('saves a received photo into the vault as an ordinary item', async () => {
  // …bob receives a photo from alice
  await bob.messaging.saveToVault(conversationId, message);
  expect(await bob.vault.count()).toBe(1);
});

it('saves a received video too', async () => {
  // …the same for kind 'video', through addVideo
});

// A received item is an ordinary vault item. No special case, no bypass.
it('refuses when the free vault is full, and says why', async () => {
  // …fill the vault to FREE_TIER.maxItems
  await expect(bob.messaging.saveToVault(conversationId, message))
    .rejects.toMatchObject({ code: 'vault-full' });
  expect(await bob.vault.count()).toBe(FREE_TIER.maxItems);
});

it('refuses an item over the per-item cap on every tier', async () => {
  // …a video larger than MAX_ITEM_BYTES, with Cloud active
});

// Expired media cannot be saved, and must say so rather than failing obscurely.
it('reports an expired item as expired rather than as a vault error', async () => {
  world.store.expireBlobsUnder(`messages/${conversationId}/`);
  await expect(bob.messaging.saveToVault(conversationId, message))
    .rejects.toMatchObject({ code: 'expired' });
});
```

```tsx
it('offers Save to vault on a received item, and shows the upsell when full', async () => {
  // …a full free vault
  fireEvent.press(screen.getByTestId('media_save_to_vault_m1'));
  expect(await screen.findByTestId('vault_upsell')).toBeTruthy();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/messaging -t vault`
Expected: FAIL — `saveToVault` does not exist.

- [ ] **Step 3: Implement**

```ts
  /**
   * Keeps a received photo or video, as an ordinary vault item.
   *
   * The 30-day expiry makes this necessary rather than optional: without a way to keep something,
   * the expiry destroys it. What it must NOT do is bypass the vault's own limits -- a received
   * item counts against the 50-item free cap and the per-item size cap exactly as one from the
   * camera does, because the vault's limits are about the vault, not about where a file came from.
   */
  async saveToVault(conversationId: string, message: DecryptedMessage): Promise<void> {
    const uri = await this.fetchMedia(conversationId, message); // throws 'expired' if swept
    // …gate on vaultGate({ bytes, itemCount, cloudActive, enforced }), then addPhoto / addVideo,
    // then release the scratch file whether or not the add succeeded.
  }
```

The scratch release belongs in a `finally`: a refused save must not leave a decrypted copy of
somebody's photo in the cache directory, which is the failure that matters most here.

**The two add methods take different things**, which is easy to get wrong because `fetchMedia`
returns a uri for both: `addPhoto(image: ImageInput, options)` wants `image.bytes`, while
`addVideo(video: VideoInput, options)` wants `video.uri`. So the photo branch reads the scratch
file back into memory and the video branch hands over the path — deliberately, since a 100 MB video
must not be loaded into memory to be stored.

On the bubble, the action shows the existing `VaultUpsellDialog` when the gate refuses, so the
ceiling reads as a limit with a way past it. An `'expired'` failure gets the bubble's existing
expired wording instead — the two must not share a message.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsc --noEmit -p tsconfig.json && npm run lint && npx jest`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/messaging/
git commit -m "feat(messaging): save received photos and video into the vault"
```

---

### Task 9: The lifecycle rule and the documentation

**Files:**
- Modify: `firebase/README.md`
- Modify: `docs/messaging.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

**This task is not optional and must not be deferred.** The 30-day expiry is the only bound on
storage cost for this feature: every byte of chat media, video included, is carried by a one-time
₱299 payment with no quota and no recurring revenue behind it. Shipping the feature without the
rule applied is shipping an unbounded liability.

- [ ] **Step 1: Verify the live bucket before writing any rule — this is a gate**

The Firebase project `eevee-mate` is **shared with EVPAL**, so a lifecycle rule — a standing
instruction to delete data on a schedule — has to be aimed with care.

**The isolation already exists, and it is at the bucket level, not the prefix level.** `firebase.json`
pins SilentSum to its own bucket and says why in its own header comment:

```json
"storage": [{ "bucket": "silentsum-vault-eevee-mate", "rules": "firebase/storage.rules" }]
```

> "The storage entry names SilentSum's own bucket explicitly so a deploy can never touch
> `eevee-mate.appspot.com`, which belongs to EVPAL."

`FirebaseCloudBackend` enforces the same pinning at runtime (`gs://${this.storageBucket}`, from
`extra.firebaseStorageBucket`), and `src/firebase/__tests__/storageBucket.test.ts` exists to keep it
that way. **EVPAL's data is in a different bucket**, which is a far stronger boundary than a prefix
matcher — a rule applied to `gs://silentsum-vault-eevee-mate` cannot reach `eevee-mate.appspot.com`
however it is written.

That is the static evidence. It is not a substitute for looking, because what `firebase.json`
declares and what the live bucket contains are different claims, and assuming a capability or a
configuration matches reality is exactly what produced the three device-only failures in
`docs/messaging.md`. So look:

```bash
gcloud storage ls gs://silentsum-vault-eevee-mate/ && gcloud storage buckets describe gs://silentsum-vault-eevee-mate --format="default(lifecycle)"
```

```bash
gcloud storage ls --recursive gs://silentsum-vault-eevee-mate/messages/ 2>&1 | head -50
```

The first shows every top-level prefix in SilentSum's bucket and any lifecycle rule **already**
present. The second shows whether anything is under `messages/` yet.

Four outcomes:

- **Only `users/` present, no lifecycle rule.** The expected state. Proceed to Step 2.
- **A lifecycle rule already exists.** Do not run `buckets update` with a fresh file — it replaces
  the entire rule set rather than appending. Merge the new rule into the existing set and apply the
  whole set at once.
- **The bucket does not exist, or the name differs from `firebase.json`.** Stop and resolve the
  discrepancy before doing anything else; a rule applied to the wrong bucket is the exact failure
  this step exists to prevent.
- **Anything present that SilentSum did not write, or any doubt about what wrote it.** **Stop.
  Report the finding and apply no rule.** Do not rename the prefix, narrow the matcher, or work
  around it unilaterally — a decision about another product's data is not this plan's to make.

Record what was observed, with the date, in `firebase/README.md` beside the rule. A future
maintainer needs to know this was checked and when, not that it was once believed to be fine.

**`gcloud` is not installed on this machine** (checked 2026-09-24: not on `PATH`, and neither is
`gsutil`). Applying the rule needs it anyway, so installing and authenticating the Google Cloud SDK
is part of this step. Until then the same two questions can be answered from the Firebase console's
Storage tab — the bucket selector lists every bucket in the project, and the Rules/Lifecycle view
shows any rule already present — which is enough to confirm the expected state, though not to apply
anything.

- [ ] **Step 2: Write the operational step into `firebase/README.md`**

```markdown
### Chat media expiry (required before chat media ships)

Chat media under `messages/` — the media AND its thumbnail — is deleted 30 days after upload by a
bucket lifecycle rule. It is configuration, not code, and nothing in the app enforces it.

Checked before applying (record the date each time): `messages/` in
`gs://silentsum-vault-eevee-mate` holds SilentSum chat media only, and no other lifecycle rule is
present. EVPAL lives in a different bucket, `eevee-mate.appspot.com`, which this rule cannot reach.

    gcloud storage buckets update gs://silentsum-vault-eevee-mate --lifecycle-file=firebase/storage-lifecycle.json

`firebase/storage-lifecycle.json`:

    { "rule": [ { "action": { "type": "Delete" },
                  "condition": { "age": 30, "matchesPrefix": ["messages/"] } } ] }

Verify with `gcloud storage buckets describe gs://silentsum-vault-eevee-mate --format="default(lifecycle)"`.

Two things this rule must keep doing:

- Match ONLY the `messages/` prefix. Without `matchesPrefix` it would delete users' cloud backups
  under `users/`, which have no expiry and must never acquire one.
- Cover `messages/` wholly, so `photo/`, `video/` and `thumb/` all expire together. A preview that
  outlives its media is the failure this design exists to avoid.

`buckets update` REPLACES the whole rule set. Before running it, confirm the bucket has no other
lifecycle rule, or merge into it.
```

Create `firebase/storage-lifecycle.json` with that content.

- [ ] **Step 3: Update `docs/messaging.md`**

Add a short section stating that messages carry text, photos or video; that media is Pro with no
Cloud condition; that it comes from the camera, the photo library **or the vault**, and that a
vault send is a copy explained once per conversation; that a received item can be **saved into the
vault**, subject to the ordinary vault limits; that **the media and its thumbnail both expire after
30 days**, leaving the message in the thread but no imagery; and that none of it counts against the
Cloud backup allowance.

- [ ] **Step 4: Commit**

```bash
git add firebase/README.md firebase/storage-lifecycle.json docs/messaging.md
git commit -m "docs(messaging): the 30-day chat-media lifecycle rule, and how to apply it"
```

---

## Rollout order

**Bucket verification (Task 9 Step 1)** → Storage rules → app → **lifecycle rule applied before
anyone can send**. Rules first is safe because the paths are new: nothing exists under `messages/`
to lock out. The verification comes first because its worst outcome is "stop and report", and that
answer is worth having before the rest of the rollout is in motion.

## Security and privacy implications

- **A new shared Storage prefix.** `messages/{cid}/…` is the first non-owner-scoped path in the
  bucket. Its object names contain a conversation id, which is two uids — so object names are
  social-graph metadata and must never be logged, including by Plan 2's usage triggers.
- **Pro is enforced on the document, not the object.** An attacker with a conversation they belong
  to could upload objects without Pro. They gain nothing — no document, no bubble, swept in 30 days
  — but it is storage they can consume, bounded by the caps and the expiry. Accepted, and stated
  here so it is a known position rather than an oversight.
- **The caps are not a security boundary.** The ciphertext is opaque, so a small video can be
  uploaded down the photo path. Since neither path checks an entitlement, this buys nothing.
- **The thumbnail is a stored object, not a Firestore field**, encrypted under the conversation key
  with its own AAD domain. At 256 px it is a real preview of the image and is exactly as sensitive
  as the image, so it gets the same membership rule and the same 30-day expiry. Storing it this way
  is the whole reason expiry is complete: a thumbnail inline in Firestore would be beyond the reach
  of any bucket lifecycle rule, and an "expired" photo would keep showing a recognisable copy of
  itself indefinitely to anyone who could read the conversation.
- **The message record survives the expiry, and that is intended.** After 30 days the thread still
  shows who sent a photo and when, with no imagery. The metadata is the conversation history; the
  content is what expires. Anyone who needs the history gone deletes the conversation.
- **Previews now cost a Storage read.** Opening a thread fetches one object per media message
  rather than reading bytes already in the document. This is the price of expiring thumbnails, and
  it makes the read pattern of a conversation visible to the server as a count of requests per
  conversation prefix — the same metadata the message documents already expose, so nothing new is
  leaked, but the request volume is higher.
- **Decrypted media on disk.** Full-size images and video are written to scratch files to be
  displayed. Video already goes through `PlaybackScratch`, which purges on background; images
  fetched by `fetchMedia` must be released the same way, or a decrypted photo outlives the session
  in the cache directory. Three new paths add to this: a vault video decrypted for sending, a
  received item decrypted for saving, and a refused save — the last is the one to watch, because
  the natural implementation leaves the file behind on the failure branch. The release belongs in
  a `finally`.
- **The vault picker is the first door out of the vault.** Until now nothing moved a vault item off
  the device except the user's own encrypted backup. This sends a copy to somebody else, and the
  one-time notice per conversation is the whole mitigation — a user who taps through it has still
  sent the photo. What limits the damage is that it is a separate, deliberate route rather than the
  default, and that the vault's own copy is never moved or altered.
- **Save to vault must not become a way around the vault's limits.** A received item goes through
  the same `vaultGate` as one from the camera. If it ever skipped the gate, chat would be a free
  channel for filling a free vault past 50 items, and the limit would be advisory.
