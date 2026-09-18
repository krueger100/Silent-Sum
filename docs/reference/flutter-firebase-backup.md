# Flutter reference: firebase-backup

_firebase-backup — optional Firebase bootstrap (Core/App Check/Crashlytics/Analytics/Auth/Firestore/Storage) behind interfaces, plus the end-to-end-encrypted cloud backup feature (BackupEnvelope, BackupService, CloudErrors, PassphraseDialog, RestoreFlowScreen, CloudBackupScreen) and the Firebase security rules. SilentSum Flutter reference at C:/Users/carlo/AndroidStudioProjects/silentsum_flutter._

Files read: C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/firebase/firebase_bootstrap.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/firebase/firebase_services.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/firebase/cloud_backend.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/firebase/firebase_cloud_backend.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/firebase/crash_reporter.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/firebase/firebase_crash_reporter.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/firebase/analytics_service.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/firebase/firebase_analytics_service.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/firebase/firebase_options_dev.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/firebase/firebase_options_prod.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/backup/backup_envelope.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/backup/backup_service.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/backup/cloud_errors.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/backup/passphrase_dialog.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/backup/restore_flow_screen.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/settings/cloud_backup_screen.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/settings/settings_screen.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/settings/security_screen.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/test/features/backup/backup_service_test.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/test/features/lifecycle/auto_lock_policy_test.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/test/support/test_app.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/test/core/security/key_derivation_test.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/test/core/security/key_wrapping_test.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/test/core/storage/settings_store_test.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/test/features/authentication/pin_auth_service_test.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/test/features/vault/encrypted_vault_repository_test.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/firebase/firestore.rules, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/firebase/storage.rules, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/firebase/firebase.json, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/firebase/firestore.indexes.json, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/docs/security.md, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/docs/architecture.md, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/docs/firebase-setup.md, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/environment.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/clock.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/security/key_derivation.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/security/key_wrapping.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/security/vault_keys.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/security/byte_utils.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/security/secure_random.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/security/file_cipher.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/security/pin_policy.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/storage/settings_store.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/storage/prefs_settings_store.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/storage/vault_paths.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/app/providers.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/app/router.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/main.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/vault/vault_repository.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/vault/vault_index.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/vault/photo_entry.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/vault/encrypted_vault_repository.dart (backup-facing methods only, lines 218-261), C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/authentication/pin_auth_service.dart (adoptMasterKey / _wrapMaster, lines 180-223), C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/authentication/pin_setup_screen.dart (restore link, lines 1-60 and 191-250), C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/authentication/vault_session_controller.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/authentication/vault_session.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/authentication/vault_status.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/authentication/forgot_pin_dialog.dart (backup paragraph), C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/authentication/erase_vault_dialog.dart (settings reset), C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/authentication/vault_eraser.dart (settings reset), C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/pubspec.yaml (dependency versions), C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/android/app/src/main/AndroidManifest.xml (Firebase meta-data / removed permissions), C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/android/app/build.gradle.kts (conditional google-services plugin), C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/.gitignore (Firebase config ignores)

## Behaviour

# 0. Dependency baseline (Flutter reference)

| Package | Version | Used for |
|---|---|---|
| `firebase_core` | ^4.14.0 | `Firebase.initializeApp` |
| `firebase_app_check` | ^0.4.7 | App Check providers |
| `firebase_auth` | ^6.6.1 | email/password only |
| `cloud_firestore` | ^6.9.0 | envelope + manifest documents |
| `firebase_storage` | ^13.5.0 | ciphertext blobs |
| `firebase_crashlytics` | ^5.3.0 | crash reports |
| `firebase_analytics` | ^12.5.0 | opt-in events |
| `cryptography` | ^2.9.0 | Argon2id, XChaCha20-Poly1305, HKDF |

App id (Android package and iOS bundle id): `com.kruegerco.silentsum`. Firebase services NOT used: Cloud Messaging, In-App Messaging, Realtime Database, Remote Config, Google Sign-In, phone/OAuth auth, reCAPTCHA.

# 1. Build-time environment (`SilentSumEnv`)

1. Enum values `dev`, `prod`. Selected by compile-time define key `SILENTSUM_ENV` (`--dart-define=SILENTSUM_ENV=dev|prod`).
2. Resolution: raw == `prod` → prod; raw == `dev` → dev; anything else → `prod` in release builds, `dev` in debug/profile builds.
3. `isProd` = (value == prod).

# 2. FirebaseBootstrap — `initializeFirebase(env) -> FirebaseServices`

Never throws. Exact order:

1. Resolve options: `env.isProd ? prod.DefaultFirebaseOptions.currentPlatform : dev.DefaultFirebaseOptions.currentPlatform`. The committed stub files are generated by `flutterfire configure --out=lib/core/firebase/firebase_options_{dev,prod}.dart`; until replaced each stub's getter throws `UnsupportedError('Firebase dev options not generated')` / `UnsupportedError('Firebase prod options not generated')`. Only `UnsupportedError` is caught here → options = null.
2. If options != null → `Firebase.initializeApp(options: options)`; else → `Firebase.initializeApp()` with no options (relies on native config files `android/app/google-services.json` (or `src/debug/`, `src/release/`) / iOS `GoogleService-Info.plist` in the Runner target).
3. ANY exception from step 2 → `debugPrint('Firebase not configured, continuing offline: $e')` and return `FirebaseServices.unavailable`. This is the "not configured" detection: there is no other probe.
4. App Check activation (only reached when Core initialised): `FirebaseAppCheck.instance.activate(providerAndroid: env.isProd ? AndroidPlayIntegrityProvider() : AndroidDebugProvider(), providerApple: env.isProd ? AppleAppAttestWithDeviceCheckFallbackProvider() : AppleDebugProvider())`. ANY exception → `debugPrint('App Check activation failed: $e')` and CONTINUE (services still returned as available).
5. Return `FirebaseServices(available: true, crash: CrashlyticsCrashReporter(), analytics: FirebaseAnalyticsService(), cloud: FirebaseCloudBackend())`.

Native/build-side facts that accompany this: `android/app/build.gradle.kts` applies the `com.google.gms.google-services` and `com.google.firebase.crashlytics` Gradle plugins ONLY if one of `google-services.json`, `src/debug/google-services.json`, `src/release/google-services.json` exists under `android/app/`. `.gitignore` excludes `google-services.json`, `GoogleService-Info.plist`, `/android/app/src/*/google-services.json`. AndroidManifest meta-data: `firebase_analytics_collection_enabled=false`, `google_analytics_adid_collection_enabled=false`, `google_analytics_default_allow_ad_personalization_signals=false`, `firebase_crashlytics_collection_enabled=false`; permissions `com.google.android.gms.permission.AD_ID` and `android.permission.ACCESS_ADSERVICES_AD_ID` removed via `tools:node="remove"`; Firebase Auth's `GenericIdpActivity` and `RecaptchaActivity` removed; `android:allowBackup="false"`. Final permission set is `CAMERA`, `INTERNET`, `ACCESS_NETWORK_STATE`, `WAKE_LOCK`.

# 3. `main()` wiring order (what consumes the bootstrap)

1. `WidgetsFlutterBinding.ensureInitialized()`.
2. `env = SilentSumEnv.current`.
3. `firebase = await initializeFirebase(env)` (debug marker `silentsum bootstrap: firebase`).
4. Load settings from `PrefsSettingsStore(SharedPreferencesAsync())` — SharedPreferences key `silentsum.settings.v1`, JSON value (see §12).
5. `await firebase.crash.setEnabled(settings.crashReportsEnabled)` (default true).
6. `await firebase.analytics.setEnabled(settings.analyticsEnabled)` (default false).
7. `FlutterError.onError = (details) { if (kDebugMode) FlutterError.presentError(details); firebase.crash.recordFlutterError(details); }` (fatal defaults to true).
8. `PlatformDispatcher.instance.onError = (error, stack) { firebase.crash.recordError(error, stack, fatal: true); return true; }`.
9. `runApp` with provider overrides: `firebaseServicesProvider` = result, `settingsStoreProvider`, `initialSettingsProvider`.

Tests override `firebaseServicesProvider` with `FirebaseServices.unavailable` (`test/support/test_app.dart`); Firebase is never initialised in tests.

# 4. `FirebaseServices` container

Fields: `available: bool`, `crash: CrashReporter`, `analytics: AnalyticsService`, `cloud: CloudBackend?` (nullable). Constant `FirebaseServices.unavailable = {available: false, crash: NoopCrashReporter(), analytics: NoopAnalyticsService(), cloud: null}`.

Derived providers (`lib/app/providers.dart`): `firebaseServicesProvider` (default `unavailable`), `crashReporterProvider = services.crash`, `analyticsProvider = services.analytics`, `cloudBackendProvider = services.cloud` (nullable), `backupServiceProvider` = null when cloud is null, else `BackupService(backend: cloud, kdf: Argon2idKeyDerivation() [isolate on], wrapping: KeyWrapping(), clock: SystemClock, random: SecureRandomSource(), kdfParams: KdfParams.backup)`.

UI gating on `available`: Settings tile subtitle (§13), Security screen toggle subtitles (§13), PIN-setup "Restore from cloud backup instead" button (shown only when `firebaseServices.available`), CloudBackupScreen/RestoreFlowScreen "not available" states (they check `backupService == null || cloudBackend == null`).

# 5. CrashReporter

## 5.1 Interface
- `setEnabled(bool)`.
- `recordError(Object error, StackTrace? stack, {String? reason, bool fatal = false})`.
- `recordFlutterError(FlutterErrorDetails details, {bool fatal = true})`.
- `log(String message)` (sync, fire-and-forget).
- static `scrub(String) -> String`.

## 5.2 `scrub` — applied in this exact order, each as replace-all
| # | Regex | Replacement | Intent |
|---|---|---|---|
| 1 | `(?<!\d)\d{4,8}(?!\d)` | `[redacted]` | runs of exactly 4–8 digits not adjacent to other digits (possible PINs). 1–3 digit runs and 9+ digit runs are left intact. |
| 2 | `[A-Za-z]:\\[^\s]+` | `[path]` | Windows absolute path up to whitespace |
| 3 | `/(?:data|private|var|storage|sdcard|tmp|Users|home)/[^\s'"]*` | `[path]` | POSIX paths under those roots, up to whitespace/quote |
| 4 | `/[^\s]*vault[^\s]*` | `[path]` | any slash-path containing `vault` |

Examples (from tests): `unlock failed for 123456` → `unlock failed for [redacted]`; `year 2026 ok` → `year [redacted] ok`; `id 123` → `id 123`; `C:\Users\x\vault\photos\a.enc failed` → `[path] failed`; `/data/user/0/app/vault/index.enc bad` → `[path] bad`; `read /data/user/0/app/cache/picker/IMG_holiday.jpg` → `read [path]`; `read /private/var/mobile/tmp/x.jpg` → `read [path]`.

## 5.3 `NoopCrashReporter`
`setEnabled` no-op. `recordError` → in debug builds only prints `[error] ${scrub(error.toString())}`. `recordFlutterError` → debug-only `FlutterError.presentError(details)`. `log` → debug-only prints `[log] ${scrub(message)}`. Release: silent.

## 5.4 `CrashlyticsCrashReporter`
- `setEnabled(e)` → `FirebaseCrashlytics.setCrashlyticsCollectionEnabled(e)`.
- `recordError(error, stack, reason, fatal)` → `crashlytics.recordError(scrub(error.toString()) /*a String, not the original object*/, stack, reason: reason == null ? null : scrub(reason), fatal: fatal)`.
- `recordFlutterError(details, fatal)` → constructs new details `{exception: scrub(details.exceptionAsString()) (String), stack: details.stack (unchanged), library: details.library (unchanged), context: details.context == null ? null : ErrorDescription(scrub(context.toDescription())), informationCollector: null}` then `crashlytics.recordFlutterError(scrubbed, fatal: fatal)`. Information collectors are dropped because widget trees can contain on-screen text.
- `log(message)` → `crashlytics.log(scrub(message))`.
- Never sets user identifiers or custom keys. Stack traces are NOT scrubbed.

# 6. AnalyticsService

## 6.1 Interface
`setEnabled(bool)`, `logEvent(String name, [Map<String, Object> parameters = {}])`.

## 6.2 `logEventSafely(analytics, name, [params])`
Free function: `unawaited(analytics.logEvent(name, params).catchError((_) {}))` — never awaited, never throws. All production call sites use this, never `logEvent` directly.

## 6.3 Event catalogue (`AnalyticsEvents`) — the ONLY events ever logged
| Constant | Event name | Parameters | Where |
|---|---|---|---|
| `vaultSetup` | `vault_setup_completed` | none | PIN setup (create) success |
| `vaultUnlock` | `vault_unlocked` | none | calculator unlock success |
| `photoAdded` | `vault_photo_added` | `{source: 'camera'}` or `{source: 'import'}` | camera screen / gallery import |
| `backupCompleted` | `vault_backup_completed` | `{count: report.total}` | CloudBackupScreen "Back up now" |
| `restoreCompleted` | `vault_restore_completed` | `{count: restored}` | RestoreFlowScreen done, CloudBackupScreen "Download missing photos" |

No user id, no user properties, no photo ids, no file names, no email.

## 6.4 Implementations
- `FirebaseAnalyticsService`: private `_enabled` = false initially. `setEnabled(e)`: set flag then `FirebaseAnalytics.setAnalyticsCollectionEnabled(e)`. `logEvent`: if `!_enabled` return immediately (no SDK call); else `analytics.logEvent(name:, parameters:)`.
- `NoopAnalyticsService`: both methods no-op.
- `RecordingAnalyticsService` (tests): `events: List<(String, Map<String,Object>)>`, `enabled = false`; `setEnabled` sets the flag; `logEvent` appends only when enabled.

Opt-in gating: manifest disables collection; `main()` applies `settings.analyticsEnabled` (default false) at startup; Security screen toggle updates the setting then calls `analytics.setEnabled(v)`.

# 7. CloudBackend interface and fakes

## 7.1 Types
- `CloudUser { uid: String, email: String? }`.
- `CloudException(code: String, [message: String?])`; `toString()` = `CloudException(<code>)` or `CloudException(<code>: <message>)`.

## 7.2 Methods (all async unless noted)
| Method | Semantics |
|---|---|
| `currentUser -> CloudUser?` (sync getter) | signed-in user or null |
| `authStateChanges() -> Stream<CloudUser?>` | emits on auth changes |
| `signIn({email, password}) -> CloudUser` | email/password sign-in |
| `signUp({email, password}) -> CloudUser` | create account and sign in |
| `signOut()` | |
| `deleteAccount()` | delete the auth user (see impl differences) |
| `putDocument(path, Map<String,Object?>)` | full replace of a document |
| `getDocument(path) -> Map?` | null when absent |
| `deleteDocument(path)` | |
| `putBlob(path, Uint8List)` | |
| `getBlob(path) -> Uint8List` | throws `object-not-found` when absent |
| `deleteBlob(path)` | absent → no error |
| `listBlobs(prefix) -> List<String>` | names (last path segment) of blobs DIRECTLY under prefix |

## 7.3 `FirebaseCloudBackend` (Auth + Firestore + Storage)
- Constructor takes optional `FirebaseAuth`, `FirebaseFirestore`, `FirebaseStorage` (defaults to `.instance`).
- `static const maxBlobBytes = 100 * 1024 * 1024` (104857600).
- `currentUser` → maps `User{uid,email}`; `authStateChanges` → `auth.authStateChanges().map(...)`.
- `signIn` → `signInWithEmailAndPassword`; `signUp` → `createUserWithEmailAndPassword`; `FirebaseAuthException` → `CloudException(e.code, e.message)`.
- `signOut` → `auth.signOut()`.
- `deleteAccount` → if no current user throw `CloudException('unauthenticated')`; `user.delete()`; auth exceptions mapped. NOTE: does NOT delete Firestore/Storage data (the in-memory fake does). No UI currently calls `deleteAccount`.
- `putDocument(path, data)` → `firestore.doc(path).set(data)` (non-merge overwrite).
- `getDocument(path)` → `(await firestore.doc(path).get()).data()` (null when missing).
- `deleteDocument(path)` → `.delete()`.
- `putBlob(path, bytes)` → `storage.ref(path).putData(bytes, SettableMetadata(contentType: 'application/octet-stream'))` — this content type is REQUIRED by storage rules.
- `getBlob(path)` → `storage.ref(path).getData(maxBlobBytes)`; null result → `CloudException('object-not-found')`.
- `deleteBlob(path)` → `ref.delete()`; swallow `FirebaseException` with code `object-not-found`; rethrow others.
- `listBlobs(prefix)` → `storage.ref(prefix).listAll()` → `result.items.map(name)` (prefixes/subfolders ignored).
- `_guard`: every Firestore/Storage call wrapped; `FirebaseException` → `CloudException(e.code, e.message)`. Non-Firebase exceptions propagate unchanged.

## 7.4 `InMemoryCloudBackend` (test double; mirrors the security rules' owner-only model)
- State: `documents: Map<String, Map>`, `blobs: Map<String, Uint8List>`, `_accounts: Map<email,password>`, `_user`.
- `signIn`: `_accounts[email] != password` → `CloudException('wrong-password')`.
- `signUp`: existing email → `CloudException('email-already-in-use')`; else store password.
- uid = `'uid_' + email.hashCode.toRadixString(16)` (Dart-specific; any deterministic per-email id is fine).
- `authStateChanges` yields the current user once (tests read `currentUser`).
- `signOut` → user null. `deleteAccount` → requires user (`unauthenticated`), removes all documents and blobs whose key starts with `users/{uid}/`, removes the account, signs out.
- `_authorize(path)`: no user → `CloudException('unauthenticated')`; path not starting with `users/{uid}/` → `CloudException('permission-denied')`. Applied to every document/blob op and to `listBlobs(prefix)`.
- `putDocument` stores a copy; `getDocument` returns a copy or null; `getBlob` missing → `object-not-found`; `deleteBlob`/`deleteDocument` missing → silent.
- `listBlobs(prefix)`: normalise to trailing `/`; return keys that start with it and whose remainder contains no `/`, stripped of the prefix.

# 8. Cryptographic primitives the backup relies on (exact parameters)

## 8.1 `KdfParams` (Argon2id)
Fields `memoryKiB`, `iterations`, `parallelism`, `hashLength` (default 32).
| Preset | m (KiB) | t | p | len | Use |
|---|---|---|---|---|---|
| `defaults` | 32768 (32 MiB) | 3 | 1 | 32 | local PIN wrap |
| `backup` | 65536 (64 MiB) | 3 | 1 | 32 | recovery passphrase → backup KEK |
| `forTests` | 256 | 1 | 1 | 32 | tests only |

JSON (`toJson`): `{"alg":"argon2id","m":<int>,"t":<int>,"p":<int>,"len":<int>}`.
`fromJson` validation (untrusted input, e.g. downloaded envelope): `alg` must equal `argon2id` else `FormatException('Unsupported KDF <alg>')`; `p` in [1, 4] (`maxParallelism = 4`); `m` in [8*p, 262144] (`maxMemoryKiB = 256*1024`); `t` in [1, 10] (`maxIterations = 10`); `len` missing → 32, must be 32. Violations → `FormatException`.
Derivation: RFC 9106 Argon2id with `parallelism=p`, `memory=m KiB`, `iterations=t`, `hashLength=len`, secret = passphrase bytes, salt ("nonce") = the 16-byte salt; no secret key K, no associated data X. Runs in a background isolate in production (`useIsolate: true`), inline in tests.

## 8.2 `KeyWrapping` / `WrappedKey` (XChaCha20-Poly1305 IETF AEAD)
- `WrappedKey{nonce (24 bytes), cipherText, mac (16 bytes)}`; JSON `{"nonce": base64, "ct": base64, "mac": base64}`. `fromJson`: nonce length must be 24 (`bad nonce length`), mac 16 (`bad mac length`), ct non-empty and ≤ 1024 bytes (`bad ciphertext length`), else `FormatException`.
- AAD strings: `vaultAad = 'silentsum/vmk/v1'` (local PIN wrap), `backupAad = 'silentsum/backup-envelope/v1'` (cloud envelope). AAD bytes = UTF-8 of the string.
- `wrap(key, kek, aad)`: random 24-byte nonce, standard `crypto_aead_xchacha20poly1305_ietf` (detached MAC). `unwrap`: authentication failure → `WrongKeyException()` (no detail).
- Master key is 32 bytes, so envelope `ct` is 32 bytes (44 base64 chars).

## 8.3 `VaultKeys` (what the master key unlocks)
`VaultKeys.derive(master32)`: HKDF-SHA256 (outputLength 32, no salt) with info `silentsum/photo/v1` (key id code 1), `silentsum/thumb/v1` (code 2), `silentsum/index/v1` (code 3 — enum `VaultKeyId.manifest`). Copies master before deriving; `dispose()` zeroes all four buffers. Throws `ArgumentError` if master is not 32 bytes.

## 8.4 `FileCipher` blob container (what is uploaded verbatim)
`"SSV1"(4) | version 0x01 (1) | keyId (1) | nonce (24) | ciphertext | Poly1305 tag (16)`; the 6-byte header is the AAD. `looksEncrypted(bytes)`: length ≥ 46 and magic `53 53 56 31` and byte[4] == 1. `decrypt(blob, key, id)` checks header key id equals expected else `FileCipherFormatException`; auth failure → `WrongKeyException`.

## 8.5 Helpers
`zeroBytes(list)` overwrites with 0. `constantTimeEquals(a,b)`: false on length mismatch, else OR-accumulated XOR. `SecureRandomSource.bytes(n)` from OS CSPRNG. `Clock.now()` wall clock; `FakeClock` default start `2026-01-01T12:00` local, `advance(d)`.

# 9. `BackupEnvelope`

Fields: `version` (default 1), `salt: Uint8List` (16 random bytes when created), `kdf: KdfParams`, `wrappedMasterKey: WrappedKey`, `createdAt: DateTime`.

`toJson()` (this exact shape is what Firestore rules validate):
```
{
  "v": 1,
  "salt": "<base64 of 16 bytes → 24 chars>",
  "kdf": {"alg":"argon2id","m":65536,"t":3,"p":1,"len":32},
  "wrapped": {"nonce":"<base64 24 bytes → 32 chars>","ct":"<base64 32 bytes → 44 chars>","mac":"<base64 16 bytes → 24 chars>"},
  "createdAt": "<UTC ISO-8601, e.g. 2026-01-01T12:00:00.000Z>"
}
```
Base64 is standard (with `=` padding), not URL-safe. `createdAt` = `clock.now().toUtc().toIso8601String()`.

`fromJson`: `v` missing → 1; `v != 1` → `FormatException('Unsupported envelope v<v>')`; decode salt; salt length must be in [8, 64] bytes else `FormatException('bad salt length')`; `kdf` via `KdfParams.fromJson` (§8.1); `wrapped` via `WrappedKey.fromJson` (§8.2); `createdAt` via `DateTime.parse`. Missing/mistyped fields throw (cast errors) — callers treat any throw as a failed restore.

# 10. `BackupService`

## 10.1 Construction
`BackupService({backend, kdf, wrapping, clock, random = SecureRandomSource(), kdfParams = KdfParams.backup})`.

## 10.2 Remote paths (uid = Firebase Auth uid of the signed-in user)
| Helper | Path | Store |
|---|---|---|
| `envelopePath(uid)` | `users/<uid>/vault/envelope` | Firestore document |
| `manifestPath(uid)` | `users/<uid>/vault/manifest` | Firestore document |
| `indexPath(uid)` | `users/<uid>/index.enc` | Storage object |
| `photoPath(uid,id)` | `users/<uid>/photos/<id>.enc` | Storage object |
| `thumbPath(uid,id)` | `users/<uid>/thumbs/<id>.enc` | Storage object |
Photo ids are 32-char lower-case hex (16 random bytes) generated by the vault.

## 10.3 `PassphrasePolicy`
`minLength = 12`. `validate(p)`: if `p.length < 12` → `'Use at least 12 characters.'`; else if `p.trim() != p` → `'Remove leading or trailing spaces.'`; else null. Length is UTF-16 code units (same as JS `.length`). No other rules (no character-class requirements). Interior spaces are allowed. Passphrase is used byte-for-byte (UTF-8), never trimmed or normalised.

## 10.4 Error types
- `BackupNotEnabledException` — no envelope document for this uid.
- `WrongPassphraseException` — envelope unwrap failed authentication.
- `CloudException('unauthenticated')` — `_requireUser()` when `backend.currentUser == null`.
- `ArgumentError(<policy message>)` — `enable` with a passphrase that fails `PassphrasePolicy`.
- `FormatException` — malformed envelope (from `BackupEnvelope.fromJson`).
- `CloudException(<firebase code>)` — any backend failure.
- `WrongKeyException` / `FileCipherFormatException` — index or blob does not authenticate under the session keys during restore (propagates out of `restoreInto`).

## 10.5 `hasEnvelope() -> bool`
1. `_requireUser()`. 2. `getDocument(envelopePath(uid)) != null`.

## 10.6 `enable({keys: VaultKeys, passphrase}) -> void` (creates or REPLACES the envelope)
1. `PassphrasePolicy.validate(passphrase)`; non-null → throw `ArgumentError(problem)` (happens BEFORE the sign-in check).
2. `user = _requireUser()`.
3. `salt = random.bytes(16)`.
4. `kek = _deriveKek(passphrase, salt, kdfParams)` — `secret = utf8(passphrase)`; `kdf.deriveKey(secret, salt, params)`; secret zeroed in `finally`.
5. `wrapped = wrapping.wrap(keys.masterKey, kek, aad: 'silentsum/backup-envelope/v1')`.
6. `envelope = BackupEnvelope(salt, kdf: kdfParams, wrappedMasterKey: wrapped, createdAt: clock.now().toUtc())`.
7. `putDocument(envelopePath(uid), envelope.toJson())`.
8. `finally zeroBytes(kek)`.
Does not touch the manifest or any blob. Re-enabling with a new passphrase simply overwrites the envelope; existing blobs remain valid because the master key is unchanged.

## 10.7 `backupNow(repository) -> BackupReport{uploaded, removed, total}`
1. `user = _requireUser()`.
2. `if (!await hasEnvelope()) throw BackupNotEnabledException()`.
3. `manifest = getDocument(manifestPath(uid))`; `uploadedIds = Set<String>(manifest?['photoIds'] as List ?? [])`.
4. `localIds = repository.photos.map(id).toSet()` (repository snapshot, newest first).
5. For each `id` in `localIds` not in `uploadedIds`: `putBlob(photoPath(uid,id), await repository.readEncryptedPhoto(id))` (raw bytes of `photos/<id>.enc` from disk), then `putBlob(thumbPath(uid,id), await repository.readEncryptedThumbnail(id))`; add id to `uploadedIds`; `uploaded++`.
6. For each `id` in a snapshot of `uploadedIds` not in `localIds`: `deleteBlob(photoPath)`, `deleteBlob(thumbPath)`; remove id; `removed++`.
7. `index = await repository.readEncryptedIndex()` (raw bytes of `index.enc`, or null if the file does not exist): non-null → `putBlob(indexPath(uid), index)`; null → `deleteBlob(indexPath(uid))`.
8. `putDocument(manifestPath(uid), {'photoIds': uploadedIds.toList(), 'photoCount': uploadedIds.length, 'updatedAt': clock.now().toUtc().toIso8601String()})` (full overwrite).
9. Return `BackupReport(uploaded, removed, total: uploadedIds.length)`.
Notes: sequential, not transactional; a failure before step 8 leaves the manifest stale so the next run re-uploads the same ids (uploads are idempotent overwrites). Blobs are never inspected or re-encrypted; whatever is on disk is uploaded byte-for-byte. Blobs already in the manifest are never re-uploaded even if the local file changed (photos are immutable in this app).

## 10.8 `recoverMasterKey(passphrase) -> Uint8List(32)`
1. `user = _requireUser()`.
2. `doc = getDocument(envelopePath(uid))`; null → `BackupNotEnabledException`.
3. `envelope = BackupEnvelope.fromJson(doc)` (bounded KDF params enforced here).
4. `kek = _deriveKek(passphrase, envelope.salt, envelope.kdf)` — parameters come FROM THE ENVELOPE, not from the service defaults.
5. `wrapping.unwrap(envelope.wrappedMasterKey, kek, aad: backupAad)`; `WrongKeyException` → `WrongPassphraseException`.
6. `finally zeroBytes(kek)`.
7. Return the master key; caller MUST zero it when done. No passphrase policy check on this path.

## 10.9 `restoreInto(repository, keys) -> RestoreReport{restored, skipped}`
Repository must already be open with `VaultKeys` derived from the recovered master key.
1. `user = _requireUser()`.
2. `indexBlob = getBlob(indexPath(uid))`; `CloudException('object-not-found')` → return `RestoreReport(0, 0)`; other errors rethrow.
3. `json = FileCipher().decrypt(indexBlob, keys.keyFor(VaultKeyId.manifest), VaultKeyId.manifest)`; `index = VaultIndex.decode(utf8.decode(json))` — index JSON is `{"version":1,"photos":[PhotoEntry...]}` with PhotoEntry `{id, createdAt (UTC ISO), width, height, sizeBytes, source ('camera'|'import'|'restore'), mimeType (default 'image/jpeg'), originalName?}`; version != 1 → `FormatException('Unsupported index version <n>')`.
4. `existing = repository.photos ids`.
5. For each `entry` in `index.photos.reversed` (oldest first): if `existing` contains id → `skipped++`, continue. Else `photoBlob = getBlob(photoPath)`, `thumbBlob = getBlob(thumbPath)`, `repository.importEncrypted(entry, photoBlob, thumbnailBlob)`, `restored++`. `CloudException('object-not-found')` for either blob → `skipped++`, continue; other `CloudException` rethrow. `WrongKeyException` / `FileCipherFormatException` from `importEncrypted` propagate (abort).
6. Return the report.
`importEncrypted` (repository side): decrypts the thumbnail with the thumb key and the photo with the photo key purely to authenticate (plaintexts zeroed and discarded), then atomically writes both blobs to `photos/<id>.enc` / `thumbs/<id>.enc`, replaces any same-id entry, appends `entry.copyWith(source: PhotoSource.restore)`, sorts by `createdAt` descending, and commits the encrypted index.

## 10.10 `disable() -> void`
1. `user = _requireUser()`.
2. For prefix in [`users/<uid>/photos`, `users/<uid>/thumbs`]: for each `name` in `listBlobs(prefix)` → `deleteBlob('<prefix>/<name>')`.
3. `deleteBlob(indexPath(uid))`.
4. `deleteDocument(manifestPath(uid))`.
5. `deleteDocument(envelopePath(uid))`.
Does not sign out and does not delete the auth account.

## 10.11 `_deriveKek(passphrase, salt, params)`
`secret = Uint8List(utf8.encode(passphrase))`; `kdf.deriveKey(secret:, salt:, params:)`; `finally zeroBytes(secret)`.

# 11. `describeCloudError(Object) -> String` (cloud_errors.dart)

| Input | Copy |
|---|---|
| `CloudException` code `wrong-password`, `invalid-credential`, `user-not-found`, `INVALID_LOGIN_CREDENTIALS` | `Wrong email or password.` |
| `email-already-in-use` | `An account with this email already exists. Sign in instead.` |
| `weak-password` | `Choose a longer password.` |
| `invalid-email` | `That email address is not valid.` |
| `network-request-failed` | `No network connection.` |
| `unauthenticated` | `Sign in first.` |
| `permission-denied` | `Permission denied by the server rules.` |
| `too-many-requests` | `Too many attempts. Try again later.` |
| `object-not-found` | `That backup file no longer exists.` |
| any other `CloudException` | `Cloud error: <code>` (message is NEVER shown) |
| `WrongPassphraseException` | `Wrong recovery passphrase.` |
| `BackupNotEnabledException` | `Backup is not enabled for this account.` |
| `ArgumentError` | `error.message?.toString() ?? 'Invalid input.'` (i.e. the PassphrasePolicy text) |
| anything else (incl. `VaultLockedException`, `WrongKeyException`, `FormatException`, `StateError`) | `Something went wrong.` |

# 12. Settings model touched by this subsystem (`AppSettings`, persisted as JSON under SharedPreferences key `silentsum.settings.v1`)

| JSON key | Type | Default | Set by backup subsystem |
|---|---|---|---|
| `analyticsEnabled` | bool | false | Security screen toggle |
| `crashReportsEnabled` | bool | true | Security screen toggle |
| `onboardingDone` | bool | false | RestoreFlowScreen success → true |
| `backupEnabled` | bool | false | enable → true; backupNow → true; restore success → true; disable → false; vault erase → false |
| `lastBackupAt` | UTC ISO string or null | null | backupNow → `clock.now()`; disable/erase → cleared (`clearLastBackup: true`) |
Unparseable `lastBackupAt` → null. `copyWith(clearLastBackup: true)` forces null.

# 13. Firebase security rules (exact constraints)

## 13.1 `firebase/firestore.rules` (rules_version '2')
- `isOwner(uid)`: `request.auth != null && request.auth.uid == uid`.
- `validEnvelope(d)`: `d.keys().hasOnly(['v','salt','kdf','wrapped','createdAt'])` AND `d.v == 1` AND `d.salt is string && d.salt.size() <= 64` AND `d.kdf is map && d.kdf.keys().hasOnly(['alg','m','t','p','len'])` AND `d.kdf.alg == 'argon2id'` AND `d.kdf.m is int && 8192 <= m <= 262144` AND `d.kdf.t is int && 1 <= t <= 10` AND `d.kdf.p is int && 1 <= p <= 4` AND `d.kdf.len == 32` AND `d.wrapped is map` AND `d.wrapped.nonce is string && size() <= 64` AND `d.wrapped.ct is string && size() <= 256` AND `d.wrapped.mac is string && size() <= 64` AND `d.createdAt is string`.
- `validManifest(d)`: `d.keys().hasOnly(['photoIds','photoCount','updatedAt'])` AND `d.photoIds is list && size() <= 20000` AND `d.photoCount is int && d.photoCount == d.photoIds.size()` AND `d.updatedAt is string`.
- `match /users/{uid}/vault/envelope`: `read, delete` if owner; `create, update` if owner AND `validEnvelope(request.resource.data)`.
- `match /users/{uid}/vault/manifest`: `read, delete` if owner; `create, update` if owner AND `validManifest(request.resource.data)`.
- `match /{document=**}`: `read, write: if false`.
Implication: numeric fields must be written as integers (JS SDK stores integer-valued numbers as int64 — do not write floats). Minimum accepted `m` on write is 8192 KiB, stricter than the client's `8*p` floor; `KdfParams.forTests` (256) would be rejected by rules. `firestore.indexes.json` is empty (`{"indexes":[],"fieldOverrides":[]}`).

## 13.2 `firebase/storage.rules` (rules_version '2')
- `match /users/{uid}/{allPaths=**}`: `read, delete` if `request.auth != null && request.auth.uid == uid`; `write` if same owner check AND `request.resource.size < 100 * 1024 * 1024` AND `request.resource.contentType == 'application/octet-stream'`.
- `match /{allPaths=**}`: `read, write: if false`.

## 13.3 `firebase/firebase.json`
`firestore.rules = firestore.rules`, `firestore.indexes = firestore.indexes.json`, `storage.rules = storage.rules`; emulators: auth 9099, firestore 8080, storage 9199, ui enabled. Deploy with `firebase deploy --only firestore:rules,storage` per project (dev and prod are separate Firebase projects). App Check is expected to be enforced for Firestore and Storage in the console once tokens verify.

# 14. Local restore prerequisites (`PinAuthService.adoptMasterKey(master, pin, {overwrite=false})`)
Validates PIN (`PinPolicy`: digits only, 4–8 long, no leading 0; errors: `Use at least 4 digits.`, `Use at most 8 digits.`, `Use digits only.`, `The PIN cannot start with 0, because the calculator drops leading zeros.`) → `InvalidPinException`; if credentials already exist and `!overwrite` → `StateError('A vault PIN already exists')`; wraps the given master under Argon2id(PIN, new 16-byte salt, `KdfParams.defaults` 32 MiB/3/1) with AAD `silentsum/vmk/v1`, stores `VaultCredentials{salt, kdf, wrappedMasterKey, pinLength, createdAt}` in the secure store, resets the attempt throttle, returns `VaultKeys.derive(master)`. This is how restore "produces a new local PIN wrap": the SAME master key is re-wrapped under the new device PIN; files are not re-encrypted.

## Public API

// ---- core/environment
enum SilentSumEnv { dev, prod; static SilentSumEnv get current; bool get isProd; }

// ---- core/firebase/firebase_bootstrap
Future<FirebaseServices> initializeFirebase(SilentSumEnv env); // never throws

// ---- core/firebase/firebase_services
class FirebaseServices {
  const FirebaseServices({required bool available, required CrashReporter crash, required AnalyticsService analytics, CloudBackend? cloud});
  static const FirebaseServices unavailable; // available=false, Noop crash/analytics, cloud=null
  final bool available; final CrashReporter crash; final AnalyticsService analytics; final CloudBackend? cloud;
}

// ---- core/firebase/crash_reporter
abstract class CrashReporter {
  Future<void> setEnabled(bool enabled);
  Future<void> recordError(Object error, StackTrace? stack, {String? reason, bool fatal = false});
  Future<void> recordFlutterError(FlutterErrorDetails details, {bool fatal = true});
  void log(String message);
  static String scrub(String input); // 4 regex passes, see spec §5.2
}
class NoopCrashReporter implements CrashReporter { const NoopCrashReporter(); }
class CrashlyticsCrashReporter implements CrashReporter { CrashlyticsCrashReporter([FirebaseCrashlytics? crashlytics]); }

// ---- core/firebase/analytics_service
void logEventSafely(AnalyticsService analytics, String name, [Map<String, Object> parameters = const {}]); // unawaited, errors swallowed
abstract class AnalyticsService {
  Future<void> setEnabled(bool enabled);
  Future<void> logEvent(String name, [Map<String, Object> parameters = const {}]);
}
class AnalyticsEvents {
  static const vaultSetup = 'vault_setup_completed';
  static const vaultUnlock = 'vault_unlocked';
  static const photoAdded = 'vault_photo_added';
  static const backupCompleted = 'vault_backup_completed';
  static const restoreCompleted = 'vault_restore_completed';
}
class NoopAnalyticsService implements AnalyticsService { const NoopAnalyticsService(); }
class RecordingAnalyticsService implements AnalyticsService { final List<(String, Map<String, Object>)> events; bool enabled = false; }
class FirebaseAnalyticsService implements AnalyticsService { FirebaseAnalyticsService([FirebaseAnalytics? analytics]); } // logEvent no-op until setEnabled(true)

// ---- core/firebase/cloud_backend
class CloudUser { const CloudUser({required String uid, String? email}); }
class CloudException implements Exception { const CloudException(String code, [String? message]); final String code; final String? message; }
abstract class CloudBackend {
  CloudUser? get currentUser;
  Stream<CloudUser?> authStateChanges();
  Future<CloudUser> signIn({required String email, required String password});
  Future<CloudUser> signUp({required String email, required String password});
  Future<void> signOut();
  Future<void> deleteAccount();
  Future<void> putDocument(String path, Map<String, Object?> data);
  Future<Map<String, Object?>?> getDocument(String path);
  Future<void> deleteDocument(String path);
  Future<void> putBlob(String path, Uint8List bytes);
  Future<Uint8List> getBlob(String path);           // throws CloudException('object-not-found')
  Future<void> deleteBlob(String path);              // missing → ok
  Future<List<String>> listBlobs(String prefix);     // last path segments directly under prefix
}
class InMemoryCloudBackend implements CloudBackend { final Map<String, Map<String, Object?>> documents; final Map<String, Uint8List> blobs; }
class FirebaseCloudBackend implements CloudBackend {
  FirebaseCloudBackend({FirebaseAuth? auth, FirebaseFirestore? firestore, FirebaseStorage? storage});
  static const int maxBlobBytes = 100 * 1024 * 1024;
}

// ---- core/security (consumed by backup)
class KdfParams { const KdfParams({required int memoryKiB, required int iterations, required int parallelism, int hashLength = 32});
  static const defaults /*32768,3,1*/, backup /*65536,3,1*/, forTests /*256,1,1*/;
  static const int maxMemoryKiB = 262144, maxIterations = 10, maxParallelism = 4;
  Map<String, Object?> toJson(); factory KdfParams.fromJson(Map); }
abstract class KeyDerivation { Future<Uint8List> deriveKey({required Uint8List secret, required Uint8List salt, required KdfParams params}); }
class Argon2idKeyDerivation implements KeyDerivation { const Argon2idKeyDerivation({bool useIsolate = true}); }
class WrongKeyException implements Exception {}
class WrappedKey { Uint8List nonce, cipherText, mac; Map toJson(); factory fromJson(Map); static const nonceLength = 24, macLength = 16, maxCipherTextLength = 1024; }
class KeyWrapping { static const vaultAad = 'silentsum/vmk/v1'; static const backupAad = 'silentsum/backup-envelope/v1';
  Future<WrappedKey> wrap(List<int> key, List<int> kek, {String aad = vaultAad});
  Future<Uint8List> unwrap(WrappedKey wrapped, List<int> kek, {String aad = vaultAad}); }
class VaultKeys { static Future<VaultKeys> derive(Uint8List masterKey32); Uint8List get masterKey; Uint8List keyFor(VaultKeyId id); void dispose(); bool get isDisposed; }
enum VaultKeyId { photo(1,'silentsum/photo/v1'), thumb(2,'silentsum/thumb/v1'), manifest(3,'silentsum/index/v1') }
class FileCipher { Future<Uint8List> encrypt(Uint8List plain, Uint8List key, VaultKeyId id); Future<Uint8List> decrypt(Uint8List blob, Uint8List key, VaultKeyId id); static bool looksEncrypted(List<int> bytes); }
void zeroBytes(List<int>); bool constantTimeEquals(List<int> a, List<int> b);
class SecureRandomSource { Uint8List bytes(int length); String hexId([int byteLength = 16]); }
abstract class Clock { DateTime now(); Duration monotonic(); } class SystemClock; class FakeClock { void advance(Duration); void setNow(DateTime); }

// ---- features/vault (backup-facing subset of VaultRepository)
abstract class VaultRepository {
  List<PhotoEntry> get photos;                       // newest first
  Future<Uint8List> readEncryptedPhoto(String id);   // raw photos/<id>.enc
  Future<Uint8List> readEncryptedThumbnail(String id);
  Future<Uint8List?> readEncryptedIndex();           // raw index.enc or null
  Future<void> importEncrypted({required PhotoEntry entry, required Uint8List photoBlob, required Uint8List thumbnailBlob}); // authenticates, overwrites same id, source=restore
}
class VaultIndex { static VaultIndex decode(String raw); List<PhotoEntry> photos; int version; }
class PhotoEntry { String id; DateTime createdAt; int width, height, sizeBytes; PhotoSource source; String mimeType; String? originalName; toJson/fromJson; copyWith({PhotoSource? source}); }
enum PhotoSource { camera, import, restore }

// ---- features/backup/backup_envelope
class BackupEnvelope {
  const BackupEnvelope({int version = 1, required Uint8List salt, required KdfParams kdf, required WrappedKey wrappedMasterKey, required DateTime createdAt});
  Map<String, Object?> toJson();                     // {v, salt, kdf, wrapped, createdAt}
  factory BackupEnvelope.fromJson(Map<String, Object?> json); // FormatException on bad shape
}

// ---- features/backup/backup_service
class BackupReport { final int uploaded, removed, total; }
class RestoreReport { final int restored, skipped; }
class BackupNotEnabledException implements Exception {}
class WrongPassphraseException implements Exception {}
class PassphrasePolicy { static const int minLength = 12; static String? validate(String passphrase); }
class BackupService {
  BackupService({required CloudBackend backend, required KeyDerivation kdf, required KeyWrapping wrapping, required Clock clock, SecureRandomSource? random, KdfParams kdfParams = KdfParams.backup});
  static String envelopePath(String uid) => 'users/$uid/vault/envelope';
  static String manifestPath(String uid) => 'users/$uid/vault/manifest';
  static String indexPath(String uid) => 'users/$uid/index.enc';
  static String photoPath(String uid, String id) => 'users/$uid/photos/$id.enc';
  static String thumbPath(String uid, String id) => 'users/$uid/thumbs/$id.enc';
  Future<bool> hasEnvelope();
  Future<void> enable({required VaultKeys keys, required String passphrase});
  Future<BackupReport> backupNow(VaultRepository repository);
  Future<Uint8List> recoverMasterKey(String passphrase);   // caller zeroes the result
  Future<RestoreReport> restoreInto(VaultRepository repository, VaultKeys keys);
  Future<void> disable();
}

// ---- features/backup/cloud_errors
String describeCloudError(Object error);

// ---- features/backup/passphrase_dialog
Future<String?> showPassphraseDialog(BuildContext context, {required bool confirm, String title = 'Recovery passphrase'}); // null on cancel

// ---- features/backup/restore_flow_screen
class RestoreFlowScreen extends ConsumerStatefulWidget {}   // route '/setup/restore'

// ---- features/settings/cloud_backup_screen
class CloudBackupScreen extends ConsumerStatefulWidget {}   // route '/settings/backup' (protected)

// ---- app/providers (relevant)
firebaseServicesProvider: FirebaseServices (default unavailable)
crashReporterProvider: CrashReporter; analyticsProvider: AnalyticsService; cloudBackendProvider: CloudBackend?; backupServiceProvider: BackupService?
settingsProvider (AppSettings notifier with update(fn)); vaultSessionProvider (adopt(keys)/lock()/state.requireKeys()); vaultRepositoryProvider (FutureProvider<VaultRepository?>, autoDispose); vaultStatusProvider (configured, refresh()); pinAuthServiceProvider (adoptMasterKey)

// ---- features/authentication (used by restore)
Future<VaultKeys> PinAuthService.adoptMasterKey(Uint8List master, String pin, {bool overwrite = false}); // StateError if a vault exists and !overwrite
class PinPolicy { static const minLength = 4, maxLength = 8; static PinValidationError? validate(String); static String describe(PinValidationError); }

// ---- app/router
AppRoutes.setup = '/setup'; AppRoutes.restore = '/setup/restore'; AppRoutes.vault = '/vault'; AppRoutes.settings = '/settings'; AppRoutes.backup = '/settings/backup'; AppRoutes.security = '/settings/security'

## Tests

## test/features/backup/backup_service_test.dart (9 tests)

Fixture: temp dir per test; `InMemoryCloudBackend`; `FakeClock` (2026-01-01 12:00); `keys = VaultKeys.derive(random 32 bytes)`; `BackupService(backend: cloud, kdf: Argon2idKeyDerivation(useIsolate: false), wrapping: KeyWrapping(), clock, kdfParams: KdfParams.forTests /*256 KiB,1,1*/)`; `cloud.signUp(email: 'a@example.com', password: 'pw-pw-pw')`; `passphrase = 'correct horse battery staple'`; `jpeg = 80x60 solid RGB(20,120,220) JPEG quality 85`. `openRepo(name, keys)` builds an `EncryptedVaultRepository` under `<tmp>/<name>` with `FileCipher()`, `DartThumbnailGenerator(useIsolate:false)`, `SecureDelete()`, the fake clock, and opens it. Helper `containsSequence(haystack, needle)` = naive byte-subsequence search.

1. `requires a signed-in account` — after `cloud.signOut()`, `service.enable(keys, passphrase)` throws `CloudException` (code `unauthenticated`).
2. `enable stores an envelope that contains neither passphrase nor master key` — after `enable`, exactly one document exists; `jsonEncode(doc)` does not contain the passphrase string and does not contain `base64Encode(keys.masterKey)`; `doc['kdf']` contains pair `alg` → `argon2id`.
3. `recoverMasterKey needs the right passphrase` — after `enable`, `recoverMasterKey(passphrase)` equals `keys.masterKey`; `recoverMasterKey('wrong passphrase!!')` throws `WrongPassphraseException`.
4. `weak passphrases are rejected` — `enable(passphrase: 'short')` throws `ArgumentError`; `PassphrasePolicy.validate(' padded passphrase ')` is non-null.
5. `backupNow refuses without an envelope` — with an open repo but no envelope, `backupNow(repo)` throws `BackupNotEnabledException`.
6. `backupNow uploads only ciphertext and mirrors deletions` — enable; add two photos a, b (source camera); first `backupNow` → `uploaded == 2`, `total == 2`; EVERY blob in `cloud.blobs` satisfies `FileCipher.looksEncrypted` and does NOT contain the JPEG SOI marker bytes `FF D8 FF`; `cloud.blobs.keys` contains `photoPath(uid, a.id)`, `thumbPath(uid, b.id)`, `indexPath(uid)`; second `backupNow` → `uploaded == 0`; `repo.deletePhotos([a.id])` then third `backupNow` → `removed == 1`, `total == 1`, and `photoPath(uid, a.id)` is no longer in `cloud.blobs`.
7. `restore on a fresh device reproduces the photos` — enable; source repo adds `a` (camera), clock +1 min, adds `b` (30x30 JPEG, source import); `backupNow(source)`; `master = recoverMasterKey(passphrase)`; `restoredKeys = VaultKeys.derive(master)`; target repo opened with restoredKeys; `restoreInto(target, restoredKeys)` → `restored == 2`; `target.photos ids == [b.id, a.id]` (newest first); `target.readFullImage(a.id) == jpeg` (byte-identical); second `restoreInto` → `restored == 0`, `skipped == 2`.
8. `disable removes everything for the account` — enable, add photo, backupNow, `disable()` → `cloud.blobs` empty, `cloud.documents` empty, `hasEnvelope() == false`.
9. `another user cannot read the data (backend enforces ownership)` — enable as user A; sign out; sign up `b@example.com`; `cloud.getDocument(envelopePath(uidA))` throws `CloudException` (`permission-denied`).

## test/features/lifecycle/auto_lock_policy_test.dart (1 relevant test)
- `crash reporter scrubbing removes PIN-like digit runs and paths` — the seven exact input/output pairs listed in spec §5.2.

## test/core/security/key_derivation_test.dart (2 relevant)
- `params round-trip through json and reject unknown algorithms` — `KdfParams.fromJson(KdfParams.backup.toJson()) == KdfParams.backup` (and same for defaults/forTests); `{'alg':'md5'}` → FormatException; `defaults.memoryKiB == 32*1024`; `backup.memoryKiB > defaults.memoryKiB`.
- `params from untrusted records are bounded` — with base `{alg:argon2id, m:32768, t:3, p:1, len:32}`: m = 1 GiB → FormatException; t = 100 → FormatException; p = 64 → FormatException; len = 16 → FormatException; m = 4 with p = 1 → FormatException; m = 262144 accepted.

## test/core/security/key_wrapping_test.dart (2 relevant)
- `tampered ciphertext or wrong aad fails authentication` — flipping bit 0 of ct → `WrongKeyException`; unwrapping a vault-AAD wrap with `aad: KeyWrapping.backupAad` → `WrongKeyException` (AAD domain separation between local and cloud wraps).
- `json round trip` — `WrappedKey.fromJson(wrapped.toJson())` unwraps to the original key.

## test/core/storage/settings_store_test.dart (2 relevant)
- defaults test: `backupEnabled == false`, `crashReportsEnabled == true`, `analyticsEnabled` default false.
- `json round trip and unknown timeout falls back` — settings with `analyticsEnabled: true`, `onboardingDone: true`, `lastBackupAt: DateTime.utc(2026,2,3,4,5)` round-trip through JSON equal.

## test/features/authentication/pin_auth_service_test.dart (2 relevant)
- `adoptMasterKey (cloud restore) wraps a given key under a new PIN` — setup PIN `2468` on store 1; fresh service on an empty store adopts `original.masterKey` with PIN `7531`; `adopted.masterKey == original.masterKey`; `unlock('7531')` yields keys with the same master.
- `adoptMasterKey refuses to replace an existing vault unless told to` — with a configured vault, `adoptMasterKey(master, '1357')` throws `StateError`; with `overwrite: true` it succeeds and `unlock('1357')` is `UnlockSuccess`.

## test/features/vault/encrypted_vault_repository_test.dart (2 relevant)
- `restored blobs are authenticated before being accepted` — flip the last byte of an exported photo blob; `importEncrypted` on a second repo with the same master throws `WrongKeyException`.
- `encrypted export/import round-trip for backup` — `readEncryptedPhoto/Thumbnail` and `readEncryptedIndex()` non-null; target repo (new root, keys derived from same master) `importEncrypted(entry, photoBlob, thumbBlob)` → single photo with `entry.id`, `source == PhotoSource.restore`, `readFullImage == smallJpeg`.

## test/support/test_app.dart
Widget-test harness overrides `firebaseServicesProvider` with `FirebaseServices.unavailable`; no test ever initialises Firebase. There are no widget tests for `CloudBackupScreen`, `RestoreFlowScreen` or `PassphraseDialog` in the reference.

## UI flows

All copy is exact. Buttons listed as `Label (widget kind)`.

## A. Settings entry points
- Settings screen (`/settings`, requires unlocked vault): section header `Cloud`; ListTile icon cloud_outlined, title `Cloud backup`, subtitle = `Not available in this build` when `!firebase.available`; else `On — end-to-end encrypted` when `settings.backupEnabled`; else `Off — photos stay on this device`. Tap → push `/settings/backup`.
- Security & privacy screen (`/settings/security`), header `Diagnostics`: SwitchListTile `Send crash reports`, subtitle `Anonymous crash reports via Firebase Crashlytics. They never include your PIN, photos or file names.` (or `Inactive in this build (no Firebase configuration).` when unavailable); value `crashReportsEnabled`; on change: save setting then `crashReporter.setEnabled(v)`. SwitchListTile `Share usage statistics`, subtitle `Off by default. Only coarse events such as "vault unlocked"; never content, never the advertising ID.` (or the same inactive text); value `analyticsEnabled`; on change: save setting then `analytics.setEnabled(v)`. Toggles remain interactive even when Firebase is unavailable (they drive no-ops).
- PIN setup screen (create mode, "enter" step) shows `Restore from cloud backup instead` (TextButton) ONLY when `firebaseServices.available`; tap → push `/setup/restore`.
- Forgot-PIN dialog adds paragraph `You enabled cloud backup: after erasing this vault you can restore it during setup with your recovery passphrase.` when `settings.backupEnabled`.
- Erase vault (dialog and eraser) resets `backupEnabled=false` and clears `lastBackupAt`; cloud data is NOT deleted by erase.

## B. CloudBackupScreen (`/settings/backup`, protected route)
AppBar title `Cloud backup`. Content centred, max width 640, ListView bottom padding 32.

Explainer card (always shown first), title `How cloud backup works`, bullets:
- `• Off by default. Nothing leaves this device until you enable it.`
- `• Photos are uploaded exactly as stored here: already encrypted.`
- `• Your vault key is uploaded only inside an envelope locked with a recovery passphrase you choose. The passphrase is never uploaded.`
- `• Your PIN is never uploaded and is not linked to the account.`
- `• Without the passphrase, the backup is unreadable, including to the service operator.`
- `• The vault keeps working offline whether or not backup is on.`

State 1 — Firebase unavailable (`backupService == null || cloudBackend == null`): explainer + centred text `This build has no Firebase configuration, so cloud backup is not available. Everything else works fully offline. See docs/firebase-setup.md to enable it.`

State 2 — available, signed out (StreamBuilder on `authStateChanges()`, initial `currentUser`; a `LinearProgressIndicator` appears under the explainer while `_busy`): header `Backup account`; text `The account only identifies your backup. It is not your vault PIN and cannot open the vault.`; TextField `Email` (email keyboard, autocorrect off); TextField `Password` (obscured); `Sign in` (FilledButton) → `cloud.signIn(email.trim(), password)`; `Create account` (OutlinedButton) → `cloud.signUp(...)`. Both disabled while busy. On success the password field is cleared. Errors → SnackBar with `describeCloudError`.

State 3 — signed in: header `Backup account`; ListTile icon account_circle_outlined, title = `user.email ?? user.uid`, trailing `Sign out` (TextButton) → `cloud.signOut()`. Header `Status`; FutureBuilder on `service.hasEnvelope()` (re-run after every action via a refresh counter): loading → LinearProgressIndicator (padding 16). Then text: enabled → `Backup is enabled for this account.` plus, when `lastBackupAt != null`, ` Last backup: <DateFormat.yMMMd().add_jm() of local time>.`; not enabled → `Backup is not enabled for this account.`
 - Not enabled: `Enable backup` (FilledButton.icon, cloud_upload_outlined, key `backup_enable`).
 - Enabled: `Back up now` (FilledButton.icon, cloud_upload_outlined, key `backup_now`); `Download missing photos` (OutlinedButton.icon, cloud_download_outlined); `Disable backup and delete cloud data` (TextButton). All disabled while busy.

Actions (each wrapped in `_run`: ignore if busy; busy=true; on error SnackBar `describeCloudError(e)`; finally busy=false and refresh status):
- Enable: open PassphraseDialog (confirm=true); cancel → nothing. Then `keys = session.requireKeys()`; `service.enable(keys, passphrase)`; settings `backupEnabled=true`; SnackBar `Backup enabled. Use "Back up now" to upload your photos.`
- Back up now: `repository = vaultRepositoryProvider.value` (null → `CloudException('unauthenticated')` → `Sign in first.`); `report = backupNow`; settings `backupEnabled=true, lastBackupAt=clock.now()`; analytics `vault_backup_completed {count: report.total}`; SnackBar `Uploaded <n> new photo<s> (<total> in the backup).` (singular when n == 1).
- Download missing photos: PassphraseDialog (confirm=false); `master = recoverMasterKey(passphrase)`; if `!constantTimeEquals(master, sessionKeys.masterKey)` → SnackBar `This backup belongs to a different vault. To restore it, erase this vault and choose "Restore from cloud backup" during setup.` and stop; else `restoreInto(repository, keys)`; analytics `vault_restore_completed {count: restored}`; SnackBar `Restored <n> photo<s>.`; master zeroed in finally.
- Disable: AlertDialog title `Disable cloud backup?`, content `Every backed-up photo and the key envelope are deleted from the cloud. Photos on this device are not affected.`, actions `Cancel` (TextButton → false) / `Disable` (FilledButton → true). If true: `service.disable()`; settings `backupEnabled=false`, clear `lastBackupAt`; SnackBar `Cloud backup disabled and cloud data deleted.`
SnackBars: hide current then show.

## C. PassphraseDialog (`showPassphraseDialog(context, confirm:, title: 'Recovery passphrase')`)
AlertDialog, title = `title`. When `confirm`: intro text `This passphrase protects your backup. It is never uploaded and cannot be reset: without it the backup is unreadable. Use at least 12 characters.` TextField key `passphrase_field`, label `Passphrase`, obscured (toggle suffix icon visibility_outlined / visibility_off_outlined), autofocus, autocorrect off, suggestions off; typing clears the error. When `confirm`: second TextField key `passphrase_confirm_field`, label `Confirm passphrase`, same obscure state. Error text (theme error colour) under the fields. Actions: `Cancel` (TextButton → returns null), `Continue` (FilledButton). Continue: `PassphrasePolicy.validate(first)` non-null → show it (`Use at least 12 characters.` / `Remove leading or trailing spaces.`); else if confirm and second != first → `The passphrases do not match.`; else pop with the passphrase (not trimmed).

## D. RestoreFlowScreen (`/setup/restore`, unprotected; reached from PIN setup)
Steps: account → passphrase → pin → working → done. AppBar title `Restore from backup`; back arrow hidden and system back blocked while `working`. Leaving the screen after keys were adopted but before `Open vault` was tapped → `session.lock()`. Content max width 480, padding 24; current error shown at top in error colour. If Firebase unavailable: `Cloud backup is not available in this build.`

1. account — heading `1. Sign in to your backup account`; TextField `Email` (email keyboard, autocorrect off); TextField `Password` (obscured); `Sign in` (FilledButton) → `cloud.signIn(email.trim(), password)`; success → clear password, go to passphrase; failure → error text. (No create-account option here.)
2. passphrase — heading `2. Enter your recovery passphrase`; text `The passphrase you chose when enabling backup. It unlocks the key envelope; nobody can recover the backup without it.`; TextField `Recovery passphrase` (obscured, autocorrect/suggestions off); `Next` (FilledButton) → if `PassphrasePolicy.validate` fails → error `Enter your full recovery passphrase.`; else go to pin.
3. pin — heading `3. Choose a PIN for this device`; text `4 to 8 digits, not starting with 0. You will type it on the calculator and press = to open the vault.`; TextField `New PIN`, TextField `Confirm PIN` (number keyboard, obscured); `Restore vault` (FilledButton) → `_restore`.
   `_restore`: pin = trimmed; `PinPolicy.validate` error → `PinPolicy.describe(error)`; pin != confirm (trimmed) → `The PINs do not match.`; `vaultStatus.configured` → `A vault already exists on this device. Erase it first, then restore.`; else step=working, error=null; keep `vaultRepositoryProvider` alive; `master = service.recoverMasterKey(passphrase)`; `keys = pinAuthService.adoptMasterKey(master, pin)`; `session.adopt(keys)`; `repository = await vaultRepositoryProvider.future` (null → `CloudException('unauthenticated')`); `report = service.restoreInto(repository, keys)`; zero master; `vaultStatus.refresh()`; settings `onboardingDone=true, backupEnabled=true` (lastBackupAt untouched); analytics `vault_restore_completed {count}`; clear passphrase/pin fields; step=done. On any error: error = `describeCloudError(e)`; step = passphrase if `WrongPassphraseException`, else pin.
4. working — CircularProgressIndicator + `Downloading your encrypted photos…` (centred).
5. done — icon verified_user_outlined size 56 (primary colour); headline `Restored <n> photo<s>` (singular when 1); text `From now on, type your new PIN on the calculator and press = to open the vault.`; `Open vault` (FilledButton) → mark opened, `go('/vault')`.

## Security notes

What leaves the device (and only this): (1) Firebase Auth email + password to Firebase Auth (a credential unrelated to the PIN); (2) Firestore `users/<uid>/vault/envelope` = 16-byte random salt, Argon2id params, XChaCha20-Poly1305 wrap of the 32-byte master key under Argon2id(passphrase, salt, 64 MiB/3/1) with AAD `silentsum/backup-envelope/v1`, and a UTC timestamp; (3) Firestore `users/<uid>/vault/manifest` = plaintext list of photo ids (random 128-bit hex), count, timestamp; (4) Storage `users/<uid>/index.enc`, `photos/<id>.enc`, `thumbs/<id>.enc` = the on-disk SSV1 ciphertext containers, byte-identical, content type `application/octet-stream`; (5) scrubbed crash text and coarse analytics events when enabled.

Never uploaded: the PIN, the recovery passphrase, the plaintext master key, any subkey, any plaintext image, file names, the local `VaultCredentials`. Tests assert the envelope JSON contains neither the passphrase nor base64(master) and that every uploaded blob starts with the SSV1 header and contains no JPEG SOI marker.

Server-side controls: owner-only access by verified token uid on every path (uid never taken from the payload); envelope shape validation (exact key set, `v==1`, `alg=='argon2id'`, m in [8192,262144], t in [1,10], p in [1,4], len==32, bounded base64 sizes 64/64/256/64); manifest shape validation (photoIds ≤ 20000, photoCount == size); Storage writes < 100 MiB and content type exactly `application/octet-stream`; everything else denied. App Check with Play Integrity / App Attest(+DeviceCheck fallback) in prod, debug providers in dev; activation failure is non-fatal on the client, enforcement is a console setting.

Client-side hardening: KDF parameters read from a downloaded envelope are bounded (`KdfParams.fromJson`) so a hostile envelope cannot force multi-GB allocations; envelope salt bounded to 8–64 bytes, wrapped ct ≤ 1024 bytes, nonce/mac exact lengths; restored blobs are authenticated under the session keys before being written; the "Download missing photos" path refuses to import when the recovered master key differs from the session's (constant-time compare); restore on a fresh device refuses if a vault already exists; KEK, passphrase bytes and recovered master are zeroed in `finally` blocks (best effort — Dart/JS cannot guarantee no copies); error copy never echoes raw backend messages (only codes), and crash text is scrubbed of 4–8 digit runs and paths before leaving the device; analytics is off until opt-in and never carries identifiers; Advertising ID collection is disabled in the manifest; Crashlytics collection is disabled in the manifest and enabled at runtime from the setting (default on).

Residual risks / caveats to carry into the RN port: the manifest exposes photo count and ids, and blob sizes/timestamps leak activity metadata; the SSV1 container binds header but not photo id, so an attacker with bucket access could swap two same-key blobs (confidentiality unaffected); wrong-passphrase attempts are limited only by Argon2id cost (64 MiB) plus Firestore read throttling — there is no server-side attempt counter; `FirebaseCloudBackend.deleteAccount` deletes only the auth user, not the data (the in-memory fake deletes both) — use `disable()` first; re-`enable` overwrites the envelope without warning; `backupNow` is not transactional (partial uploads are retried on the next run because the manifest is written last); restore aborts on the first blob that fails authentication (WrongKeyException is not caught per-photo); Argon2id and XChaCha20 must run off the JS thread in RN (native libsodium/argon2 modules), and the XChaCha20-Poly1305 variant must be the IETF construction (`crypto_aead_xchacha20poly1305_ietf`, 24-byte nonce, 16-byte tag, detached MAC serialised separately as `mac`) to interoperate with envelopes written by the Flutter app.

## Open questions

- Cross-implementation compatibility: package:cryptography's `Xchacha20.poly1305Aead()` is expected to match libsodium `crypto_aead_xchacha20poly1305_ietf` and its `Argon2id` to match RFC 9106 reference output; the repo has no fixed test vectors. Generate a vector set (salt, params, passphrase → KEK; kek, nonce, aad, master → ct/mac) from the Flutter build before porting so RN can be verified against real envelopes.
- `FirebaseCloudBackend.getBlob` uses `getData(maxBlobBytes)`; the Firebase error code raised when an object exceeds 100 MiB is not mapped in `describeCloudError` (falls to `Cloud error: <code>`). Confirm desired behaviour in RN (react-native-firebase downloads to a file rather than to memory).
- `deleteAccount` exists on the interface but no screen calls it, and the Firebase implementation leaves Firestore/Storage data behind. Decide whether the RN port exposes account deletion and, if so, whether it must call `disable()` first.
- The client accepts Argon2id memory down to `8*p` KiB when parsing an envelope, but Firestore rules require m >= 8192 on write; a test-parameter envelope (256 KiB) can never be stored in the real backend. Decide whether RN should mirror the looser client floor or align to 8192.
- `InMemoryCloudBackend` derives uid from Dart `String.hashCode`; any deterministic per-email id is acceptable for the RN test double, but tests that compare uids across sign-ins of the same email must stay deterministic.
- Restore flow sets `onboardingDone=true` and `backupEnabled=true` but does not set `lastBackupAt`; confirm this is intended (the Cloud backup screen will then show 'enabled' with no 'Last backup' suffix until the first backupNow).
- `restoreInto` iterates `index.photos.reversed` (oldest first) and aborts on a `WrongKeyException` from `importEncrypted` rather than skipping that photo; confirm whether the RN port should keep abort-on-first-corrupt semantics.
- `CrashReporter.scrub` deliberately leaves 9+ digit runs and 1–3 digit runs untouched (lookaround-bounded `\d{4,8}`); the RN regex engine supports lookbehind on Hermes — verify, or use an equivalent boundary construction.
- There are no widget tests for CloudBackupScreen, RestoreFlowScreen or PassphraseDialog in the reference; the RN port will need its own UI tests for the copy and state transitions documented here.
- Debug App Check tokens: dev builds print a token in logs that must be registered in the Firebase console; the RN equivalent (react-native-firebase app-check debug provider) needs an explicit token setup step not present in this repo.