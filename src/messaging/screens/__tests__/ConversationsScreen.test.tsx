import React from 'react';
import { fireEvent, screen } from '@testing-library/react-native';

import { buildOfflineHarness, renderWithServices } from '@/billing/screens/__tests__/harness';
import { ConversationsScreen } from '@/messaging/screens/ConversationsScreen';
import {
  ALICE,
  BOB,
  MessagingWorld,
  flush,
  vaultKeysFor,
} from '@/messaging/screens/__tests__/harness';

describe('ConversationsScreen', () => {
  it('says so in a build with no cloud backend', async () => {
    const { services } = buildOfflineHarness();
    await renderWithServices(services, <ConversationsScreen />);
    expect(screen.getByTestId('messages_unavailable')).toBeTruthy();
  });

  it('starts a conversation from an address and opens it', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, 1);
    await world.join(BOB, 2);
    const onOpen = jest.fn();

    await renderWithServices(alice.services, <ConversationsScreen onOpen={onOpen} />);
    expect(screen.getByTestId('messages_empty')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('messages_new'));
    await fireEvent.changeText(screen.getByTestId('messages_email'), BOB);
    await fireEvent.press(screen.getByTestId('messages_start'));
    await flush();

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('messages_error')).toBeNull();
  });

  it('lists a conversation with its unread count and the address it was started from', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, 1);
    const bob = await world.join(BOB, 2);
    const conversationId = await alice.messaging.startConversation(BOB);
    await bob.messaging.send(conversationId, 'are you there?');
    await flush();

    await renderWithServices(alice.services, <ConversationsScreen />);
    await flush();

    expect(screen.getByTestId('messages_row_' + conversationId)).toBeTruthy();
    expect(screen.getByTestId('messages_unread_' + conversationId)).toHaveTextContent('1');
    expect(screen.getByText(BOB)).toBeTruthy();
  });

  it('offers plans instead of a composer without Pro', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, 1, { pro: false });
    const onPlans = jest.fn();

    await renderWithServices(alice.services, <ConversationsScreen onPlans={onPlans} />);
    expect(screen.getByTestId('messages_pro_required')).toBeTruthy();
    expect(screen.queryByTestId('messages_email')).toBeNull();
    await fireEvent.press(screen.getByTestId('messages_plans'));
    expect(onPlans).toHaveBeenCalledTimes(1);
  });

  it('says the vault is locked, and still lists what is there', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, 1);
    await world.join(BOB, 2);
    await alice.messaging.startConversation(BOB);
    alice.services.session.lock();

    await renderWithServices(alice.services, <ConversationsScreen />);
    await flush();
    expect(screen.getByTestId('messages_locked')).toBeTruthy();
    expect(screen.getByTestId('messages_list')).toBeTruthy();
  });

  it('reports an address nobody uses', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, 1);

    await renderWithServices(alice.services, <ConversationsScreen />);
    await fireEvent.press(screen.getByTestId('messages_new'));
    await fireEvent.changeText(screen.getByTestId('messages_email'), 'ghost@example.test');
    await fireEvent.press(screen.getByTestId('messages_start'));
    await flush();

    expect(screen.getByTestId('messages_error')).toHaveTextContent(/nobody here uses/i);
  });

  it('lifts the new-conversation sheet above the keyboard', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, 1);

    await renderWithServices(alice.services, <ConversationsScreen />);
    await fireEvent.press(screen.getByTestId('messages_new'));

    // The sheet is docked to the bottom and its only field autoFocuses, so the keyboard opens
    // directly over the thing being typed into unless the sheet is lifted out of the way.
    // Presence only; which behaviour the wrapper gets is pinned by keyboardAvoidance.test.ts.
    expect(screen.getByTestId('messages_sheet_keyboard_avoider')).toBeTruthy();
    expect(screen.getByTestId('messages_email')).toBeTruthy();
  });
});

/**
 * The way back in, offered where the user arrives rather than where they eventually notice.
 *
 * The messaging identity belongs to the ACCOUNT, so one passphrase unlocks every conversation on
 * it. Showing that only inside an opened thread -- underneath the messages it had just failed to
 * read -- meant somebody signing into their other account met a list that looked perfectly
 * healthy and had to go hunting.
 */
describe('an account whose messaging belongs to another vault', () => {
  async function strandedAlice() {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, 1);
    await world.join(BOB, 2);
    await alice.messaging.startConversation(BOB);
    await flush();

    // The same account, now open on a vault that did not set its messaging up.
    alice.services.session.lock();
    alice.services.session.adopt(vaultKeysFor(7));
    await alice.messaging.publishKey();
    await flush();
    return alice;
  }

  it('offers the recovery on the list itself', async () => {
    const alice = await strandedAlice();

    await renderWithServices(alice.services, <ConversationsScreen />);
    await flush();

    expect(screen.getByTestId('messages_foreign_vault')).toBeTruthy();
    expect(screen.getByTestId('messages_foreign_vault')).toHaveTextContent(
      /unlocks all of them at once/i,
    );
    // The action, not merely an explanation of the problem.
    expect(screen.getByTestId('conversation_recover_messaging')).toBeTruthy();
  });

  /** The ordinary account must not be offered a remedy for a problem it does not have. */
  it('offers nothing on the vault that set the account up', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, 1);
    await world.join(BOB, 2);
    await alice.messaging.startConversation(BOB);

    await renderWithServices(alice.services, <ConversationsScreen />);
    await flush();

    expect(screen.queryByTestId('messages_foreign_vault')).toBeNull();
    expect(screen.queryByTestId('conversation_recover_messaging')).toBeNull();
  });
});

describe('deleting a conversation', () => {
  it('asks before deleting, and removes the row once confirmed', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, 1);
    const bob = await world.join(BOB, 2);
    const conversationId = await alice.messaging.startConversation(BOB);
    await bob.messaging.send(conversationId, 'hello');
    await flush();

    await renderWithServices(alice.services, <ConversationsScreen />);
    await flush();
    expect(screen.getByTestId('messages_row_' + conversationId)).toBeTruthy();

    // A long press must not delete anything on its own.
    await fireEvent(screen.getByTestId('messages_row_' + conversationId), 'longPress');
    expect(screen.getByTestId('messages_delete_confirm')).toBeTruthy();
    expect(screen.getByTestId('messages_row_' + conversationId)).toBeTruthy();

    await fireEvent.press(screen.getByText('Delete for both'));
    await flush();
    await flush();

    expect(screen.queryByTestId('messages_row_' + conversationId)).toBeNull();
  });

  it('leaves the conversation alone when the confirmation is declined', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, 1);
    await world.join(BOB, 2);
    const conversationId = await alice.messaging.startConversation(BOB);
    await flush();

    await renderWithServices(alice.services, <ConversationsScreen />);
    await flush();

    await fireEvent(screen.getByTestId('messages_row_' + conversationId), 'longPress');
    await fireEvent.press(screen.getByText('Cancel'));
    await flush();

    expect(screen.getByTestId('messages_row_' + conversationId)).toBeTruthy();
  });
});

/**
 * The other door into the gate.
 *
 * A vault that arrives on an account with no conversations sees nothing wrong on the list itself
 * -- there is no banner there, only an empty screen that looks like a fresh start. The gate has to
 * hold at the moment it tries to begin one, because a conversation started from the wrong vault is
 * one neither side could ever read, and the other person would be invited into it regardless.
 */
describe('ConversationsScreen on a vault that did not set messaging up', () => {
  it('refuses to start a conversation, and says recovery is the way out', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, 1);
    await world.join(BOB, 2);

    // Same account, a different vault: lock, then unlock another master key in its place.
    alice.services.session.lock();
    alice.services.session.adopt(vaultKeysFor(7));
    await alice.services.messaging.publishKey();
    await flush();

    await renderWithServices(alice.services, <ConversationsScreen />);
    await flush();
    await fireEvent.press(screen.getByTestId('messages_new'));
    await fireEvent.changeText(screen.getByTestId('messages_email'), BOB);
    await fireEvent.press(screen.getByTestId('messages_start'));
    await flush();

    const error = screen.getByTestId('messages_error');
    expect(error).toHaveTextContent(/not the one that set up messaging/i);
    expect(error).toHaveTextContent(/recovery passphrase/i);
    // And nothing was written: no half-made conversation for the other side to be invited into.
    const made = [...world.store.documents.keys()].filter((key) =>
      key.startsWith('conversations/'),
    );
    expect(made).toEqual([]);
  });
});
