/**
 * How every keyboard-avoiding wrapper in this app behaves.
 *
 * `padding` on BOTH platforms, deliberately, and this is the reason it is a named constant rather
 * than a literal typed out at each wrapper.
 *
 * The usual React Native advice is to avoid on iOS and let `android:windowSoftInputMode=
 * "adjustResize"` take care of Android, which is written as `Platform.OS === 'ios' ? 'padding' :
 * undefined`. That advice stopped being true when edge-to-edge became the default: the window no
 * longer shrinks when the IME opens -- the app keeps the whole screen and draws behind the
 * keyboard. A `KeyboardAvoidingView` with `behavior={undefined}` renders a plain `View` and
 * applies no offset at all, so the focused input is simply covered.
 *
 * Four wrappers in this app need the same answer, and the bug this replaces was exactly one of
 * them disagreeing with the other three. `keyboardAvoidance.test.ts` fails if a new wrapper spells
 * the behaviour out for itself instead of importing this.
 */
export const KEYBOARD_BEHAVIOR = 'padding' as const;
