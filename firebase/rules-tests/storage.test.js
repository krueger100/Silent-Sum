/**
 * The Storage rules for SilentSum's own bucket, against the Storage emulator, with the Firestore
 * emulator beside it for the cross-service `firestore.get` that gates uploads.
 */
const fs = require('node:fs');
const path = require('node:path');
const {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} = require('@firebase/rules-unit-testing');
const { doc, setDoc, Timestamp } = require('firebase/firestore');
const { ref, uploadBytes, getBytes, deleteObject } = require('firebase/storage');

const PROJECT_ID = 'demo-silentsum';
const ALICE = 'alice-uid';
const BOB = 'bob-uid';
const DAY = 86_400_000;
const BLOB = new Uint8Array([0x53, 0x53, 0x56, 0x31, 1, 1, 2, 3]);

let env;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: fs.readFileSync(path.resolve(__dirname, '..', 'firestore.merged.rules'), 'utf8'),
    },
    storage: {
      rules: fs.readFileSync(path.resolve(__dirname, '..', 'storage.rules'), 'utf8'),
    },
  });
});

afterAll(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.clearStorage();
});

async function serverWritesEntitlements(uid, accessUntilMs) {
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), `users/${uid}/billing/entitlements`), {
      v: 1,
      pro: false,
      cloud: { status: 'active', accessUntil: Timestamp.fromMillis(accessUntilMs) },
      updatedAt: Timestamp.now(),
    });
  });
}

/** The emulator's default bucket carries the rules loaded above; the real bucket is named in firebase.json. */
function storageFor(uid) {
  return env.authenticatedContext(uid).storage();
}

function objectRef(uid, name) {
  return ref(storageFor(uid), `users/${uid}/${name}`);
}

const OCTET = { contentType: 'application/octet-stream' };

describe('uploads need an active Cloud term', () => {
  it('refuses a free account and a lapsed one', async () => {
    await assertFails(uploadBytes(objectRef(ALICE, 'index.enc'), BLOB, OCTET));
    await serverWritesEntitlements(ALICE, Date.now() - 1000);
    await assertFails(uploadBytes(objectRef(ALICE, 'index.enc'), BLOB, OCTET));
  });

  it('allows an active term, opaque type only, and never for someone else', async () => {
    await serverWritesEntitlements(ALICE, Date.now() + DAY);
    await assertSucceeds(uploadBytes(objectRef(ALICE, 'photos/p1.enc'), BLOB, OCTET));
    await assertFails(
      uploadBytes(objectRef(ALICE, 'photos/p2.enc'), BLOB, { contentType: 'image/jpeg' }),
    );
    await assertFails(
      uploadBytes(ref(storageFor(BOB), `users/${ALICE}/photos/p3.enc`), BLOB, OCTET),
    );
  });
});

describe('reads and deletes never need a term', () => {
  it('lets a lapsed account download and delete its own objects', async () => {
    await serverWritesEntitlements(ALICE, Date.now() + DAY);
    await assertSucceeds(uploadBytes(objectRef(ALICE, 'photos/p1.enc'), BLOB, OCTET));

    await serverWritesEntitlements(ALICE, Date.now() - 1000);
    await assertSucceeds(getBytes(objectRef(ALICE, 'photos/p1.enc')));
    await assertFails(getBytes(ref(storageFor(BOB), `users/${ALICE}/photos/p1.enc`)));
    await assertSucceeds(deleteObject(objectRef(ALICE, 'photos/p1.enc')));
  });
});


describe('chat media objects', () => {
  const cid = [ALICE, BOB].sort().join('__');
  const photo = (uid) => ref(storageFor(uid), `messages/${cid}/photo/m1`);
  const video = (uid) => ref(storageFor(uid), `messages/${cid}/video/m2`);
  const thumb = (uid) => ref(storageFor(uid), `messages/${cid}/thumb/m1`);

  it('lets either member write and read all three kinds', async () => {
    await assertSucceeds(uploadBytes(photo(ALICE), BLOB, OCTET));
    await assertSucceeds(uploadBytes(video(ALICE), BLOB, OCTET));
    await assertSucceeds(uploadBytes(thumb(ALICE), BLOB, OCTET));
    await assertSucceeds(getBytes(photo(BOB)));
    await assertSucceeds(getBytes(video(BOB)));
    await assertSucceeds(getBytes(thumb(BOB)));
  });

  it('refuses an outsider entirely', async () => {
    await assertFails(uploadBytes(photo('carol-uid'), BLOB, OCTET));
    // The thumbnail is a preview of the image and is exactly as sensitive as it.
    await assertFails(uploadBytes(thumb('carol-uid'), BLOB, OCTET));
    await env.withSecurityRulesDisabled(async (context) => {
      await uploadBytes(ref(context.storage(), `messages/${cid}/photo/m1`), BLOB, OCTET);
    });
    await assertFails(getBytes(ref(storageFor('carol-uid'), `messages/${cid}/photo/m1`)));
  });

  // The whole point of the revised model: no entitlement is read in this block at all.
  it('lets a member with no Cloud term write every kind', async () => {
    // No entitlement document is written for ALICE in this test at all.
    await assertSucceeds(uploadBytes(photo(ALICE), BLOB, OCTET));
    await assertSucceeds(uploadBytes(video(ALICE), BLOB, OCTET));
    await assertSucceeds(uploadBytes(thumb(ALICE), BLOB, OCTET));
  });

  it('keeps a lapsed Cloud term out of it', async () => {
    await serverWritesEntitlements(ALICE, Date.now() - 1000);
    await assertSucceeds(uploadBytes(photo(ALICE), BLOB, OCTET));
  });

  it('holds each kind to its own cap', async () => {
    await assertFails(uploadBytes(thumb(ALICE), new Uint8Array(33 * 1024), OCTET));
    await assertFails(uploadBytes(photo(ALICE), new Uint8Array(9 * 1024 * 1024), OCTET));
  });

  it('requires opaque ciphertext, exactly as the backup paths do', async () => {
    await assertFails(uploadBytes(photo(ALICE), BLOB, { contentType: 'image/jpeg' }));
  });

  it('lets a member delete, so a failed send can clean up after itself', async () => {
    await assertSucceeds(uploadBytes(photo(ALICE), BLOB, OCTET));
    await assertSucceeds(deleteObject(photo(BOB)));
  });
});
