/**
 * Everything the conversation screen needs to show and send media, kept out of the screen itself.
 *
 * The screen was already doing enough; folding six more pieces of state into it would have made
 * the composer and the thread hard to read at once. This owns exactly one thing: the media side
 * of a conversation.
 *
 * The preview cache is the load-bearing part. Thumbnails are Storage objects rather than Firestore
 * fields -- which is what lets one lifecycle rule expire a preview with the media it previews --
 * so each bubble costs a fetch and a decrypt. Without a cache an inverted FlatList re-fetches on
 * every pass, and a thread of twenty photos would fetch twenty previews per scroll.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { useServices } from '@/app/ServicesProvider';
import type { DecryptedMessage } from '@/messaging/messaging';
import type { MediaBubbleState } from '@/messaging/screens/MediaBubble';
import type { Bytes } from '@/utils/bytes';

export interface ChatMedia {
  /** The decrypted preview for a message, or null while loading, expired or failed. */
  previewFor: (message: DecryptedMessage) => Bytes | null;
  stateFor: (message: DecryptedMessage) => MediaBubbleState;
  retry: (message: DecryptedMessage) => void;
}

export function useChatMedia(
  conversationId: string,
  messages: readonly DecryptedMessage[],
): ChatMedia {
  const { messaging } = useServices();
  const [previews, setPreviews] = useState<ReadonlyMap<string, Bytes>>(new Map());
  const [states, setStates] = useState<ReadonlyMap<string, MediaBubbleState>>(new Map());
  /** Requests already made this session, so a re-render never re-fetches. */
  const requested = useRef(new Set<string>());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // No reset when the conversation changes, deliberately: the cache is keyed by object path,
  // and a path contains its own conversation id (`messages/{cid}/thumb/{id}`), so entries from
  // one thread can never be read by another. What is left behind is a few 20 KB previews for
  // threads visited this session, which the next lock clears with everything else.
  useEffect(() => {
    for (const message of messages) {
      const key = message.thumbObject;
      if (key === null || message.kind === null || message.kind === 'unknown') continue;
      if (requested.current.has(key)) continue;
      requested.current.add(key);
      void (async () => {
        try {
          const bytes = await messaging.fetchThumb(conversationId, message);
          if (!mounted.current) return;
          if (typeof bytes === 'string') {
            // `expired` is gone, which after 30 days is exactly what it should be. `sealed` is
            // present but unopenable here. Neither is a failure and no retry changes either, but
            // they are not the same sentence, and this used to tell both of them the first one.
            setStates((prev) => new Map(prev).set(key, bytes));
            return;
          }
          setPreviews((prev) => new Map(prev).set(key, bytes));
          setStates((prev) => new Map(prev).set(key, 'ready'));
        } catch {
          // The network failed, which a retry may fix. Deliberately distinct from expiry: telling
          // someone on a bad connection that their photo was destroyed would be a lie.
          if (mounted.current) setStates((prev) => new Map(prev).set(key, 'failed'));
        }
      })();
    }
  }, [conversationId, messages, messaging]);

  const previewFor = useCallback(
    (message: DecryptedMessage): Bytes | null =>
      message.thumbObject === null ? null : (previews.get(message.thumbObject) ?? null),
    [previews],
  );

  const stateFor = useCallback(
    (message: DecryptedMessage): MediaBubbleState => {
      // A message with no thumbnail at all -- a video whose poster could not be made -- is not
      // loading forever; it simply has no preview to show.
      if (message.thumbObject === null) return 'ready';
      return states.get(message.thumbObject) ?? 'loading';
    },
    [states],
  );

  const retry = useCallback((message: DecryptedMessage): void => {
    const key = message.thumbObject;
    if (key === null) return;
    requested.current.delete(key);
    setStates((prev) => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }, []);

  return { previewFor, stateFor, retry };
}
