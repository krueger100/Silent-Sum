/**
 * Auto-lock and the privacy curtain, driven through real AppState transitions.
 *
 * These are security behaviours, not cosmetics: if the timer can be defeated by changing the
 * system clock, or the curtain does not cover the app before the switcher snapshot, the vault is
 * exposed on a phone that was merely put down.
 */
import React from 'react';
import { AppState, Text, type AppStateStatus } from 'react-native';
import { act, render, screen, waitFor } from '@testing-library/react-native';

import { ServicesProvider } from '@/app/ServicesProvider';
import { createServices, type Services } from '@/app/services';
import { KDF_PRESETS } from '@/crypto/types';
import { AppLifecycleGuard } from '@/privacy/AppLifecycleGuard';
import { RecordingScreenProtection } from '@/privacy/types';
import { InMemorySecureStore } from '@/secure-storage/secureStore';
import { InMemorySettingsStore } from '@/settings/appSettings';
import { InMemoryFileSystem } from '@/storage/inMemoryFileSystem';
import { FakeThumbnailGenerator } from '@/vault/thumbnailGenerator';
import { containsSequence, utf8Encode } from '@/utils/bytes';
import { FakeClock, MINUTE_MS, SECOND_MS } from '@/utils/clock';

type Listener = (status: AppStateStatus) => void;

function captureAppState(): { emit: (status: AppStateStatus) => void } {
  const listeners = new Set<Listener>();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, handler) => {
    const listener = handler as Listener;
    listeners.add(listener);
    return {
      remove: () => {
        listeners.delete(listener);
      },
    } as ReturnType<typeof AppState.addEventListener>;
  });
  return {
    emit: (status) => {
      for (const listener of listeners) listener(status);
    },
  };
}

interface Harness {
  services: Services;
  clock: FakeClock;
  screenProtection: RecordingScreenProtection;
  fs: InMemoryFileSystem;
}

function build(): Harness {
  const clock = new FakeClock();
  const screenProtection = new RecordingScreenProtection();
  const fs = new InMemoryFileSystem();
  const services = createServices({
    clock,
    screenProtection,
    fs,
    secureStore: new InMemorySecureStore(),
    settingsStore: new InMemorySettingsStore(),
    thumbnails: new FakeThumbnailGenerator(),
    kdfParams: KDF_PRESETS.forTests,
  });
  return { services, clock, screenProtection, fs };
}

async function mount(harness: Harness) {
  return render(
    <ServicesProvider services={harness.services}>
      <AppLifecycleGuard>
        <Text testID="app-content">content</Text>
      </AppLifecycleGuard>
    </ServicesProvider>,
  );
}

async function unlock(harness: Harness): Promise<void> {
  const keys = await harness.services.auth.setupPin('2468');
  await harness.services.vault.open(keys);
  await act(() => {
    harness.services.session.adopt(keys);
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('leaving the app', () => {
  it('wipes a decrypted video when the app is backgrounded', async () => {
    const harness = build();
    const appState = captureAppState();
    await mount(harness);
    await unlock(harness);

    // As if a video were on screen: the one piece of vault plaintext that lives in a file.
    const uri = await harness.services.playbackScratch.allocate();
    await harness.fs.writeBytes(uri, utf8Encode('ftypisom decrypted recording'));
    const stored = harness.fs.peek(uri);
    if (stored === undefined) throw new Error('expected the decrypted file');

    await act(() => {
      appState.emit('background');
    });
    await waitFor(async () => {
      expect(await harness.fs.exists(uri)).toBe(false);
    });
    // Overwritten before it was unlinked.
    expect(containsSequence(stored, utf8Encode('ftypisom'))).toBe(false);
  });

  it('leaves it alone for a transient overlay, which is not leaving the app', async () => {
    const harness = build();
    const appState = captureAppState();
    await mount(harness);
    await unlock(harness);

    const uri = await harness.services.playbackScratch.allocate();
    await harness.fs.writeBytes(uri, utf8Encode('ftypisom decrypted recording'));

    // iOS raises `inactive` for a notification banner; deleting the file under a running player
    // for that would break playback for no gain -- the curtain already covers the screen.
    await act(() => {
      appState.emit('inactive');
    });
    expect(await harness.fs.exists(uri)).toBe(true);
  });
});

describe('auto-lock', () => {
  it('locks after the configured time in the background', async () => {
    const harness = build();
    const appState = captureAppState();
    await mount(harness);
    await unlock(harness);
    await harness.services.settings.update({ autoLockTimeout: 'oneMinute' });

    await act(() => {
      appState.emit('background');
    });
    harness.clock.advance(MINUTE_MS);
    await act(() => {
      appState.emit('active');
    });

    expect(harness.services.session.isUnlocked).toBe(false);
  });

  it('stays unlocked for a short absence', async () => {
    const harness = build();
    const appState = captureAppState();
    await mount(harness);
    await unlock(harness);
    await harness.services.settings.update({ autoLockTimeout: 'fiveMinutes' });

    await act(() => {
      appState.emit('background');
    });
    harness.clock.advance(30 * SECOND_MS);
    await act(() => {
      appState.emit('active');
    });

    expect(harness.services.session.isUnlocked).toBe(true);
  });

  it('locks immediately when that is the chosen setting', async () => {
    const harness = build();
    const appState = captureAppState();
    await mount(harness);
    await unlock(harness);
    await harness.services.settings.update({ autoLockTimeout: 'immediately' });

    await act(() => {
      appState.emit('background');
    });
    await act(() => {
      appState.emit('active');
    });

    expect(harness.services.session.isUnlocked).toBe(false);
  });

  it('cannot be defeated by winding the system clock', async () => {
    const harness = build();
    const appState = captureAppState();
    await mount(harness);
    await unlock(harness);
    await harness.services.settings.update({ autoLockTimeout: 'fiveMinutes' });

    await act(() => {
      appState.emit('background');
    });
    // Wall clock jumps a day; the monotonic timer has barely moved, so this is still a short trip.
    harness.clock.setNow(harness.clock.now() + 24 * 60 * MINUTE_MS);
    await act(() => {
      appState.emit('active');
    });
    expect(harness.services.session.isUnlocked).toBe(true);

    // And a genuinely long absence still locks, measured monotonically.
    await act(() => {
      appState.emit('background');
    });
    harness.clock.advance(6 * MINUTE_MS);
    await act(() => {
      appState.emit('active');
    });
    expect(harness.services.session.isUnlocked).toBe(false);
  });

  it('holds the lock off during a picker round trip, but not forever', async () => {
    const harness = build();
    const appState = captureAppState();
    await mount(harness);
    await unlock(harness);
    await harness.services.settings.update({ autoLockTimeout: 'immediately' });

    harness.services.autoLockSuspension.suspend();
    await act(() => {
      appState.emit('background');
    });
    harness.clock.advance(MINUTE_MS);
    await act(() => {
      appState.emit('active');
    });
    expect(harness.services.session.isUnlocked).toBe(true);

    // Beyond the grace window the suspension no longer protects the session.
    await act(() => {
      appState.emit('background');
    });
    harness.clock.advance(6 * MINUTE_MS);
    await act(() => {
      appState.emit('active');
    });
    expect(harness.services.session.isUnlocked).toBe(false);
  });

  it('does nothing while the vault is already locked', async () => {
    const harness = build();
    const appState = captureAppState();
    await mount(harness);

    await act(() => {
      appState.emit('background');
    });
    harness.clock.advance(60 * MINUTE_MS);
    await act(() => {
      appState.emit('active');
    });

    expect(harness.services.session.isUnlocked).toBe(false);
    expect(screen.getByTestId('app-content')).toBeTruthy();
  });
});

describe('privacy curtain', () => {
  // The curtain is deliberately hidden from assistive technology, so queries must opt in to
  // hidden elements to see it at all.
  const curtain = () => screen.queryByTestId('privacy-curtain', { includeHiddenElements: true });

  it('covers an unlocked vault the moment the app goes inactive', async () => {
    const harness = build();
    const appState = captureAppState();
    await mount(harness);
    await unlock(harness);

    expect(curtain()).toBeNull();

    await act(() => {
      appState.emit('inactive');
    });
    expect(curtain()).not.toBeNull();

    await act(() => {
      appState.emit('active');
    });
    await waitFor(() => {
      expect(curtain()).toBeNull();
    });
  });

  it('covers it on background too, not only on the inactive step', async () => {
    const harness = build();
    const appState = captureAppState();
    await mount(harness);
    await unlock(harness);

    await act(() => {
      appState.emit('background');
    });

    expect(curtain()).not.toBeNull();
  });

  it('is not shown while locked, because there is nothing to hide', async () => {
    const harness = build();
    const appState = captureAppState();
    await mount(harness);

    await act(() => {
      appState.emit('inactive');
    });

    expect(curtain()).toBeNull();
  });
});

describe('screen protection', () => {
  it('follows the session', async () => {
    const harness = build();
    captureAppState();
    await mount(harness);

    await unlock(harness);
    await waitFor(() => {
      expect(harness.screenProtection.calls).toContain(true);
    });

    await act(() => {
      harness.services.session.lock();
    });
    await waitFor(() => {
      expect(harness.screenProtection.calls.at(-1)).toBe(false);
    });
  });

  it('stays off while the user has the setting disabled', async () => {
    const harness = build();
    captureAppState();
    await harness.services.settings.update({ screenProtection: false });
    await mount(harness);

    await unlock(harness);

    expect(harness.screenProtection.calls).not.toContain(true);
  });
});
