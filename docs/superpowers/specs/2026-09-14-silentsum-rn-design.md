# SilentSum (React Native) — Design

Date: 2026-09-14
Status: approved by the product brief that requested this rebuild (the brief is the spec of record; this document records the decisions taken to satisfy it). The Flutter implementation at `../silentsum_flutter` is the behavioural reference; its exact formats and flows are extracted in `docs/reference/flutter-*.md`.

## 1. Purpose

SilentSum is a real calculator that doubles as a PIN-protected, encrypted photo vault. Typing the vault PIN on the calculator and pressing `=` opens the vault (camera, gallery, viewer). Authentication and storage are fully local and offline. Firebase is an optional remote layer: Crashlytics (default on, scrubbed), Analytics (opt-in), App Check, and an explicit end-to-end-encrypted cloud backup behind Firebase Authentication. The app must run unchanged when Firebase is not configured.

## 2. Stack

| Concern | Choice | Why |
|---|---|---|
| Framework | Expo SDK 57 / React Native 0.86 / React 19, TypeScript strict | Config plugins give us native config (permissions, FLAG_SECURE, backup rules) without hand-maintained native projects; `expo prebuild` regenerates `android/` and `ios/`. |
| Crypto | `react-native-libsodium` 1.7 (JSI libsodium): Argon2id (`crypto_pwhash` ALG_ARGON2ID13), XChaCha20-Poly1305 IETF (`crypto_aead_xchacha20poly1305_ietf_*`), CSPRNG. `@noble/hashes` for HKDF-SHA256 (32-byte sub-keys, identical in tests and on device). | Audited native primitives, byte-compatible with the Flutter vault format. Tests alias the module to `libsodium-wrappers-sumo` (same API). |
| Secure storage | `expo-secure-store`: Android Keystore-backed AES-GCM over app-private SharedPreferences; iOS Keychain `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, no iCloud sync. | The platform-native mechanisms the brief requires, through a maintained Expo module. Holds only the wrapped master key record and throttle state. |
| Files | `expo-file-system` (`File`/`Directory`/`Paths`), document directory | App-private, never media-scanned; `allowBackup=false` + data-extraction rules exclude it from OS backups. |
| Camera / import / thumbnails / display | `expo-camera`, `expo-image-picker`, `expo-image-manipulator`, `expo-image` (data-URI sources) | Decrypted images are shown from memory (base64 data URIs); no plaintext files are written by the app. Plugin temp files are securely wiped immediately. |
| Screenshots / switcher | `expo-screen-capture` (`preventScreenCaptureAsync` = FLAG_SECURE on Android, secure-field trick on iOS) + our own privacy curtain on inactive/background | Matches the Flutter behaviour (FLAG_SECURE while unlocked, curtain otherwise). |
| Navigation | React Navigation native-stack, state-gated | The vault stack is only mounted while the session is unlocked, so there is no URL/deep-link surface into vault screens and locking unmounts them. |
| State | Zustand stores for session status, settings, vault status; pure functions for engine/policies | Small, testable; key material is held outside any store (see §5). |
| Firebase | `@react-native-firebase/{app,auth,firestore,storage,crashlytics,app-check,analytics}` 26.x, modular API | Config plugins are added in `app.config.ts` only when the native config files exist; the JS gateway detects availability at runtime. |
| Tests | Jest (`jest-expo`), `@testing-library/react-native`, `libsodium-wrappers-sumo`, `jpeg-js` | Same test matrix as the Flutter project, against in-memory fakes. |

## 3. Architecture

```
src/
  app/            composition root (production wiring, ServicesProvider), bootstrap, theme
  calculator/     pure engine + controller hook + screen/keypad/display
  auth/           PIN policy, throttle, credentials, PinAuthService, session, status, eraser, PIN screens
  vault/          PhotoEntry/VaultIndex, VaultRepository (encrypted), thumbnails, decrypted cache, paths
  crypto/         libsodium adapter, Argon2id, key wrapping, HKDF vault keys, SSV1 file cipher, random
  secure-storage/ SecureStore interface, expo-secure-store adapter, in-memory fake
  storage/        FileSystem interface, expo adapter, in-memory fake, atomic write, secure delete
  camera/         capture flow (CameraView -> encrypt -> wipe temp)
  gallery/        grid, tile, viewer, import service
  firebase/       interfaces, gateway (availability), Crashlytics/Analytics/CloudBackend adapters, fakes, scrub
  backup/         envelope, BackupService, passphrase policy, cloud error copy, backup/restore screens
  privacy/        auto-lock policy + suspension, lifecycle guard, curtain, screen protection adapter
  settings/       AppSettings model, stores, settings screens
  components/     shared UI primitives (buttons, dialogs, list rows, toasts)
  navigation/     RootNavigator (session-gated stacks), route types
  utils/          bytes, base64, clock, iso8601, formatting
```

Dependency direction: `screens -> services (interfaces) -> adapters`. UI never imports libsodium, expo-secure-store, expo-file-system or Firebase; it receives services through `ServicesProvider`. Every platform-facing capability has an interface and an in-memory fake, so tests boot the real app with fakes.

Rule: every sensitive operation takes the `VaultKeys` of the live in-memory session; when locked the repository is closed and its caches zeroed. UI visibility is never the security boundary.

## 4. Offline authentication and key hierarchy (unchanged from the reference)

- Setup: 32-byte random master key (VMK) + 16-byte salt; `KEK = Argon2id(PIN, salt, 32 MiB, t=3, p=1)`; `wrapped = XChaCha20-Poly1305(KEK, nonce24, VMK, aad "silentsum/vmk/v1")`; `VaultCredentials{v:1,salt,kdf,wrapped,pinLength,createdAt}` stored in the secure store as compact JSON. PIN and KEK buffers zeroed.
- Unlock: derive KEK with the STORED params (bounded: m <= 256 MiB, t <= 10, p == 1 for libsodium, len == 32) and unwrap; Poly1305 failure = wrong PIN. There is no separate verifier.
- Sub-keys: `HKDF-SHA256(VMK, salt = empty, info = silentsum/{photo,thumb,index}/v1, 32)`.
- Throttle: failures 1-2 free; 3rd 5 s; 4th 15 s; 5th 30 s; 6th 60 s; 7th 5 min doubling to a 1 h cap. Persisted `{failedCount, lockedUntil, lastFailureAt}` in the secure store plus an in-process monotonic deadline; backwards clock = still locked. Throttled attempts never run the KDF. No automatic wipe, no backdoor.
- Length gate: only bare integers of exactly the configured PIN length are attempts, so arithmetic never trips the throttle.
- Forgot PIN -> typed confirmation -> erase (secure-delete files, delete credentials + throttle, clear backup flags). The confirmation phrase is `DELETE MY VAULT` (the brief's phrase; the Flutter build used `ERASE`).
- The Argon2id call is a synchronous JSI call (~150-400 ms at 32 MiB on a phone). Screens yield a frame before calling it so progress UI renders; this is documented as a limitation versus the Flutter isolate.

## 5. Storage and encryption at rest (unchanged formats)

- `<documentDirectory>/vault/{index.enc, photos/<id>.enc, thumbs/<id>.enc}`; ids are 32 hex chars from the CSPRNG.
- Blob container `SSV1`: `"SSV1"(4) | 0x01 | keyId | nonce(24) | ciphertext | tag(16)`, header authenticated as AAD. Key ids photo=1, thumb=2, index=3.
- Index JSON `{"version":1,"photos":[...]}` newest first, encrypted with the index key, written atomically (temp + rename). Thumbnails 512 px longest side, JPEG q82, encrypted with the thumb key.
- Decryption is on demand into byte-budgeted LRU caches (24 MiB thumbs, 48 MiB full) that are zeroed on lock. Display uses `data:` URIs produced with native base64; no plaintext file is ever written by the app.
- Camera: `takePictureAsync` output and picker copies are read, encrypted, then securely overwritten and unlinked in `finally`. Thumbnails are produced by `expo-image-manipulator` from that same temp file before it is wiped.
- Secure delete: one pass of pseudo-random bytes in place, then unlink (best effort on flash; documented).

## 6. Calculator

Pure engine reproduced from the reference (left-to-right with `x /` precedence, percent unary, `+/-`, backspace, all-clear, 15-digit entry cap, `toPrecision(10)` formatting, Unicode operator glyphs). `=` on a bare 4-8 digit integer with no pending tokens produces an unlock candidate that lives for exactly one state transition. The controller submits it only when a vault is configured and the length matches; wrong PIN shows nothing; throttled shows a discreet toast with remaining time and "Forgot PIN?".

## 7. Lifecycle and privacy

- `AppState` mapping: iOS `inactive` -> clear calculator + curtain; `background` (both platforms) -> clear calculator, stamp monotonic `backgroundedAt`, curtain; `active` -> lock if the configured timeout (immediately / 30 s / 1 / 5 / 15 min; default 1 min) has elapsed, unless a picker/permission suspension is active and within the 5-minute grace.
- Screen protection: `preventScreenCaptureAsync` while unlocked and the setting is on; cleared on lock. On Android this is FLAG_SECURE (also blanks the recents preview). iOS additionally relies on the curtain (rendered on `inactive`) so no vault content is in the switcher snapshot.
- Sessions are never persisted; a process restart is always locked.

## 8. Firebase

- `app.config.ts` adds the RNFirebase plugins and `googleServicesFile` only when `config/firebase/google-services.<env>.json` / `GoogleService-Info.<env>.plist` exist (paths overridable via `.env`). Otherwise no Firebase native initialisation is compiled in.
- `firebaseGateway.initializeFirebase(env)` never throws: it lazily requires the RNFirebase modules, checks `getApps().length > 0`, activates App Check (Play Integrity / App Attest in prod, debug providers in dev), and returns `FirebaseServices{available, crash, analytics, cloud}` or `FIREBASE_UNAVAILABLE`.
- Crashlytics: enabled from the `crashReportsEnabled` setting (default on); every free-text field passes through `scrub` (4-8 digit runs -> `[redacted]`, paths -> `[path]`). Analytics: opt-in; five coarse event names, no ids. Manifest meta-data disables collection and Advertising-ID by default.
- Firebase Auth identifies the backup account only; it never participates in unlocking.

## 9. Cloud backup (E2E)

- Envelope `{v:1,salt,kdf(64 MiB,3,1),wrapped(aad silentsum/backup-envelope/v1),createdAt}` in Firestore `users/<uid>/vault/envelope`; manifest `{photoIds,photoCount,updatedAt}` in `users/<uid>/vault/manifest`; blobs `users/<uid>/{index.enc,photos/<id>.enc,thumbs/<id>.enc}` uploaded byte-for-byte as they exist on disk with `application/octet-stream`.
- Restore recovers the VMK with the passphrase, wraps it under a new local PIN (`adoptMasterKey`), then imports blobs after authenticating them with the session keys.
- Security rules (`firebase/firestore.rules`, `firebase/storage.rules`) restrict every path to the owner and validate shapes/sizes. The server can never decrypt anything.

## 10. Configuration and builds

- `.env.example` documents `SILENTSUM_ENV`, `GOOGLE_SERVICES_JSON`, `GOOGLE_SERVICES_PLIST`, `APP_CHECK_DEBUG_TOKEN`, `APP_ID`. Nothing is required.
- Android build outputs and Gradle caches live on `D:` (`GRADLE_USER_HOME=D:\gradle-cache`, `android/app/build` junction to `D:\silentsum-rn-build`); see `docs/building.md`.
- Release: R8 minify + resource shrinking, signing via `android/keystore.properties` (git-ignored) or EAS credentials. Keystores are never committed.

## 11. Testing strategy

Unit tests mirror the Flutter suite (engine, PIN policy, throttle, KDF, wrapping, file cipher, secure delete, atomic write, settings, PinAuthService, repository, backup service, auto-lock policy, scrub). Component tests boot the real screens with fakes for: onboarding, PIN setup, unlock/lock via calculator, throttling toast, gallery refresh, auto-lock on resume, curtain visibility, screen-protection calls. Firebase is never initialised in tests; the cloud is an owner-scoped in-memory backend.

## 12. Known limitations

- JS cannot pin or reliably zero all copies of secrets; buffers are zeroed on lock (best effort).
- Argon2id runs synchronously on the JS thread (brief stall during setup/unlock).
- SSV1 binds the key id but not the photo id (same-kind blobs could be swapped without failing authentication; confidentiality unaffected).
- iOS cannot be compiled on this Windows host; the project is configured for it.
- Secure deletion is best effort on flash storage.
