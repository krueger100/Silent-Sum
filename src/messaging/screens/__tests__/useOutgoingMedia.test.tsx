/**
 * The gap between picking an item and the message arriving is where duplicates get sent, so the
 * behaviour in that gap is worth pinning: an item appears at once, a second send is refused while
 * one is in flight, and a failure is held rather than dropped.
 */
import React from 'react';
import { act, renderHook } from '@testing-library/react-native';

import { ServicesProvider } from '@/app/ServicesProvider';
import type { Services } from '@/app/services';
import { MessagingError, type MediaSource } from '@/messaging/messagingService';
import { useOutgoingMedia } from '@/messaging/screens/useOutgoingMedia';
import { ALICE, MessagingWorld } from '@/messaging/screens/__tests__/harness';

const SOURCE: MediaSource = { uri: 'file:///p.jpg', kind: 'photo', bytes: new Uint8Array([1, 2]) };

function wrapper(services: Services) {
  return function Wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
    return <ServicesProvider services={services}>{children}</ServicesProvider>;
  };
}

/** A send this test controls the timing of. */
function controllable(): {
  deliver: (source: MediaSource) => Promise<void>;
  settle: (outcome: 'ok' | 'fail') => void;
  calls: number;
} {
  const state = { calls: 0, resolve: (): void => undefined, reject: (): void => undefined };
  const api = {
    deliver: async (_source: MediaSource): Promise<void> => {
      state.calls += 1;
      await new Promise<void>((resolve, reject) => {
        state.resolve = resolve;
        state.reject = () => {
          reject(new Error('no'));
        };
      });
    },
    settle: (outcome: 'ok' | 'fail'): void => {
      if (outcome === 'ok') state.resolve();
      else state.reject();
    },
    get calls(): number {
      return state.calls;
    },
  };
  return api;
}

describe('useOutgoingMedia', () => {
  it('shows the item at once and reports busy until the send lands', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, 1);
    const sender = controllable();
    const { result } = await renderHook(() => useOutgoingMedia(sender.deliver), {
      wrapper: wrapper(alice.services),
    });

    let sending: Promise<void> = Promise.resolve();
    await act(async () => {
      sending = result.current.send(SOURCE);
      await Promise.resolve();
    });

    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0]?.kind).toBe('photo');
    // A preview is generated locally, so the bubble is never an empty box.
    expect(result.current.items[0]?.preview).not.toBeNull();
    expect(result.current.busy).toBe(true);

    await act(async () => {
      sender.settle('ok');
      await sending;
    });

    // The real message arrives through the listener; the placeholder has done its job.
    expect(result.current.items).toHaveLength(0);
    expect(result.current.busy).toBe(false);
  });

  it('holds a failed item, stops being busy, and retries from the source it kept', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, 1);
    const sender = controllable();
    const { result } = await renderHook(() => useOutgoingMedia(sender.deliver), {
      wrapper: wrapper(alice.services),
    });

    let sending: Promise<void> = Promise.resolve();
    await act(async () => {
      sending = result.current.send(SOURCE);
      await Promise.resolve();
    });
    await act(async () => {
      sender.settle('fail');
      await sending;
    });

    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0]?.failed).toBe(true);
    // Not busy any more: a failed item must not keep the composer locked.
    expect(result.current.busy).toBe(false);

    const id = result.current.items[0]?.id ?? '';
    let retrying: Promise<void> = Promise.resolve();
    await act(async () => {
      retrying = result.current.retry(id);
      await Promise.resolve();
    });

    // Retried from the held source: no second trip to the picker.
    expect(sender.calls).toBe(2);
    await act(async () => {
      sender.settle('ok');
      await retrying;
    });
    expect(result.current.items).toHaveLength(0);
  });

  it('refuses to re-run a failure that tapping again cannot fix, and says why', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, 1);
    let calls = 0;
    const deliver = async (): Promise<void> => {
      calls += 1;
      throw new MessagingError('pro-required');
    };
    const { result } = await renderHook(() => useOutgoingMedia(deliver), {
      wrapper: wrapper(alice.services),
    });

    await act(async () => {
      await result.current.send(SOURCE);
    });

    expect(result.current.items[0]?.failed).toBe(true);
    expect(result.current.items[0]?.retryable).toBe(false);
    expect(result.current.items[0]?.problem).toMatch(/pro/i);

    // Tapping it would clear the reason, fail again, and put it back -- a render that looks like
    // nothing happened, which is exactly what "it says tap to retry but it doesn't work" was.
    await act(async () => {
      await result.current.retry(result.current.items[0]?.id ?? '');
    });
    expect(calls).toBe(1);
    expect(result.current.items[0]?.problem).toMatch(/pro/i);
  });

  it('discards a failed item when asked', async () => {
    const world = new MessagingWorld();
    const alice = await world.join(ALICE, 1);
    const sender = controllable();
    const { result } = await renderHook(() => useOutgoingMedia(sender.deliver), {
      wrapper: wrapper(alice.services),
    });

    let sending: Promise<void> = Promise.resolve();
    await act(async () => {
      sending = result.current.send(SOURCE);
      await Promise.resolve();
    });
    await act(async () => {
      sender.settle('fail');
      await sending;
    });

    await act(async () => {
      result.current.dismiss(result.current.items[0]?.id ?? '');
      await Promise.resolve();
    });

    expect(result.current.items).toHaveLength(0);
  });
});
