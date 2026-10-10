# Firebase setup

Firebase is optional. The app builds, starts, creates a vault and unlocks with none of the steps
below. Follow them only to enable crash reporting, opt-in analytics, App Check and
end-to-end-encrypted cloud backup.

## Services used, and why

| Service | Purpose | Default |
| --- | --- | --- |
| Crashlytics | crash and error reports | on, user-toggleable, all free text scrubbed |
| Analytics | five coarse product events | off, opt-in, advertising ID disabled |
| App Check | restrict Firestore and Storage to genuine app instances | activated when configured |
| Authentication (email/password) | identifies the backup account only | never a vault credential |
| Cloud Firestore | key envelope and a manifest of uploaded ids | rules in `firebase/firestore.rules` |
| Cloud Storage | encrypted photo, thumbnail and index blobs | rules in `firebase/storage.rules` |
| Cloud Functions | PayMongo checkout, webhook and entitlements (`functions/`) | codebase `silentsum`, see §8 |

Not used: Cloud Messaging, Remote Config, Realtime Database, In-App Messaging. Cloud Messaging in
particular would add a notification permission for no product benefit.

The backup account is a separate credential from the PIN. Signing in does not unlock the vault, and
signing out does not lock it.

## 1. Create the projects

Create two Firebase projects, for example `silentsum-dev` and `silentsum-prod`. In each: enable
Authentication with the Email/Password provider, create a Firestore database in production mode,
enable Storage, enable Crashlytics, and enable App Check.

## 2. Register the apps

Android package and iOS bundle identifier: `com.kruegerco.silentsum` (override with `APP_ID`).

For Android, add the SHA-256 fingerprints of both your debug and release signing keys. Play
Integrity App Check needs the fingerprint of the key that actually signs the build.

## 3. Add the native config files

Place the downloaded files at:

```
config/firebase/google-services.dev.json
config/firebase/google-services.prod.json
config/firebase/GoogleService-Info.dev.plist
config/firebase/GoogleService-Info.prod.plist
```

`app.config.ts` adds the React Native Firebase config plugins **only when the file for the current
platform exists**. Without them no Firebase native initialisation is compiled in, and the JS layer
detects that at runtime. Paths can be overridden with `GOOGLE_SERVICES_JSON` and
`GOOGLE_SERVICES_PLIST` in `.env`.

These files are git-ignored. They hold public identifiers rather than secrets, but keeping them out
of the repository avoids accidentally mixing the dev and prod projects.

Re-run `npx expo prebuild` after adding them.

## 4. Deploy the security rules

```bash
cd firebase
firebase use silentsum-dev
firebase deploy --only firestore:rules,storage
```

Repeat with `firebase use silentsum-prod`.

`firestore.rules` allows only `users/{uid}/vault/{envelope,manifest}` for the owner and validates
the envelope shape, including the Argon2id parameter bounds and the base64 field sizes.
`storage.rules` allows only `users/{uid}/**` for the owner, capped at 100 MB per object and
`application/octet-stream`. Everything else is denied.

Local testing: `firebase emulators:start` using the ports in `firebase/firebase.json`.

## 5. App Check

The app activates App Check at startup: Play Integrity and App Attest with DeviceCheck fallback in
prod, debug providers in dev. In the console:

- Android: register the Play Integrity provider, which needs the SHA-256 fingerprints.
- iOS: enable App Attest with your Team ID.
- Dev builds need `APP_CHECK_DEBUG_TOKEN` set in `.env`, and that exact value registered under
  App Check, Apps, Manage debug tokens. Any UUID will do; generate one with
  `node -e "console.log(require('crypto').randomUUID())"`.
- Enforce App Check for Firestore and Storage only after you have seen a verified token.

### A dev build with no debug token

Leaving `APP_CHECK_DEBUG_TOKEN` empty does not disable App Check. The native SDK mints a random
debug secret per install (Android: `DebugAppCheckProviderFactory`), nothing has registered it, and
every Firestore read and Storage upload is refused. What you see in the app is:

> Messaging is not available in this build.

which is a claim about the build, for a server refusal. It comes from
`describeMessagingError('unavailable')`, and `messagingService.ts` maps a failed read of
`messagingKeys/{uid}` -- the peer's published key, needed by every conversation -- onto that code.
So the first symptom of a missing debug token is a message that sends you looking at the APK.

`app.config.ts` warns at build time when a dev build has no token, and refuses to publish one for a
prod build: a registered debug token inside a public APK would let anyone who unzips it bypass App
Check for the whole project. Prod attests with Play Integrity and needs no token.

To confirm what the device is doing: `adb logcat -d | grep -i appcheck`. An unregistered secret
shows as a rejected token exchange; "Enter this debug secret into the allow list" is the SDK
printing the random one it just invented. Be aware before you capture one that this log contains
the real token too -- see below.

### Where the token leaks

Two places, and an earlier version of this section got the first one wrong. Both matter.

**The logs.** The Firebase SDK prints the registered token in cleartext on every cold start, under
the obfuscated tag `D/w8.g`, as a ready-to-run line:

```
D/w8.g: firebase appcheck:debugtokens:create <uuid> --project <project> --app <app-id>
```

Confirmed by byte-comparing the logged value against `.env`: they are equal, so this is the token
the console has registered, not an invented one. Anyone with `adb` access to the device, or an app
holding `READ_LOGS`, can read it and bypass App Check for the whole project. Find it with
`adb logcat -d | grep appcheck:debugtokens:create` -- against a capture that actually contains a
cold start, which is the trap described next. **Treat a dev-build logcat as a secret-bearing file:
do not paste one into a chat, an issue, or a transcript.**

This section previously said "not the logs", for two reasons worth recording because the shape of
the mistake repeats. First, the search that produced that answer ran over a 29 MB capture with no
cold start in it, and absence from a log that cannot contain the thing is not absence. Second,
both `ProviderFactory::configure` and `Provider::configure` in `@react-native-firebase/app-check`
do print `(not shown)` in place of the value -- but that is the wrapper. The SDK underneath it
redacts nothing, on either the supplied or the generated path, and a wrapper being careful says
nothing about what it wraps.

**The APK.** `extra` is plaintext JSON at `assets/app.config` inside the archive, so
**a dev-environment APK is a secret-bearing artifact**: unzip it, read one key, and you can bypass
App Check for the whole Firebase project from any client. Treat the file the way you would treat
`.env`:

- never send a dev APK to a tester -- give them a Play internal-testing build, which is `prod` and
  carries no token (`withAppCheckEnvGuard` makes that the only kind of `.aab` that builds);
- delete stale ones. `android/app/build` is junctioned to `D:\silentsum-rn-build`, which is outside
  the repo and therefore outside `.gitignore`'s reach and outside anything that sweeps it;
- to check an artifact either way, inflate `assets/app.config` and look for `appCheckDebugToken`. A
  `prod` build does not have the key at all.

### Rotating the debug token

Register the replacement BEFORE revoking the old one. The other order leaves dev unable to read
Firestore between the two steps, with the symptom described above -- a message about the build, for a
server refusal.

1. Generate one: `node -e "console.log(require('crypto').randomUUID())"`. Never reuse a value, and
   never derive it from anything.
2. Firebase console, App Check, Apps, the Android app, Manage debug tokens, Add debug token. Give it
   a name you can trace to one machine, e.g. `carlo-emulator-2026-10-09`. Leave the old one in place.
3. Put the new value in `.env` under `APP_CHECK_DEBUG_TOKEN`. It is already git-ignored
   (`.env`, `.env.*`, `!.env.example`); `.env.example` keeps an empty placeholder and nothing else.
4. Rebuild and reinstall: `SILENTSUM_ENV=dev ./gradlew assembleRelease`. Not `bundleRelease` -- the
   guard refuses that outside `prod`, which is the point of it.
5. Confirm the new build attests before going further. `debugToken: (not shown)` in the log proves
   only that RNFB was handed something, so the test that counts is behavioural: a Firestore read in
   the app must succeed -- open Messages and let a conversation load. To check WHICH token the build
   carries, compare `appcheck:debugtokens:create` from a cold-start logcat against `.env` by
   digest, never by printing either; then delete the capture.
6. Only now delete the old token in the console.
7. Delete every artifact built with the old one, starting with
   `D:\silentsum-rn-build\app\outputs\apk\release\app-release.apk`.

One token per machine, each named, so a single leak can be revoked without stopping anyone else.
Nothing here touches enforcement: App Check stays enforced on Firestore and Storage throughout, and
a build that cannot attest is refused rather than waved through.

## 6. Crashlytics and Analytics

Collection is disabled in the manifest and enabled at runtime from the user's settings. Everything
the app hands to Crashlytics passes through the scrubber first. Stack traces are deliberately not
scrubbed, because redacting file paths inside frames would destroy symbolication; the scrubber is
applied to messages and context values, which are the fields that could carry user input.

Analytics stays entirely silent until the user opts in. No user id or user property is ever set.

## 7. Cost

Each backup upload is a full ciphertext copy of the photos, so Storage egress and storage are the
cost drivers. Set a budget alert before inviting real users.

## 8. Billing (Cloud Functions + PayMongo)

Purchases (SilentSum Pro, SilentSum Cloud) run through five Cloud Functions in `functions/`
(codebase `silentsum`) that hold the PayMongo keys as Firebase secrets; the app only ever calls
them. `docs/billing.md` has the design, the configuration table and the setup steps. The short
form:

```bash
cd functions && npm install && cd ..
firebase functions:secrets:set PAYMONGO_SECRET_KEY --project eevee-mate
firebase functions:secrets:set PAYMONGO_WEBHOOK_SECRET --project eevee-mate
firebase deploy --only functions:silentsum --project eevee-mate
```

Register the webhook URL in the PayMongo dashboard, then ship the app, and **only then** deploy
the rules (`firestore:rules,storage`): they gate backup writes on an active Cloud term, and
deploying them first would stop every existing backup. The Storage rules read Firestore
(`firestore.get`); the first such deploy asks to grant the Storage rules service agent access.

`firebase deploy --only functions:silentsum` manages only this codebase's five functions. Never
run a bare `--only functions` deploy from another project against `eevee-mate` without checking
what it would delete: EVPAL's Stripe functions live there too.

## Production checklist

- Separate dev and prod projects; release builds use `SILENTSUM_ENV=prod`.
- Rules deployed to prod and App Check enforced.
- Release keystore fingerprint registered and linked to the Play Console app.
- No Admin SDK credentials anywhere in the repository. The app only ever uses client SDKs, and none
  are needed.
- Confirm the merged manifest still exports only the launcher activity after any Firebase
  dependency change.
