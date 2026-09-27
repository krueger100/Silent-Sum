/**
 * What a thread is made of, once it is laid out rather than merely listed.
 *
 * Two things turn a list of messages into something readable. A day separator, so a long thread
 * has landmarks instead of an undifferentiated column of times. And grouping: consecutive
 * messages from one person within a few minutes are one utterance typed in pieces, so only the
 * last of them gets the tail and the spacing between them closes up.
 *
 * Pure, and separate from the screen, because this is the part with the off-by-one risks.
 */
import type { DecryptedMessage } from '@/messaging/messaging';
import { sameDay } from '@/messaging/screens/chatTime';

/** Long enough that a burst of typing stays one group, short enough that a reply starts a new one. */
export const GROUP_GAP_MS = 5 * 60_000;

export interface DaySeparatorItem {
  readonly kind: 'day';
  readonly key: string;
  readonly at: number;
}

export interface MessageItem {
  readonly kind: 'message';
  readonly key: string;
  readonly message: DecryptedMessage;
  /** First of a run by one sender: the one that gets the breathing room above it. */
  readonly firstOfGroup: boolean;
  /** Last of a run: the one that gets the tail corner and the timestamp. */
  readonly lastOfGroup: boolean;
}

export type ChatItem = DaySeparatorItem | MessageItem;

/**
 * Chronological order, oldest first. The screen reverses this for an inverted list; keeping the
 * builder in reading order is what makes "previous" and "next" mean what they say.
 */
export function buildChatItems(messages: readonly DecryptedMessage[]): ChatItem[] {
  const items: ChatItem[] = [];
  messages.forEach((message, index) => {
    const previous = index === 0 ? null : (messages[index - 1] ?? null);
    const next = messages[index + 1] ?? null;

    const newDay = previous === null || !sameDay(previous.createdAt, message.createdAt);
    if (newDay) {
      items.push({ kind: 'day', key: 'day_' + message.id, at: message.createdAt });
    }

    const firstOfGroup =
      newDay ||
      previous === null ||
      previous.from !== message.from ||
      message.createdAt - previous.createdAt > GROUP_GAP_MS;

    const lastOfGroup =
      next === null ||
      next.from !== message.from ||
      !sameDay(next.createdAt, message.createdAt) ||
      next.createdAt - message.createdAt > GROUP_GAP_MS;

    items.push({ kind: 'message', key: message.id, message, firstOfGroup, lastOfGroup });
  });
  return items;
}
