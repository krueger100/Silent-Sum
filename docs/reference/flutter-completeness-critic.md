UNCOVERED FILES (with their specs)

Coverage check: 77 lib files + 18 test files. The four specs' files_read cover everything except the files below (fully uncovered), plus four files that were only partially read (lib/features/lifecycle/app_lifecycle_guard.dart lines 25-70; lib/features/settings/security_screen.dart lines 40-110; lib/features/backup/restore_flow_screen.dart lines 55-110; lib/main.dart grep only). All were read in full for this report, together with the native Android/iOS shells and firebase/ rules they depend on.

Fully uncovered:
- lib/features/backup/backup_envelope.dart, backup_service.dart, cloud_errors.dart, passphrase_dialog.dart, restore_flow_screen.dart (full)
- lib/features/settings/cloud_backup_screen.dart, settings_screen.dart, auto_lock_screen.dart, about_screen.dart, security_screen.dart (full)
- lib/core/firebase/cloud_backend.dart, firebase_cloud_backend.dart, firebase_services.dart, firebase_bootstrap.dart, firebase_options_dev.dart, firebase_options_prod.dart, firebase_analytics_service.dart, firebase_crash_reporter.dart
- lib/features/lifecycle/auto_lock_policy.dart, app_lifecycle_guard.dart (full), privacy_curtain.dart
- lib/core/security/screen_protection.dart
- lib/app/app.dart, lib/app/theme.dart, lib/main.dart (full); plus the providers in lib/app/providers.dart that no spec described (screenProtectionProvider, cloudBackendProvider, backupServiceProvider, initialSettingsProvider, SettingsController.update semantics, noRetry)
- test/features/backup/backup_service_test.dart, test/features/lifecycle/auto_lock_policy_test.dart, test/features/lifecycle/app_lifecycle_guard_test.dart
- Native glue: android/app/src/main/kotlin/com/kruegerco/silentsum/MainActivity.kt, AndroidManifest.xml, res/xml/data_extraction_rules.xml, ios/Runner/Info.plist, firebase/firestore.rules, firebase/storage.rules, firebase/firebase.json

======================================================================
SPEC A: cloud-backup (BackupEnvelope, PassphrasePolicy, BackupService, CloudBackend + InMemoryCloudBackend + FirebaseCloudBackend, cloud error copy, passphrase dialog, CloudBackupScreen, RestoreFlowScreen, Firestore/Storage rules)
======================================================================

A.1 CloudBackend contract (lib/core/firebase/cloud_backend.dart)
- CloudUser { uid: String, email: String? }.
- CloudException(code, [message]); toString `CloudException(<code>)` or `CloudException(<code>: <message>)`. Codes used by the app: `unauthenticated`, `permission-denied`, `object-not-found`, plus raw Firebase Auth/Firestore/Storage codes passed through (`wrong-password`, `invalid-credential`, `user-not-found`, `INVALID_LOGIN_CREDENTIALS`, `email-already-in-use`, `weak-password`, `invalid-email`, `network-request-failed`, `too-many-requests`).
- abstract CloudBackend: `currentUser`, `authStateChanges(): Stream<CloudUser?>`, `signIn({email,password})`, `signUp({email,password})`, `signOut()`, `deleteAccount()`, `putDocument(path, Map)`, `getDocument(path) -> Map?` (null when missing), `deleteDocument(path)`, `putBlob(path, Uint8List)`, `getBlob(path)` (throws CloudException('object-not-found') when missing), `deleteBlob(path)` (no error when missing), `listBlobs(prefix) -> List<String>` of last path segments directly under prefix.
- deleteAccount() has NO caller in the UI (exists only on the interface/adapters).

A.2 InMemoryCloudBackend (test double, also encodes the security-rule semantics)
- Accounts: Map email -> password. signUp: existing email -> CloudException('email-already-in-use'); signIn: mismatch -> CloudException('wrong-password'). uid = `uid_` + email.hashCode in hex. authStateChanges() yields the current user ONCE (does not stream later changes; tests read currentUser).
- Every document/blob op first requires a signed-in user (else `unauthenticated`) and requires the path to start with `users/<uid>/` (else `permission-denied`) — mirrors the owner-only rules. Documents and blobs are stored as copies. deleteAccount removes all `users/<uid>/` data and the account.
- listBlobs(prefix): appends `/` if missing, returns direct children only (no nested `/`).

A.3 FirebaseCloudBackend (lib/core/firebase/firebase_cloud_backend.dart)
- Wraps FirebaseAuth (email/password only), FirebaseFirestore (`doc(path).set/get/delete`; getDocument returns `.data()`), FirebaseStorage (`ref(path).putData(bytes, SettableMetadata(contentType: 'application/octet-stream'))`; `getData(maxBlobBytes = 100 MiB)`; null data -> `object-not-found`; deleteBlob swallows `object-not-found`; listBlobs = `listAll().items.map(name)`).
- Every FirebaseException/FirebaseAuthException is rethrown as `CloudException(e.code, e.message)`. Storage contentType MUST be `application/octet-stream` (storage.rules rejects anything else).

A.4 BackupEnvelope (lib/features/backup/backup_envelope.dart)
- Fields: version=1, salt (16 random bytes), kdf: KdfParams (always `KdfParams.backup` = m 65536 KiB, t 3, p 1, len 32 when written by this app), wrappedMasterKey: WrappedKey (AAD `silentsum/backup-envelope/v1`), createdAt UTC.
- toJson key order: `{"v":1,"salt":<b64>,"kdf":{alg,m,t,p,len},"wrapped":{nonce,ct,mac},"createdAt":<toUtc().toIso8601String()>}`. Unlike VaultCredentials there is NO pinLength.
- fromJson: v (default 1) != 1 -> FormatException('Unsupported envelope v<n>'); salt length outside [8,64] -> FormatException('bad salt length'); kdf via KdfParams.fromJson (bounded, see auth spec §2); wrapped via WrappedKey.fromJson; createdAt via DateTime.parse. Type errors propagate as TypeError.

A.5 PassphrasePolicy (in backup_service.dart)
- minLength = 12. validate(p): `p.length < 12` -> 'Use at least 12 characters.'; `p.trim() != p` -> 'Remove leading or trailing spaces.'; else null. No other rules (no character classes, no Unicode normalisation; passphrase bytes = raw UTF-8 of the string).

A.6 BackupService (lib/features/backup/backup_service.dart)
Construction: backend, kdf, wrapping, clock, random (default CSPRNG), kdfParams (default KdfParams.backup). Cloud paths (static):
- envelopePath(uid) = `users/<uid>/vault/envelope` (Firestore doc)
- manifestPath(uid) = `users/<uid>/vault/manifest` (Firestore doc)
- indexPath(uid) = `users/<uid>/index.enc` (Storage)
- photoPath(uid,id) = `users/<uid>/photos/<id>.enc`; thumbPath = `users/<uid>/thumbs/<id>.enc` (Storage)
- `_requireUser()` -> CloudException('unauthenticated') when no current user.
- hasEnvelope(): getDocument(envelopePath) != null.
- enable({keys, passphrase}): PassphrasePolicy.validate -> ArgumentError(message) if invalid; salt = 16 random bytes; kek = Argon2id(utf8(passphrase), salt, service kdfParams) (secret zeroed in finally); wrapped = wrap(keys.masterKey, kek, aad backupAad); putDocument(envelope.toJson()) with createdAt = clock.now().toUtc(); kek zeroed in finally. Replaces any existing envelope (new salt/nonce each time).
- backupNow(repository) -> BackupReport{uploaded, removed, total}: requires user; `!hasEnvelope()` -> BackupNotEnabledException; read manifest doc; uploadedIds = set of manifest.photoIds (or empty); localIds = repository.photos ids. For each local id not uploaded: putBlob(photo, readEncryptedPhoto(id)); putBlob(thumb, readEncryptedThumbnail(id)); add; uploaded++. For each uploaded id not local: deleteBlob(photo), deleteBlob(thumb), remove, removed++. Then index: readEncryptedIndex() non-null -> putBlob(indexPath) else deleteBlob(indexPath). Then putDocument(manifest, {photoIds: [...], photoCount: n, updatedAt: clock.now().toUtc().toIso8601String()}). Returns total = uploadedIds.length. Blobs are the on-disk ciphertext, byte-for-byte; nothing is re-encrypted. Not atomic: a failure mid-way leaves a stale manifest (next run re-uploads missing ids).
- recoverMasterKey(passphrase) -> Uint8List master: requires user; envelope doc null -> BackupNotEnabledException; parse envelope; kek = Argon2id(passphrase, envelope.salt, envelope.kdf) (STORED params, bounded by KdfParams.fromJson); unwrap with backupAad; WrongKeyException -> WrongPassphraseException; kek zeroed in finally. Caller owns and must zero the returned master.
- restoreInto(repository, keys) -> RestoreReport{restored, skipped}: requires user; getBlob(indexPath); CloudException 'object-not-found' -> RestoreReport(0,0); decrypt index with `const FileCipher()` (not injected) using keys.keyFor(manifest); VaultIndex.decode; existing = repository.photos ids. Iterate `index.photos.reversed` (oldest first): id already present -> skipped++; else getBlob(photo), getBlob(thumb), repository.importEncrypted(entry, photoBlob, thumbnailBlob) (which authenticates both blobs, stores with source=restore, re-sorts by createdAt desc), restored++; a CloudException 'object-not-found' for either blob -> skipped++ and continue; other exceptions propagate. Test expectation: after restore the target order is newest first [b, a].
- disable(): requires user; for prefix in [`users/<uid>/photos`, `users/<uid>/thumbs`]: listBlobs(prefix) and deleteBlob(`<prefix>/<name>`) for each; deleteBlob(indexPath); deleteDocument(manifest); deleteDocument(envelope). Does NOT sign out and does NOT delete the account.
- Exceptions: BackupNotEnabledException, WrongPassphraseException (both fieldless).

A.7 describeCloudError(Object) (lib/features/backup/cloud_errors.dart) — exact copy
- CloudException codes: wrong-password | invalid-credential | user-not-found | INVALID_LOGIN_CREDENTIALS -> 'Wrong email or password.'; email-already-in-use -> 'An account with this email already exists. Sign in instead.'; weak-password -> 'Choose a longer password.'; invalid-email -> 'That email address is not valid.'; network-request-failed -> 'No network connection.'; unauthenticated -> 'Sign in first.'; permission-denied -> 'Permission denied by the server rules.'; too-many-requests -> 'Too many attempts. Try again later.'; object-not-found -> 'That backup file no longer exists.'; anything else -> 'Cloud error: <code>'.
- WrongPassphraseException -> 'Wrong recovery passphrase.'; BackupNotEnabledException -> 'Backup is not enabled for this account.'; ArgumentError -> its message (the PassphrasePolicy text) or 'Invalid input.'; anything else -> 'Something went wrong.'. Raw Firebase messages are never shown.

A.8 Passphrase dialog — showPassphraseDialog(context, {required confirm, title = 'Recovery passphrase'}) -> String?
- AlertDialog title; when confirm: intro text 'This passphrase protects your backup. It is never uploaded and cannot be reset: without it the backup is unreadable. Use at least 12 characters.'; TextField key `passphrase_field` (label 'Passphrase', obscured with visibility toggle icon, autofocus, no autocorrect/suggestions); when confirm: second TextField key `passphrase_confirm_field` label 'Confirm passphrase' (same obscure state); error text in error color below. Typing clears the error.
- Actions: TextButton 'Cancel' -> null; FilledButton 'Continue' -> validate via PassphrasePolicy (error shown, stays open); if confirm and second != first -> 'The passphrases do not match.'; else pop(passphrase). The passphrase is returned to the caller and never stored.

A.9 CloudBackupScreen (route /settings/backup, protected)
- AppBar 'Cloud backup'; content centered, maxWidth 640.
- If backupServiceProvider or cloudBackendProvider is null (no Firebase): `_NotAvailable` = explainer card + centered text 'This build has no Firebase configuration, so cloud backup is not available. Everything else works fully offline. See docs/firebase-setup.md to enable it.'
- Otherwise a StreamBuilder on cloud.authStateChanges() (initialData currentUser): ListView(bottom padding 32): explainer card; LinearProgressIndicator while `_busy`; then sign-in form (no user) or account section.
- Explainer card 'How cloud backup works' with bullets (exact): '• Off by default. Nothing leaves this device until you enable it.' / '• Photos are uploaded exactly as stored here: already encrypted.' / '• Your vault key is uploaded only inside an envelope locked with a recovery passphrase you choose. The passphrase is never uploaded.' / '• Your PIN is never uploaded and is not linked to the account.' / '• Without the passphrase, the backup is unreadable, including to the service operator.' / '• The vault keeps working offline whether or not backup is on.'
- Sign-in form: header 'Backup account'; text 'The account only identifies your backup. It is not your vault PIN and cannot open the vault.'; TextField 'Email' (email keyboard, no autocorrect); TextField 'Password' (obscured); FilledButton 'Sign in' (signIn with trimmed email); OutlinedButton 'Create account' (signUp). Password field cleared after success. Buttons disabled while busy.
- Account section: header 'Backup account'; ListTile account_circle icon, title = email ?? uid, trailing TextButton 'Sign out'. Header 'Status'; FutureBuilder(hasEnvelope(), re-keyed by `_refresh` counter after every action) -> LinearProgressIndicator while loading; then text 'Backup is enabled for this account.' + (lastBackupAt != null ? ' Last backup: <DateFormat yMMMd jm of lastBackupAt.toLocal()>.' : '') or 'Backup is not enabled for this account.'.
  - Not enabled: FilledButton.icon key `backup_enable` 'Enable backup' -> passphrase dialog (confirm: true) -> service.enable(keys: session.requireKeys(), passphrase) -> settings backupEnabled=true -> snackbar 'Backup enabled. Use "Back up now" to upload your photos.'
  - Enabled: FilledButton.icon key `backup_now` 'Back up now' -> repository = vaultRepositoryProvider.value (null -> CloudException('unauthenticated'), i.e. snackbar 'Sign in first.' — misleading copy, faithful behaviour) -> service.backupNow -> settings backupEnabled=true, lastBackupAt = clock.now() (LOCAL DateTime; persisted as UTC by toJson) -> analytics `vault_backup_completed` {count: report.total} -> snackbar 'Uploaded <n> new photo(s) (<total> in the backup).' (singular when n == 1).
  - OutlinedButton.icon 'Download missing photos' -> passphrase dialog (confirm: false) -> master = recoverMasterKey; if `!constantTimeEquals(master, session.masterKey)` -> snackbar 'This backup belongs to a different vault. To restore it, erase this vault and choose "Restore from cloud backup" during setup.' and stop; else service.restoreInto(repository, keys) -> analytics `vault_restore_completed` {count} -> snackbar 'Restored <n> photo(s).'; master zeroed in finally.
  - TextButton 'Disable backup and delete cloud data' -> AlertDialog 'Disable cloud backup?' / 'Every backed-up photo and the key envelope are deleted from the cloud. Photos on this device are not affected.' / 'Cancel' / FilledButton 'Disable' -> service.disable() -> settings backupEnabled=false, clearLastBackup -> snackbar 'Cloud backup disabled and cloud data deleted.'
- `_run(action)`: single-flight (`_busy`), any exception -> snackbar describeCloudError(e) (hides current snackbar first), finally busy=false and `_refresh++`.

A.10 RestoreFlowScreen (route /setup/restore, reachable while locked; entered from PinSetupScreen 'Restore from cloud backup instead', shown only when firebase.available)
- Steps: account -> passphrase -> pin -> working -> done. AppBar 'Restore from backup'; back arrow hidden and PopScope canPop=false while working. Content maxWidth 480, padding 24, error text (error color) above the step widgets. Without Firebase: 'Cloud backup is not available in this build.'
- account: '1. Sign in to your backup account'; Email + Password fields; FilledButton 'Sign in' -> cloud.signIn (trimmed email); success clears password and moves to passphrase; failure -> describeCloudError. No "create account" here (restore presumes an existing account).
- passphrase: '2. Enter your recovery passphrase'; body 'The passphrase you chose when enabling backup. It unlocks the key envelope; nobody can recover the backup without it.'; obscured TextField 'Recovery passphrase'; 'Next' -> PassphrasePolicy.validate non-null -> error 'Enter your full recovery passphrase.' else go to pin.
- pin: '3. Choose a PIN for this device'; body '4 to 8 digits, not starting with 0. You will type it on the calculator and press = to open the vault.'; two obscured numeric TextFields 'New PIN' / 'Confirm PIN' (plain text fields, NOT PinKeypad); FilledButton 'Restore vault' -> `_restore`.
- `_restore`: pin = trimmed; PinPolicy.validate -> describe(error); mismatch -> 'The PINs do not match.'; `vaultStatus.configured` -> 'A vault already exists on this device. Erase it first, then restore.'; step=working; `ref.listenManual(vaultRepositoryProvider)` keeps the auto-dispose repository alive (no vault screen is mounted yet); master = recoverMasterKey(passphrase); keys = pinAuthService.adoptMasterKey(master, pin) (writes credentials, resets throttle); vaultSession.adopt(keys); `_adopted = true`; repository = await vaultRepositoryProvider.future (null -> CloudException('unauthenticated')); report = restoreInto(repository, keys); master zeroed in finally; vaultStatus.refresh(); settings onboardingDone=true, backupEnabled=true; analytics `vault_restore_completed` {count}; clear passphrase/pin controllers; step=done. On error: error = describeCloudError(e); step = passphrase if WrongPassphraseException else pin. Finally keepAlive.close().
- working: spinner + 'Downloading your encrypted photos…'.
- done: verified_user icon 56 primary; headline 'Restored <n> photo(s)'; text 'From now on, type your new PIN on the calculator and press = to open the vault.'; FilledButton 'Open vault' -> `_openedVault = true`, go('/vault').
- Pop handling: if the screen is popped after keys were adopted but the vault was not opened (`_adopted && !_openedVault`) the session is locked so an unlocked session never sits behind the calculator.

A.11 Server-side rules (firebase/firestore.rules, firebase/storage.rules) — product constraints the client must satisfy
- Firestore: only `users/{uid}/vault/envelope` and `users/{uid}/vault/manifest`; owner = request.auth.uid == uid; everything else closed. Envelope create/update validated: keys exactly {v,salt,kdf,wrapped,createdAt}; v == 1; salt string ≤ 64 chars; kdf keys exactly {alg,m,t,p,len}, alg 'argon2id', m int in [8192, 262144], t int in [1,10], p int in [1,4], len == 32; wrapped.nonce string ≤ 64, wrapped.ct string ≤ 256, wrapped.mac string ≤ 64; createdAt string. Manifest: keys exactly {photoIds, photoCount, updatedAt}; photoIds list ≤ 20000; photoCount int == photoIds.size(); updatedAt string.
- Storage: `users/{uid}/**` read/delete for owner; write only if owner AND size < 100 MiB AND contentType == 'application/octet-stream'. Everything else closed.
- firebase.json: emulator ports auth 9099, firestore 8080, storage 9199, UI enabled. No indexes.

A.12 Tests — test/features/backup/backup_service_test.dart (InMemoryCloudBackend, FakeClock, Argon2id inline, KdfParams.forTests, passphrase 'correct horse battery staple', account a@example.com / 'pw-pw-pw' signed up in setUp, repos over temp dirs with DartThumbnailGenerator)
1. `requires a signed-in account` — after signOut, enable() throws CloudException.
2. `enable stores an envelope that contains neither passphrase nor master key` — single document; its JSON contains neither the passphrase nor base64(masterKey); kdf.alg == 'argon2id'.
3. `recoverMasterKey needs the right passphrase` — correct passphrase returns masterKey; 'wrong passphrase!!' throws WrongPassphraseException.
4. `weak passphrases are rejected` — enable('short') throws ArgumentError; validate(' padded passphrase ') non-null.
5. `backupNow refuses without an envelope` — BackupNotEnabledException.
6. `backupNow uploads only ciphertext and mirrors deletions` — 2 photos: first report uploaded 2/total 2; every blob passes FileCipher.looksEncrypted and contains no FF D8 FF; keys include photoPath(a), thumbPath(b), indexPath; second run uploaded 0; delete a locally -> third run removed 1, total 1, photo blob for a gone.
7. `restore on a fresh device reproduces the photos` — backup 2 photos (1 min apart); recoverMasterKey -> derive keys -> new repo 'target'; restoreInto restored 2; target order [b, a]; readFullImage(a) == original jpeg; second restoreInto restored 0, skipped 2.
8. `disable removes everything for the account` — blobs and documents empty; hasEnvelope false.
9. `another user cannot read the data (backend enforces ownership)` — second account reading the first account's envelope path throws CloudException.

A.13 Security notes (backup)
- Only ciphertext and the passphrase-wrapped VMK leave the device; the PIN is never involved. Passphrase KDF uses KdfParams.backup (64 MiB) — twice the PIN cost — and the envelope AAD differs from the vault AAD so a vault credential record can never be replayed as an envelope or vice versa (verified by key_wrapping test 3).
- The recovered master key is only accepted into an existing session if it is constant-time-equal to the session's master key; otherwise the user is told to erase and restore during setup (no silent key mixing).
- Restore into a fresh device requires no existing vault; it writes credentials via adoptMasterKey before downloading, and locks the session if the user backs out before opening the vault.
- The manifest is a plain list of 32-hex ids plus counts/timestamps (metadata leak: photo count and upload times are visible to the operator; contents are not).
- Firebase Auth email/password only; no OAuth providers (their exported activities are removed from the manifest).

A.14 Open questions (backup)
- `_backupNow` maps a locked/absent repository to CloudException('unauthenticated') -> 'Sign in first.' — wrong copy; decide whether to keep.
- backupNow is not transactional; a crash between blob uploads and the manifest write leaves orphan blobs that are re-uploaded next run (idempotent) but never garbage-collected unless deleted locally.
- Firestore rules require m ≥ 8192 while KdfParams.fromJson accepts m ≥ 8·p; the app always writes 65536, so only hand-crafted envelopes differ.
- authStateChanges() in the in-memory backend emits once; the real backend streams — the UI relies on `_refresh` re-keying rather than the stream for status updates.

======================================================================
SPEC B: lifecycle & screen protection (AutoLockPolicy, AutoLockSuspension, AppLifecycleGuard, PrivacyCurtain, ScreenProtection + MainActivity channel)
======================================================================

B.1 AutoLockPolicy.shouldLock({backgroundedAt: Duration?, now: Duration, timeout}) — pure, monotonic durations
1. backgroundedAt == null -> false.
2. timeout == immediately -> true.
3. else `(now - backgroundedAt) >= timeout.duration`.

B.2 AutoLockSuspension (Riverpod Notifier<int>, provider autoLockSuspensionProvider)
- Counter of flows that intentionally hand control to another activity (the system photo picker). suspend(): +1; resume(): -1 floored at 0; isSuspended = state > 0; `grace = 5 minutes`. Wired by importServiceProvider (onPickerOpened -> suspend, onPickerClosed -> resume).

B.3 AppLifecycleGuard (wraps the whole app via MaterialApp.router builder)
State: `_backgroundedAt: Duration?` (monotonic), `_inactive: bool`.
didChangeAppLifecycleState:
- inactive: calculatorController.clearAll(); `_inactive = true`. Does NOT record a background timestamp (a permission dialog or app-switcher peek never triggers a lock).
- paused | hidden | detached: clearAll(); `_backgroundedAt ??= clock.monotonic()` (only the first transition sets it); `_inactive = true`.
- resumed: if session.isUnlocked and `_backgroundedAt != null`: now = monotonic(); suspended = autoLockSuspension.isSuspended; withinGrace = `now - _backgroundedAt < 5 min`; timeout = settings.autoLockTimeout; if `!(suspended && withinGrace) && AutoLockPolicy.shouldLock(...)` -> vaultSession.lock(). Then `_backgroundedAt = null`, `_inactive = false`. (While suspended by the picker, a background shorter than 5 min never locks regardless of the timeout, including `immediately`; longer than 5 min falls back to the normal rule.)
build:
- watches vaultSession and `settings.screenProtection`.
- ref.listen(vaultSession): `screenProtection.setSecure(next.isUnlocked && protect)`; on the unlocked -> locked transition also `imageCache.clear()` and `imageCache.clearLiveImages()` (Flutter engine bitmap cache, outside the repository byte caches).
- ref.listen(settings.screenProtection): `setSecure(session.isUnlocked && enabled)` (toggle takes effect immediately while unlocked).
- Renders `Stack(fit: expand, [child, if (_inactive && session.isUnlocked) PrivacyCurtain()])` — the curtain is drawn only while UNLOCKED; the calculator itself is never covered (it must look like a calculator in the switcher).
- setSecure is only invoked on changes (never on first build); the app starts locked so FLAG_SECURE starts cleared.

B.4 PrivacyCurtain — full-screen `Material(color: colorScheme.surface)` with a centered `Icons.calculate_outlined` 72 px in onSurfaceVariant (looks like a calculator splash).

B.5 ScreenProtection (lib/core/security/screen_protection.dart)
- abstract `Future<void> setSecure(bool enabled)`.
- NoopScreenProtection: no-op.
- MethodChannelScreenProtection([channel = MethodChannel('silentsum/screen_protection')]): `invokeMethod('setSecure', {'enabled': enabled})`; swallows MissingPluginException (iOS/web/desktop have no handler) and PlatformException (never let protection failures break the vault flow).
- RecordingScreenProtection: `calls: List<bool>` (tests assert `contains(true)` after unlock and `last == false` after lock).
- Native (MainActivity.kt, package com.kruegerco.silentsum): FlutterActivity, the only exported component; channel handler `setSecure` reads `enabled` (default false), on the UI thread sets or clears `WindowManager.LayoutParams.FLAG_SECURE`, returns success(null); other methods -> notImplemented. ProGuard keeps MainActivity unobfuscated.

B.6 Tests
- test/features/lifecycle/auto_lock_policy_test.dart: `never locks without a background timestamp` (null, immediately -> false); `immediately locks on any resume` (t0,t0 -> true); `locks only once the timeout has elapsed` (59 s false, 60 s true for oneMinute); `crash reporter scrubbing removes PIN-like digit runs and paths` — vectors: 'unlock failed for 123456' -> 'unlock failed for [redacted]'; 'year 2026 ok' -> 'year [redacted] ok'; 'id 123' unchanged; `C:\Users\x\vault\photos\a.enc failed` -> '[path] failed'; '/data/user/0/app/vault/index.enc bad' -> '[path] bad'; 'read /data/user/0/app/cache/picker/IMG_holiday.jpg' -> 'read [path]'; 'read /private/var/mobile/tmp/x.jpg' -> 'read [path]'.
- test/features/lifecycle/app_lifecycle_guard_test.dart (TestHarness, PIN 2468, onboardingDone true):
  1. `backgrounding past the timeout locks and re-authentication is required` (autoLock oneMinute): unlock -> GalleryScreen; inactive -> PrivacyCurtain present; paused + clock.advance(20 s) + resumed -> still GalleryScreen, no curtain; paused + advance(2 min) + resumed -> CalculatorScreen, no GalleryScreen; `2468=` unlocks again.
  2. `"immediately" locks on any resume` — paused then resumed with no time passing -> CalculatorScreen.

B.7 Security notes
- Auto-lock uses `Clock.monotonic()`; wall-clock edits in the background cannot defeat it. Sessions are never persisted (process restart = locked).
- FLAG_SECURE is Android-only and tied to (unlocked AND setting on); iOS relies on curtain + auto-lock only (security.md).
- On lock the engine image cache is cleared in addition to the repository caches (both spec'd elsewhere) — a port must clear its image component cache too.

======================================================================
SPEC C: Firebase integration layer (FirebaseServices, bootstrap, options stubs, Crashlytics/Analytics adapters, scrubbing)
======================================================================

C.1 FirebaseServices { available: bool, crash: CrashReporter, analytics: AnalyticsService, cloud: CloudBackend? }; `unavailable` = (false, NoopCrashReporter, NoopAnalyticsService, cloud null). Provider default is `unavailable`; main.dart overrides with the bootstrap result. Derived providers: crashReporterProvider, analyticsProvider, cloudBackendProvider (= services.cloud, null when unavailable), backupServiceProvider (null when cloud null).

C.2 initializeFirebase(env) — never throws
1. options = env.isProd ? prod.DefaultFirebaseOptions.currentPlatform : dev...; the committed option files are STUBS whose getter throws UnsupportedError('Firebase dev|prod options not generated') -> options = null.
2. options != null -> Firebase.initializeApp(options) else Firebase.initializeApp() (native google-services.json / GoogleService-Info.plist). Any exception -> debugPrint('Firebase not configured, continuing offline: …') and return `unavailable`.
3. App Check activate: Android `AndroidPlayIntegrityProvider` (prod) / `AndroidDebugProvider` (dev); Apple `AppleAppAttestWithDeviceCheckFallbackProvider` (prod) / `AppleDebugProvider` (dev); failures only debugPrint.
4. Return FirebaseServices(available: true, CrashlyticsCrashReporter(), FirebaseAnalyticsService(), FirebaseCloudBackend()).
Regeneration command (documented in the stubs): `flutterfire configure --project=<proj> --out=lib/core/firebase/firebase_options_{dev,prod}.dart --android-package-name=com.kruegerco.silentsum --ios-bundle-id=com.kruegerco.silentsum`.

C.3 AnalyticsService (interface already partially spec'd) — full event list `AnalyticsEvents`: `vault_setup_completed`, `vault_unlocked`, `vault_photo_added` {source}, `vault_backup_completed` {count}, `vault_restore_completed` {count}. `logEventSafely` = unawaited + catchError swallow. RecordingAnalyticsService records only when `enabled`.
- FirebaseAnalyticsService: in-memory `_enabled` (default false) mirrors `setAnalyticsCollectionEnabled(enabled)`; logEvent returns early when disabled (double gate). Manifest also sets `firebase_analytics_collection_enabled=false`, `google_analytics_adid_collection_enabled=false`, `google_analytics_default_allow_ad_personalization_signals=false`. No user ids / user properties are ever set.

C.4 CrashReporter (interface) + scrub
- Methods: setEnabled, recordError(error, stack, {reason, fatal=false}), recordFlutterError(details, {fatal=true}), log(message).
- `scrub(input)` applies, in order: `(?<!\d)\d{4,8}(?!\d)` -> `[redacted]`; `[A-Za-z]:\\[^\s]+` -> `[path]`; `/(?:data|private|var|storage|sdcard|tmp|Users|home)/[^\s'"]*` -> `[path]`; `/[^\s]*vault[^\s]*` -> `[path]`. Note any 4-8 digit run is redacted (years included).
- NoopCrashReporter: debug-mode-only console output of scrubbed error/log; presentError for Flutter errors.
- CrashlyticsCrashReporter: setEnabled -> setCrashlyticsCollectionEnabled; recordError sends `scrub(error.toString())` (a String, not the original object), the stack, scrubbed reason, fatal; recordFlutterError rebuilds FlutterErrorDetails with scrubbed `exceptionAsString()`, original stack and library, scrubbed context description, informationCollector dropped; log -> scrubbed. Manifest sets `firebase_crashlytics_collection_enabled=false`; runtime enables from settings (default on).

C.5 main.dart bootstrap order
1. WidgetsFlutterBinding.ensureInitialized(); env = SilentSumEnv.current.
2. firebase = await initializeFirebase(env).
3. settingsStore = PrefsSettingsStore(SharedPreferencesAsync()); settings = load(); `crash.setEnabled(settings.crashReportsEnabled)`; `analytics.setEnabled(settings.analyticsEnabled)`.
4. FlutterError.onError -> presentError in debug only, then `crash.recordFlutterError(details)`; PlatformDispatcher.onError -> `crash.recordError(error, stack, fatal: true)`, returns true.
5. runApp(ProviderScope(overrides: firebaseServicesProvider, settingsStoreProvider, initialSettingsProvider, child: SilentSumApp())).
Debug-only stage markers `silentsum bootstrap: firebase|settings|runApp` (never data).

C.6 Firebase is never initialised in tests (harness overrides firebaseServicesProvider with `unavailable`).

======================================================================
SPEC D: app shell (SilentSumApp, theme, settings provider semantics, router details not previously captured)
======================================================================

D.1 SilentSumApp: `MaterialApp.router(title: 'Calculator', debugShowCheckedModeBanner: false, theme: SilentSumTheme.light(), darkTheme: SilentSumTheme.dark(), themeMode: ThemeMode.system, routerConfig, builder: (ctx, child) => AppLifecycleGuard(child))`. Android label and iOS CFBundleDisplayName are also 'Calculator'; iOS CFBundleName / web title are 'silentsum'.

D.2 SilentSumTheme (Material 3, one seed)
- seed = 0xFF3D5AFE (also the web/launcher `theme_color`); `ColorScheme.fromSeed(seed, brightness)`; `useMaterial3: true`.
- scaffoldBackgroundColor = scheme.surface. AppBar: background surface, foreground onSurface, elevation 0, scrolledUnderElevation 0, centerTitle false.
- FilledButton: minimumSize 48×52, radius 16, text 16 / w600. OutlinedButton: minimumSize 48×52, radius 16. TextButton: radius 12. InputDecoration: filled, OutlineInputBorder radius 14 with no border side. SnackBar: floating, radius 12. Card: elevation 0, color surfaceContainerHigh, radius 18. Dialog: radius 22.
- Launcher/adaptive icon background `#1F2937`, calculator glyph drawn programmatically (tool/generate_icon.dart: body 0x334155, display 0x0F172A); web manifest background `#1F2937`.

D.3 Settings providers (lib/app/providers.dart)
- settingsStoreProvider default `InMemorySettingsStore()` (main overrides with Prefs); initialSettingsProvider default `AppSettings.defaults` (main overrides with the loaded record).
- SettingsController (Notifier<AppSettings>): build() = initialSettings; `update(fn)`: computes next, sets `state` SYNCHRONOUSLY, then awaits `store.save(next)` (UI reacts before persistence; a save failure propagates to the caller after the state already changed).
- `noRetry(retryCount, error) => null` disables Riverpod 3 auto-retry on vaultRootDirectoryProvider, vaultStatusProvider, vaultEraserProvider, vaultRepositoryProvider, photosProvider.
- screenProtectionProvider -> `const MethodChannelScreenProtection()`; kdfParamsProvider -> KdfParams.defaults; keyDerivationProvider -> `const Argon2idKeyDerivation()` (isolate on).

D.4 Router additions: `debugLogDiagnostics: false`; `_SessionRefresh` ChangeNotifier created inside routerProvider, disposed with it; redirect reads `state.matchedLocation`; routes are nested (`/` children `setup`→`restore`, `about`; `/vault` children `camera`, `photo/:id`; `/settings` children `change-pin`, `auto-lock`, `security`, `backup`, `about`). No deep links; the only Android intent filter is MAIN/LAUNCHER.

======================================================================
SPEC E: settings screens (SettingsScreen, AutoLockScreen, SecurityScreen, AboutScreen)
======================================================================

All: Scaffold + AppBar + Center(ConstrainedBox(maxWidth 640)) + ListView. `SettingsHeader(text)`: padding (16,20,16,4), labelLarge in primary color.

E.1 SettingsScreen (route /settings, protected) — AppBar 'Settings'
- Header 'Vault': ListTile key `settings_change_pin` icon pin_outlined 'Change PIN' -> push /settings/change-pin; ListTile timer_outlined 'Auto-lock', subtitle = current AutoLockTimeout.label -> /settings/auto-lock; ListTile shield_outlined 'Security & privacy' -> /settings/security.
- Header 'Cloud': ListTile cloud_outlined 'Cloud backup', subtitle: `!firebase.available` -> 'Not available in this build'; backupEnabled -> 'On — end-to-end encrypted' (em dash); else 'Off — photos stay on this device' -> /settings/backup (always tappable).
- Header 'App': ListTile info_outline 'About SilentSum' -> /settings/about (AboutScreen disguised:false).
- Padding (16,24,16,24): `FilledButton.tonalIcon` key `settings_lock`, icon lock_outline, 'Lock vault now' -> vaultSession.lock() (router then redirects to `/`).

E.2 AutoLockScreen (route /settings/auto-lock) — AppBar 'Auto-lock'
- Text (padding 16,16,16,8, bodyMedium): 'When the app leaves the foreground, the vault locks after this delay. It always locks when the app is closed.'
- One RadioListTile per AutoLockTimeout value in enum order (immediately, thirtySeconds, oneMinute, fiveMinutes, fifteenMinutes), key `autolock_<enum name>`, title = label ('Immediately', 'After 30 seconds', 'After 1 minute', 'After 5 minutes', 'After 15 minutes'), groupValue = current; onChanged -> settings update. Persisted immediately; no confirm.

E.3 SecurityScreen (route /settings/security) — AppBar 'Security & privacy'
- Header 'Screen': SwitchListTile key `security_screen_protection` 'Block screenshots', subtitle 'Prevents screenshots, screen recording and app-switcher previews while the vault is open (Android). On iOS the vault is always hidden in the app switcher.', value settings.screenProtection -> update setting (the guard applies FLAG_SECURE live).
- Header 'Diagnostics': SwitchListTile 'Send crash reports', subtitle firebase.available ? 'Anonymous crash reports via Firebase Crashlytics. They never include your PIN, photos or file names.' : 'Inactive in this build (no Firebase configuration).'; value crashReportsEnabled; onChanged: update setting THEN `crashReporter.setEnabled(v)`. SwitchListTile 'Share usage statistics', subtitle available ? 'Off by default. Only coarse events such as "vault unlocked"; never content, never the advertising ID.' : same inactive text; value analyticsEnabled; onChanged: update setting THEN `analytics.setEnabled(v)`. Both switches remain interactive without Firebase (they toggle a stored preference only).
- Header 'Danger zone': ListTile key `security_erase` (delete_forever_outlined, error color) 'Erase vault' (error color) subtitle 'Securely deletes every photo and the PIN on this device.' -> showEraseVaultDialog (auth spec G).

E.4 AboutScreen({disguised}) — routes `/about` (disguised:true, reachable while locked from the calculator menu) and `/settings/about` (disguised:false)
- AppBar 'About'; ListView padding 16. ListTile leading calculate_outlined (disguised) or lock_outline; title 'Calculator' (disguised) or 'SilentSum'; subtitle 'Version 0.1.0'.
- Only when not disguised: Card(padding 16) 'Security model' (titleMedium) + lines (exact): '• Your PIN never leaves this device and is never stored.' / '• The PIN derives a key with Argon2id; that key unwraps a random vault key kept in the platform secure store.' / '• Every photo, thumbnail and the index are encrypted with XChaCha20-Poly1305 in app-private storage.' / '• Unlocking works fully offline. Cloud backup is optional and end-to-end encrypted with a separate passphrase.' / '• Failed attempts are throttled; there is no backdoor. Forgetting the PIN means the vault cannot be recovered.'
- ListTile description_outlined 'Open source licenses' -> showLicensePage(applicationName: name, applicationVersion: AppInfo.version). The disguised page therefore reveals nothing but 'Calculator', version and licenses.

E.5 Native shell facts relevant to a rebuild (AndroidManifest.xml, data_extraction_rules.xml, Info.plist)
- Android: declared permissions CAMERA, INTERNET only; camera features `required=false`; tools:node="remove" for RECORD_AUDIO, READ/WRITE_EXTERNAL_STORAGE, com.google.android.gms.permission.AD_ID, ACCESS_ADSERVICES_AD_ID, ACCESS_ADSERVICES_ATTRIBUTION, BIND_GET_INSTALL_REFERRER_SERVICE, READ_GSERVICES; removed components GenericIdpActivity, RecaptchaActivity, RevocationBoundService. `android:label="Calculator"`, `allowBackup=false`, `fullBackupContent=false`, dataExtractionRules excluding every domain for cloud-backup and device-transfer (`disableIfNoEncryptionCapabilities=true`), `enableOnBackInvokedCallback=true`; MainActivity exported, launchMode singleTop, `taskAffinity=""`. Debug manifest disables Impeller (emulator rendering).
- iOS: CFBundleDisplayName 'Calculator'; NSCameraUsageDescription 'The camera is used to take photos that are stored in your private vault.'; NSPhotoLibraryUsageDescription 'Photo library access is used only to import photos you choose into your private vault.'; UIFileSharingEnabled=false; LSSupportsOpeningDocumentsInPlace=false; portrait + landscape supported; Podfile platform iOS 13.0; ITSAppUsesNonExemptEncryption deliberately not set.

======================================================================
CONTRADICTIONS (resolved by reading source)
======================================================================

1. Operator precedence. docs/superpowers plan Task 6 says `2+3×4=` -> 20 ("left-to-right") and the design spec §7 says "operator chaining with left-to-right evaluation". Source (calculator_engine.dart evaluate) applies × ÷ before + −; test `respects precedence` asserts 14. RESOLVED: precedence (14); the docs are stale.

2. ThrottleState shape. Design §5 and plan describe `{failedCount, lockedUntil}`. Source persists three fields `{failedCount, lockedUntil, lastFailureAt}`; lastFailureAt drives backwards-clock detection (auth spec §7, test 16). RESOLVED: three fields.

3. Android secure-storage backend. Design §3 says "Android Keystore-backed EncryptedSharedPreferences". Source uses flutter_secure_storage 10.3.3 with `AndroidOptions(resetOnError: false)` only (v10 removed the encryptedSharedPreferences option); security.md and the class doc say "AES-GCM key held in the Android Keystore over app-private preferences". RESOLVED: v10 semantics; the crypto-storage spec's open question is answered — no EncryptedSharedPreferences flag exists; only "no reset on error, device-bound" matters.

4. compileSdk. Plan says `compileSdk 35`; android/app/build.gradle.kts and docs/building.md say 36 (required by flutter_secure_storage 10; AGP warning suppressed). minSdk 26 agrees everywhere. RESOLVED: 36.

5. Permission set. Plan says "CAMERA and INTERNET". Manifest declares exactly those two, but firebase-setup.md documents the final merged set as CAMERA, INTERNET, ACCESS_NETWORK_STATE, WAKE_LOCK (Firebase merges the last two). RESOLVED: 2 declared + 2 merged.

6. Plan API names vs source (plan is pre-implementation and stale): `UnlockThrottled(retryAt)` -> `UnlockThrottled(remaining)`; `PinAuthService.eraseVault()` -> `eraseCredentials()` + separate `VaultEraser.eraseEverything()`; `VaultSessionController.adoptKeys` -> `adopt`; `writeAtomically` -> `writeFileAtomically`; `AttemptThrottle.delayFor/next/ThrottleDecision` -> `delayAfter/recordFailure/recordSuccess/remaining/isLocked`; `SettingsStore` typed getters -> single `AppSettings` record; `KeyDerivation` returns `Uint8List` (not `SecretKeyBytes`); `VaultKeys.photoKey/thumbKey/indexKey` fields -> `keyFor(VaultKeyId)`; `BackupService.restore(passphrase)/status()` -> `recoverMasterKey` + `restoreInto` + `hasEnvelope`; files `app_check.dart`, `vault_providers.dart`, `backup_providers.dart`, `change_pin_screen.dart`, `vault_session_test.dart` do not exist (App Check lives in firebase_bootstrap; all providers in app/providers.dart; change PIN is `PinSetupScreen(mode: change)`). RESOLVED: source names (as in the four specs) are authoritative.

7. Wrong-length PIN handling appears contradictory between the calculator spec ("numbers of another length are never attempts") and the auth spec §9.7 ("wrong length is counted as a wrong PIN without deriving"). Both are true at different layers: CalculatorController gates on `status.pinLength` (test: six `12345=` leave failedCount 0), while PinAuthService.unlock itself counts a wrong-length pin as a failure (test 6). A port must implement BOTH.

8. KDF memory lower bound. KdfParams.fromJson accepts `m >= 8*p` (auth spec §2); firebase/firestore.rules requires `m >= 8192` for envelopes. Not a runtime conflict (the app writes 65536) but the server is stricter; the RN port should validate envelopes with the server bound.

9. Lifecycle events. Design §9 says paused/hidden record the time and inactive shows the curtain. Source: `detached` also records the time; all four non-resumed states clear the calculator; the curtain is shown only while the session is unlocked. RESOLVED as in Spec B.

10. FLAG_SECURE condition. Design §9 says "while the session is unlocked"; source requires `isUnlocked && settings.screenProtection` (toggle 'Block screenshots', default on). RESOLVED: both conditions.

11. Large-image test. Design §12 promises a "12 MB" image test; the actual test is 3000×2000 (> 1 MiB, ~few MB). Minor doc drift.

12. Unused field confirmed: `VaultUnlocked.unlockedAt` has no consumer anywhere in lib (auth spec open question) — the guard uses its own monotonic `_backgroundedAt`.

13. README says 120 tests; grep counts 119 `test(`/`testWidgets(` calls. Immaterial.

No contradictions were found between the four specs on Argon2id params (32768/3/1/32 vault; 65536/3/1/32 backup; 256/1/1/32 tests), storage keys (`silentsum.vault.credentials.v1`, `silentsum.vault.throttle.v1`, `silentsum.settings.v1`), AAD strings (`silentsum/vmk/v1`, `silentsum/backup-envelope/v1`, SSV1 6-byte header), HKDF infos (`silentsum/photo/v1`, `silentsum/thumb/v1`, `silentsum/index/v1`), throttle schedule, routes, or analytics event names — all agree with source.

======================================================================
PRODUCT DECISIONS FROM DESIGN DOCS not captured by any spec
======================================================================
(docs/superpowers/specs/2026-09-12-silentsum-flutter-design.md, docs/superpowers/plans/2026-09-12-silentsum-flutter.md, plus README/security/architecture/building/firebase-setup)

1. Provenance: the native Android `Silent-Sum-master` prototype is used for product intent only; explicitly rejected legacy behaviours: registration via long press (no hidden gesture anywhere — setup is a visible menu item until configured), plaintext PIN, public Pictures folder, exported activities, copied resources.
2. Only three behaviours are preserved from the reference: calculator launcher labelled as a calculator; PIN entered through the calculator with no visible login control; camera + gallery after unlock.
3. Identity: application id / bundle id `com.kruegerco.silentsum`; Dart package `silentsum`; user-visible app name 'Calculator' (Android label, iOS display name, MaterialApp title); real name 'SilentSum' only inside the vault.
4. Platform targets: Android 8.0+ (minSdk 26), iOS 13+ (configured, never compiled — Windows host); web scaffolded for architecture only and NOT supported (browser storage not hardware-backed); desktop not scaffolded. iOS `isExcludedFromBackup` for the vault directory is a known TODO.
5. Firebase service matrix: Crashlytics (default ON, opt-out), Analytics (default OFF, opt-in, no Advertising ID, no user ids/properties), App Check (Play Integrity / App Attest+DeviceCheck in prod, debug providers in dev; enforcement enabled in console once verified), Auth email/password only (backup account, never a vault credential), Firestore (envelope + manifest), Storage (ciphertext blobs). Explicitly NOT used: Cloud Messaging (would add a permission), In-App Messaging, Realtime Database, Remote Config. No Admin SDK anywhere in the mobile project.
6. Firebase configuration strategy: two projects (dev/prod), selected by `--dart-define=SILENTSUM_ENV` (default dev in debug/profile, prod in release); committed option files are throwing stubs -> fallback to native config files -> fallback to "no Firebase"; native config files and generated options are git-ignored; Gradle applies google-services/crashlytics plugins only when a google-services.json exists. The app must compile, start and unlock with no Firebase and no network.
7. Manifest hardening as a standing rule: only the launcher activity exported; remove plugin-merged permissions/components; re-check the merged manifest after any Firebase dependency change; verify with `aapt2 dump permissions`.
8. Android backup: `allowBackup=false` plus data-extraction rules excluding everything (cloud backup and device transfer) — "the vault key lives in the keystore and cannot follow the files".
9. Release engineering: R8 minify + resource shrinking; signing via git-ignored android/key.properties (falls back to debug key); Play App Signing recommended; Kotlin plugin pinned 2.2.20 (Firebase Auth 6.x metadata); NDK 27.1.12297006; `kotlin.incremental=false` for cross-drive pub cache; `build/` is a junction to D:\silentsum-build; debug builds disable Impeller for software emulators.
10. Versioning: `version:` in pubspec.yaml AND `AppInfo.version` must be bumped together (manual duplication).
11. iOS export compliance: `ITSAppUsesNonExemptEncryption` deliberately not pre-set (app uses non-exempt crypto; answer in App Store Connect).
12. Import UX decision: system photo picker, no storage permission on Android 13+; originals never deleted; only the picker's private copy is securely deleted.
13. Camera decision: audio disabled and RECORD_AUDIO removed from the merged manifest (captured only partially — "audio never enabled").
14. Testing policy: no test initialises Firebase; widget tests boot the real app with fakes; BackupService tested only against InMemoryCloudBackend which mirrors owner-only rules.
15. Operations note: budget alerts on Storage egress — each backup is a full ciphertext copy; manifest capped at 20000 ids by rules; blobs < 100 MB.
16. Threat model (security.md): protects against device pickup after lock, OS gallery/switcher/file-manager browsing, file-system dumps without keystore, curious cloud operator, casual guessing; does NOT protect against rooted/compromised OS, shoulder surfing, PIN knowledge, memory forensics, or device loss without backup. "The disguise is behavioural, not forensic."
17. Launcher icon is drawn programmatically (tool/generate_icon.dart) so the repo carries no binary assets of unknown origin; adaptive background #1F2937; theme color #3D5AFE.
18. Verification log (README): 120 tests, release APK ~54 MB all ABIs, on-device `run-as` inspection confirmed SSV1 ciphertext under files/vault, no JPEG signature, camera temp file removed, no PIN traces in secure-storage prefs, nothing in Pictures/DCIM, FLAG_SECURE active while unlocked.

======================================================================
REPO NOTES (pubspec.yaml, analysis_options.yaml, .gitignore, misc)
======================================================================

pubspec.yaml (C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/pubspec.yaml)
- name `silentsum`, version `0.1.0` (no build number), `publish_to: none`, Dart SDK `^3.8.0` (Flutter 3.32.0 per docs).
- Runtime deps (resolved in pubspec.lock): camera 0.11.2+1 (camera_android_camerax 0.6.19+1), cloud_firestore 6.9.0, collection 1.19.1 (declared, unused in lib/test), cryptography 2.9.0, firebase_analytics 12.5.0, firebase_app_check 0.4.7, firebase_auth 6.6.1, firebase_core 4.14.0, firebase_crashlytics 5.3.0, firebase_storage 13.5.0, flutter_riverpod 3.3.2 (riverpod 3.3.2), flutter_secure_storage 10.3.3, go_router 17.0.0, image 4.9.2 (thumbnails in tests, icon generator, JPEG encode in EngineThumbnailGenerator), image_picker 1.2.1, intl 0.20.2 (DateFormat yMMMd/jm in viewer and backup screen), meta 1.16.0 (declared, unused), path_provider 2.1.5, shared_preferences 2.5.3.
- Dev deps: flutter_test, flutter_lints 5.0.0, fake_async 1.3.3 (declared, NOT imported anywhere — tests use FakeClock), flutter_launcher_icons 0.14.4.
- `uses-material-design: true`; no bundled assets/fonts (all icons are Material icons; launcher icons generated from assets/icon/*.png).
- flutter_launcher_icons: android+ios, remove_alpha_ios, image assets/icon/icon.png, adaptive background `#1F2937`, adaptive foreground assets/icon/icon_foreground.png; web icons with background `#1F2937`, theme `#3D5AFE`.
- RN mapping hints: cryptography -> libsodium (Argon2id13 / xchacha20poly1305_ietf detached / HKDF-SHA256 via a separate lib); flutter_secure_storage -> react-native-keychain / expo-secure-store with AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY and no cloud sync; shared_preferences -> AsyncStorage/MMKV (key `silentsum.settings.v1`); camera/image_picker -> expo-camera / expo-image-picker (no audio, no EXIF metadata request, delete picker copies); path_provider app-support -> documentDirectory-equivalent app-private dir excluded from backups; Firebase -> RN Firebase or Expo modules behind the same CloudBackend interface.

analysis_options.yaml
- Single line `include: package:flutter_lints/flutter.yaml` — stock Flutter lint set, no custom rules, no `strict-*` analyzer flags, no exclusions. Nothing here constrains the rebuild beyond "analyze clean" (README/plan gate).

.gitignore
- Standard Flutter template (build/, .dart_tool/, .idea/, *.iml, symbols/obfuscation maps, android debug/profile/release dirs) plus a SilentSum block: `google-services.json`, `GoogleService-Info.plist`, `/android/app/src/*/google-services.json`, `/android/key.properties`, `*.jks`, `*.keystore`, `firebase-debug.log`, `.firebase/`, `/firebase/*.log`. Note the generated firebase_options_{dev,prod}.dart are NOT ignored (the committed stubs must be replaced locally and would be committed if regenerated — the header comments say to replace them; the design doc says "never commit ... generated options" but .gitignore does not enforce it).

Other repo facts
- Git: repository initialised on branch `main` with NO commits ("does not have any commits yet"); there is no history to mine for decisions.
- `build` in the project root is a symlink/junction to D:\silentsum-build (per docs/building.md); `.flutter-plugins-dependencies` is present at root.
- Test count by grep: 119 test()/testWidgets() calls across 17 test files (README says 120).
- Docs present: docs/architecture.md, security.md, building.md, firebase-setup.md, superpowers/specs/2026-09-12-silentsum-flutter-design.md, superpowers/plans/2026-09-12-silentsum-flutter.md, README.md; firebase/ (firebase.json, firestore.rules, storage.rules, firestore.indexes.json); tool/generate_icon.dart.
- Android Gradle: compileSdk 36, minSdk 26, targetSdk = flutter default, Java/Kotlin JVM 11, NDK 27.1.12297006, Kotlin plugin 2.2.20, `org.gradle.jvmargs=-Xmx8G`, `kotlin.incremental=false`, `android.suppressUnsupportedCompileSdk=36`; proguard keeps MainActivity and `-dontwarn com.google.android.play.core.**`.