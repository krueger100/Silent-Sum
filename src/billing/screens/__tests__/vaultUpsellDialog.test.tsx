/**
 * The copy shown when a gate refuses an addition.
 *
 * `upsellMessage` had no test at all before this file: it is exported, used by both
 * `VaultUpsellDialog` and `CameraSheet`, and nothing pinned its wording. The distinction it now
 * has to make is worth pinning, because getting it wrong means trying to sell a subscription to
 * somebody whose problem a subscription cannot solve.
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';

import { PRODUCTS } from '@/billing/products';
import { VaultUpsellDialog, upsellMessage } from '@/billing/screens/VaultUpsellDialog';

describe('upsellMessage', () => {
  it('offers Cloud when the item limit is what stopped the addition', () => {
    expect(upsellMessage('itemLimit')).toMatch(/50 items/);
    expect(upsellMessage('itemLimit')).toMatch(/SilentSum Cloud/);
  });

  // A file too large for the device is not something a subscription fixes, so this copy must
  // not try to sell anything.
  it('does not offer a plan when the file is simply too large', () => {
    expect(upsellMessage('fileSize')).toMatch(/100 MB/);
    expect(upsellMessage('fileSize')).not.toMatch(/Cloud/);
  });
});

describe('VaultUpsellDialog', () => {
  it('offers the plans screen when the item limit is the problem', async () => {
    await render(
      <VaultUpsellDialog visible reason="itemLimit" onPlans={jest.fn()} onClose={jest.fn()} />,
    );

    expect(screen.getByTestId('vault_upsell-confirm')).toHaveTextContent('See plans');
    expect(screen.getByText(PRODUCTS.cloud.name)).toBeTruthy();
  });

  // The whole point: an oversized file is a size limit, not a paywall. Nothing on this dialog
  // may read as an advertisement -- not the buttons, and not the title either.
  it('sells nothing at all when the file is too large', async () => {
    await render(
      <VaultUpsellDialog visible reason="fileSize" onPlans={jest.fn()} onClose={jest.fn()} />,
    );

    expect(screen.getByTestId('vault_upsell-confirm')).toHaveTextContent('OK');
    expect(screen.queryByTestId('vault_upsell-cancel')).toBeNull();
    // Searched across every rendered Text node, title included -- asserting on the wrapper View
    // would pass vacuously, since a View has no text content of its own.
    expect(screen.queryByText(new RegExp(PRODUCTS.cloud.name))).toBeNull();
    expect(screen.queryByText(new RegExp(PRODUCTS.pro.name))).toBeNull();
    expect(screen.getByText(/100 MB/)).toBeTruthy();
  });
});
