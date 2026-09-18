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
- Dev builds print a debug token; register it under App Check, Apps, Manage debug tokens, and set
  `APP_CHECK_DEBUG_TOKEN` in `.env` if you want it passed explicitly.
- Enforce App Check for Firestore and Storage only after you have seen a verified token.

## 6. Crashlytics and Analytics

Collection is disabled in the manifest and enabled at runtime from the user's settings. Everything
the app hands to Crashlytics passes through the scrubber first. Stack traces are deliberately not
scrubbed, because redacting file paths inside frames would destroy symbolication; the scrubber is
applied to messages and context values, which are the fields that could carry user input.

Analytics stays entirely silent until the user opts in. No user id or user property is ever set.

## 7. Cost

Each backup upload is a full ciphertext copy of the photos, so Storage egress and storage are the
cost drivers. Set a budget alert before inviting real users.

## Production checklist

- Separate dev and prod projects; release builds use `SILENTSUM_ENV=prod`.
- Rules deployed to prod and App Check enforced.
- Release keystore fingerprint registered and linked to the Play Console app.
- No Admin SDK credentials anywhere in the repository. The app only ever uses client SDKs, and none
  are needed.
- Confirm the merged manifest still exports only the launcher activity after any Firebase
  dependency change.
