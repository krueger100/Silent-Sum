import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { ERASE_PHRASE, ForgotPinDialog } from '@/auth/screens/ForgotPinDialog';
import { buildHarness, renderWithServices, type Harness } from '@/auth/screens/__tests__/harness';
import { SodiumSecureRandom } from '@/crypto';
import { utf8Encode } from '@/utils/bytes';

const random = new SodiumSecureRandom();

async function seedVault(harness: Harness): Promise<void> {
  const keys = await harness.services.auth.setupPin('2468');
  harness.services.session.adopt(keys);
  const repository = await harness.services.vault.open(keys);
  const image = random.bytes(1024);
  image.set(utf8Encode('PLAINTEXT'), 0);
  await repository.addPhoto({ bytes: image }, { source: 'import' });
  await harness.services.settings.update({ onboardingDone: true, backupEnabled: true });
}

function vaultFileCount(harness: Harness): number {
  const root = harness.services.paths.root;
  return [...harness.fs.allFiles.keys()].filter((uri) => uri.startsWith(root)).length;
}

describe('ForgotPinDialog', () => {
  it('offers no recovery, only erasure, and demands the exact phrase', async () => {
    const harness = buildHarness();
    await seedVault(harness);
    expect(vaultFileCount(harness)).toBeGreaterThan(0);
    const onErased = jest.fn();

    await renderWithServices(
      harness.services,
      <ForgotPinDialog visible onDismiss={jest.fn()} onErased={onErased} />,
    );

    expect(screen.getByText('Forgot your PIN?')).toBeTruthy();
    expect(screen.getByTestId('erase_explain_dialog')).toHaveTextContent(/no backdoor/);

    await fireEvent.press(screen.getByTestId('erase_explain_dialog-confirm'));

    // A near miss must not be enough to destroy a vault.
    await fireEvent.changeText(screen.getByTestId('typed-confirm-input'), 'delete my vault');
    await fireEvent.press(screen.getByTestId('erase_confirm_dialog-confirm'));
    expect(onErased).not.toHaveBeenCalled();
    expect(await harness.services.auth.isConfigured()).toBe(true);
    expect(vaultFileCount(harness)).toBeGreaterThan(0);

    await fireEvent.changeText(screen.getByTestId('typed-confirm-input'), ERASE_PHRASE);
    await fireEvent.press(screen.getByTestId('erase_confirm_dialog-confirm'));

    // The dialog reports what happened before it closes: the caller is not told the vault is gone
    // until the user has been told what that means for their photos.
    await waitFor(() => {
      expect(screen.getByTestId('erase_outcome_dialog')).toBeTruthy();
    });
    expect(onErased).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('erase_outcome_dialog-confirm'));
    expect(onErased).toHaveBeenCalledTimes(1);

    expect(await harness.services.auth.isConfigured()).toBe(false);
    expect(harness.services.session.isUnlocked).toBe(false);
    expect(harness.services.vault.current).toBeNull();
    expect(harness.services.settings.current.onboardingDone).toBe(false);
    expect(harness.services.settings.current.backupEnabled).toBe(false);
    expect(await harness.settingsStore.load()).toMatchObject({ onboardingDone: false });
    expect(vaultFileCount(harness)).toBe(0);
  });

  it('keeps everything when the user backs out', async () => {
    const harness = buildHarness();
    await seedVault(harness);
    const onDismiss = jest.fn();

    await renderWithServices(
      harness.services,
      <ForgotPinDialog visible onDismiss={onDismiss} onErased={jest.fn()} />,
    );

    await fireEvent.press(screen.getByText('Keep trying'));

    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(await harness.services.auth.isConfigured()).toBe(true);
    expect(vaultFileCount(harness)).toBeGreaterThan(0);
  });
});
