# Flutter reference: calculator

_calculator (launcher/disguise screen: pure calculator engine + controller that turns "PIN-shaped integer then =" into a vault unlock attempt + display/keypad/screen widgets)_

Files read: C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/calculator/calculator_engine.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/calculator/calculator_controller.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/calculator/calculator_keypad.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/calculator/calculator_display.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/calculator/calculator_screen.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/test/features/calculator/calculator_engine_test.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/test/features/calculator/calculator_screen_test.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/docs/security.md, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/docs/architecture.md, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/security/pin_policy.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/test/core/security/pin_policy_test.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/test/support/test_app.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/authentication/auth_models.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/authentication/vault_status.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/authentication/vault_session_controller.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/authentication/pin_auth_service.dart (unlock() and configuredPinLength() only), C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/app/providers.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/app/router.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/firebase/analytics_service.dart (first 40 lines), C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/authentication/welcome_sheet.dart (API + copy via grep), C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/authentication/forgot_pin_dialog.dart (signature via grep), C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/storage/settings_store.dart (AppSettings.onboardingDone via grep), C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/lifecycle/app_lifecycle_guard.dart (lines 25-70, clearAll call sites)

## Behaviour

# 1. Key model

## 1.1 `CalcKey` (enum, order matters — index is used)
| index | name | isDigit | isOperator |
|---|---|---|---|
| 0..9 | `digit0` .. `digit9` | yes | no |
| 10 | `point` | no | no |
| 11 | `add` | no | yes |
| 12 | `subtract` | no | yes |
| 13 | `multiply` | no | yes |
| 14 | `divide` | no | yes |
| 15 | `equals` | no | no |
| 16 | `clear` | no | no |
| 17 | `backspace` | no | no |
| 18 | `percent` | no | no |
| 19 | `negate` | no | no |

- `isDigit` ⇔ index ≤ 9. `digit` = decimal string of the index (only meaningful for digit keys). `digitKey(d)` = the key with index `d`.
- `op` maps add/subtract/multiply/divide → `CalcOp`; any other key throws `StateError('<key> is not an operator')`.
- Key `name` strings (used for test IDs `calc_key_<name>`): `digit0`…`digit9`, `point`, `add`, `subtract`, `multiply`, `divide`, `equals`, `clear`, `backspace`, `percent`, `negate`.

## 1.2 `CalcOp` symbols (exact code points)
| op | symbol | code point |
|---|---|---|
| add | `+` | U+002B |
| subtract | `−` | U+2212 (MINUS SIGN, not hyphen) |
| multiply | `×` | U+00D7 |
| divide | `÷` | U+00F7 |

# 2. `CalculatorState` (immutable)

Fields and defaults:
| field | type | default | meaning |
|---|---|---|---|
| `tokens` | list of (number | CalcOp), strictly alternating number, op, number, op… | `[]` | committed part of the expression |
| `entry` | string | `''` | the number currently being typed, verbatim (may contain leading `-`, a trailing `.`, or `e` notation — see 4.5/4.6) |
| `resultValue` | number or null | null | set after `=`; the value the next operator continues from |
| `lastExpression` | string or null | null | text shown on the secondary line after `=` (e.g. `12 + 3 =`) |
| `error` | bool | false | division by zero / non-finite result |
| `unlockCandidate` | string or null | null | the bare integer the user "evaluated" on the last `=`; lives for exactly one transition |

`initial` = all defaults. `justEvaluated` ⇔ `resultValue != null || error`.

`maxEntryDigits` = **15**.

## 2.1 `display` (main line) — first rule that matches wins
1. `error` → `Error`
2. `resultValue != null` → `formatNumber(resultValue)`
3. `entry` non-empty → `entry` verbatim (so `0.`, `-0`, `-5.`, `1e16` are shown as typed)
4. `tokens` non-empty: if last token is a number → `formatNumber(last)`; else (trailing operator) if `tokens.length >= 2` → `formatNumber(tokens[length-2])` (the number before the operator)
5. otherwise `0`

## 2.2 `expressionLine` (secondary line)
1. If `lastExpression != null` → return it.
2. Else build a list: for each token, numbers via `formatNumber`, operators via their symbol; then append `entry` verbatim if non-empty; join with a single space `' '`. Examples: `12 + 3`, `2 × 3 ÷ 4`, `5 +` (trailing operator), `` (empty string in the initial state).

## 2.3 `copyWith` semantics (important for candidate lifetime)
- Passing `null` for `resultValue`/`lastExpression` keeps the old value; clearing requires `clearResult: true` / `clearExpression: true`.
- `clearCandidate` defaults to **true**: every `copyWith` call drops the previous `unlockCandidate` unless a new one is explicitly passed. Consequently the candidate survives exactly one state transition (set in `=`, gone after any next key). `copyWith()` with no arguments = same state with candidate removed.

## 2.4 `formatNumber(v)` (all numeric output)
1. NaN or ±Infinity → `Error`.
2. `v == 0` (including -0) → `0`.
3. If `v` is integral (`v == round(v)`) and `|v| < 1e15` → plain integer string, e.g. `42`, `-2`, `999999999999999`. (JS: `String(Math.trunc(v))`; safe because JS only switches to exponent at 1e21.)
4. Otherwise `s = v.toStringAsPrecision(10)` — 10 significant digits, ECMAScript `toPrecision(10)` algorithm: decimal notation when the decimal exponent e satisfies -6 ≤ e < 10, else exponential `d.ddddddddde+XX` / `e-XX` (sign always present for exponent; no zero padding). JS `Number.prototype.toPrecision(10)` produces identical strings.
5. If `s` contains `e`: split at `e`; mantissa = left part; if mantissa contains `.`, strip trailing zeros (`/0+$/`) then a trailing `.` (`/\.$/`); exponent = right part with the first `+` removed (a `-` is kept); return `${mantissa}e${exponent}`. Examples: 1e16 → `1e16`; 99999999³ → `9.9999997e23`; 0.0000001 → `1e-7`; 12345678901.5 → `1.23456789e10`; 1e15 (integral but not < 1e15) → `1e15`.
6. Else if `s` contains `.`: strip trailing zeros then a trailing `.`. Examples: 0.1+0.2 → `0.3`; 1/3 → `0.3333333333`; 3.5 → `3.5`; -0.5 → `-0.5`.
7. Return `s`.
Note: there is **no** thousands grouping anywhere.

# 3. Engine (`CalculatorEngine.press(state, key)`) — pure function

Dispatch:
| key | handler |
|---|---|
| clear | return `initial` (this is an all-clear: tokens, entry, result, expression, error, candidate all reset) |
| equals | §3.8 |
| backspace | §3.3 |
| point | §3.2 |
| negate | §3.4 |
| percent | §3.5 |
| add/subtract/multiply/divide | §3.6 |
| digit0..9 | §3.1 |

Helper `_fresh(s)`: if `s.justEvaluated` → `initial`; else `s.copyWith()` (same state, candidate dropped). Used by digit and point so that typing after a result or after `Error` starts a brand-new calculation.

## 3.1 Digit `d`
1. `st = _fresh(s)`; `e = st.entry`.
2. If `e == '0'` → `e = d` (leading zero replaced; `0` then `0` stays `0`).
   Else if `e == '-0'` → `e = '-' + d`.
   Else `e = e + d`.
3. `digitCount` = length of `e` with every `-` and `.` removed (note: an `e` from exponent notation is NOT removed and counts). If `digitCount > 15` → return `st` unchanged (key ignored).
4. Return `st.copyWith(entry: e)`.
Consequences: the entry can never start with `0` followed by a digit (hence PINs cannot start with 0); `007` → `7`; `0.` + `5` → `0.5`.

## 3.2 Point
1. `st = _fresh(s)`; `e = st.entry`.
2. If `e` already contains `.` → return `st` (ignored).
3. If `e` is empty → `e = '0'`. If `e == '-'` → `e = '-0'` (defensive; `-` alone never persists).
4. Return `st.copyWith(entry: e + '.')`. No digit-count check (a 15-digit entry can still take a `.`; further digits are then rejected).

## 3.3 Backspace
1. If `error` → `initial`.
2. If `justEvaluated` (a result is shown) → `initial` (backspace after `=` is a full clear).
3. If `entry` is empty → `s.copyWith()` (no change; it does NOT remove a pending operator or committed numbers).
4. `e = entry` without its last character; if `e == '-'` → `e = ''`.
5. Return `s.copyWith(entry: e)`. Display then falls through to the token rules (e.g. `1<<` shows `0`; `12+3<` shows `12`).

## 3.4 Negate (`±`)
1. If `error` → `initial`.
2. If `resultValue != null` → brand-new state with only `entry = formatNumber(-resultValue)` (tokens/expression/result dropped). Result 0 → entry `0`. A large result yields an entry in exponent form, e.g. `-1e16`.
3. Else if `entry` non-empty → toggle: if it starts with `-` remove it, else prepend `-`. (`0` → `-0`, `0.` → `-0.`, `5.` → `-5.`.) Return `s.copyWith(entry: …)`.
4. Else if `tokens` non-empty and last token is a number → negate that token (copy list). (Unreachable through the key API because an empty entry with no result always leaves a trailing operator; keep or drop.)
5. Else `s.copyWith()` (no-op, e.g. right after an operator or in the initial state).

## 3.5 Percent (`%`) — unary only, no "x + y%" semantics
1. If `error` → `initial`.
2. If `resultValue != null` → brand-new state with only `entry = formatNumber(resultValue / 100)`.
3. Else if `entry` non-empty → `entry = formatNumber(parse(entry) / 100)` via `s.copyWith` (`50` → `0.5`; `5.` → `0.05`; `-50` → `-0.5`; `0.` → `0`; `0.00000001` → `1e-10`).
4. Else if last token is a number → divide it by 100 (unreachable, defensive).
5. Else `s.copyWith()` (no-op).

## 3.6 Operator (`+ − × ÷`)
1. If `error` → `initial`.
2. `tokens = copy(s.tokens)`.
3. If `resultValue != null` → `tokens = [resultValue]` (continue from result; previous `lastExpression` is discarded).
   Else if `entry` non-empty → append `parse(entry)`.
4. If `tokens` is empty → append `0.0` (leading operator operates on zero: `+5=` → 5).
5. If last token is an operator → replace it with the new op (`5+*2=` → 10); else append the op.
6. Return a brand-new `CalculatorState(tokens: tokens)` (entry `''`, no result, no expression, no error, no candidate).

## 3.7 `parse(entry)` (entry string → number)
1. `''` or `'-'` → 0.
2. Strip one trailing `.`.
3. `'-0'` → 0.
4. Otherwise standard decimal/exponent parse (Dart `double.parse`; JS `Number(e)` is equivalent for the strings that can occur: optional `-`, digits, optional `.digits`, optional `e±digits`).

## 3.8 Equals
1. If `error` → `initial`.
2. If `justEvaluated` (result already shown) → `s.copyWith()`: **no change** except the candidate is dropped. Repeated `=` does NOT repeat the last operation (`2+2==` → 4).
3. `candidate = (tokens is empty && PinPolicy.looksLikePin(entry)) ? entry : null`. `looksLikePin(text)` ⇔ matches `^[0-9]+$` AND 4 ≤ length ≤ 8 AND does not start with `0`. Because `entry` is checked verbatim, `-1234`, `12.34`, `1234.` are never candidates; any committed token (e.g. `1+234=`, `1234+=`) disqualifies.
4. `tokens = copy(s.tokens)`; if `entry` non-empty append `parse(entry)`.
5. If tokens non-empty and last is an operator → remove it (`1234+=` evaluates `1234`; `5+=` → 5).
6. If tokens is empty (only possible when entry and tokens were both empty) → `s.copyWith(unlockCandidate: candidate)` — effectively a no-op on the initial state.
7. `expression = CalculatorState(tokens).expressionLine` (numbers re-formatted via `formatNumber`, so `0.50` shows as `0.5`).
8. `value = evaluate(tokens)`.
9. If `value == null` (division by zero) or not finite (overflow) → `CalculatorState(error: true, lastExpression: expression + ' =', unlockCandidate: candidate)`. Display `Error`, secondary line e.g. `5 ÷ 0 =`.
10. Else → `CalculatorState(resultValue: value, lastExpression: expression + ' =', unlockCandidate: candidate)`. Note a bare number is also "evaluated": `1234=` → display `1234`, secondary `1234 =`, candidate `1234`.

## 3.9 `evaluate(tokens)` — precedence × ÷ over + −, left-to-right within a level
1. Empty list → 0.
2. Pass 1: walk tokens left to right building `pass1`. When the token is `multiply` or `divide`: `left = pass1.pop()`, `right = tokens[i+1]`; if divide and `right == 0` → return **null**; push `left*right` or `left/right`; advance by 2. Otherwise push the token, advance by 1.
3. Pass 2: `acc = pass1[0]`; for j = 1, 3, 5…: `op = pass1[j]`, `right = pass1[j+1]`; `acc = (op == add) ? acc + right : acc - right`.
4. Return `acc` (may be ±Infinity on overflow; the caller turns that into the error state). `0/0` → null (Error), not NaN.
Examples: `2+3*4` → 14; `10-2-3` → 5; `8/2/2` → 2; `7/2` → 3.5.

# 4. Controller (`CalculatorController`, Riverpod `Notifier<CalculatorState>`)

State starts at `initial`. Private flag `_busy = false`.

## 4.1 `press(key)` → `Promise<UnlockOutcome | null>`
1. `next = engine.press(state, key)`; `state = next` **synchronously** (the display updates immediately, before and independent of any unlock work).
2. If `next.unlockCandidate == null` → return null.
3. Else return `await _tryUnlock(candidate)`.

## 4.2 `clearAll()` → `state = initial`. Called by the app lifecycle guard on `inactive`, `paused`, `hidden`, `detached` (so the app-switcher preview and a resumed app always show `0`).

## 4.3 `_tryUnlock(digits)` — exactly when `=` is a PIN attempt
1. If `_busy` → return null (a second candidate while an unlock is in flight is ignored; the calculator state was still updated by step 4.1).
2. `status = vaultStatusProvider.value` (the last loaded `VaultStatus{configured: bool, pinLength: int?, unreadable: bool}`; `null` while still loading or if it errored).
3. If `status == null` or `!status.configured` → return null. **No vault / first run / status not loaded: nothing happens; the calculator just shows the number as a result.**
4. If `status.unreadable` → return `UnlockUnavailable` (checked BEFORE the length check, without calling the auth service).
5. If `status.pinLength != digits.length` → return null. Numbers of another length are never attempts and never touch the throttle.
6. `_busy = true`; try:
   a. `result = await vaultSession.unlock(digits)`; if it throws `CredentialsUnreadableException` → return `UnlockUnavailable`.
   b. `UnlockSuccess` → `state = initial` (display resets to `0` before navigation, so the calculator is blank when the user later locks and comes back), fire-and-forget analytics event `vault_unlocked` (no parameters; errors swallowed), return `UnlockOpened`.
   c. `UnlockThrottled(remaining)` → return `UnlockBlocked(remaining)`.
   d. `UnlockWrongPin` or `UnlockNotConfigured` → return null. **Wrong PIN: nothing visible changes — display keeps showing the number with `<n> =` above it.** (The auth service has already recorded the failure for throttling.)
   finally `_busy = false`.

Throttle facts the UI depends on (from PinAuthService/security.md): failures 1–2 free; 3rd → 5 s; 4th → 15 s; 5th → 30 s; 6th → 60 s; 7th → 5 min doubling to a 1 h cap; attempts during a delay return `UnlockThrottled` without deriving; success resets.

# 5. Screen (`CalculatorScreen`)

## 5.1 First-run welcome (post-first-frame)
1. Guard: `_welcomeShown` flag; skip if already shown or unmounted.
2. If `settings.onboardingDone` → return.
3. `status = await vaultStatus` (future); if unmounted or `status.configured` → return.
4. Set `_welcomeShown = true`; show the welcome bottom sheet (`showWelcomeSheet`) → `WelcomeChoice.setup | later`.
5. `setup` → push route `/setup`; `later` → persist `onboardingDone = true`.

## 5.2 Key handling `_onKey(key)`
1. Haptic: selection click on **every** key press.
2. `outcome = await controller.press(key)`; if unmounted or null → return.
3. `UnlockOpened` → `go('/vault')` (replace, not push).
4. `UnlockBlocked(remaining)` → `_showBlocked(remaining)`.
5. `UnlockUnavailable` → hide current snackbar, show snackbar text `The vault credentials on this device cannot be read.` with action `Forgot PIN?` → opens the forgot-PIN dialog.

## 5.3 `_showBlocked(remaining)`
1. `seconds = trunc(remaining in seconds)` clamped to [1, 86400].
2. `label = seconds >= 60 ? ceil(seconds/60) + ' min' : seconds + ' s'` (e.g. `5 s`, `1 min`, `2 min` for 90 s, `60 min` for 3600 s).
3. Hide current snackbar; show `Too many attempts. Try again in <label>.` with action `Forgot PIN?` → forgot-PIN dialog.

## 5.4 Layout / responsive rules
- `Scaffold > SafeArea > Center > ConstrainedBox(maxWidth: 720) > LayoutBuilder`.
- `showSetup = status != null && !status.configured`.
- `landscape = maxWidth > maxHeight && maxWidth > 640`.
- Landscape: `Row[ Expanded(Column[ Align(topRight: menu), Expanded(CalculatorDisplay) ]), Expanded(Padding(all 8, CalculatorKeypad)) ]` — two equal halves, display left, keypad right.
- Portrait: `Column[ Align(topRight: menu), Expanded(flex 2: CalculatorDisplay), Expanded(flex 4: Padding(left 8, top 0, right 8, bottom 8, CalculatorKeypad)) ]` — display 1/3, keypad 2/3 of remaining height.

## 5.5 Overflow menu (`_Menu`, test key `calc_menu`, tooltip `More`, default platform "more" icon)
- If `showSetup`: item (test key `menu_setup_vault`) with lock-outline icon, title `Set up private vault` → push `/setup`.
- Always: item with info-outline icon, title `About` → push `/about` (the disguised About screen).
- When the vault is configured (or status still loading) only `About` is shown.

# 6. Display widget (`CalculatorDisplay`)
- Padding: horizontal 24, vertical 8. Column bottom-aligned, right-aligned.
- Secondary line: `expressionLine`, test key `calc_expression`, 1 line, tail-ellipsis, right-aligned, Material `titleMedium` style, color `onSurfaceVariant`, tabular figures.
- 8 px gap.
- Main line: `display`, test key `calc_display`, 1 line, `displayLarge` at font size 64, weight 300, color `onSurface`, tabular figures, wrapped in a scale-down FittedBox anchored center-right (text shrinks to fit rather than wrapping/ellipsizing).

# 7. Keypad (`CalculatorKeypad`) — 5 rows × 4 columns, fills all available space
| row | col 1 | col 2 | col 3 | col 4 |
|---|---|---|---|---|
| 1 | `C` (clear) | `⌫` (backspace, U+232B) | `%` (percent) | `÷` (divide) |
| 2 | `7` | `8` | `9` | `×` (multiply) |
| 3 | `4` | `5` | `6` | `−` (subtract, U+2212) |
| 4 | `1` | `2` | `3` | `+` (add) |
| 5 | `±` (negate, U+00B1) | `0` | `.` (point) | `=` (equals) |

- Column of 5 equally-expanded rows, each a row of 4 equally-expanded cells (no fixed sizes).
- Each cell: outer padding 5 on all sides; accessibility role button with label; rounded rectangle radius 20; ink ripple on tap; centered label font size 28; weight 500 for digits, 600 for everything else; widget key `calc_key_<CalcKey.name>`.
- Accessibility labels: point `decimal point`, add `plus`, subtract `minus`, multiply `multiply`, divide `divide`, equals `equals`, clear `clear`, backspace `backspace`, percent `percent`, negate `plus minus`, digits their digit.
- Colors (Material 3 color-scheme roles):
| keys | background | foreground |
|---|---|---|
| `=` | primary | onPrimary |
| `+ − × ÷` | secondaryContainer | onSecondaryContainer |
| `C`, `⌫`, `%` | surfaceContainerHighest | primary |
| digits, `.`, `±` | surfaceContainerHigh | onSurface |

# 8. Worked traces
- `12+3=` → display `15`, secondary `12 + 3 =`; then `C` → `0`, secondary empty.
- `5/0=` → display `Error`, secondary `5 ÷ 0 =`; then `7` → display `7` (fresh).
- `1111=` with PIN `2468` configured: display `1111`, secondary `1111 =`, failure recorded (same length). Screen unchanged.
- `12345=` with 4-digit PIN: display `12345`, no attempt, throttle untouched.
- `2468=` correct: state resets to `0`, navigate to `/vault`; after locking, calculator shows `0`.
- `2468=` while throttled: display `2468`, snackbar `Too many attempts. Try again in 5 s.` + `Forgot PIN?`.
- `=` on initial state: no change. `.` → `0.`; `1..5` → `1.5`; `5~~` → `5`; `1+2=<` → `0`.

## Public API

## Engine (pure, no side effects)
- `enum CalcKey { digit0…digit9, point, add, subtract, multiply, divide, equals, clear, backspace, percent, negate }` with `bool isDigit`, `String digit`, `bool isOperator`, `CalcOp op` (throws for non-operators), `static CalcKey digitKey(int d)`.
- `enum CalcOp { add('+'), subtract('−'), multiply('×'), divide('÷') }` with `final String symbol`.
- `class CalculatorState { tokens: List<double|CalcOp>, entry: String, resultValue: double?, lastExpression: String?, error: bool, unlockCandidate: String? }`
  - `static const initial`; `static const int maxEntryDigits = 15`
  - `bool get justEvaluated`; `String get display`; `String get expressionLine`
  - `copyWith({tokens, entry, resultValue, clearResult=false, lastExpression, clearExpression=false, error, unlockCandidate, clearCandidate=true})`
  - `static String formatNumber(double v)`
- `class CalculatorEngine { const CalculatorEngine(); CalculatorState press(CalculatorState s, CalcKey key); static double? evaluate(List<Object> tokens) }` — `evaluate` returns null for division by zero.

## Controller (Riverpod)
- `sealed class UnlockOutcome`; `class UnlockOpened`; `class UnlockBlocked(Duration remaining)`; `class UnlockUnavailable`.
- `class CalculatorController extends Notifier<CalculatorState>`:
  - `CalculatorState build()` → `CalculatorState.initial`
  - `Future<UnlockOutcome?> press(CalcKey key)` — updates state synchronously, then (only when the new state carries an `unlockCandidate`) runs the unlock attempt and returns its outcome; null means "nothing to do".
  - `void clearAll()` — resets to `initial` (used by the lifecycle guard on inactive/paused/hidden/detached).
- `final calculatorControllerProvider = NotifierProvider<CalculatorController, CalculatorState>`.
- Dependencies read: `vaultStatusProvider` (AsyncValue<VaultStatus{configured, pinLength, unreadable}>), `vaultSessionProvider.notifier.unlock(String pin) → Future<UnlockResult>` (UnlockSuccess | UnlockWrongPin | UnlockThrottled(remaining) | UnlockNotConfigured; may throw CredentialsUnreadableException), `analyticsProvider` + `logEventSafely(analytics, 'vault_unlocked')`.

## Widgets
- `CalculatorScreen()` — ConsumerStatefulWidget, route `/`.
- `CalculatorDisplay({required CalculatorState state})`.
- `CalculatorKeypad({required ValueChanged<CalcKey> onKey})` with `static const List<List<CalcKey>> layout` (5×4, see spec §7).
- `CalculatorKeyButton({required CalcKey calcKey, required VoidCallback onPressed})` with `static String labelFor(CalcKey)` and `static String semanticsFor(CalcKey)`.

## External contracts used
- `PinPolicy.looksLikePin(String) → bool` (= `isValid`: `^[0-9]+$`, 4 ≤ len ≤ 8, no leading `0`); `PinPolicy.minLength = 4`, `maxLength = 8`.
- Routes: `AppRoutes.calculator = '/'`, `setup = '/setup'`, `vault = '/vault'`, `calculatorAbout = '/about'`.
- `showWelcomeSheet(context) → Future<WelcomeChoice{setup, later}>`; `showForgotPinDialog(context, ref) → Future<void>`.
- `AppSettings.onboardingDone: bool` (default false) via `settingsProvider` / `SettingsController.update(fn)`.

## Tests

## Unit tests — `test/features/calculator/calculator_engine_test.dart`
Helper `type(keys, [start])` feeds characters to a const `CalculatorEngine` starting from `initial` (or `start`): `+`→add, `-`→subtract, `*`→multiply, `/`→divide, `=`→equals, `.`→point, `C`→clear, `<`→backspace, `%`→percent, `~`→negate, any other char → that digit key. Assertions are on `.display`, `.expressionLine`, `.tokens`, `.resultValue`, `.error`, `.entry`, `.unlockCandidate`.

group `arithmetic`
1. `adds` — `1+2=` display `3`.
2. `subtracts into negatives` — `3-5=` → `-2`.
3. `multiplies` — `6*7=` → `42`.
4. `divides with decimals` — `7/2=` → `3.5`.
5. `respects precedence` — `2+3*4=` → `14`.
6. `chains left to right for same precedence` — `10-2-3=` → `5`; `8/2/2=` → `2`.
7. `formats floating point noise away` — `0.1+0.2=` → `0.3`; `1/3=` → `0.3333333333`.
8. `division by zero is an error and clears on next digit` — `5/0=` display `Error` and `error == true`; pressing `7` from that state → display `7`.
9. `continues from a result` — `5=+3=` → `8`.
10. `replaces a pending operator` — `5+*2=` → `10`.
11. `leading operator uses zero` — `+5=` → `5`.
12. `repeated equals is stable` — `2+2==` → `4`.
13. `large numbers use exponent form` — `99999999*99999999*99999999=` → `9.9999997e23`.

group `entry editing`
14. `leading zeros collapse` — `007` → `7`.
15. `decimal point once` — `1..5` → `1.5`.
16. `point on empty entry gives 0.` — `.` → `0.`.
17. `backspace removes a digit` — `123<` → `12`.
18. `backspace on empty stays 0` — `1<<` → `0`.
19. `backspace after result clears` — `1+2=<` → `0`.
20. `clear resets everything` — `1+2C` → display `0` and `tokens` empty.
21. `percent divides entry by 100` — `50%` → `0.5`.
22. `negate toggles sign` — `5~` → `-5`; `5~~` → `5`.
23. `digit after result starts fresh` — `2+2=3` → display `3`, `tokens` empty, `resultValue` null.
24. `entry digits are capped` — `1234567890123456789` → `entry.length == 15` (`maxEntryDigits`).

group `expression line`
25. `shows pending expression` — `12+3` → expressionLine `12 + 3`.
26. `shows evaluated expression` — `12+3=` → `12 + 3 =`.
27. `shows unicode operator symbols` — `2*3/4` → `2 × 3 ÷ 4`.

group `unlock candidate`
28. `bare 4-8 digit integer on equals is a candidate` — `1234=` candidate `1234`; `12345678=` candidate `12345678`; `1234=` display `1234`.
29. `too short or too long is not a candidate` — `123=` null; `123456789=` null.
30. `decimals and expressions are not candidates` — `12.34=`, `1+234=`, `1234+=`, `1234~=` all null.
31. `candidate is consumed by the next key press` — `1234=` gives `1234`; from that state `5` → null; from that state `=` → null.

## Related unit tests — `test/core/security/pin_policy_test.dart`
- `accepts 4 to 8 digits not starting with zero` — `1234`, `98765432` valid.
- `rejects short, long, non-digit and leading-zero PINs` — `123` tooShort, `123456789` tooLong, `12a4` notDigits, `` notDigits, `0123` leadingZero.
- `every error has a user-facing description` — non-empty text for each error.

## Widget tests — `test/features/calculator/calculator_screen_test.dart`
Harness: `TestHarness.pump(tester, configuredPin: '2468')` boots the real app with in-memory secure store, fake clock, temp vault dir, recording screen-protection, `onboardingDone: true`, no Firebase; Argon2id with tiny test params. `tapCalculator(tester, '12+3=')` taps `Key('calc_key_<name>')` per character (same char map as above minus `%`/`~`) and pumps a frame each. `calculatorDisplay(tester)` = text of `Key('calc_display')`. `settle(tester, frames: n)` pumps n×40 ms frames with 15 ms real delays (default 12).

1. `behaves like a calculator` — CalculatorScreen present; display `0`; after `12+3=` display `15` and text `12 + 3 =` visible; after `C` display `0`.
2. `wrong PIN stays on the calculator, correct PIN opens the vault, lock returns` — `1111=` → still CalculatorScreen, display `1111`; `C2468=` → GalleryScreen shown with text `Your vault is empty`, screen protection was enabled (`calls` contains true); tap `Key('vault_lock')` → back on CalculatorScreen, display `0`, last screen-protection call is false.
3. `a number with a different length than the PIN is never an attempt` — `C12345=` six times → `throttleState().failedCount == 0`; then `C2468=` opens GalleryScreen.
4. `repeated wrong PINs surface the lockout with a forgot-PIN path` — `C1111=`, `C2222=`, `C3333=` → `failedCount == 3`; `C2468=` during the 5 s delay → still CalculatorScreen, a text containing `Too many attempts` and the action `Forgot PIN?` are visible; advance fake clock 6 s; `C2468=` → GalleryScreen.

## UI flows

## Screen: Calculator (route `/`, app launcher screen; nothing hints at the vault)
Structure (portrait): top-right overflow menu button (tooltip `More`) → display area (1/3 of remaining height) → keypad (2/3). Landscape (width > height and width > 640): menu + display in the left half, keypad in the right half. Whole content centered, max width 720, inside safe area.

Display area: right-aligned; small grey secondary line (pending expression like `12 + 3` or, after `=`, `12 + 3 =`; empty on fresh state; single line, tail-ellipsis) above a large thin 64 pt main number (`0` initially; shrinks to fit on one line; `Error` on division by zero/overflow).

Keypad rows (top→bottom): `C ⌫ % ÷` / `7 8 9 ×` / `4 5 6 −` / `1 2 3 +` / `± 0 . =`. `=` in primary color; operators in secondary container; `C ⌫ %` in highest surface tint with primary-colored glyph; digits/`.`/`±` in high surface tint. Rounded (radius 20), 5 px gutters, 28 pt labels, ripple, selection-click haptic on every press.

Overflow menu items: `Set up private vault` (lock icon; only when no vault is configured) → `/setup`; `About` (info icon) → `/about` (disguised about page).

## Flow: first run
On first frame, if `onboardingDone` is false and no vault is configured: bottom sheet `Welcome to SilentSum` with buttons `Set up vault` (→ push `/setup`) and `Not now` (→ persist `onboardingDone = true`, sheet never shown again). If a vault exists the sheet is skipped.

## Flow: unlock
1. User types a 4–8 digit integer (no leading zero possible) and presses `=`. Display shows the number, secondary line `<number> =` — identical to any other evaluation.
2. If no vault exists / status not loaded → nothing more happens.
3. If the number's length ≠ the configured PIN length → nothing more happens (no throttle impact).
4. Wrong PIN → nothing visible changes (silent failure counted by the throttle).
5. Correct PIN → display resets to `0`, navigate (replace) to `/vault`. Returning after lock shows `0`.
6. Throttled → snackbar `Too many attempts. Try again in 5 s.` / `… in 2 min.` (seconds if < 60 s, else minutes rounded up; clamped 1 s…24 h) with action `Forgot PIN?` → forgot-PIN dialog (erase vault path).
7. Credentials unreadable/corrupt → snackbar `The vault credentials on this device cannot be read.` with action `Forgot PIN?`.
Each new snackbar first hides any currently shown one.

## Lifecycle
When the app becomes inactive/paused/hidden/detached, the calculator is reset to `0` (so the app-switcher thumbnail and the resumed screen never show what was typed).

## Security notes

1. The candidate PIN is held in `CalculatorState.unlockCandidate` for exactly one transition (every `copyWith` drops it; only `=` sets it). Never log or persist calculator state; RN state devtools/Redux loggers would leak PINs — keep the candidate out of any serialized/logged state, or hold it outside the store.
2. Length gating (`status.pinLength != digits.length` → not an attempt) is what prevents ordinary arithmetic from tripping the throttle (tested: six `12345=` presses leave `failedCount == 0` with a 4-digit PIN). Preserve it exactly; only bare integers with empty `tokens` are ever candidates.
3. Wrong PIN produces zero UI difference from evaluating any number: same display, same secondary `<n> =`, no snackbar, no haptic difference (selection click fires on every key). Do not add any "wrong PIN" feedback.
4. `_busy` guard serialises unlock attempts; a second `=` during Argon2id work is ignored (the calculator state still updates). On success the state is reset to `initial` before navigation so no PIN residue is shown when the user locks and returns.
5. Lifecycle: `clearAll()` on inactive/paused/hidden/detached wipes typed digits so the app-switcher preview / resume never shows a partially typed PIN.
6. The `unreadable` check precedes the length check: ANY 4–8 digit bare integer + `=` shows `The vault credentials on this device cannot be read.` when the secure store is corrupt — this reveals that a vault exists, by design (the only remedy is erase/restore).
7. The PIN travels as an immutable string to `unlock(digits)`; zeroing is not possible in Dart/JS — accepted limitation (security.md).
8. Analytics: only the coarse event name `vault_unlocked` with no parameters, fire-and-forget, errors swallowed; never log entry, candidate, or PIN length.
9. Leading zeros are dropped by the entry rules (`0` then digit → digit), which is why `PinPolicy` forbids a leading 0; a PIN starting with 0 could never be typed on this keypad.
10. Throttling itself lives in PinAuthService (persisted wall-clock deadline + in-process monotonic deadline); the calculator only surfaces `remaining` and never bypasses it (a correct PIN during the delay is refused — tested).

## Open questions

- Number formatting relies on Dart `toStringAsPrecision(10)`; JS `Number.prototype.toPrecision(10)` follows the same ECMAScript algorithm, but the RN team should add the engine test vectors (`9.9999997e23`, `0.3333333333`, `0.3`, `1e16`, `1e-7`) to confirm parity on Hermes.
- Quirk to decide on: `±` or `%` applied to a large/small RESULT writes an exponent-form string into `entry` (e.g. `-1e16`), and subsequent digits are appended to the exponent (`-1e165`) while the digit cap counts the `e`. Faithful port or fix?
- `_negate`/`_percent` branches that modify the last token when `entry` is empty appear unreachable via the key API (an empty entry without a result always ends in an operator). Port for fidelity or drop?
- While `vaultStatusProvider` is still loading at cold start, a `=` on a PIN-shaped number is silently ignored (not queued). Acceptable for RN, or should the attempt wait for status?
- Button/theme colors are Material 3 ColorScheme roles (primary, secondaryContainer, surfaceContainerHigh/Highest, onSurface, onSurfaceVariant); the actual palette lives in the app theme (not part of this subsystem) and must be mapped to RN design tokens.
- The overflow-menu icon is Flutter's platform default (`more_vert` on Android, `more_horiz` on iOS); pick the equivalent per platform in RN.
- Copy text of the welcome sheet body and the forgot-PIN dialog was not read in full (only titles/buttons `Welcome to SilentSum`, `Set up vault`, `Not now`); they belong to the authentication subsystem spec.