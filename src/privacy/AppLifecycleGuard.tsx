/**
 * Wraps the whole app and enforces everything that must happen when it leaves the foreground.
 *
 * - Locks the vault once the configured background timeout has elapsed, measured on the MONOTONIC
 *   clock so changing the system time while backgrounded cannot defeat it.
 * - Shows the privacy curtain while inactive, so the app-switcher snapshot and any overlay never
 *   contain vault content. On Android FLAG_SECURE already blanks the recents preview; on iOS the
 *   curtain is the only defence, which is why it is rendered on `inactive`, before the snapshot.
 * - Turns platform screen protection on and off with the session and the user's setting.
 * - Wipes the playback scratch directory. A decrypted video is the one piece of vault plaintext
 *   that lives in a file rather than in memory, so leaving the app has to remove it, not just
 *   cover it up. This happens on `background` only: iOS raises `inactive` for a notification
 *   banner, and deleting the file under a player for that would be absurd. The viewer rebuilds
 *   its file when the app returns.
 *
 * The one exception to the timeout is a deliberate hand-off to a system UI (the photo picker, a
 * permission dialog). Those suspend the timer for a bounded grace window, because otherwise
 * importing a photo would lock the vault underneath the user. A genuinely long absence still locks.
 */
import React, { useEffect, useRef, useState, type ReactNode } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { useServices, useSettings } from '@/app/ServicesProvider';
import { shouldLock } from '@/privacy/autoLockPolicy';
import { AUTO_LOCK_SUSPENSION_GRACE_MS } from '@/privacy/types';
import { PrivacyCurtain } from '@/privacy/PrivacyCurtain';
import { AUTO_LOCK_DURATION_MS } from '@/settings/appSettings';

export function AppLifecycleGuard({ children }: { children: ReactNode }): React.JSX.Element {
  const services = useServices();
  const settings = useSettings();
  const [covered, setCovered] = useState(false);
  const backgroundedAtRef = useRef<number | null>(null);

  const { session, vault, clock, autoLockSuspension, screenProtection, playbackScratch } =
    services;
  const timeoutMs = AUTO_LOCK_DURATION_MS[settings.autoLockTimeout];
  const screenProtectionEnabled = settings.screenProtection;

  // Keep the latest values visible to the AppState listener without re-subscribing on each change.
  const latest = useRef({ timeoutMs, screenProtectionEnabled });
  useEffect(() => {
    latest.current = { timeoutMs, screenProtectionEnabled };
  }, [timeoutMs, screenProtectionEnabled]);

  useEffect(() => {
    function handle(status: AppStateStatus): void {
      if (status === 'active') {
        const backgroundedAt = backgroundedAtRef.current;
        backgroundedAtRef.current = null;
        setCovered(false);
        if (!session.isUnlocked || backgroundedAt === null) return;

        const nowMs = clock.monotonicMs();
        const suspended = autoLockSuspension.isSuspended;
        const withinGrace = nowMs - backgroundedAt < AUTO_LOCK_SUSPENSION_GRACE_MS;
        if (suspended && withinGrace) return;

        if (
          shouldLock({
            backgroundedAtMs: backgroundedAt,
            nowMs,
            timeoutMs: latest.current.timeoutMs,
          })
        ) {
          session.lock();
        }
        return;
      }

      // 'inactive' (iOS multitask/overlay) and 'background' both mean "may be captured".
      setCovered(true);
      if (status === 'background' || status === 'inactive') {
        backgroundedAtRef.current ??= clock.monotonicMs();
      }
      // Leaving the app entirely: no decrypted video may survive it.
      if (status === 'background') void playbackScratch.purge();
    }

    const subscription = AppState.addEventListener('change', handle);
    return () => {
      subscription.remove();
    };
  }, [session, clock, autoLockSuspension, playbackScratch]);

  // Screen protection follows the session and the setting together.
  useEffect(() => {
    let cancelled = false;
    const apply = (): void => {
      if (cancelled) return;
      void screenProtection.setSecure(session.isUnlocked && screenProtectionEnabled);
    };
    apply();
    const unsubscribe = session.store.subscribe(apply);
    return () => {
      cancelled = true;
      unsubscribe();
      // Leaving the guard must not strand the OS in secure mode.
      void screenProtection.setSecure(false);
    };
  }, [session, screenProtection, screenProtectionEnabled]);

  // Dropping decoded images on lock is what stops a re-render from painting stale plaintext.
  useEffect(() => session.onLock(() => void vault.close()), [session, vault]);

  const showCurtain = covered && session.isUnlocked;
  return (
    <>
      {children}
      {showCurtain ? <PrivacyCurtain /> : null}
    </>
  );
}
