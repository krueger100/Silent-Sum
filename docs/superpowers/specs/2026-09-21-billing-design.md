# SilentSum billing: Pro (one-time) and Cloud (monthly) — Design

Date: 2026-09-21
Status: approved by the product brief that requested it (the brief is the spec of record; this
document records the decisions taken to satisfy it against the code as it stands).

## 1. Purpose

Two products, sold through PayMongo and recorded in Firebase:

| Product         | Price       | Kind                         | What it unlocks                                                                                   |
| --------------- | ----------- | ---------------------------- | ------------------------------------------------------------------------------------------------- |
| SilentSum Pro   | ₱299        | one-time purchase, permanent | the local Pro features (§4)                                                                       |
| SilentSum Cloud | ₱99 / month | recurring subscription       | encrypted cloud backup, cloud restore, support chat, push notifications and future cloud services |

The two entitlements are independent. Pro never expires and never depends on Cloud. When Cloud
lapses, only Cloud-dependent features stop; the calculator, the vault, Pro features, unlocking,
recovery codes, the wipe PIN and every security flow are untouched. The vault never needs either
product to open.

## 2. What exists today, and what this reuses

- **Firebase** is the optional remote layer (`src/firebase/*`, `initializeFirebase`, the
  `CloudBackend` interface over Auth, Firestore and Storage). The backup account (email/password
  Firebase Auth) is the only identity in the system. Entitlements therefore belong to that account:
  the uid is the key, nothing else.
- **The Firebase project is `eevee-mate`, shared with EVPAL.** It already runs EVPAL's Stripe Cloud
  Functions and its Firestore rules carry a `stripe_customers` block that must stay byte-for-byte.
  Everything SilentSum adds is namespaced, and the functions live in their own _codebase_ so a
  deploy can never delete EVPAL's.
- **No PayMongo code existed** anywhere in this repository or in the Flutter reference, and there
  was no `functions/` directory. The "existing Firebase + PayMongo architecture" is therefore
  realised as: Firebase Cloud Functions (2nd gen, Node 22) holding the PayMongo secret, PayMongo
  Checkout Sessions for payment, PayMongo webhooks for confirmation, Firestore for state.
- **Design system**: `Screen`, `SectionLabel`, `Paragraph`, `ListRow`, `SwitchRow`, `Button`,
  `Field`, `ConfirmDialog`, palette tokens from `src/app/theme.ts`. The plans screen is built from
  these only.
- **Composition root**: `createServices()` gains a `billing` service (null when the build cannot
  offer purchases), and an `entitlements` controller (always present; reports "free" when nothing
  is known).

## 3. Payment architecture

### 3.1 Products are paid through PayMongo Checkout Sessions

Both products are sold as **PayMongo Checkout Sessions** created server-side. The app never talks to
PayMongo: it calls a Cloud Function, receives a `checkout_url`, opens it in the system browser, and
waits for the entitlement document to change. The secret key (`sk_live_…`/`sk_test_…`) and the
webhook secret (`whsk_…`) exist only as Cloud Functions secrets.

Why Checkout Sessions for Cloud rather than PayMongo's native Subscriptions API:

- PayMongo's Subscriptions API is not self-serve: the merchant must ask PayMongo support to enable
  it, and it supports only vaulted Visa/Mastercard and Maya. GCash, the dominant Philippine payment
  method, cannot be charged on a recurring basis at all. Checkout Sessions accept every method.
- The first payment of a native subscription is completed through a Payment Intent flow that has
  no hosted page; a card form in the app would put card data on the client.

Cloud is therefore a **renewable 30-day term**: each ₱99 payment extends `cloud.accessUntil` by 30
days from the later of "now" and the current end. The entitlement model carries full subscription
semantics (status, period, cancellation) so that native PayMongo subscription events plug into
the same document without a migration: the webhook already maps `subscription.invoice.paid`,
`subscription.past_due`, `subscription.unpaid`, `subscription.updated` and
`subscription.invoice.payment_failed` onto it (§6.4). Creating native subscriptions is _not_
offered by the app until the merchant account has the feature enabled; the mapping exists so that
enabling it later is a configuration change on the server, not an app release.

"Recurring" in the shipped product means: the app shows the renewal date, offers "Renew" from 7
days before expiry, and Cloud lapses on `accessUntil` if no payment arrives. Cancelling Cloud
records the intention (`cancelAtPeriodEnd`), keeps access until the paid period ends, and stops
the renewal prompts.

### 3.2 Backend: Cloud Functions in `functions/` (codebase `silentsum`)

| Function                   | Kind                                                           | Purpose                                                                                                                                                                                                      |
| -------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `silentsumCreateCheckout`  | callable (`onCall`, auth required, App Check enforced in prod) | `{product: 'pro' \| 'cloud'}` → creates the PayMongo Checkout Session with server-side prices, records the session under the uid, returns `{checkoutId, checkoutUrl}`. Refuses Pro when already owned.       |
| `silentsumSyncCheckout`    | callable                                                       | `{checkoutId}` → retrieves the session from PayMongo and applies a `paid` payment through the same idempotent path as the webhook. Covers a late or lost webhook when the user returns from the browser.     |
| `silentsumCancelCloud`     | callable                                                       | records `cancelAtPeriodEnd` (term mode) or cancels the PayMongo subscription (subscription mode).                                                                                                            |
| `silentsumPaymongoWebhook` | HTTPS (`onRequest`, raw body)                                  | verifies `Paymongo-Signature`, deduplicates by event id, applies the event, always answers 200 for a verified event.                                                                                         |
| `silentsumBillingReturn`   | HTTPS                                                          | the `success_url` / `cancel_url` landing page ("Payment received — return to the app"). The app has no URL scheme by design (the calculator disguise), so the return page is plain HTTPS with no data in it. |

No scheduled function: expiry is **derived on read** from `cloud.accessUntil` (client, functions
and security rules all compare it with the current time), so there is nothing to run and nothing
that can be late.

### 3.3 Idempotency and duplicate-grant prevention

Two ledgers, both written inside Firestore transactions with create-if-absent semantics:

1. `silentsum_billing_events/{paymongoEventId}` — one document per webhook delivery. A second
   delivery of the same event id is acknowledged with 200 and does nothing.
2. `silentsum_billing_payments/{paymongoPaymentId}` — one document per PayMongo payment. The
   entitlement change and this ledger entry are written in **the same transaction**, keyed by the
   payment id, so the same payment can never be applied twice — not by a retried webhook, not by
   `checkout_session.payment.paid` and `payment.paid` both arriving for it, and not by the
   `syncCheckout` fallback racing the webhook.

Pro is additionally guarded at the product level: a payment for `pro` when `pro` is already true
is recorded in the ledger as `pro_already` and changes nothing; `createCheckout` refuses to sell
Pro to an owner in the first place.

Every applied payment is validated against the server's own record of the checkout session
(`silentsum_billing_refs/{cs_id}` → uid, product, expected amount): the uid and product come from
the server's record, never from the event body, and the paid amount must equal the product price.

## 4. Entitlement model

### 4.1 The document

`users/{uid}/billing/entitlements` — readable by its owner, writable by nobody through the rules
(only the Admin SDK in Cloud Functions writes it):

```
{
  v: 1,
  pro: boolean,
  proSince: Timestamp | null,
  proPaymentId: string | null,
  cloud: {
    status: 'none' | 'active' | 'past_due' | 'unpaid' | 'cancelled' | 'incomplete',
    accessUntil: Timestamp | null,        // the authoritative "is Cloud on" date
    currentPeriodStart: Timestamp | null,
    currentPeriodEnd: Timestamp | null,
    cancelAtPeriodEnd: boolean,
    source: 'term' | 'subscription' | null,
    subscriptionId: string | null,
  },
  updatedAt: Timestamp,
}
```

`cloud.active` is not stored: it is `accessUntil > now`. "Expired" is the derived state of an
`accessUntil` in the past, whatever `status` last was. Pro has no expiry field at all, on purpose.

Server-only collections (no client access): `silentsum_billing_refs/{paymongoId}` (checkout
session, subscription and customer ids → uid, plus the checkout's product, price and status) and
the two ledgers above. A per-user `billing/account` document was considered and dropped: the
refs collection already answers every "which account is this PayMongo id for" question, and the
subscription id lives in the entitlement document itself.

### 4.2 What Pro gates (local features)

Gates are applied only when **billing is available in the build** (Firebase configured and the
billing endpoint known). A build without Firebase behaves exactly as today: everything unlocked,
because a gate whose key cannot be bought is not a product tier, it is a broken app.

| Feature                                                                                                                                          | Free     | Pro       |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | --------- |
| Items in the vault (photos + videos)                                                                                                             | up to 50 | unlimited |
| Video capture and video import                                                                                                                   | no       | yes       |
| Everything else (calculator, PIN, throttle, wipe PIN, super secure, auto-lock, screen protection, recovery codes, night mode, settings, support) | yes      | yes       |

The free cap applies to **adding** items only. Nothing already in the vault is ever hidden, locked
or deleted by a gate, and the cap is a single constant (`FREE_TIER.maxItems`).

### 4.3 What Cloud gates

Cloud backup (`enable`, `backupNow`, `rebindBackup`), cloud restore (both the in-vault restore and
the locked-calculator restore flow), and the future support chat / push notifications. Gated in
the app (the screens show a "SilentSum Cloud required" card that leads to the plans screen) and
**enforced by the security rules** for writes: envelope and manifest writes and Storage uploads
require `accessUntil > request.time`. Reads and deletes stay owner-only without a Cloud check, so a
lapsed user can always delete their own data and their own account; a lapsed user's ciphertext is
never held hostage by the server, only the _service_ stops.

The customer-service e-mail form stays available to everyone: it is the only way to report a
billing problem, and it is not a cloud service.

### 4.4 Client state and offline Pro

`EntitlementsController` (zustand store, `services.entitlements`):

- On start: loads the cached record from the secure store (`silentsum.billing.entitlements.v1`),
  keyed by uid. Pro features work offline from that cache indefinitely.
- When Firebase is available and a user is signed in: subscribes to the Firestore document
  (`CloudBackend.watchDocument`, a new interface method) and mirrors every change into the store
  and the cache. Signing in as a different uid replaces the cache.
- The cache is a **mirror**, never a source of truth: the server never reads it, the rules never
  trust it, and Cloud features check the live document before acting. Its only job is to keep Pro
  usable on a device with no network.
- Erasing the vault removes it with everything else (it is in `ALL_SECURE_STORE_KEYS`); signing
  in again restores it from the server.

## 5. Client architecture

```
src/billing/
  entitlements.ts        Entitlements type, parse/serialise, deriveCloudState, FREE_TIER gates (pure)
  entitlementsController.ts  store + cache + Firestore subscription
  billingService.ts      BillingService interface (createCheckout, syncCheckout, cancelCloud) + InMemoryBillingService
  products.ts            the two products: ids, prices, the exact copy
  screens/PlansScreen.tsx      the purchase / subscription / status screen
  screens/CloudRequiredCard.tsx  the gate card the cloud screens show
  screens/ProUpsellDialog.tsx    the gate dialog the gallery/camera show
  screens/billingErrors.ts       user-facing copy for billing failures
src/firebase/
  callableClient.ts      HTTPS callable protocol over fetch (ID token + App Check token)
  firebaseBillingService.ts  BillingService over the callable client
```

`src/billing` never imports Firebase or reaches the network; it talks to `BillingService` and
`CloudBackend`. The callable client lives in `src/firebase` because that is the one module allowed
to talk to a server for the app's own purposes, and the security scan enforces it.

The callable client speaks the documented Firebase callable protocol (`POST {data}` with
`Authorization: Bearer <ID token>` and `X-Firebase-AppCheck`) rather than adding
`@react-native-firebase/functions`: no new native module, no prebuild, fully testable here.

## 6. Backend design

### 6.1 Configuration

Secrets (`defineSecret`): `PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET`.
Parameters (environment): `SILENTSUM_PRO_PRICE_CENTAVOS` (29900), `SILENTSUM_CLOUD_PRICE_CENTAVOS`
(9900), `SILENTSUM_CLOUD_TERM_DAYS` (30), `SILENTSUM_BILLING_RETURN_URL` (defaults to the
`silentsumBillingReturn` function), `SILENTSUM_PAYMENT_METHODS` (default
`gcash,paymaya,card,grab_pay,qrph`), `SILENTSUM_ENFORCE_APP_CHECK` (default true).
Never in source: any key. The security scan fails on `sk_test_`, `sk_live_` or `whsk_` anywhere in
tracked files, and on `api.paymongo.com` anywhere outside `functions/`.

### 6.2 `createCheckout`

1. Require auth (uid). Optionally require App Check.
2. Validate `product`. For `pro`, read entitlements; refuse (`failed-precondition`) if owned.
3. `POST /v1/checkout_sessions` with one line item at the server price, `metadata: {uid, product,
ref}`, `success_url`/`cancel_url` on the return page, `send_email_receipt: false`,
   `description` = the product's one-line copy, `reference_number` = our ref.
4. Write `silentsum_billing_refs/{cs_id}` = `{kind: 'checkout', uid, product, amount, currency,
status: 'open', createdAt}` and `users/{uid}/billing/account.lastCheckout`.
5. Return `{checkoutId: cs_id, checkoutUrl}`.

### 6.3 Webhook

1. Read the raw body. Verify `Paymongo-Signature` (`t=…,te=…,li=…`): HMAC-SHA256 over
   `${t}.${rawBody}` with the webhook secret, compared in constant time against `li` when the
   event is live and `te` when it is test; reject when `t` is older than 5 minutes. Invalid → 400,
   nothing recorded.
2. Parse `{data: {id, attributes: {type, livemode, data}}}`.
3. Transaction: create `silentsum_billing_events/{id}`; if it exists → 200 `duplicate`.
4. Dispatch by type:
   - `checkout_session.payment.paid` → the checkout session is `data`; for each payment in
     `attributes.payments` with status `paid`: look up `refs/{cs_id}` (must exist, must match the
     session's metadata uid/product), verify amount, then `applyPayment` (§3.3).
   - `payment.paid` → resolved through the payment's `attributes.metadata` (uid/product/ref) only
     when a matching ref exists; otherwise recorded as `ignored`. Duplicate protection makes this
     safe when both events arrive for one payment.
   - `payment.failed` → mark the ref `failed` (informational; the app shows "payment failed").
   - subscription events → §6.4.
   - anything else → recorded as `ignored`, 200.
5. Record the outcome on the event document. Respond 200. Processing errors after the event is
   recorded answer 500 so PayMongo retries; the event record carries `outcome: 'error'` and the
   retry re-runs the (idempotent) apply.

### 6.4 Applying payments and subscription events (pure domain, `entitlements.ts` in functions)

- `grantPro(current, payment)`: `pro: true`, `proSince`, `proPaymentId` set once; no-op if owned.
- `extendCloudTerm(current, payment, termDays)`: `accessUntil = max(now, accessUntil) + termDays`,
  `currentPeriodStart/End` set to the new term, `status: 'active'`, `source: 'term'`,
  `cancelAtPeriodEnd: false`.
- `applySubscriptionEvent(current, event)`: `invoice.paid` → active, access to the invoice's period
  end (+3-day grace); `past_due` → status only; `unpaid` → status + access revoked;
  `invoice.payment_failed` → status `past_due`; `updated` → mirror status, `cancelled` keeps access
  to period end.

### 6.5 Security rules

Firestore (both `firestore.rules` and `firestore.merged.rules`, which is the deployed one):

```
match /users/{uid}/billing/entitlements { allow read: if ssOwner(uid); allow write: if false; }
function ssCloudActive(uid) {
  return exists(/databases/$(database)/documents/users/$(uid)/billing/entitlements)
    && get(/databases/$(database)/documents/users/$(uid)/billing/entitlements).data.cloud.accessUntil > request.time;
}
```

Envelope and manifest `create, update` additionally require `ssCloudActive(uid)`. `read, delete`
are unchanged. Storage `write` on `users/{uid}/**` additionally requires the same check through
`firestore.get`; `read, delete` unchanged. `users/{uid}/billing/account` and the
`silentsum_billing_*` collections have no client rule at all (denied).

## 7. UI

Settings gains a "Plans" section with a row "SilentSum Pro and Cloud" whose value is `Pro` /
`Free` and whose detail states the Cloud status. It opens `PlansScreen`:

- Status card: `Pro — active since <date>` or `Pro — not purchased`; `Cloud — active until <date>`
  / `expires in N days` / `cancelled, access until <date>` / `expired on <date>` / `not
subscribed`.
- Product cards, with the copy exactly as the brief specifies:
  - **SilentSum Pro** — **₱299 one-time** — "Pay once. Keep Pro forever." — `Buy Pro` (or `Purchased`)
  - **SilentSum Cloud** — **₱99/month** — "Encrypted backup, restore, support chat and cloud
    services." — `Subscribe` / `Renew` / `Cancel Cloud`
- Account: the backup account is required (it is the identity the entitlement is filed under).
  Signed out → sign-in / create-account form (same fields as the backup screen); signed in → the
  address, "Sign out", and "Refresh status".
- After `Buy`/`Subscribe`: the browser opens on PayMongo's page; the screen shows "Waiting for
  PayMongo to confirm…" driven by the live document, plus "I have paid" (runs `syncCheckout`) and
  "Cancel" (clears the wait). A failed payment shows the failure copy and the button again.
- Small print: payments are handled by PayMongo; the app never sees card or wallet details;
  entitlements are tied to the backup account; Pro is permanent, Cloud renews by paying again.

`CloudBackupScreen` and `RestoreFlowScreen` show `CloudRequiredCard` (with "See plans") in place of
their controls when billing is available and Cloud is not active. The gallery's import button and
the camera sheet consult the Pro gate before adding; when blocked they show `ProUpsellDialog`
("Go Pro" → plans, "Not now").

The disguise is respected: nothing about Pro or Cloud appears on the calculator, in the ⋮ menu or
on the disguised About page. The plans screen is reachable only from inside the vault and from the
restore flow (which already reveals the vault).

## 8. Error handling

- Client: every billing failure becomes a sentence from `billingErrors.ts`; no SDK text is shown.
  `unauthenticated` → "Sign in to your backup account first"; `failed-precondition` (Pro owned) →
  "You already own SilentSum Pro"; `unavailable`/network → "…needs a connection; the vault does
  not"; App Check refusal → "This build could not prove it is genuine…".
- Opening the browser can fail (no browser); the URL is then shown as text with a copy hint.
- Backend: callable errors use `HttpsError` codes; the webhook never leaks internals in responses.

## 9. Testing

Client (Jest, in-memory fakes, no Firebase): entitlement parsing and derivation, free-tier gates,
controller cache/sync/sign-out/erase, callable client protocol, plans screen (unavailable build;
signed out; free; buy → URL opened → document change → Pro shown; Cloud states; cancel), settings
row, cloud screens gated, gallery/camera gates, security-scan rules.

Backend (Jest in `functions/`, pure functions + an in-memory `BillingStore`): signature
verification (valid live/test, tampered body, stale timestamp, bad header), event parsing,
entitlement transitions, webhook duplicate event, duplicate payment across two event types,
double Pro purchase, wrong amount, missing ref, checkout creation input validation.

`npm run check` runs typecheck, lint, the security scan, the app tests and the functions tests.

## 10. Configuration the operator must still do

PayMongo: create the API keys, register the webhook URL for `checkout_session.payment.paid`,
`payment.failed` (and the subscription events if ever enabled), copy the `whsk_…` secret.
Firebase: set the two secrets, deploy the `silentsum` functions codebase, deploy the merged
Firestore rules and the bucket's Storage rules (rollout order: functions → app → rules), grant the
Storage rules service agent Firestore read access (Firebase does this on the first deploy that uses
`firestore.get`). App: set `BILLING_FUNCTIONS_URL` in `.env` (or leave the default derived from the
project id and region). These are listed in `docs/billing.md`.

## 11. Known limitations

- Cloud is renewed by paying again, not by an automatic charge (§3.1). The renewal prompt starts
  7 days before expiry.
- The cached Pro flag on a rooted device can be edited; that unlocks local features on that device
  only and grants nothing on the server, which is the same trust boundary every offline
  entitlement has.
- iOS is configured but has not been built on this Windows host, as before.
