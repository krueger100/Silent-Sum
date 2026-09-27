# Billing: SilentSum Pro and SilentSum Cloud

Two products, sold through PayMongo, recorded in Firebase, never trusted from the client.

## The entitlement model

Confirmed 2026-09-24. This section is the model of record; where the code still differs, the
difference is listed under "Not yet true" below rather than quietly written out of this table.

| Tier                | Price             | Kind                 | Unlocks                                                                                    |
| ------------------- | ----------------- | -------------------- | ------------------------------------------------------------------------------------------ |
| **Free**            | —                 | —                    | the local vault, holding **photos and video alike**, up to a finite item limit; cloud backup and restore within a limited free allowance |
| **SilentSum Pro**   | **₱299 one-time** | permanent            | end-to-end user-to-user messaging: **text, images and video**                               |
| **SilentSum Cloud** | **₱99/month**     | paid term, renewable | unlimited vault items; unlimited photos and video; full cloud backup and restore; support chat |

Pro is the messaging plan; Cloud is the storage plan. Four rules hold between them, and each one is
a thing the code must never do:

1. **Local photos and video never require anything to use.** Not Pro, not Cloud, not a network.
   Limits apply to _adding_ to the vault, never to opening, viewing or keeping what is already in
   it.
2. **Pro lifts no vault limit.** Buying the messaging plan does not enlarge the vault or unlock
   vault video. Those are Cloud's, and only Cloud's.
3. **Cloud grants no messaging.** A Cloud term that lapses — or one that never existed — takes
   nothing away from Pro messaging, media included.
4. **Free is limited, not excluded.** Free holds video and can back up; what Cloud buys is the
   removal of the limits, not the arrival of the capability.

A build with no billing (no Firebase, no cloud backend, or `BILLING_ENABLED=false`) sells nothing
and gates nothing.

### The limits

|                          | Free                                     | Cloud       |
| ------------------------ | ---------------------------------------- | ----------- |
| Vault items              | **50** — a photo and a video each count 1 | unlimited   |
| Video in the vault       | allowed                                  | allowed     |
| Per-item file size       | **100 MB**                               | 100 MB      |
| Cloud backup storage     | **500 MB total**                         | unlimited   |

There is deliberately **no separate video quota**. One item is one item, whatever it holds; the
only thing that distinguishes a video is its size, which the per-item cap already bounds. A vault
of fifty videos is a legitimate way to spend a free vault.

The per-item cap is 100 MB on both tiers, and it is the same number the Storage rules already
enforce per object. That is the point: anything that can enter the vault can also be backed up, so
a user can never create an item that is impossible to protect.

**Cloud backup storage is 500 MB on Free, counting photos and video alike.** At the allowance:

- **Restore always works.** Reads are never gated by usage — a user at the ceiling can still pull
  back everything they have. Being full must never mean being locked out.
- **New backup uploads are refused** until they delete backup data or subscribe to Cloud. Deleting
  is the way back under the line, and deletes are never gated either.
- Nothing already uploaded is touched. The allowance bounds what may be added, exactly as the
  vault's item limit does.
- **Accounts already above the line when enforcement arrives keep everything.** Some will be — a
  user who bought Cloud, filled it, and let the term lapse. Nothing is deleted, all of it stays
  restorable, and only new uploads stop until they are back under 500 MB or on Cloud again. The
  limit applies from the day it ships; it is not applied retroactively to data.

**Chat media does not count toward this allowance.** It lives under `messages/` rather than
`users/{uid}/`, belongs to Pro rather than Cloud, and is bounded by its own 30-day expiry instead
(`docs/superpowers/specs/2026-09-24-chat-media-design.md`). The two budgets are separate because
the two products are.

### Enforcing the backup allowance

The allowance is enforced **server-side**, in the Storage rules, against a ledger only the server
writes. A client that lies about its usage gains nothing.

- `users/{uid}/billing/usage` — `{ v, bytes, objects, updatedAt }`. Written exclusively by Cloud
  Functions with the Admin SDK; the rules let the owner **read** it (so the UI can show "412 MB of
  500 MB") and let nobody write it, exactly as `billing/entitlements` already works.
- Two Storage-trigger functions maintain it: one on object finalize (`bytes += size`), one on
  object delete (`bytes -= size`), both transactional so concurrent uploads cannot lose a count.
- The Storage rule becomes, in effect:

  ```
  allow create, update: if isOwner(uid)
    && (cloudActive(uid) || used(uid) + request.resource.size <= 500 MB)
    && request.resource.size < 100 * 1024 * 1024
    && request.resource.contentType == 'application/octet-stream';
  allow read, delete: if isOwner(uid);
  ```

  Both halves of that gate already have precedent in this file: `cloudActive()` performs a
  cross-service `firestore.get`, and the size ceiling reads `request.resource.size`.

- **Known imprecision, accepted.** The ledger trails its trigger by a moment, so two uploads racing
  each other can both pass the check and overshoot. The overshoot is bounded by the per-item cap
  times the number of concurrent uploads — tens of megabytes in the worst realistic case, against a
  500 MB line. A distributed lock would cost far more than it saves, so the rule is a ceiling with
  a little give rather than a hard edge, and that is a deliberate choice rather than an oversight.

### Not yet true

The model above is the target. As of 2026-09-25 the code differs in three places, each recorded
here so the gap is visible rather than assumed away:

- **There is no 500 MB free backup allowance.** Backup is all-or-nothing today: without Cloud the
  backup screen shows `CloudRequiredCard` instead of its controls and restore stops at a
  `cloudRequired` step. No usage ledger, no Storage-trigger functions and no quota concept exist
  anywhere in the codebase. Reads and deletes of existing backup data are ungated, so nobody is
  locked away from data they already have — that part already matches the model.
- **Chat carries text only.** Image and video messages are designed but unbuilt — see
  `docs/superpowers/specs/2026-09-24-chat-media-design.md`. They are a Pro feature with no Cloud
  condition.
- **The Cloud gate on backup writes is client-side only in production.** The deployed ruleset
  (`firebase/firestore.stage1.rules`) allows vault envelope and manifest writes with owner and
  shape validation alone; the `ssCloudActive` gate exists only in `firestore.merged.rules`, which
  has never been deployed. A patched client could therefore back up without a term today.

The plans screen copy (`src/billing/products.ts`, `PlansScreen`) no longer sells video, which the
free vault now has. It still describes cloud backup as a flat Cloud feature, which is true today
and becomes wrong when the 500 MB free allowance above is built — that bullet moves with it, not
before, so the card never advertises an allowance that does not exist.

## How a purchase works

```
app ──(callable, ID token + App Check)──► silentsumCreateCheckout ──► PayMongo: create Checkout Session
app ◄── { checkoutId, checkoutUrl } ◄──── (server records cs_… → uid, product, price)
app opens checkoutUrl in the browser; user pays with GCash / Maya / card / …
PayMongo ──(signed webhook)──► silentsumPaymongoWebhook ──► Firestore: users/{uid}/billing/entitlements
app follows that document live and shows "Pro is now active" / "Cloud is active until …"
```

- The app never sees a PayMongo key and never calls PayMongo. `scripts/security-scan.js` fails the
  build if a PayMongo host or key appears anywhere in the app.
- The **server** decides prices and products. The app's copy of the price is display only.
- The webhook is verified over the raw body with the webhook secret (`Paymongo-Signature`,
  HMAC-SHA256 of `"<t>.<body>"`, `te` for test mode, `li` for live), with a 5-minute replay window.
  Events from the other mode are acknowledged and ignored.
- **Idempotency**: every webhook event id is recorded once (`silentsum_billing_events`); every
  PayMongo payment id is recorded once (`silentsum_billing_payments`) **in the same transaction**
  as the entitlement change. A retried event, a second event type for the same payment, and the
  app's "I have paid" reconciliation all hit the same ledger and cannot apply a payment twice. A
  second Pro payment is recorded as `pro_already` and changes nothing; the callable refuses to
  sell Pro to an owner in the first place.
- Every applied payment is checked against the server's own record of the session: the uid and
  product come from `silentsum_billing_refs/{cs_…}`, never from the event body, and the paid
  amount must equal the server price in PHP.
- "I have paid" (`silentsumSyncCheckout`) asks PayMongo for the session and applies it through the
  same path as the webhook, for a late or lost webhook. It cannot grant anything the webhook would
  not have.
- **A pending checkout suspends auto-lock** (`AutoLockSuspension`, the same bounded grace the photo
  picker and permission dialogs use). Paying means leaving the app, and locking would unmount the
  plans screen together with the pending checkout and the "I have paid" fallback — losing the only
  in-app way to reconcile a payment that really was made. The grace is bounded, so a phone left
  alone still locks.

## Cloud is a renewable term, not an automatic charge

Each ₱99 payment adds 30 days to `cloud.accessUntil`, counted from the later of "now" and the
current end. The app shows the end date, offers **Renew** from 7 days before it, and Cloud lapses
on the date if no payment arrives. **Cancel Cloud** records `cancelAtPeriodEnd`, keeps access to
the paid end, and stops the renewal prompts. Nothing is ever charged automatically.

Why not PayMongo's native Subscriptions API: it is not self-serve (PayMongo support must enable
it), it supports only vaulted Visa/Mastercard and Maya (no GCash), and its first payment goes
through a Payment Intent with no hosted page. The entitlement model nevertheless carries full
subscription semantics, and the webhook already maps `subscription.invoice.paid`,
`subscription.invoice.payment_failed`, `subscription.past_due`, `subscription.unpaid` and
`subscription.updated` onto it (a 3-day grace past each billing period), keyed by a
`silentsum_billing_refs/{sub_…}` record. Enabling native subscriptions later is a server change.

## The entitlement document

`users/{uid}/billing/entitlements` — readable by its owner, writable by nobody through the rules
(only the Admin SDK in Cloud Functions writes it):

```
{
  v: 1,
  pro: boolean, proSince: Timestamp | null, proPaymentId: string | null,
  cloud: {
    status: 'none' | 'active' | 'past_due' | 'unpaid' | 'cancelled' | 'incomplete',
    accessUntil: Timestamp | null,   // the authoritative "is Cloud on" date
    currentPeriodStart, currentPeriodEnd: Timestamp | null,
    cancelAtPeriodEnd: boolean,
    source: 'term' | 'subscription' | null,
    subscriptionId: string | null,
  },
  updatedAt: Timestamp,
}
```

Cloud is on iff `status` still grants access (`active`, `past_due`, `cancelled`) **and**
`accessUntil > now`. "Expired" is derived, never stored, so nothing has to run on a schedule. The
security rules compare `accessUntil` with `request.time`; the server sets it to "now" when access
is withdrawn (`unpaid`), so the date alone is the truth for the rules.

Server-only collections (closed to every client): `silentsum_billing_refs/{paymongoId}` (checkout
session, subscription and customer ids → uid), `silentsum_billing_events/{eventId}`,
`silentsum_billing_payments/{paymentId}`.

## What the app does with it

- `EntitlementsController` (`src/billing/entitlementsController.ts`) follows the document with a
  Firestore listener while a backup account is signed in, and mirrors it into the secure store
  (`silentsum.billing.entitlements.v1`) so **Pro works offline indefinitely**. The mirror is never
  a source of truth: nothing on the server reads it and the rules never trust it. Signing in as a
  different account replaces it; erasing the vault removes it; signing in again restores it.
- **Vault gates** (`vaultGate` and `FREE_TIER` in `src/billing/entitlements.ts`): the limits lift
  with an active CLOUD term, never with Pro — `vaultGate` takes no Pro input at all, which is what
  makes rule 2 above structural rather than a convention. Gates apply to _adding_ only, and only in
  a build that can sell. Nothing already in the vault is ever hidden, locked or deleted by a tier,
  and a term that lapses takes nothing away.
  _Today_ free holds 50 items and **no video**; under the confirmed model it must hold video too,
  bounded by the item limit alone. See "Not yet true".
- **Pro gates**: messaging only — and everything in a message, which will include images and video.
  `MessagingService.canMessage()` reads `isPro()` and nothing else; the Firestore rules
  (`ssProActive`) and the lookup callable are what actually enforce it. No messaging path reads a
  Cloud term anywhere, which is what makes rule 3 structural. See `docs/messaging.md`.
- **Cloud gates**: the cloud-backup and restore screens show a "SilentSum Cloud is required" card
  instead of their controls when the account has no active term. Signing out, turning backup off
  (which deletes the cloud copy) and deleting the account stay available: a lapsed user must always
  be able to take their data out. The e-mail customer-service form is not gated — it is how a
  billing problem gets reported.
  _Today_ this is all-or-nothing; under the confirmed model Free and Pro get a limited backup
  allowance rather than none, so this card belongs at the edge of that allowance, not at zero.
- **Server enforcement**: written as `cloud.accessUntil > request.time` on envelope/manifest
  `create, update` in `firestore.merged.rules` and on object `create, update` in `storage.rules`;
  reads and deletes are owner-only without a term. **The Firestore half is not live**: the deployed
  ruleset is the staged `firestore.stage1.rules`, which omits that gate on purpose, so backup writes
  are currently enforced by the client alone. See "Not yet true".

## Backend (`functions/`, codebase `silentsum`)

| Function                   | Kind       | Purpose                                                                       |
| -------------------------- | ---------- | ----------------------------------------------------------------------------- |
| `silentsumCreateCheckout`  | callable   | `{product}` → `{checkoutId, checkoutUrl}`                                     |
| `silentsumSyncCheckout`    | callable   | `{checkoutId}` → `{outcome: paid \| pending \| expired \| failed \| unknown}` |
| `silentsumCancelCloud`     | callable   | `{}` → `{ok, accessUntil}`                                                    |
| `silentsumPaymongoWebhook` | HTTPS POST | PayMongo events                                                               |
| `silentsumBillingReturn`   | HTTPS GET  | the page the browser lands on after checkout (`?outcome=success\|cancel`)     |

Callables require a signed-in Firebase user (the backup account) and, by default, a valid App
Check token. The app speaks the callable protocol over `fetch` (`src/firebase/callableClient.ts`)
with the ID token and App Check token, so no new native module was needed.

Configuration (environment, `functions/.env` or `functions/.env.<project>`):

| Variable                         | Default                            | Meaning                                                      |
| -------------------------------- | ---------------------------------- | ------------------------------------------------------------ |
| `SILENTSUM_PRO_PRICE_CENTAVOS`   | `29900`                            | ₱299                                                         |
| `SILENTSUM_CLOUD_PRICE_CENTAVOS` | `9900`                             | ₱99                                                          |
| `SILENTSUM_CLOUD_TERM_DAYS`      | `30`                               | days per Cloud payment                                       |
| `SILENTSUM_PAYMENT_METHODS`      | `gcash,paymaya,card,grab_pay,qrph` | PayMongo `payment_method_types`                              |
| `SILENTSUM_BILLING_RETURN_URL`   | (the deployed return function)     | https base for the return page                               |
| `SILENTSUM_ENFORCE_APP_CHECK`    | `true`                             | `false` lets callables run without App Check (dev only)      |
| `PAYMONGO_LIVEMODE`              | derived from the key prefix        | which PayMongo mode this deployment accepts                  |
| `SILENTSUM_REGION`               | `us-central1`                      | deploy region; must match `BILLING_FUNCTIONS_URL` in the app |

| `SILENTSUM_SUPPORT_FROM`         | (none)                             | support relay sender; unset disables the relay                |
| `SILENTSUM_SUPPORT_TO`           | (none)                             | the one inbox the relay will send to                          |

Secrets (Firebase Secret Manager, never in files): `PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET`,
`RESEND_API_KEY` (the support relay; see `firebase/README.md`).

## Setting it up

PayMongo (dashboard):

1. Copy the **secret key** (`sk_test_…` first; `sk_live_…` for release).
2. After the first deploy, register a webhook for `https://<region>-<project>.cloudfunctions.net/silentsumPaymongoWebhook`
   with the events `checkout_session.payment.paid` and `payment.failed` (and the `subscription.*`
   events if subscriptions are ever enabled). Copy the **webhook secret** (`whsk_…`) it shows once.
   Test-mode and live-mode webhooks are separate; a live deployment needs a live webhook.
3. Make sure the payment methods in `SILENTSUM_PAYMENT_METHODS` are enabled on the account.

Firebase (`eevee-mate`), from the repo root:

```bash
cd functions && npm install && cd ..
firebase functions:secrets:set PAYMONGO_SECRET_KEY --project eevee-mate
firebase functions:secrets:set PAYMONGO_WEBHOOK_SECRET --project eevee-mate
# The support relay lives in the same codebase, so its secret must exist before the deploy.
firebase functions:secrets:set RESEND_API_KEY --project eevee-mate
FUNCTIONS_DISCOVERY_TIMEOUT=120 firebase deploy --only functions:silentsum --project eevee-mate
```

`FUNCTIONS_DISCOVERY_TIMEOUT` is not optional on a slow or busy machine. To work out what to
deploy, the CLI starts the built code on a local port and asks it for its backend specification,
with a 10-second budget by default. Exceeding that fails the deploy with

```
Error: User code failed to load. Cannot determine backend specification. Timeout after 10000.
```

which reads like a code fault and is not one: `node -e "require('./lib/index.js')"` from `functions/`
loads the same module in about a second. Raising the budget is the fix. Observed on this machine
2026-09-26.

Then the app: set `BILLING_FUNCTIONS_URL` in `.env` only if the functions are not at
`https://us-central1-<project>.cloudfunctions.net`; otherwise nothing to configure. Build and
ship the app.

Then, and only then, the rules (they gate backup writes on the subscription):

```bash
firebase deploy --only firestore:rules,storage --project eevee-mate
```

The Storage rules use `firestore.get`; the first such deploy asks to grant the Storage rules
service agent Firestore access. Say yes.

**Rollout order matters**: functions → app → rules. Rules first would stop every existing backup
until someone can subscribe.

## Testing

- `npm test` (app): entitlement parsing and derivation, gates, the controller's cache and sync,
  the callable protocol, the plans screen, the gated cloud screens, the gallery and camera gates.
- `npm run test:functions`: signature verification, event parsing, entitlement transitions, the
  webhook (duplicate events, duplicate payments under new event ids, wrong amounts, unknown or
  mismatched sessions, mode mismatch, retries after a failure), checkout creation, "I have paid",
  cancellation, the return page.
- `cd firebase/rules-tests && npm install && npm test`: the deployed Firestore rules and the
  Storage rules against the emulators (needs Java and the Firebase CLI). Proves that no client can
  write entitlements, that backup writes need an active term, and that reads/deletes never do.
- `npm run check` runs typecheck, lint, the security scan, the app tests and the functions tests.

## What is deliberately not done

- No automatic monthly charge (see above). The renewal prompt starts 7 days before expiry.
- No refunds path; refunds are handled in the PayMongo dashboard, and `payment.refunded` is
  acknowledged but not acted on. Revoking Pro after a refund is a manual edit of the entitlement
  document.
- The cached Pro flag on a rooted device can be edited; that unlocks local features on that device
  only and grants nothing on the server — the same trust boundary every offline entitlement has.
