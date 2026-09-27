# 500 MB free cloud-backup allowance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Free accounts 500 MB of cloud backup instead of none, enforced by the server, with Cloud remaining unlimited.

**Architecture:** A usage ledger at `users/{uid}/billing/usage` is maintained by two Cloud Storage trigger functions and read by the Storage rules alongside `request.resource.size`. The client never writes it and cannot forge it. Reads and deletes are never gated, so an account at its ceiling can still restore everything and can always delete its way back under the line.

**Tech Stack:** Firebase Functions v2 (Node 22, `firebase-functions@^7.4.0`), Firebase Admin SDK, Storage security rules, `@firebase/rules-unit-testing` against the Storage + Firestore emulators.

**Spec:** `docs/billing.md`, sections "The limits" and "Enforcing the backup allowance".

## Global Constraints

- Free cloud backup: **500 MB** (`500 * 1024 * 1024`) total. Cloud: unlimited.
- Photos and videos both count. **Chat media under `messages/` must never count** — it belongs to Pro, not Cloud (`docs/superpowers/specs/2026-09-24-chat-media-design.md`).
- **Accounts already above 500 MB when enforcement goes live keep everything.** The limit applies from that day forward: nothing is deleted, everything stays restorable, and only *new* backup uploads are refused until the account is back under the line or on Cloud. See "Accounts already over the line".
- The 50-item local vault limit is a **separate** limit and is not touched by this plan. See `docs/superpowers/plans/2026-09-24-free-tier-vault-video.md`.
- Per-object size ceiling stays **100 MB** and applies on every tier.
- **Reads and deletes are never gated by usage.** Being full must never mean being locked out of your own data.
- The ledger is written **only** by the Admin SDK. Firestore rules must refuse every client write to it.
- Functions live in the `silentsum` codebase and deploy with `FUNCTIONS_DISCOVERY_TIMEOUT=180 npx firebase deploy --only functions:silentsum:<name> --project eevee-mate`. The `--only` filter needs the codebase prefix.
- Run `cd functions && npm run typecheck && npx jest`, and `cd firebase/rules-tests && npm test` (needs `JAVA_HOME` set to the Android Studio JBR) before each commit.

## Dependencies between the three plans

**Confirmed order: Plan 1 → Plan 3 → this plan.** This plan is last, which is the right place for
it: it is the only one of the three with a deploy sequence, a backfill over live data, and a
failure mode that reaches existing users' backups.

- **Independent of Plan 1** (free-tier vault video). Neither reads the other's code.
- **Coupled to Plan 3 (chat media) in exactly one place**: the triggers must ignore the `messages/` prefix. That filter is built here, in Task 1, and is correct whether or not Plan 3 has shipped.
- **Because Plan 3 ships first, `messages/` objects will already exist** when this plan's triggers and backfill run. Both must ignore them, and both do: `accountForObject` returns null for that prefix, and the backfill lists with `prefix: 'users/'` so it never sees them at all. The two filters are deliberately redundant — this is the one place where a mistake would bill a Pro user's conversation against their Cloud allowance, so it is guarded twice and tested in Task 1.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `functions/src/storageUsage.ts` | pure: which objects count, and for whom | Create |
| `functions/src/firestoreUsageStore.ts` | the ledger over Firestore, transactional | Create |
| `functions/src/index.ts` | the two trigger declarations | Modify |
| `functions/src/__tests__/storageUsage.test.ts` | pure-logic tests | Create |
| `functions/src/__tests__/firestoreUsageStore.test.ts` | ledger tests | Create |
| `functions/scripts/backfillUsage.ts` | one-off reconciliation | Create |
| `firebase/storage.rules` | the allowance gate | Modify |
| `firebase/firestore.merged.rules`, `firebase/firestore.stage1.rules` | ledger readable by owner, writable by nobody | Modify |
| `firebase/rules-tests/storage.test.js` | allowance rules tests | Modify |
| `src/backup/screens/CloudBackupScreen.tsx` | usage display and the at-limit state | Modify |

---

### Task 1: Decide which objects count

**Files:**
- Create: `functions/src/storageUsage.ts`
- Create: `functions/src/__tests__/storageUsage.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `FREE_BACKUP_BYTES: number`; `accountForObject(name: string): string | null`.

This is the whole security-relevant decision of the feature, isolated so it can be tested without a
database: given an object name, whose backup allowance does it count against, if anyone's.

- [ ] **Step 1: Write the failing test**

```ts
import { FREE_BACKUP_BYTES, accountForObject } from '../storageUsage';

describe('accountForObject', () => {
  it('counts the objects cloud backup actually writes', () => {
    expect(accountForObject('users/alice-uid/index.enc')).toBe('alice-uid');
    expect(accountForObject('users/alice-uid/photos/p1.enc')).toBe('alice-uid');
    expect(accountForObject('users/alice-uid/thumbs/p1.enc')).toBe('alice-uid');
  });

  // Chat media belongs to Pro and is bounded by its own 30-day expiry. Counting it here would
  // charge one product's traffic against another product's budget.
  it('never counts chat media, previews included', () => {
    expect(accountForObject('messages/alice-uid__bob-uid/photo/m1')).toBeNull();
    expect(accountForObject('messages/alice-uid__bob-uid/video/m1')).toBeNull();
    expect(accountForObject('messages/alice-uid__bob-uid/thumb/m1')).toBeNull();
  });

  it('ignores anything outside a user folder', () => {
    expect(accountForObject('index.enc')).toBeNull();
    expect(accountForObject('users/')).toBeNull();
    expect(accountForObject('users/alice-uid')).toBeNull();
    expect(accountForObject('users/alice-uid/')).toBeNull();
    expect(accountForObject('')).toBeNull();
  });

  // A uid is opaque, but it is never a path segment that could climb out of its own folder.
  it('refuses a uid that is not a plain segment', () => {
    expect(accountForObject('users/../secrets/x.enc')).toBeNull();
    expect(accountForObject('users/.././x.enc')).toBeNull();
  });

  it('is 500 MB', () => {
    expect(FREE_BACKUP_BYTES).toBe(500 * 1024 * 1024);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd functions && npx jest src/__tests__/storageUsage.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
/**
 * Which stored objects count against an account's cloud-backup allowance.
 *
 * Only the objects cloud backup itself writes, all of them under `users/<uid>/`: the index, the
 * photo ciphertext and the thumbnails (`BACKUP_PATHS` in `src/backup/types.ts`). Everything else
 * in the bucket is somebody else's business.
 *
 * Chat media under `messages/` is deliberately excluded and must stay excluded -- the media, and
 * its previews under `messages/<cid>/thumb/`, alike. It is a Pro feature bounded by a 30-day
 * object-lifecycle rule, not a Cloud one bounded by this allowance; counting it here would bill
 * one product's traffic to another product's budget and would make a Pro user's conversation eat
 * their Cloud backup space.
 *
 * The exclusion is by omission rather than by a `messages/` check: anything that is not under
 * `users/<uid>/` counts against nobody. That is the safer default, because a prefix this function
 * has never heard of is silently ignored instead of being charged to whoever the path happens to
 * resemble.
 */
export const FREE_BACKUP_BYTES = 500 * 1024 * 1024;

/** The account an object belongs to, or null when it counts against nobody. */
export function accountForObject(name: string): string | null {
  const parts = name.split('/');
  // users / <uid> / <at least one more segment>, and the last segment must be a real object.
  if (parts.length < 3) return null;
  if (parts[0] !== 'users') return null;
  const uid = parts[1];
  if (uid === undefined || uid === '' || uid === '.' || uid === '..') return null;
  if (parts[parts.length - 1] === '') return null;
  return uid;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd functions && npx jest src/__tests__/storageUsage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add functions/src/storageUsage.ts functions/src/__tests__/storageUsage.test.ts
git commit -m "feat(functions): decide which stored objects count against the backup allowance"
```

---

### Task 2: The ledger

**Files:**
- Create: `functions/src/firestoreUsageStore.ts`
- Create: `functions/src/__tests__/firestoreUsageStore.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `usagePath(uid: string): string`; `class FirestoreUsageStore { add(uid: string, deltaBytes: number, deltaObjects: number): Promise<void>; set(uid: string, bytes: number, objects: number): Promise<void> }`.

Follow `functions/src/firestoreDirectoryStore.ts` for style: a thin class over `Firestore`, a
`…Path(uid)` helper exported beside it, and a transaction where two writers could race.

- [ ] **Step 1: Write the failing test**

Use the Firestore emulator the functions suite already targets, or a hand-rolled fake if that suite
has no emulator wiring — check how `functions/src/__tests__/store.test.ts` does it and follow that
file rather than introducing a second style.

```ts
describe('FirestoreUsageStore', () => {
  it('starts an account at zero and adds to it', async () => {
    const store = new FirestoreUsageStore(db);
    await store.add('alice-uid', 1000, 1);
    await expect(read('alice-uid')).resolves.toMatchObject({ v: 1, bytes: 1000, objects: 1 });
  });

  it('subtracts on delete', async () => {
    const store = new FirestoreUsageStore(db);
    await store.add('alice-uid', 1000, 1);
    await store.add('alice-uid', -1000, -1);
    await expect(read('alice-uid')).resolves.toMatchObject({ bytes: 0, objects: 0 });
  });

  // A delete whose create was never counted -- an object written before this feature existed --
  // must not push the ledger negative, or the account would earn free space by deleting.
  it('never goes below zero', async () => {
    const store = new FirestoreUsageStore(db);
    await store.add('alice-uid', -5000, -1);
    await expect(read('alice-uid')).resolves.toMatchObject({ bytes: 0, objects: 0 });
  });

  it('set replaces rather than accumulating, so a backfill can be re-run', async () => {
    const store = new FirestoreUsageStore(db);
    await store.add('alice-uid', 1000, 1);
    await store.set('alice-uid', 42_000, 7);
    await store.set('alice-uid', 42_000, 7);
    await expect(read('alice-uid')).resolves.toMatchObject({ bytes: 42_000, objects: 7 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd functions && npx jest src/__tests__/firestoreUsageStore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
import type { Firestore } from 'firebase-admin/firestore';

export function usagePath(uid: string): string {
  return `users/${uid}/billing/usage`;
}

/**
 * The cloud-backup usage ledger, written only here and only by the Admin SDK.
 *
 * `add` is transactional because two uploads finishing at the same moment must not both read the
 * same total and both write their own. `set` exists for the backfill and replaces the total
 * outright, which is what makes re-running the backfill safe.
 *
 * The floor at zero matters: objects uploaded before this ledger existed have no matching
 * increment, so their deletes arrive as unmatched decrements. Without the clamp an account could
 * mine free allowance by deleting its own history.
 */
export class FirestoreUsageStore {
  constructor(private readonly db: Firestore) {}

  async add(uid: string, deltaBytes: number, deltaObjects: number): Promise<void> {
    const reference = this.db.doc(usagePath(uid));
    await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      const bytes = snapshot.exists ? snapshot.get('bytes') : 0;
      const objects = snapshot.exists ? snapshot.get('objects') : 0;
      transaction.set(reference, {
        v: 1,
        bytes: Math.max(0, (typeof bytes === 'number' ? bytes : 0) + deltaBytes),
        objects: Math.max(0, (typeof objects === 'number' ? objects : 0) + deltaObjects),
        updatedAt: new Date(),
      });
    });
  }

  async set(uid: string, bytes: number, objects: number): Promise<void> {
    await this.db.doc(usagePath(uid)).set({
      v: 1,
      bytes: Math.max(0, bytes),
      objects: Math.max(0, objects),
      updatedAt: new Date(),
    });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd functions && npx jest src/__tests__/firestoreUsageStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add functions/src/firestoreUsageStore.ts functions/src/__tests__/firestoreUsageStore.test.ts
git commit -m "feat(functions): transactional cloud-backup usage ledger"
```

---

### Task 3: The triggers

**Files:**
- Modify: `functions/src/index.ts` (header comment count, imports, two new exports)

**Interfaces:**
- Consumes: `accountForObject` (Task 1), `FirestoreUsageStore` (Task 2).
- Produces: deployed functions `silentsumStorageFinalized`, `silentsumStorageDeleted`.

- [ ] **Step 1: Add the trigger declarations**

At the end of `functions/src/index.ts`:

```ts
/**
 * The cloud-backup usage ledger, maintained from the bucket itself.
 *
 * Storage triggers rather than a callable, because the number has to be true no matter how the
 * object got there: the app uploads directly to Storage and never tells a function it did. A
 * client that skipped a "please count this" call would otherwise have unlimited free backup.
 *
 * Both handlers are no-ops for anything `accountForObject` does not claim, which is how chat media
 * under `messages/` stays out of the Cloud allowance.
 */
export const silentsumStorageFinalized = onObjectFinalized(async (event) => {
  const uid = accountForObject(event.data.name);
  if (uid === null) return;
  const size = Number(event.data.size ?? 0);
  if (!Number.isFinite(size) || size <= 0) return;
  await new FirestoreUsageStore(getFirestore()).add(uid, size, 1);
});

export const silentsumStorageDeleted = onObjectDeleted(async (event) => {
  const uid = accountForObject(event.data.name);
  if (uid === null) return;
  const size = Number(event.data.size ?? 0);
  if (!Number.isFinite(size) || size <= 0) return;
  await new FirestoreUsageStore(getFirestore()).add(uid, -size, -1);
});
```

Add the import:

```ts
import { onObjectDeleted, onObjectFinalized } from 'firebase-functions/v2/storage';
```

and the two local imports for `accountForObject` and `FirestoreUsageStore`. Update the file's
header comment: it currently says "Eight functions" and lists them — make it ten and add both lines.

- [ ] **Step 2: Typecheck**

Run: `cd functions && npm run typecheck`
Expected: PASS. `firebase-functions@^7.4.0` ships `v2/providers/storage`; verified present.

- [ ] **Step 3: Commit**

```bash
git add functions/src/index.ts
git commit -m "feat(functions): maintain the backup usage ledger from Storage triggers"
```

---

### Task 4: The ledger is readable by its owner and writable by nobody

**Files:**
- Modify: `firebase/firestore.merged.rules`, `firebase/firestore.stage1.rules` (beside the existing `users/{uid}/billing/entitlements` block)
- Modify: `firebase/rules-tests/firestore.test.js`

**Interfaces:**
- Consumes: `usagePath` shape from Task 2 (`users/{uid}/billing/usage`).
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

```js
describe('the cloud-backup usage ledger', () => {
  const usagePath = `users/${ALICE}/billing/usage`;

  async function serverWritesUsage(bytes) {
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), usagePath), {
        v: 1, bytes, objects: 1, updatedAt: Timestamp.now(),
      });
    });
  }

  it('is readable by its owner and nobody else', async () => {
    await serverWritesUsage(1000);
    await assertSucceeds(getDoc(doc(asAlice(), usagePath)));
    await assertFails(getDoc(doc(asBob(), usagePath)));
  });

  // If the owner could write this, the allowance would be advisory.
  it('cannot be written by its owner', async () => {
    await serverWritesUsage(1000);
    await assertFails(setDoc(doc(asAlice(), usagePath), { v: 1, bytes: 0, objects: 0 }));
    await assertFails(deleteDoc(doc(asAlice(), usagePath)));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd firebase/rules-tests && npm test`
Expected: FAIL on the read — no rule matches that path, so it is denied.

- [ ] **Step 3: Add the rule to BOTH rules files**

Immediately after the entitlements block in each file:

```
    // What cloud backup currently occupies, in bytes. Written only by the Storage triggers with
    // the Admin SDK; the owner reads it so the app can show "412 MB of 500 MB". A client that
    // could write this could grant itself unlimited backup, so nothing may.
    match /users/{uid}/billing/usage {
      allow read: if ssOwner(uid);
      allow write: if false;
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd firebase/rules-tests && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add firebase/firestore.merged.rules firebase/firestore.stage1.rules firebase/rules-tests/firestore.test.js
git commit -m "feat(rules): owner-readable, server-only cloud-backup usage ledger"
```

---

### Task 5: The allowance gate in the Storage rules

**Files:**
- Modify: `firebase/storage.rules:24-31`
- Modify: `firebase/rules-tests/storage.test.js`

**Interfaces:**
- Consumes: the ledger document from Task 4.
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

`storage.test.js` already imports `ref, uploadBytes, getBytes, deleteObject` and wires both
emulators; follow its existing `serverWritesEntitlements`-style helper for seeding Firestore.

```js
describe('the free backup allowance', () => {
  const FREE = 500 * 1024 * 1024;
  const object = (uid) => ref(storageAs(uid), `users/${uid}/photos/p1.enc`);

  async function serverWritesUsage(uid, bytes) {
    await env.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), `users/${uid}/billing/usage`), {
        v: 1, bytes, objects: 1, updatedAt: Timestamp.now(),
      });
    });
  }

  it('lets a free account upload while it is under the line', async () => {
    await serverWritesUsage(ALICE, FREE - 1_000_000);
    await assertSucceeds(uploadBytes(object(ALICE), BLOB));
  });

  it('refuses an upload that would cross the line', async () => {
    await serverWritesUsage(ALICE, FREE);
    await assertFails(uploadBytes(object(ALICE), BLOB));
  });

  // A new account has no ledger yet. That must read as "nothing used", not as "denied" --
  // otherwise the first backup any new user ever makes fails.
  it('treats a missing ledger as nothing used', async () => {
    await assertSucceeds(uploadBytes(object(ALICE), BLOB));
  });

  it('ignores the allowance entirely while Cloud is active', async () => {
    await serverWritesEntitlements(ALICE, Date.now() + DAY);
    await serverWritesUsage(ALICE, FREE * 10);
    await assertSucceeds(uploadBytes(object(ALICE), BLOB));
  });

  // Being full must never mean being locked out of your own data.
  it('still allows read and delete at the ceiling', async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      await uploadBytes(ref(context.storage(), `users/${ALICE}/photos/p1.enc`), BLOB);
    });
    await serverWritesUsage(ALICE, FREE * 10);
    await assertSucceeds(getBytes(object(ALICE)));
    await assertSucceeds(deleteObject(object(ALICE)));
  });

  // The existing-account case, stated as a test rather than only as prose. An account that was
  // already above the line on the day enforcement arrived keeps everything it has and can restore
  // all of it; only NEW uploads stop. Nothing about being over the line destroys data.
  it('leaves an already-over-the-line account whole, refusing only new uploads', async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      await uploadBytes(ref(context.storage(), `users/${ALICE}/photos/old.enc`), BLOB);
      await uploadBytes(ref(context.storage(), `users/${ALICE}/index.enc`), BLOB);
    });
    await serverWritesUsage(ALICE, FREE * 4); // 2 GB backed up before the rule existed

    // Restore: every existing object still readable.
    await assertSucceeds(getBytes(ref(storageAs(ALICE), `users/${ALICE}/photos/old.enc`)));
    await assertSucceeds(getBytes(ref(storageAs(ALICE), `users/${ALICE}/index.enc`)));
    // New backup data: refused.
    await assertFails(uploadBytes(object(ALICE), BLOB));
    // The way back down is always open, and needs nobody's permission.
    await assertSucceeds(deleteObject(ref(storageAs(ALICE), `users/${ALICE}/photos/old.enc`)));
  });

  it('lets that same account upload again once Cloud is bought', async () => {
    await serverWritesUsage(ALICE, FREE * 4);
    await assertFails(uploadBytes(object(ALICE), BLOB));
    await serverWritesEntitlements(ALICE, Date.now() + DAY);
    await assertSucceeds(uploadBytes(object(ALICE), BLOB));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd firebase/rules-tests && npm test`
Expected: FAIL — today every upload without Cloud is refused, so the first, third and fifth cases fail.

- [ ] **Step 3: Rewrite the rule**

In `firebase/storage.rules`, add beside `cloudActive`:

```
    function usedBytes(uid) {
      return firestore.exists(/databases/(default)/documents/users/$(uid)/billing/usage)
        ? firestore.get(/databases/(default)/documents/users/$(uid)/billing/usage).data.bytes
        : 0;
    }

    // Free accounts get 500 MB; Cloud is unlimited. A missing ledger means a new account that has
    // stored nothing yet, never a denial -- the first backup a user makes must not fail.
    function withinAllowance(uid, size) {
      return cloudActive(uid) || usedBytes(uid) + size <= 500 * 1024 * 1024;
    }
```

and replace the `users/{uid}/{allPaths=**}` block's write rule:

```
    match /users/{uid}/{allPaths=**} {
      allow read, delete: if isOwner(uid);
      allow create, update: if isOwner(uid)
        && withinAllowance(uid, request.resource.size)
        && request.resource.size < 100 * 1024 * 1024
        && request.resource.contentType == 'application/octet-stream';
    }
```

Update the file's header comment: uploads are no longer "a SilentSum Cloud feature" outright — they
are bounded by an allowance that Cloud removes.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd firebase/rules-tests && npm test`
Expected: PASS, including the existing cases (the 100 MB ceiling and the content-type check are unchanged).

- [ ] **Step 5: Commit**

```bash
git add firebase/storage.rules firebase/rules-tests/storage.test.js
git commit -m "feat(rules): 500 MB free cloud-backup allowance, unlimited with Cloud"
```

---

### Task 6: Backfill for accounts that already have data

**Files:**
- Create: `functions/scripts/backfillUsage.ts`

**Interfaces:**
- Consumes: `accountForObject` (Task 1), `FirestoreUsageStore.set` (Task 2).
- Produces: a script run by hand, not a deployed function.

**The problem.** Every existing account already has objects in Storage and no ledger. The rule in
Task 5 reads a missing ledger as zero, so on the day it deploys, every existing account silently
gets a fresh 500 MB on top of whatever it already stores. That is the *safe* direction — the unsafe
direction would be treating a missing ledger as "denied", which would break the backup of every
existing user the moment the rule landed — but it is still wrong, and it is wrong specifically for
the accounts that have the most data.

**The safest solution is ordering, not cleverness.** Deploy in three steps, in this order:

1. **Triggers first** (Task 3). From that moment every new object is counted. Nothing is enforced
   yet, so nothing can break.
2. **Backfill second** (this task). It lists what already exists and `set`s the true total,
   overwriting whatever the triggers accumulated in the gap. Because it sets rather than adds, it
   is idempotent and can be re-run.
3. **Rules last** (Task 5). Enforcement begins only once the numbers are true.

Deploying the rule before the backfill would enforce wrong numbers; deploying the backfill before
the triggers would leave a gap that nothing ever counts.

**What the backfill will surface.** Some accounts will land above 500 MB the moment their true
total is written — the ones that bought Cloud, filled it, and let the term lapse. That is expected,
not a bug in the backfill, and the policy for it is settled: see "Accounts already over the line".
The backfill's job is to report the truth, never to adjust it downward to be kind.

- [ ] **Step 1: Write the script**

```ts
/**
 * One-off reconciliation of the cloud-backup usage ledger.
 *
 * Run AFTER the Storage triggers are deployed and BEFORE the allowance rule is (see the plan).
 * It is idempotent: it computes each account's true total from the bucket and writes it with
 * `set`, so re-running it after a partial run is safe and is the correct response to any doubt.
 *
 *   cd functions && npx tsx scripts/backfillUsage.ts
 *
 * Small race, deliberately accepted: an upload that lands between listing an account's objects
 * and writing its total is not counted. The fix is to run it again; the exposure is one object.
 */
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

import { accountForObject } from '../src/storageUsage';
import { FirestoreUsageStore } from '../src/firestoreUsageStore';

async function main(): Promise<void> {
  if (getApps().length === 0) initializeApp();
  const [files] = await getStorage().bucket().getFiles({ prefix: 'users/' });

  const totals = new Map<string, { bytes: number; objects: number }>();
  for (const file of files) {
    const uid = accountForObject(file.name);
    if (uid === null) continue;
    const size = Number(file.metadata.size ?? 0);
    if (!Number.isFinite(size) || size <= 0) continue;
    const current = totals.get(uid) ?? { bytes: 0, objects: 0 };
    totals.set(uid, { bytes: current.bytes + size, objects: current.objects + 1 });
  }

  const store = new FirestoreUsageStore(getFirestore());
  for (const [uid, total] of totals) {
    await store.set(uid, total.bytes, total.objects);
    console.log(`${uid}: ${String(total.objects)} objects, ${String(total.bytes)} bytes`);
  }
  console.log(`reconciled ${String(totals.size)} accounts`);
}

void main();
```

- [ ] **Step 2: Typecheck**

Run: `cd functions && npm run typecheck`
Expected: PASS. If `tsconfig.build.json` excludes `scripts/`, leave it excluded — this file is run
with `tsx`, never deployed, and must not be bundled into the functions artefact.

- [ ] **Step 3: Commit**

```bash
git add functions/scripts/backfillUsage.ts
git commit -m "feat(functions): one-off backup usage reconciliation for existing accounts"
```

---

### Task 7: Show the allowance, and what happens at the ceiling

**Files:**
- Modify: `src/backup/screens/CloudBackupScreen.tsx`
- Modify: `src/billing/screens/CloudRequiredCard.tsx`
- Test: `src/backup/screens/__tests__/` (follow the existing screen tests in that folder)

**Interfaces:**
- Consumes: the ledger document, read through the existing `CloudBackend.watchDocument`/`getDocument` path the entitlements controller already uses for `users/{uid}/billing/entitlements`.
- Produces: nothing other tasks rely on.

- [ ] **Step 1: Write the failing test**

```tsx
it('shows how much of the free allowance is used', async () => {
  const harness = buildFreeBackupHarness({ usedBytes: 412 * 1024 * 1024 });
  await renderWithServices(harness.services, <CloudBackupScreen />);

  expect(screen.getByTestId('backup_usage')).toHaveTextContent(/412 MB of 500 MB/);
});

it('explains the ceiling without pretending backup is unavailable', async () => {
  const harness = buildFreeBackupHarness({ usedBytes: 500 * 1024 * 1024 });
  await renderWithServices(harness.services, <CloudBackupScreen />);

  const notice = screen.getByTestId('backup_at_limit');
  expect(notice).toHaveTextContent(/delete/i);
  expect(notice).toHaveTextContent(/SilentSum Cloud/);
  // Restoring is never gated by usage, so nothing here may suggest it is.
  expect(screen.queryByTestId('cloud_required')).toBeNull();
});

// The existing-account case: 2 GB backed up before the limit existed. Nothing was taken away, and
// the screen must not let the user believe otherwise -- "paused" read as "deleted" is the single
// worst misunderstanding this feature can cause.
it('reassures an account that is already over the line', async () => {
  const harness = buildFreeBackupHarness({ usedBytes: 2 * 1024 * 1024 * 1024 });
  await renderWithServices(harness.services, <CloudBackupScreen />);

  const notice = screen.getByTestId('backup_at_limit');
  expect(notice).toHaveTextContent(/safe|still there|nothing has been deleted/i);
  expect(notice).toHaveTextContent(/restore/i);
  // Restore stays available, and is the proof of the sentence above it.
  expect(screen.getByTestId('backup_restore')).toBeEnabled();
  expect(screen.getByTestId('backup_usage')).toHaveTextContent(/2(\.0)? GB of 500 MB/);
});
```

The last assertion is deliberate: the usage line shows the real number even when it is absurd
against the allowance. Hiding it, or clamping it to "500 MB of 500 MB", would leave the user unable
to work out how much to delete.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/backup`
Expected: FAIL — neither testID exists, and a free account currently sees `CloudRequiredCard`.

- [ ] **Step 3: Implement**

Replace the all-or-nothing `cloudGated` branch with three states:

- **under the allowance** — the normal controls, plus a `backup_usage` line.
- **at or over it** — the controls stay, plus a `backup_at_limit` notice that must say, in this
  order: **nothing has been deleted and everything already backed up can still be restored**; new
  backups are paused; deleting backup data resumes them; `PRODUCTS.cloud.name` removes the limit.
  Restore and delete stay enabled; this is the point of the design. The reassurance comes first
  because it is what an over-the-line user is actually worried about, and the rest of the notice is
  useless to someone who has just concluded their photos are gone.
- **Cloud active** — no usage line at all; the allowance does not apply.

`CloudRequiredCard` is no longer the right component for a free account on this screen — a free
account *can* back up. Leave the component in place for any other caller and stop rendering it here.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsc --noEmit -p tsconfig.json && npm run lint && npx jest`
Expected: PASS.

- [ ] **Step 5: Update the docs and commit**

In `docs/billing.md`, delete the "There is no 500 MB free backup allowance" bullet from "Not yet
true" and the `_Today_ this is all-or-nothing` note on the Cloud-gates bullet.

```bash
git add src/backup/ src/billing/screens/CloudRequiredCard.tsx docs/billing.md
git commit -m "feat(backup): show the free allowance and what happens at the ceiling"
```

---

## Accounts already over the line

Enforcement arrives for accounts that already hold data, and some of them hold more than 500 MB —
anyone who bought Cloud, used it, and let the term lapse. The confirmed policy:

| | Behaviour |
| --- | --- |
| Existing backup data | **Never deleted.** Not by this plan, not by the backfill, not by the rule. |
| Restore | **Always works**, at any usage level. Reads are never gated. |
| Delete | **Always works.** The way back under the line needs nobody's permission. |
| New backup uploads | **Refused** until usage drops below 500 MB or Cloud is active. |
| Cloud purchase | Lifts the limit immediately — `cloudActive` short-circuits `withinAllowance`. |

The rule in Task 5 already produces all of this, because it gates `create` and `update` only. No
extra code is needed; what is needed is that nobody later "tidies" `allow read, delete: if
isOwner(uid)` into something that also consults usage. The test
`leaves an already-over-the-line account whole` exists to make that edit fail loudly.

**Why the limit applies to them at all.** The alternative — grandfathering everyone above the line
on the day it lands — creates a permanent second free tier whose size is whatever each account
happened to have at one moment, invisible in the UI and impossible to explain to the user or to
support. A single line that everyone can see, with nothing destroyed on the day it arrives, is the
more honest arrangement.

**What the user must be told, and when.** An account that is over the line has *not* lost anything,
and the screen must say so plainly. The failure to avoid is a user reading "backup paused" as
"backup deleted" and concluding their photos are gone. Task 7's `backup_at_limit` notice carries
this, and its wording is the part of that task most worth getting right: state that everything
already backed up is safe and restorable, that only new uploads are paused, and give both ways
forward — delete some backup data, or get Cloud.

## Concurrent uploads and ledger lag

The ledger is updated by a trigger that fires *after* an object is written, so it always trails
reality by a moment. Two consequences, both accepted:

- **Overshoot.** Uploads racing each other can all read the same pre-upload total and all pass the
  rule, so an account can finish slightly over its allowance. The bound is the per-object ceiling
  times the number of genuinely concurrent uploads — tens of megabytes against a 500 MB line, and
  self-correcting, because the next upload sees the true total and is refused. A hard edge would
  need a lock or a mediating callable on every upload; both cost far more than the overshoot.
- **A brief lag after deleting.** Space freed by a delete becomes usable when the delete trigger
  lands, not the instant the object disappears. The at-limit notice should say "in a moment"
  rather than implying it is immediate.

Neither is a security property. The allowance is a commercial ceiling with a little give, not an
access control, and it is documented as such in `docs/billing.md`.

## Security and privacy implications

- **The ledger is a new server-written document about a user.** It holds two integers and a
  timestamp — no filenames, no sizes of individual items, nothing about content. Its read rule is
  owner-only, matching `billing/entitlements`.
- **The rule reads Firestore from Storage on every upload.** That is one extra document read per
  upload and an existing pattern (`cloudActive` already does it). It also means a Firestore outage
  degrades uploads; the existing `cloudActive` gate already has that property.
- **The triggers see every object name in the bucket**, including chat media paths, which contain
  two uids. They must not log object names: `accountForObject` returning null is a silent no-op,
  and nothing in either handler should `console.log` the path. Chat media names are conversation
  metadata.
- **A client cannot inflate its own allowance**, because the only writer is the Admin SDK and the
  rules refuse client writes to the ledger.
- **Deleting is always permitted**, which is deliberate: an account must be able to reduce its own
  usage without asking anyone, and must never be locked away from its own data by a billing state.
