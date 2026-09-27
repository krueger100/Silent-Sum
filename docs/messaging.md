# User-to-user messaging

End-to-end encrypted conversations between two SilentSum accounts. A Pro feature, enforced by the
server. Entirely separate from the support conversation in [support-chat.md](support-chat.md):
different collections, different keys, different rules, and neither can read the other.

## What the server can see

A conversation document naming two account ids, a per-side unread count, a timestamp, and rows of
base64. That is all. Bodies are XChaCha20-Poly1305 ciphertext under a key the server never has and
cannot derive, and the addresses people looked each other up by are encrypted too.

## Keys

```
vault master key --HKDF "silentsum/messaging/id/v1"--> seed --crypto_box_seed_keypair--> X25519 pair
                 '-HKDF "silentsum/messaging/contact/v1"--> contacts key (private labels)

my secret + their public --X25519--> shared --HKDF "silentsum/messaging/conv/v1|<cid>"--> conversation key
```

Nothing is stored. The identity is derived on unlock from the key the vault already holds, so
there is no second secret to back up and no new way to lose access: restore the vault and every
old conversation opens again. Only the public half is published.

The Diffie-Hellman itself is the one primitive here that is not libsodium: it is `x25519` from
`@noble/curves`, in JS. `react-native-libsodium` bridges a fixed list of functions to the device
in `lib.native.ts`, and neither `crypto_box_beforenm` nor `crypto_scalarmult` is on it — there is
no X25519 in the native build at all, only the all-in-one `crypto_box_easy`. The keypair still
comes from libsodium (`crypto_box_seed_keypair` _is_ bridged) and the two agree: noble derives the
same public key from a libsodium secret key. The raw DH output is never used as a key; the HKDF
above is what turns it into one. `src/crypto/__tests__/nativeSurface.test.ts` now checks every
imported binding function against the native build, because a missing one type checks, passes the
suite, and fails only on a phone.

Both sides compute the same conversation key, so one ciphertext serves sender and recipient. The
key is bound to the conversation id, and every message's authentication tag covers its
conversation, sender and timestamp — a ciphertext moved to another conversation, re-attributed or
re-dated does not open.

**Messaging needs an unlocked vault.** Locked, the app can list conversations and unread counts
but not read a word of them. That is the same key boundary the photos are behind.

## Where it lives

| Path | Written by | Read by |
| --- | --- | --- |
| `messagingKeys/{uid}` | that account only | any signed-in account |
| `conversations/{cid}` | either member | those two members |
| `conversations/{cid}/messages/{id}` | either member (`from` must be itself) | those two members |
| `users/{uid}/contacts/{peerUid}` | that account only | that account only |

`cid` is the two uids, sorted, joined with `__`. Deterministic on purpose:

- two people can only ever have one conversation, so starting one is idempotent and a race
  between both sides converges instead of forking;
- **membership is readable from the id**, so the rules answer "may you see this message?" without
  fetching the parent document. A rule that read the parent would cost an extra read for every
  message displayed.

The cost is that this is a two-party model. Group chat would need random ids and a members list
the rules have to `get()`.

Conversations are listed with `where('members', 'array-contains', uid)` and no `orderBy`, so the
automatic single-field index serves it and **no composite index is needed**; the handful of rows
is sorted on the device. Messages are ordered by `createdAt` alone — again a single-field index.

## Who may do what

Enforced by `firebase/firestore.rules` (and the deployed merged/staged file):

- Only the two members read or write a conversation or its messages. A third account is refused
  by every operation, including the listing.
- **Creating a conversation and sending a message require Pro**, checked against
  `users/{uid}/billing/entitlements`, which only the PayMongo webhook writes. A patched client
  that claims Pro gets `permission-denied` from Firestore.
- Reading is never gated. An account that lets Pro lapse keeps its whole history, and its vault,
  PIN, recovery code and Cloud term are untouched.
- A sender may add exactly one to the other side's unread count and may not touch its own; a
  reader may zero only its own. Neither can rewrite membership, edit a sent message or delete
  anything.
- `from` must be the caller, `createdAt` is pinned to the server's clock (+60 s / −300 s), and the
  ciphertext has a size ceiling so the collection cannot be used as file storage.

## Finding someone

`silentsumFindUser` takes one exact e-mail address and answers with one account id, or nothing.
No prefix search, no listing, no directory — SilentSum cannot tell you who else uses it. The
callable requires Pro and spends one of 30 lookups per hour per caller, counted in the server-only
`silentsum_directory_lookups` collection, so a paid account cannot walk a list of addresses
either. App Check is enforced as it is for the purchase callables, and the PayMongo secret is not
bound to it.

The address you typed is then kept in `users/{you}/contacts/{them}`, encrypted with your contacts
key, so the app can show a name instead of an id. It never reaches the shared document.

## Naming the other side

Only the account that _started_ a conversation typed an address, so only it has a contact. The
receiving account has a uid and nothing else, and a list row reading `rfXV7zGKaeh…` tells the
person nothing about who is writing to them — which is also the condition an impersonation
attempt wants.

`silentsumPeerEmail` closes that gap: one account id in, its address out. Its gate is
**membership, not Pro** — the server answers only about an account the caller already shares a
conversation with, which is a single existence check on `conversations/{sorted ids}` and needs no
query. That is what stops it being an id-to-address oracle: you can only ask about someone who is
already talking to you, and they could only have started that conversation by knowing your
address first. Pro is deliberately not required, because receiving and reading never need it
anywhere else. The same 30-per-hour budget applies.

The client treats it as a nicety, not a requirement. `MessagingService.nameUnknownPeers()` asks
once per peer per unlocked session, files the answer in that account's own encrypted contacts, and
swallows every failure — a locked vault, a spent budget, no network. The row then falls back to
the account id, which is honest rather than broken. The shared document still carries no
addresses, and never will.

The other person must have opened Messages at least once, which is when their public key is
published. Until then, starting a conversation fails with "has not set up messaging yet" and
writes nothing.

Deriving the identity is local and costs nothing. **Publishing** the public key is a write to the
cloud, so it does not happen on unlock: it happens the first time the user opens Messages, and
again when they start a conversation. An account that never opens the feature leaves no trace of
it in the database.

## The screens

`ConversationsScreen` is the list, `ConversationScreen` one thread; the layout helpers next to
them (`chatItems.ts`, `chatTime.ts`, `Avatar.tsx`) are pure and tested on their own.

Two constraints shape what the UI can show, and both are worth knowing before "improving" it:

- **A conversation row cannot show a message preview.** Bodies are ciphertext and the shared
  conversation document has never held one. Adding a preview field would mean writing plaintext
  to the one document both accounts can read — the thing the whole design avoids. A row shows
  who, when, and how many are unread, because that is all the document honestly knows.
- **There are no profile pictures, and there is nowhere to put one.** The avatar is derived on
  the device: the peer's uid picks the colour, the name picks the letter.

Everything else is the ordinary chat shape — an inverted list, bubbles that lean toward their
sender, day separators, runs by one sender grouped within five minutes, a docked composer. The
encryption notice above the thread deliberately does not scroll away: what it says about the PIN
is the sentence this app most needs a user to have read.

## Photos and video

A message carries text, a photo, or a video. Media is **Pro, with no Cloud condition anywhere** —
an account whose Cloud term has lapsed, or that never had one, sends and receives media exactly as
it sends text. It comes from three places: the camera, the photo library, or the vault.

Sending from the **vault** is a copy, never a move: the vault's own item is untouched. Because it
is the one route that moves a vault item off the device to somebody else, the first vault send in
each conversation shows a one-time explanation before it happens — per conversation rather than
per send, because a dialog seen on every send is one people learn to dismiss unread, and per
conversation rather than once per install, because *who* the copy goes to is the part that matters.

Media received in a conversation can be **saved into the vault**, where it becomes an ordinary
vault item under the ordinary limits: the 50-item free cap and the 100 MB per-item cap. That is
what makes the expiry below tidy rather than lossy.

**Media and its preview both expire after 30 days.** A bucket lifecycle rule sweeps everything
under `messages/`, and the thumbnail lives there rather than inline in Firestore precisely so that
one rule reaches both — an inline preview would outlive the photo it previews for ever. The message
record survives: the thread still shows who sent a photo and when, with no imagery. Metadata is
conversation history; content is what expires.

None of it counts against the Cloud backup allowance. Chat media is under `messages/`, not
`users/{uid}/`, belongs to Pro rather than Cloud, and is bounded by the expiry instead.

**A plaintext photo never reaches disk.** Opening one decrypts it into memory and shows it from a
`data:` URI, the same discipline the vault's own viewer keeps; saving one to the vault takes the
same route. Video is the single exception, because a player needs a file it can seek — that file
comes from `PlaybackScratch`, is released when the viewer closes, and is purged when the app
backgrounds even if it is not.

The ciphertext lives at `messages/{cid}/{photo|video|thumb}/{messageId}`, encrypted under the same
conversation key text uses, with the object's own path bound into the tag so a valid ciphertext
cannot be re-pointed at another message. Each object is `nonce || ciphertext`, so a receiving
device needs nothing but the object to open it. The Storage rules check conversation membership
from the path and read no entitlement at all — Pro is enforced on the message document, where it
already was.

## What cannot be sent

The composer refuses, before writing anything, text that looks like a PIN, a recovery passphrase,
key material or vault ciphertext — the same guard the support form uses. Encryption is not a
reason to hand someone your recovery passphrase.

## Push notifications

Not implemented: the app has no push dependency (neither `@react-native-firebase/messaging` nor
`expo-notifications` is installed), and adding one is a native change needing a new build and FCM
setup. Messages arrive live while the app is open, and unread counts are correct the moment the
list is opened. With end-to-end encryption a push could only ever say "new message" anyway.

## Rollout

Both server-side halves went out on 2026-09-22:

1. `firebase deploy --only functions:silentsum` — `silentsumFindUser` created, the other six
   updated in place.
2. `firebase deploy --only firestore:rules --config firebase.stage1.json` — the messaging
   collections, additive over what was live. See `firebase/README.md` for why the staged
   ruleset exists.

What remains is the app build: nothing on a phone can reach any of this until one ships.
