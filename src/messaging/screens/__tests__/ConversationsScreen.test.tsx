import React from 'react';
import { fireEvent, screen } from '@testing-library/react-native';

import { buildOfflineHarness, renderWithServices } from '@/billing/screens/__tests__/harness';
import { ConversationsScreen } from '@/messaging/screens/ConversationsScreen';
import { ALICE, BOB, MessagingWorld, flush } from '@/messaging/screens/__tests__/harness';

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
});
