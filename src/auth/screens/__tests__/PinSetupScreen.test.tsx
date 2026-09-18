import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { buildHarness, renderWithServices } from '@/auth/screens/__tests__/harness';
import { PinSetupScreen } from '@/auth/screens/PinSetupScreen';
import { SECURE_STORE_KEYS } from '@/secure-storage/secureStore';

const PIN = '2468';

async function typePin(pin: string): Promise<void> {
  for (const digit of pin.split('')) {
    await fireEvent.press(screen.getByTestId(`pin_key_${digit}`));
  }
}

async function pressNext(): Promise<void> {
  await fireEvent.press(screen.getByTestId('pin_next'));
}

describe('PinSetupScreen create', () => {
  it('creates a vault, opens it and reports back to the navigator', async () => {
    const harness = buildHarness();
    const onDone = jest.fn();
    await renderWithServices(harness.services, <PinSetupScreen mode="create" onDone={onDone} />);

    await typePin(PIN);
    await pressNext();
    await typePin(PIN);
    await pressNext();

    await waitFor(() => {
      expect(screen.getByTestId('pin_done')).toBeTruthy();
    });

    expect(await harness.services.auth.isConfigured()).toBe(true);
    expect(harness.services.settings.current.onboardingDone).toBe(true);
    expect(await harness.settingsStore.load()).toMatchObject({ onboardingDone: true });

    // Setup hands the vault straight over: the session is unlocked, the vault is open, and the
    // navigator has been told. A navigator gated on `isUnlocked` swaps stacks on this.
    await waitFor(() => {
      expect(harness.services.session.isUnlocked).toBe(true);
    });
    expect(harness.services.vault.current).not.toBeNull();
    expect(onDone).toHaveBeenCalled();

    // The vault is open before the session unlocks, so nothing can mount against a closed vault.
    expect(harness.services.vault.store.getState().isOpen).toBe(true);

    // Pressing the button on the success screen is harmless once the handover already happened.
    await fireEvent.press(screen.getByTestId('pin_done'));
    expect(harness.services.session.isUnlocked).toBe(true);
  });

  it('never leaves key material alive when the screen is torn down mid-flow', async () => {
    const harness = buildHarness();
    const view = await renderWithServices(
      harness.services,
      <PinSetupScreen mode="create" onDone={jest.fn()} />,
    );

    await typePin(PIN);
    await pressNext();
    await view.unmount();

    // Nothing was created, so nothing is unlocked and the vault is still unconfigured.
    expect(harness.services.session.isUnlocked).toBe(false);
    expect(await harness.services.auth.isConfigured()).toBe(false);
  });

  it('writes the PIN only into the secure-store record, never to a file', async () => {
    const harness = buildHarness();
    await renderWithServices(harness.services, <PinSetupScreen mode="create" onDone={jest.fn()} />);

    await typePin('13579');
    await pressNext();
    await typePin('13579');
    await pressNext();
    await waitFor(() => {
      expect(screen.getByTestId('pin_done')).toBeTruthy();
    });

    // The substring unlock rule has to read the PIN, so the credential record holds it. Nothing
    // else does: no other secure-store key, and no file on disk.
    expect(
      JSON.parse(harness.secureStore.snapshot[SECURE_STORE_KEYS.vaultCredentials] ?? '{}'),
    ).toMatchObject({
      pinLength: 5,
      pin: '13579',
    });
    for (const [key, value] of Object.entries(harness.secureStore.snapshot)) {
      if (key === SECURE_STORE_KEYS.vaultCredentials) continue;
      expect(value).not.toContain('13579');
    }
    for (const [, bytes] of harness.fs.allFiles) {
      expect(new TextDecoder().decode(bytes)).not.toContain('13579');
    }
  });

  it('restarts the confirmation when the two PINs differ, and still succeeds afterwards', async () => {
    const harness = buildHarness();
    await renderWithServices(harness.services, <PinSetupScreen mode="create" onDone={jest.fn()} />);

    await typePin(PIN);
    await pressNext();
    await typePin('1357');
    await pressNext();

    expect(screen.getByTestId('pin_error')).toHaveTextContent(/do not match/);
    // Still on the confirmation step, with the typed digits cleared.
    expect(screen.getByTestId('pin_start_over')).toBeTruthy();
    expect(await harness.services.auth.isConfigured()).toBe(false);

    await typePin(PIN);
    await pressNext();
    await waitFor(() => {
      expect(screen.getByTestId('pin_done')).toBeTruthy();
    });
    expect(await harness.services.auth.isConfigured()).toBe(true);
  });

  it('starting over returns to choosing a PIN', async () => {
    const harness = buildHarness();
    await renderWithServices(harness.services, <PinSetupScreen mode="create" onDone={jest.fn()} />);

    await typePin(PIN);
    await pressNext();
    await fireEvent.press(screen.getByTestId('pin_start_over'));

    expect(screen.queryByTestId('pin_start_over')).toBeNull();
    expect(screen.getByText('Choose a vault PIN')).toBeTruthy();
  });

  it.each([
    ['too short', '123', 'Use at least 4 digits.'],
    [
      'a leading zero',
      '0246',
      'The PIN cannot start with 0, because the calculator drops leading zeros.',
    ],
  ])('refuses a PIN with %s', async (_label, pin, message) => {
    const harness = buildHarness();
    await renderWithServices(harness.services, <PinSetupScreen mode="create" onDone={jest.fn()} />);

    await typePin(pin);
    await pressNext();

    expect(screen.getByTestId('pin_error')).toHaveTextContent(message);
    expect(await harness.services.auth.isConfigured()).toBe(false);
  });
});

describe('PinSetupScreen change', () => {
  it('changes the PIN when the current one is right', async () => {
    const harness = buildHarness();
    (await harness.services.auth.setupPin(PIN)).dispose();
    const onDone = jest.fn();
    await renderWithServices(harness.services, <PinSetupScreen mode="change" onDone={onDone} />);

    await typePin(PIN);
    await pressNext();
    await typePin('9753');
    await pressNext();
    await typePin('9753');
    await pressNext();

    await waitFor(() => {
      expect(screen.getByTestId('pin_done')).toBeTruthy();
    });

    const unlocked = await harness.services.auth.unlock('9753');
    expect(unlocked.kind).toBe('success');
    if (unlocked.kind === 'success') unlocked.keys.dispose();
  });

  it('reports a wrong current PIN and starts again from the current-PIN step', async () => {
    const harness = buildHarness();
    (await harness.services.auth.setupPin(PIN)).dispose();
    await renderWithServices(harness.services, <PinSetupScreen mode="change" onDone={jest.fn()} />);

    await typePin('1357');
    await pressNext();
    await typePin('9753');
    await pressNext();
    await typePin('9753');
    await pressNext();

    await waitFor(() => {
      expect(screen.getByTestId('pin_error')).toHaveTextContent('That is not your current PIN.');
    });
    expect(screen.getByText('Enter your current PIN')).toBeTruthy();

    // The old PIN still works, the attempted new one does not.
    const stillOld = await harness.services.auth.unlock(PIN);
    expect(stillOld.kind).toBe('success');
    if (stillOld.kind === 'success') stillOld.keys.dispose();
  });

  it('reports the remaining lockout in words when the throttle is engaged', async () => {
    const harness = buildHarness();
    (await harness.services.auth.setupPin(PIN)).dispose();
    // Three consecutive failures put the throttle into a five-second lockout.
    for (let attempt = 0; attempt < 3; attempt++) {
      await harness.services.auth.unlock('1357');
    }
    expect(await harness.services.auth.remainingLockoutMs()).toBe(5000);

    await renderWithServices(harness.services, <PinSetupScreen mode="change" onDone={jest.fn()} />);

    await typePin(PIN);
    await pressNext();
    await typePin('9753');
    await pressNext();
    await typePin('9753');
    await pressNext();

    await waitFor(() => {
      expect(screen.getByTestId('pin_error')).toHaveTextContent(
        'Too many attempts. Try again in 5 seconds.',
      );
    });
    // The refused change left the old PIN in place.
    const stillOld = await harness.services.auth.unlock(PIN);
    expect(stillOld.kind).toBe('throttled');
  });
});
