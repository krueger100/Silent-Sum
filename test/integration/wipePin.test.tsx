/**
 * The wipe PIN, driven through the real app the way a user under duress would drive it.
 *
 * Entering it puts a question up rather than destroying anything, and only the answer starts the
 * wipe. Everything after that answer is still invisible: no notice, no navigation, no welcome
 * sheet appearing a moment later to announce what happened. So the assertions come in two halves
 * -- nothing is destroyed before the prompt is answered, and nothing is SHOWN after it is.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import {
  NoopCrashReporter,
  type AnalyticsEventName,
  type AnalyticsService,
} from '@/firebase/types';

import { buildHarness, digitKeysFor, renderApp, type Harness } from '../support/appHarness';

jest.setTimeout(30000);

const PIN = '2468';
const WIPE_PIN = '55531';
const PASSPHRASE = 'correct horse battery staple';
const EMAIL = 'vault@example.test';
const PASSWORD = 'account-password';

/** Records event names, so "nothing was logged" is asserted rather than assumed. */
class RecordingAnalytics implements AnalyticsService {
  readonly events: AnalyticsEventName[] = [];

  async setEnabled(): Promise<void> {}

  async logEvent(name: AnalyticsEventName): Promise<void> {
    this.events.push(name);
  }
}

async function press(testID: string): Promise<void> {
  await fireEvent.press(screen.getByTestId(testID));
}

async function typeDigits(value: string): Promise<void> {
  for (const key of digitKeysFor(value)) await press(key);
}

/** Types a number and presses `=`, which is every interaction this feature has. */
async function calculate(value: string): Promise<void> {
  await typeDigits(value);
  await press('calc_key_equals');
}

/** Answers the confirmation the wipe PIN now raises. */
async function confirmWipe(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId('wipe_confirm_dialog')).toBeTruthy();
  });
  await press('wipe_confirm_dialog-confirm');
}

async function seedVault(harness: Harness, scope: 'device' | 'backup' | 'both'): Promise<void> {
  const keys = await harness.services.auth.setupPin(PIN);
  const repository = await harness.services.vault.open(keys);
  await repository.addPhoto({ bytes: new Uint8Array(512).fill(3) }, { source: 'import' });

  if (harness.cloud !== null && scope !== 'device') {
    await harness.cloud.signUp(EMAIL, PASSWORD);
    const backup = harness.services.backup;
    if (backup === null) throw new Error('expected a backup service');
    await backup.enable(keys, PASSPHRASE);
    await backup.backupNow(repository, keys);
    await harness.services.settings.update({ backupEnabled: true });
  }

  await harness.services.auth.setWipePin(WIPE_PIN, scope);
  await harness.services.settings.update({ onboardingDone: true });
  await harness.services.vault.close();
  keys.dispose();
}

function vaultFileCount(harness: Harness): number {
  const root = harness.services.paths.root;
  return [...harness.fs.allFiles.keys()].filter((uri) => uri.startsWith(root)).length;
}

describe('the wipe pin on the calculator', () => {
  it('asks first, then destroys the vault and says nothing about it', async () => {
    const harness = buildHarness();
    await seedVault(harness, 'device');
    await renderApp(harness);
    await waitFor(() => screen.getByTestId('calculator-screen'), { timeout: 10000 });
    expect(vaultFileCount(harness)).toBeGreaterThan(0);

    await calculate(WIPE_PIN);

    // The question comes up, and NOTHING has been destroyed yet.
    await waitFor(() => {
      expect(screen.getByTestId('wipe_confirm_dialog')).toHaveTextContent(/cannot be undone/);
    });
    expect(await harness.services.auth.isConfigured()).toBe(true);
    expect(vaultFileCount(harness)).toBeGreaterThan(0);

    await press('wipe_confirm_dialog-confirm');

    // After the answer, the screen goes back to being a calculator and says nothing more.
    expect(screen.getByTestId('calc_value').props.children).toBe(WIPE_PIN);
    expect(screen.getByTestId('calculator-screen')).toBeTruthy();
    expect(screen.queryByTestId('calc_notice')).toBeNull();
    expect(screen.queryByTestId('gallery-grid')).toBeNull();

    // What actually happened.
    await waitFor(async () => {
      expect(await harness.services.auth.isConfigured()).toBe(false);
    });
    expect(vaultFileCount(harness)).toBe(0);
    expect(harness.fs.allFiles.size).toBe(0);
    expect(harness.services.session.isUnlocked).toBe(false);

    // And still nothing on screen a render later: no welcome sheet, no notice, no navigation.
    expect(screen.queryByTestId('welcome_sheet')).toBeNull();
    expect(screen.queryByTestId('calc_notice')).toBeNull();
    expect(screen.getByTestId('calculator-screen')).toBeTruthy();
  });

  it('deletes only the cloud copy when that is the scope, leaving the vault openable', async () => {
    const harness = buildHarness({ withCloud: true });
    await seedVault(harness, 'backup');
    const cloud = harness.cloud;
    if (cloud === null) throw new Error('expected a cloud backend');
    expect(cloud.blobs.size).toBeGreaterThan(0);

    await renderApp(harness);
    await waitFor(() => screen.getByTestId('calculator-screen'), { timeout: 10000 });

    await calculate(WIPE_PIN);
    await confirmWipe();

    // Nothing opened, and nothing moved off the calculator.
    expect(harness.services.session.isUnlocked).toBe(false);
    expect(screen.getByTestId('calculator-screen')).toBeTruthy();
    expect(screen.queryByTestId('gallery-grid')).toBeNull();

    await waitFor(() => {
      expect(cloud.blobs.size).toBe(0);
    });
    expect(cloud.documents.size).toBe(0);
    // The account is not deleted -- it just has nothing in it now.
    expect(cloud.passwordFor(EMAIL)).toBe(PASSWORD);

    // The photos on the phone are untouched, and the real PIN still opens them.
    expect(await harness.services.auth.isConfigured()).toBe(true);
    expect(vaultFileCount(harness)).toBeGreaterThan(0);
    await calculate(PIN);
    await waitFor(() => {
      expect(screen.getByTestId('gallery-grid')).toBeTruthy();
    });
  });

  it('asks about, and executes, the STORED scope rather than any UI default', async () => {
    const harness = buildHarness({ withCloud: true });
    // `backup` is armed while `device` is where the settings picker starts from. If anything on
    // the way from the record to the wipe fell back to a default, this is the test that fails.
    await seedVault(harness, 'backup');
    const cloud = harness.cloud;
    if (cloud === null) throw new Error('expected a cloud backend');
    expect(await harness.services.auth.wipePin()).toMatchObject({ scope: 'backup' });

    await renderApp(harness);
    await waitFor(() => screen.getByTestId('calculator-screen'), { timeout: 10000 });

    await calculate(WIPE_PIN);

    // The question itself is scope-specific, and it describes the cloud, not the phone.
    const dialog = await waitFor(() => screen.getByTestId('wipe_confirm_dialog'));
    expect(dialog).toHaveTextContent(/deleted from the cloud/);
    expect(dialog).not.toHaveTextContent(/every decrypted temporary file/);

    await press('wipe_confirm_dialog-confirm');

    await waitFor(() => {
      expect(cloud.blobs.size).toBe(0);
    });
    // And the device copy the default would have destroyed is still here.
    expect(await harness.services.auth.isConfigured()).toBe(true);
    expect(vaultFileCount(harness)).toBeGreaterThan(0);
  });

  it('does not get in the way of the real PIN', async () => {
    const harness = buildHarness();
    await seedVault(harness, 'both');
    await renderApp(harness);
    await waitFor(() => screen.getByTestId('calculator-screen'), { timeout: 10000 });

    await calculate(PIN);

    await waitFor(() => {
      expect(screen.getByTestId('gallery-grid')).toBeTruthy();
    });
    expect(await harness.services.auth.wipePin()).not.toBeNull();
  });

  it('is not fired by a calculation that only partly matches it', async () => {
    const harness = buildHarness();
    await seedVault(harness, 'device');
    await renderApp(harness);
    await waitFor(() => screen.getByTestId('calculator-screen'), { timeout: 10000 });

    // A run of the wipe PIN, and a number that merely contains it, are both just arithmetic.
    await calculate('555');
    await calculate('555310');

    expect(screen.queryByTestId('wipe_confirm_dialog')).toBeNull();
    expect(await harness.services.auth.isConfigured()).toBe(true);
    expect(vaultFileCount(harness)).toBeGreaterThan(0);
  });

  it('destroys nothing when the question is declined', async () => {
    const harness = buildHarness();
    await seedVault(harness, 'device');
    await renderApp(harness);
    await waitFor(() => screen.getByTestId('calculator-screen'), { timeout: 10000 });
    const before = vaultFileCount(harness);

    await calculate(WIPE_PIN);
    await waitFor(() => {
      expect(screen.getByTestId('wipe_confirm_dialog')).toBeTruthy();
    });
    await fireEvent.press(screen.getByText('Cancel'));

    // The whole point of the prompt: a number typed by mistake costs nothing.
    await waitFor(() => {
      expect(screen.queryByTestId('wipe_confirm_dialog')).toBeNull();
    });
    expect(await harness.services.auth.isConfigured()).toBe(true);
    expect(vaultFileCount(harness)).toBe(before);
    expect(await harness.services.auth.wipePin()).not.toBeNull();

    // And declining does not disarm it: the same number still asks again.
    await calculate(WIPE_PIN);
    await waitFor(() => {
      expect(screen.getByTestId('wipe_confirm_dialog')).toBeTruthy();
    });
  });
});

describe('what the wipe pin leaves in the record', () => {
  it('logs nothing, on a keypad that does log an ordinary unlock', async () => {
    const analytics = new RecordingAnalytics();
    const harness = buildHarness({
      overrides: {
        firebase: {
          available: true,
          crash: new NoopCrashReporter(),
          analytics,
          cloud: null,
        },
      },
    });
    await seedVault(harness, 'device');
    await renderApp(harness);
    await waitFor(() => screen.getByTestId('calculator-screen'), { timeout: 10000 });

    await calculate(WIPE_PIN);
    await confirmWipe();
    await waitFor(async () => {
      expect(await harness.services.auth.isConfigured()).toBe(false);
    });

    // An event here would be a durable record that the feature exists and was used.
    expect(analytics.events).toEqual([]);
  });

  it('proves the recorder works, by logging an ordinary unlock', async () => {
    const analytics = new RecordingAnalytics();
    const harness = buildHarness({
      overrides: {
        firebase: {
          available: true,
          crash: new NoopCrashReporter(),
          analytics,
          cloud: null,
        },
      },
    });
    await seedVault(harness, 'device');
    await renderApp(harness);
    await waitFor(() => screen.getByTestId('calculator-screen'), { timeout: 10000 });

    await calculate(PIN);

    await waitFor(() => {
      expect(analytics.events).toEqual(['vault_unlocked']);
    });
  });
});
