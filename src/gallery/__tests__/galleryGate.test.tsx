/**
 * The free tier at the gallery's import button. Only ADDING is gated, only in a build that can
 * sell, and only once the cap is reached; the picker itself is capped at the room left so a
 * selection can never be half-imported.
 */
import { fireEvent, waitFor, type RenderResult } from '@testing-library/react-native';
import React from 'react';

import type { Services } from '@/app/services';
import { InMemoryBillingService } from '@/billing/billingService';
import { FREE_TIER } from '@/billing/entitlements';
import { AcceptingCaptureInspector } from '@/camera/captureInspector';
import { GalleryScreen } from '@/gallery/GalleryScreen';
import {
  MarkedThumbnailGenerator,
  buildServices,
  imageBytes,
  renderInVault,
  unlockedVault,
} from '@/gallery/__tests__/vaultHarness';
import { InMemoryCloudBackend } from '@/firebase/cloudBackend';
import { NoopAnalyticsService, NoopCrashReporter } from '@/firebase/types';
import { FakeClock } from '@/utils/clock';
import type { VaultRepository } from '@/vault/types';
import type { PickedMedia, PickMediaOptions } from '../../../modules/vault-media';

const pickMedia = jest.fn<Promise<readonly PickedMedia[]>, [PickMediaOptions]>();

jest.mock('expo-image', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const react = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  return {
    Image: (props: Record<string, unknown>) => react.createElement(View, props),
  };
});



interface SellingVault {
  services: Services;
  repository: VaultRepository;
  billing: InMemoryBillingService;
  stop: () => void;
}

/** An unlocked vault in a build that can sell, with the entitlements controller running. */
async function sellingVault(): Promise<SellingVault> {
  const cloud = new InMemoryCloudBackend();
  const clock = new FakeClock();
  const billing = new InMemoryBillingService(cloud, clock);
  const { services } = buildServices(
    new MarkedThumbnailGenerator(),
    new AcceptingCaptureInspector(),
    {
      clock,
      pickMedia,
      firebase: {
        available: true,
        crash: new NoopCrashReporter(),
        analytics: new NoopAnalyticsService(),
        cloud,
        billing,
      },
    },
  );
  const keys = await services.auth.setupPin('1234');
  services.session.adopt(keys);
  const repository = await services.vault.open(keys);
  await cloud.signUp('buyer@example.test', 'account-password');
  await services.entitlements.load();
  const stop = services.entitlements.start();
  return { services, repository, billing, stop };
}

async function fill(repository: VaultRepository, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await repository.addPhoto({ bytes: imageBytes(0x10 + (i % 200)) }, { source: 'camera' });
  }
}

async function pressImport(view: RenderResult): Promise<void> {
  await waitFor(() => {
    expect(view.getByTestId('gallery-import')).toBeTruthy();
  });
  await fireEvent.press(view.getByTestId('gallery-import'));
}

beforeEach(() => {
  pickMedia.mockReset();
  pickMedia.mockResolvedValue([]);
});

describe('GalleryScreen import gate', () => {
  it('lets the free tier open the picker while there is room', async () => {
    const { services, repository, stop } = await sellingVault();
    await fill(repository, FREE_TIER.maxItems - 2);
    const view = await renderInVault(services, <GalleryScreen />);

    await pressImport(view);

    await waitFor(() => {
      expect(pickMedia).toHaveBeenCalledTimes(1);
    });
    expect(pickMedia.mock.calls[0]?.[0]).toMatchObject({ allowsMultipleSelection: true });
    expect(view.queryByTestId('vault_upsell')).toBeNull();
    stop();
  });

  it('shows the Cloud dialog instead of the picker once the free vault is full', async () => {
    const { services, repository, stop } = await sellingVault();
    await fill(repository, FREE_TIER.maxItems);
    const onOpenPlans = jest.fn();
    const view = await renderInVault(services, <GalleryScreen onOpenPlans={onOpenPlans} />);

    await pressImport(view);

    expect(pickMedia).not.toHaveBeenCalled();
    expect(view.getByTestId('vault_upsell')).toHaveTextContent(
      new RegExp(`free vault holds ${String(FREE_TIER.maxItems)} items`),
    );
    expect(view.getByTestId('vault_upsell')).toHaveTextContent('₱99/month', { exact: false });
    // Everything already in the vault is untouched by the answer.
    expect(repository.photos).toHaveLength(FREE_TIER.maxItems);

    await fireEvent.press(view.getByTestId('vault_upsell-confirm'));
    expect(onOpenPlans).toHaveBeenCalledTimes(1);
    expect(view.queryByTestId('vault_upsell')).toBeNull();
    stop();
  });

  it('closes the dialog with "Not now" and leaves everything as it was', async () => {
    const { services, repository, stop } = await sellingVault();
    await fill(repository, FREE_TIER.maxItems);
    const view = await renderInVault(services, <GalleryScreen onOpenPlans={jest.fn()} />);

    await pressImport(view);
    await fireEvent.press(view.getByTestId('vault_upsell-cancel'));

    expect(view.queryByTestId('vault_upsell')).toBeNull();
    expect(pickMedia).not.toHaveBeenCalled();
    stop();
  });

  it('lifts the gate the moment a Cloud term arrives', async () => {
    const { services, repository, billing, stop } = await sellingVault();
    await fill(repository, FREE_TIER.maxItems);
    billing.completePayment((await billing.createCheckout('cloud')).checkoutId);
    await services.entitlements.flush();
    const view = await renderInVault(services, <GalleryScreen />);

    await pressImport(view);

    await waitFor(() => {
      expect(pickMedia).toHaveBeenCalledTimes(1);
    });
    expect(pickMedia.mock.calls[0]?.[0]).toMatchObject({ allowsMultipleSelection: true });
    stop();
  });

  it('never gates a build that cannot sell', async () => {
    const { services, repository } = await unlockedVault(undefined, undefined, { pickMedia });
    await fill(repository, FREE_TIER.maxItems);
    const view = await renderInVault(services, <GalleryScreen />);

    await pressImport(view);

    await waitFor(() => {
      expect(pickMedia).toHaveBeenCalledTimes(1);
    });
    expect(pickMedia.mock.calls[0]?.[0]).toMatchObject({ allowsMultipleSelection: true });
    expect(view.queryByTestId('vault_upsell')).toBeNull();
  });
});
