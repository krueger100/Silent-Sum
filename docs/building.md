# Building

## Requirements

- Node 20 or newer (built with 22.14) and npm 10.
- Android: Android SDK with platform 36, JDK 17, an emulator or device on Android 8.0 (API 26) or
  newer.
- iOS: macOS with Xcode 16 and CocoaPods. Deployment target 16.4, the minimum Expo SDK 57 accepts.

`android/` and `ios/` are generated, not committed. `npx expo prebuild` writes them from
`app.config.ts`, so native configuration is changed there rather than by editing the native
projects by hand.

## Install and check

```bash
npm install
npm run typecheck
npm test
npm run lint
```

`npm run check` runs all three.

`npm install` runs `patch-package` afterwards. There are two patches, both in `patches/`, and
neither is optional.

`react-native-libsodium`'s CMake file is made to normalise `NODE_MODULES_DIR`; without it the
native build fails on Windows, where the path arrives with backslashes and CMake rejects the drive
prefix as an invalid escape. It is a no-op on Linux and macOS.

`expo-camera`'s Android module is made to capture from the camera on every device. Upstream,
`takePicture` checks `EmulatorUtilities.isRunningOnEmulator()` and, on an emulator, returns
`generateSimulatorPhoto(view.width, view.height)` instead of calling CameraX: a black rectangle the
size of the preview view with a small yellow timestamp in the corner, encoded as a PNG. The preview
stays live, so nothing looks wrong -- but the vault holds the only copy of what it stores, so a
placeholder is a lost photo. The patch removes the substitution and makes a capture with no camera
bound reject the promise rather than leave it unsettled. An emulator whose AVD has a working camera
backend now captures for real; `src/camera/__tests__/expoCameraCapturePath.test.ts` fails if an
install ever drops the patch. Do not skip the postinstall step.

That second patch needs one more thing to have any effect. Expo SDK 57 ships its own modules as
precompiled Android artifacts -- `expo-camera/local-maven-repo/.../expo.modules.camera-57.0.5.aar`
-- and autolinking prefers them over the Kotlin in `android/src`, so a patched source file is
compiled by nobody and the build succeeds while changing nothing. `package.json` therefore carries:

```json
"expo": { "autolinking": { "buildFromSource": ["expo-camera"] } }
```

which makes autolinking link `expo-camera` as a Gradle source project instead. A build that has
picked up the patch runs `:expo-camera:compileDebugKotlin` and prints `- expo-camera (57.0.5)`
without the package marker that flags a prebuilt artifact.

## Running

The app uses native modules that Expo Go does not bundle (libsodium, and Firebase when configured),
so it needs a development build rather than Expo Go.

```bash
npx expo prebuild
npx expo run:android
```

```bash
npx expo run:ios
```

After the first install, `npm run start:dev-client` is enough for JavaScript changes.

## Environments

`SILENTSUM_ENV=dev|prod` selects which Firebase config file `app.config.ts` looks for. It changes
nothing about the local vault. Copy `.env.example` to `.env` to set it and the optional Firebase
paths; every variable has a working default and none is required.

It also picks the **App Check provider**, which is the part that bites. `firebaseGateway.ts` reads
it and configures `playIntegrity` for `prod` and `debug` for anything else — and the default when
the variable is unset is `dev`. A debug-provider build on a real device mints an App Check token
nobody has registered, so every callable is refused: messaging, the directory and billing all fail
for every user, while Firestore reads keep working and make it look like an app bug rather than a
build one. Version 3 shipped to closed testing exactly this way.

Nothing warns you at build time, at upload time, or on first launch. So `plugins/withAppCheckEnvGuard.js`
makes `:app:bundleRelease` **fail** unless `SILENTSUM_ENV=prod`. `assembleRelease` is deliberately
left alone: a dev-environment release APK is how this project tests on an emulator, where Play
Integrity cannot attest at all.

`SUPPORT_ENDPOINT`, `SUPPORT_FROM` and `SUPPORT_TO` turn on the customer service screen; with any of
them empty the screen says support is not set up in this build.

`SUPPORT_ENDPOINT` is the deployed `silentsumSupportRelay` function, never a mail provider. The
provider's API key is held by that function through Secret Manager, and the app sends no credential
at all — everything in `extra` is readable in the shipped bundle, so a bearer token there would be
published with every build. Pointing the endpoint at a provider's own host is refused outright by
`src/support/supportConfig.ts`, and `npm run security:scan` fails if `app.config.ts` starts reading a
key again. The relay needs `SILENTSUM_SUPPORT_FROM` and `SILENTSUM_SUPPORT_TO` in `functions/.env`
and `RESEND_API_KEY` in Secret Manager; see `firebase/README.md`.

On a dev-client build these values come from the Metro manifest, so restarting
`npm run start:dev-client` with different values is enough - no native rebuild.

## Release build

```bash
npx expo run:android --variant release
```

or, from `android/`, `./gradlew assembleRelease`. Release builds are R8-minified with resource
shrinking, configured through the `expo-build-properties` plugin.

For Play, build an app bundle instead — **with `SILENTSUM_ENV=prod`**, or the build is refused:

```bash
SILENTSUM_ENV=prod ./gradlew bundleRelease
```

which writes `android/app/build/outputs/bundle/release/app-release.aab`. The variable is not
optional here and the plain `./gradlew bundleRelease` this file used to give is what put a
debug-App-Check build on Play as version 3; see **Environments** above for why, and
`plugins/withAppCheckEnvGuard.js` for the guard that now stops it.

Gradle does not treat `SILENTSUM_ENV` as a task input, so a tree whose last build was the other
environment can hand you a **stale JS bundle** that ignores the variable entirely. Before an upload
build, delete `android/app/build/generated/assets/react/release` and
`android/app/build/intermediates/assets/release/mergeReleaseAssets`, then check the artifact really
carries what you asked for — `base/assets/app.config` inside the `.aab` is plain JSON and states
`silentsumEnv` outright.

### Signing

Expo's template signs the release build with `debug.keystore`. That is not a placeholder to fix
later: Play rejects a debug-signed upload, and `debug.keystore` is the same key in every React
Native checkout, so anything it signs can be replaced by anybody. `plugins/withReleaseSigning.js`
replaces it, and makes `assembleRelease`/`bundleRelease` **fail** when no real key is configured
rather than hand you an artifact that is only refused at upload.

Copy `keystore.properties.example` to `keystore.properties` in the **project root** — not
`android/`, which `expo prebuild` deletes — and fill in `storeFile`, `storePassword`, `keyAlias` and
`keyPassword`. `storeFile` may be absolute or relative to the project root. For CI, leave the file
out and set `SILENTSUM_KEYSTORE_FILE`, `SILENTSUM_KEYSTORE_PASSWORD`, `SILENTSUM_KEY_ALIAS` and
`SILENTSUM_KEY_PASSWORD` instead.

Generate one with the JDK's own tool:

```bash
keytool -genkeypair -v -keystore silentsum-release.jks -alias silentsum \
  -keyalg RSA -keysize 4096 -validity 10000
```

Keystores and `keystore.properties` are git-ignored, and `npm run security:scan` fails if either is
committed. **Back the keystore up somewhere you will still have in five years**: Play will not accept
an app signed with a different upload key without a key reset, and a reset needs the working key to
request.

`npm run security:scan` also re-checks the generated `android/app/build.gradle` whenever one exists,
so a stale prebuild that reintroduces debug signing is caught before a build rather than after.

## Building on EAS

`eas.json` has two profiles. `production` is `distribution: store` with
`android.buildType: app-bundle`, so it runs `:app:bundleRelease` and produces the `.aab` Play wants;
`development` is an internal-distribution `.apk` with the dev client.

```bash
npx eas-cli@latest build --platform android --profile production
```

`cli.appVersionSource` is **`local`** on purpose, against EAS's own recommendation of `remote`.
Remote means EAS stores and increments `versionCode` on its servers and ignores what the app config
says, which would make the value in `app.config.ts` decoration. Here `app.config.ts` stays the
source of truth, at the cost of bumping it by hand for every upload (see Versioning below).

Three things about EAS differ from a local build, and all three have bitten this project:

- **`android/` is git-ignored, so EAS does not receive it** and runs prebuild remotely instead. The
  config plugins therefore run on EAS, including `withReleaseSigning`.
- **EAS signs the release itself.** It writes `android/app/eas-build.gradle` with its own
  `signingConfigs.release` and applies it from `build.gradle`. `withReleaseSigning` detects
  `EAS_BUILD=true` and stands down: it installs no failure guard and assigns no `signingConfig`, so
  the two do not fight. Without that, every EAS build would stop for want of a `keystore.properties`
  that cannot exist in a remote workspace.
- **The archive is decided by git.** Anything git-ignored is absent from the build, and anything
  uncommitted is not in it either. That includes `.env` and `config/firebase/google-services.*.json`,
  which the app config reads to decide whether Firebase is compiled in at all. A build that does not
  receive them produces an app with **no Firebase**: no cloud backup, billing, messaging or support.
  `npm run eas:env` closes that gap (below). `SILENTSUM_ENV` is already set per profile in `eas.json`.

### The configuration git does not carry

```bash
npm run eas:env             # show what would be set, and check every source is present
npm run eas:env -- --apply  # set it
```

Five variables in the EAS `production` environment, read from the files that already hold them so
there is nothing to transcribe and nothing to keep in step:

| Variable                  | Type   | Visibility | From                                        |
| ------------------------- | ------ | ---------- | ------------------------------------------- |
| `GOOGLE_SERVICES_JSON`    | file   | sensitive  | `config/firebase/google-services.prod.json` |
| `FIREBASE_STORAGE_BUCKET` | string | plaintext  | `.env`                                      |
| `SUPPORT_ENDPOINT`        | string | plaintext  | `.env`                                      |
| `SUPPORT_FROM`            | string | plaintext  | `.env`                                      |
| `SUPPORT_TO`              | string | plaintext  | `.env`                                      |

A **file** variable is stored by EAS and written to disk during the build, with the variable set to
the path it wrote. `app.config.ts` resolves it with `resolve(__dirname, value)`, which returns an
absolute path unchanged, so nothing in the app had to change to accept it.

The list is closed on purpose. `eas env:push` would upload every key `.env` grows later, including
ones that should stay on one machine. A missing source stops the whole run rather than configuring
half of it: a half-configured build is still wrong, with fewer clues why.

`--force` is deliberately not passed, so re-running will not silently overwrite a variable somebody
set by hand in the dashboard. Add it yourself if that is what you want.

iOS is not covered: `GOOGLE_SERVICES_PLIST` would need the same treatment, and the iOS project has
never been compiled (see below).

`credentialsSource: "local"` on the production profile makes EAS use the same keystore as a local
release build, read from `credentials.json` in the project root. That file holds the same four values
as `keystore.properties`, so it is **generated** rather than maintained:

```bash
npm run eas:credentials
```

`keystore.properties` stays the only copy anyone edits. Keeping two by hand is a silent trap: they
can disagree, and the way you find out is an EAS build that succeeds and produces an artifact Play
then rejects for being signed with the wrong key.

The script resolves credentials exactly as the Gradle plugin does — properties file first, then
`SILENTSUM_KEYSTORE_*` from the environment — refuses to write if `credentials.json` is not
git-ignored, and prints no value. What it does print is the keystore path, the key alias and the
certificate's SHA-256 fingerprint, read back through `keytool` with the password supplied on stdin
rather than the command line. The fingerprint is public — Play displays it — and it is the cheap way
to learn that an alias or password is wrong before a build spends twenty minutes finding out. It is
also what you register as the upload key in Play Console.

Removing the `credentialsSource` line would let EAS generate and hold a keystore instead — simpler,
but then locally built and EAS-built artifacts are signed with different keys, and only whichever
signs the first Play upload can ever sign another. Failing loudly on missing credentials is the safer
default, which is why it is set.

Both `keystore.properties` and `credentials.json` are git-ignored and are _expected_ to exist on a
machine that builds. `npm run security:scan` therefore fails only when git **tracks** one, not when
one is merely present.

## Native modules that need a prebuild

`expo-video` (playback) and `expo-video-thumbnails` (poster frames) are autolinked like any other
Expo module, but `expo-video`'s config plugin also decides what goes in the manifest. It is
configured with `supportsBackgroundPlayback: false` and `supportsPictureInPicture: false`, which is
a security setting rather than a preference -- a PiP window is drawn by the system outside the app,
where `FLAG_SECURE` does not reach (docs/security.md). After changing either, run
`npx expo prebuild --platform android` and confirm the generated `AndroidManifest.xml` has no
`supportsPictureInPicture` on `MainActivity` and still carries
`android.permission.RECORD_AUDIO ... tools:node="remove"`.

## Permissions

The final Android permission set is `CAMERA` and `INTERNET`. Video recording does not add
`RECORD_AUDIO`: recordings are silent by design, so the camera is opened with `mute` and the
permission stays blocked. `app.config.ts` explicitly blocks the
permissions that the camera, image picker and Firebase libraries would otherwise merge in: audio
recording, legacy and scoped media storage, media location, and the advertising-ID family. Verify
after a build with:

```bash
aapt2 dump permissions android/app/build/outputs/apk/release/app-release.apk
```

Internet is present because cloud backup and crash reporting are optional features. Nothing on the
unlock or vault path uses it.

## Building on a small system drive

Gradle caches and build outputs are large. On this machine they are kept off `C:` entirely:

- `GRADLE_USER_HOME` is set to `D:\gradle-home` as a user environment variable.
- `android/app/build` and `android/build` are directory junctions to `D:\silentsum-rn-build`:
  `New-Item -ItemType Junction -Path android\app\build -Target D:\silentsum-rn-build\app`.
  Gradle follows them transparently. **`expo prebuild` deletes `android/`**, so recreate the
  junctions after every prebuild.
- The native toolchains also write several gigabytes into `node_modules/*/android/build` and
  `.cxx`, which are on the system drive regardless. Deleting those directories reclaims the space
  and only costs a recompile.

Check free space before a first build; a full Android build needs several gigabytes. The release
build in particular needs more Gradle memory than Expo's default, which is why
`plugins/withGradleMemory.js` raises the daemon's heap and metaspace; without it R8 and the Kotlin
compiler fail partway through with `OutOfMemoryError: Metaspace`.

## iOS

The iOS project is fully configured in `app.config.ts`: bundle identifier, camera and photo-library
usage strings, file sharing disabled, and the export-compliance key set for standard encryption of
user data at rest. It has not been compiled, because this repository was produced on Windows.

## Icons and splash

Icons come from `assets/`. The splash screen is configured through the `expo-splash-screen` plugin
in `app.config.ts`.

## Versioning

Bump `version` in `app.config.ts` and `package.json` together. It is what users see.

`android.versionCode` in `app.config.ts` is the separate number Play actually compares, and it must
increase for **every** upload — including a re-upload of the same `version`. It is declared in
`app.config.ts` rather than left in `android/app/build.gradle` because prebuild regenerates that
file: a versionCode edited there silently returns to 1, and Play then refuses the upload as a
duplicate of one it already has.

## Continuous integration

```bash
npm ci && npm run typecheck && npm run lint && npm test
```

No secrets are needed for that pipeline. Add `google-services.json` from CI secrets only for builds
that must include Firebase.
