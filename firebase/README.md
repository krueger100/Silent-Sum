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

    Checked: 2026-10-11, in the Cloud console (gcloud is still not installed here).
      Bucket silentsum-vault-eevee-mate exists and matches firebase.json.
      Top level holds exactly two prefixes: messages/ and users/. Nothing foreign.
      Lifecycle rules: NONE -- so the rule had never been applied, and chat media
      had never expired. This was outcome one, "apply the rule", plus the fact that
      messages/ already had content accumulating against no expiry at all.
      Location: asia MULTI-REGION. Soft delete: 7 days. Autoclass: enabled the same day.

    APPLIED: 2026-10-11, via the console, with Autoclass already on. The Lifecycle tab
      now reads exactly one rule and nothing else:
        Delete object | 30+ days since object was created, Name matches prefix 'messages/'
      Verified against the form's DOM before saving, not from a screenshot: action
      "Delete object", exactly two conditions ticked, age 30, prefix "messages/" as a
      single exact entry with no suffix condition. This matches storage-lifecycle.json
      field for field, so the file and the bucket finally agree.
      Google's console warns a new rule can take up to 24 hours to first evaluate.

**Applying it with Autoclass on.** Safe, and the reason is in the Autoclass section below: the
restriction is on `SetStorageClass` actions and `matchesStorageClass` conditions, and this rule
uses a `Delete` action with an `age` and a `matchesPrefix`. It touches none of them.

**Soft delete interacts with this.** The bucket keeps deleted objects for 7 days and bills for
them at their storage class, so chat media actually stops costing anything at day 37, not day
30. That is a reason to apply the rule sooner rather than a reason to change it.

**The app is already ready for objects to vanish.** `fetchThumb` distinguishes an expired object
(`object-not-found`) from a sealed one and from a retryable failure, so an expired chat
thumbnail says so instead of offering a retry that cannot work.

Without gcloud, the console path is: bucket → **Lifecycle** tab → **Add a rule** →
action **Delete object** → conditions **Age = 30 days** AND **Object name matches prefix =
`messages/`**. Both conditions, on one rule. Age alone would reach `users/` and delete people's
vault backups.

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

**THE TRAP, stated precisely.** Google's Autoclass page says a bucket cannot have Autoclass
enabled *and* a lifecycle rule using the `SetStorageClass` action or the `matchesStorageClass`
condition, and that **requests which would cause both fail**. So the two directions differ:

- *Enabling Autoclass* deletes any existing storage-class rules. The console says so in the
  enable dialog.
- *Adding* such a rule afterwards is **refused outright** — it does not silently switch
  Autoclass off, which an earlier version of this note claimed.

`storage-lifecycle.json` must still stay **delete-only**, and `test/storageLifecycle.test.js`
still earns its place: it catches the mistake at commit time instead of at apply time, when the
failure would be a confusing API error against live infrastructure. Delete rules are unaffected
and are the kind Autoclass permits. If a future change wants age-based tiering, it has to
choose: that, or Autoclass, never both.

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

    Enabled: 2026-10-11, via the console (Configuration -> Default storage class -> Autoclass).
    Included classes: Standard, Nearline, Coldline, Archive -- the full ladder, Archive terminal.
    Lifecycle rules at the time: NONE, so nothing was deleted by the enablement.

Note for anyone reading the console later: Autoclass is not a row of its own. It is the pencil
beside **Default storage class**, which afterwards reads "Managed with Autoclass" with an
**Included classes** row underneath. The enable dialog's blurb says "Standard or Nearline",
which describes the common case and not what this bucket got -- check Included classes, because
a Nearline floor would throw away most of the saving.

**Autoclass is load-bearing, not an optimisation.** Without it all three price bands lose money
at the top of their band. With it they clear 22–30% once a vault has matured. The full table,
against this bucket's real location, is in the next section.

## Cloud subscriptions (added 2026-10-11, NOT YET LIVE)

`silentsumStartCloudSubscription` creates a real monthly PayMongo subscription, so Cloud can
renew on its own instead of being bought 30 days at a time. The code is written and tested; it
cannot run yet, for reasons that are not code.

### Two things PayMongo must enable, by e-mail

Neither is self-service. Both are stated on PayMongo's own documentation pages:

1. **Subscriptions.** The subscriptions guide says to "contact PayMongo support to enable
   subscriptions on your account". Until then `POST /v1/subscriptions` is refused.
2. **The payment method must be activated** on the account — the same guide says to "Ensure that
   your PayMongo Account is activated for the supported payment method". For SilentSum that is
   **Maya**.

Mail support@paymongo.com for both. Card vaulting is a third thing PayMongo gates ("Card Vaulting
is only available for select accounts") and SilentSum deliberately does **not** want it — see
below.

### Why Maya and not cards

PayMongo supports cards and Maya for subscriptions. A card subscription requires the card to be
vaulted, and vaulting is done by sending `card_number`, `exp_month`, `exp_year` and `cvc` to
`POST /v1/payment_methods`. There is no hosted page for a subscription's first payment, so those
fields would have to be collected in the app and passed through our own backend — which puts
SilentSum's servers inside PCI DSS scope for the sake of one product.

A Maya payment method needs nothing but `{"type": "paymaya"}`. `SubscriptionWallet` in
`functions/src/paymongo/client.ts` is therefore a one-member union, and
`clientSubscriptions.test.ts` asserts the request body has exactly one key. The cost is that
card-only customers cannot subscribe; they can still buy a 30-day term, which takes every method.

### The flow, as the API documents it

| step | call |
| --- | --- |
| 1 | `POST /v1/subscriptions/plans` — one plan per band, cached in `silentsum_billing_plans` |
| 2 | `POST /v1/customers` — `first_name`, `last_name`, `email`, `default_device: email` |
| 3 | `POST /v1/subscriptions` — `customer_id` + `plan_id`; the first invoice appears at once |
| 4 | `POST /v1/payment_methods` — `{"type": "paymaya"}` |
| 5 | `POST /v1/payment_intents/{latest_invoice.payment_intent.id}/attach` — the app opens the `next_action.redirect.url` this answers with |

The customer has **24 hours** to authorise, or PayMongo cancels the subscription and its status
becomes `incomplete_cancelled`. After that PayMongo bills it: a `draft` invoice one day before
the date, `open` twelve hours later, then payment. A failure retries once a day, three times,
then the subscription goes `unpaid`.

No `phone` is sent. PayMongo marks it optional, and a vault app has no business holding a mobile
number. `first_name`/`last_name` are required by the API and SilentSum does not know them, so a
fixed `SilentSum Subscriber` goes out instead.

### Usage-based pricing, and its one-cycle lag

One plan per band, and `PUT /v1/subscriptions/{id}/plan` to move between them. The band comes
from `CloudStorageMeter`, which lists `users/{uid}/` in SilentSum's bucket and adds up the object
sizes — the server's own figure, never the client's.

Re-rating happens on `subscription.invoice.paid`, so **a vault that changes band is billed the
old band once more and the new one after that.** PayMongo applies a plan change from the next
cycle; there is no proration API. The worst case is a vault that fills from empty to the 512 GB
ceiling inside one month, which costs about **$5.47, once**, and is bounded by the ceiling on
additions.

### Testing the monthly charge without waiting a month

`POST /v1/subscriptions/{id}/test_cycle` forces the next cycle. It is **test keys only** —
`PayMongoClient.triggerTestCycle` exists for exactly this. The full lifecycle is already covered
offline against the documented shapes in `functions/src/__tests__/subscriptionLifecycle.test.ts`
(first charge, two renewals, a band change, a failed charge, the retries running out,
cancellation keeping the paid period). What that cannot prove is PayMongo's real response bodies,
which is what the test key is for once Subscriptions are enabled.

### What the app does meanwhile

`PlansScreen` tries `startCloudSubscription` and falls back to a one-off term when the backend
answers `unsupported` — which is what every deployment answers today. It says which happened in
the status line, because the two charge differently and the user is agreeing to one of them.
Nothing had to be switched off to ship this.

### Do the band prices cover their costs?

Fees are from PayMongo's published pricing page, which states all rates are VAT-exclusive, so
each is multiplied by 1.12: **Maya 1.79% → 2.005%, no fixed fee**; a domestic card would be
3.125% + ₱13.39 → **3.50% + ₱15.00**. Plus ₱10 per payout. Tax is the 8% flat rate on gross.

Storage rates are READ OFF Google's pricing page for this bucket's actual location — **`asia`
multi-region** — not estimated, converted at Google's own 730 hours/month:

| | Standard | Nearline | Coldline | Archive |
| --- | --- | --- | --- | --- |
| asia multi-region, per GiB-month | $0.0260 | $0.0150 | $0.0087 | $0.0030 |

Autoclass blends those to **$0.0112** for a one-year-old vault and **$0.0071** for a two-year-old
one, as objects descend the ladder.

**THE LINE THAT DOMINATES, and that an earlier version of this file missed entirely:
inter-region replication.** It is billed per GiB on all data WRITTEN to a dual-region or
multi-region bucket. For `asia` multi-region it is **$0.08/GiB — four times the US and EU rate
of $0.02 — and a single-region bucket does not pay it at all.** It is one-time per upload, but
it is enormous relative to the monthly price:

| band | cost to fill it, once | = months of that band's entire net revenue |
| --- | --- | --- |
| 64 GB | $5.12 | 4.1 |
| 160 GB | $12.80 | 3.8 |
| 512 GB | $40.96 | 3.6 |

Full to the top of the band, with replication amortised over an assumed 24-month subscriber:

| band | price | storage | replication/mo | Maya net | 8% tax | profit | margin |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 64 GB | ₱99 | $0.74 | $0.21 | $1.39 | $0.13 | **$0.31** | 22% |
| 160 GB | ₱249 | $1.85 | $0.53 | $3.73 | $0.32 | **$1.02** | 28% |
| 512 GB | ₱799 | $5.92 | $1.71 | $12.31 | $1.02 | **$3.66** | 30% |

Break-even is at 85 / 229 / 758 GB against ceilings of 64 / 160 / 512 — covered, but by 1.3–1.5×
rather than the 1.5–1.7× an earlier estimate claimed.

**Year one is much thinner: 3% / 10% / 13%**, because replication is being paid off against a
vault that has not yet cooled. A subscriber who fills a band and leaves inside a year is close
to break-even or behind.

### The bucket's location costs about half the profit

`asia` multi-region was chosen when the bucket was created (2026-09-16) and is the single
largest lever left. A single Asian region pays **no replication at all** and cheaper storage:

| band | profit now (asia multi-region) | profit if single-region |
| --- | --- | --- |
| 64 GB | $0.31 (22%) | **$0.73 (53%)** |
| 160 GB | $1.02 (28%) | **$2.09 (56%)** |
| 512 GB | $3.66 (30%) | **$7.08 (58%)** |

Not acted on. Moving means relocating a bucket that holds real vaults, and the multi-region
also buys availability a single region does not. Recorded here so the trade-off is a decision
rather than an accident.

Moving to Maya is itself worth +23% on the ₱99 band against a card, because a ₱15 fixed fee is
15% of a ₱99 charge. That was not the reason for choosing it, but it is why the cheapest band
works at all.

One smaller line, real and small: **soft delete is on with a 7-day window and soft-deleted
objects are billed** at their class rate, though they are exempt from the Autoclass management
fee. It is why chat media stops costing anything on day 37 rather than day 30.

(The other line here used to say the `messages/` lifecycle rule had never been applied. It was
applied on 2026-10-11 — see the chat media expiry section above.)

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
