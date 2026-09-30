/**
 * How every keyboard-avoiding wrapper in this app behaves.
 *
 * Two separate things have to be right, and each has its own silent failure.
 *
 * `behavior`: `padding` on BOTH platforms, deliberately. The usual React Native advice is to avoid
 * on iOS and let `android:windowSoftInputMode="adjustResize"` handle Android, written as
 * `Platform.OS === 'ios' ? 'padding' : undefined`. That stopped being true when edge-to-edge became
 * the default: the window no longer shrinks when the IME opens -- the app keeps the whole screen
 * and draws behind the keyboard. `behavior={undefined}` renders a plain `View` and applies no
 * offset at all, so the focused input is simply covered.
 *
 * `keyboardVerticalOffset`: measured, never left at its default of 0 and never hardcoded. This is
 * the subtler one. `KeyboardAvoidingView._relativeKeyboardHeight` computes
 *
 *     Math.max(frame.y + frame.height - (keyboardFrame.screenY - keyboardVerticalOffset), 0)
 *
 * where `frame` comes from `onLayout` -- which is relative to the PARENT -- while
 * `keyboardFrame.screenY` is relative to the SCREEN. The two are only commensurable when the
 * wrapper's top edge is at screen y = 0. A wrapper sitting below a status-bar inset of `t` and a
 * header of `h` therefore lifts its content by `t + h` pixels too few, and the input it exists to
 * reveal stays under the keyboard. On a tall phone that is most of a composer bar.
 *
 * `keyboardVerticalOffset` is documented as "distance between the top of the user screen and the
 * React Native view", which is exactly the correction: feeding it the wrapper's own window
 * position makes the sum come out as `wrapperBottomInWindow - keyboardTopOnScreen`, the real
 * overlap. It is measured rather than computed from insets so it stays right whatever the screen
 * puts above the wrapper -- header or not, inset or not, whatever the font scale -- and it
 * naturally comes out as 0 inside a `Modal`, where the old behaviour was already correct.
 *
 * Four wrappers need the same answer, and both bugs above were one of them disagreeing with the
 * others. `keyboardAvoidance.test.ts` fails if a screen reaches for `KeyboardAvoidingView` itself
 * instead of using `KeyboardAvoider`.
 */
import React, { useCallback, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

export const KEYBOARD_BEHAVIOR = 'padding' as const;

export interface KeyboardAvoiderProps {
  /** Applied to the avoiding view itself, so alignment styles keep working as before. */
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
  readonly children: React.ReactNode;
}

/**
 * A `KeyboardAvoidingView` that knows where it is on screen.
 *
 * The extra `View` exists only to be measured: a ref on `KeyboardAvoidingView` yields the class
 * instance, which has no `measureInWindow`. It is measured instead of the avoider itself, so
 * `frame.y` -- which React Native adds separately -- is not counted twice when the avoider has
 * siblings above it. It carries no styling beyond filling its parent, which leaves the caller's
 * own style on the avoider where it was.
 */
export function KeyboardAvoider({
  style,
  testID,
  children,
}: KeyboardAvoiderProps): React.JSX.Element {
  const host = useRef<React.ComponentRef<typeof View> | null>(null);
  const [offset, setOffset] = useState(0);

  const measure = useCallback(() => {
    const node = host.current;
    if (node === null) return;
    node.measureInWindow((_x, y) => {
      if (typeof y !== 'number' || !Number.isFinite(y)) return;
      // Sub-pixel jitter between layout passes must not re-render on every frame. The offset does
      // not affect this view's own layout, so there is no feedback loop to guard against beyond
      // that.
      setOffset((previous) => (Math.abs(previous - y) < 1 ? previous : y));
    });
  }, []);

  return (
    // `collapsable={false}` or Android flattens this view away in release builds and
    // `measureInWindow` never calls back -- which would silently restore the original bug.
    <View ref={host} style={styles.host} onLayout={measure} collapsable={false}>
      <KeyboardAvoidingView
        testID={testID}
        style={style}
        behavior={KEYBOARD_BEHAVIOR}
        keyboardVerticalOffset={offset}
      >
        {children}
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  host: { flex: 1 },
});
