# Flutter reference: lifecycle-settings-app

_lifecycle-settings-app — app shell (MaterialApp.router + theme), go_router redirect rules, AppLifecycleGuard / AutoLockPolicy / AutoLockSuspension / PrivacyCurtain, ScreenProtection method channel (Dart + MainActivity.kt FLAG_SECURE), main.dart bootstrap + error hooks, AppSettings model + persistence, all five settings screens (Settings, Auto-lock, Security & privacy incl. erase dialog, Cloud backup, About), Android manifest/gradle/resource hardening, iOS Info.plist._

Files read: C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/lifecycle/auto_lock_policy.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/lifecycle/auto_lock_suspension.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/lifecycle/app_lifecycle_guard.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/lifecycle/privacy_curtain.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/settings/settings_screen.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/settings/auto_lock_screen.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/settings/security_screen.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/settings/about_screen.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/settings/cloud_backup_screen.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/app/app.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/app/router.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/app/theme.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/app/providers.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/main.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/security/screen_protection.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/storage/settings_store.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/storage/prefs_settings_store.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/clock.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/app_info.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/environment.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/firebase/firebase_bootstrap.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/firebase/firebase_services.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/firebase/crash_reporter.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/firebase/firebase_crash_reporter.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/firebase/analytics_service.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/firebase/firebase_analytics_service.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/firebase/cloud_backend.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/security/byte_utils.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/authentication/erase_vault_dialog.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/authentication/vault_session.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/authentication/vault_session_controller.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/backup/passphrase_dialog.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/backup/cloud_errors.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/backup/backup_service.dart (lines 16-52 + method signatures), C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/gallery/import_service.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/calculator/calculator_controller.dart (clearAll), C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/test/features/lifecycle/app_lifecycle_guard_test.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/test/features/lifecycle/auto_lock_policy_test.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/test/core/storage/settings_store_test.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/test/features/calculator/calculator_screen_test.dart (lines 20-46), C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/test/support/test_app.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/android/app/src/main/AndroidManifest.xml, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/android/app/src/debug/AndroidManifest.xml, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/android/app/src/profile/AndroidManifest.xml, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/android/app/src/main/kotlin/com/kruegerco/silentsum/MainActivity.kt, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/android/app/src/main/res/xml/data_extraction_rules.xml, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/android/app/src/main/res/values/styles.xml, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/android/app/src/main/res/values-night/styles.xml, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/android/app/src/main/res/values/colors.xml, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/android/app/src/main/res/drawable/launch_background.xml, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/android/app/src/main/res/drawable-v21/launch_background.xml, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/android/app/build.gradle.kts, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/android/app/proguard-rules.pro, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/ios/Runner/Info.plist, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/ios/Runner/AppDelegate.swift, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/pubspec.yaml (header), C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/docs/security.md, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/docs/architecture.md

## Behaviour

## 0. Static constants

| Constant | Value | Where |
|---|---|---|
| Real product name | `SilentSum` | `AppInfo.name` |
| Disguise name | `Calculator` | `AppInfo.disguisedName`, `MaterialApp.title`, Android `android:label`, iOS `CFBundleDisplayName` |
| Version string | `0.1.0` (must match pubspec `version: 0.1.0`) | `AppInfo.version` |
| Android package / applicationId / namespace | `com.kruegerco.silentsum` | build.gradle.kts, MainActivity.kt |
| iOS CFBundleName | `silentsum` | Info.plist |
| Method channel name | `silentsum/screen_protection` | Dart + Kotlin |
| Method name | `setSecure` with args map `{"enabled": <bool>}` | Dart + Kotlin |
| Settings persistence key | `silentsum.settings.v1` (shared_preferences string holding JSON) | PrefsSettingsStore |
| Auto-lock picker grace | 5 minutes | `AutoLockSuspension.grace` |
| Theme seed colour | `0xFF3D5AFE` (ARGB) | SilentSumTheme.seed |
| Build env dart-define | `SILENTSUM_ENV` = `dev` \| `prod`; default `prod` in release builds, `dev` otherwise | SilentSumEnv |
| Debug bootstrap log prefix | `silentsum bootstrap: <stage>` with stages `firebase`, `settings`, `runApp` (debug builds only) | main.dart |
| Launcher icon background | `#1F2937` (adaptive icon, foreground inset 16%) | colors.xml, ic_launcher.xml |

## 1. AutoLockTimeout (enum, ordered; order = UI order)

| name (persisted string) | duration | label (UI) |
|---|---|---|
| `immediately` | 0 | `Immediately` |
| `thirtySeconds` | 30 s | `After 30 seconds` |
| `oneMinute` | 60 s | `After 1 minute` |
| `fiveMinutes` | 5 min | `After 5 minutes` |
| `fifteenMinutes` | 15 min | `After 15 minutes` |

`AutoLockTimeout.fromName(name)` → the enum whose `name` equals the string; any unknown/null → `oneMinute` (the default).

## 2. AppSettings (non-secret preferences)

Fields, JSON keys (identical to field names) and defaults:

| field / JSON key | type | default | fromJson fallback |
|---|---|---|---|
| `autoLockTimeout` | enum name string | `oneMinute` | `fromName` (→ oneMinute) |
| `screenProtection` | bool | `true` | `true` |
| `analyticsEnabled` | bool | `false` | `false` |
| `crashReportsEnabled` | bool | `true` | `true` |
| `onboardingDone` | bool | `false` | `false` |
| `backupEnabled` | bool | `false` | `false` |
| `lastBackupAt` | ISO-8601 UTC string (`toUtc().toIso8601String()`) or null | null | `DateTime.tryParse` if a string, else null |

- `copyWith(...)` accepts every field plus `clearLastBackup: bool = false`; when `clearLastBackup` is true `lastBackupAt` becomes null regardless of the argument.
- Equality/hash over all 7 fields.
- `SettingsStore` interface: `load()`, `save(settings)`, `clear()`.
- `InMemorySettingsStore([initial])`: `load()` returns stored or `AppSettings.defaults`; `clear()` sets null.
- `PrefsSettingsStore(SharedPreferencesAsync)`: `load()` reads string at key `silentsum.settings.v1`; null → defaults; `jsonDecode` + `fromJson`; a `FormatException` → defaults (other exceptions propagate). `save()` writes `jsonEncode(toJson())`. `clear()` removes the key.
- `SettingsController` (Riverpod Notifier): initial state = `initialSettingsProvider` (defaults unless overridden in main). `update(change)`: `next = change(state)`; set `state = next` synchronously (UI updates immediately); then `await store.save(next)`. No rollback if save throws.

## 3. Clock

- `Clock { DateTime now(); Duration monotonic(); }`
- `SystemClock`: `now()` = wall clock; `monotonic()` = elapsed time of a single process-wide `Stopwatch` started at first use. It is process-lifetime monotonic (not OS uptime). Changing the system date/time never affects it.
- `FakeClock([start])` (tests): `now` starts at 2026-01-01 12:00 local, `monotonic` at 0; `advance(d)` moves both; `setNow(t)` moves only the wall clock.

## 4. AutoLockPolicy.shouldLock({backgroundedAt: Duration?, now: Duration, timeout})

1. If `backgroundedAt == null` → `false` (never lock without a recorded background instant).
2. Else if `timeout == immediately` → `true` (regardless of elapsed time, even 0).
3. Else `elapsed = now - backgroundedAt`; return `elapsed >= timeout.duration` (inclusive: exactly 60 s locks for `oneMinute`; 59 s does not).
All inputs are monotonic durations; wall-clock is never consulted.

## 5. AutoLockSuspension (Riverpod `Notifier<int>`; provider `autoLockSuspensionProvider`)

- State is a counter, initial `0`. `suspend()` → +1. `resume()` → -1 but never below 0. `isSuspended` → `state > 0`.
- `static const grace = Duration(minutes: 5)`.
- Sole caller: `ImportService.importFromLibrary` calls `onPickerOpened` (= `suspend()`) immediately before `ImagePicker.pickMultiImage(requestFullMetadata: false)` and `onPickerClosed` (= `resume()`) in a `finally` once the picker returns/throws. So the counter is > 0 only while the system photo picker activity is in front. It is never reset on lock (not needed: the finally always balances it).

## 6. AppLifecycleGuard (wraps the entire router output via `MaterialApp.router(builder:)`)

State: `_backgroundedAt: Duration?` (monotonic), `_inactive: bool = false`. Registers as a `WidgetsBindingObserver` on init and removes on dispose.

### 6.1 Lifecycle transitions (`didChangeAppLifecycleState`)

| Flutter state | Actions |
|---|---|
| `inactive` (visible but not focused: app switcher opening, permission/system dialog, incoming call, iOS control-centre) | 1) `calculatorController.clearAll()` (resets calculator to `CalculatorState.initial`, display `0`, so a typed PIN is never visible in the switcher); 2) `_inactive = true` (curtain shows if unlocked). Does NOT record `_backgroundedAt`. |
| `paused`, `hidden`, `detached` | 1) `clearAll()`; 2) `_backgroundedAt ??= clock.monotonic()` (only the FIRST of these events after a resume sets it; later ones keep the earlier stamp); 3) `_inactive = true`. |
| `resumed` | 1) If session `isUnlocked` AND `_backgroundedAt != null`: `now = clock.monotonic()`; `suspended = autoLockSuspension.isSuspended`; `withinGrace = (now - _backgroundedAt) < 5 min` (strict); `timeout = settings.autoLockTimeout`; if `!(suspended && withinGrace) && AutoLockPolicy.shouldLock(backgroundedAt, now, timeout)` → `vaultSession.lock()`. 2) Always: `_backgroundedAt = null`; `_inactive = false`. |

Consequences:
- An `inactive` that never reaches `paused` (e.g. a dialog over the app) never locks, however long it lasts; it only shows the curtain.
- During a picker round trip shorter than 5 min the vault never locks, even with timeout `immediately`. At ≥ 5 min the normal policy applies (so with `immediately`/`30s`/`1m`/`5m` it locks; with `15m` it locks only at ≥ 15 min).
- If the session is already locked on resume nothing happens except clearing state.
- Android Flutter embedding ordering (for mapping): onPause → `inactive`; onStop → `hidden` then `paused`; onStart → `hidden` → `inactive`; onResume → `resumed`. iOS: willResignActive → `inactive`; didEnterBackground → `hidden`/`paused`; willEnterForeground → `inactive`; didBecomeActive → `resumed`.

### 6.2 Build-time side effects (run on every relevant provider change, not at first build)
- `ref.listen(vaultSessionProvider)`: on every session change call `screenProtection.setSecure(next.isUnlocked && settings.screenProtection)`; additionally, when `previous.isUnlocked == true && next.isUnlocked == false` (an unlock→lock transition) clear the Flutter global `imageCache` (`clear()` + `clearLiveImages()`) so decoded bitmaps of vault photos leave memory.
- `ref.listen(settingsProvider.select(s => s.screenProtection))`: on toggle call `setSecure(session.isUnlocked && enabled)` immediately (so turning the switch off while the vault is open clears FLAG_SECURE at once; toggling while locked sends `false`).
- No `setSecure` call is made at startup; the app starts locked so the flag is off until the first unlock.

### 6.3 Layout
`Stack(fit: expand)`: `[child, if (_inactive && session.isUnlocked) PrivacyCurtain()]`. The curtain is never shown while locked (the calculator is already innocuous).

## 7. PrivacyCurtain
Opaque `Material` filling the screen with `colorScheme.surface`, containing a centred `Icons.calculate_outlined`, size 72 logical px, colour `colorScheme.onSurfaceVariant`. No text. Purpose: app-switcher preview / dialogs show a calculator glyph instead of vault content.

## 8. ScreenProtection (Dart) and MainActivity (Kotlin)

- `abstract class ScreenProtection { Future<void> setSecure(bool enabled); }`
- `NoopScreenProtection`: does nothing.
- `MethodChannelScreenProtection([channel = MethodChannel('silentsum/screen_protection')])`: `setSecure(enabled)` → `channel.invokeMethod('setSecure', {'enabled': enabled})`; swallows `MissingPluginException` (platform without implementation: iOS, web, desktop) and `PlatformException` (never break the vault flow). Any other error propagates (none expected).
- `RecordingScreenProtection`: appends each `enabled` to `List<bool> calls` (tests).
- Production provider: `screenProtectionProvider = MethodChannelScreenProtection()`.
- **MainActivity.kt** (`com.kruegerco.silentsum.MainActivity extends FlutterActivity`, the only Activity): in `configureFlutterEngine` registers a `MethodChannel` named `"silentsum/screen_protection"`. Handler: method `"setSecure"` → `enabled = call.argument<Boolean>("enabled") ?: false`; on the UI thread: if enabled `window.setFlags(FLAG_SECURE, FLAG_SECURE)` else `window.clearFlags(FLAG_SECURE)`; replies `result.success(null)` (synchronously, without waiting for the UI-thread runnable). Any other method → `result.notImplemented()`.
- iOS `AppDelegate.swift` only registers plugins; no channel handler exists → Dart gets `MissingPluginException`, swallowed. iOS relies on the curtain + auto-lock only.
- ProGuard: `-keep class com.kruegerco.silentsum.MainActivity { *; }` and `-dontwarn com.google.android.play.core.**`.

## 9. Router (go_router)

Route table (path → screen):

| Path constant | Path | Screen | Protected? |
|---|---|---|---|
| `calculator` | `/` (initialLocation) | CalculatorScreen | no |
| `setup` | `/setup` | PinSetupScreen(mode: create) | no |
| `restore` | `/setup/restore` | RestoreFlowScreen | no |
| `calculatorAbout` | `/about` | AboutScreen(disguised: true) | no |
| `vault` | `/vault` | GalleryScreen | yes |
| `camera` | `/vault/camera` | CameraScreen | yes |
| `photo(id)` | `/vault/photo/:id` | PhotoViewerScreen(initialId: id) | yes |
| `settings` | `/settings` | SettingsScreen | yes |
| `changePin` | `/settings/change-pin` | PinSetupScreen(mode: change) | yes |
| `autoLock` | `/settings/auto-lock` | AutoLockScreen | yes |
| `security` | `/settings/security` | SecurityScreen | yes |
| `backup` | `/settings/backup` | CloudBackupScreen | yes |
| `about` | `/settings/about` | AboutScreen(disguised: false) | yes |

Rules:
1. `AppRoutes.isProtected(location) = location.startsWith('/vault') || location.startsWith('/settings')`.
2. Global `redirect`: if `isProtected(state.matchedLocation) && !vaultSession.isUnlocked` → redirect to `/`; otherwise no redirect (return null). No onboarding redirect lives here (the calculator screen handles setup navigation).
3. `refreshListenable` = a ChangeNotifier that fires on every `vaultSessionProvider` change, so a `lock()` re-runs the redirect and immediately ejects the user from any protected route to `/`.
4. `debugLogDiagnostics: false`. No deep links are declared (no intent filters besides LAUNCHER, no iOS URL types).
5. Navigation from Settings tiles uses push (stack) semantics; erase flow uses `go('/')` (replace stack).

## 10. App shell (`SilentSumApp`)
`MaterialApp.router(title: 'Calculator', debugShowCheckedModeBanner: false, theme: light, darkTheme: dark, themeMode: ThemeMode.system, routerConfig: router, builder: (ctx, child) => AppLifecycleGuard(child: child ?? SizedBox.shrink()))`. The OS task label is therefore "Calculator" on both platforms.

## 11. Theme (`SilentSumTheme.light()` / `.dark()`; identical construction, only brightness differs)
1. `scheme = ColorScheme.fromSeed(seedColor: 0xFF3D5AFE, brightness)` (Material 3 tonal palette; a single indigo-blue accent on neutral surfaces). `useMaterial3: true`.
2. Overrides:
   - `scaffoldBackgroundColor = scheme.surface`
   - AppBar: background `scheme.surface`, foreground `scheme.onSurface`, elevation 0, scrolledUnderElevation 0, `centerTitle: false` (left-aligned titles).
   - FilledButton: `minimumSize 48×52`, corner radius 16, text 16 px weight 600.
   - OutlinedButton: `minimumSize 48×52`, radius 16.
   - TextButton: radius 12.
   - Inputs: `filled: true`, `OutlineInputBorder` radius 14 with **no** border stroke.
   - SnackBar: floating behaviour, radius 12.
   - Card: elevation 0, colour `scheme.surfaceContainerHigh`, radius 18.
   - Dialog: radius 22.
3. Dark/light follows the system (`ThemeMode.system`). Android launch theme: light `Theme.Light.NoTitleBar`, night `Theme.Black.NoTitleBar`; `launch_background` = plain `?android:colorBackground` (API 21+) / white (legacy); `NormalTheme` windowBackground `?android:colorBackground`.

## 12. main.dart bootstrap (exact order)
1. `WidgetsFlutterBinding.ensureInitialized()`.
2. `env = SilentSumEnv.current` (see §0).
3. debug log `silentsum bootstrap: firebase`; `firebase = await initializeFirebase(env)` — never throws: tries compiled `DefaultFirebaseOptions` (prod or dev by env; an `UnsupportedError` from the stub means "use native config files" → `Firebase.initializeApp()` without options); any exception → `debugPrint('Firebase not configured, continuing offline: $e')` and returns `FirebaseServices.unavailable` (`available:false`, `NoopCrashReporter`, `NoopAnalyticsService`, `cloud:null`). On success activates App Check (Android: prod `PlayIntegrity`, dev `Debug`; Apple: prod `AppAttestWithDeviceCheckFallback`, dev `Debug`; failure only `debugPrint('App Check activation failed: $e')`) and returns `FirebaseServices(available:true, CrashlyticsCrashReporter, FirebaseAnalyticsService, FirebaseCloudBackend)`.
4. debug log `silentsum bootstrap: settings`; `settingsStore = PrefsSettingsStore(SharedPreferencesAsync())`; `settings = await settingsStore.load()`.
5. `await firebase.crash.setEnabled(settings.crashReportsEnabled)` (Crashlytics: `setCrashlyticsCollectionEnabled`; manifest default is disabled, so this is what turns it on).
6. `await firebase.analytics.setEnabled(settings.analyticsEnabled)` (sets an in-memory `_enabled` flag AND `setAnalyticsCollectionEnabled`; `logEvent` is a no-op while `_enabled == false`).
7. debug log `silentsum bootstrap: runApp`.
8. `FlutterError.onError = (details) { if (kDebugMode) FlutterError.presentError(details); firebase.crash.recordFlutterError(details); }` — i.e. framework errors are printed to console only in debug and always forwarded to the crash reporter (fatal defaults to true). Crashlytics adapter rebuilds `FlutterErrorDetails` with `exception = scrub(exceptionAsString())`, `context = scrub(context.toDescription())`, `informationCollector: null`, keeping `stack` and `library`.
9. `PlatformDispatcher.instance.onError = (error, stack) { firebase.crash.recordError(error, stack, fatal: true); return true; }` — uncaught async/zone errors are reported as fatal and marked handled. Crashlytics adapter sends `scrub(error.toString())`, the stack, `reason` scrubbed if present.
10. `runApp(ProviderScope(overrides: [firebaseServicesProvider ← firebase, settingsStoreProvider ← settingsStore, initialSettingsProvider ← settings], child: SilentSumApp()))`.
Note: the error hooks are installed after Firebase init and settings load but before any widget builds.

`CrashReporter.scrub(input)` (applied to every free-text field before it leaves the device), in order:
1. `(?<!\d)\d{4,8}(?!\d)` → `[redacted]` (4–8 digit runs = possible PINs; 3-digit and 9+-digit runs untouched).
2. `[A-Za-z]:\\[^\s]+` → `[path]` (Windows paths).
3. `/(?:data|private|var|storage|sdcard|tmp|Users|home)/[^\s'"]*` → `[path]`.
4. `/[^\s]*vault[^\s]*` → `[path]`.
`NoopCrashReporter`: in debug builds prints `[error] <scrubbed>` / `[log] <scrubbed>` and presents Flutter errors; otherwise silent.

`AnalyticsEvents` names: `vault_setup_completed`, `vault_unlocked`, `vault_photo_added`, `vault_backup_completed`, `vault_restore_completed`. `logEventSafely(analytics, name, params)` fires and forgets, swallowing errors.

## 13. Composition root facts relevant here (`lib/app/providers.dart`)
- `clockProvider` → `SystemClock()`; `screenProtectionProvider` → `MethodChannelScreenProtection()`; `settingsStoreProvider` default `InMemorySettingsStore()` (overridden in main); `initialSettingsProvider` default `AppSettings.defaults`; `settingsProvider` = SettingsController.
- `firebaseServicesProvider` default `FirebaseServices.unavailable`; `crashReporterProvider`, `analyticsProvider`, `cloudBackendProvider` are projections of it; `backupServiceProvider` is `null` when `cloud == null`, otherwise a `BackupService(backend, kdf, wrapping, clock, random)`.
- `vaultSessionProvider` (`VaultSessionController`): starts `VaultLocked`; `lock()` is a no-op if already locked, else sets `VaultLocked` and disposes (zeroes) the keys; `VaultSessionState.isUnlocked`, `keysOrNull`, `requireKeys()` (throws `VaultLockedException` if locked or keys disposed).
- Async providers use `retry: noRetry` (no automatic retries).

## 14. Settings screens — behaviour (copy and layout in ui_flows)
1. **SettingsScreen**: reads `settingsProvider` and `firebaseServicesProvider`. Auto-lock tile subtitle = `autoLockTimeout.label`. Cloud backup subtitle: `!firebase.available` → `Not available in this build`; else `backupEnabled` → `On — end-to-end encrypted`; else `Off — photos stay on this device`. "Lock vault now" → `vaultSession.lock()` (router then redirects to `/`). All tiles push their route even when the feature is unavailable.
2. **AutoLockScreen**: one radio per `AutoLockTimeout.values` in enum order; selecting → `settings.update(s => s.copyWith(autoLockTimeout: value))`. Takes effect on the next resume (no timer restart needed; policy is evaluated on resume).
3. **SecurityScreen**: `Block screenshots` switch bound to `screenProtection` (update only; the guard's listener applies FLAG_SECURE). `Send crash reports` → `await settings.update(crashReportsEnabled: v)` then `await crashReporter.setEnabled(v)`. `Share usage statistics` → `await settings.update(analyticsEnabled: v)` then `await analytics.setEnabled(v)`. Both diagnostic switches stay interactive even when Firebase is unavailable (subtitle changes to the "Inactive in this build" copy; the setEnabled call is a no-op). `Erase vault` → `showEraseVaultDialog(context, ref)`.
4. **Erase flow** (`showEraseVaultDialog`, returns `Future<bool>`): show typed-confirmation dialog; if result != true or context unmounted → return false. Otherwise: `eraser = await vaultEraserProvider.future`; `vaultSession.lock()`; `await eraser.eraseEverything()`; `await settings.update(backupEnabled: false, clearLastBackup: true)`; `await vaultStatus.refresh()`; if still mounted show SnackBar `Vault erased.` and `context.go('/')`; return true. Confirmation input matches when `text.trim() == 'ERASE'` (exact, case-sensitive; the field forces capital letters via `textCapitalization: characters`).
5. **AboutScreen(disguised)**: `disguised: true` (reached from `/about` on the calculator) shows name `Calculator`, calculator icon, version, licenses only. `disguised: false` (from `/settings/about`) shows `SilentSum`, lock icon, a "Security model" card, licenses. Licenses → Flutter `showLicensePage(applicationName: name, applicationVersion: '0.1.0')`.
6. **CloudBackupScreen** state machine:
   - `service == null || cloud == null` (Firebase unavailable) → `_NotAvailable` view.
   - Otherwise `StreamBuilder(cloud.authStateChanges(), initialData: cloud.currentUser)`: `user == null` → sign-in form; else account view.
   - `_busy` flag: `_run(action)` ignores calls while busy; sets busy; awaits action; any exception → SnackBar `describeCloudError(e)`; finally busy=false and `_refresh++` (this re-keys the `FutureBuilder` so `service.hasEnvelope()` is re-queried). A `LinearProgressIndicator` appears under the explainer while busy; all buttons are disabled while busy.
   - Sign in / create: `email = _email.text.trim()`, `password = _password.text` (untrimmed); `create ? cloud.signUp : cloud.signIn`; on success clear the password field only.
   - Status: `FutureBuilder<bool>(key: ValueKey(_refresh), future: service.hasEnvelope())` → while loading a `LinearProgressIndicator`; `true` = "enabled" branch, `false` = "not enabled" branch. Note: enabled-ness comes from the cloud envelope, not from `settings.backupEnabled`.
   - Enable: `showPassphraseDialog(confirm: true)`; null → abort; `_run`: `keys = vaultSession.requireKeys()`; `await service.enable(keys, passphrase)`; `settings.update(backupEnabled: true)`; SnackBar `Backup enabled. Use "Back up now" to upload your photos.`
   - Back up now: `_run`: `repository = vaultRepositoryProvider.value` (null → `throw CloudException('unauthenticated')` → "Sign in first."); `report = await service.backupNow(repository)`; `settings.update(backupEnabled: true, lastBackupAt: clock.now())`; `logEventSafely(analytics, 'vault_backup_completed', {'count': report.total})`; SnackBar `Uploaded <uploaded> new photo[s] (<total> in the backup).` (singular when uploaded == 1).
   - Download missing photos: `showPassphraseDialog(confirm: false)`; null → abort; `_run`: `master = await service.recoverMasterKey(passphrase)`; try { `keys = requireKeys()`; if `!constantTimeEquals(master, keys.masterKey)` → SnackBar `This backup belongs to a different vault. To restore it, erase this vault and choose "Restore from cloud backup" during setup.` and return; repository null → unauthenticated; `report = await service.restoreInto(repository, keys)`; `logEventSafely(analytics, 'vault_restore_completed', {'count': report.restored})`; SnackBar `Restored <restored> photo[s].` } finally `zeroBytes(master)`.
   - Disable: confirmation `AlertDialog`; if not confirmed abort; `_run`: `await service.disable()`; `settings.update(backupEnabled: false, clearLastBackup: true)`; SnackBar `Cloud backup disabled and cloud data deleted.`
   - Sign out: `_run(cloud.signOut)`.
   - `_say(msg)`: if mounted, hide current SnackBar then show the new one.
   - Last-backup text uses `intl` `DateFormat.yMMMd().add_jm()` on `lastBackupAt.toLocal()` (e.g. `Feb 3, 2026 4:05 AM` in en_US).
7. **Passphrase dialog** (`showPassphraseDialog(context, confirm:, title = 'Recovery passphrase')`): returns the passphrase string or null (Cancel/dismiss). Validation on Continue: `PassphrasePolicy.validate`: length < 12 → `Use at least 12 characters.`; `trim() != value` → `Remove leading or trailing spaces.`; then if confirm and second field != first → `The passphrases do not match.`; else pop(passphrase). Typing in either field clears the error. Both fields obscured, toggled together by one eye icon; autocorrect and suggestions off.
8. **describeCloudError(error)** → user copy (never echoes raw messages):

| Error | Copy |
|---|---|
| CloudException code `wrong-password`, `invalid-credential`, `user-not-found`, `INVALID_LOGIN_CREDENTIALS` | `Wrong email or password.` |
| `email-already-in-use` | `An account with this email already exists. Sign in instead.` |
| `weak-password` | `Choose a longer password.` |
| `invalid-email` | `That email address is not valid.` |
| `network-request-failed` | `No network connection.` |
| `unauthenticated` | `Sign in first.` |
| `permission-denied` | `Permission denied by the server rules.` |
| `too-many-requests` | `Too many attempts. Try again later.` |
| `object-not-found` | `That backup file no longer exists.` |
| other CloudException code X | `Cloud error: X` |
| `WrongPassphraseException` | `Wrong recovery passphrase.` |
| `BackupNotEnabledException` | `Backup is not enabled for this account.` |
| `ArgumentError` | its `message` string, or `Invalid input.` |
| anything else | `Something went wrong.` |

## 15. Android manifest hardening (`android/app/src/main/AndroidManifest.xml`)
1. Declared permissions: only `android.permission.CAMERA` and `android.permission.INTERNET`. Features `android.hardware.camera` and `android.hardware.camera.autofocus` both `required="false"`.
2. Permissions explicitly REMOVED from the merged manifest (`tools:node="remove"`): `RECORD_AUDIO`, `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`, `com.google.android.gms.permission.AD_ID`, `android.permission.ACCESS_ADSERVICES_AD_ID`, `android.permission.ACCESS_ADSERVICES_ATTRIBUTION`, `com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE`, `com.google.android.providers.gsf.permission.READ_GSERVICES`.
3. `<application>`: `android:label="Calculator"`, `android:name="${applicationName}"`, `android:icon="@mipmap/ic_launcher"`, `android:allowBackup="false"`, `android:fullBackupContent="false"`, `android:dataExtractionRules="@xml/data_extraction_rules"`, `android:enableOnBackInvokedCallback="true"`.
4. Application meta-data (all `false`): `firebase_analytics_collection_enabled`, `google_analytics_adid_collection_enabled`, `google_analytics_default_allow_ad_personalization_signals`, `firebase_crashlytics_collection_enabled`. Plus Flutter's `flutterEmbedding` = `2`.
5. `MainActivity`: `android:exported="true"`, `launchMode="singleTop"`, `taskAffinity=""` (empty, so no other app can join its task), `theme="@style/LaunchTheme"`, `configChanges="orientation|keyboardHidden|keyboard|screenSize|smallestScreenSize|locale|layoutDirection|fontScale|screenLayout|density|uiMode"`, `hardwareAccelerated="true"`, `windowSoftInputMode="adjustResize"`; meta-data `io.flutter.embedding.android.NormalTheme` → `@style/NormalTheme`; single intent filter `MAIN` + `LAUNCHER`. It is intended to be the only exported component.
6. Removed exported components merged in by Firebase Auth / Google Sign-In: activities `com.google.firebase.auth.internal.GenericIdpActivity`, `com.google.firebase.auth.internal.RecaptchaActivity`; service `com.google.android.gms.auth.api.signin.RevocationBoundService`.
7. `<queries>`: one intent `android.intent.action.PROCESS_TEXT` with `text/plain` (Flutter text-selection toolbar default).
8. Debug manifest adds `INTERNET` and `io.flutter.embedding.android.EnableImpeller=false` (Skia on software emulators); profile manifest adds `INTERNET` only.

## 16. data_extraction_rules.xml
`<cloud-backup disableIfNoEncryptionCapabilities="true">` and `<device-transfer>` each exclude domains `root`, `file`, `database`, `sharedpref`, `external` — nothing is ever backed up or transferred by the OS.

## 17. build.gradle.kts
- `namespace`/`applicationId` `com.kruegerco.silentsum`; `compileSdk 36`; `minSdk 26`; `targetSdk` = Flutter's; `ndkVersion "27.1.12297006"`; Java/Kotlin target 11.
- Google Services + Crashlytics Gradle plugins are applied only if `google-services.json` exists in `android/app/`, `src/debug/`, or `src/release/`.
- Release: `isMinifyEnabled = true`, `isShrinkResources = true`, `proguard-android-optimize.txt` + `proguard-rules.pro`; signing from `android/key.properties` (`storeFile`, `storePassword`, `keyAlias`, `keyPassword`) if present, else falls back to the debug signing config.

## 18. iOS Info.plist
`CFBundleDisplayName` = `Calculator`; `CFBundleName` = `silentsum`; `CFBundleShortVersionString` = `$(FLUTTER_BUILD_NAME)`; `CFBundleVersion` = `$(FLUTTER_BUILD_NUMBER)`; `LSRequiresIPhoneOS` true; `UILaunchStoryboardName` `LaunchScreen`; `UIMainStoryboardFile` `Main`; iPhone orientations Portrait, LandscapeLeft, LandscapeRight; iPad additionally PortraitUpsideDown; `CADisableMinimumFrameDurationOnPhone` true; `UIApplicationSupportsIndirectInputEvents` true; `NSCameraUsageDescription` = `The camera is used to take photos that are stored in your private vault.`; `NSPhotoLibraryUsageDescription` = `Photo library access is used only to import photos you choose into your private vault.`; `UIFileSharingEnabled` false; `LSSupportsOpeningDocumentsInPlace` false. No URL schemes, no background modes.

## Public API

// lib/features/lifecycle
class AutoLockPolicy { static bool shouldLock({required Duration? backgroundedAt, required Duration now, required AutoLockTimeout timeout}); }  // pure; see §4
class AutoLockSuspension extends Notifier<int> { static const Duration grace = 5 min; int build() => 0; void suspend(); void resume(); bool get isSuspended; }
final autoLockSuspensionProvider = NotifierProvider<AutoLockSuspension, int>;
class AppLifecycleGuard extends ConsumerStatefulWidget { const AppLifecycleGuard({Key? key, required Widget child}); }  // WidgetsBindingObserver; wraps router output
class PrivacyCurtain extends StatelessWidget { const PrivacyCurtain({Key? key}); }

// lib/core/security/screen_protection.dart
abstract class ScreenProtection { Future<void> setSecure(bool enabled); }
class NoopScreenProtection implements ScreenProtection { const NoopScreenProtection(); }
class MethodChannelScreenProtection implements ScreenProtection { const MethodChannelScreenProtection([MethodChannel channel = defaultChannel]); static const MethodChannel defaultChannel = MethodChannel('silentsum/screen_protection'); }
class RecordingScreenProtection implements ScreenProtection { final List<bool> calls; }

// android MainActivity.kt
class MainActivity : FlutterActivity  // channel "silentsum/screen_protection", method "setSecure"(enabled: Boolean) -> null; others notImplemented

// lib/core/storage/settings_store.dart
enum AutoLockTimeout { immediately, thirtySeconds, oneMinute, fiveMinutes, fifteenMinutes; final Duration duration; final String label; static AutoLockTimeout fromName(String? name); }
class AppSettings { const AppSettings({autoLockTimeout = oneMinute, screenProtection = true, analyticsEnabled = false, crashReportsEnabled = true, onboardingDone = false, backupEnabled = false, DateTime? lastBackupAt}); static const defaults; AppSettings copyWith({..., bool clearLastBackup = false}); Map<String,Object?> toJson(); factory AppSettings.fromJson(Map); ==/hashCode over all fields }
abstract class SettingsStore { Future<AppSettings> load(); Future<void> save(AppSettings); Future<void> clear(); }
class InMemorySettingsStore implements SettingsStore { InMemorySettingsStore([AppSettings? initial]); }
class PrefsSettingsStore implements SettingsStore { PrefsSettingsStore(SharedPreferencesAsync prefs); }  // key 'silentsum.settings.v1'

// lib/core/clock.dart
abstract class Clock { DateTime now(); Duration monotonic(); }
class SystemClock implements Clock { const SystemClock(); }
class FakeClock implements Clock { FakeClock([DateTime? start]); void advance(Duration); void setNow(DateTime); }

// lib/core/app_info.dart
class AppInfo { static const String name = 'SilentSum'; static const String disguisedName = 'Calculator'; static const String version = '0.1.0'; }

// lib/core/environment.dart
enum SilentSumEnv { dev, prod; static SilentSumEnv get current; bool get isProd; }

// lib/app
class SilentSumApp extends ConsumerWidget
class AppRoutes { static const calculator='/', setup='/setup', restore='/setup/restore', vault='/vault', camera='/vault/camera', settings='/settings', changePin='/settings/change-pin', autoLock='/settings/auto-lock', security='/settings/security', backup='/settings/backup', about='/settings/about', calculatorAbout='/about'; static String photo(String id) => '/vault/photo/$id'; static bool isProtected(String location); }
final routerProvider = Provider<GoRouter>;
class SilentSumTheme { static const Color seed = Color(0xFF3D5AFE); static ThemeData light(); static ThemeData dark(); }
// providers.dart (subset used here)
final clockProvider = Provider<Clock>; final screenProtectionProvider = Provider<ScreenProtection>; final settingsStoreProvider = Provider<SettingsStore>; final initialSettingsProvider = Provider<AppSettings>;
class SettingsController extends Notifier<AppSettings> { Future<void> update(AppSettings Function(AppSettings current) change); }
final settingsProvider = NotifierProvider<SettingsController, AppSettings>;
final firebaseServicesProvider = Provider<FirebaseServices>; final crashReporterProvider = Provider<CrashReporter>; final analyticsProvider = Provider<AnalyticsService>; final cloudBackendProvider = Provider<CloudBackend?>; final backupServiceProvider = Provider<BackupService?>;
final vaultSessionProvider = NotifierProvider<VaultSessionController, VaultSessionState>;  // lock(), unlock(pin), adopt(keys), isUnlocked
Duration? noRetry(int retryCount, Object error) => null;

// lib/main.dart
Future<void> main()  // bootstrap §12

// lib/features/settings
class SettingsScreen extends ConsumerWidget; class SettingsHeader extends StatelessWidget { const SettingsHeader(String text); }
class AutoLockScreen extends ConsumerWidget; class SecurityScreen extends ConsumerWidget;
class AboutScreen extends StatelessWidget { const AboutScreen({required bool disguised}); }
class CloudBackupScreen extends ConsumerStatefulWidget;

// dialogs used by these screens
Future<bool> showEraseVaultDialog(BuildContext context, WidgetRef ref);   // features/authentication/erase_vault_dialog.dart
Future<String?> showPassphraseDialog(BuildContext context, {required bool confirm, String title = 'Recovery passphrase'});  // features/backup/passphrase_dialog.dart
class PassphrasePolicy { static const int minLength = 12; static String? validate(String passphrase); }
String describeCloudError(Object error);   // features/backup/cloud_errors.dart

// firebase abstractions consumed here
class FirebaseServices { const FirebaseServices({required bool available, required CrashReporter crash, required AnalyticsService analytics, CloudBackend? cloud}); static const unavailable; }
Future<FirebaseServices> initializeFirebase(SilentSumEnv env);  // never throws
abstract class CrashReporter { Future<void> setEnabled(bool); Future<void> recordError(Object error, StackTrace? stack, {String? reason, bool fatal = false}); Future<void> recordFlutterError(FlutterErrorDetails details, {bool fatal = true}); void log(String); static String scrub(String input); }
abstract class AnalyticsService { Future<void> setEnabled(bool); Future<void> logEvent(String name, [Map<String,Object> parameters = const {}]); }
void logEventSafely(AnalyticsService analytics, String name, [Map<String,Object> parameters = const {}]);
class AnalyticsEvents { vaultSetup='vault_setup_completed', vaultUnlock='vault_unlocked', photoAdded='vault_photo_added', backupCompleted='vault_backup_completed', restoreCompleted='vault_restore_completed' }
class CloudUser { const CloudUser({required String uid, String? email}); }
class CloudException implements Exception { const CloudException(String code, [String? message]); }
abstract class CloudBackend { CloudUser? get currentUser; Stream<CloudUser?> authStateChanges(); Future<CloudUser> signIn({email,password}); Future<CloudUser> signUp({email,password}); Future<void> signOut(); Future<void> deleteAccount(); ...document/blob ops }
// BackupService (used by CloudBackupScreen): Future<bool> hasEnvelope(); Future<void> enable({required VaultKeys keys, required String passphrase}); Future<BackupReport{uploaded,removed,total}> backupNow(VaultRepository); Future<Uint8List> recoverMasterKey(String passphrase); Future<RestoreReport{restored,skipped}> restoreInto(VaultRepository, VaultKeys); Future<void> disable();

## Tests

### test/features/lifecycle/auto_lock_policy_test.dart (pure unit tests; `t0 = Duration(hours: 3)`)
1. `never locks without a background timestamp`: `shouldLock(backgroundedAt: null, now: t0, timeout: immediately)` is false.
2. `immediately locks on any resume`: `shouldLock(backgroundedAt: t0, now: t0, timeout: immediately)` is true (zero elapsed still locks).
3. `locks only once the timeout has elapsed`: with `oneMinute`, `now = t0 + 59 s` → false; `now = t0 + 60 s` → true (inclusive boundary).
4. `crash reporter scrubbing removes PIN-like digit runs and paths` (lives in this file although it tests CrashReporter.scrub): `'unlock failed for 123456'` → `'unlock failed for [redacted]'`; `'year 2026 ok'` → `'year [redacted] ok'`; `'id 123'` → unchanged `'id 123'`; `'C:\Users\x\vault\photos\a.enc failed'` → `'[path] failed'`; `'/data/user/0/app/vault/index.enc bad'` → `'[path] bad'`; `'read /data/user/0/app/cache/picker/IMG_holiday.jpg'` → `'read [path]'`; `'read /private/var/mobile/tmp/x.jpg'` → `'read [path]'`.

### test/features/lifecycle/app_lifecycle_guard_test.dart (widget tests booting the real app through TestHarness; all inside `tester.runAsync`)
1. `backgrounding past the timeout locks and re-authentication is required` — harness with `configuredPin = '2468'`, settings `onboardingDone: true, autoLockTimeout: oneMinute`.
   - Tap calculator keys `2468=`; settle 30 frames → exactly one `GalleryScreen`.
   - Send `AppLifecycleState.inactive`; settle 3 → exactly one `PrivacyCurtain` (curtain shows, no lock).
   - Send `paused`; `clock.advance(20 s)`; send `resumed`; settle 5 → `GalleryScreen` still present and `PrivacyCurtain` absent (short background stays unlocked, curtain removed).
   - Send `paused`; `clock.advance(2 min)`; send `resumed`; settle 10 → `CalculatorScreen` present, `GalleryScreen` absent (locked and redirected to `/`).
   - Tap `2468=` again; settle 30 → `GalleryScreen` present (re-authentication works after auto-lock).
2. `"immediately" locks on any resume` — settings `autoLockTimeout: immediately`. Unlock with `2468=` → GalleryScreen; send `paused` then `resumed` with no clock advance; settle 10 → `CalculatorScreen` present.

### test/core/storage/settings_store_test.dart
1. `defaults are privacy-preserving`: `analyticsEnabled` false, `crashReportsEnabled` true, `screenProtection` true, `backupEnabled` false, `autoLockTimeout == oneMinute`.
2. `json round trip and unknown timeout falls back`: defaults with `fiveMinutes`, analytics true, onboardingDone true, `lastBackupAt = 2026-02-03T04:05Z` survives `fromJson(toJson())` with equality; `AutoLockTimeout.fromName('bogus') == oneMinute`.
3. `in-memory store persists and clears`: save `screenProtection: false` → load returns false; `clear()` → load returns `AppSettings.defaults`.

### test/features/calculator/calculator_screen_test.dart (only the assertions touching this subsystem), case `wrong PIN stays on the calculator, correct PIN opens the vault, lock returns`
- After unlocking with `C2468=` and reaching `GalleryScreen` (text `Your vault is empty` visible): `harness.screenProtection.calls` contains `true` (FLAG_SECURE requested on unlock because the default `screenProtection` setting is true).
- After tapping the gallery's `vault_lock` key and settling: `CalculatorScreen` shown, display text is `0` (calculator cleared), and `screenProtection.calls.last == false` (FLAG_SECURE cleared on lock).

### test/support/test_app.dart (harness semantics tests rely on)
- `TestHarness.pump(tester, {configuredPin, settings = AppSettings(onboardingDone: true)})` boots the real `SilentSumApp` inside a `ProviderScope` overriding: `secureStoreProvider` → `InMemorySecureStore`; `keyDerivationProvider` → `Argon2idKeyDerivation(useIsolate: false)`; `kdfParamsProvider` → `KdfParams.forTests`; `fileCipherProvider` → `FileCipher(isolateThresholdBytes: 1<<30)`; `thumbnailGeneratorProvider` → `DartThumbnailGenerator(useIsolate: false)`; `vaultRootDirectoryProvider` → `<systemTemp>/silentsum_widget_*/vault`; `settingsStoreProvider` → `InMemorySettingsStore(settings)`; `initialSettingsProvider` → `settings`; `clockProvider` → `FakeClock()`; `screenProtectionProvider` → `RecordingScreenProtection()`; `firebaseServicesProvider` → `FirebaseServices.unavailable`. If `configuredPin` is given, a vault is pre-created via `PinAuthService.setupPin` so the app starts past onboarding, locked.
- `TestHarness.defaultPin = '2468'`. `dispose()` deletes the temp dir.
- `tapCalculator(tester, keys)` taps widgets keyed `calc_key_<CalcKey.name>` for each char (`+ - * / = . C <` and digits via `CalcKey.digitKey(n)`).
- `settle(tester, {frames = 12})` pumps `frames` × (40 ms frame + 15 ms real delay) so async IO/crypto complete.
- `calculatorDisplay(tester)` reads the `Text` keyed `calc_display`.
- Lifecycle events are injected with `tester.binding.handleAppLifecycleStateChanged(state)`; time via `harness.clock.advance(...)`.

Equivalent RN tests should: (a) unit-test the pure policy with the same boundary values; (b) drive AppState `background`/`active` transitions with a fake monotonic clock and assert curtain visibility (inactive/background while unlocked), no lock at 20 s with a 1-minute timeout, lock + navigation to the calculator at 2 min, immediate lock for `immediately`, and re-unlock afterwards; (c) assert the recorded secure-flag calls contain `true` after unlock and end with `false` after lock; (d) assert settings defaults and JSON round-trip.

## UI flows

All settings-family screens share: `Scaffold` + `AppBar(title)` (left-aligned, flat), body `Center > ConstrainedBox(maxWidth: 640) > ListView`. `SettingsHeader(text)`: `Padding(16, 20, 16, 4)` with `textTheme.labelLarge` in `colorScheme.primary`.

### Settings (`/settings`, AppBar `Settings`)
1. Header `Vault`
2. ListTile key `settings_change_pin`, icon `pin_outlined`, title `Change PIN` → push `/settings/change-pin`
3. ListTile icon `timer_outlined`, title `Auto-lock`, subtitle = current option label (e.g. `After 1 minute`) → push `/settings/auto-lock`
4. ListTile icon `shield_outlined`, title `Security & privacy` → push `/settings/security`
5. Header `Cloud`
6. ListTile icon `cloud_outlined`, title `Cloud backup`, subtitle one of `Not available in this build` / `On — end-to-end encrypted` / `Off — photos stay on this device` (em dashes) → push `/settings/backup`
7. Header `App`
8. ListTile icon `info_outline`, title `About SilentSum` → push `/settings/about`
9. `Padding(16, 24, 16, 24)` > `FilledButton.tonalIcon` key `settings_lock`, icon `lock_outline`, label `Lock vault now` → locks; router redirects to `/`.

### Auto-lock (`/settings/auto-lock`, AppBar `Auto-lock`)
1. `Padding(16,16,16,8)` body text (bodyMedium): `When the app leaves the foreground, the vault locks after this delay. It always locks when the app is closed.`
2. Five `RadioListTile`s in enum order, keys `autolock_immediately`, `autolock_thirtySeconds`, `autolock_oneMinute`, `autolock_fiveMinutes`, `autolock_fifteenMinutes`; titles `Immediately`, `After 30 seconds`, `After 1 minute`, `After 5 minutes`, `After 15 minutes`; selected = current setting; tapping saves immediately (no confirm, no back navigation).

### Security & privacy (`/settings/security`, AppBar `Security & privacy`)
1. Header `Screen`
2. SwitchListTile key `security_screen_protection`, title `Block screenshots`, subtitle `Prevents screenshots, screen recording and app-switcher previews while the vault is open (Android). On iOS the vault is always hidden in the app switcher.` — bound to `screenProtection` (default on).
3. Header `Diagnostics`
4. SwitchListTile title `Send crash reports`; subtitle when Firebase available: `Anonymous crash reports via Firebase Crashlytics. They never include your PIN, photos or file names.`; otherwise `Inactive in this build (no Firebase configuration).` — bound to `crashReportsEnabled` (default on).
5. SwitchListTile title `Share usage statistics`; subtitle when available: `Off by default. Only coarse events such as "vault unlocked"; never content, never the advertising ID.`; otherwise `Inactive in this build (no Firebase configuration).` — bound to `analyticsEnabled` (default off).
6. Header `Danger zone`
7. ListTile key `security_erase`, leading `delete_forever_outlined` in `colorScheme.error`, title `Erase vault` in error colour, subtitle `Securely deletes every photo and the PIN on this device.` → erase dialog.

### Erase vault dialog (AlertDialog)
- Title `Erase vault?`
- Body: `Every photo in the vault and the vault PIN will be securely deleted from this device. This cannot be undone.` blank line, `Type ERASE to confirm.`
- 16 px gap, TextField key `erase_confirm_field`, autofocus, all-caps capitalization, hint `ERASE`.
- Actions: TextButton `Cancel` (returns false); FilledButton key `erase_confirm_button`, background `colorScheme.error` / foreground `onError`, label `Erase vault`, enabled only while the trimmed text equals `ERASE` (returns true).
- On confirm: vault locks, files + credentials are securely erased, backup flags cleared, SnackBar `Vault erased.`, navigate (replace) to `/` (calculator, now in first-run state).

### About (`/settings/about` real, `/about` disguised; AppBar `About`; ListView padding 16)
1. ListTile leading `lock_outline` (real) or `calculate_outlined` (disguised); title `SilentSum` or `Calculator`; subtitle `Version 0.1.0`.
2. Real only: 8 px gap, Card (padding 16) with `Security model` (titleMedium), 8 px gap, five lines:
   - `• Your PIN never leaves this device and is never stored.`
   - `• The PIN derives a key with Argon2id; that key unwraps a random vault key kept in the platform secure store.`
   - `• Every photo, thumbnail and the index are encrypted with XChaCha20-Poly1305 in app-private storage.`
   - `• Unlocking works fully offline. Cloud backup is optional and end-to-end encrypted with a separate passphrase.`
   - `• Failed attempts are throttled; there is no backdoor. Forgetting the PIN means the vault cannot be recovered.`
3. 8 px gap, ListTile leading `description_outlined`, title `Open source licenses` → platform license page with application name (real or disguised) and version `0.1.0`.

### Cloud backup (`/settings/backup`, AppBar `Cloud backup`)
**Explainer card** (shown at top in every state; Padding 16 > Card > Padding 16): title `How cloud backup works` (titleMedium), 8 px gap, lines:
- `• Off by default. Nothing leaves this device until you enable it.`
- `• Photos are uploaded exactly as stored here: already encrypted.`
- `• Your vault key is uploaded only inside an envelope locked with a recovery passphrase you choose. The passphrase is never uploaded.`
- `• Your PIN is never uploaded and is not linked to the account.`
- `• Without the passphrase, the backup is unreadable, including to the service operator.`
- `• The vault keeps working offline whether or not backup is on.`

**State A – Firebase unavailable** (`_NotAvailable`, Padding 24 > Column): explainer, then centred text `This build has no Firebase configuration, so cloud backup is not available. Everything else works fully offline. See docs/firebase-setup.md to enable it.`

**State B – available, signed out** (ListView bottom padding 32): explainer; `LinearProgressIndicator` if busy; then Padding 16 > Column(stretch): Header `Backup account`; text (h-pad 16, v-pad 4) `The account only identifies your backup. It is not your vault PIN and cannot open the vault.`; 8 px; TextField `Email` (email keyboard, no autocorrect); 12 px; TextField `Password` (obscured); 16 px; FilledButton `Sign in`; 8 px; OutlinedButton `Create account`. Buttons disabled while busy. Errors appear as SnackBars (see error table). On success password field is cleared and the view switches to State C via the auth stream.

**State C – signed in** (Column stretch): Header `Backup account`; ListTile leading `account_circle_outlined`, title = email (or uid if no email), trailing TextButton `Sign out`. Header `Status`; then:
- Loading: Padding 16 > `LinearProgressIndicator` (while `hasEnvelope()` resolves; re-queried after every action).
- Not enabled: text (v-pad 8) `Backup is not enabled for this account.`; FilledButton.icon key `backup_enable`, icon `cloud_upload_outlined`, label `Enable backup`.
- Enabled: text `Backup is enabled for this account.` optionally followed by ` Last backup: <Mon d, yyyy h:mm AM/PM>.`; FilledButton.icon key `backup_now`, icon `cloud_upload_outlined`, label `Back up now`; 8 px; OutlinedButton.icon icon `cloud_download_outlined`, label `Download missing photos`; 8 px; TextButton `Disable backup and delete cloud data`.

**Dialogs from this screen**
- Recovery passphrase dialog (title `Recovery passphrase`): enable flow shows intro `This passphrase protects your backup. It is never uploaded and cannot be reset: without it the backup is unreadable. Use at least 12 characters.`, field `Passphrase` (key `passphrase_field`, eye toggle), field `Confirm passphrase` (key `passphrase_confirm_field`); restore flow shows only `Passphrase`. Errors in error colour under the fields: `Use at least 12 characters.` / `Remove leading or trailing spaces.` / `The passphrases do not match.` Actions `Cancel`, `Continue`.
- Disable confirmation: title `Disable cloud backup?`, body `Every backed-up photo and the key envelope are deleted from the cloud. Photos on this device are not affected.`, actions TextButton `Cancel`, FilledButton `Disable`.

**SnackBars**: `Backup enabled. Use "Back up now" to upload your photos.` · `Uploaded N new photo(s) (T in the backup).` · `Restored N photo(s).` · `This backup belongs to a different vault. To restore it, erase this vault and choose "Restore from cloud backup" during setup.` · `Cloud backup disabled and cloud data deleted.` · any `describeCloudError` string. Each new SnackBar hides the previous one first.

### Privacy curtain (not a route)
Full-screen `surface`-coloured layer with a centred 72 px `calculate_outlined` glyph in `onSurfaceVariant`; appears over any unlocked screen whenever the app is inactive/backgrounded; disappears on resume (unless the resume locked the vault, in which case the calculator is shown instead).

## Security notes

- Auto-lock relies exclusively on a process-monotonic clock (Stopwatch), so changing the system clock in the background cannot defeat it; the session is memory-only, so any process restart starts locked regardless of the timeout ("It always locks when the app is closed").
- `immediately` is truly unconditional on resume-after-background (elapsed 0 locks) — except during a photo-picker round trip shorter than 5 minutes (AutoLockSuspension grace), a deliberate usability trade-off documented in docs/security.md.
- The calculator entry is wiped on every `inactive`/`paused`/`hidden`/`detached` so a half-typed PIN never appears in the app switcher; the curtain covers vault content while inactive; FLAG_SECURE (Android only) blocks screenshots/recording/recents thumbnails while unlocked and the setting is on. FLAG_SECURE is cleared on lock and when the user disables the switch, and is never set while locked.
- Decoded images are flushed from the engine image cache on every unlock→lock transition (RN: clear the image library's memory cache on lock).
- Crash/analytics: Crashlytics collection is manifest-disabled and only enabled at runtime from the persisted `crashReportsEnabled` (default true); Analytics and Ad-ID collection are manifest-disabled, analytics default off and additionally gated in-process (`logEvent` no-op while disabled). Every free-text string sent to Crashlytics passes `CrashReporter.scrub` (4–8 digit runs and file paths redacted); `FlutterErrorDetails.informationCollector` is dropped. Framework errors are only printed to the console in debug builds.
- Settings are non-secret and stored in plain shared_preferences; the vault's security never depends on them (turning `screenProtection` off weakens only capture resistance).
- Android hardening: minimal permissions (CAMERA, INTERNET), explicit removal of RECORD_AUDIO/storage/Ad-ID/install-referrer/GSERVICES permissions merged by plugins; `allowBackup=false`, `fullBackupContent=false`, data-extraction rules exclude every domain for cloud backup and device transfer; MainActivity is the only exported component (Firebase Auth/Google Sign-In exported activities and service removed), `taskAffinity=""`, no deep links; release builds minified + resource-shrunk.
- iOS: no FLAG_SECURE equivalent — mitigation is the curtain and auto-lock; file sharing and open-in-place disabled; usage-description strings avoid revealing the disguise only partially (they mention "private vault").
- Cloud backup UI never stores the passphrase; the recovered master key buffer is zeroed in a `finally`; comparison with the live master key is constant-time; error copy never echoes server messages (only codes).
- Erase requires typed `ERASE`, locks first, then securely deletes files and credentials, clears backup flags, and returns to the calculator.

## Open questions

- RN AppState has no `inactive` on Android (only iOS) and no `hidden`/`detached`. To reproduce the curtain during Android permission dialogs / app-switcher opening (Flutter `inactive` = Activity.onPause), the RN port needs a native hook (e.g. onWindowFocusChanged or onPause bridged as an event) or must accept that the curtain appears only on `background`. Decide which fidelity is required.
- Flutter's `inactive` never starts the background timer; only `paused`/`hidden`/`detached` do. On iOS, an `inactive` that never becomes `background` (control centre, incoming-call banner) therefore never locks. Confirm the RN port should mirror this (map only `background` to the timer, `inactive` to curtain-only).
- Grace check uses strict `<` (5 min) while the policy uses `>=`; at exactly 5 min of picker absence the policy applies. Also the suspension counter is never reset on lock/erase — harmless today because ImportService balances it in a finally, but any new suspend caller must do the same.
- `SystemClock.monotonic()` is a process-lifetime Stopwatch, not OS uptime. On Android, when the OS kills the process in the background the session is lost anyway (always locked on restart), so this is fine; but an RN implementation using `performance.now()` should confirm it keeps advancing while the JS thread is suspended in the background (on some RN runtimes it does not — Date-based fallback would reintroduce clock tampering). Native `SystemClock.elapsedRealtime()` / `mach_absolute_time` is the safe equivalent.
- `setSecure` is never called at startup; if the app could ever start unlocked (it cannot today) FLAG_SECURE would be missing. Also toggling `screenProtection` while locked sends `setSecure(false)` (harmless).
- Diagnostics switches (`Send crash reports`, `Share usage statistics`) remain interactive when Firebase is unavailable and persist the value; the port should decide whether to disable them instead.
- `_NotAvailable` copy leaks a developer path (`See docs/firebase-setup.md to enable it.`) into the user-facing UI — keep for parity or drop?
- Cloud backup 'enabled' status comes from `service.hasEnvelope()` (cloud state), not from `settings.backupEnabled`; the Settings tile subtitle, however, reads `settings.backupEnabled`. These can disagree (e.g. after signing into a different account or after the envelope is deleted elsewhere).
- Last-backup formatting uses intl `DateFormat.yMMMd().add_jm()` with the intl default locale (not necessarily the device locale unless initialised elsewhere); the RN port should pick an explicit locale strategy.
- `RadioListTile(groupValue:)` API is deprecated in recent Flutter; irrelevant for RN but the behaviour (single-select list, immediate save) is what matters.
- Info.plist declares `NSPhotoLibraryUsageDescription` although PHPicker (image_picker on iOS 14+) does not require it; the RN port (expo-image-picker) may or may not need it depending on API used.
- `MainActivity.setSecure` replies `success(null)` before the UI-thread runnable executes; a race is theoretically possible if the Dart side immediately renders sensitive content, but in practice the flag is applied within the same frame. Decide whether the RN native module should apply synchronously on the UI thread before resolving.