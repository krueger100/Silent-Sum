import React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { DARK_PALETTE, LIGHT_PALETTE } from '@/app/theme';

import { AboutScreen } from '@/settings/screens/AboutScreen';
import { AutoLockScreen } from '@/settings/screens/AutoLockScreen';
import { SecurityScreen } from '@/settings/screens/SecurityScreen';
import { SettingsScreen } from '@/settings/screens/SettingsScreen';
import { SupportScreen } from '@/settings/screens/SupportScreen';
import { WipePinScreen } from '@/settings/screens/WipePinScreen';
import { buildHarness, renderWithServices } from '@/settings/screens/__tests__/harness';
import { DEFAULT_SETTINGS } from '@/settings/appSettings';
import { InMemoryCloudBackend } from '@/firebase/cloudBackend';
import { NoopAnalyticsService, NoopCrashReporter } from '@/firebase/types';
import type { SupportMessage, SupportSendResult, SupportService } from '@/support/types';

const SENT: SupportSendResult = { kind: 'sent', reference: null };

/** Records what was handed to the transport, and decides what it answers. */
function fakeSupport(): {
  sent: SupportMessage[];
  answer: (next: SupportSendResult) => void;
  service: SupportService;
} {
  const sent: SupportMessage[] = [];
  let result: SupportSendResult = { kind: 'sent', reference: 'em_3f1e' };
  return {
    sent,
    answer: (next) => {
      result = next;
    },
    service: {
      send: async (message) => {
        sent.push(message);
        return result;
      },
    },
  };
}

describe('SettingsScreen', () => {
  it('routes every row to the navigator and shows the current auto-lock value', async () => {
    const harness = buildHarness();
    await harness.services.settings.update({ autoLockTimeout: 'fiveMinutes' });
    const handlers = {
      onChangePin: jest.fn(),
      onAutoLock: jest.fn(),
      onSecurity: jest.fn(),
      onWipePin: jest.fn(),
      onCloudBackup: jest.fn(),
      onSupport: jest.fn(),
      onAbout: jest.fn(),
    };

    await renderWithServices(harness.services, <SettingsScreen {...handlers} />);

    expect(screen.getByTestId('settings_auto_lock')).toHaveTextContent(/After 5 minutes/);
    expect(screen.getByTestId('settings_cloud_backup')).toHaveTextContent(/Not available/);

    for (const [name, handler] of Object.entries(handlers)) {
      const testID = {
        onChangePin: 'settings_change_pin',
        onAutoLock: 'settings_auto_lock',
        onSecurity: 'settings_security',
        onWipePin: 'settings_wipe_pin',
        onCloudBackup: 'settings_cloud_backup',
        onSupport: 'settings_support',
        onAbout: 'settings_about',
      }[name];
      if (testID === undefined) throw new Error(`no testID for ${name}`);
      await fireEvent.press(screen.getByTestId(testID));
      expect(handler).toHaveBeenCalledTimes(1);
    }
  });
});

/**
 * The wipe-PIN row is the only place the armed scope is visible without opening anything, so what
 * it prints has to come from the record. An owner who cannot see that their phone carries a PIN
 * which deletes their cloud backup has no way to discover it before it fires.
 */
describe('SettingsScreen wipe PIN row', () => {
  const handlers = {
    onChangePin: jest.fn(),
    onAutoLock: jest.fn(),
    onSecurity: jest.fn(),
    onWipePin: jest.fn(),
    onCloudBackup: jest.fn(),
    onSupport: jest.fn(),
    onAbout: jest.fn(),
  };

  it.each([
    ['device', 'This device'],
    ['backup', 'Cloud backup'],
    ['both', 'Both'],
  ] as const)('reports a stored %s scope as "%s"', async (scope, label) => {
    const harness = buildHarness();
    (await harness.services.auth.setupPin('12142907')).dispose();
    await harness.services.auth.setWipePin('55531', scope);

    await renderWithServices(harness.services, <SettingsScreen {...handlers} />);

    await waitFor(() => {
      expect(screen.getByTestId('settings_wipe_pin')).toHaveTextContent(
        new RegExp(`Wipe PIN active: ${label}\\.`),
      );
    });
  });

  it('says it is not set rather than naming a scope nobody chose', async () => {
    const harness = buildHarness();
    await renderWithServices(harness.services, <SettingsScreen {...handlers} />);

    await waitFor(() => {
      expect(screen.getByTestId('settings_wipe_pin')).toHaveTextContent(/Not set/);
    });
    expect(screen.getByTestId('settings_wipe_pin')).not.toHaveTextContent(/active/);
  });
});

describe('SettingsScreen super secure', () => {
  const handlers = {
    onChangePin: jest.fn(),
    onAutoLock: jest.fn(),
    onSecurity: jest.fn(),
    onWipePin: jest.fn(),
    onCloudBackup: jest.fn(),
    onSupport: jest.fn(),
    onAbout: jest.fn(),
  };

  it('is off to begin with and persists being turned on', async () => {
    const harness = buildHarness();
    await renderWithServices(harness.services, <SettingsScreen {...handlers} />);

    const toggle = screen.getByTestId('settings_super_secure');
    expect(toggle.props.value).toBe(false);

    await fireEvent(toggle, 'valueChange', true);

    await waitFor(async () => {
      expect(await harness.settingsStore.load()).toMatchObject({ superSecure: true });
    });
    expect(harness.services.settings.current.superSecure).toBe(true);
  });
});

describe('SettingsScreen night mode', () => {
  const handlers = {
    onChangePin: jest.fn(),
    onAutoLock: jest.fn(),
    onSecurity: jest.fn(),
    onWipePin: jest.fn(),
    onCloudBackup: jest.fn(),
    onSupport: jest.fn(),
    onAbout: jest.fn(),
  };

  const background = (): unknown =>
    StyleSheet.flatten(screen.getByTestId('settings_screen').props.style).backgroundColor;

  it('starts on night and repaints the screen when turned off', async () => {
    const harness = buildHarness();
    await renderWithServices(harness.services, <SettingsScreen {...handlers} />);

    expect(screen.getByTestId('settings_night_mode').props.value).toBe(true);
    expect(background()).toBe(DARK_PALETTE.background);

    await fireEvent(screen.getByTestId('settings_night_mode'), 'valueChange', false);

    await waitFor(() => {
      expect(background()).toBe(LIGHT_PALETTE.background);
    });
    expect(await harness.settingsStore.load()).toMatchObject({ theme: 'day' });
  });

  it('comes back up in day mode once that is what was stored', async () => {
    const harness = buildHarness();
    await harness.services.settings.update({ theme: 'day' });
    await renderWithServices(harness.services, <SettingsScreen {...handlers} />);

    expect(screen.getByTestId('settings_night_mode').props.value).toBe(false);
    expect(background()).toBe(LIGHT_PALETTE.background);
  });
});

describe('AutoLockScreen', () => {
  it('persists the chosen timeout through the settings controller', async () => {
    const harness = buildHarness();
    await renderWithServices(harness.services, <AutoLockScreen />);

    expect(screen.getByTestId('autolock_oneMinute_selected')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('autolock_fifteenMinutes'));

    await waitFor(async () => {
      expect(await harness.settingsStore.load()).toMatchObject({
        autoLockTimeout: 'fifteenMinutes',
      });
    });
    expect(harness.services.settings.current.autoLockTimeout).toBe('fifteenMinutes');
    expect(screen.getByTestId('autolock_fifteenMinutes_selected')).toBeTruthy();
    expect(screen.queryByTestId('autolock_oneMinute_selected')).toBeNull();
  });
});

describe('SecurityScreen', () => {
  it('starts from the documented defaults', async () => {
    const harness = buildHarness();
    await renderWithServices(harness.services, <SecurityScreen />);

    expect(DEFAULT_SETTINGS.crashReportsEnabled).toBe(true);
    expect(DEFAULT_SETTINGS.analyticsEnabled).toBe(false);
    expect(screen.getByTestId('security_crash_reports').props.value).toBe(true);
    expect(screen.getByTestId('security_analytics').props.value).toBe(false);
    expect(screen.getByTestId('security_screen_protection').props.value).toBe(true);
  });

  it('persists every toggle and tells the platform services about it', async () => {
    const harness = buildHarness({ firebaseAvailable: true });
    const crashSpy = jest.spyOn(harness.crash, 'setEnabled');
    const analyticsSpy = jest.spyOn(harness.analytics, 'setEnabled');
    await renderWithServices(harness.services, <SecurityScreen />);

    await fireEvent(screen.getByTestId('security_screen_protection'), 'valueChange', false);
    await fireEvent(screen.getByTestId('security_crash_reports'), 'valueChange', false);
    await fireEvent(screen.getByTestId('security_analytics'), 'valueChange', true);

    await waitFor(async () => {
      expect(await harness.settingsStore.load()).toMatchObject({
        screenProtection: false,
        crashReportsEnabled: false,
        analyticsEnabled: true,
      });
    });

    expect(harness.screenProtection.calls).toContain(false);
    expect(crashSpy).toHaveBeenCalledWith(false);
    expect(analyticsSpy).toHaveBeenCalledWith(true);
  });

  it('explains what screen protection does and that iOS support is limited', async () => {
    const harness = buildHarness();
    await renderWithServices(harness.services, <SecurityScreen />);

    const row = screen.getByTestId('security_screen_protection');
    expect(row).toBeTruthy();
    expect(screen.getByText(/Blocks screenshots/)).toHaveTextContent(/app-switcher preview/);
    expect(screen.getByText(/Blocks screenshots/)).toHaveTextContent(/privacy curtain/);
    expect(screen.getByTestId('security_encryption_summary')).toHaveTextContent(/Argon2id/);
  });
});

describe('AboutScreen', () => {
  it('states the version and that nothing leaves the device without cloud backup', async () => {
    const harness = buildHarness();
    await renderWithServices(harness.services, <AboutScreen appName="SilentSum" version="9.9.9" />);

    expect(screen.getByTestId('about_app_name')).toHaveTextContent(/SilentSum/);
    expect(screen.getByTestId('about_version')).toHaveTextContent(/9\.9\.9/);
    expect(screen.getByTestId('about_data_statement')).toHaveTextContent(
      /No vault data leaves this device unless you explicitly switch on cloud backup/,
    );
    expect(screen.getByTestId('about_security_summary')).toHaveTextContent(/no reset, no backdoor/);
  });

  /**
   * About is the only thing the calculator's menu offers while super secure is on, so it is where
   * customer service has to live. What it must offer is an address -- never a way in.
   */
  it('names the configured support address without offering any way into the vault', async () => {
    const harness = buildHarness({ support: { send: async () => SENT, contact: 'help@example.com' } });

    await renderWithServices(harness.services, <AboutScreen />);

    expect(screen.getByTestId('about_customer_service')).toBeTruthy();
    expect(screen.getByTestId('about_support_contact')).toHaveTextContent(/help@example\.com/);
    // And it says, in the same breath, what writing to that address cannot achieve.
    expect(screen.getByTestId('about_support_limits')).toHaveTextContent(/cannot do/);
    expect(screen.getByTestId('about_support_limits')).toHaveTextContent(/reset or look up your PIN/);
    expect(screen.getByTestId('about_support_limits')).toHaveTextContent(/decrypt a backup/);
    // Writing a message is the only thing it collects; nothing here leads into the vault.
    expect(screen.queryByTestId('forgot_pin_dialog')).toBeNull();
    expect(screen.queryByTestId('support_topic_unlock')).toBeNull();
  });

  it('sends what was typed, with no topic and no app details attached', async () => {
    const support = fakeSupport();
    const harness = buildHarness({
      support: { send: support.service.send, contact: 'help@example.com' },
    });

    await renderWithServices(harness.services, <AboutScreen />);

    await fireEvent.changeText(screen.getByTestId('about_support_reply_to'), ' me@example.com ');
    await fireEvent.changeText(screen.getByTestId('about_support_body'), '  the app will not open  ');
    await fireEvent.press(screen.getByTestId('about_support_send'));

    await waitFor(() => {
      expect(support.sent).toHaveLength(1);
    });
    expect(support.sent[0]).toEqual({
      // Neutral: the subject line must not name what this app actually does.
      topic: 'other',
      body: 'the app will not open',
      replyTo: 'me@example.com',
      // The block the full support screen offers would say whether cloud backup is on.
      diagnostics: null,
    });

    // The draft does not outlive the send, and the user is told where a reply will go.
    expect(screen.getByTestId('about_support_sent')).toHaveTextContent(/me@example\.com/);
    expect(screen.queryByTestId('about_support_body')).toBeNull();
  });

  it('will not send an empty message or an address nobody could reply to', async () => {
    const support = fakeSupport();
    const harness = buildHarness({
      support: { send: support.service.send, contact: 'help@example.com' },
    });

    await renderWithServices(harness.services, <AboutScreen />);

    // Nothing typed at all.
    await fireEvent.press(screen.getByTestId('about_support_send'));
    expect(support.sent).toEqual([]);

    // Something typed, but the reply address is not one.
    await fireEvent.changeText(screen.getByTestId('about_support_body'), 'hello');
    await fireEvent.changeText(screen.getByTestId('about_support_reply_to'), 'not an address');
    await fireEvent.press(screen.getByTestId('about_support_send'));

    expect(support.sent).toEqual([]);
    expect(screen.getByText(/does not look like an email address/)).toBeTruthy();
  });

  /**
   * Super secure makes this the only page the calculator's menu opens, so it has to read like a
   * calculator's About page: a name, a version, and a way to write to somebody.
   */
  it('says nothing whatsoever about a vault while disguised', async () => {
    const harness = buildHarness({
      support: { send: async () => SENT, contact: 'help@example.com' },
    });

    await renderWithServices(
      harness.services,
      <AboutScreen appName="Calculator" disguised />,
    );

    const rendered = JSON.stringify(screen.toJSON());
    for (const word of [
      /vault/i,
      /\bpin\b/i,
      /passphrase/i,
      /backup/i,
      /photo/i,
      /encrypt/i,
      // The warnings the honest page carries are themselves a tell: a calculator has no
      // reason to mention passwords, codes, or stripping digits out of what you send it.
      /password/i,
      /\bcodes?\b/i,
      /digits are removed/i,
    ]) {
      expect(rendered).not.toMatch(word);
    }
    expect(screen.queryByTestId('about_security_summary')).toBeNull();
    expect(screen.queryByTestId('about_data_statement')).toBeNull();
    expect(screen.queryByTestId('about_support_limits')).toBeNull();
    expect(screen.queryByTestId('about_support_recovery')).toBeNull();

    // What remains is a calculator's About page, and a way to reach a person from it.
    expect(screen.getByTestId('about_app_name')).toHaveTextContent(/Calculator/);
    expect(screen.getByTestId('about_support_contact')).toHaveTextContent(/help@example\.com/);
    expect(screen.getByTestId('about_support_reply_to')).toBeTruthy();
    expect(screen.getByTestId('about_support_body')).toBeTruthy();
    expect(screen.getByTestId('about_support_send')).toBeTruthy();
  });

  it('still sends from the disguised page', async () => {
    const support = fakeSupport();
    const harness = buildHarness({
      support: { send: support.service.send, contact: 'help@example.com' },
    });

    await renderWithServices(harness.services, <AboutScreen appName="Calculator" disguised />);

    await fireEvent.changeText(screen.getByTestId('about_support_reply_to'), 'me@example.com');
    await fireEvent.changeText(screen.getByTestId('about_support_body'), 'please help');
    await fireEvent.press(screen.getByTestId('about_support_send'));

    await waitFor(() => {
      expect(support.sent).toHaveLength(1);
    });
    expect(support.sent[0]?.replyTo).toBe('me@example.com');
  });

  it('says so plainly when the build has no support address', async () => {
    const harness = buildHarness({ support: null });

    await renderWithServices(harness.services, <AboutScreen />);

    expect(screen.getByTestId('about_support_contact')).toHaveTextContent(/no support address/);
  });

  it('points a backup user at the account AND the passphrase, never one alone', async () => {
    const harness = buildHarness({
      firebase: {
        available: true,
        crash: new NoopCrashReporter(),
        analytics: new NoopAnalyticsService(),
        cloud: new InMemoryCloudBackend(),
      },
    });

    await renderWithServices(harness.services, <AboutScreen />);

    const recovery = screen.getByTestId('about_support_recovery');
    expect(recovery).toHaveTextContent(/backup account sign-in/);
    expect(recovery).toHaveTextContent(/recovery passphrase/);
    expect(recovery).toHaveTextContent(/account password on its own .* cannot decrypt/);
  });
});

describe('SupportScreen', () => {

  it('says plainly that this build cannot send, instead of offering a form that goes nowhere', async () => {
    const harness = buildHarness({ support: null });

    await renderWithServices(harness.services, <SupportScreen />);

    expect(screen.getByTestId('support_unavailable')).toBeTruthy();
    expect(screen.queryByTestId('support_send')).toBeNull();
  });

  it('sends exactly what is on the screen, and nothing else', async () => {
    const support = fakeSupport();
    const harness = buildHarness({ support: support.service });

    await renderWithServices(harness.services, <SupportScreen />);
    await fireEvent.press(screen.getByTestId('support_topic_backup'));
    await fireEvent.changeText(screen.getByTestId('support_body'), '  Restore never finishes.  ');
    await fireEvent.changeText(screen.getByTestId('support_reply_to'), 'me@example.com');
    await fireEvent.press(screen.getByTestId('support_send'));

    await waitFor(() => {
      expect(screen.getByTestId('support_sent')).toBeTruthy();
    });
    expect(support.sent).toEqual([
      {
        topic: 'backup',
        body: 'Restore never finishes.',
        replyTo: 'me@example.com',
        diagnostics: expect.stringContaining('App version:') as unknown as string,
      },
    ]);
    expect(screen.getByTestId('support_reference')).toHaveTextContent(/em_3f1e/);
  });

  it('attaches no app details once the user turns them off', async () => {
    const support = fakeSupport();
    const harness = buildHarness({ support: support.service });

    await renderWithServices(harness.services, <SupportScreen />);
    expect(screen.getByTestId('support_diagnostics_preview')).toBeTruthy();
    await fireEvent(screen.getByTestId('support_include_diagnostics'), 'valueChange', false);
    await fireEvent.changeText(screen.getByTestId('support_body'), 'No details please.');
    await fireEvent.press(screen.getByTestId('support_send'));

    await waitFor(() => {
      expect(support.sent).toHaveLength(1);
    });
    expect(support.sent[0]?.diagnostics).toBeNull();
    expect(screen.queryByTestId('support_diagnostics_preview')).toBeNull();
  });

  it('refuses to send with an address nobody could reply to', async () => {
    const support = fakeSupport();
    const harness = buildHarness({ support: support.service });

    await renderWithServices(harness.services, <SupportScreen />);
    await fireEvent.changeText(screen.getByTestId('support_body'), 'Something is wrong.');
    await fireEvent.changeText(screen.getByTestId('support_reply_to'), 'me@example');
    await fireEvent.press(screen.getByTestId('support_send'));

    expect(screen.getByText('That does not look like an email address.')).toBeTruthy();
    expect(support.sent).toHaveLength(0);
  });

  it('sends nothing at all until the user has written something', async () => {
    const support = fakeSupport();
    const harness = buildHarness({ support: support.service });

    await renderWithServices(harness.services, <SupportScreen />);
    await fireEvent.press(screen.getByTestId('support_send'));

    expect(support.sent).toHaveLength(0);
  });

  it('keeps the message on screen when it could not be delivered', async () => {
    const support = fakeSupport();
    support.answer({ kind: 'failed', reason: 'unreachable' });
    const harness = buildHarness({ support: support.service });

    await renderWithServices(harness.services, <SupportScreen />);
    await fireEvent.changeText(screen.getByTestId('support_body'), 'Still broken.');
    await fireEvent.press(screen.getByTestId('support_send'));

    await waitFor(() => {
      expect(screen.getByTestId('support_error')).toHaveTextContent(/Could not reach/);
    });
    expect(screen.getByTestId('support_body').props.value).toBe('Still broken.');
    expect(screen.queryByTestId('support_sent')).toBeNull();
  });

  it('does not invite a retry that could never work', async () => {
    const support = fakeSupport();
    support.answer({ kind: 'failed', reason: 'configuration' });
    const harness = buildHarness({ support: support.service });

    await renderWithServices(harness.services, <SupportScreen />);
    await fireEvent.changeText(screen.getByTestId('support_body'), 'Hello.');
    await fireEvent.press(screen.getByTestId('support_send'));

    await waitFor(() => {
      expect(screen.getByTestId('support_error')).toHaveTextContent(/will not help/);
    });
  });
});
/**
 * The wipe PIN's settings screen, and above all the distinction it exists to keep: what is ARMED
 * versus what the picker has SELECTED.
 *
 * Those were one value once. The picker defaulted to `device`, so a tick sat beside "This device"
 * whether or not anything was armed and whatever the record actually said. An owner read that tick
 * as a report, armed `both` without meaning to, and the wipe deleted their cloud backup along with
 * the phone. Every assertion below about an absent tick or an "active" line is guarding against
 * that specific reading, so none of them is incidental.
 */
describe('WipePinScreen', () => {
  const VAULT_PIN = '12142907';
  const WIPE_PIN = '55531';

  /** The screen only makes sense against a real vault PIN, which is what it checks against. */
  async function withVault() {
    const harness = buildHarness();
    (await harness.services.auth.setupPin(VAULT_PIN)).dispose();
    return harness;
  }

  /** Picks a scope the way a user has to: tap the row, then answer the dialog it raises. */
  async function chooseScope(scope: 'device' | 'backup' | 'both'): Promise<void> {
    await fireEvent.press(screen.getByTestId(`wipe_scope_${scope}`));
    await waitFor(() => {
      expect(screen.getByTestId('wipe_scope_dialog')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('wipe_scope_dialog-confirm'));
  }

  /** No scope row is ticked. A tick can only ever mean "the user chose this, just now". */
  function expectNothingTicked(): void {
    for (const option of ['device', 'backup', 'both']) {
      expect(screen.queryByTestId(`wipe_scope_${option}_selected`)).toBeNull();
    }
  }

  it.each([
    ['device', 'This device'],
    ['backup', 'Cloud backup'],
    ['both', 'Both'],
  ] as const)('shows a stored %s scope as "%s"', async (scope, label) => {
    const harness = await withVault();
    await harness.services.auth.setWipePin(WIPE_PIN, scope);
    await renderWithServices(harness.services, <WipePinScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('wipe_pin_active_scope')).toHaveTextContent(
        new RegExp(`^Wipe PIN active: ${label}$`),
      );
    });
    expect(screen.getByTestId('wipe_pin_status')).toHaveTextContent(/A wipe PIN is set/);
  });

  it('never presents the picker default as the armed scope', async () => {
    const harness = await withVault();
    // `both` is armed while `device` is what the picker used to default to -- the exact pairing
    // that produced the incident.
    await harness.services.auth.setWipePin(WIPE_PIN, 'both');
    await renderWithServices(harness.services, <WipePinScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('wipe_pin_active_scope')).toHaveTextContent(
        /^Wipe PIN active: Both$/,
      );
    });

    // Nothing is ticked -- not the old default, and not the armed scope either. The armed scope is
    // reported in words, above; the list below is only ever a choice the user has yet to make.
    expectNothingTicked();
    expect(screen.getByTestId('wipe_pin_draft_scope')).toHaveTextContent(/Nothing chosen yet/);
  });

  it('claims nothing is armed only when nothing is', async () => {
    const harness = await withVault();
    await renderWithServices(harness.services, <WipePinScreen />);

    expect(screen.getByTestId('wipe_pin_status')).toHaveTextContent(/No wipe PIN is set/);
    // The "active" line is absent rather than showing a default, which is the whole point: there
    // is no scope to report, so the screen reports none.
    expect(screen.queryByTestId('wipe_pin_active_scope')).toBeNull();
    expectNothingTicked();
  });

  it('requires an explicit confirmation before the selected scope changes', async () => {
    const harness = await withVault();
    await renderWithServices(harness.services, <WipePinScreen />);

    await fireEvent.press(screen.getByTestId('wipe_scope_both'));

    // Tapping proposes; it does not select.
    await waitFor(() => {
      expect(screen.getByTestId('wipe_scope_dialog')).toHaveTextContent(/PERMANENT/);
    });
    expectNothingTicked();
    expect(screen.getByTestId('wipe_pin_draft_scope')).toHaveTextContent(/Nothing chosen yet/);

    await fireEvent.press(screen.getByTestId('wipe_scope_dialog-cancel'));

    // Declining leaves the selection exactly where it was, which for a stray tap is nowhere.
    await waitFor(() => {
      expect(screen.queryByTestId('wipe_scope_dialog')).toBeNull();
    });
    expectNothingTicked();

    await chooseScope('both');
    expect(screen.getByTestId('wipe_scope_both_selected')).toBeTruthy();
    expect(screen.getByTestId('wipe_pin_draft_scope')).toHaveTextContent(
      /The new wipe PIN will destroy: Both/,
    );
  });

  it('refuses to arm anything until a scope has been chosen', async () => {
    const harness = await withVault();
    await renderWithServices(harness.services, <WipePinScreen />);

    await fireEvent.changeText(screen.getByTestId('wipe_pin_input'), WIPE_PIN);
    await fireEvent.changeText(screen.getByTestId('wipe_pin_confirm_input'), WIPE_PIN);
    await fireEvent.press(screen.getByTestId('wipe_pin_save'));

    // No silent default -- least of all to `both`.
    await waitFor(() => {
      expect(screen.getByTestId('wipe_pin_error')).toHaveTextContent(/Choose what this wipe PIN/);
    });
    expect(screen.queryByTestId('wipe_pin_arm_dialog')).toBeNull();
    expect(await harness.services.auth.wipePin()).toBeNull();
  });

  it.each([
    ['device', 'Scope: This device', false],
    ['backup', 'Scope: Cloud backup', true],
    ['both', 'Scope: Both', true],
  ] as const)('names %s in the final confirmation', async (scope, heading, warnsAboutCloud) => {
    const harness = await withVault();
    await renderWithServices(harness.services, <WipePinScreen />);

    await chooseScope(scope);
    await fireEvent.changeText(screen.getByTestId('wipe_pin_input'), WIPE_PIN);
    await fireEvent.changeText(screen.getByTestId('wipe_pin_confirm_input'), WIPE_PIN);
    await fireEvent.press(screen.getByTestId('wipe_pin_save'));

    const dialog = await waitFor(() => screen.getByTestId('wipe_pin_arm_dialog'));
    expect(dialog).toHaveTextContent(new RegExp(heading));
    // A cloud scope has to spell out that the key goes with the blobs. "Deletes the cloud backup"
    // is true and still leaves people thinking their passphrase can undo it.
    if (warnsAboutCloud) expect(dialog).toHaveTextContent(/PERMANENT/);
    else expect(dialog).not.toHaveTextContent(/PERMANENT/);
  });

  it('refuses a PIN that overlaps the vault PIN, before offering to arm anything', async () => {
    const harness = await withVault();
    await renderWithServices(harness.services, <WipePinScreen />);

    expect(screen.getByTestId('wipe_pin_status')).toHaveTextContent(/No wipe PIN is set/);

    await chooseScope('device');
    // "1214" is a run the user calculates on their way into the vault.
    await fireEvent.changeText(screen.getByTestId('wipe_pin_input'), '1214');
    await fireEvent.changeText(screen.getByTestId('wipe_pin_confirm_input'), '1214');
    await fireEvent.press(screen.getByTestId('wipe_pin_save'));

    await waitFor(() => {
      expect(screen.getByTestId('wipe_pin_error')).toHaveTextContent(/overlaps your vault PIN/);
    });
    expect(screen.queryByTestId('wipe_pin_arm_dialog')).toBeNull();
    expect(await harness.services.auth.wipePin()).toBeNull();
  });

  it('arms nothing until the confirmation is answered', async () => {
    const harness = await withVault();
    await renderWithServices(harness.services, <WipePinScreen />);

    await chooseScope('both');
    await fireEvent.changeText(screen.getByTestId('wipe_pin_input'), WIPE_PIN);
    await fireEvent.changeText(screen.getByTestId('wipe_pin_confirm_input'), WIPE_PIN);
    await fireEvent.press(screen.getByTestId('wipe_pin_save'));

    await waitFor(() => {
      expect(screen.getByTestId('wipe_pin_arm_dialog')).toHaveTextContent(
        /not a number you would ever calculate by accident/,
      );
    });
    expect(await harness.services.auth.wipePin()).toBeNull();

    await fireEvent.press(screen.getByTestId('wipe_pin_arm_dialog-confirm'));

    await waitFor(async () => {
      expect(await harness.services.auth.wipePin()).toMatchObject({
        pin: WIPE_PIN,
        scope: 'both',
      });
    });

    // What it now reports is what it stored, and the picker has gone back to holding no opinion.
    expect(screen.getByTestId('wipe_pin_active_scope')).toHaveTextContent(
      /^Wipe PIN active: Both$/,
    );
    expect(screen.getByTestId('wipe_pin_notice')).toHaveTextContent(/It destroys: Both\./);
    expectNothingTicked();
  });

  it('rejects a mismatched confirmation and turns an armed PIN off again', async () => {
    const harness = await withVault();
    await harness.services.auth.setWipePin(WIPE_PIN, 'device');
    await renderWithServices(harness.services, <WipePinScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('wipe_pin_active_scope')).toHaveTextContent(
        /^Wipe PIN active: This device$/,
      );
    });

    await chooseScope('device');
    await fireEvent.changeText(screen.getByTestId('wipe_pin_input'), '4826');
    await fireEvent.changeText(screen.getByTestId('wipe_pin_confirm_input'), '4827');
    await fireEvent.press(screen.getByTestId('wipe_pin_save'));
    expect(screen.getByTestId('wipe_pin_error')).toHaveTextContent(/do not match/);
    expect(await harness.services.auth.wipePin()).toMatchObject({ pin: WIPE_PIN });

    await fireEvent.press(screen.getByTestId('wipe_pin_clear'));

    await waitFor(async () => {
      expect(await harness.services.auth.wipePin()).toBeNull();
    });
    expect(screen.getByTestId('wipe_pin_status')).toHaveTextContent(/No wipe PIN is set/);
    expect(screen.queryByTestId('wipe_pin_active_scope')).toBeNull();
  });
});
