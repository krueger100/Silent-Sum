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

import { useEntitlements, useServices, useSettings } from '@/app/ServicesProvider';
import { spacing } from '@/app/theme';
import type { WipeScope } from '@/auth/types';
import { WIPE_SCOPE_LABEL } from '@/auth/wipePin';
import { deriveCloudState, type CloudState } from '@/billing/entitlements';
import { PLANS_TITLE, PRODUCTS } from '@/billing/products';
import { formatDay } from '@/billing/screens/formatDay';
import { Button } from '@/components/Button';
import { ListGroup, ListRow, SwitchRow } from '@/components/ListRow';
import { Screen, SectionLabel } from '@/components/Screen';
import { AUTO_LOCK_LABEL } from '@/settings/appSettings';
import { openInBrowser, PRIVACY_POLICY_LABEL, PRIVACY_POLICY_URL } from '@/settings/privacyPolicy';

export interface SettingsScreenProps {
  onChangePin: () => void;
  onAutoLock: () => void;
  onSecurity: () => void;
  onWipePin: () => void;
  /** The list of what THIS account has in the cloud. Absent where there is no cloud at all. */
  onCloudGallery?: () => void;
  onCloudBackup: () => void;
  /** The SilentSum Pro and Cloud page: prices, status, and the way to buy. */
  onPlans: () => void;
  onSupport: () => void;
  /** Opens user-to-user messaging. Absent in a navigator that does not offer it. */
  onMessages?: () => void;
  onAbout: () => void;
  /**
   * Opens a URL in the system browser. Injected for tests, defaulted so the privacy row cannot go
   * missing because a caller forgot a prop: Play requires the link to be in the app.
   */
  openUrl?: (url: string) => Promise<boolean>;
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
  onCloudGallery,
  onPlans,
  onSupport,
  onMessages,
  onAbout,
  openUrl = openInBrowser,
  onBack,
  onLocked,
  reloadToken,
}: SettingsScreenProps): React.JSX.Element {
  const services = useServices();
  const settings = useSettings();
  const { entitlements: owned } = useEntitlements();
  const cloudAvailable = services.backup !== null && services.firebase.available;
  // Selling needs the cloud backend too: entitlements are read through it.
  const billingAvailable = cloudAvailable && services.billing !== null;
  const cloudState = deriveCloudState(owned, services.clock.now());

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
      {/*
        Detail text is kept only where it reports STATE the user cannot otherwise see -- the
        armed wipe scope, whether backup is on, where the plans stand. Rows that merely described
        what the next screen does have lost it: that explanation belongs on the screen it
        describes, and eleven paragraphs here turned an index into a document. Before this the
        Messages row sat at y=3024 on a 3040px screen; the whole list now fits.
      */}
      <SectionLabel>Vault</SectionLabel>
      <ListGroup>
        <ListRow testID="settings_change_pin" label="Change PIN" onPress={onChangePin} />
        <ListRow
          testID="settings_auto_lock"
          label="Auto-lock"
          value={AUTO_LOCK_LABEL[settings.autoLockTimeout]}
          onPress={onAutoLock}
        />
        <ListRow
          testID="settings_security"
          label="Security and privacy"
          detail="Screenshot blocking, crash reports, usage statistics."
          onPress={onSecurity}
        />
      </ListGroup>

      <SectionLabel>Hiding the vault</SectionLabel>
      <ListGroup>
        <SwitchRow
          testID="settings_super_secure"
          label="Super secure"
          detail={
            'Empties the ⋮ menu down to About. "Forgot PIN?" goes with it, so your PIN becomes ' +
            'the only way in.'
          }
          value={settings.superSecure}
          onValueChange={(next) => {
            void services.settings.update({ superSecure: next });
          }}
        />
        {/*
          The one row whose detail is not optional. It is the only place the armed scope appears
          without opening anything, and it prints what was read from the stored record -- never a
          guess. An owner should be able to see that their phone carries a PIN that destroys
          their cloud backup without going to look for it.
        */}
        <ListRow
          testID="settings_wipe_pin"
          label="Wipe PIN"
          detail={
            wipeScope === undefined
              ? 'A second PIN that destroys instead of opening.'
              : wipeScope === null
                ? 'Not set. A second PIN that destroys instead of opening.'
                : `Typed on the calculator, it destroys ${WIPE_SCOPE_LABEL[wipeScope].toLowerCase()}.`
          }
          value={
            wipeScope === undefined || wipeScope === null ? undefined : WIPE_SCOPE_LABEL[wipeScope]
          }
          destructive
          onPress={onWipePin}
        />
      </ListGroup>

      <SectionLabel>Account</SectionLabel>
      <ListGroup>
        <ListRow
          testID="settings_plans"
          label={PLANS_TITLE}
          detail={
            billingAvailable
              ? planDetail(owned.pro, cloudState)
              : 'Not available in this build. Every feature is unlocked.'
          }
          value={billingAvailable ? (owned.pro ? 'Pro' : 'Free') : undefined}
          onPress={onPlans}
        />
        <ListRow
          testID="settings_cloud_backup"
          label="Cloud backup"
          value={!cloudAvailable ? undefined : settings.backupEnabled ? 'On' : 'Off'}
          detail={
            !cloudAvailable
              ? 'Not available in this build. Everything works offline.'
              : settings.backupEnabled
                ? 'End-to-end encrypted with your recovery passphrase.'
                : 'Nothing leaves this device.'
          }
          onPress={onCloudBackup}
        />
        {onCloudGallery === undefined || !cloudAvailable ? null : (
          <ListRow
            testID="settings_cloud_gallery"
            label="Cloud Gallery"
            detail="What this account has in the cloud. Your Local Gallery is unlimited and stays on this device."
            onPress={onCloudGallery}
          />
        )}
        {onMessages === undefined || !services.messaging.available ? null : (
          <ListRow
            testID="settings_messages"
            label="Messages"
            value={owned.pro ? undefined : 'Pro'}
            onPress={onMessages}
          />
        )}
      </ListGroup>

      <SectionLabel>App</SectionLabel>
      <ListGroup>
        <SwitchRow
          testID="settings_night_mode"
          label="Night mode"
          value={settings.theme === 'night'}
          onValueChange={(night) => {
            void services.settings.update({ theme: night ? 'night' : 'day' });
          }}
        />
        <ListRow
          testID="settings_support"
          label="Customer service"
          {...(services.support === null
            ? { detail: 'Not set up in this build. Nothing on that screen could reach anyone.' }
            : {})}
          onPress={onSupport}
        />
        <ListRow testID="settings_about" label="About" onPress={onAbout} />
        <ListRow
          testID="settings_privacy_policy"
          label={PRIVACY_POLICY_LABEL}
          detail="Opens in your browser"
          onPress={() => {
            void openUrl(PRIVACY_POLICY_URL);
          }}
        />
      </ListGroup>

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

/** One line for the row: what Pro is, and where Cloud stands, without ever mixing the two. */
function planDetail(pro: boolean, cloud: CloudState): string {
  const proPart = pro
    ? `${PRODUCTS.pro.name} is yours for good.`
    : `${PRODUCTS.pro.name} is ${PRODUCTS.pro.price}.`;
  const cloudPart =
    cloud.kind === 'active'
      ? `${PRODUCTS.cloud.name} is on until ${formatDay(cloud.until)}.`
      : cloud.kind === 'expired'
        ? `${PRODUCTS.cloud.name} ended on ${formatDay(cloud.on)}.`
        : `${PRODUCTS.cloud.name} (${PRODUCTS.cloud.price}) is not on.`;
  return `${proPart} ${cloudPart}`;
}

const styles = StyleSheet.create({
  footer: { marginTop: spacing.lg },
});
