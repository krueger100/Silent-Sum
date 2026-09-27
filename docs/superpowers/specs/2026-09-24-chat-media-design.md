# Photos and video in user-to-user chat — Design

Date: 2026-09-24
Status: approved in conversation, then **revised the same day** when the entitlement model was
confirmed (`docs/billing.md`, "The entitlement model"). The revision makes all chat media — photos
and video alike — a Pro feature with no Cloud condition anywhere; §3, §6, §7, §8, §11 and §13
changed. Nothing has been implemented.

## 1. Purpose

Let one SilentSum user send a photo or a video to another inside an existing conversation, with
the same end-to-end guarantee the text already has: the server stores ciphertext and a sender id,
and nothing else it can read.

Text messaging shipped and was verified on a device on 2026-09-24 (`docs/messaging.md`). This adds
one message kind to it. It does not change how conversations are found, keyed, listed or read.

## 2. What exists today, and what this reuses

The transport is already here. It was built for the vault's cloud backup and is proven by it:

- **`CloudBackend` blob API** (`src/firebase/types.ts`): `putBlob`, `putBlobFromFile`, `getBlob`,
  `getBlobToFile`, `deleteBlob`, `listBlobs`. The `…FromFile` / `…ToFile` pair exists precisely
  because vault video ciphertext runs to hundreds of megabytes and must never be held in memory as
  one buffer. Chat media uses the same pair for the same reason.
- **`aeadEncrypt` / `aeadDecrypt`** (`src/crypto/sodium.ts`), XChaCha20-Poly1305 with associated
  data, and `SODIUM_AEAD_NONCE_BYTES`.
- **`MessagingIdentity.conversationKey(peerPublicKey, conversationId)`** (`src/messaging/identity.ts`).
  Both participants derive it independently; nothing new is exchanged for media.
- **`ThumbnailGenerator`** (`src/vault/thumbnailGenerator.ts`, with `FakeThumbnailGenerator` for
  tests) and `videoThumbnailGenerator.ts`.
- **`PlaybackScratch`** (`src/vault/playbackScratch.ts`, purged by `AppLifecycleGuard` when the app
  backgrounds): decrypts a video to a scratch file for playback and removes it afterwards. Chat
  video reuses it unchanged, which is what keeps decrypted video from outliving the session.
- **The picker and camera** (`src/gallery/importService.ts`, `src/camera/CameraSheet.tsx`). Both
  already suspend auto-lock around the hand-off to system UI, which matters more here than in the
  vault: an upload can take longer than the picker did.
- **Rules test harnesses**: `firebase/rules-tests/{firestore,storage}.test.js` against the
  emulators.

What does **not** exist and must be built: any shared-path Storage rule (today's rules are strictly
owner-scoped, `users/{uid}/**`), any non-text message kind, and any upload/download UI.

## 3. Product decisions

The premises of everything below. Both follow from the entitlement model confirmed on 2026-09-24
(`docs/billing.md`, "The entitlement model").

**All chat media is Pro. Photos and video alike.** Pro buys messaging, and a message with a picture
in it is a message. There is no Cloud check anywhere in this feature: a Pro account whose Cloud term
has lapsed, or who never had one, sends and receives photos and video exactly as before. **Receiving
and viewing require nothing at all** — not Pro, not Cloud — matching the existing rule that reads
and deletes of backup objects are ungated.

> Revised. An earlier draft of this spec put chat video behind Cloud, mirroring the vault's
> video gate. That was rejected with the rest of that model: Cloud is the *vault storage* plan and
> Pro is the *messaging* plan, so a messaging capability may not depend on it. The revision
> removes work rather than adding it — see §6.

**Chat media expires after 30 days.** A Google Cloud Storage object-lifecycle rule on the
`messages/` prefix deletes objects 30 days after upload. It costs nothing to run and needs no
scheduled function, and it caps storage exposure at roughly one month of traffic regardless of how
many Pro licences are sold.

That rule now carries the entire cost model for this feature. Every byte of chat media — video
included — is stored against a one-time ₱299 payment with no recurring revenue behind it and no
per-account quota. The 30-day expiry is the only thing bounding that, which makes it a
**requirement, not a nicety**: shipping this feature without the lifecycle rule applied is shipping
an unbounded liability. §9 and §12 say where it is applied.

Anything worth keeping is saved into the vault by the recipient, where the free tier's 50-item cap
applies as it does to everything else. That is a real action in this feature, not an aspiration —
see "Media moves both ways" below.

**Media comes from three places: the camera, the photo library, and the vault.** The first two are
ordinary. The third is not, and it is the one product decision in this spec that touches the app's
central promise.

An item in the vault is local, encrypted with the master key, and does not leave the device unless
the user backs it up. Sending one to a conversation **uploads a copy** and ends that property for
the copy. The original is untouched and stays in the vault; but the recipient's copy is theirs, and
the server holds ciphertext for up to 30 days.

That is a legitimate thing to want — the vault is where a user's photos already are, and a
messenger that could not send them would be strange — but it must not happen silently. **The first
vault send in each conversation shows a one-time explanation** and asks the user to go ahead:
a copy leaves the vault, the recipient keeps theirs, the server copy expires in 30 days, the
original is unaffected. After that, sending from the vault in that conversation is frictionless.

Per conversation rather than per send, because a dialog a user sees on every send is a dialog they
learn to dismiss without reading, which is worse than not showing one. Per conversation rather than
once per install, because *who* the copy is going to is the part that matters.

**Media moves both ways.** A photo or video received in a conversation can be saved into the vault,
where it becomes an ordinary vault item subject to the ordinary limits: the 50-item free cap and
the 100 MB per-item cap, enforced by the existing `vaultGate`. This is what makes the 30-day expiry
acceptable rather than lossy — anything worth keeping can be kept, deliberately, by the person who
received it.

**Chat media is outside the 500 MB free backup allowance** (`docs/billing.md`, "The limits"). It
lives under `messages/`, not `users/{uid}/`, belongs to Pro rather than Cloud, and is bounded by
the 30-day expiry instead. The Storage-trigger functions that maintain the backup usage ledger must
therefore ignore the `messages/` prefix — a detail worth stating plainly, because a trigger that
counted chat media into a Cloud allowance would charge one product's traffic against another's
budget.

## 4. Data model

`conversations/{cid}/messages/{id}` today:

```
{ v: 1, from, box, nonce, createdAt }
```

Media adds a kind and a pointer. Text records are **unchanged**, so every message already sent
stays valid and there is no migration:

```
{
  v: 1,
  kind: 'photo' | 'video',        // absent means 'text'
  from, createdAt,
  box, nonce,                     // the caption/filename envelope, as today
  object: 'messages/<cid>/photo/<objectId>',
  bytes: <ciphertext length>,
  thumbObject: 'messages/<cid>/thumb/<objectId>',   // pointer, never the bytes
}
```

`kind` is absent rather than `'text'` on text messages. A reader that does not understand a kind it
has never heard of must render the message as unopenable rather than drop it — the same rule the
existing parser follows for a record it cannot decrypt, and for the same reason: a silent gap is
the one failure a user cannot tell from "they never wrote".

**The thumbnail is a Storage object, not an inline Firestore field.** An earlier draft of this spec
inlined it — a 256px JPEG is only ~20 KB and a document read already happens, so the bubble would
render with no second round trip. That was rejected for one reason: **Firestore is not covered by
the Storage lifecycle rule**, so an inline preview would outlive the media it previews, for ever.
An "expired" photo would go on showing a recognisable copy of itself to anyone who could read the
conversation, and no bucket rule could ever reach it.

So the preview lives at `messages/<cid>/thumb/<objectId>`, under the same membership rule and the
same 30-day sweep as the media. The costs are accepted and real: one Storage read and one decrypt
per media bubble instead of zero, which makes an in-memory cache on the conversation screen
necessary rather than optional. Thumbnails are capped at 32 KB, enforced client-side and in the
Storage rules; anything larger is a bug.

**After 30 days, nothing visual remains.** The message record survives — the thread still shows who
sent a photo and when — but the bubble renders as expired with no preview at all. Metadata is
conversation history; content is what expires.

## 5. Cryptography

The same construction as text, with the object path bound in:

```
file bytes --XChaCha20-Poly1305(conversationKey, fresh nonce, AAD)--> object in Storage
AAD = "silentsum/media/v1|<cid>|<from>|<createdAt>|<objectPath>"
```

The thumbnail is sealed separately under the same key with its own nonce and its own AAD
(`silentsum/mediathumb/v1|…`), so a thumbnail can never be replayed as a body or vice versa.

Binding the **object path** into the AAD is what stops a valid ciphertext being re-pointed at a
different message: move the object, or edit `object` in the document, and it no longer opens. The
existing message AAD already binds conversation, sender and timestamp; this extends the same idea to
the blob.

No new key exchange. The conversation key both sides already derive is the only secret involved.

## 6. Storage layout and rules

A new shared block — the Storage analogue of the `conversations/` collection, and the first
non-owner-scoped path in the bucket:

```
messages/{cid}/photo/{objectId}    ≤ 8 MB     membership
messages/{cid}/video/{objectId}    ≤ 100 MB   membership
messages/{cid}/thumb/{objectId}    ≤ 32 KB    membership
read, delete                                  membership
```

**No entitlement is read here at all.** Membership in the conversation is the only condition, and
Pro is already enforced where it belongs: the Firestore rules refuse the message document itself
without `ssProActive`. An object with no message pointing at it is invisible and is swept by the
lifecycle rule, so there is nothing to gain by uploading one.

This is a direct simplification from the earlier draft. Because no rule now distinguishes a photo
from a video by entitlement, the previous design's weakest point disappears with it: there is no
longer any incentive to upload a video down the photo path, and the caps become plain resource
limits rather than a security boundary the ciphertext could not actually support. The paths stay
separate only because the two caps differ.

The split is still by path rather than content type, because the object is opaque ciphertext
(`application/octet-stream`, as the existing rules already require) and the server genuinely cannot
tell a photo from a video by inspection.

**Settled, 2026-09-25: the Storage rules language does support `split()`.** A throwaway probe
against the Storage emulator loaded a ruleset using `request.auth.uid in cid.split('__')` and
checked both directions — a member's upload succeeded and an outsider's was refused — so the
expression both compiles and evaluates correctly. Membership is therefore read from the path, at
the cost of no document read at all, exactly as the Firestore rules already do it.

The fallback that would have been used had the probe failed,

```
firestore.get(/databases/(default)/documents/conversations/$(cid)).data.members
```

is recorded here only so a future reader knows the alternative existed and costs one Firestore read
per object access. It is not in use.

The probe was deleted once it had answered; its job was to settle a question, not to become a
permanent test of Google's rules engine. Writing it first was deliberate: two of the three
device-only defects in `docs/messaging.md` came from assuming a rules or binding capability the
real service did not have, and this is the same shape of assumption.

## 7. Client architecture

New module `src/messaging/media.ts` — pure, no I/O:

- `mediaAad(kind, parts)`, `sealMedia`, `openMedia`, mirroring `messageCipher.ts`.
- `MAX_PHOTO_BYTES`, `MAX_VIDEO_BYTES`, `MAX_THUMB_BYTES`, `PHOTO_MAX_EDGE`.
- `mediaRecord(...)` and the parser additions, beside the existing `messageRecord`.

`MessagingService` gains:

- `sendMedia(conversationId, source: { uri, kind })` — downscale, generate and seal the thumbnail
  and `putBlob` it, encrypt the media to a scratch file and `putBlobFromFile` it, then write the
  message document **last**. Ordering matters: a document pointing at an object that does not exist
  is a broken bubble, whereas an object with no document is invisible and is swept by the lifecycle
  rule. Both objects therefore precede the document, and every partial failure leaves only litter
  that expires on its own.
- `fetchMediaBytes(message)` — decrypt and return the plaintext, in memory. **This is how a photo
  is always handled.** The vault's own viewer shows photos from a `data:` URI precisely so that
  plaintext images never reach storage, and a chat photo is no less sensitive than a vault one.
  `saveToVault` takes this route for photos too, so keeping one never round-trips through disk.
- `fetchMedia(message)` — the same, then written to a `PlaybackScratch` file, returning its uri.
  **For video only**, and only because a player needs a file it can seek; the caller releases it
  when the viewer closes, and the scratch directory is purged on background regardless. Named
  `fetchMedia`, not `openMedia`, so it is never confused with the pure `openMedia` in `media.ts`.
- `fetchThumb(message)` — `getBlob`, decrypt, return the bytes, or `null` when the object is gone.
  It returns `null` rather than throwing because an expired preview is the ordinary end state of
  every message older than 30 days, not an error; a thread scrolling through a year of history
  would otherwise throw constantly. The screen caches the result by `thumbObject`.
- Pro is checked for send exactly as text already checks it (`canMessage()`), with no additional
  condition for video. As with text, the client check exists only so the UI can refuse politely —
  the Firestore rule on the message document is the real gate.

Upload progress is per-message state on the screen, not in the service; a failed upload leaves no
document and offers a retry.

**The three sources converge before they reach the service.** `sendMedia` takes a local file and a
kind; it does not know or care where they came from. The sources differ only in how they produce
that pair:

| Source | How it produces a file | Notes |
| --- | --- | --- |
| Camera | the existing `CameraSheet` | already does photo and video, already suspends auto-lock |
| Photo library | `LaunchImageLibrary` from `src/gallery/importService.ts` | `mediaTypes: ['images', 'videos']` |
| Vault | `readFullImage(id)` for photos, `readVideoToFile(id, uri)` for video | both already on `EncryptedVaultRepository` |

The photo library is opened here with **video allowed**, which differs from the vault's own import
picker — that one stays images-only, and video reaches the *vault* only through the camera. The
difference is deliberate and lives at the call site: it is a decision about what the vault accepts,
not about what a message may carry.

**The vault needs no new crypto.** `readFullImage` and `readVideoToFile` already decrypt under the
master key; the result is re-sealed under the conversation key like any other file. What the vault
does *not* provide is a reusable thumbnail — see the trap below.

> **Vault thumbnails are the wrong size, and quietly so.** The vault generates previews at
> `THUMBNAIL.defaultMaxDimension` = **512px, quality 82** (`src/vault/types.ts`), which is
> typically 40–90 KB. The chat thumbnail cap is **32 KB at 256px**. Reusing `readThumbnail(id)`
> therefore looks like a free optimisation and is not: it would pass every local check and be
> refused by the Storage rule on the device. The vault path regenerates at 256 exactly like the
> other two sources, and a test pins the resulting size.

`MessagingService` also gains **`saveToVault(conversationId, message)`** — `fetchMedia`, then
`addPhoto` or `addVideo` on the repository, gated by the existing `vaultGate`. It is on the service
rather than the screen because it needs the same decrypt-to-scratch path `fetchMedia` already owns,
and because a partially-saved item must be cleaned up in one place.

## 8. UI

- **Composer**: an attach button opening a small sheet with three rows — **Camera**, **Photo
  library**, **From the vault**. The first two go through the existing picker and `CameraSheet`, so
  auto-lock suspension comes for free; the vault route suspends it the same way, because decrypting
  a 100 MB video is not instant.
- **Vault picker**: a single-select sheet over the vault's items, reusing `PhotoTile` and the
  repository. Deliberately **not** `GalleryScreen`, which carries multi-select and Delete — a
  picker must not put a destructive action one mis-tap from a routine one. Videos show the same
  play badge they do in the gallery.
- **First vault send in a conversation**: a one-time sheet, not a dialog stacked on the picker.
  It states that a copy leaves the vault, that the recipient keeps theirs, that the server copy
  expires in 30 days, and that the original is unaffected; then Send or Cancel. Cancelling returns
  to the thread and remembers nothing, so the next attempt asks again.
- **Received media**: a Save to vault action on the bubble. On success it says so briefly; when
  `vaultGate` refuses it shows the existing `VaultUpsellDialog` rather than a bare failure, so the
  50-item ceiling reads as a limit with a way past it rather than a bug.
- **Bubble**: thumbnail at the bubble's width, rounded to match, with the same tail treatment as
  text. Uploading shows a progress ring over the thumbnail; failure shows a retry affordance.
- **Video bubble**: the same, plus a play badge and duration.
- **Full screen**: tap opens `MediaViewer`, a black full-screen sheet — `expo-image` with
  `contentFit="contain"` for a photo, `VideoSurface` for a video, the same two components the
  vault viewer uses. Deliberately not `PhotoViewerScreen` itself: that pages through the vault's
  own list by entry id, and a chat item is not a vault entry. It opens in a loading state
  immediately rather than after the fetch, so tapping a 100 MB video does not look inert, and it
  shows a failure (usually expiry) in place of the image rather than as a banner behind it.
- **Expired**: a dimmed placeholder reading "This photo has expired", **with no preview** — the
  thumbnail expires with the media. Not an error, and visibly distinct from a failed fetch, which
  offers a retry. Confusing the two would tell a user on a bad connection that their photo had been
  destroyed.
- **Loading**: a placeholder at the bubble's final size while the thumbnail is fetched, so the list
  does not jump as previews arrive.
- **Without Pro**: the attach button is absent for the same reason the composer is, and the
  existing `conversation_cannot_send` card already explains why and offers plans. No new upsell
  surface, and specifically no Cloud upsell anywhere in this feature.

## 9. Expiry

A bucket lifecycle rule, applied once, outside the app:

```
matchesPrefix: ["messages/"]
age: 30 days
action: Delete
```

It is configuration, not code, and therefore must be recorded in `firebase/README.md` and applied
as part of rollout — a spec that forgets it produces a design whose cost assumptions are false.

The prefix covers `photo/`, `video/` **and** `thumb/`, which is the point: media and preview expire
together, so nothing visual survives. The message documents are untouched — history remains, and
the thread shows who sent a photo and when, without the photo.

**It is applied to `gs://silentsum-vault-eevee-mate`, SilentSum's own bucket.** EVPAL uses the
project's default bucket, `eevee-mate.appspot.com`, which `firebase.json` deliberately keeps this
app away from. The separation is at bucket level, so this rule cannot reach EVPAL's data however it
is written — but the live bucket is still to be inspected before the rule is applied, because what
a config file declares and what a bucket contains are two different claims.

## 10. What is deliberately not done

Forwarding; captions; multi-select in either the vault picker or the composer; any transcoding or
re-encoding of video; resumable uploads; download progress for the full-size image. Each is a
separate feature and none blocks this one.

Saving received media into the vault **was** on this list and has been moved into the feature: it
is what makes the 30-day expiry acceptable rather than lossy, and it costs one service method plus
one bubble action because `addPhoto`, `addVideo` and `vaultGate` all already exist.

## 11. Testing

- **Rules (emulator)**: a member may read and write both paths; a non-member may do neither;
  either path is refused above its cap; **a member with no Cloud term may write both paths**, which
  is the regression test for the model this spec was revised to. These must exercise real Storage
  operations — the Firestore suite shipped a rule that refused every query because it only ever
  read documents by path.
- **Entitlement independence**: a Pro account whose Cloud term has expired can send and open a
  photo and a video. This is the same property `docs/billing.md` states for text, extended to media,
  and it is worth its own test because it is the thing the earlier draft got wrong.
- **Cipher**: round trip; a tampered AAD (wrong conversation, wrong sender, wrong object path) must
  fail to open; a thumbnail must not open as a body.
- **Service**: send writes the object before the document; a failed upload writes no document;
  sending without Pro is refused client-side for media exactly as it is for text; an absent object
  opens as expired rather than throwing.
- **Screens**: uploading, failed, expired and playable states.
- **Sources**: each of the three reaches `sendMedia` with a file and a kind; the vault picker
  offers no delete affordance; the photo library is opened with video allowed while the vault's own
  import picker is not.
- **The vault thumbnail trap**: a photo sent from the vault produces a thumbnail at 256px and under
  32 KB. This is a regression test for a specific mistake — reusing the vault's own 512px preview —
  that would pass every other test in this list and fail only on a real device.
- **The one-time warning**: shown on the first vault send in a conversation, not on the second;
  shown again in a different conversation; survives a remount; cancelling remembers nothing.
- **Save to vault**: a received photo and a received video each become vault items; a vault at the
  50-item ceiling shows the upsell instead of failing; an item over 100 MB is refused by the same
  gate that refuses it from the camera.

## 12. Rollout order

Storage rules → functions (none needed) → app → lifecycle rule. Rules first is safe here because
the paths are new: nothing exists under `messages/` to lock out. The lifecycle rule may be applied
at any point and has no effect until objects exist.

## 13. Risks

- **The `split()` question in §6.** Settled first, with a proven fallback; not a blocker either way.
- **Storage cost rests entirely on the 30-day expiry.** All chat media, video included, is carried
  by a one-time payment with no quota and no recurring revenue. The lifecycle rule is the only
  bound, so it must be applied before the feature reaches users, not after. If it is ever removed,
  something else — a quota, a shorter window, a Cloud requirement — has to replace it in the same
  change. This is the single largest risk in the design and it is a deliberate, priced-in choice.
- **A conversation deleted by hand leaves objects behind.** Harmless for at most 30 days, after
  which the lifecycle rule removes them. A second reason that rule is not optional.
- **The caps are resource limits, not a security boundary.** 8 MB and 100 MB bound what one message
  can cost; they are not load-bearing for entitlements, since no entitlement is checked in Storage.
- **The vault picker is a door out of the vault, and it is the first one.** Until now nothing could
  move a vault item off the device except cloud backup, which is the user's own encrypted copy.
  This sends a copy to somebody else. The design treats that as a decision rather than a gesture —
  the one-time explanation per conversation — but the risk is real and is not eliminated by a
  sheet: a user who taps through it has still sent the photo. The mitigation that matters more is
  that the picker is a separate, deliberate route rather than the default one, and that the vault's
  own copy is never moved or altered.
- **Decrypting a vault video writes a large plaintext to scratch.** `readVideoToFile` produces up
  to 100 MB of cleartext on disk in order to re-encrypt it. `PlaybackScratch` already owns this
  problem for playback and purges on background; the send path must use it rather than inventing a
  second scratch location, or a decrypted video outlives the session in the cache directory.

## 14. Dependency on Plan 1

Save to vault calls `vaultGate` with the item's byte length. That signature arrives in Plan 1
(free-tier vault video), which replaces the `kind`-based gate with a `bytes`-based one. **This
feature therefore cannot ship before Plan 1**, which the agreed order — Plan 1, then this, then the
500 MB allowance — already satisfies. It is recorded here because the dependency did not exist when
this spec was first written and would otherwise be invisible.
