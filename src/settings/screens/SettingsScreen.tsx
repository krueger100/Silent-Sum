/**
 * The vault's settings index.
 *
 * Every row here is a preference or a navigation target; nothing on this screen can weaken the
 * crypto. The cloud-backup row states its current state in words, because "off" is the default and
 * the user should be able to confirm at a glance that nothing is leaving the device.
 *
 * The wipe-PIN row does the same for the same reason, but it matters more: it is the only place
 * the armed scope appears without opening anything, and it prints the scope read from the stored
 * record -- never a guess, never a default. An owner should be able to see that their own phone is
 * carrying a PIN that deletes their cloud backup without having to go and look for it.
 */
import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useServices, useSettings } from '@/app/ServicesProvider';
import { spacing } from '@/app/theme';
import type { WipeScope } from '@/auth/types';
import { WIPE_SCOPE_LABEL } from '@/auth/wipePin';
import { Button } from '@/components/Button';
import { ListRow, SwitchRow } from '@/components/ListRow';
import { Screen, SectionLabel } from '@/components/Screen';
import { AUTO_LOCK_LABEL } from '@/settings/appSettings';

export interface SettingsScreenProps {
  onChangePin: () => void;
  onAutoLock: () => void;
  onSecurity: () => void;
  onWipePin: () => void;
  onCloudBackup: () => void;
  onSupport: () => void;
  onAbout: () => void;
  onBack?: () => void;
  /** Optional: renders a "Lock vault now" action when the navigator wants one here. */
  onLocked?: () => void;
  /**
   * Changed by the navigator whenever the wipe-PIN screen closes, so the row below re-reads the
   * record. This screen stays mounted underneath that one, so without it the scope shown here
   * would be whatever was armed when Settings was first opened -- a stale answer to the one
   * question this row exists to answer.
   */
  reloadToken?: number;
}

export function SettingsScreen({
  onChangePin,
  onAutoLock,
  onSecurity,
  onWipePin,
  onCloudBackup,
  onSupport,
  onAbout,
  onBack,
  onLocked,
  reloadToken,
}: SettingsScreenProps): React.JSX.Element {
  const services = useServices();
  const settings = useSettings();
  const cloudAvailable = services.backup !== null && services.firebase.available;

  // Undefined until the record has been read, so the row never claims "not set" before it knows.
  const [wipeScope, setWipeScope] = useState<WipeScope | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const record = await services.auth.wipePin();
      if (!cancelled) setWipeScope(record?.scope ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [services, reloadToken]);

  return (
    <Screen
      title="Settings"
      scroll
      testID="settings_screen"
      {...(onBack === undefined ? {} : { onBack })}
    >
      <SectionLabel>Vault</SectionLabel>
      <ListRow
        testID="settings_change_pin"
        label="Change PIN"
        detail="Re-wraps the vault key under a new PIN. Your photos are not re-encrypted."
        onPress={onChangePin}
      />
      <ListRow
        testID="settings_auto_lock"
        label="Auto-lock"
        detail="How long the vault may stay open in the background."
        value={AUTO_LOCK_LABEL[settings.autoLockTimeout]}
        onPress={onAutoLock}
      />
      <ListRow
        testID="settings_security"
        label="Security and privacy"
        detail="Screenshot blocking, crash reports, usage statistics."
        onPress={onSecurity}
      />

      <SectionLabel>Super secure</SectionLabel>
      <SwitchRow
        testID="settings_super_secure"
        label="Super secure"
        detail={
          'Empties the ⋮ menu down to About, so nothing on the calculator suggests the app is ' +
          'anything else. The menu itself stays -- a calculator has one -- but "Forgot PIN?" is ' +
          'not in it, and your PIN becomes the only way in. It has no effect while there is no ' +
          'vault to hide, or while the vault data cannot be read.'
        }
        value={settings.superSecure}
        onValueChange={(next) => {
          void services.settings.update({ superSecure: next });
        }}
      />
      <ListRow
        testID="settings_wipe_pin"
        label="Wipe PIN"
        detail={
          wipeScope === undefined
            ? 'A second PIN that destroys instead of opening.'
            : wipeScope === null
              ? 'Not set. A second PIN that destroys instead of opening: this device, the cloud ' +
                'backup, or both.'
              : `Wipe PIN active: ${WIPE_SCOPE_LABEL[wipeScope]}. Typed on the calculator it ` +
                'destroys exactly that.'
        }
        value={
          wipeScope === undefined || wipeScope === null ? undefined : WIPE_SCOPE_LABEL[wipeScope]
        }
        destructive
        onPress={onWipePin}
      />

      <SectionLabel>Cloud</SectionLabel>
      <ListRow
        testID="settings_cloud_backup"
        label="Cloud backup"
        detail={
          !cloudAvailable
            ? 'Not available in this build. Everything works offline.'
            : settings.backupEnabled
              ? 'On. Uploads are end-to-end encrypted with your recovery passphrase.'
              : 'Off. Nothing leaves this device.'
        }
        onPress={onCloudBackup}
      />

      <SectionLabel>Support</SectionLabel>
      <ListRow
        testID="settings_support"
        label="Customer service"
        detail={
          services.support === null
            ? 'Not set up in this build. Nothing on that screen could reach anyone.'
            : 'Write to us. You see the whole message before it is sent, and nothing else goes with it.'
        }
        onPress={onSupport}
      />

      <SectionLabel>App</SectionLabel>
      <SwitchRow
        testID="settings_night_mode"
        label="Night mode"
        detail="Dark screen. Turn it off for a light one."
        value={settings.theme === 'night'}
        onValueChange={(night) => {
          void services.settings.update({ theme: night ? 'night' : 'day' });
        }}
      />
      <ListRow
        testID="settings_about"
        label="About"
        detail="Version and what the encryption actually does."
        onPress={onAbout}
      />

      {onLocked === undefined ? null : (
        <View style={styles.footer}>
          <Button
            testID="settings_lock_now"
            label="Lock vault now"
            variant="secondary"
            onPress={() => {
              services.session.lock();
              onLocked();
            }}
          />
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  footer: { marginTop: spacing.lg },
});
