/**
 * "I can't type while a photo is sending."
 *
 * The composer folded two different things into one `busy` flag: a text send already in flight,
 * and an attachment uploading. The first is a real double-submit guard. The second is not --
 * typing is local, and a text message is its own document under its own random id, so it cannot
 * collide with an upload. The result was a keyboard that went dead for as long as a video took to
 * go out, which on a slow connection is a minute of an app that looks broken.
 *
 * The ordering rule that flag was protecting is real but narrower than where it was applied:
 * `useOutgoingMedia` states it as two ATTACHMENTS racing -- "two photos racing to the same
 * conversation would arrive in whichever order the network settled on". So both halves are pinned
 * here on one screen with one upload held open: the composer stays alive, and the attach button
 * stays shut.
 *
 * Both assertions share a single render deliberately. They describe one state -- "an attachment is
 * in flight" -- and a second `renderWithServices` in this file renders nothing at all, so splitting
 * them buys a harness problem and no extra coverage.
 */
import React from 'react';
import { fireEvent, screen } from '@testing-library/react-native';
import * as ImagePicker from 'expo-image-picker';

import { renderWithServices } from '@/billing/screens/__tests__/harness';
import { MESSAGING_PATHS } from '@/messaging/messaging';
import { ConversationScreen } from '@/messaging/screens/ConversationScreen';
import { ALICE, BOB, MessagingWorld, flush } from '@/messaging/screens/__tests__/harness';
import type { InMemoryFileSystem } from '@/storage/inMemoryFileSystem';

jest.mock('expo-image-picker', () => ({ launchImageLibraryAsync: jest.fn() }));

const PICKED = 'file:///memory/cache/picked.jpg';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const launch = ImagePicker.launchImageLibraryAsync as unknown as jest.Mock;

function messageDocs(world: MessagingWorld, conversationId: string): readonly string[] {
  return [...world.store.documents.keys()].filter((key) =>
    key.startsWith(MESSAGING_PATHS.messages(conversationId)),
  );
}

/**
 * An upload that does not settle until the test says so, holding the tray busy.
 *
 * It RESOLVES on release rather than rejecting: `putBlob` returns `Promise<void>`, so resolving
 * just lets the send finish normally, while a rejection left a failure travelling through the
 * component after the test had ended.
 */
function heldUpload(cloud: { putBlob: unknown }): { release: () => void } {
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  jest.spyOn(cloud as never, 'putBlob').mockReturnValue(held as never);
  return { release };
}

describe('the composer while an attachment is uploading', () => {
  beforeEach(() => {
    launch.mockReset();
    launch.mockResolvedValue({ canceled: false, assets: [{ uri: PICKED, type: 'image' }] });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('stays usable for text, while still refusing a second attachment', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, 1);
    await world.join(BOB, 2);
    const conversationId = await alice.messaging.startConversation(BOB);
    await (alice.services.fs as InMemoryFileSystem).writeBytes(PICKED, JPEG);
    const upload = heldUpload(alice.cloud);

    try {
      await renderWithServices(
        alice.services,
        <ConversationScreen conversationId={conversationId} />,
      );
      await flush();

      await fireEvent.press(screen.getByTestId('conversation_attach'));
      await fireEvent.press(screen.getByTestId('attach_library'));
      await flush();

      // The upload is in flight, and visibly so.
      expect(screen.getByTestId('conversation_outgoing')).toBeTruthy();
      expect(messageDocs(world, conversationId)).toEqual([]);

      // The guard that must survive: no second attachment on top of this one.
      expect(screen.getByTestId('conversation_attach').props.accessibilityState.disabled).toBe(
        true,
      );

      // The keyboard must NOT be dead. This is the complaint.
      expect(screen.getByTestId('conversation_input').props.editable).not.toBe(false);

      fireEvent.changeText(screen.getByTestId('conversation_input'), 'are you there');
      await flush();
      expect(screen.getByTestId('conversation_send').props.accessibilityState.disabled).toBe(
        false,
      );

      await fireEvent.press(screen.getByTestId('conversation_send'));
      await flush();

      // The text went out on its own, while the attachment is still going.
      expect(messageDocs(world, conversationId)).toHaveLength(1);
      expect(screen.getByTestId('conversation_outgoing')).toBeTruthy();
    } finally {
      // Let the released send run all the way out, so nothing is still in flight at teardown.
      upload.release();
      await flush();
      await flush();
      await flush();
    }
  });
});
