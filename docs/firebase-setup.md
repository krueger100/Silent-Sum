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
printing the random one it just invented.

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
