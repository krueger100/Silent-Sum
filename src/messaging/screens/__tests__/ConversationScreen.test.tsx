import React from 'react';
import { fireEvent, screen } from '@testing-library/react-native';

import { renderWithServices } from '@/billing/screens/__tests__/harness';
import { MESSAGING_PATHS } from '@/messaging/messaging';
import { ConversationScreen } from '@/messaging/screens/ConversationScreen';
import {
  ALICE,
  BOB,
  MessagingWorld,
  flush,
  vaultKeysFor,
} from '@/messaging/screens/__tests__/harness';

describe('ConversationScreen', () => {
  it('sends a message and shows it, and the other account reads it back', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, 1);
    const bob = await world.join(BOB, 2);
    const conversationId = await alice.messaging.startConversation(BOB);

    const hers = await renderWithServices(
      alice.services,
      <ConversationScreen conversationId={conversationId} />,
    );
    await flush();
    expect(hers.getByTestId('conversation_empty')).toBeTruthy();

    await fireEvent.changeText(hers.getByTestId('conversation_input'), 'Hey, are you available?');
    await fireEvent.press(hers.getByTestId('conversation_send'));
    await flush();

    expect(hers.getByText('Hey, are you available?')).toBeTruthy();
    expect(hers.queryByTestId('conversation_error')).toBeNull();
    // Attribution is carried by which side the bubble leans to, so the label is where it can be
    // asserted -- and it is what a screen reader is told.
    expect(hers.getByLabelText('You: Hey, are you available?')).toBeTruthy();

    // The other side, on its own session, opens the same conversation. Each render is held by
    // its own result object: `screen` follows only the latest one.
    const his = await renderWithServices(
      bob.services,
      <ConversationScreen conversationId={conversationId} />,
    );
    await flush();
    expect(his.getByText('Hey, are you available?')).toBeTruthy();
    expect(his.getByLabelText('Them: Hey, are you available?')).toBeTruthy();
  });

  it('refuses a PIN and says why, without writing anything', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, 1);
    await world.join(BOB, 2);
    const conversationId = await alice.messaging.startConversation(BOB);

    await renderWithServices(
      alice.services,
      <ConversationScreen conversationId={conversationId} />,
    );
    await flush();
    await fireEvent.changeText(screen.getByTestId('conversation_input'), 'my pin is 4821');
    await fireEvent.press(screen.getByTestId('conversation_send'));
    await flush();

    expect(screen.getByTestId('conversation_error')).toHaveTextContent(/never send your pin/i);
    const written = [...world.store.documents.keys()].filter((key) =>
      key.startsWith(MESSAGING_PATHS.messages(conversationId)),
    );
    expect(written).toEqual([]);
  });

  it('lets a reader without Pro read but not write', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, 1);
    const bob = await world.join(BOB, 2, { pro: false });
    const conversationId = await alice.messaging.startConversation(BOB);
    await alice.messaging.send(conversationId, 'still readable');
    await flush();

    await renderWithServices(bob.services, <ConversationScreen conversationId={conversationId} />);
    await flush();
    expect(screen.getByText('still readable')).toBeTruthy();
    expect(screen.getByTestId('conversation_cannot_send')).toHaveTextContent(/part of SilentSum Pro/i);
    expect(screen.queryByTestId('conversation_input')).toBeNull();
  });

  /**
   * The composer used to blame Pro and the lock for every refusal, whatever the cause -- which
   * sent people to the plans screen over problems a purchase could not fix. These pin the reason
   * to the actual one.
   */
  it('blames the lock, not Pro, when the vault is locked', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, 1);
    await world.join(BOB, 2);
    const conversationId = await alice.messaging.startConversation(BOB);
    alice.services.session.lock();

    await renderWithServices(
      alice.services,
      <ConversationScreen conversationId={conversationId} />,
    );
    await flush();

    const card = screen.getByTestId('conversation_cannot_send');
    expect(card).toHaveTextContent(/unlock the vault to send/i);
    expect(card).not.toHaveTextContent(/Pro/);
    expect(screen.queryByTestId('conversation_cannot_send_plans')).toBeNull();
  });

  it('offers plans only when Pro is what is missing', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, 1);
    const bob = await world.join(BOB, 2, { pro: false });
    const conversationId = await alice.messaging.startConversation(BOB);
    const onPlans = jest.fn();

    await renderWithServices(
      bob.services,
      <ConversationScreen conversationId={conversationId} onPlans={onPlans} />,
    );
    await flush();

    await fireEvent.press(screen.getByTestId('conversation_cannot_send_plans'));
    expect(onPlans).toHaveBeenCalledTimes(1);
  });

  it('shows a message that cannot be opened rather than hiding it', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, 1);
    await world.join(BOB, 2);
    const conversationId = await alice.messaging.startConversation(BOB);
    await alice.messaging.send(conversationId, 'real one');
    await flush();

    // Something with the right shape that this key cannot open.
    world.store.documents.set(MESSAGING_PATHS.message(conversationId, 'm_tampered'), {
      v: 1,
      from: alice.uid,
      box: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      nonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      createdAt: world.clock.now() + 1,
    });

    await renderWithServices(
      alice.services,
      <ConversationScreen conversationId={conversationId} />,
    );
    await flush();
    expect(screen.getByTestId('conversation_sealed_m_tampered')).toBeTruthy();
    expect(screen.getByText('real one')).toBeTruthy();
  });

  it('says the vault is locked instead of showing empty bubbles', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, 1);
    await world.join(BOB, 2);
    const conversationId = await alice.messaging.startConversation(BOB);
    await alice.messaging.send(conversationId, 'written while unlocked');
    alice.services.session.lock();

    await renderWithServices(
      alice.services,
      <ConversationScreen conversationId={conversationId} />,
    );
    await flush();
    expect(screen.getByTestId('conversation_problem')).toHaveTextContent(/unlock the vault/i);
    expect(screen.queryByText('written while unlocked')).toBeNull();
  });
});

describe('attaching media', () => {
  it('offers all three sources behind the attach button', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, 1);
    await world.join(BOB, 2);
    const conversationId = await alice.messaging.startConversation(BOB);

    const view = await renderWithServices(
      alice.services,
      <ConversationScreen conversationId={conversationId} />,
    );
    await flush();

    await fireEvent.press(view.getByTestId('conversation_attach'));

    expect(view.getByTestId('attach_camera')).toBeTruthy();
    expect(view.getByTestId('attach_library')).toBeTruthy();
    expect(view.getByTestId('attach_vault')).toBeTruthy();
  });

  // The attach button lives under the same condition as the composer, so Pro gating needs no
  // separate logic -- and a reader who cannot write must not be offered a way to send.
  it('offers no attach button to a reader without Pro', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, 1);
    const bob = await world.join(BOB, 2, { pro: false });
    const conversationId = await alice.messaging.startConversation(BOB);

    const view = await renderWithServices(
      bob.services,
      <ConversationScreen conversationId={conversationId} />,
    );
    await flush();

    expect(view.queryByTestId('conversation_attach')).toBeNull();
    expect(view.getByTestId('conversation_cannot_send')).toBeTruthy();
  });

  it('closes the sheet again on cancel', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, 1);
    await world.join(BOB, 2);
    const conversationId = await alice.messaging.startConversation(BOB);

    const view = await renderWithServices(
      alice.services,
      <ConversationScreen conversationId={conversationId} />,
    );
    await flush();

    await fireEvent.press(view.getByTestId('conversation_attach'));
    await fireEvent.press(view.getByTestId('attach_cancel'));
    await flush();

    expect(view.queryByTestId('attach_camera')).toBeNull();
  });
});

describe('viewing media', () => {
  const PHOTO = new Uint8Array([0xff, 0xd8, 0xff, 4, 5, 6]);

  it('shows a photo bubble and opens it full screen when tapped', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, 1);
    const bob = await world.join(BOB, 2);
    const conversationId = await alice.messaging.startConversation(BOB);
    await alice.services.fs.writeBytes('file:///p.jpg', PHOTO);
    const sent = await alice.messaging.sendMedia(conversationId, {
      uri: 'file:///p.jpg',
      kind: 'photo',
    });
    await flush();

    const view = await renderWithServices(
      bob.services,
      <ConversationScreen conversationId={conversationId} />,
    );
    await flush();
    await flush();

    // The preview is a Storage read, so the bubble starts as a placeholder and becomes the image.
    const bubble = view.getByTestId(`conversation_media_${sent.id}`);
    await fireEvent.press(bubble);
    await flush();

    expect(view.getByTestId('media_viewer')).toBeTruthy();
    expect(view.getByTestId('media_viewer_image')).toBeTruthy();
  });

  it('closes again', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, 1);
    const bob = await world.join(BOB, 2);
    const conversationId = await alice.messaging.startConversation(BOB);
    await alice.services.fs.writeBytes('file:///p.jpg', PHOTO);
    const sent = await alice.messaging.sendMedia(conversationId, {
      uri: 'file:///p.jpg',
      kind: 'photo',
    });
    await flush();

    const view = await renderWithServices(
      bob.services,
      <ConversationScreen conversationId={conversationId} />,
    );
    await flush();
    await flush();
    await fireEvent.press(view.getByTestId(`conversation_media_${sent.id}`));
    await flush();

    await fireEvent.press(view.getByTestId('media_viewer_close'));
    await flush();

    expect(view.queryByTestId('media_viewer_image')).toBeNull();
  });

  // After 30 days the object is gone. The bubble says so, and there is nothing to open.
  it('shows an expired photo with no preview and no way in', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, 1);
    const bob = await world.join(BOB, 2);
    const conversationId = await alice.messaging.startConversation(BOB);
    await alice.services.fs.writeBytes('file:///p.jpg', PHOTO);
    const sent = await alice.messaging.sendMedia(conversationId, {
      uri: 'file:///p.jpg',
      kind: 'photo',
    });
    await flush();
    bob.cloud.expireBlobsUnder(`messages/${conversationId}/`);

    const view = await renderWithServices(
      bob.services,
      <ConversationScreen conversationId={conversationId} />,
    );
    await flush();
    await flush();

    expect(view.getByTestId(`conversation_media_expired_${sent.id}`)).toHaveTextContent(/expired/i);
    expect(view.queryByTestId(`conversation_media_${sent.id}`)).toBeNull();
  });

  it('keeps the composer above the keyboard on Android as well as iOS', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, 1);
    await world.join(BOB, 2);
    const conversationId = await alice.messaging.startConversation(BOB);

    const view = await renderWithServices(
      alice.services,
      <ConversationScreen conversationId={conversationId} />,
    );
    await flush();

    // Presence only. Which behaviour it is given cannot be read back here -- KeyboardAvoidingView
    // destructures `behavior` out before spreading the rest onto the View underneath, so it never
    // reaches the host element -- and that half is pinned by keyboardAvoidance.test.ts instead.
    // Between the two, neither deleting the wrapper nor neutering it can pass.
    expect(view.getByTestId('conversation_keyboard_avoider')).toBeTruthy();
    expect(view.getByTestId('conversation_input')).toBeTruthy();
  });
});

describe('deleting a message from the thread', () => {
  it('offers both deletions on your own message, and hides it for you', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, 1);
    await world.join(BOB, 2);
    const conversationId = await alice.messaging.startConversation(BOB);
    await alice.messaging.send(conversationId, 'mine to delete');
    await flush();

    const view = await renderWithServices(
      alice.services,
      <ConversationScreen conversationId={conversationId} />,
    );
    await flush();

    const bubble = view.getByLabelText('You: mine to delete');
    await fireEvent(bubble, 'longPress');

    expect(view.getByTestId('message_delete_for_me')).toBeTruthy();
    expect(view.getByTestId('message_delete_for_everyone')).toBeTruthy();
    expect(view.getByTestId('message_actions_cancel')).toBeTruthy();

    await fireEvent.press(view.getByTestId('message_delete_for_me'));
    await flush();

    expect(view.queryByLabelText('You: mine to delete')).toBeNull();
  });

  it('does not offer "delete for everyone" on the other person’s message', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, 1);
    const bob = await world.join(BOB, 2);
    const conversationId = await alice.messaging.startConversation(BOB);
    await bob.messaging.send(conversationId, 'his, not hers');
    await flush();

    const view = await renderWithServices(
      alice.services,
      <ConversationScreen conversationId={conversationId} />,
    );
    await flush();

    await fireEvent(view.getByLabelText('Them: his, not hers'), 'longPress');
    // Hiding it for herself is always allowed; withdrawing it for him is not offered at all,
    // which is the client half of a rule the server enforces independently.
    expect(view.getByTestId('message_delete_for_me')).toBeTruthy();
    expect(view.queryByTestId('message_delete_for_everyone')).toBeNull();
  });

  it('shows the placeholder to the other side once a message is withdrawn', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, 1);
    const bob = await world.join(BOB, 2);
    const conversationId = await alice.messaging.startConversation(BOB);
    const sent = await alice.messaging.send(conversationId, 'regretted');
    await flush();
    await alice.messaging.deleteForEveryone(conversationId, sent);
    await flush();

    const view = await renderWithServices(
      bob.services,
      <ConversationScreen conversationId={conversationId} />,
    );
    await flush();

    expect(view.getByTestId('conversation_deleted_' + sent.id)).toHaveTextContent(
      'This message was deleted',
    );
    expect(view.queryByText('regretted')).toBeNull();
  });
});

/**
 * The foreign-vault gate, as a user actually meets it.
 *
 * Everything else pinning this gate works on the service. This works on the screen, through the
 * real composition root: the same account signed in, the vault locked, and a DIFFERENT master key
 * unlocked in its place -- which is precisely what happens when somebody installs SilentSum on a
 * new phone, signs into their account, and sets up a fresh vault instead of recovering the old one.
 *
 * What they must not get is a composer that looks ready and sends something neither end can read.
 */
describe('ConversationScreen on a vault that did not set messaging up', () => {
  it('asks for recovery instead of offering a composer', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, 1);
    const bob = await world.join(BOB, 2);
    // Bob starts it, so the conversation exists on Alice's account without her vault having
    // typed anything -- the state a second device really arrives into.
    const conversationId = await bob.messaging.startConversation(ALICE);
    await flush();

    // Alice's account on another vault. Lock first: that is the real sequence, and it is what
    // disposes the old messaging identity and drops the cached conversation keys.
    alice.services.session.lock();
    alice.services.session.adopt(vaultKeysFor(7));
    await alice.services.messaging.publishKey();
    await flush();

    await renderWithServices(
      alice.services,
      <ConversationScreen conversationId={conversationId} />,
    );
    await flush();

    const banner = screen.getByTestId('conversation_cannot_send');
    expect(banner).toHaveTextContent(/not the one that set up messaging/i);
    expect(banner).toHaveTextContent(/recovery passphrase/i);
    // Not a Pro problem. Offering plans here sells a purchase that cannot fix it.
    expect(screen.queryByTestId('conversation_cannot_send_plans')).toBeNull();
    // And there is no composer at all, rather than one that looks ready.
    expect(screen.queryByTestId('conversation_input')).toBeNull();
    expect(screen.queryByTestId('conversation_send')).toBeNull();
  });

  /** The published key is the account's identity. Opening the screen must not touch it. */
  it('leaves the published key exactly where it was', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, 1);
    const bob = await world.join(BOB, 2);
    const conversationId = await bob.messaging.startConversation(ALICE);
    await flush();

    const path = MESSAGING_PATHS.publicKey(alice.uid);
    const before = JSON.stringify(world.store.documents.get(path) ?? null);

    alice.services.session.lock();
    alice.services.session.adopt(vaultKeysFor(7));
    world.clock.advance(60 * 60 * 1000); // any write at all would move `updatedAt`
    await alice.services.messaging.publishKey();
    await flush();

    await renderWithServices(
      alice.services,
      <ConversationScreen conversationId={conversationId} />,
    );
    await flush();

    expect(JSON.stringify(world.store.documents.get(path) ?? null)).toBe(before);
  });
});
