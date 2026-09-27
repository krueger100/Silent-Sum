# Support chat

A two-way conversation between one account and SilentSum support, over the same Firestore the
backup uses. It sits beside the existing one-way e-mail form, which is unchanged: the form still
works in builds with no cloud at all, and the chat is offered only where Firebase is configured.

## What it is not

The chat carries typed text and timestamps. It never carries vault data. The composer refuses a
message before writing it when the text looks like ciphertext, a wrapped key, a PIN, a recovery
passphrase or anything named as key material, and nothing in the feature can read the vault, the
master key, the PIN or the recovery code. Diagnostics are not attached.

## Where it lives

| Path | Written by | Read by |
| --- | --- | --- |
| `users/{uid}/support/thread` | the owner (read marker only) and the server | the owner |
| `users/{uid}/support/thread/messages/{id}` | the owner (`sender: 'user'`) and the server (`sender: 'support'`) | the owner |

The thread document holds `userLastReadAt` and nothing else the client may set. Unread is derived:
support messages newer than that marker. No counter is stored, so nothing can drift.

Messages are ordered by `createdAt`, a millisecond number the rules pin to the server's own clock,
so a message cannot be backdated or postdated. One `orderBy` on one collection is served by the
automatic single-field index; no composite index is needed.

## Who may do what

Enforced by `firebase/firestore.rules` (and the deployed `firestore.merged.rules`):

- Only the owner reads the thread or any message. Another signed-in account is refused.
- Sending a new message requires an active Cloud term, the same `cloudActive` check the backup
  writes already use.
- Reading is never gated. A lapsed or cancelled Cloud account keeps the whole history and keeps its
  local vault, PIN, recovery code and Pro entitlement exactly as they were.
- A client cannot write `sender: 'support'`, cannot edit a sent message, and cannot delete one.
- The thread document accepts only `v`, `uid` and `userLastReadAt`, so an owner cannot invent
  conversation state.

## Answering

`silentsumSupportReply` is a callable in the `silentsum` functions codebase. It refuses any caller
whose token lacks the `silentsumSupport` custom claim, then writes the reply with the Admin SDK,
which is the only way a `support` message can exist. App Check is enforced exactly as it is for the
purchase callables. The PayMongo secret is deliberately not bound to it.

Grant an operator the claim once, from a trusted machine with Admin SDK credentials:

```js
await getAuth().setCustomUserClaims(operatorUid, { silentsumSupport: true });
```

There is no self-service path to that claim, and the user's own app never sets claims.

With no Admin SDK credentials to hand, the same thing can be done from Cloud Shell, which is
already authenticated as the project owner. The Identity Platform console has no custom-claims
editor, so it goes through the Identity Toolkit API; the access token stays inside the command
substitution and is never printed:

```sh
curl -s -X POST -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H "Content-Type: application/json" \
  -d '{"localId":"<uid>","customAttributes":"{\"silentsumSupport\":true}"}' \
  "https://identitytoolkit.googleapis.com/v1/projects/eevee-mate/accounts:update"
```

Swap `accounts:update` for `accounts:lookup` with `{"localId":["<uid>"]}` to read it back; pipe
that through `jq -r '.users[0].customAttributes'` so the rest of the record stays off the screen.
A claim reaches the operator's ID token only on the next token refresh, so sign out and back in.

Granted on 2026-09-22 to `carloliverkrueger111@gmail.com`
(`xjTqI8OTrgXw9OnXqixv40TbTzO2`), the project's only account.

A reply can equally be written straight into `users/{uid}/support/thread/messages/{id}` from the
Firebase console; the open conversation in the app updates live either way.

## Push notifications

Not implemented, because the app has no push dependency: neither `@react-native-firebase/messaging`
nor `expo-notifications` is installed, and adding either is a native change requiring a new build
and Firebase Cloud Messaging setup. Replies appear the moment the screen is open, and the unread
count is correct whenever the conversation is opened.

## Rollout

Deployed on 2026-09-22 as `firebase/firestore.stage1.rules` (see `firebase/README.md`): the chat
rules are live, the backup gate is deliberately held back until the app that sells Cloud ships.
Deploy order is unchanged: functions, then the app build, then the full merged rules. Deploying the merged file before the app ships is safe
for the chat (nobody is using it yet) but would gate backup writes on a Cloud term, which is why
the gate waits.
