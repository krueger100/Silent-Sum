/**
 * "I forgot my PIN".
 *
 * There is no recovery path and no backdoor, and this dialog says so rather than implying a
 * support channel that does not exist. The only thing on offer is destruction: erase the vault and
 * start over. That is gated behind a typed phrase, because a mis-tap must never be able to destroy
 * a vault.
 *
 * What makes it survivable is what erasing does NOT destroy. The wipe stops at the device
 * boundary: the cloud account is signed out but never deleted, and the encrypted blobs and the
 * backup envelope in the cloud are not touched at all. So the dialog has three stages rather than
 * two, and the third is the one that matters most -- once the vault is gone it tells the user
 * which of the two situations they are actually in. With a backup, the next step is the restore
 * flow and their recovery passphrase. Without one, it says plainly that those photos are gone, at
 * the one moment the user is still paying attention.
 */
import React, { useCallback, useState } from 'react';

import { useServices, useSettings } from '@/app/ServicesProvider';
import { wipeLocalVault, type LocalWipeResult } from '@/auth/vaultWipe';
import { ConfirmDialog, TypedConfirmDialog } from '@/components/Dialog';

/** Typed exactly, in full, before anything is deleted. */
export const ERASE_PHRASE = 'DELETE MY VAULT';

export interface ForgotPinDialogProps {
  visible: boolean;
  /** Closes the dialog without touching anything. */
  onDismiss: () => void;
  /** Called after the vault, the credentials and the settings are gone. */
  onErased?: () => void;
  /**
   * Opens the restore flow. Offered only when this device recorded a cloud backup, and only after
   * the wipe: restoring into a vault that still exists is refused by `adoptMasterKey` anyway.
   */
  onRestore?: () => void;
}

type Stage = 'explain' | 'confirm' | 'outcome';

const GONE =
  'Everything the vault kept on this device is gone: the photos, the videos, the thumbnails, the ' +
  'PIN and every decrypted temporary file.';

export function ForgotPinDialog({
  visible,
  onDismiss,
  onErased,
  onRestore,
}: ForgotPinDialogProps): React.JSX.Element {
  const services = useServices();
  const settings = useSettings();
  const [stage, setStage] = useState<Stage>('explain');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<LocalWipeResult | null>(null);

  const close = useCallback(() => {
    setStage('explain');
    setOutcome(null);
    onDismiss();
  }, [onDismiss]);

  const erase = useCallback(async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      setOutcome(await wipeLocalVault(services));
    } finally {
      setBusy(false);
    }
    setStage('outcome');
  }, [busy, services]);

  /** Leaves the outcome dialog. The caller refreshes the calculator; the vault is already gone. */
  const finish = useCallback(() => {
    setStage('explain');
    setOutcome(null);
    onErased?.();
  }, [onErased]);

  // A restore needs somewhere to restore from: a backup this device knew about, a build that has
  // a cloud backend at all, and a navigator willing to show the flow.
  const canRestore =
    outcome !== null &&
    outcome.hadCloudBackup &&
    services.backup !== null &&
    onRestore !== undefined;

  const cloudNote = settings.backupEnabled
    ? '\n\nYour cloud backup is separate and is NOT deleted. Erasing this device leaves the ' +
      'encrypted copy and your account exactly as they are, and afterwards you can sign in and ' +
      'restore it - but only with your recovery passphrase, which is the only thing that can ' +
      'unwrap it.'
    : '\n\nThere is no cloud backup of this vault, so erasing it is final.';

  return (
    <>
      <ConfirmDialog
        testID="forgot_pin_dialog"
        visible={visible && stage === 'explain'}
        title="Forgot your PIN?"
        message={
          'The vault is encrypted with a key that only your PIN unwraps. It is not stored anywhere, ' +
          'so nobody can recover it or reset it for you - not the developers, not support, not with ' +
          'a device unlock. There is no backdoor.' +
          cloudNote +
          '\n\nIf the PIN is truly gone, the only option is to erase the vault and start over.'
        }
        confirmLabel="Erase vault"
        cancelLabel="Keep trying"
        destructive
        onCancel={close}
        onConfirm={() => {
          setStage('confirm');
        }}
      />
      <TypedConfirmDialog
        testID="erase_vault_dialog"
        visible={visible && stage === 'confirm'}
        title="Erase the vault?"
        message={
          `${GONE} This cannot be undone.\n\n` +
          (settings.backupEnabled
            ? 'Your encrypted cloud backup and your account are left alone; you will simply be ' +
              'signed out on this device.'
            : 'There is no backup anywhere, so nothing can bring these photos and videos back.')
        }
        confirmLabel="Erase vault"
        cancelLabel="Cancel"
        destructive
        busy={busy}
        phrase={ERASE_PHRASE}
        onCancel={close}
        onConfirm={() => {
          void erase();
        }}
      />
      <ConfirmDialog
        testID="erase_outcome_dialog"
        visible={visible && stage === 'outcome'}
        title={outcome?.credentialsErased === false ? 'Not fully erased' : 'Vault erased'}
        message={outcome === null ? '' : describeOutcome(outcome, canRestore)}
        confirmLabel={canRestore ? 'Restore from cloud backup' : 'OK'}
        cancelLabel="Not now"
        hideCancel={!canRestore}
        onCancel={finish}
        onConfirm={() => {
          finish();
          if (canRestore) onRestore?.();
        }}
      />
    </>
  );
}

/**
 * What actually happened, in the user's terms.
 *
 * The no-backup sentence is the important one. It is the last moment at which the user can be told
 * the truth while it still means something, and the worst failure mode this flow has is a user who
 * walks away from it believing support can get their photos back.
 */
function describeOutcome(result: LocalWipeResult, canRestore: boolean): string {
  if (!result.credentialsErased) {
    return (
      'The vault files were erased, but the PIN record on this device could not be removed. ' +
      'Restart the app and erase again before setting up a new vault.'
    );
  }

  const signedOut = result.signedOut
    ? ' You have been signed out of your backup account; the account itself is untouched.'
    : '';

  if (canRestore) {
    return (
      `${GONE}${signedOut}\n\nYour encrypted cloud backup was not touched. Sign in again and ` +
      'enter your recovery passphrase to bring it back, then choose a new PIN for this device.'
    );
  }

  if (result.hadCloudBackup) {
    return (
      `${GONE}${signedOut}\n\nYour cloud backup was not touched either, but this copy of the app ` +
      'cannot reach it. Restore it from a build with cloud backup configured, using your recovery ' +
      'passphrase.'
    );
  }

  return (
    `${GONE}${signedOut}\n\nThere was no cloud backup of this vault, so there is nothing to ` +
    'restore from. Those photos and videos cannot be recovered - not by you, not by support, not ' +
    'by anyone.'
  );
}
