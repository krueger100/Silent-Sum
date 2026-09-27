/**
 * The support-issued recovery code, driven through the real app.
 *
 * The scenario is the one it exists for: super secure is on, the PIN is forgotten, and the ONLY
 * thing the calculator's menu offers is About. These tests care about two things above all --
 * that nothing on that page names an account until a genuine code has verified, and that a code
 * buys a sign-in screen and not one step more. The passphrase still stands behind it, and the
 * code cannot touch it.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { crypto_sign_detached, crypto_sign_keypair } from 'react-native-libsodium';

import { SequentialRandom } from '@/crypto/random';
import { RecoveryAccess } from '@/support/recoveryAccess';
import {
  dayNumber,
  encodeRecoveryCode,
  recoveryCodeMessage,
  RECOVERY_CODE_TTL_DAYS,
} from '@/support/recoveryCode';
import type { Bytes } from '@/utils/bytes';

import { InMemorySecureStore } from '@/secure-storage/secureStore';
import { buildSupportEmail } from '@/support/supportMessage';
import type { SupportMessage, SupportSendResult, SupportService } from '@/support/types';
import { FakeClock } from '@/utils/clock';

import { buildHarness, renderApp, type Harness } from '../support/appHarness';

jest.setTimeout(30000);

const PIN = '2468';
const PASSPHRASE = 'correct horse battery staple';
const EMAIL = 'vault@example.test';
const PASSWORD = 'account-password';

/** Records the message exactly as the app hands it over, scrubbing and all. */
class RecordingSupport implements SupportService {
  readonly sent: SupportMessage[] = [];
  readonly contact = 'support@example.test';

  async send(message: SupportMessage): Promise<SupportSendResult> {
    this.sent.push(message);
    return { kind: 'sent', reference: null };
  }
}

interface Fixture {
  readonly harness: Harness;
  readonly recovery: RecoveryAccess;
  /** The store and clock the SERVICES use, which the harness fields do not report back. */
  readonly secureStore: InMemorySecureStore;
  readonly clock: FakeClock;
  readonly support: RecordingSupport;
  /** Mints a code the way the offline signing script would. */
  mint(options?: { days?: number; privateKey?: Bytes }): Promise<string>;
}

async function build(): Promise<Fixture> {
  const pair = crypto_sign_keypair();
  // Built here rather than inside the harness so the recovery service and the app share them.
  const secureStore = new InMemorySecureStore();
  const clock = new FakeClock();
  const recovery = new RecoveryAccess({
    store: secureStore,
    random: new SequentialRandom(),
    clock,
    publicKey: pair.publicKey,
  });
  // A real build reads the public key out of `extra`; here it is injected.
  const support = new RecordingSupport();
  const harness = buildHarness({
    withCloud: true,
    overrides: { secureStore, clock, recovery, support },
  });

  return {
    harness,
    recovery,
    secureStore,
    clock,
    support,
    async mint(options) {
      const ref = await recovery.installRef();
      const days = dayNumber(clock.now()) + (options?.days ?? RECOVERY_CODE_TTL_DAYS);
      return encodeRecoveryCode(
        days,
        crypto_sign_detached(
          recoveryCodeMessage(ref, days),
          options?.privateKey ?? pair.privateKey,
        ),
      );
    },
  };
}

async function press(testID: string): Promise<void> {
  await fireEvent.press(screen.getByTestId(testID));
}

async function type(testID: string, value: string): Promise<void> {
  await fireEvent.changeText(screen.getByTestId(testID), value);
}

/** A vault with a cloud backup, super secure on, and the PIN as good as forgotten. */
async function seedLockedOutVault(harness: Harness): Promise<void> {
  const keys = await harness.services.auth.setupPin(PIN);
  const repository = await harness.services.vault.open(keys);
  await repository.addPhoto({ bytes: new Uint8Array(512).fill(9) }, { source: 'import' });

  if (harness.cloud === null) throw new Error('expected a cloud backend');
  await harness.cloud.signUp(EMAIL, PASSWORD);
  const backup = harness.services.backup;
  if (backup === null) throw new Error('expected a backup service');
  await backup.enable(keys, PASSPHRASE);
  await backup.backupNow(repository, keys);
  await harness.cloud.signOut();

  await harness.services.settings.update({
    onboardingDone: true,
    backupEnabled: true,
    superSecure: true,
  });
  await harness.services.vault.close();
  keys.dispose();
}

/** Calculator -> menu -> About, which under super secure is the only door there is. */
async function openAbout(): Promise<void> {
  await waitFor(() => screen.getByTestId('calculator-screen'), { timeout: 10000 });
  await press('calc_menu');
  await press('menu_about');
  await waitFor(() => {
    expect(screen.getByTestId('about_screen')).toBeTruthy();
  });
}

async function enterCode(code: string): Promise<void> {
  await type('about_recovery_input', code);
  await press('about_recovery_submit');
}

describe('support-issued recovery code', () => {
  it('shows no way to an account until a genuine code has verified', async () => {
    const f = await build();
    await seedLockedOutVault(f.harness);
    await renderApp(f.harness);
    await openAbout();

    // Super secure is doing its job: the menu held nothing but About.
    expect(screen.queryByTestId('menu_forgot_pin')).toBeNull();
    // And About names no account, no backup and no passphrase.
    expect(screen.queryByTestId('restore_email')).toBeNull();
    expect(screen.queryByTestId('restore_password')).toBeNull();
    expect(screen.queryByTestId('about_security_summary')).toBeNull();
    expect(screen.queryByTestId('about_support_recovery')).toBeNull();

    await enterCode(await f.mint());

    await waitFor(() => {
      expect(screen.getByTestId('restore_email')).toBeTruthy();
    });
    expect(screen.getByTestId('restore_password')).toBeTruthy();
  });

  it.each([
    ['a code for another installation', 'other-install'],
    ['a code signed by the wrong key', 'wrong-key'],
    ['an expired code', 'expired'],
    ['gibberish', 'garbage'],
  ])('refuses %s and leaves the account hidden', async (_name, kind) => {
    const f = await build();
    await seedLockedOutVault(f.harness);
    await renderApp(f.harness);
    await openAbout();

    let code: string;
    if (kind === 'wrong-key') {
      code = await f.mint({ privateKey: crypto_sign_keypair().privateKey });
    } else if (kind === 'expired') {
      code = await f.mint({ days: 1 });
      f.clock.advance((RECOVERY_CODE_TTL_DAYS + 1) * 24 * 60 * 60 * 1000);
    } else if (kind === 'other-install') {
      // Same key, same expiry, different phone.
      const days = dayNumber(f.clock.now()) + RECOVERY_CODE_TTL_DAYS;
      const otherRef = Uint8Array.from([2, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
      code = encodeRecoveryCode(
        days,
        crypto_sign_detached(recoveryCodeMessage(otherRef, days), crypto_sign_keypair().privateKey),
      );
    } else {
      code = 'NOPE-NOPE-NOPE';
    }

    await enterCode(code);

    await waitFor(() => {
      expect(screen.getByTestId('about_recovery_error')).toBeTruthy();
    });
    expect(screen.queryByTestId('restore_email')).toBeNull();
    expect(f.recovery.isAuthorized).toBe(false);
  });

  it('spends the code: the same one will not open the door twice', async () => {
    const f = await build();
    await seedLockedOutVault(f.harness);
    await renderApp(f.harness);
    await openAbout();
    const code = await f.mint();

    await enterCode(code);
    await waitFor(() => {
      expect(screen.getByTestId('restore_email')).toBeTruthy();
    });

    // Back out, which also ends the authorization, and try the same code again.
    await press('screen-back');
    await waitFor(() => {
      expect(screen.getByTestId('about_screen')).toBeTruthy();
    });
    expect(f.recovery.isAuthorized).toBe(false);

    await enterCode(code);

    await waitFor(() => {
      expect(screen.getByTestId('about_recovery_error')).toHaveTextContent(/already been used/i);
    });
    expect(screen.queryByTestId('restore_email')).toBeNull();
  });

  it('still demands the recovery passphrase after the account signs in', async () => {
    const f = await build();
    await seedLockedOutVault(f.harness);
    await renderApp(f.harness);
    await openAbout();
    await enterCode(await f.mint());
    await waitFor(() => {
      expect(screen.getByTestId('restore_email')).toBeTruthy();
    });

    await type('restore_email', EMAIL);
    await type('restore_password', PASSWORD);
    await press('restore_sign_in');

    // Signing in reaches the passphrase step and stops dead there.
    await waitFor(() => {
      expect(screen.getByTestId('restore_passphrase')).toBeTruthy();
    });
    expect(screen.queryByTestId('restore_pin')).toBeNull();

    // A wrong passphrase gets no further: the code bought nothing here.
    await type('restore_passphrase', 'not the passphrase');
    await press('restore_passphrase_next');
    await waitFor(() => {
      expect(screen.getByTestId('restore_error')).toBeTruthy();
    });
    expect(screen.queryByTestId('restore_pin')).toBeNull();

    // The right one does, because it is the thing that actually unwraps the key.
    await type('restore_passphrase', PASSPHRASE);
    await press('restore_passphrase_next');
    await waitFor(() => {
      expect(screen.getByTestId('restore_pin')).toBeTruthy();
    });
  });

  it('keeps the account password reset available, since that may be forgotten too', async () => {
    const f = await build();
    await seedLockedOutVault(f.harness);
    await renderApp(f.harness);
    await openAbout();
    await enterCode(await f.mint());
    await waitFor(() => {
      expect(screen.getByTestId('restore_forgot_password')).toBeTruthy();
    });

    await type('restore_email', EMAIL);
    await press('restore_forgot_password');

    await waitFor(() => {
      expect(screen.getByTestId('restore_notice')).toBeTruthy();
    });
    // The reset really was requested of the backend, not just announced.
    expect(f.harness.cloud?.passwordResets).toContain(EMAIL);
  });

  it('never unlocks the vault by itself, and leaves the PIN exactly as it was', async () => {
    const f = await build();
    await seedLockedOutVault(f.harness);
    await renderApp(f.harness);
    await openAbout();

    const credentialsBefore = f.secureStore.snapshot;
    await enterCode(await f.mint());
    await waitFor(() => {
      expect(screen.getByTestId('restore_email')).toBeTruthy();
    });

    // Authorized, and still locked out: no session, no keys, no vault.
    expect(f.recovery.isAuthorized).toBe(true);
    expect(f.harness.services.session.isUnlocked).toBe(false);
    expect(f.harness.services.session.peekKeys()).toBeNull();
    expect(() => f.harness.services.session.requireKeys()).toThrow();
    // The wrapped master key is untouched: the code cannot rewrap, reset or read it.
    expect(f.secureStore.snapshot['silentsum.vault.credentials.v1']).toBe(
      credentialsBefore['silentsum.vault.credentials.v1'],
    );
    // And the original PIN still works, which it would not if the code had changed anything.
    await expect(f.harness.services.auth.unlock(PIN)).resolves.toMatchObject({
      kind: 'success',
    });
  });

  it('withdraws the authorization when the vault locks', async () => {
    const f = await build();
    await seedLockedOutVault(f.harness);
    await renderApp(f.harness);
    await openAbout();
    await enterCode(await f.mint());
    await waitFor(() => {
      expect(screen.getByTestId('restore_email')).toBeTruthy();
    });
    expect(f.recovery.isAuthorized).toBe(true);

    // Whatever the reason, locking means nobody is trusted right now.
    const keys = await f.harness.services.auth.unlock(PIN);
    if (keys.kind !== 'success') throw new Error('expected the PIN to verify');
    f.harness.services.session.adopt(keys.keys);
    f.harness.services.session.lock();

    expect(f.recovery.isAuthorized).toBe(false);
  });

  it('withdraws the authorization once the recovery has actually finished', async () => {
    const f = await build();
    await seedLockedOutVault(f.harness);
    await renderApp(f.harness);
    await openAbout();
    await enterCode(await f.mint());
    await waitFor(() => {
      expect(screen.getByTestId('restore_email')).toBeTruthy();
    });

    await type('restore_email', EMAIL);
    await type('restore_password', PASSWORD);
    await press('restore_sign_in');
    await waitFor(() => {
      expect(screen.getByTestId('restore_passphrase')).toBeTruthy();
    });
    await type('restore_passphrase', PASSPHRASE);
    await press('restore_passphrase_next');
    await waitFor(() => {
      expect(screen.getByTestId('restore_pin')).toBeTruthy();
    });

    // Replacing the vault that is already here is exactly what this path is for, and it is
    // announced rather than done quietly.
    expect(screen.getByTestId('restore_overwrite_warning')).toBeTruthy();

    await type('restore_pin', '1357');
    await type('restore_pin_confirm', '1357');
    await press('restore_submit');

    await waitFor(
      () => {
        expect(screen.getByTestId('restore_summary')).toBeTruthy();
      },
      { timeout: 15000 },
    );
    await press('restore_done');

    await waitFor(() => {
      expect(f.recovery.isAuthorized).toBe(false);
    });
  });

  describe('the reference in the support message', () => {
    it('is already in the draft, so a locked-out user does not have to be asked for it', async () => {
      const f = await build();
      await seedLockedOutVault(f.harness);
      await renderApp(f.harness);
      await openAbout();
      const reference = await f.recovery.displayRef();

      await waitFor(() => {
        expect(screen.getByTestId('about_support_body')).toHaveProp(
          'value',
          `Reference ${reference}\n\n`,
        );
      });
      expect(screen.getByTestId('about_support_reference_note')).toBeTruthy();
    });

    it('reaches the inbox intact, through the scrubbing every message gets', async () => {
      const f = await build();
      await seedLockedOutVault(f.harness);
      await renderApp(f.harness);
      await openAbout();
      const reference = await f.recovery.displayRef();
      await waitFor(() => {
        expect(screen.getByTestId('about_support_body')).toHaveProp(
          'value',
          `Reference ${reference}\n\n`,
        );
      });

      await type('about_support_body', `Reference ${reference}\n\nI forgot my password`);
      await type('about_support_reply_to', 'user@example.test');
      await press('about_support_send');

      await waitFor(() => {
        expect(f.support.sent).toHaveLength(1);
      });
      // What the operator will actually read, after the PIN scrubber has had its pass.
      const delivered = buildSupportEmail(f.support.sent[0]!).text;
      expect(delivered).toContain(reference);
    });

    it('does not overwrite what the user has started writing', async () => {
      const f = await build();
      await seedLockedOutVault(f.harness);
      await renderApp(f.harness);
      await openAbout();
      await waitFor(() => {
        expect(screen.getByTestId('about_support_body')).toHaveProp(
          'value',
          expect.stringContaining('Reference'),
        );
      });

      await type('about_support_body', 'just my own words');

      expect(screen.getByTestId('about_support_body')).toHaveProp('value', 'just my own words');
    });

    it('can be deleted, because it is text and not an attachment', async () => {
      const f = await build();
      await seedLockedOutVault(f.harness);
      await renderApp(f.harness);
      await openAbout();
      const reference = await f.recovery.displayRef();
      await waitFor(() => {
        expect(screen.getByTestId('about_support_body')).toHaveProp(
          'value',
          expect.stringContaining('Reference'),
        );
      });

      await type('about_support_body', 'I would rather not say which phone');
      await type('about_support_reply_to', 'user@example.test');
      await press('about_support_send');

      await waitFor(() => {
        expect(f.support.sent).toHaveLength(1);
      });
      expect(f.support.sent[0]?.body).not.toContain(reference);
    });

    it('is left out entirely in a build that cannot accept codes', async () => {
      const secureStore = new InMemorySecureStore();
      const clock = new FakeClock();
      const support = new RecordingSupport();
      // No public key: nothing here could ever redeem a code, so nothing here asks for a ref.
      const recovery = new RecoveryAccess({
        store: secureStore,
        random: new SequentialRandom(),
        clock,
        publicKey: null,
      });
      const harness = buildHarness({
        withCloud: true,
        overrides: { secureStore, clock, recovery, support },
      });
      await seedLockedOutVault(harness);
      await renderApp(harness);
      await openAbout();

      expect(screen.queryByTestId('about_recovery_code')).toBeNull();
      expect(screen.queryByTestId('about_support_reference_note')).toBeNull();
      expect(screen.getByTestId('about_support_body')).toHaveProp('value', '');
    });
  });
});
