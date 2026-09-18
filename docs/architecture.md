# Architecture

## Shape

```
src/
  app/            composition root, React providers, controllers, theme
  calculator/     pure engine, unlock controller, keypad and display
  auth/           PIN policy, throttle, credential record, PinAuthService, session, PIN screens
  vault/          item model (photos + videos), encrypted index, repository, thumbnails,
                  video poster frames, decrypted cache, playback scratch, paths
  crypto/         libsodium adapter, Argon2id, key wrapping, HKDF key hierarchy, SSV1 container
  secure-storage/ SecureStore interface, expo-secure-store adapter, in-memory fake
  storage/        FileSystem interface, expo adapter, in-memory fake, atomic write, secure delete
  camera/         capture sheet (stills and silent video), review, and capture inspection
  gallery/        grid, tile, viewer, video surface, import service
  firebase/       interfaces, availability gateway, Crashlytics/Analytics/cloud adapters, fakes
  backup/         envelope, BackupService, passphrase policy, backup and restore screens
  privacy/        auto-lock policy, suspension, lifecycle guard, curtain, screen protection
  settings/       settings model, stores, settings screens
  support/        customer service: message shape, scrub-on-send, Resend/relay transport
  navigation/     session-gated navigator
  components/     shared UI primitives
  utils/          bytes, base64, clock, ISO-8601
```

## Dependency direction

`screens -> services (interfaces) -> adapters`

UI never imports libsodium, expo-secure-store, expo-file-system or Firebase. It receives everything
through `ServicesProvider`. Every platform-facing capability has an interface and an in-memory
fake, which is what lets tests boot real screens against fakes with no native modules involved.

`src/crypto/sodium.ts` is the single file that imports the libsodium binding. Under Jest that
module name is mapped to a shim backed by `libsodium-wrappers-sumo`, so tests exercise the same
function names, argument order and output bytes as the device.

## The composition root

`createServices()` in `src/app/services.ts` builds one object holding the clock, CSPRNG, KDF, key
wrapping, file cipher, file system, secure store, thumbnail generator, screen protection,
authenticator, session, vault controller, settings controller, Firebase services, the support
service and the backup service. Tests call the same function with overrides. There is no module-level singleton, so test
cases cannot leak state into one another.

## Session and key lifetime

`VaultSession` holds the key material in a private field that is deliberately **not** part of any
observable state, so no selector, devtool or serialiser can reach it. Components observe only the
boolean `isUnlocked`.

`VaultController` ties the repository's lifetime to the session. Locking disposes the keys, closes
the repository and wipes its decrypted caches. Screens ask for the repository through
`requireRepository()`, which throws when locked: a screen that is somehow still mounted after a
lock fails loudly instead of rendering stale plaintext. UI visibility is never the security
boundary.

## State management

Vanilla Zustand stores, created per services instance rather than as module globals, exposed to
React through `useStore`. Policies and the calculator engine are pure functions with no store
involvement at all, which is why they are exhaustively testable.

## Navigation

React Navigation native-stack, gated on session state. The vault stack is only mounted while the
session is unlocked, so there is no route, deep link or back-stack entry that leads into vault
screens, and locking unmounts them rather than covering them.

Android exports exactly one activity, the launcher. Nothing vault-related is reachable from another
app.

## Firebase isolation

Only `src/firebase/*` imports `@react-native-firebase/*`, and only inside lazily evaluated
functions, so a missing native module cannot crash startup or the test run.
`initializeFirebase(env)` never throws and never rejects: it returns the services object or a
sentinel meaning "unavailable", in which case crash reporting and analytics are no-ops and the
cloud backend is null. `app.config.ts` only adds the Firebase config plugins when the native config
files exist, so a build without them contains no Firebase native initialisation at all.

The vault and the authenticator have no compile-time or runtime dependency on any of this.

## Enforcement

`npm run security:scan` fails the build on the mistakes a type checker cannot see: an import of
libsodium, Firebase or expo-secure-store from outside its owning module, a key-shaped string or a
credential file committed to the repository, a reference to the OS media library from vault code,
a Resend API key in tracked source, any network client reachable from the offline authentication
path, and any reach for the network from outside `src/firebase` and `src/support` - the two
modules allowed to talk to a server. It runs as part of `npm run check`.

## Testing

Unit tests cover the calculator engine, PIN policy, throttle, KDF parameter bounds, key wrapping,
the SSV1 container, secure delete, atomic writes, settings parsing, the authenticator, the
repository, the backup service and the auto-lock policy. A dedicated suite pins byte compatibility
with the Flutter implementation. Component tests boot real screens against in-memory fakes. No test
initialises Firebase or touches a real native module.
