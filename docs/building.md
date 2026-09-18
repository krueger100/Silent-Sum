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

`SUPPORT_FROM` and `SUPPORT_TO` turn on the customer service screen; with either empty the screen
says support is not set up in this build. `SUPPORT_ENDPOINT` defaults to Resend's `/emails` and
can point at a relay of your own instead, which is the recommended arrangement: everything in
`extra`, `SUPPORT_API_KEY` included, is readable in the shipped bundle. See the note at the top of
`src/support/supportConfig.ts`. On a dev-client build these values come from the Metro manifest, so
restarting `npm run start:dev-client` with different values is enough - no native rebuild.

## Release build

```bash
npx expo run:android --variant release
```

or, from `android/`, `./gradlew assembleRelease`. Release builds are R8-minified with resource
shrinking, configured through the `expo-build-properties` plugin.

Signing: create `android/keystore.properties` (git-ignored) with `storeFile`, `storePassword`,
`keyAlias` and `keyPassword`, or let EAS manage credentials. Keystores are never committed; back
yours up, because Play will not accept a replacement.

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

Bump `version` in `app.config.ts` and `package.json` together.

## Continuous integration

```bash
npm ci && npm run typecheck && npm run lint && npm test
```

No secrets are needed for that pipeline. Add `google-services.json` from CI secrets only for builds
that must include Firebase.
