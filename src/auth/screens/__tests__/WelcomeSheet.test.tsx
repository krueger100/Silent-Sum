import React from 'react';
import { fireEvent, screen } from '@testing-library/react-native';

import { WelcomeSheet } from '@/auth/screens/WelcomeSheet';
import { buildHarness, renderWithServices } from '@/auth/screens/__tests__/harness';

describe('WelcomeSheet', () => {
  it('says what the app is, that the PIN is the key, and that there is no recovery', async () => {
    const harness = buildHarness();
    await renderWithServices(
      harness.services,
      <WelcomeSheet onSetup={jest.fn()} onLater={jest.fn()} />,
    );

    const sheet = screen.getByTestId('welcome_sheet');
    expect(sheet).toHaveTextContent(/calculator/i);
    expect(sheet).toHaveTextContent(/private photo vault/i);
    expect(sheet).toHaveTextContent(/PIN is the key/i);
    expect(sheet).toHaveTextContent(/There is no recovery/i);
    // How to get in: calculate parts of the PIN until they add up to all of it.
    expect(sheet).toHaveTextContent(/answer is a part of your PIN and press =/);
    expect(sheet).toHaveTextContent(/opens as soon as the parts add up to the whole PIN/);
    // Scrollable, so the copy still fits a small screen.
    expect(screen.getByTestId('welcome_scroll')).toBeTruthy();
  });

  it('hands both choices back to the navigator', async () => {
    const harness = buildHarness();
    const onSetup = jest.fn();
    const onLater = jest.fn();
    await renderWithServices(
      harness.services,
      <WelcomeSheet onSetup={onSetup} onLater={onLater} />,
    );

    await fireEvent.press(screen.getByTestId('welcome_setup'));
    expect(onSetup).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByTestId('welcome_later'));
    expect(onLater).toHaveBeenCalledTimes(1);
  });
});
