/**
 * Holding a photo has to reach the same actions sheet holding a text message does.
 *
 * The row around a media bubble has always had `onLongPress`, so this looked wired up. It was not:
 * React Native gives the gesture to the innermost pressable, and every touchable state of this
 * bubble has one of its own -- tap to open, tap to retry. Holding the picture was therefore
 * swallowed, and the only way to reach "Delete for me" on a photo was to hold the few pixels of
 * margin beside it, which nobody would find.
 *
 * None of that is reproducible through `fireEvent`, which dispatches straight at the element it is
 * handed and walks UP the tree for a handler -- so a spec driving the whole screen would have
 * passed before the fix as happily as after. These specs therefore render the bubble ALONE, with
 * no parent to fall back to, so a state that fails to forward the gesture has nowhere to hide. The
 * source invariant at the end is what stops the next state anyone adds from reintroducing it.
 */
import { fireEvent, render, screen } from '@testing-library/react-native';
import fs from 'fs';
import path from 'path';
import React from 'react';

import {
  MediaBubble,
  type MediaBubbleProps,
  type MediaBubbleState,
} from '@/messaging/screens/MediaBubble';

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'MediaBubble.tsx'), 'utf8');

async function renderBubble(
  state: MediaBubbleState,
  overrides: Partial<MediaBubbleProps> = {},
): Promise<{ onLongPress: jest.Mock }> {
  const onLongPress = jest.fn();
  await render(
    <MediaBubble
      messageId="m1"
      kind="photo"
      mine={false}
      state={state}
      preview={new Uint8Array([1, 2, 3, 4])}
      onOpen={jest.fn()}
      onRetry={jest.fn()}
      onSaveToVault={jest.fn()}
      onLongPress={onLongPress}
      {...overrides}
    />,
  );
  return { onLongPress };
}

describe('holding a chat photo', () => {
  it('reaches the actions sheet from the photo itself', async () => {
    const { onLongPress } = await renderBubble('ready');

    fireEvent(screen.getByTestId('conversation_media_m1'), 'longPress');

    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('still works on a photo that could not be loaded', async () => {
    // Otherwise an undecryptable photo is stuck in the thread with no way to remove it.
    const { onLongPress } = await renderBubble('failed');

    fireEvent(screen.getByTestId('conversation_media_failed_m1'), 'longPress');

    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('still works on a send that failed and is waiting to be retried', async () => {
    const { onLongPress } = await renderBubble('retry');

    fireEvent(screen.getByTestId('conversation_media_retry_m1'), 'longPress');

    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('works on the save link too, so no part of the bubble is a dead spot', async () => {
    const { onLongPress } = await renderBubble('ready');

    fireEvent(screen.getByTestId('media_save_to_vault_m1'), 'longPress');

    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('does not fire on an ordinary tap, which opens the photo instead', async () => {
    const onOpen = jest.fn();
    const { onLongPress } = await renderBubble('ready', { onOpen });

    fireEvent.press(screen.getByTestId('conversation_media_m1'));

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onLongPress).not.toHaveBeenCalled();
  });
});

/** The testID of one JSX opening tag, for a failure that names the state rather than dumping it. */
function testIdOf(openingTag: string): string {
  const marker = 'testID=';
  const at = openingTag.indexOf(marker);
  if (at < 0) return openingTag.trim().split('\n')[0] ?? openingTag;
  const rest = openingTag.slice(at + marker.length).trim();
  const end = rest.search(/[\s}]/);
  return end < 0 ? rest : rest.slice(0, end);
}

describe('the media bubble source', () => {
  it('gives every pressable an onLongPress, so no new state can swallow the gesture', () => {
    // A `<Pressable` with no `onLongPress` becomes the responder and the row around it never sees
    // the hold. That is the exact bug this file exists for, and it is invisible to a screen spec.
    const tags = SOURCE.split('<Pressable').slice(1);
    expect(tags.length).toBeGreaterThan(0);

    const swallowing = tags
      .map((tag) => tag.slice(0, tag.indexOf('>')))
      .filter((openingTag) => !openingTag.includes('onLongPress'))
      .map(testIdOf);

    expect(swallowing).toEqual([]);
  });
});
