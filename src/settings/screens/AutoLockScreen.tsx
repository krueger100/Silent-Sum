/**
 * How long the vault may stay open while the app is not in front.
 *
 * This is a convenience dial, not a security boundary: the vault always locks when the process
 * ends, and no setting here can keep keys alive across a restart. "Immediately" is the strict end
 * of the dial, not a special mode.
 */
import React from 'react';
import { StyleSheet, Text } from 'react-native';

import { useServices, useSettings } from '@/app/ServicesProvider';
import { type Palette, typography, useStyles } from '@/app/theme';
import { ListRow } from '@/components/ListRow';
import { Paragraph, Screen } from '@/components/Screen';
import { AUTO_LOCK_LABEL, AUTO_LOCK_TIMEOUTS, type AutoLockTimeout } from '@/settings/appSettings';

export interface AutoLockScreenProps {
  onBack?: () => void;
}

export function AutoLockScreen({ onBack }: AutoLockScreenProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const services = useServices();
  const selected = useSettings().autoLockTimeout;

  const choose = (option: AutoLockTimeout): void => {
    void services.settings.update({ autoLockTimeout: option });
  };

  return (
    <Screen
      title="Auto-lock"
      scroll
      testID="auto_lock_screen"
      {...(onBack === undefined ? {} : { onBack })}
    >
      <Paragraph>
        When the app leaves the foreground, the vault locks after this delay. It always locks when
        the app is closed, whatever you choose here.
      </Paragraph>
      {AUTO_LOCK_TIMEOUTS.map((option) => (
        <ListRow
          key={option}
          testID={`autolock_${option}`}
          label={AUTO_LOCK_LABEL[option]}
          onPress={() => {
            choose(option);
          }}
          trailing={
            option === selected ? (
              <Text testID={`autolock_${option}_selected`} style={styles.tick}>
                {'✓'}
              </Text>
            ) : null
          }
        />
      ))}
    </Screen>
  );
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    tick: { ...typography.title, color: colors.accent },
  });
