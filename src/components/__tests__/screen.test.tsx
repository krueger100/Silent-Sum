/**
 * The page chrome, and specifically the one thing about it that is easy to break by accident:
 * a scrolling page has to get itself out of the keyboard's way.
 *
 * `android:windowSoftInputMode="adjustResize"` is set in the manifest and used to be sufficient.
 * It is not any more. With `edgeToEdgeEnabled=true` (the default from Android 15) the window no
 * longer shrinks when the IME opens -- the app keeps the whole screen and draws behind the
 * keyboard. A PIN field near the bottom of a form then sits underneath the keyboard that is
 * supposed to be typing into it, and scrolling cannot rescue it because the content has nowhere
 * left to go.
 *
 * So the inset is applied in JS, and this spec exists to stop someone removing the wrapper again
 * because the layout looked fine on an emulator that happened to be in hardware-keyboard mode --
 * which is exactly the configuration that hides the bug.
 */
import React from 'react';
import { Text } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { Screen } from '@/components/Screen';
import { TEST_METRICS } from '@/settings/screens/__tests__/harness';

function renderScreen(scroll: boolean): ReturnType<typeof render> {
  return render(
    <SafeAreaProvider initialMetrics={TEST_METRICS}>
      <Screen title="Wipe PIN" scroll={scroll} testID="screen_under_test">
        <Text testID="form_field">field</Text>
      </Screen>
    </SafeAreaProvider>,
  );
}

describe('Screen', () => {
  it('lifts a scrolling page above the keyboard', async () => {
    await renderScreen(true);

    // The wrapper is what applies the keyboard inset; `behavior="padding"` is set on it in
    // Screen.tsx, on both platforms, because relying on the Android window resizing is what broke.
    expect(screen.getByTestId('screen-keyboard-avoider')).toBeTruthy();
    expect(screen.getByTestId('form_field')).toBeTruthy();
  });

  it('leaves a non-scrolling page alone', async () => {
    await renderScreen(false);

    // Nothing to scroll means nothing to lift; a full-height page has no room to give up.
    expect(screen.queryByTestId('screen-keyboard-avoider')).toBeNull();
    expect(screen.getByTestId('form_field')).toBeTruthy();
  });
});
