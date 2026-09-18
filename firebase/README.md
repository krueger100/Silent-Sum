# Firebase rules

Nothing in this folder is deployed automatically, and nothing here has been deployed. The
`eevee-mate` project is shared with other apps; deploying any of it without reading it first can
take away access those apps depend on.

| File | What it is | Where it goes |
|---|---|---|
| `firestore.rules` | SilentSum's rules standalone, for a project of its own | a dedicated project only |
| `firestore.merged.rules` | the same rules merged into what is live on `eevee-mate` today | **review this one** before any Firestore deploy |
| `storage.rules` | SilentSum's Storage rules | **SilentSum's own bucket only** - never the project default |

## Why SilentSum has its own Storage bucket

The default bucket of `eevee-mate` currently carries:

```
match /{allPaths=**} { allow read; allow write: if request.auth != null; }
```

That is public unauthenticated read and any-signed-in write over every path in the bucket. Storage
rules OR together within a bucket, so adding a stricter owner-only rule for `users/<uid>/**` there
would not take those grants away - vault blobs would still be world-readable and overwritable by
any other account. Narrowing that catch-all is not safe to do blind either: the other app builds
its Storage paths dynamically, and a third app registered on the project has no source here.

A separate bucket has its own ruleset, so `storage.rules` applies to SilentSum's data and to
nothing else, and the default bucket is never opened. The bucket name is a build input
(`FIREBASE_STORAGE_BUCKET`); with none set the app offers no cloud backup at all rather than
falling back to the shared bucket.

Blob confidentiality never depended on any of this - every object is XChaCha20-Poly1305 ciphertext
encrypted on the device, and the PIN and vault keys are never uploaded. What the rules protect is
everything else: who can list your backup, overwrite it, or delete it.
