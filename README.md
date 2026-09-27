# SilentSum

A working calculator that hides an encrypted photo vault. Type your PIN on the keypad, press
equals, and the vault opens. Everything else about the app behaves exactly like a calculator.

This is the React Native and TypeScript implementation. The Flutter implementation in
`../silentsum_flutter` is the behavioural reference; the two share the same on-disk formats and key
hierarchy, and a test suite pins that compatibility byte for byte.

## What it does

- A real calculator: four operations with correct precedence, decimals, percent, sign toggle,
  backspace and clear.
- A private vault holding photos taken in-app or imported from the library, encrypted at rest.
- Offline authentication. Unlocking never needs a network, an account, or Firebase.
- Optional, opt-in, end-to-end-encrypted cloud backup.

## Security in one paragraph

The PIN is never stored, not even as a hash. It derives a key with Argon2id that unwraps a random
master key held in the Android Keystore or the iOS Keychain. Photos, thumbnails and the index are
XChaCha20-Poly1305 ciphertext in app-private storage, never in Pictures or DCIM. Wrong PINs are
throttled up to a one-hour lockout, and "forgot PIN" offers only a typed-confirmation erase, with
no backdoor. The vault auto-locks in the background, hides behind a privacy curtain in the app
switcher, and blocks screenshots on Android. Cloud backup, when explicitly enabled, uploads
ciphertext plus a key envelope locked by a separate recovery passphrase, so the server can never
decrypt anything.

Full detail, including the threat model and the known limitations, is in [docs/security.md](docs/security.md).

## Getting started

```bash
npm install
npm run check
npx expo prebuild
npx expo run:android
```

The app needs a development build rather than Expo Go, because it uses native libsodium. See
[docs/building.md](docs/building.md).

## Commands

| Command | What it does |
| --- | --- |
| `npm run check` | typecheck, lint, security scan and test |
| `npm test` | Jest suite |
| `npm run typecheck` | TypeScript, no emit |
| `npm run lint` | ESLint |
| `npm run security:scan` | layering and secret checks a type checker cannot make |
| `npm run test:functions` | the billing backend's Jest suite (`functions/`) |
| `npm run typecheck:functions` | TypeScript for the backend |
| `npm run android` | prebuild if needed, then build and install the debug app |
| `npm run android:release` | release variant, minified |
| `npm run ios` | same on macOS |
| `npm run prebuild:clean` | regenerate `android/` and `ios/` from scratch |

## Layout

```
src/app          composition root, providers, controllers, theme
src/calculator   engine, keypad, display, unlock controller
src/auth         PIN policy, throttle, credentials, authenticator, session, PIN screens
src/vault        photo model, encrypted index, repository, thumbnails, paths
src/crypto       libsodium adapter, Argon2id, key wrapping, HKDF, SSV1 container
src/storage      file-system abstraction, atomic write, secure delete
src/gallery      grid, tile, viewer, import
src/camera       capture
src/backup       envelope, backup service, backup and restore screens
src/billing      Pro and Cloud: products, entitlements, offline mirror, plans screen, gates
src/firebase     optional remote layer behind interfaces (incl. the callable client)
functions/       Cloud Functions: PayMongo checkout + webhook -> Firestore entitlements
src/privacy      auto-lock, lifecycle guard, curtain, screen protection
src/settings     settings model, store, settings screens
firebase/        Firestore and Storage security rules
docs/            architecture, security, building, Firebase setup
```

[docs/architecture.md](docs/architecture.md) explains the dependency rules and why the vault is
testable without any native module.

## Firebase

Entirely optional and off unless configured. Nothing on the unlock path touches it, and a build
with no Firebase config contains no Firebase native initialisation at all. Setup instructions are
in [docs/firebase-setup.md](docs/firebase-setup.md). No secrets are committed; the config files are
git-ignored.

## Pro and Cloud

SilentSum Pro (₱299 once, permanent: unlimited items and video) and SilentSum Cloud (₱99 per
30-day term: encrypted backup, restore and cloud services) are sold through PayMongo from the
Cloud Functions in `functions/`; the app never holds a payment key and never decides what it
owns. See [docs/billing.md](docs/billing.md).

## Platforms

Android and iOS. The iOS project is configured but has not been compiled, because this repository
was produced on Windows.

## Licence

See [LICENSE](LICENSE).
