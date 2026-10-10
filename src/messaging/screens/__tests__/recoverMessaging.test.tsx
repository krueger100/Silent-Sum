/**
 * The way out of a foreign vault, as a user meets it.
 *
 * A second account opened on a vault that did not set its messaging up can see its conversations
 * but open none of them, and the composer is blocked. The remedy is NOT to republish this
 * device's key over the account's -- that is what stranded ten production accounts -- but to give
 * this device the account's own key, recovered from the backup passphrase it already has.
 *
 * These drive the whole path through the real composition root: a real BackupService writing a
 * real envelope, a real messaging identity derived from a real master key.
 */
import { fireEvent, waitFor } from '@testing-library/react-native';
import React from 'react';

import { renderWithServices } from '@/billing/screens/__tests__/harness';
import { ConversationScreen } from '@/messaging/screens/ConversationScreen';
import {
  ALICE,
  BOB,
  MessagingWorld,
  flush,
  vaultKeysFor,
  type Account,
} from '@/messaging/screens/__tests__/harness';

const PASSPHRASE = 'correct horse battery staple';
const ORIGINAL_SEED = 1;
const OTHER_SEED = 7;

/**
 * Alice's account, backed up under `PASSPHRASE`, holding one message, then opened on a vault
 * that never set its messaging up.
 */
async function stranded(): Promise<{ alice: Account; conversationId: string }> {
  const world = new MessagingWorld();
  const alice = await world.join(ALICE, ORIGINAL_SEED);
  await world.join(BOB, 2);

  const backup = alice.services.backup;
  if (backup === null) throw new Error('expected a backup service');
  await backup.enable(alice.services.session.requireKeys(), PASSPHRASE);

  const conversationId = await alice.messaging.startConversation(BOB);
  await alice.messaging.send(conversationId, 'written under the original vault');
  await flush();

  // A different vault on the same account: the key it derives is not the published one.
  alice.services.session.lock();
  alice.services.session.adopt(vaultKeysFor(OTHER_SEED));
  await alice.messaging.publishKey();
  await flush();

  return { alice, conversationId };
}

describe('recovering messaging on a second account', () => {
  it('offers the way out where the problem is shown', async () => {
    const { alice, conversationId } = await stranded();

    const view = await renderWithServices(
      alice.services,
      <ConversationScreen conversationId={conversationId} />,
    );
    await flush();

    expect(view.getByTestId('conversation_cannot_send')).toBeTruthy();
    expect(view.getByTestId('conversation_recover_messaging')).toBeTruthy();
  });

  it('reads the thread and unblocks the composer once the passphrase is given', async () => {
    const { alice, conversationId } = await stranded();

    const view = await renderWithServices(
      alice.services,
      <ConversationScreen conversationId={conversationId} />,
    );
    await flush();
    // Nothing opens under the wrong vault's key.
    expect(view.queryByText('written under the original vault')).toBeNull();

    await fireEvent.press(view.getByTestId('conversation_recover_messaging'));
    await fireEvent.changeText(view.getByTestId('conversation_recover_passphrase'), PASSPHRASE);
    await fireEvent.press(view.getByTestId('conversation_recover_submit'));

    await waitFor(() => {
      expect(view.queryByTestId('conversation_cannot_send')).toBeNull();
    });
    await flush();
    expect(view.getByText('written under the original vault')).toBeTruthy();
  });

  /** A typo costs one Argon2id and touches nothing. */
  it('says the passphrase was wrong and leaves everything blocked', async () => {
    const { alice, conversationId } = await stranded();

    const view = await renderWithServices(
      alice.services,
      <ConversationScreen conversationId={conversationId} />,
    );
    await flush();

    await fireEvent.press(view.getByTestId('conversation_recover_messaging'));
    await fireEvent.changeText(
      view.getByTestId('conversation_recover_passphrase'),
      'not the passphrase at all',
    );
    await fireEvent.press(view.getByTestId('conversation_recover_submit'));

    await waitFor(() => {
      expect(view.getByTestId('conversation_recover_error')).toHaveTextContent(
        /Wrong recovery passphrase/i,
      );
    });
    expect(view.getByTestId('conversation_cannot_send')).toBeTruthy();
    expect(view.queryByText('written under the original vault')).toBeNull();
  });

  it('refuses an empty passphrase without asking the server anything', async () => {
    const { alice, conversationId } = await stranded();
    const getDocument = jest.spyOn(alice.cloud, 'getDocument');

    const view = await renderWithServices(
      alice.services,
      <ConversationScreen conversationId={conversationId} />,
    );
    await flush();
    getDocument.mockClear();

    await fireEvent.press(view.getByTestId('conversation_recover_messaging'));
    await fireEvent.press(view.getByTestId('conversation_recover_submit'));

    expect(view.getByTestId('conversation_recover_error')).toHaveTextContent(
      /Enter the recovery passphrase/i,
    );
    expect(getDocument).not.toHaveBeenCalled();
    getDocument.mockRestore();
  });

  /** The ordinary case must not be offered a remedy for a problem it does not have. */
  it('offers nothing when the vault is the one that set messaging up', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, ORIGINAL_SEED);
    await world.join(BOB, 2);
    const conversationId = await alice.messaging.startConversation(BOB);

    const view = await renderWithServices(
      alice.services,
      <ConversationScreen conversationId={conversationId} />,
    );
    await flush();

    expect(view.queryByTestId('conversation_recover_messaging')).toBeNull();
  });
});
