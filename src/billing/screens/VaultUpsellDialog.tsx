/**
 * What the gallery and the camera show when the free tier stops an addition.
 *
 * It is a dialog rather than a silent refusal because the user just tried to do something and
 * nothing happened; and it names the price, because a paywall that hides the price is a paywall
 * the user resents. Nothing already in the vault is affected by the answer.
 */
import React from 'react';

import { CLOUD_TIER, FREE_TIER, MAX_ITEM_BYTES, type GateReason } from '@/billing/entitlements';
import { PRODUCTS } from '@/billing/products';
import { ConfirmDialog } from '@/components/Dialog';

export interface VaultUpsellDialogProps {
  visible: boolean;
  reason: GateReason | null;
  /** Absent when there is no way to the plans screen from here; the dialog then only informs. */
  onPlans?: () => void;
  onClose: () => void;
  testID?: string;
}

/**
 * Why the addition was refused, in the user's terms.
 *
 * The two reasons are different in kind, not just in wording. A full vault is a commercial limit
 * with something to sell against it; a file too large for the device is not, and copy that tried
 * to sell a subscription against it would be offering to fix a problem the subscription does not
 * touch. So the size message names no product at all.
 */
export function upsellMessage(reason: GateReason): string {
  if (reason === 'fileSize') {
    return (
      `That file is larger than ${String(MAX_ITEM_BYTES / (1024 * 1024))} MB, which is the most ` +
      'the vault takes for a single item. Nothing else is affected.'
    );
  }
  // A third kind again: the subscription is working and is simply full. There is nothing to
  // sell against it, so this names no product and offers no upgrade -- and it says plainly
  // that nothing has been lost, because a storage message is exactly where someone fears it has.
  if (reason === 'cloudStorageLimit') {
    return (
      `${PRODUCTS.cloud.name} goes up to ${String(CLOUD_TIER.maxBytes / 1024 ** 3)} GB and this ` +
      'vault is full. Everything already here stays, and stays backed up — only new items are ' +
      'turned away. Remove something to make room, or get in touch through Customer service.'
    );
  }
  return (
    `The free vault holds ${String(FREE_TIER.maxItems)} items and this one is full. Everything ` +
    'already here stays exactly where it is, with or without a subscription. ' +
    `${PRODUCTS.cloud.name} removes the limit; it is ${PRODUCTS.cloud.price}.`
  );
}

export function VaultUpsellDialog({
  visible,
  reason,
  onPlans,
  onClose,
  testID = 'vault_upsell',
}: VaultUpsellDialogProps): React.JSX.Element {
  // A size limit is not a paywall, so it gets no route to the plans screen and no product name in
  // the title either. Leaving the title as "SilentSum Cloud" would make the whole dialog read as
  // an advertisement no matter how carefully the message avoided being one.
  // Neither of these has a plan behind it: one is a device limit, the other is the plan already
  // bought and already full. Offering "See plans" against either sells nothing and reads as a
  // shrug.
  const canOffer =
    onPlans !== undefined && reason !== 'fileSize' && reason !== 'cloudStorageLimit';
  return (
    <ConfirmDialog
      testID={testID}
      visible={visible && reason !== null}
      title={reason === 'fileSize' ? 'That file is too large' : PRODUCTS.cloud.name}
      message={reason === null ? '' : upsellMessage(reason)}
      confirmLabel={canOffer ? 'See plans' : 'OK'}
      cancelLabel="Not now"
      hideCancel={!canOffer}
      onConfirm={() => {
        onClose();
        onPlans?.();
      }}
      onCancel={onClose}
    />
  );
}
