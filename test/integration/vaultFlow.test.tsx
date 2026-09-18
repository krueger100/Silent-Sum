/**
 * End-to-end flows through the real app: first run, setup, unlock, lock, and the things that must
 * NOT happen (arithmetic tripping the throttle, a wrong PIN showing anything, plaintext on disk).
 *
 * Only the first-run test drives the setup UI. The rest seed a vault through the same services the
 * UI would have used and then render, which keeps each test to a single mounted app and makes the
 * unlock path, the part that matters most, the thing actually under test.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { looksEncrypted } from '@/crypto/types';
import { SECURE_STORE_KEYS } from '@/secure-storage/secureStore';
import { containsSequence, utf8Encode } from '@/utils/bytes';
import { buildHarness, digitKeysFor, renderApp, type Harness } from '../support/appHarness';

jest.setTimeout(30000);

const PIN = '2468';

async function press(testID: string): Promise<void> {
  await fireEvent.press(screen.getByTestId(testID));
}

async function typeDigits(value: string): Promise<void> {
  for (const key of digitKeysFor(value)) await press(key);
}

/** Creates a vault the way the setup screen does, then leaves the app locked. */
async function seedLockedVault(harness: Harness, pin = PIN): Promise<void> {
  const keys = await harness.services.auth.setupPin(pin);
  keys.dispose();
  await harness.services.settings.update({ onboardingDone: true });
}

describe('first run', () => {
  it('shows the calculator and explains the vault without any hidden gesture', async () => {
    const harness = buildHarness();
    await renderApp(harness);

    await waitFor(() => {
      expect(screen.getByTestId('calculator-screen')).toBeTruthy();
    });
    expect(screen.getByTestId('welcome_sheet')).toBeTruthy();
  });

  it('offers vault setup from the ordinary menu when the sheet is dismissed', async () => {
    const harness = buildHarness();
    await renderApp(harness);
    await waitFor(() => screen.getByTestId('welcome_sheet'));

    await press('welcome_later');
    await waitFor(() => {
      expect(screen.queryByTestId('welcome_sheet')).toBeNull();
    });

    await press('calc_menu');
    expect(screen.getByTestId('menu_setup_vault')).toBeTruthy();
  });

  it('works as a calculator before any vault exists', async () => {
    const harness = buildHarness();
    await renderApp(harness);
    await waitFor(() => screen.getByTestId('welcome_sheet'));
    await press('welcome_later');

    await typeDigits('12');
    await press('calc_key_add');
    await typeDigits('30');
    await press('calc_key_equals');

    expect(screen.getByTestId('calc_value').props.children).toBe('42');
  });

  it('creates a vault through the setup screens and unlocks the session', async () => {
    const harness = buildHarness();
    await renderApp(harness);

    await waitFor(() => screen.getByTestId('welcome_sheet'), { timeout: 10000 });
    await press('welcome_setup');
    await waitFor(() => screen.getByTestId('pin_key_1'), { timeout: 10000 });

    for (let round = 0; round < 2; round++) {
      for (const digit of PIN) await press(`pin_key_${digit}`);
      await press('pin_next');
    }

    // The screen may show a confirmation step that hands the vault over, or unlock by itself.
    await waitFor(
      () => {
        const done = screen.queryByTestId('pin_done');
        expect(done !== null || harness.services.session.isUnlocked).toBe(true);
      },
      { timeout: 10000 },
    );
    const done = screen.queryByTestId('pin_done');
    if (done !== null) await fireEvent.press(done);

    await waitFor(
      () => {
        expect(harness.services.session.isUnlocked).toBe(true);
      },
      { timeout: 10000 },
    );

    const record = harness.secureStore.snapshot[SECURE_STORE_KEYS.vaultCredentials];
    expect(record).toBeDefined();
    // Answering with a part of the PIN has to read the PIN, so the credential record holds it -
    // and no other secure-store entry does.
    for (const [key, value] of Object.entries(harness.secureStore.snapshot)) {
      if (key === SECURE_STORE_KEYS.vaultCredentials) continue;
      expect(value).not.toContain(PIN);
    }
  });
});

describe('super secure', () => {
  /**
   * The menu itself is never taken away -- a calculator has one, and an app whose only exit is
   * invisible strands the person entitled to get in. What super secure removes is everything in
   * it that names a vault.
   */
  it('keeps the menu but leaves nothing in it except About', async () => {
    const harness = buildHarness();
    await seedLockedVault(harness);
    await harness.services.settings.update({ superSecure: true });
    await renderApp(harness);
    await waitFor(() => screen.getByTestId('calculator-screen'));

    expect(screen.getByTestId('calc_menu')).toBeTruthy();
    await press('calc_menu');
    expect(screen.getByTestId('menu_about')).toBeTruthy();
    expect(screen.queryByTestId('menu_forgot_pin')).toBeNull();
    expect(screen.queryByTestId('menu_setup_vault')).toBeNull();

    // Still a calculator, and still the way in.
    await press('calc_menu');
    await typeDigits(PIN);
    await press('calc_key_equals');
    await waitFor(
      () => {
        expect(harness.services.session.isUnlocked).toBe(true);
      },
      { timeout: 10000 },
    );
  });

  it('offers Forgot PIN alongside About while it is off', async () => {
    const harness = buildHarness();
    await seedLockedVault(harness);
    await renderApp(harness);
    await waitFor(() => screen.getByTestId('calculator-screen'));

    await press('calc_menu');
    expect(screen.getByTestId('menu_forgot_pin')).toBeTruthy();
    expect(screen.getByTestId('menu_about')).toBeTruthy();

    await press('menu_forgot_pin');
    expect(screen.getByTestId('forgot_pin_dialog')).toBeTruthy();
  });

  /**
   * The menu is not the only thing that used to lead to the erase dialog: a wrong PIN puts a
   * notice on screen with a "Forgot PIN?" link under it. That is the same route by another door,
   * so super secure has to close it too.
   */
  it('leaves no other route to Forgot PIN while it is on', async () => {
    const harness = buildHarness();
    await seedLockedVault(harness);
    await harness.services.settings.update({ superSecure: true });
    await renderApp(harness);
    await waitFor(() => screen.getByTestId('calculator-screen'));

    // A result that is a PART of the PIN is answered on screen, and that notice is where the
    // second route to the erase dialog used to sit.
    await typeDigits(PIN.slice(0, 1));
    await press('calc_key_equals');
    await waitFor(
      () => {
        expect(screen.getByTestId('calc_notice')).toBeTruthy();
      },
      { timeout: 10000 },
    );

    expect(screen.queryByTestId('calc_notice_forgot')).toBeNull();
    expect(screen.queryByTestId('forgot_pin_dialog')).toBeNull();
  });

  it('shows the same shortcut under the notice while it is off', async () => {
    const harness = buildHarness();
    await seedLockedVault(harness);
    await renderApp(harness);
    await waitFor(() => screen.getByTestId('calculator-screen'));

    await typeDigits(PIN.slice(0, 1));
    await press('calc_key_equals');
    await waitFor(
      () => {
        expect(screen.getByTestId('calc_notice')).toBeTruthy();
      },
      { timeout: 10000 },
    );

    expect(screen.getByTestId('calc_notice_forgot')).toBeTruthy();
  });

  /**
   * About is the only page that menu opens, so it is the page a stranger holding the phone will
   * read. It has to be a calculator's About page: a name, a version, and a way to write to
   * somebody -- and not one word that gives the app away.
   */
  it('opens an About page that says nothing about a vault', async () => {
    const harness = buildHarness();
    await seedLockedVault(harness);
    await harness.services.settings.update({ superSecure: true });
    await renderApp(harness);
    await waitFor(() => screen.getByTestId('calculator-screen'));

    await press('calc_menu');
    await press('menu_about');
    await waitFor(() => {
      expect(screen.getByTestId('about_screen')).toBeTruthy();
    });

    const rendered = JSON.stringify(screen.toJSON());
    for (const word of [
      /vault/i,
      /\bpin\b/i,
      /passphrase/i,
      /backup/i,
      /photo/i,
      /encrypt/i,
      // The warnings the honest page carries are themselves a tell: a calculator has no
      // reason to mention passwords, codes, or stripping digits out of what you send it.
      /password/i,
      /\bcodes?\b/i,
      /digits are removed/i,
    ]) {
      expect(rendered).not.toMatch(word);
    }
    expect(screen.getByTestId('about_app_name')).toHaveTextContent(/Calculator/);
    expect(screen.getByTestId('about_customer_service')).toBeTruthy();
  });

  /** Empty-handed super secure would leave no way to create a vault at all. */
  it('has no effect while there is no vault to hide', async () => {
    const harness = buildHarness();
    await harness.services.settings.update({ superSecure: true, onboardingDone: true });
    await renderApp(harness);
    await waitFor(() => screen.getByTestId('calculator-screen'));

    await press('calc_menu');
    expect(screen.getByTestId('menu_setup_vault')).toBeTruthy();
  });

  /**
   * A credential record that cannot be decoded is the one state where the erase path stays on
   * offer: no PIN can open anything there, so it is not a bypass, it is the only exit.
   */
  it('still offers the erase path when the credential record cannot be read', async () => {
    const harness = buildHarness();
    await seedLockedVault(harness);
    await harness.services.settings.update({ superSecure: true });
    await harness.secureStore.write(SECURE_STORE_KEYS.vaultCredentials, 'not json at all');
    await renderApp(harness);
    await waitFor(() => screen.getByTestId('calculator-screen'));

    await press('calc_menu');
    expect(screen.getByTestId('menu_forgot_pin')).toBeTruthy();
  });
});

describe('unlocking from the calculator', () => {
  it('opens the vault for the right PIN', async () => {
    const harness = buildHarness();
    await seedLockedVault(harness);
    await renderApp(harness);
    await waitFor(() => screen.getByTestId('calculator-screen'));

    await typeDigits(PIN);
    await press('calc_key_equals');

    await waitFor(
      () => {
        expect(harness.services.session.isUnlocked).toBe(true);
      },
      { timeout: 10000 },
    );
  });

  it('shows nothing at all for a result that is not in the PIN', async () => {
    const harness = buildHarness();
    await seedLockedVault(harness);
    await renderApp(harness);
    await waitFor(() => screen.getByTestId('calculator-screen'));

    await typeDigits('1357');
    await press('calc_key_equals');

    await waitFor(() => {
      expect(screen.getByTestId('calc_value').props.children).toBe('1357');
    });
    expect(harness.services.session.isUnlocked).toBe(false);
    expect(screen.queryByTestId('calc_notice')).toBeNull();
  });

  /** The specification's own examples, driven through the real keypad against PIN 12142907. */
  it.each<[string, readonly string[], string]>([
    ['2 - 1 = 1', ['2', 'calc_key_subtract', '1'], '1 is correct, but there are 7 more'],
    ['6 + 6 = 12', ['6', 'calc_key_add', '6'], '12 is correct, but there are 6 more'],
    ['1000 + 214 = 1214', ['1000', 'calc_key_add', '214'], '1214 is correct, but there are 4 more'],
  ])('counts the missing digits without opening the vault: %s', async (_label, steps, message) => {
    const harness = buildHarness();
    await seedLockedVault(harness, '12142907');
    await renderApp(harness);
    await waitFor(() => screen.getByTestId('calculator-screen'));

    for (const step of steps) {
      if (step.startsWith('calc_key_')) await press(step);
      else await typeDigits(step);
    }
    await press('calc_key_equals');

    await waitFor(
      () => {
        expect(screen.getByTestId('calc_notice')).toBeTruthy();
        expect(screen.getByText(message)).toBeTruthy();
      },
      { timeout: 10000 },
    );
    expect(harness.services.session.isUnlocked).toBe(false);
  });

  it('stays locked when the result is not a contiguous part of the PIN', async () => {
    const harness = buildHarness();
    await seedLockedVault(harness, '12142907');
    await renderApp(harness);
    await waitFor(() => screen.getByTestId('calculator-screen'));

    await typeDigits('7');
    await press('calc_key_multiply');
    await typeDigits('7');
    await press('calc_key_equals');

    await waitFor(() => {
      expect(screen.getByTestId('calc_value').props.children).toBe('49');
    });
    expect(harness.services.session.isUnlocked).toBe(false);
    expect(screen.queryByTestId('calc_notice')).toBeNull();
  });

  /** The spec's examples continued: the parts add up and the vault opens on the last one. */
  it('opens the vault once the parts add up to the whole PIN', async () => {
    const harness = buildHarness();
    await seedLockedVault(harness, '12142907');
    await renderApp(harness);
    await waitFor(() => screen.getByTestId('calculator-screen'));

    for (const [part, message] of [
      ['1', '1 is correct, but there are 7 more'],
      ['12', '12 is correct, but there are 6 more'],
      ['1214', '1214 is correct, but there are 4 more'],
    ] as const) {
      await press('calc_key_clear');
      await typeDigits(part);
      await press('calc_key_equals');
      await waitFor(() => screen.getByText(message), { timeout: 10000 });
      expect(harness.services.session.isUnlocked).toBe(false);
    }

    await press('calc_key_clear');
    await typeDigits('2907');
    await press('calc_key_equals');
    await waitFor(
      () => {
        expect(harness.services.session.isUnlocked).toBe(true);
      },
      { timeout: 10000 },
    );
  });

  /** An answer belongs to the calculation that earned it, and to no later one. */
  it('drops the answer as soon as the next calculation begins', async () => {
    const harness = buildHarness();
    await seedLockedVault(harness, '12142907');
    await renderApp(harness);
    await waitFor(() => screen.getByTestId('calculator-screen'));

    await typeDigits('2');
    await press('calc_key_subtract');
    await typeDigits('1');
    await press('calc_key_equals');
    await waitFor(() => screen.getByTestId('calc_notice'), { timeout: 10000 });

    await press('calc_key_clear');
    expect(screen.queryByTestId('calc_notice')).toBeNull();
  });

  it('reports a lockout and offers the only recovery there is', async () => {
    const harness = buildHarness();
    await seedLockedVault(harness);
    await renderApp(harness);
    await waitFor(() => screen.getByTestId('calculator-screen'));

    for (let attempt = 0; attempt < 3; attempt++) {
      await press('calc_key_clear');
      await typeDigits('1357');
      await press('calc_key_equals');
    }
    await press('calc_key_clear');
    await typeDigits(PIN);
    await press('calc_key_equals');

    await waitFor(
      () => {
        expect(screen.getByTestId('calc_notice')).toBeTruthy();
      },
      { timeout: 10000 },
    );
    expect(harness.services.session.isUnlocked).toBe(false);
    expect(screen.getByTestId('calc_notice_forgot')).toBeTruthy();
  });

  it('returns to the calculator when the vault locks', async () => {
    const harness = buildHarness();
    await seedLockedVault(harness);
    await renderApp(harness);
    await waitFor(() => screen.getByTestId('calculator-screen'));

    await typeDigits(PIN);
    await press('calc_key_equals');
    await waitFor(
      () => {
        expect(harness.services.session.isUnlocked).toBe(true);
      },
      { timeout: 10000 },
    );

    await act(() => {
      harness.services.session.lock();
    });

    await waitFor(() => {
      expect(screen.getByTestId('calculator-screen')).toBeTruthy();
    });
    expect(harness.services.session.isUnlocked).toBe(false);
  });
});

describe('what reaches storage', () => {
  it('writes nothing but ciphertext, inside the vault directory only', async () => {
    const harness = buildHarness();
    await seedLockedVault(harness);
    await renderApp(harness);
    await waitFor(() => screen.getByTestId('calculator-screen'));

    await typeDigits(PIN);
    await press('calc_key_equals');
    await waitFor(
      () => {
        expect(harness.services.session.isUnlocked).toBe(true);
      },
      { timeout: 10000 },
    );

    const marker = utf8Encode('VISIBLE-PIXELS');
    const image = new Uint8Array(1024);
    image.set(marker, 0);
    await act(async () => {
      await harness.services.vault
        .requireRepository()
        .addPhoto({ bytes: image }, { source: 'camera' });
    });

    const vaultRoot = harness.services.paths.root;
    let files = 0;
    for (const [uri, bytes] of harness.fs.allFiles) {
      files += 1;
      expect(uri.startsWith(vaultRoot)).toBe(true);
      expect(looksEncrypted(bytes)).toBe(true);
      expect(containsSequence(bytes, marker)).toBe(false);
    }
    expect(files).toBeGreaterThanOrEqual(3);
  });
});

describe('screen protection', () => {
  it('turns on while unlocked and off again on lock', async () => {
    const harness = buildHarness();
    await seedLockedVault(harness);
    await renderApp(harness);
    await waitFor(() => screen.getByTestId('calculator-screen'));

    await typeDigits(PIN);
    await press('calc_key_equals');
    await waitFor(
      () => {
        expect(harness.screenProtection.calls).toContain(true);
      },
      { timeout: 10000 },
    );

    await act(() => {
      harness.services.session.lock();
    });

    await waitFor(() => {
      expect(harness.screenProtection.calls.at(-1)).toBe(false);
    });
  });
});
