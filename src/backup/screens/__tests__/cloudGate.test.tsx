/**
 * The cloud screens with a build that can sell: backup and restore are SilentSum Cloud features,
 * so without an active term they show the gate card instead of their controls. Everything that
 * lets a user leave -- signing out, deleting the backup, deleting the account -- stays.
 */
import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { CloudBackupScreen } from '@/backup/screens/CloudBackupScreen';
import { RestoreFlowScreen } from '@/backup/screens/RestoreFlowScreen';
import {
  buildHarness,
  openVaultWithPhotos,
  renderWithServices,
  type Harness,
} from '@/backup/screens/__tests__/harness';
import { InMemoryBillingService } from '@/billing/billingService';
import { InMemoryCloudBackend } from '@/firebase/cloudBackend';
import { NoopAnalyticsService, NoopCrashReporter } from '@/firebase/types';
import { FakeClock } from '@/utils/clock';

const DAY = 86_400_000;
const EMAIL = 'vault@example.test';
const ACCOUNT_PASSWORD = 'account-password';
const PASSPHRASE = 'correct horse battery staple';

interface SellingHarness extends Harness {
  readonly cloud: InMemoryCloudBackend;
  readonly billing: InMemoryBillingService;
  readonly stop: () => void;
}

async function buildSellingHarness(cloud = new InMemoryCloudBackend()): Promise<SellingHarness> {
  const clock = new FakeClock();
  const billing = new InMemoryBillingService(cloud, clock);
  const harness = buildHarness({
    clock,
    firebase: {
      available: true,
      crash: new NoopCrashReporter(),
      analytics: new NoopAnalyticsService(),
      cloud,
      billing,
    },
  });
  await harness.services.entitlements.load();
  const stop = harness.services.entitlements.start();
  // `clock` last: the backup harness reports its own default clock, but the services run on the
  // one passed in above, and it is that one a test has to advance.
  return { ...harness, cloud, billing, stop, clock };
}

async function subscribe(harness: SellingHarness): Promise<void> {
  harness.billing.completePayment((await harness.billing.createCheckout('cloud')).checkoutId);
  await harness.services.entitlements.flush();
}

describe('CloudBackupScreen with a build that can sell', () => {
  it('shows the Cloud-required card instead of the backup controls while Cloud is off', async () => {
    const harness = await buildSellingHarness();
    await openVaultWithPhotos(harness, '2468', 1);
    await harness.cloud.signUp(EMAIL, ACCOUNT_PASSWORD);
    const onPlans = jest.fn();

    await renderWithServices(harness.services, <CloudBackupScreen onPlans={onPlans} />);

    expect(screen.getByTestId('cloud_required')).toHaveTextContent(/SilentSum Cloud is required/);
    expect(screen.getByTestId('cloud_required')).toHaveTextContent(/₱99\/month/);
    expect(screen.queryByTestId('backup_enable')).toBeNull();
    expect(screen.queryByTestId('backup_now')).toBeNull();
    expect(screen.queryByTestId('backup_restore')).toBeNull();
    // The account itself is not gated: it is how the user pays, and how they leave.
    expect(screen.getByTestId('backup_sign_out')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('cloud_required_plans'));
    expect(onPlans).toHaveBeenCalledTimes(1);
    harness.stop();
  });

  it('offers the backup controls once Cloud is active', async () => {
    const harness = await buildSellingHarness();
    await openVaultWithPhotos(harness, '2468', 1);
    await harness.cloud.signUp(EMAIL, ACCOUNT_PASSWORD);
    await subscribe(harness);

    await renderWithServices(harness.services, <CloudBackupScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('backup_enable')).toBeTruthy();
    });
    expect(screen.queryByTestId('cloud_required')).toBeNull();
    harness.stop();
  });

  it('lets a lapsed account still turn backup off and delete its data', async () => {
    const harness = await buildSellingHarness();
    await openVaultWithPhotos(harness, '2468', 1);
    await harness.cloud.signUp(EMAIL, ACCOUNT_PASSWORD);
    await subscribe(harness);
    const backup = harness.services.backup;
    if (backup === null) throw new Error('expected a backup service');
    await backup.enable(harness.services.session.requireKeys(), PASSPHRASE);
    harness.clock.advance(31 * DAY);

    await renderWithServices(harness.services, <CloudBackupScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('cloud_required')).toBeTruthy();
    });
    expect(screen.getByTestId('cloud_required_expired')).toHaveTextContent(/ended on/);
    expect(screen.queryByTestId('backup_now')).toBeNull();
    await waitFor(() => {
      expect(screen.getByTestId('backup_disable')).toBeTruthy();
    });
    harness.stop();
  });

  it('never shows the card before the account has signed in', async () => {
    const harness = await buildSellingHarness();
    await renderWithServices(harness.services, <CloudBackupScreen />);
    expect(screen.queryByTestId('cloud_required')).toBeNull();
    expect(screen.getByTestId('backup_sign_in')).toBeTruthy();
    harness.stop();
  });
});

describe('RestoreFlowScreen with a build that can sell', () => {
  /** A device that already has a vault and has pushed it to the cloud, then signs out. */
  async function seedCloudBackup(cloud: InMemoryCloudBackend): Promise<void> {
    const source = await buildSellingHarness(cloud);
    await openVaultWithPhotos(source, '2468', 1);
    await cloud.signUp(EMAIL, ACCOUNT_PASSWORD);
    await subscribe(source);
    const backup = source.services.backup;
    if (backup === null) throw new Error('expected a backup service');
    await backup.enable(source.services.session.requireKeys(), PASSPHRASE);
    const repository = source.services.vault.current;
    if (repository === null) throw new Error('expected an open vault');
    await backup.backupNow(repository, source.services.session.requireKeys());
    source.services.session.lock();
    source.stop();
    await cloud.signOut();
  }

  async function signIn(): Promise<void> {
    await fireEvent.changeText(screen.getByTestId('restore_email'), EMAIL);
    await fireEvent.changeText(screen.getByTestId('restore_password'), ACCOUNT_PASSWORD);
    await fireEvent.press(screen.getByTestId('restore_sign_in'));
  }

  it('stops after sign-in with the Cloud-required card when the term has lapsed', async () => {
    const cloud = new InMemoryCloudBackend();
    await seedCloudBackup(cloud);
    // A different phone, later: the term bought above has run out.
    const harness = await buildSellingHarness(cloud);
    harness.clock.advance(31 * DAY);
    const onPlans = jest.fn();

    await renderWithServices(
      harness.services,
      <RestoreFlowScreen onDone={jest.fn()} onPlans={onPlans} />,
    );
    await signIn();

    await waitFor(() => {
      expect(screen.getByTestId('restore_cloud_required')).toBeTruthy();
    });
    expect(screen.queryByTestId('restore_passphrase')).toBeNull();
    await fireEvent.press(screen.getByTestId('restore_cloud_required_plans'));
    expect(onPlans).toHaveBeenCalledTimes(1);
    harness.stop();
  });

  it('goes on to the passphrase when Cloud is active on the account', async () => {
    const cloud = new InMemoryCloudBackend();
    await seedCloudBackup(cloud);
    const harness = await buildSellingHarness(cloud);

    await renderWithServices(harness.services, <RestoreFlowScreen onDone={jest.fn()} />);
    await signIn();

    await waitFor(() => {
      expect(screen.getByTestId('restore_passphrase')).toBeTruthy();
    });
    expect(screen.queryByTestId('restore_cloud_required')).toBeNull();
    harness.stop();
  });
});
