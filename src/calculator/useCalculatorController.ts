/**
 * Drives the calculator and turns "press `=`, get a whole number" into a local unlock attempt.
 *
 * Every calculation is offered to the authenticator, which opens the vault when the RESULT is the
 * whole PIN. The disguise only works if a result that is nothing to do with the PIN is
 * indistinguishable from arithmetic: nothing is shown, logged or animated in that case.
 * Only three things ever surface, through the callbacks: a successful unlock; a result that is a
 * contiguous part of the PIN, answered with how many digits are missing; and a lockout notice for
 * a result that would otherwise have been answered, without which a user who has just been
 * throttled would think the app was broken.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { useServices } from '@/app/ServicesProvider';
import { INITIAL_STATE, press } from '@/calculator/calculatorEngine';
import type { CalcKey, CalculatorState } from '@/calculator/types';
import { CredentialsUnreadableError, type VaultStatus, type WipeScope } from '@/auth/types';
import { performScopedWipe } from '@/auth/vaultWipe';
import { ANALYTICS_EVENTS, logEventSafely } from '@/firebase/types';

export interface CalculatorCallbacks {
  /** The vault was unlocked and opened. */
  onOpened: () => void;
  /** The result is a part of the PIN, `missingDigits` short of all of it. Still locked. */
  onPartial: (digits: string, missingDigits: number) => void;
  /** An attempt was refused because of the failed-attempt delay. */
  onBlocked: (remainingMs: number) => void;
  /** The stored credentials cannot be read; only erase or restore helps. */
  onUnavailable: () => void;
}

export interface CalculatorController {
  state: CalculatorState;
  status: VaultStatus;
  /**
   * Set when a calculated result was the wipe PIN and the destruction is waiting to be confirmed.
   * The screen renders the prompt; nothing is destroyed until {@link confirmWipe}.
   */
  pendingWipe: WipeScope | null;
  confirmWipe(): void;
  cancelWipe(): void;
  press(key: CalcKey): void;
  clear(): void;
  refreshStatus(): Promise<void>;
}

const UNKNOWN_STATUS: VaultStatus = { configured: false, pinLength: null, unreadable: false };

async function readStatus(loadCredentials: () => Promise<{ pinLength: number } | null>) {
  try {
    const credentials = await loadCredentials();
    return {
      configured: credentials !== null,
      pinLength: credentials?.pinLength ?? null,
      unreadable: false,
    } satisfies VaultStatus;
  } catch (error) {
    if (error instanceof CredentialsUnreadableError) {
      return { configured: true, pinLength: null, unreadable: true } satisfies VaultStatus;
    }
    throw error;
  }
}

export function useCalculatorController(callbacks: CalculatorCallbacks): CalculatorController {
  const services = useServices();
  const { auth, session, vault, firebase } = services;
  const [state, setState] = useState<CalculatorState>(INITIAL_STATE);
  const [status, setStatus] = useState<VaultStatus>(UNKNOWN_STATUS);
  const busy = useRef(false);
  const wiping = useRef(false);
  const [pendingWipe, setPendingWipe] = useState<WipeScope | null>(null);

  // Callbacks change identity on every render of the screen; keeping them in a ref means the
  // unlock path never has to be rebuilt just because a parent re-rendered.
  const handlers = useRef(callbacks);
  useEffect(() => {
    handlers.current = callbacks;
  }, [callbacks]);

  const refreshStatus = useCallback(async () => {
    setStatus(await readStatus(() => auth.loadCredentials()));
  }, [auth]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = await readStatus(() => auth.loadCredentials());
      if (!cancelled) setStatus(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [auth]);

  // A lock (auto-lock, or the user leaving the vault) must not leave typed digits on screen.
  useEffect(
    () =>
      session.onLock(() => {
        setState(INITIAL_STATE);
      }),
    [session],
  );

  /**
   * Runs the wipe PIN's destruction, in the background and on purpose.
   *
   * Awaiting it here would stall the keypad for as long as the overwrite and the network take,
   * and a calculator that pauses for two seconds on one particular number has given the whole
   * thing away. So the display answers at calculator speed and the destruction happens behind it.
   * Nothing is reported, and nothing is logged -- an analytics event for this would be a record
   * that the feature exists and was used.
   */
  const startWipe = useCallback(
    (scope: WipeScope) => {
      if (wiping.current) return;
      wiping.current = true;
      void (async () => {
        try {
          await performScopedWipe(services, scope);
        } finally {
          wiping.current = false;
          // The vault may be gone now, and the menu and the welcome sheet read this.
          try {
            setStatus(await readStatus(() => auth.loadCredentials()));
          } catch {
            setStatus({ configured: true, pinLength: null, unreadable: true });
          }
        }
      })();
    },
    [auth, services],
  );

  const attemptUnlock = useCallback(
    async (digits: string, current: VaultStatus) => {
      if (busy.current) return;
      if (!current.configured) return;
      // An unreadable credential record is NOT short-circuited here any more. The wipe PIN is
      // checked before the record is parsed, so it still works on a vault that has stopped
      // opening; the parse then throws and the catch below reports it exactly as it used to.
      busy.current = true;
      try {
        const result = await auth.unlockWithCalculatedDigits(digits);
        switch (result.kind) {
          case 'success': {
            try {
              await vault.open(result.keys);
            } catch {
              // Vault files exist but do not decrypt: the session still opens so the gallery can
              // explain and offer erase or restore, rather than silently bouncing to the keypad.
            }
            session.adopt(result.keys);
            setState(INITIAL_STATE);
            logEventSafely(firebase.analytics, ANALYTICS_EVENTS.vaultUnlock);
            handlers.current.onOpened();
            return;
          }
          case 'partialPin':
            handlers.current.onPartial(result.digits, result.missingDigits);
            return;
          case 'throttled':
            handlers.current.onBlocked(result.remainingMs);
            return;
          case 'wipe':
            // Asked, not done. The result is held and the screen puts the question up; nothing is
            // destroyed until the answer comes back through `confirmWipe`.
            //
            // This costs the feature its original property -- a wipe used to be indistinguishable
            // from arithmetic, which is what made it usable under coercion. A prompt is visible to
            // whoever is watching the screen. That trade is deliberate: a number typed by accident,
            // or a wipe PIN whose owner has forgotten which number it was, should not be able to
            // destroy a vault with no way to stop it.
            setPendingWipe(result.scope);
            return;
          case 'wrongPin':
          case 'notConfigured':
            // Deliberately silent.
            return;
          default:
            return;
        }
      } catch (error) {
        if (error instanceof CredentialsUnreadableError) {
          setStatus({ configured: true, pinLength: null, unreadable: true });
          handlers.current.onUnavailable();
          return;
        }
        throw error;
      } finally {
        busy.current = false;
      }
    },
    [auth, session, vault, firebase],
  );

  const confirmWipe = useCallback((): void => {
    setPendingWipe((scope) => {
      if (scope !== null) startWipe(scope);
      return null;
    });
  }, [startWipe]);

  const cancelWipe = useCallback((): void => {
    setPendingWipe(null);
  }, []);

  const handlePress = useCallback(
    (key: CalcKey) => {
      setState((previous) => {
        const next = press(previous, key);
        if (next.unlockCandidate !== null) void attemptUnlock(next.unlockCandidate, status);
        return next;
      });
    },
    [attemptUnlock, status],
  );

  return {
    state,
    status,
    pendingWipe,
    confirmWipe,
    cancelWipe,
    press: handlePress,
    clear: useCallback(() => {
      setState(INITIAL_STATE);
    }, []),
    refreshStatus,
  };
}
