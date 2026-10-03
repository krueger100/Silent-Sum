/**
 * "It says tap to retry but it doesn't work."
 *
 * The bubble a failed photo leaves behind re-runs the send from the source the tray kept, which is
 * right. What was wrong is everything around it: the error was discarded, so the bubble offered
 * "Tap to retry" for failures no retry can fix, and tapping re-ran the identical operation. That
 * second attempt failed in the same tick, before any network, so React folded the two state
 * changes into one render and nothing on screen moved. A working button, indistinguishable from
 * a dead one.
 *
 * Both halves are pinned here, because fixing one without the other leaves the complaint standing:
 * a retry that can work does work, and a failure that cannot be retried says so instead.
 */
import React from 'react';
import { fireEvent, screen } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';

import { CloudError } from '@/firebase/types';
import { renderWithServices } from '@/billing/screens/__tests__/harness';
import { MESSAGING_PATHS } from '@/messaging/messaging';
import { ConversationScreen } from '@/messaging/screens/ConversationScreen';
import { ALICE, BOB, MessagingWorld, flush } from '@/messaging/screens/__tests__/harness';
import type { InMemoryFileSystem } from '@/storage/inMemoryFileSystem';
import type { FakeThumbnailGenerator } from '@/vault/thumbnailGenerator';

jest.mock('expo-image-picker', () => ({ launchImageLibraryAsync: jest.fn() }));

/** Where the picker says the photo is. Whether it is really there is the second experiment. */
const PICKED = 'file:///memory/cache/picked.jpg';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

const launch = ImagePicker.launchImageLibraryAsync as unknown as jest.Mock;

async function attachFromLibrary(): Promise<void> {
  await fireEvent.press(screen.getByTestId('conversation_attach'));
  await fireEvent.press(screen.getByTestId('attach_library'));
  await flush();
}

function sentMessages(world: MessagingWorld, conversationId: string): readonly string[] {
  return [...world.store.documents.keys()].filter((key) =>
    key.startsWith(MESSAGING_PATHS.messages(conversationId)),
  );
}

describe('a photo send that failed', () => {
  beforeEach(() => {
    launch.mockReset();
    launch.mockResolvedValue({ canceled: false, assets: [{ uri: PICKED, type: 'image' }] });
  });

  it('re-sends the source it kept when a retryable failure is tapped', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, 1);
    await world.join(BOB, 2);
    const conversationId = await alice.messaging.startConversation(BOB);
    await (alice.services.fs as InMemoryFileSystem).writeBytes(PICKED, JPEG);

    // One dropped upload: the kind of failure a second attempt really can get past.
    const upload = jest.spyOn(alice.cloud, 'putBlob');
    upload.mockRejectedValueOnce(new CloudError('unknown'));

    await renderWithServices(
      alice.services,
      <ConversationScreen conversationId={conversationId} />,
    );
    await flush();
    await attachFromLibrary();

    expect(screen.getByLabelText('Retry sending photo')).toBeTruthy();
    expect(sentMessages(world, conversationId)).toEqual([]);

    await fireEvent.press(screen.getByLabelText('Retry sending photo'));
    await flush();

    expect(screen.queryByTestId('conversation_outgoing')).toBeNull();
    expect(sentMessages(world, conversationId)).toHaveLength(1);
  });

  it('says a photo is too large, once it has tried making it smaller', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, 1);
    await world.join(BOB, 2);
    const conversationId = await alice.messaging.startConversation(BOB);

    // Over the 8 MB ceiling, and incompressible at every rung of the ladder.
    await (alice.services.fs as InMemoryFileSystem).writeBytes(PICKED, new Uint8Array(9 * 1024 * 1024));
    (alice.services.thumbnails as FakeThumbnailGenerator).sizeForEdge = () => 9 * 1024 * 1024;

    await renderWithServices(
      alice.services,
      <ConversationScreen conversationId={conversationId} />,
    );
    await flush();
    await attachFromLibrary();

    expect(screen.getByText('This photo is too large to send. Please choose a smaller photo.')).toBeTruthy();
    // No retry: re-running the identical re-encode would reach the identical answer.
    expect(screen.queryByLabelText('Retry sending photo')).toBeNull();
    expect(screen.getByText(/not sent/i)).toBeTruthy();
    expect(sentMessages(world, conversationId)).toEqual([]);
  });

  it('says why, and offers no retry, when tapping again cannot help', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, 1);
    await world.join(BOB, 2);
    const conversationId = await alice.messaging.startConversation(BOB);
    // The file the picker named is not there -- the state a released vault scratch file leaves
    // behind, and the state a cleared cache leaves behind. No retry can conjure it back.

    await renderWithServices(
      alice.services,
      <ConversationScreen conversationId={conversationId} />,
    );
    await flush();
    await attachFromLibrary();

    expect(screen.getByTestId('conversation_outgoing')).toBeTruthy();
    expect(screen.getByText(/no longer on this device/i)).toBeTruthy();
    // The retry affordance is withdrawn rather than left there to be tapped forever.
    expect(screen.queryByLabelText('Retry sending photo')).toBeNull();
    expect(screen.getByText(/not sent/i)).toBeTruthy();
    // Still dismissable, so the tray does not become permanent furniture.
    expect(screen.getByLabelText('Discard')).toBeTruthy();
    expect(sentMessages(world, conversationId)).toEqual([]);
  });
});
