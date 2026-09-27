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
 *
 * `disguised` swaps the vocabulary and nothing else. Super secure hides the calculator menu item
 * that normally opens this, so the only way here is the About page, and a dialog that says
 * "vault" or asks the user to type DELETE MY VAULT would undo the disguise at the worst possible
 * moment. The disguised wording still has to do the whole job -- say what is destroyed, say it
 * cannot be undone, and say whether anything survives elsewhere -- so it trades precision of
 * NOUN for nothing else. The stages, the typed gate and the wipe underneath are identical.
 */
import React, { useCallback, useState } from 'react';

import { useServices, useSettings } from '@/app/ServicesProvider';
import { wipeLocalVault, type LocalWipeResult } from '@/auth/vaultWipe';
import { ConfirmDialog, TypedConfirmDialog } from '@/components/Dialog';

/** Typed exactly, in full, before anything is deleted. */
export const ERASE_PHRASE = 'DELETE MY VAULT';
/** The same gate, in words that do not name the app. See the note about `disguised` above. */
export const ERASE_PHRASE_DISGUISED = 'ERASE EVERYTHING';

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
  /** Say all of this without naming the app. Changes the words, never the behaviour. */
  disguised?: boolean;
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
  disguised = false,
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

  const copy = (disguised ? disguisedCopy : plainCopy)(settings.backupEnabled);

  return (
    <>
      <ConfirmDialog
        testID="erase_explain_dialog"
        visible={visible && stage === 'explain'}
        title={copy.explainTitle}
        message={copy.explainMessage}
        confirmLabel={copy.eraseLabel}
        cancelLabel="Keep trying"
        destructive
        onCancel={close}
        onConfirm={() => {
          setStage('confirm');
        }}
      />
      <TypedConfirmDialog
        testID="erase_confirm_dialog"
        visible={visible && stage === 'confirm'}
        title={copy.confirmTitle}
        message={copy.confirmMessage}
        confirmLabel={copy.eraseLabel}
        cancelLabel="Cancel"
        destructive
        busy={busy}
        phrase={copy.phrase}
        onCancel={close}
        onConfirm={() => {
          void erase();
        }}
      />
      <ConfirmDialog
        testID="erase_outcome_dialog"
        visible={visible && stage === 'outcome'}
        title={copy.outcomeTitle(outcome?.credentialsErased !== false)}
        message={outcome === null ? '' : copy.outcome(outcome, canRestore)}
        confirmLabel={canRestore ? copy.restoreLabel : 'OK'}
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

/** Every user-visible string in this flow, in one of two vocabularies. */
interface EraseCopy {
  readonly phrase: string;
  readonly eraseLabel: string;
  readonly explainTitle: string;
  readonly explainMessage: string;
  readonly confirmTitle: string;
  readonly confirmMessage: string;
  readonly restoreLabel: string;
  readonly outcomeTitle: (fully: boolean) => string;
  readonly outcome: (result: LocalWipeResult, canRestore: boolean) => string;
}

/** The honest wording, for every door except the disguised About page. */
function plainCopy(backupEnabled: boolean): EraseCopy {
  const cloudNote = backupEnabled
    ? '\n\nYour cloud backup is separate and is NOT deleted. Erasing this device leaves the ' +
      'encrypted copy and your account exactly as they are, and afterwards you can sign in and ' +
      'restore it - but only with your recovery passphrase, which is the only thing that can ' +
      'unwrap it.'
    : '\n\nThere is no cloud backup of this vault, so erasing it is final.';

  return {
    phrase: ERASE_PHRASE,
    eraseLabel: 'Erase vault',
    explainTitle: 'Forgot your PIN?',
    explainMessage:
      'The vault is encrypted with a key that only your PIN unwraps. It is not stored anywhere, ' +
      'so nobody can recover it or reset it for you - not the developers, not support, not with ' +
      'a device unlock. There is no backdoor.' +
      cloudNote +
      '\n\nIf the PIN is truly gone, the only option is to erase the vault and start over.',
    confirmTitle: 'Erase the vault?',
    confirmMessage:
      `${GONE} This cannot be undone.\n\n` +
      (backupEnabled
        ? 'Your encrypted cloud backup and your account are left alone; you will simply be ' +
          'signed out on this device.'
        : 'There is no backup anywhere, so nothing can bring these photos and videos back.'),
    restoreLabel: 'Restore from cloud backup',
    outcomeTitle: (fully) => (fully ? 'Vault erased' : 'Not fully erased'),
    outcome: describeOutcome,
  };
}

/**
 * The same three warnings with every noun that names the app taken out.
 *
 * "Vault" becomes what is saved on this device, the PIN becomes the number you set, the cloud
 * backup becomes the copy in your online account, and the recovery passphrase becomes the
 * recovery phrase you chose. Nothing is softened: it still says everything here is gone, still
 * says it cannot be undone, and still says plainly when there is nothing anywhere to bring back.
 */
function disguisedCopy(backupEnabled: boolean): EraseCopy {
  const cloudNote = backupEnabled
    ? '\n\nThe copy kept in your online account is separate and is NOT removed. Afterwards you ' +
      'can sign in again and bring it back - but only with the recovery phrase you chose, which ' +
      'is the only thing that can open it.'
    : '\n\nThere is no copy anywhere else, so clearing this device is final.';

  return {
    phrase: ERASE_PHRASE_DISGUISED,
    eraseLabel: 'Clear this device',
    explainTitle: 'Reset this device',
    explainMessage:
      'Everything this app has saved on this device is locked to a number only you know. That ' +
      'number is not kept anywhere, so nobody can look it up or reset it for you - not support, ' +
      'not the people who made this app.' +
      cloudNote +
      '\n\nIf it is genuinely gone, the only way forward is to clear this device and start again.',
    confirmTitle: 'Clear this device?',
    confirmMessage:
      `${GONE_DISGUISED} This cannot be undone.\n\n` +
      (backupEnabled
        ? 'Your online copy and your account are left alone; you will simply be signed out on ' +
          'this device.'
        : 'There is nothing kept anywhere else, so nothing can bring these files back.'),
    restoreLabel: 'Bring back the online copy',
    outcomeTitle: (fully) => (fully ? 'Device cleared' : 'Not fully cleared'),
    outcome: describeOutcomeDisguised,
  };
}

/** What {@link GONE} says, without naming what was in it. */
const GONE_DISGUISED =
  'Everything saved here is gone: the files, the previews, the number you set and every ' +
  'temporary copy.';

/** {@link describeOutcome}, in the disguised vocabulary. */
function describeOutcomeDisguised(result: LocalWipeResult, canRestore: boolean): string {
  if (!result.credentialsErased) {
    return (
      'The files were removed, but the record of the number you set could not be deleted from ' +
      'this device. Restart the app and clear it again before setting anything up.'
    );
  }

  const signedOut = result.signedOut
    ? ' You have been signed out of your online account; the account itself is untouched.'
    : '';

  if (canRestore) {
    return (
      `${GONE_DISGUISED}${signedOut}\n\nYour online copy was not touched. Sign in again and ` +
      'enter the recovery phrase you chose to bring it back, then pick a new number for this ' +
      'device.'
    );
  }

  if (result.hadCloudBackup) {
    return (
      `${GONE_DISGUISED}${signedOut}\n\nYour online copy was not touched either, but this ` +
      'build cannot reach it.'
    );
  }

  return (
    `${GONE_DISGUISED}${signedOut}\n\nThere was no copy anywhere else, so there is nothing to ` +
    'bring back. What was here cannot be recovered - not by you, not by support, not by anyone.'
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
