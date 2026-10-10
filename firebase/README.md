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

## Billing (added 2026-09-21)

`firestore.merged.rules` now also grants the owner READ on `users/{uid}/billing/entitlements`
(written only by the `silentsum` Cloud Functions through the Admin SDK) and gates envelope and
manifest `create, update` on an active Cloud term (`ssCloudActive`, i.e. `cloud.accessUntil >
request.time`). `storage.rules` gates uploads the same way through `firestore.get`; reads and
deletes are never gated. The server-only collections `silentsum_billing_refs`,
`silentsum_billing_events` and `silentsum_billing_payments` have no match and are closed.

Deploy order: functions (`firebase deploy --only functions:silentsum`), then the app, then these
rules. `rules-tests/` runs both rulesets against the emulators: `cd rules-tests && npm install &&
npm test` (Java and the Firebase CLI required).

## What is deployed right now (2026-09-22)

`firebase/firestore.stage1.rules`, released with `firebase deploy --only firestore:rules --config
firebase.stage1.json`. It is `firestore.merged.rules` with one difference: the Cloud-term gate on
`users/{uid}/vault/envelope` and `.../manifest` writes is **not** in it, because the app build that
can buy Cloud has not shipped and deploying the gate first would stop every existing backup.
Everything else is identical, so the staged file is purely additive over the ruleset that was live
before it: same `stripe_customers` block, same vault matches, plus the read-only billing
entitlements match and the support-chat block (which does gate *sending* on an active term).

Storage rules were not deployed; `firebase.stage1.json` has no storage entry at all.

The messaging block (`messagingKeys`, `conversations`, `users/{uid}/contacts`) was added to
this file and released on 2026-09-22, in the same way. It was additive over what was already
live: three new collections, no change to any existing rule, so backup, billing and support chat
were unaffected.

When the app that sells Cloud ships, deploy the real thing and drop the staging files:

```
firebase deploy --only firestore:rules --project eevee-mate
git rm firebase.stage1.json firebase/firestore.stage1.rules
```

`SILENTSUM_RULES_FILE=firestore.stage1.rules npm run test:firestore` runs the suite against the
staged ruleset. Three tests fail there by design — the ones asserting the backup gate.

## Chat media expiry (required before chat media ships)

Chat media under `messages/` — the media **and** its thumbnail — is deleted 30 days after upload
by a bucket lifecycle rule. It is configuration, not code, and nothing in the app enforces it.

That rule carries the entire cost model for the feature: every byte of chat media, video included,
is stored against a one-time ₱299 payment with no quota and no recurring revenue behind it.
Shipping chat media without the rule applied is shipping an unbounded liability.

**Before applying it, inspect the live bucket. This is a gate, not a formality.**

```
gcloud storage ls gs://silentsum-vault-eevee-mate/
gcloud storage buckets describe gs://silentsum-vault-eevee-mate --format="default(lifecycle)"
gcloud storage ls --recursive gs://silentsum-vault-eevee-mate/messages/
```

The project is shared with EVPAL, so a standing delete rule has to be aimed with care. The
isolation is already at bucket level rather than prefix level — `firebase.json` pins this app to
`silentsum-vault-eevee-mate`, and EVPAL uses the project default bucket,
`eevee-mate.appspot.com`, which this rule cannot reach however it is written. That is the static
evidence; it is not a substitute for looking, because what a config file declares and what a
bucket contains are two different claims.

Four outcomes:

- **Only `users/` present, no lifecycle rule.** The expected state. Apply the rule.
- **A lifecycle rule already exists.** Do **not** run `buckets update` with a fresh file — it
  replaces the entire rule set rather than appending. Merge and apply the whole set at once.
- **The bucket is missing, or its name differs from `firebase.json`.** Stop and resolve that
  first; a rule applied to the wrong bucket is the exact failure this step exists to prevent.
- **Anything present that SilentSum did not write.** Stop and report. Do not rename the prefix or
  narrow the matcher unilaterally — a decision about another product's data is not ours to make.

Record what was observed, with the date, below. A future maintainer needs to know this was
checked and when, not that it was once believed to be fine.

    Checked: (not yet -- gcloud is not installed on the development machine as of 2026-09-25)

Then:

```
gcloud storage buckets update gs://silentsum-vault-eevee-mate \
  --lifecycle-file=firebase/storage-lifecycle.json
gcloud storage buckets describe gs://silentsum-vault-eevee-mate --format="default(lifecycle)"
```

Two things the rule must keep doing:

- **Match only the `messages/` prefix.** Without `matchesPrefix` it would delete users' cloud
  backups under `users/`, which have no expiry and must never acquire one.
- **Cover `messages/` wholly**, so `photo/`, `video/` and `thumb/` expire together. A preview that
  outlives its media is the failure this design exists to avoid.

## Lapsed Cloud backups: Autoclass (added 2026-10-10, NOT YET APPLIED)

A Cloud term lapses and the backup stays. Storage writes already require `cloudActive`, so a
lapsed account cannot add anything — but nothing removes what is there, `users/` has no lifecycle
rule by design, and no function reclaims anything. The result is a bill that only ever grows
against revenue that has stopped.

The size of it, at roughly $0.023/GB-month: a lapsed 100 GB account costs about $2.30 every
month, for ever, having paid ₱99 once. Against a Cloud price that nets $1.54, that single account
is a permanent loss, and nothing bounds how many of them there are.

**The fix is Autoclass, and deliberately NOT deletion.** For some users the cloud copy is the only
copy, and we cannot warn them before destroying it: `SILENTSUM_SUPPORT_FROM` is Resend's shared
test sender, which delivers only to the Resend account's own address, so there is no channel to a
user who has stopped opening the app. Deleting data you cannot give notice about is not a cost
measure, it is a liability.

Autoclass moves each object down — Standard, Nearline, Coldline, Archive — as it goes unread, and
back to Standard the moment it is read. For a backup that is exactly right: written once, read
only on a restore. A lapsed account's data descends to Archive on its own and costs roughly a
twentieth of Standard; an active subscriber who restores pulls it back, and **pays no retrieval
fee**, because Autoclass waives retrieval and early-deletion charges. Hand-tuned lifecycle
tiering would save about as much and charge for every restore.

It costs a management fee per object per month (about $0.0025 per 1,000). At the manifest's
20,000-item ceiling that is about $0.05 a month, against several dollars saved.

**THE TRAP, and the reason this is written down.** Autoclass and `SetStorageClass` lifecycle rules
are mutually exclusive: enabling Autoclass disables `SetStorageClass`, and adding such a rule
later is the thing that would silently undo this. `storage-lifecycle.json` must therefore stay
**delete-only**. Its `messages/` delete rule is unaffected and keeps working — delete rules are
the one kind Autoclass permits. If a future change wants age-based tiering, it has to choose:
that, or Autoclass, never both.

**Inspect before enabling.** Enabling is not free on existing objects: it can trigger one-time
retrieval, early-deletion and Class A charges for what is already there. On a small bucket that is
noise; look first rather than assume it still is.

```
gcloud storage buckets describe gs://silentsum-vault-eevee-mate \
  --format="default(autoclass,lifecycle,storageClass)"
gcloud storage du --summarize gs://silentsum-vault-eevee-mate/users/
```

Then, and note this touches only SilentSum's own bucket — never `eevee-mate.appspot.com`, which
is EVPAL's:

```
gcloud storage buckets update gs://silentsum-vault-eevee-mate --enable-autoclass
gcloud storage buckets describe gs://silentsum-vault-eevee-mate --format="default(autoclass)"
```

gcloud is not installed on the development machine, so this is also the console path:
Cloud Storage → `silentsum-vault-eevee-mate` → Configuration → Autoclass → Enable.

Afterwards the lifecycle rule set must still contain the `messages/` delete rule and nothing
else; check with the `describe` above.

    Enabled: (not yet -- awaiting a run on a machine with gcloud, or the console)

## Support relay (added 2026-09-26)

`silentsumSupportRelay` is the app's customer-service form. It replaced a direct call to Resend that
carried an API key compiled into the app bundle, where anyone who unzipped a build could read it.

It needs, before the app's support form works:

```bash
firebase functions:secrets:set RESEND_API_KEY --project eevee-mate
firebase deploy --only functions:silentsum --project eevee-mate
```

and `SILENTSUM_SUPPORT_FROM` / `SILENTSUM_SUPPORT_TO` in `functions/.env` (already set). Without the
secret the deploy fails; without the two addresses the endpoint answers 503 and sends nothing.

The app is then pointed at it with `SUPPORT_ENDPOINT` in the root `.env`:
`https://<region>-<project>.cloudfunctions.net/silentsumSupportRelay`. The app sends no credential,
and `src/support/supportConfig.ts` refuses a mail provider's host as an endpoint, so the old
arrangement cannot come back through configuration.

### The counters need a TTL policy

Rate-limit counters are written to `silentsum_support_relay`, one document per bucket per 15-minute
window, each carrying `expiresAt`. No Firestore rule matches that collection, so it is closed to
every client; only the Admin SDK writes it.

Nothing breaks without a TTL policy — a new window means a new document id, so the counts stay
correct — the documents simply accumulate. Set one so they do not:

```
gcloud firestore fields ttls update expiresAt \
  --collection-group=silentsum_support_relay --enable-ttl --project=eevee-mate
```

    Applied: (not yet -- gcloud is not installed on the development machine as of 2026-09-26)

This is housekeeping, not a gate: unlike the chat-media lifecycle rule above, nothing is deleted by
it that matters, and it touches a SilentSum-only collection rather than a shared bucket.
