/**
 * The two pure parts of the chat layout: where the day separators fall, and where a run of
 * messages from one person begins and ends.
 *
 * Every instant here is built with the local-time `Date` constructor rather than an epoch
 * number, so the expectations hold in whatever timezone the test happens to run in.
 */
import type { DecryptedMessage } from '@/messaging/messaging';
import { buildChatItems, type ChatItem } from '@/messaging/screens/chatItems';
import { daySeparatorLabel, listTimeLabel, sameDay } from '@/messaging/screens/chatTime';

const MINUTE = 60_000;

function at(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

function message(id: string, from: string, createdAt: number): DecryptedMessage {
  return {
    id,
    from,
    createdAt,
    mine: from === 'me',
    body: id,
    kind: null,
    object: null,
    thumbObject: null,
    deleted: false,
  };
}

function kinds(items: readonly ChatItem[]): string[] {
  return items.map((item) => (item.kind === 'day' ? 'day' : item.message.id));
}

function group(items: readonly ChatItem[], id: string): { first: boolean; last: boolean } {
  const found = items.find((item) => item.kind === 'message' && item.message.id === id);
  if (found === undefined || found.kind !== 'message') throw new Error('no such item: ' + id);
  return { first: found.firstOfGroup, last: found.lastOfGroup };
}

describe('buildChatItems', () => {
  it('opens with a day separator and adds one for every new day', () => {
    const items = buildChatItems([
      message('a', 'me', at(2026, 9, 20, 9)),
      message('b', 'me', at(2026, 9, 20, 17)),
      message('c', 'me', at(2026, 9, 21, 9)),
    ]);
    expect(kinds(items)).toEqual(['day', 'a', 'b', 'day', 'c']);
  });

  it('makes one group of a burst from the same sender', () => {
    const base = at(2026, 9, 21, 10);
    const items = buildChatItems([
      message('a', 'me', base),
      message('b', 'me', base + MINUTE),
      message('c', 'me', base + 2 * MINUTE),
    ]);
    expect(group(items, 'a')).toEqual({ first: true, last: false });
    expect(group(items, 'b')).toEqual({ first: false, last: false });
    expect(group(items, 'c')).toEqual({ first: false, last: true });
  });

  it('breaks the group when the sender changes', () => {
    const base = at(2026, 9, 21, 10);
    const items = buildChatItems([
      message('a', 'me', base),
      message('b', 'them', base + MINUTE),
    ]);
    expect(group(items, 'a')).toEqual({ first: true, last: true });
    expect(group(items, 'b')).toEqual({ first: true, last: true });
  });

  it('breaks the group after a long enough pause', () => {
    const base = at(2026, 9, 21, 10);
    const items = buildChatItems([
      message('a', 'me', base),
      message('b', 'me', base + 6 * MINUTE),
    ]);
    expect(group(items, 'a')).toEqual({ first: true, last: true });
    expect(group(items, 'b')).toEqual({ first: true, last: true });
  });

  it('breaks the group across midnight even for one sender a minute apart', () => {
    const items = buildChatItems([
      message('a', 'me', at(2026, 9, 20, 23, 59)),
      message('b', 'me', at(2026, 9, 21, 0, 0)),
    ]);
    expect(kinds(items)).toEqual(['day', 'a', 'day', 'b']);
    expect(group(items, 'a')).toEqual({ first: true, last: true });
  });

  it('has nothing to lay out for an empty thread', () => {
    expect(buildChatItems([])).toEqual([]);
  });
});

describe('chat labels', () => {
  const now = at(2026, 9, 22, 14, 30);

  it('knows which instants share a calendar day', () => {
    expect(sameDay(at(2026, 9, 22, 0, 1), at(2026, 9, 22, 23, 59))).toBe(true);
    expect(sameDay(at(2026, 9, 22, 23, 59), at(2026, 9, 23, 0, 1))).toBe(false);
  });

  it('names the recent days and dates the rest', () => {
    expect(daySeparatorLabel(at(2026, 9, 22, 8), now)).toBe('Today');
    expect(daySeparatorLabel(at(2026, 9, 21, 8), now)).toBe('Yesterday');
    expect(daySeparatorLabel(at(2026, 9, 18, 8), now)).toBe('Friday');
    expect(daySeparatorLabel(at(2026, 9, 1, 8), now)).toBe('1 Sep');
    expect(daySeparatorLabel(at(2025, 12, 24, 8), now)).toBe('24 Dec 2025');
  });

  it('gets coarser the further back a conversation row is', () => {
    expect(listTimeLabel(0, now)).toBe('');
    expect(listTimeLabel(at(2026, 9, 21, 8), now)).toBe('Yesterday');
    expect(listTimeLabel(at(2026, 9, 18, 8), now)).toBe('Fri');
    expect(listTimeLabel(at(2026, 9, 1, 8), now)).toBe('1 Sep');
    expect(listTimeLabel(at(2025, 12, 24, 8), now)).toBe('24 Dec 2025');
  });
});
