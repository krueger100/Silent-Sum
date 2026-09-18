# Flutter reference: authentication

_authentication (SilentSum Flutter): PinAuthService, VaultCredentials, KdfParams/Argon2id, KeyWrapping (XChaCha20-Poly1305), VaultKeys (HKDF), AttemptThrottle, PinPolicy, VaultSession/Controller, VaultStatus, VaultEraser, and the auth UI (welcome sheet, PIN setup/change screen, keypad, forgot-PIN dialog, erase dialog) plus the calculator unlock entry point_

Files read: C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/authentication/pin_auth_service.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/authentication/vault_credentials.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/authentication/auth_models.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/authentication/vault_session.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/authentication/vault_status.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/authentication/vault_session_controller.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/authentication/vault_eraser.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/authentication/pin_keypad.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/authentication/erase_vault_dialog.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/authentication/forgot_pin_dialog.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/authentication/welcome_sheet.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/authentication/pin_setup_screen.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/security/attempt_throttle.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/security/pin_policy.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/security/key_derivation.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/security/key_wrapping.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/security/vault_keys.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/security/secure_random.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/security/byte_utils.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/security/secure_delete.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/storage/secure_store.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/storage/flutter_secure_store.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/storage/settings_store.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/clock.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/firebase/analytics_service.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/app/providers.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/app/router.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/calculator/calculator_controller.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/calculator/calculator_screen.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/calculator/calculator_engine.dart (lines 270-300), C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/settings/security_screen.dart (lines 40-110), C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/gallery/gallery_screen.dart (lines 270-320), C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/backup/restore_flow_screen.dart (lines 55-110), C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/test/features/authentication/pin_auth_service_test.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/test/features/authentication/pin_setup_flow_test.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/test/core/security/attempt_throttle_test.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/test/core/security/pin_policy_test.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/test/core/security/key_derivation_test.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/test/core/security/key_wrapping_test.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/test/support/test_app.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/docs/security.md, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/docs/architecture.md, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/pubspec.yaml / pubspec.lock (cryptography 2.9.0, flutter_secure_storage ^10.3.3)

## Behaviour

# 0. Crypto primitives and libraries (what must be matched bit-for-bit)

Reference implementation uses `package:cryptography 2.9.0` (pure Dart). Equivalent RN primitives: libsodium (`crypto_pwhash` Argon2id v1.3, `crypto_aead_xchacha20poly1305_ietf` detached), any RFC 5869 HKDF-SHA256.

| Primitive | Exact parameters |
|---|---|
| Random | OS CSPRNG (`Random.secure()`), each byte = `nextInt(256)`. `hexId(n=16)` = lower-case hex of n random bytes. |
| Argon2id | RFC 9106 Argon2id, version 0x13. `memory` in KiB (block count), `iterations` = passes, `parallelism` = lanes, `hashLength` = 32 (tag length). Secret = UTF-8 bytes of the PIN string. Salt ("nonce" in the Dart API) = the stored 16-byte salt. No secret key (K) and no associated data (X) inputs. Runs on a background thread/isolate in production (`useIsolate=true`), inline in tests. |
| AEAD | XChaCha20-Poly1305 IETF (HChaCha20 + ChaCha20-Poly1305 per RFC 8439 with 24-byte nonce). Key = 32-byte KEK. Nonce = 24 random bytes generated fresh at every wrap by the library. Tag = 16 bytes, stored DETACHED (ciphertext and MAC are separate fields). AAD = UTF-8 of the label string (see 3). |
| HKDF | HKDF-SHA256 (RFC 5869), salt = EMPTY (equivalent to 32 zero bytes because HMAC zero-pads), output length 32, info = UTF-8 label (see 4). |
| Byte helpers | `zeroBytes(buf)`: overwrite every byte with 0. `constantTimeEquals(a,b)`: false if lengths differ, else OR-accumulate XOR of every byte, true iff 0. `concatBytes(parts)`: simple concatenation. |

# 1. PIN policy (`PinPolicy`)

Constants: `minLength = 4`, `maxLength = 8`, digit regex `^[0-9]+$`.

`validate(pin)` returns the FIRST matching error in this order, or null if valid:
1. `pin` is empty OR does not fully match `^[0-9]+$` → `notDigits`
2. `pin.length < 4` → `tooShort`
3. `pin.length > 8` → `tooLong`
4. `pin` starts with `'0'` → `leadingZero`

`isValid(pin) = validate(pin) == null`. `looksLikePin(text) = isValid(text)` (used by the calculator engine to decide whether `=` is an unlock attempt).

`describe(error)` (exact user copy):
| error | text |
|---|---|
| tooShort | `Use at least 4 digits.` |
| tooLong | `Use at most 8 digits.` |
| notDigits | `Use digits only.` |
| leadingZero | `The PIN cannot start with 0, because the calculator drops leading zeros.` |

`InvalidPinException(error)`: `.message = PinPolicy.describe(error)`, `toString() = 'InvalidPinException: <message>'`.

# 2. Argon2id parameters (`KdfParams`)

Fields: `memoryKiB:int`, `iterations:int`, `parallelism:int`, `hashLength:int = 32`. Value equality on all four fields.

Presets:
| name | memoryKiB | iterations | parallelism | hashLength | use |
|---|---|---|---|---|---|
| `defaults` | 32768 (32 MiB) | 3 | 1 | 32 | vault PIN (production) |
| `backup` | 65536 (64 MiB) | 3 | 1 | 32 | cloud recovery passphrase |
| `forTests` | 256 | 1 | 1 | 32 | tests only, never production |

JSON (`toJson`): `{"alg":"argon2id","m":<memoryKiB>,"t":<iterations>,"p":<parallelism>,"len":<hashLength>}` — key order alg, m, t, p, len.

`fromJson` validation, in order (each failure throws `FormatException` with the given message):
1. `alg` must equal `"argon2id"` else `Unsupported KDF <alg>`.
2. `m`, `t`, `p` are required numbers (cast to int); `len` optional, default 32.
3. `p < 1 || p > 4` (`maxParallelism = 4`) → `parallelism <p> out of range`.
4. `m < 8*p || m > 262144` (`maxMemoryKiB = 256*1024`) → `memory <m> out of range`.
5. `t < 1 || t > 10` (`maxIterations = 10`) → `iterations <t> out of range`.
6. `len != 32` → `hash length <len> unsupported`.

Bounds exist so a stored/downloaded record cannot force a huge allocation. `KeyDerivation.deriveKey({secret, salt, params}) -> 32 bytes`.

# 3. Key wrapping (`KeyWrapping`, `WrappedKey`)

AAD label constants: `vaultAad = "silentsum/vmk/v1"` (default for wrap/unwrap), `backupAad = "silentsum/backup-envelope/v1"`.

`wrap(key, kek, aad=vaultAad)`: XChaCha20-Poly1305 encrypt `key` under `kek` with a fresh random 24-byte nonce and AAD = utf8(aad). Returns `WrappedKey{nonce(24), cipherText(len(key) = 32 for the master key), mac(16)}`.

`unwrap(wrapped, kek, aad=vaultAad)`: decrypt; on authentication failure throw `WrongKeyException` (toString `WrongKeyException`, carries no detail). Any other error (e.g., bad key length) propagates unchanged.

`WrappedKey` JSON: `{"nonce":<b64>,"ct":<b64>,"mac":<b64>}`. Constants `nonceLength = 24`, `macLength = 16`, `maxCipherTextLength = 1024`. `fromJson`: base64-decode all three, then check in order: nonce length != 24 → `FormatException('bad nonce length')`; mac length != 16 → `FormatException('bad mac length')`; ct empty or > 1024 → `FormatException('bad ciphertext length')`.

Base64 everywhere = standard alphabet (`+`, `/`) WITH `=` padding (Dart `base64Encode`). Dart's decoder also tolerates the URL-safe alphabet; emit padded standard base64 for compatibility.

# 4. Vault key hierarchy (`VaultKeys`, `VaultKeyId`)

`masterKeyLength = 32`. `VaultKeys.derive(master)`: if `master.length != 32` throw `ArgumentError('master key must be 32 bytes')`. Copies `master` BEFORE any await (callers zero their buffer in `finally`). Derives three subkeys with HKDF-SHA256, empty salt, output 32, info strings:

| VaultKeyId | code (byte in file header) | info |
|---|---|---|
| photo | 1 | `silentsum/photo/v1` |
| thumb | 2 | `silentsum/thumb/v1` |
| manifest | 3 | `silentsum/index/v1` |

`fromCode(int)` → id or null. Accessors: `masterKey`, `keyFor(id)` return the LIVE buffers (not copies); after `dispose()` they throw `StateError('VaultKeys used after dispose')`. `isDisposed` flag. `dispose()` is idempotent: sets flag, zeroes master, photo, thumb, index buffers. The master key is only ever used for wrapping (PIN change, backup envelope), never for file encryption.

# 5. Secure store

Interface `SecureStore { read(key)->String?; write(key,value); delete(key); containsKey(key) }` storing small strings.

Keys (`SecureStoreKeys`):
- `vaultCredentials = "silentsum.vault.credentials.v1"`
- `throttleState = "silentsum.vault.throttle.v1"`
- `all = [vaultCredentials, throttleState]` (erase iterates this list in this order).

Platform config (flutter_secure_storage 10.x): Android `AndroidOptions(resetOnError: false)` — a keystore failure must surface as an error, never silently wipe; iOS `KeychainAccessibility.first_unlock_this_device`, `synchronizable: false` (never iCloud-synced, never migrates devices). RN equivalents: react-native-keychain `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` / expo-secure-store `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, no cloud sync.

# 6. VaultCredentials (the persisted record)

Fields: `version:int = 1`, `salt: bytes(16)`, `kdf: KdfParams`, `wrappedMasterKey: WrappedKey`, `pinLength:int`, `createdAt: DateTime (UTC)`.

`toJson()` (exact key order):
```
{
  "v": 1,
  "salt": "<base64 of 16 bytes>",
  "kdf": {"alg":"argon2id","m":32768,"t":3,"p":1,"len":32},
  "wrapped": {"nonce":"<b64 24B>","ct":"<b64 32B>","mac":"<b64 16B>"},
  "pinLength": 4,
  "createdAt": "2026-01-01T12:00:00.000Z"
}
```
`createdAt` = `createdAt.toUtc().toIso8601String()` → `yyyy-MM-ddTHH:mm:ss.mmmZ` (Dart appends 6-digit fraction if microseconds are non-zero; parser accepts both). `encode()` = `jsonEncode(toJson())` (compact, no whitespace). `decode(raw)` = `fromJson(jsonDecode(raw) as Map)`.

`fromJson` validation, in order:
1. `v` = number or absent → default 1; if `!= 1` throw `FormatException('Unsupported credentials v<version>')`.
2. `salt` = base64Decode(`salt` string); length must be in [8, 64] else `FormatException('bad salt length')`.
3. `pinLength` = number → int; must be in [4, 8] else `FormatException('bad pin length')`.
4. `kdf` = `KdfParams.fromJson(json['kdf'])` (see 2).
5. `wrapped` = `WrappedKey.fromJson(json['wrapped'])` (see 3).
6. `createdAt` = `DateTime.parse(json['createdAt'])`.
Type mismatches (e.g., `salt` is a number, or the top-level JSON is an array) throw `TypeError`; invalid base64/dates throw `FormatException`. All are mapped to `CredentialsUnreadableException` by the service.

# 7. Attempt throttle (`ThrottleState`, `AttemptThrottle`) — pure logic

`ThrottleState { failedCount:int = 0, lockedUntil: DateTime? , lastFailureAt: DateTime? }`; `initial` = (0, null, null). Value equality on all three fields; `toString` = `ThrottleState(failed=<n>, lockedUntil=<dt>, lastFailureAt=<dt>)`.

JSON: `{"failedCount":<int>,"lockedUntil":<UTC epoch ms | null>,"lastFailureAt":<UTC epoch ms | null>}`. `fromJson`: `failedCount` from number or 0; timestamps parsed as UTC epoch millis only when the value is a number, else null. `fromJson({})` == `initial`.

`delayAfter(failedCount)` (delay imposed after the N-th consecutive failure):
| N | delay |
|---|---|
| 0, 1, 2 | 0 |
| 3 | 5 s |
| 4 | 15 s |
| 5 | 30 s |
| 6 | 60 s |
| 7 | 5 min |
| 8 | 10 min |
| 9 | 20 min |
| 10 | 40 min |
| >= 11 | 60 min (cap) |
Formula for N >= 7: `doublings = clamp(N-7, 0, 10)`, `minutes = 5 * 2^doublings`, result `clamp(minutes, 5, 60)` minutes. Nothing is ever wiped automatically.

`remaining(state, now)`:
1. If `lastFailureAt != null && now.toUtc() < lastFailureAt` (wall clock moved backwards) → return `delayAfter(state.failedCount)` — i.e., the FULL current delay, re-evaluated on every call, so the lock does not expire until the clock passes `lastFailureAt` again (with failedCount <= 2 this is 0, so no lock).
2. Else if `lockedUntil == null` → 0.
3. Else `left = lockedUntil - now.toUtc()`; return `max(left, 0)`.

`isLocked(state, now) = remaining(state, now) > 0`.

`recordFailure(state, now)`: `count = failedCount + 1`; `delay = delayAfter(count)`; `utc = now.toUtc()`; returns `ThrottleState(failedCount: count, lockedUntil: delay == 0 ? null : utc + delay, lastFailureAt: utc)`.

`recordSuccess()` → `initial`.

# 8. Clock

`Clock { now(): DateTime (wall clock, user-editable); monotonic(): Duration (process uptime, only moves forward) }`. `SystemClock.monotonic()` = elapsed of a process-wide Stopwatch started at first use. `FakeClock(start = 2026-01-01 12:00 local)`: `advance(d)` moves both; `setNow(dt)` moves only the wall clock.

# 9. PinAuthService

Construction: `store`, `kdf`, `wrapping`, `clock`, optional `random` (default `SecureRandomSource()`), `kdfParams` (default `KdfParams.defaults`), `throttle` (default `AttemptThrottle()`). Constant `saltLength = 16`. Private in-memory field `_monotonicLockedUntil: Duration?` (monotonic deadline; complements the persisted wall-clock deadline so editing the system time while the app runs cannot shorten a lockout; lost on process restart).

9.1 `loadCredentials() -> VaultCredentials?`
1. `raw = store.read("silentsum.vault.credentials.v1")`; ANY exception → throw `CredentialsUnreadableException(cause)`.
2. `raw == null` → return null.
3. `VaultCredentials.decode(raw)`; `FormatException`, `TypeError`, `ArgumentError` → throw `CredentialsUnreadableException(cause)`.

9.2 `isConfigured() = loadCredentials() != null` (propagates CredentialsUnreadableException). `configuredPinLength() = loadCredentials()?.pinLength`.

9.3 `throttleState() -> ThrottleState` (FAILS OPEN): read `"silentsum.vault.throttle.v1"`; read exception → `initial`; null → `initial`; `ThrottleState.fromJson(jsonDecode(raw))`; `FormatException`/`TypeError` → `initial`.

9.4 `_remaining(state)`: `wall = throttle.remaining(state, clock.now())`; `mono = _monotonicLockedUntil == null ? 0 : max(_monotonicLockedUntil - clock.monotonic(), 0)`; return `max(wall, mono)`. `remainingLockout() = _remaining(await throttleState())`.

9.5 `_deriveKek(pin, salt, params)`: `secret = utf8(pin)`; `kdf.deriveKey(secret, salt, params)`; finally `zeroBytes(secret)`.

9.6 `_wrapMaster(master, pin) -> VaultCredentials`: `salt = random.bytes(16)`; `kek = _deriveKek(pin, salt, THIS SERVICE's kdfParams)`; try `wrapped = wrapping.wrap(master, kek)` (AAD `silentsum/vmk/v1`); return `VaultCredentials(salt, kdf: kdfParams, wrappedMasterKey: wrapped, pinLength: pin.length, createdAt: clock.now().toUtc())`; finally `zeroBytes(kek)`. Note: a fresh salt and fresh nonce every time; params come from the service (so a PIN change silently upgrades stored params to the current defaults).

9.7 `_tryUnwrap(c, pin) -> master | null`:
1. If `pin.length != c.pinLength || !PinPolicy.isValid(pin)` → return null WITHOUT running Argon2id (counted as a wrong PIN by the caller).
2. `kek = _deriveKek(pin, c.salt, c.kdf)` (STORED params).
3. try `wrapping.unwrap(c.wrappedMasterKey, kek)` → master; `WrongKeyException` → null; ANY other exception → throw `CredentialsUnreadableException(e)` (corrupt record is not a wrong PIN and is not counted); finally `zeroBytes(kek)`.

9.8 `setupPin(pin) -> VaultKeys`
1. `PinPolicy.validate(pin)` non-null → throw `InvalidPinException(error)`.
2. `isConfigured()` true → throw `StateError('A vault PIN already exists')` (an unreadable record propagates `CredentialsUnreadableException`).
3. `master = random.bytes(32)`.
4. try: `credentials = _wrapMaster(master, pin)`; `store.write(credentialsKey, credentials.encode())`; `_saveThrottle(ThrottleState.initial)`; `_monotonicLockedUntil = null`; `return await VaultKeys.derive(master)` (await before finally). finally `zeroBytes(master)`.

9.9 `unlock(pin) -> UnlockResult`
1. `credentials = loadCredentials()` (may throw `CredentialsUnreadableException`); null → `UnlockNotConfigured`.
2. `throttle = throttleState()`; `remaining = _remaining(throttle)`; if `> 0` → `UnlockThrottled(remaining)` — NO failure recorded, NO KDF run, lockout NOT extended.
3. `master = _tryUnwrap(credentials, pin)`.
4. If null: `throttle = throttle.recordFailure(throttle, clock.now())`; `_saveThrottle(throttle)`; `delay = delayAfter(throttle.failedCount)`; `_monotonicLockedUntil = delay == 0 ? null : clock.monotonic() + delay`; return `UnlockWrongPin(failedCount: throttle.failedCount, nextDelay: delay)`.
5. Else try: `_saveThrottle(recordSuccess())` (= initial); `_monotonicLockedUntil = null`; return `UnlockSuccess(await VaultKeys.derive(master))`; finally `zeroBytes(master)`.

9.10 `changePin(currentPin, newPin) -> ChangePinResult`
1. `validate(newPin)` non-null → `ChangePinInvalidNew(error)` (returned, not thrown; nothing touched).
2. `result = unlock(currentPin)` (full throttled path; a success also resets the throttle).
3. `UnlockSuccess(keys)` → try: `credentials = _wrapMaster(keys.masterKey, newPin)`; `store.write(credentialsKey, credentials.encode())`; return `ChangePinSuccess`; finally `keys.dispose()`. Files are NOT re-encrypted (same master key, new salt/nonce/pinLength/createdAt).
4. `UnlockWrongPin(nextDelay)` → `ChangePinWrongCurrent(nextDelay)`.
5. `UnlockThrottled(remaining)` → `ChangePinThrottled(remaining)`.
6. `UnlockNotConfigured` → throw `StateError('No vault PIN to change')`.

9.11 `adoptMasterKey(master, pin, {overwrite = false}) -> VaultKeys` (cloud restore on a fresh device)
1. `validate(pin)` → throw `InvalidPinException`.
2. `!overwrite && isConfigured()` → throw `StateError('A vault PIN already exists')`.
3. `credentials = _wrapMaster(master, pin)`; write; `_saveThrottle(initial)`; `_monotonicLockedUntil = null`; return `VaultKeys.derive(master)`. Does NOT zero `master` (caller owns it).

9.12 `eraseCredentials()`: for each key in `SecureStoreKeys.all` (credentials then throttle) `store.delete(key)`; `_monotonicLockedUntil = null`. Vault files are NOT touched here (see VaultEraser).

9.13 `_saveThrottle(state)` = `store.write("silentsum.vault.throttle.v1", jsonEncode(state.toJson()))`.

Result types (sealed): `UnlockSuccess(keys)`, `UnlockWrongPin(failedCount, nextDelay)`, `UnlockThrottled(remaining)`, `UnlockNotConfigured`; `ChangePinSuccess`, `ChangePinWrongCurrent(nextDelay)`, `ChangePinThrottled(remaining)`, `ChangePinInvalidNew(error)`. `CredentialsUnreadableException([cause])` toString `CredentialsUnreadableException(<cause>)`.

# 10. Vault session

`VaultSessionState` sealed: `VaultLocked` (singleton const) and `VaultUnlocked{keys: VaultKeys, unlockedAt: DateTime}`. `isUnlocked = state is VaultUnlocked`; `keysOrNull`; `requireKeys()` throws `VaultLockedException` (toString `VaultLockedException`) when locked OR when `keys.isDisposed`.

`VaultSessionController` (Riverpod `Notifier`, in-memory only; a process restart is always locked):
- `build()` → `VaultLocked`; registers onDispose → dispose held keys.
- `adopt(keys)`: `previous = _keys`; `_keys = keys`; `state = VaultUnlocked(keys, unlockedAt: clock.now())`; if `previous != null && !identical(previous, keys)` → `previous.dispose()`.
- `unlock(pin)`: `result = pinAuthService.unlock(pin)`; if `UnlockSuccess` → `adopt(result.keys)`; return result (exceptions propagate).
- `lock()`: if no keys → no-op (state unchanged); else `_keys = null`; `state = VaultLocked`; `keys.dispose()` (zeroes buffers). Downstream: `vaultRepositoryProvider` watches the session and rebuilds (null when locked, closing the previous repository and its decrypted caches); go_router's `refreshListenable` fires and the redirect sends any protected route (`/vault*`, `/settings*`) to `/`.

# 11. VaultStatus

`VaultStatus{configured: bool, pinLength: int?, unreadable: bool = false}`; `VaultStatus.none = (configured: false)`.
`VaultStatusController` (AsyncNotifier, no auto-retry): `_load()`: `length = pinAuthService.configuredPinLength()` → `VaultStatus(configured: length != null, pinLength: length)`; on `CredentialsUnreadableException` → `VaultStatus(configured: true, unreadable: true)`. `refresh()` sets state to a fresh `_load()`. Refreshed after setup, PIN change, erase, restore.

# 12. VaultEraser

`eraseEverything()` runs strictly in this order:
1. `secureDelete.directoryContents(vaultRoot)` — for every entry (non-recursive listing, no symlink following): files are overwritten in place with pseudo-random bytes in 64 KiB chunks, flushed, then unlinked (overwrite failures are ignored, unlink still attempted); subdirectories are recursed then removed. The root `vault` directory itself remains. No-op if the directory does not exist.
2. `auth.eraseCredentials()` (deletes both secure-store keys).
3. `settings = settingsStore.load()`; `settingsStore.save(settings.copyWith(backupEnabled: false, clearLastBackup: true))` (lastBackupAt → null).

# 13. Calculator unlock entry point (how a PIN reaches `unlock`)

- Engine: on `=`, if there are no pending operator tokens and the current entry `looksLikePin` (4–8 digits, no leading 0), the resulting state carries `unlockCandidate = entry`. The display still behaves as a normal calculator (shows the number).
- `CalculatorController._tryUnlock(digits)`: if busy → null; `status = vaultStatus.value`; null or `!configured` → null; `unreadable` → `UnlockUnavailable`; `status.pinLength != digits.length` → null (never an attempt, so ordinary arithmetic cannot trip the throttle); else `session.unlock(digits)`; `CredentialsUnreadableException` → `UnlockUnavailable`; `UnlockSuccess` → reset calculator state to initial, analytics `vault_unlocked`, return `UnlockOpened`; `UnlockThrottled(remaining)` → `UnlockBlocked(remaining)`; `UnlockWrongPin`/`UnlockNotConfigured` → null (nothing visible changes).
- Screen: `UnlockOpened` → navigate `/vault`. `UnlockBlocked` → snackbar `Too many attempts. Try again in <label>.` with `seconds = clamp(remaining.inSeconds, 1, 86400)`, `label = seconds >= 60 ? '<ceil(seconds/60)> min' : '<seconds> s'`, action `Forgot PIN?` → forgot-PIN dialog. `UnlockUnavailable` → snackbar `The vault credentials on this device cannot be read.` with action `Forgot PIN?`.

# 14. Restore-flow consumer of adoptMasterKey (for completeness)

Validates the new PIN (`PinPolicy.describe`), requires confirm match (`The PINs do not match.`), refuses if a vault exists (`A vault already exists on this device. Erase it first, then restore.`), then `master = recoverMasterKey(passphrase)`; `keys = adoptMasterKey(master, pin)`; `session.adopt(keys)`; restore files; `zeroBytes(master)`; refresh status; settings `onboardingDone: true, backupEnabled: true`; analytics `vault_restore_completed` with `{count}`.

# 15. Analytics event names touched by auth
`vault_setup_completed` (after successful setup), `vault_unlocked` (after successful calculator unlock), `vault_restore_completed`. Logged fire-and-forget; errors swallowed; analytics is opt-in (default off).

## Public API

## core/security
- `enum PinValidationError { tooShort, tooLong, notDigits, leadingZero }`
- `class PinPolicy` (static): `int minLength = 4`, `int maxLength = 8`, `PinValidationError? validate(String pin)`, `bool isValid(String pin)`, `bool looksLikePin(String text)`, `String describe(PinValidationError)`.
- `class KdfParams { memoryKiB, iterations, parallelism, hashLength = 32 }`; statics `defaults`, `backup`, `forTests`, `maxMemoryKiB = 262144`, `maxIterations = 10`, `maxParallelism = 4`; `Map toJson()`, `factory fromJson(Map)` (throws FormatException); value equality.
- `abstract class KeyDerivation { Future<Uint8List> deriveKey({required Uint8List secret, required Uint8List salt, required KdfParams params}) }`
- `class Argon2idKeyDerivation implements KeyDerivation { const Argon2idKeyDerivation({bool useIsolate = true}) }`
- `class WrongKeyException implements Exception` (no fields).
- `class WrappedKey { Uint8List nonce, cipherText, mac }`; statics `nonceLength = 24`, `macLength = 16`, `maxCipherTextLength = 1024`; `toJson()`, `factory fromJson(Map)` (FormatException on bad lengths).
- `class KeyWrapping { static const vaultAad = 'silentsum/vmk/v1'; static const backupAad = 'silentsum/backup-envelope/v1'; Future<WrappedKey> wrap(List<int> key, List<int> kek, {String aad = vaultAad}); Future<Uint8List> unwrap(WrappedKey wrapped, List<int> kek, {String aad = vaultAad}) }` (unwrap throws WrongKeyException on auth failure).
- `enum VaultKeyId { photo(1,'silentsum/photo/v1'), thumb(2,'silentsum/thumb/v1'), manifest(3,'silentsum/index/v1'); int code; String info; static VaultKeyId? fromCode(int) }`
- `class VaultKeys { static const masterKeyLength = 32; static Future<VaultKeys> derive(Uint8List masterKey) (ArgumentError if not 32 bytes); bool get isDisposed; Uint8List get masterKey; Uint8List keyFor(VaultKeyId id); void dispose() }` — accessors throw StateError('VaultKeys used after dispose').
- `class ThrottleState { const ThrottleState({int failedCount = 0, DateTime? lockedUntil, DateTime? lastFailureAt}); static const initial; toJson(); factory fromJson(Map); ==, hashCode, toString }`
- `class AttemptThrottle { const AttemptThrottle(); Duration delayAfter(int failedCount); bool isLocked(ThrottleState, DateTime now); Duration remaining(ThrottleState, DateTime now); ThrottleState recordFailure(ThrottleState, DateTime now); ThrottleState recordSuccess() }`
- `class SecureRandomSource { SecureRandomSource([Random?]); Uint8List bytes(int length); String hexId([int byteLength = 16]); static String toHex(List<int>) }`
- `void zeroBytes(List<int>)`, `bool constantTimeEquals(List<int>, List<int>)`, `Uint8List concatBytes(List<List<int>>)`
- `class SecureDelete { SecureDelete({int chunkSize = 65536, Random? random}); Future<void> file(File); Future<void> directoryContents(Directory) }`

## core/storage & clock
- `abstract class SecureStore { Future<String?> read(String key); Future<void> write(String key, String value); Future<void> delete(String key); Future<bool> containsKey(String key) }`
- `class SecureStoreKeys { static const vaultCredentials = 'silentsum.vault.credentials.v1'; static const throttleState = 'silentsum.vault.throttle.v1'; static const List<String> all }`
- `class InMemorySecureStore implements SecureStore { Map<String,String> get snapshot }`; `class FlutterSecureStore implements SecureStore` (Android resetOnError:false; iOS first_unlock_this_device, synchronizable:false).
- `abstract class Clock { DateTime now(); Duration monotonic() }`; `SystemClock`; `FakeClock([DateTime? start]) { advance(Duration); setNow(DateTime) }`.
- `AppSettings.copyWith({..., bool? onboardingDone, bool? backupEnabled, DateTime? lastBackupAt, bool clearLastBackup = false})`; `SettingsStore { load(); save(AppSettings); clear() }`.

## features/authentication
- `class InvalidPinException implements Exception { const InvalidPinException(PinValidationError error); String get message; }`
- `class CredentialsUnreadableException implements Exception { const CredentialsUnreadableException([Object? cause]) }`
- `sealed class UnlockResult`: `UnlockSuccess(VaultKeys keys)`, `UnlockWrongPin({int failedCount, Duration nextDelay})`, `UnlockThrottled({Duration remaining})`, `UnlockNotConfigured()`.
- `sealed class ChangePinResult`: `ChangePinSuccess()`, `ChangePinWrongCurrent({Duration nextDelay})`, `ChangePinThrottled({Duration remaining})`, `ChangePinInvalidNew(PinValidationError error)`.
- `class VaultCredentials { const VaultCredentials({int version = 1, required Uint8List salt, required KdfParams kdf, required WrappedKey wrappedMasterKey, required int pinLength, required DateTime createdAt}); toJson(); factory fromJson(Map); String encode(); static VaultCredentials decode(String raw) }`
- `class PinAuthService { PinAuthService({required SecureStore store, required KeyDerivation kdf, required KeyWrapping wrapping, required Clock clock, SecureRandomSource? random, KdfParams kdfParams = KdfParams.defaults, AttemptThrottle throttle = const AttemptThrottle()}); static const saltLength = 16; Future<bool> isConfigured(); Future<int?> configuredPinLength(); Future<VaultCredentials?> loadCredentials(); Future<ThrottleState> throttleState(); Future<Duration> remainingLockout(); Future<VaultKeys> setupPin(String pin); Future<UnlockResult> unlock(String pin); Future<ChangePinResult> changePin(String currentPin, String newPin); Future<VaultKeys> adoptMasterKey(Uint8List master, String pin, {bool overwrite = false}); Future<void> eraseCredentials() }`
- `class VaultLockedException implements Exception`
- `sealed class VaultSessionState { bool get isUnlocked; VaultKeys? get keysOrNull; VaultKeys requireKeys() }`; `VaultLocked()`; `VaultUnlocked({required VaultKeys keys, required DateTime unlockedAt})`.
- `class VaultSessionController extends Notifier<VaultSessionState> { bool get isUnlocked; void adopt(VaultKeys keys); Future<UnlockResult> unlock(String pin); void lock() }`
- `class VaultStatus { const VaultStatus({required bool configured, int? pinLength, bool unreadable = false}); static const none }`; `class VaultStatusController extends AsyncNotifier<VaultStatus> { Future<void> refresh() }`
- `class VaultEraser { const VaultEraser({required PinAuthService auth, required SecureDelete secureDelete, required Directory vaultRoot, required SettingsStore settings}); Future<void> eraseEverything() }`
- `enum WelcomeChoice { setup, later }`; `Future<WelcomeChoice> showWelcomeSheet(BuildContext)`
- `Future<void> showForgotPinDialog(BuildContext, WidgetRef)`
- `Future<bool> showEraseVaultDialog(BuildContext, WidgetRef)` (true = erased)
- `enum PinSetupMode { create, change }`; `class PinSetupScreen extends ConsumerStatefulWidget { PinSetupScreen({required PinSetupMode mode}) }`
- `class PinKeypad extends StatelessWidget { PinKeypad({required ValueChanged<String> onDigit, required VoidCallback onBackspace, bool enabled = true}) }`; `class PinDots extends StatelessWidget { PinDots({required int count, int max = 8}) }`

## Providers (composition root)
`clockProvider`, `secureRandomProvider`, `secureStoreProvider`, `keyDerivationProvider` (Argon2id isolate), `kdfParamsProvider` (defaults), `keyWrappingProvider`, `secureDeleteProvider`, `vaultRootDirectoryProvider` (`<app support>/vault`), `settingsStoreProvider`, `settingsProvider`, `pinAuthServiceProvider`, `vaultStatusProvider` (AsyncNotifierProvider, retry disabled), `vaultSessionProvider` (NotifierProvider), `vaultEraserProvider` (FutureProvider), `vaultRepositoryProvider` (rebuilt on session change), `analyticsProvider`, `firebaseServicesProvider`.

## Routes
`/` calculator, `/setup` PinSetupScreen(create), `/setup/restore`, `/about`, `/vault`, `/vault/camera`, `/vault/photo/:id`, `/settings`, `/settings/change-pin` PinSetupScreen(change), `/settings/auto-lock`, `/settings/security`, `/settings/backup`, `/settings/about`. `isProtected(loc) = startsWith('/vault') || startsWith('/settings')` → redirect to `/` when locked.

## Tests

All service tests use `InMemorySecureStore`, `FakeClock()` (2026-01-01 12:00 local), `Argon2idKeyDerivation(useIsolate:false)`, `KeyWrapping()`, `KdfParams.forTests` (m=256,t=1,p=1).

## test/features/authentication/pin_auth_service_test.dart
1. `starts unconfigured` — isConfigured() false; configuredPinLength() null; unlock('1234') is UnlockNotConfigured.
2. `first-run setup stores credentials but never the PIN` — setupPin('2468'); isConfigured true; configuredPinLength 4; keys.masterKey.length 32; no value in store.snapshot contains the substring '2468'; the value under `silentsum.vault.credentials.v1` contains 'argon2id'.
3. `setup rejects invalid PINs and refuses to overwrite` — setupPin('12') throws InvalidPinException; setupPin('0123') throws InvalidPinException; after setupPin('2468'), setupPin('1357') throws StateError.
4. `correct PIN unlocks with the same master key` — unlock('2468') is UnlockSuccess and its keys.masterKey equals the setup keys' masterKey.
5. `incorrect PIN is rejected and counted` — unlock('2469') is UnlockWrongPin with failedCount 1 and nextDelay Duration.zero; throttleState().failedCount == 1.
6. `wrong length is counted as a wrong PIN without deriving` — unlock('24680') (5 digits vs 4) is UnlockWrongPin.
7. `repeated incorrect PINs throttle even a correct PIN until the delay passes` — unlock '0000','1111','2222': third result failedCount 3, nextDelay 5 s; unlock('2468') is UnlockThrottled with remaining 5 s; remainingLockout() == 5 s; clock.advance(5 s); unlock('2468') is UnlockSuccess; throttleState().failedCount == 0.
8. `change PIN keeps the master key, old PIN stops working` — changePin('2468','13579') is ChangePinSuccess; configuredPinLength 5; unlock('2468') is UnlockWrongPin; unlock('13579') is UnlockSuccess with the original masterKey.
9. `change PIN validates the new PIN and the current PIN` — changePin('2468','12') is ChangePinInvalidNew; changePin('9999','1357') is ChangePinWrongCurrent; two more unlock('9999') (3 failures total); changePin('2468','1357') is ChangePinThrottled.
10. `restart: a new service over the same store still unlocks` — a second PinAuthService over the same store with FakeClock(clock.now()) unlocks '2468' with the same masterKey.
11. `erase removes credentials and throttle state` — setup, one wrong unlock, eraseCredentials(); isConfigured false; store.snapshot is empty; unlock('2468') is UnlockNotConfigured.
12. `adoptMasterKey (cloud restore) wraps a given key under a new PIN` — fresh service over a new empty store; adoptMasterKey(original.masterKey,'7531').masterKey equals original; unlock('7531') is UnlockSuccess with the same masterKey.
13. `corrupt credentials surface as unreadable, not as a silent reset` — store.write(credentialsKey, '{not json'); isConfigured() throws CredentialsUnreadableException.
14. `setup and unlock derive identical sub-keys (master is not zeroed early)` — for every VaultKeyId, setupKeys.keyFor(id) equals unlockKeys.keyFor(id) and is not all zeros.
15. `moving the wall clock forward does not shorten an in-process lockout` — 3 wrong PINs; clock.setNow(now + 2 h) (wall only); unlock('2468') is still UnlockThrottled; clock.advance(5 s); unlock('2468') is UnlockSuccess.
16. `moving the wall clock backwards keeps the lockout` — 3 wrong PINs; new service over the same store with FakeClock(now − 1 day); unlock('2468') is UnlockThrottled with remaining exactly 5 s.
17. `adoptMasterKey refuses to replace an existing vault unless told to` — adoptMasterKey(master,'1357') throws StateError; with overwrite:true returns same masterKey; unlock('1357') is UnlockSuccess.
18. `records with impossible field lengths are unreadable, not "wrong PIN"` — replace `"pinLength":4` with `"pinLength":99` in the stored JSON; unlock('2468') throws CredentialsUnreadableException.

## test/features/authentication/pin_setup_flow_test.dart (widget tests, real app with fakes; helpers tap keys `pin_key_<d>` and `pin_next`)
1. `first run: welcome sheet, PIN creation with confirmation, back to calculator` — settings = defaults (onboardingDone false): text 'Welcome to SilentSum' shown; tap `welcome_setup` → 'Choose a vault PIN'; type 0123 + Next → widget `pin_error` present; tap `pin_key_backspace` 4×; type 2468 + Next → 'Confirm your PIN'; type 2469 + Next → a text containing 'do not match' and back on 'Choose a vault PIN'; type 2468, Next, 2468, Next → 'Your vault is ready' and a text containing 'Press ='; auth.isConfigured true, configuredPinLength 4; no store value contains '2468'; tap `pin_done` → CalculatorScreen shown; settingsStore.load().onboardingDone true.
2. `"Not now" keeps setup reachable from the calculator menu` — tap `welcome_later` → CalculatorScreen; tap `calc_menu` → item `menu_setup_vault` exists; tap it → 'Choose a vault PIN'.
3. `once a vault exists the menu no longer offers setup` — harness with configuredPin '2468'; tap `calc_menu` → `menu_setup_vault` absent; 'About' present.

## test/core/security/attempt_throttle_test.dart (t0 = 2026-01-01T12:00Z)
1. `first two failures impose no delay` — after 1 failure failedCount 1 and not locked; after 2 not locked.
2. `delays increase and cap at one hour` — delayAfter: 3→5 s, 4→15 s, 5→30 s, 6→1 min, 7→5 min, 8→10 min, 9→20 min, 10→40 min, 11→60 min, 40→60 min.
3. `third failure locks for five seconds and then expires` — 3 failures at t0: isLocked(t0) true; remaining(t0) 5 s; remaining(t0+2 s) 3 s; isLocked(t0+5 s) false; remaining(t0+1 min) zero.
4. `success resets the counter` — 5 failures then recordSuccess() equals ThrottleState.initial.
5. `round-trips through json` — recordFailure(ThrottleState(failedCount:5), t0) → fromJson(toJson()) equals original; fromJson({}) equals initial.

## test/core/security/pin_policy_test.dart
1. `accepts 4 to 8 digits not starting with zero` — validate('1234') null; validate('98765432') null.
2. `rejects short, long, non-digit and leading-zero PINs` — '123' tooShort; '123456789' tooLong; '12a4' notDigits; '' notDigits; '0123' leadingZero.
3. `every error has a user-facing description` — describe(e) non-empty for all enum values.

## test/core/security/key_derivation_test.dart (salt = bytes 0..15; otherSalt = 255..240; secret = utf8 PIN)
1. `is deterministic for the same secret, salt and params` — two derivations equal; length 32.
2. `changes with the salt and with the secret` — different salt → different; secret '1235' → different.
3. `changes with the parameters` — forTests vs KdfParams(m:512,t:2,p:1) differ.
4. `works through the isolate path too` — Argon2idKeyDerivation() (isolate) equals inline result.
5. `params round-trip through json and reject unknown algorithms` — fromJson(toJson) equals for defaults, backup, forTests; fromJson({'alg':'md5'}) throws FormatException; defaults.memoryKiB == 32*1024; backup.memoryKiB > defaults.memoryKiB.
6. `params from untrusted records are bounded` — base {'alg':'argon2id','m':32768,'t':3,'p':1,'len':32}: m=1 GiB throws; t=100 throws; p=64 throws; len=16 throws; m=4 with p=1 throws (m < 8p); m=maxMemoryKiB accepted with memoryKiB == maxMemoryKiB.

## test/core/security/key_wrapping_test.dart
1. `wrap/unwrap round trip` — wrapped.nonce.length 24; mac.length 16; cipherText != key; unwrap returns key.
2. `wrong kek cannot unwrap` — unwrap with a different random kek throws WrongKeyException.
3. `tampered ciphertext or wrong aad fails authentication` — flip bit 0 of cipherText[0] → WrongKeyException; unwrap with aad = backupAad → WrongKeyException.
4. `json round trip` — WrappedKey.fromJson(wrapped.toJson()) unwraps to key.
5. `json with impossible lengths is rejected before any crypto` — nonce 'AAAA' (3 bytes) throws FormatException; mac 'AAAA' throws; ct '' throws.
6. `vault subkeys are distinct, deterministic and wiped on dispose` — derive twice: photo keys equal; photo != thumb; thumb != manifest; photo != master; masterKey equals master; after dispose the previously obtained photo buffer is all zeros; keyFor(photo) throws StateError; VaultKeys.derive(16 random bytes) throws ArgumentError.

## UI flows

## A. Welcome sheet (first run) — `showWelcomeSheet(context) -> WelcomeChoice`
Trigger: CalculatorScreen post-first-frame, only if `settings.onboardingDone == false` AND `vaultStatus.configured == false` (awaits the status future; an unreadable record counts as configured, so no sheet) AND not already shown by this screen instance.
Modal bottom sheet: not dismissible, no drag, no drag handle, scroll-controlled, safe area, max height 90% of screen, padding L24 T24 R24 B16, content stretched.
- Icon `lock_outline` 40 px primary
- Title (headlineSmall): `Welcome to SilentSum`
- Body (bodyMedium): `This calculator can also keep a private photo vault. Photos in the vault are encrypted on this device and unlocked with a PIN that you type on the calculator.\n\nYou can set it up now, or later from the ⋮ menu.`
- FilledButton key `welcome_setup`: `Set up vault` → returns `setup` → `context.push('/setup')`
- TextButton key `welcome_later`: `Not now` → returns `later` → settings `onboardingDone = true` (sheet never shown again; setup stays in the menu).
A null result (should not happen) is treated as `later`.

## B. Calculator menu (PopupMenuButton key `calc_menu`, tooltip `More`)
- If status loaded and `!configured`: item key `menu_setup_vault`, icon lock_outline, `Set up private vault` → push `/setup`.
- Always: icon info_outline, `About` → push `/about`.

## C. PIN setup / change screen (`PinSetupScreen(mode)`)
Routes: create at `/setup` (reachable while locked), change at `/settings/change-pin` (requires unlocked session).
Steps: `current` (change only, initial for change), `enter` (initial for create), `confirm`, `working`, `done`.
Layout: AppBar title `Set up vault` (create) / `Change PIN` (change); back arrow and system back are disabled while `working` (PopScope canPop false). Body centered, max width 480, scrollable, padding 24.
Entry view per step — title (headlineSmall, centered) / subtitle (bodyMedium onSurfaceVariant, centered):
| step | title | subtitle |
|---|---|---|
| current | `Enter your current PIN` | `Confirm it is you before changing the PIN.` |
| enter | `Choose a vault PIN` (create) / `Choose a new PIN` (change) | `4 to 8 digits, not starting with 0. You will type it on the calculator to open the vault.` |
| confirm | `Confirm your PIN` | `Type the same PIN again.` |
Then: 28 px gap; `PinDots(count: typed.length, max 8)`; 12 px gap; a 40 px-high slot showing the error text (key `pin_error`, error color, centered) when present; `PinKeypad`; 16 px gap; FilledButton key `pin_next` labeled `Confirm` in the confirm step, else `Next`, enabled only when `typed.length >= 4`; in create mode, enter step, when Firebase is available: TextButton `Restore from cloud backup instead` → push `/setup/restore`.
Input rules: digit tap ignored when `typed.length >= 8`; digit tap clears the error; backspace removes the last digit (no-op when empty).
Next-button logic:
- current: (ignored if empty) store as `current`, clear typed, go to `enter`.
- enter: `PinPolicy.validate(typed)`; on error show `describe(error)` and stay; else store as `first`, clear typed, go to `confirm`.
- confirm: if `typed != first` → error `The PINs do not match. Enter your new PIN again.`, clear typed and first, go back to `enter`; else commit.
Commit (step → `working`, shows CircularProgressIndicator + `Generating your vault keys…`):
- create: `setupPin(first)`; dispose returned keys (first run ends on the calculator so the unlock gesture is learned); refresh vault status; settings `onboardingDone = true`; analytics `vault_setup_completed`; step → `done`.
- change: `changePin(current, first)`: Success → refresh status, step → `done`; WrongCurrent → restart with `That is not your current PIN.` at step `current`; Throttled(remaining) → restart with `Too many attempts. Try again in <fmt>.` at `current` where fmt = `<ceil(s/60)> min` if seconds >= 60 else `<s> s`; InvalidNew(error) → restart with `describe(error)` at `enter`.
- Exceptions: InvalidPinException → restart(e.message, enter); StateError → restart(e.message, enter) (e.g., `A vault PIN already exists`); CredentialsUnreadableException → restart(`The stored vault credentials cannot be read.`, enter). Restart clears typed/first/current and sets the error text. In all cases (finally) the vault status is refreshed if still mounted.
Done view: icon `verified_user_outlined` 56 px primary; title `Your vault is ready` (create) / `PIN changed` (change); Card (padding 16) with `How to open the vault` (titleMedium), lines `1. Type your PIN on the calculator.`, `2. Press =.`, `3. The vault opens. Lock it from the vault at any time.`, then bodySmall onSurfaceVariant `If you forget the PIN, the vault cannot be recovered: its contents are encrypted with a key that only the PIN unlocks.`; FilledButton key `pin_done`: create → `Back to calculator` → `context.go('/')`; change → `Done` → `context.pop()`.

## D. PinKeypad / PinDots
Keypad rows: `[1,2,3]`, `[4,5,6]`, `[7,8,9]`, `[blank, 0, ⌫]`; each key 84×64 with 6 px padding all round, radius 18, surface `surfaceContainerHigh`, label font 26 weight 500 `onSurface`; keys carry `Key('pin_key_<digit>')` and `Key('pin_key_backspace')` for ⌫; disabled when `enabled == false`. PinDots: `max` (8) circles in a row, 6 px horizontal margin, filled = 16 px `primary`, empty = 12 px `outlineVariant`, size/color animate over 120 ms.

## E. Calculator unlock feedback
- Correct PIN + `=` → navigate `/vault` (calculator state reset). Wrong PIN → nothing visible (the display shows the number as normal arithmetic).
- Throttled → SnackBar `Too many attempts. Try again in <label>.` (label: seconds clamped 1..86400; `<ceil(s/60)> min` if >= 60 else `<s> s`) with action `Forgot PIN?` → Forgot-PIN dialog.
- Credentials unreadable → SnackBar `The vault credentials on this device cannot be read.` with action `Forgot PIN?`.
- Every key press gives `HapticFeedback.selectionClick()`.

## F. Forgot PIN dialog — `showForgotPinDialog(context, ref)`
AlertDialog title `Forgot your PIN?`. Content = `Your vault is encrypted with a key that only your PIN can unlock. Nobody can recover it without the PIN, not even the developers.\n\n` + (only if `settings.backupEnabled`: `You enabled cloud backup: after erasing this vault you can restore it during setup with your recovery passphrase.\n\n`) + `If you cannot remember the PIN, the only option is to erase the vault and start over.`
Actions: TextButton `Keep trying` → close (false); TextButton key `forgot_erase` `Erase vault…` (ellipsis character U+2026) → close (true) → opens the Erase dialog.

## G. Erase vault dialog — `showEraseVaultDialog(context, ref) -> bool`
Entry points: Forgot-PIN dialog; Settings > Security "Danger zone" tile key `security_erase` (icon delete_forever_outlined in error color, title `Erase vault` in error color, subtitle `Securely deletes every photo and the PIN on this device.`); Gallery error state when vault data is unreadable (title `Vault data cannot be read`, body `The encrypted files on this device do not match your PIN. They may belong to a previous installation. Erasing the vault lets you start over.`, tonal button `Erase vault…`).
AlertDialog title `Erase vault?`; content text `Every photo in the vault and the vault PIN will be securely deleted from this device. This cannot be undone.\n\nType ERASE to confirm.`; 16 px gap; TextField key `erase_confirm_field`, autofocus, capitalization = characters, hint `ERASE`; the confirm button is enabled only while `input.trim() == 'ERASE'` (exact, case-sensitive, surrounding whitespace ignored).
Actions: TextButton `Cancel` → false; FilledButton key `erase_confirm_button`, background `error`, foreground `onError`, label `Erase vault` → true.
On confirm (in order): resolve `VaultEraser`; `vaultSession.lock()`; `eraser.eraseEverything()` (secure-delete files → delete credentials + throttle → settings backupEnabled=false, lastBackupAt cleared); `settingsProvider.update(backupEnabled: false, clearLastBackup: true)` (keeps the in-memory settings in sync); `vaultStatus.refresh()`; SnackBar `Vault erased.`; `context.go('/')`; return true. Cancel or dismissed → return false.

## H. Session/redirect behaviour
Any navigation to `/vault*` or `/settings*` while locked redirects to `/`; locking (manual lock, auto-lock, erase) immediately re-runs the redirect via the session listener.

## Security notes

- The PIN is never persisted anywhere; the only stored verifier is the Poly1305 tag of the wrapped master key, so a guess costs one full Argon2id (32 MiB, 3 passes) plus one AEAD decrypt. Do not add a separate hash/verifier in the RN port.
- Secrets are zeroed in `finally` blocks: UTF-8 PIN bytes after KDF, KEK after wrap/unwrap, master key after derive; `VaultKeys.dispose()` zeroes all four buffers and is called on lock, on controller disposal, after setup (keys not needed until the calculator unlock), and after PIN change. `VaultKeys.derive` copies the master before the first await so a caller's `finally { zero }` cannot race it. The PIN string itself cannot be zeroed (language limitation, documented).
- KDF parameters are read from the STORED record on unlock (so vaults survive future parameter bumps) but bounded (m <= 256 MiB, t <= 10, p <= 4, len == 32, m >= 8p) so a corrupted/malicious record cannot force a huge allocation. PIN change re-wraps with the service's current defaults (implicit upgrade path). Tampering with stored params changes the derived KEK, so unwrap fails; no downgrade attack succeeds silently.
- Length gate: an attempt whose length differs from `pinLength` or that fails the policy is rejected before Argon2id runs but is still counted as a failure by the service. The calculator layer additionally never submits a number of a different length, so ordinary arithmetic cannot trip the throttle (and pinLength is therefore a deliberately non-secret stored field).
- Throttle: persisted wall-clock deadline (`lockedUntil`) + `lastFailureAt` for backwards-clock detection + an in-process MONOTONIC deadline. Within a process, setting the clock forward cannot shorten a lockout (test 15); after a restart a forward-set clock would (documented limitation); a backwards-set clock yields the full current delay until the clock passes `lastFailureAt` again. Throttled attempts do not run the KDF, do not increment the counter and do not extend the lock. Success resets to `initial`. No automatic wipe ever.
- Throttle state FAILS OPEN: an unreadable/corrupt throttle record is treated as `initial`. Credentials FAIL CLOSED: unreadable/corrupt credentials raise `CredentialsUnreadableException` and the only paths forward are erase or cloud restore (never a silent reset). A record with impossible field lengths (salt outside 8..64, pinLength outside 4..8, nonce != 24, mac != 16, ct empty or > 1024) is "unreadable", not "wrong PIN".
- Secure store must be configured so a keystore error surfaces rather than wiping (Android `resetOnError:false`), and keychain items must be device-bound and non-synced (iOS `first_unlock_this_device`, `synchronizable:false`).
- Subkeys via HKDF with distinct info labels isolate photo/thumb/index purposes; the master key is only used for wrapping. The key-id code byte is bound into the file header AAD elsewhere so blobs cannot be swapped across purposes.
- Erase order matters: files are securely overwritten and unlinked first, then credentials and throttle deleted, then backup settings cleared; the session is locked before erasing so repositories fail closed.
- Analytics never receives the PIN, lengths, or identifiers — only the coarse event names listed. Telemetry calls are fire-and-forget and swallow errors so they can never block or fail an auth flow.
- RN-port cautions: use libsodium `crypto_pwhash` with ALG_ARGON2ID13 and memlimit = memoryKiB*1024 bytes, opslimit = iterations, and note libsodium fixes parallelism at 1 (matches `p = 1` in all presets, but the record format allows p up to 4 — reject p != 1 or use an Argon2 library that supports lanes); use the DETACHED xchacha20poly1305_ietf API (ct and mac are separate JSON fields); HKDF salt must be empty; base64 must be padded standard alphabet; JSON must be compact with the field names given.

## Open questions

- Dart's base64Decode tolerates the URL-safe alphabet and (depending on input) missing padding; the RN port should always emit padded standard base64 and decide whether to accept unpadded/URL-safe input from older records.
- Throttle state fails open (corrupt record -> initial). Confirm this is intended in the RN port or whether an unreadable throttle record should instead be treated as locked for delayAfter(?)/erase-only.
- After a process restart, a wall clock set FORWARD shortens a lockout (documented limitation); the RN port could persist a boot-time/monotonic anchor to close this, but that would be a behaviour change.
- package:cryptography's pure-Dart Argon2id must be cross-checked against libsodium/RFC 9106 test vectors (v1.3, no K/X inputs) before existing records are considered portable; parallelism>1 is representable in the record but libsodium cannot compute it.
- HKDF salt is assumed empty (package:cryptography Hkdf.deriveKey default nonce = []); verify against a known-answer test when porting so subkeys match existing vault files.
- VaultUnlocked.unlockedAt is recorded but no consumer was found in the read files (auto-lock uses the monotonic clock elsewhere); confirm whether it is needed.
- showEraseVaultDialog updates backup settings twice (VaultEraser writes the store; the dialog then updates the in-memory SettingsController). Harmless duplication, but the RN port only needs one authoritative write plus a state refresh.
- Dart DateTime.toIso8601String emits 3 fractional digits normally but 6 when microseconds are non-zero; the RN parser for createdAt should accept both.
- PinAuthService.setupPin propagates CredentialsUnreadableException from isConfigured(); the UI maps it to 'The stored vault credentials cannot be read.' but offers no erase shortcut on that screen — confirm desired UX.
- The 'Restore from cloud backup instead' button depends on firebaseServicesProvider.available; the RN port needs an equivalent availability flag.