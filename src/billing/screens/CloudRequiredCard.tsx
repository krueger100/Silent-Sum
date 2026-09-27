/**
 * What the cloud screens show in place of their controls when Cloud is not on.
 *
 * It replaces backup and restore, and nothing else: signing in, signing out, deleting the
 * backup and deleting the account all stay available around it, because a lapsed subscription
 * must never leave a user unable to remove their own data.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useEntitlements, useServices } from '@/app/ServicesProvider';
import { radius, spacing, type Palette, typography, useStyles } from '@/app/theme';
import { deriveCloudState } from '@/billing/entitlements';
import { PRODUCTS } from '@/billing/products';
import { formatDay } from '@/billing/screens/formatDay';
import { Button } from '@/components/Button';

export interface CloudRequiredCardProps {
  feature: 'backup' | 'restore';
  onPlans?: () => void;
  testID?: string;
}

export function CloudRequiredCard({
  feature,
  onPlans,
  testID = 'cloud_required',
}: CloudRequiredCardProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const services = useServices();
  const { entitlements } = useEntitlements();
  const state = deriveCloudState(entitlements, services.clock.now());

  return (
    <View style={styles.card} testID={testID}>
      <Text style={styles.title}>{`${PRODUCTS.cloud.name} is required`}</Text>
      <Text style={styles.line}>
        {feature === 'backup'
          ? `Encrypted cloud backup is part of ${PRODUCTS.cloud.name} (${PRODUCTS.cloud.price}). ` +
            'Everything already in your vault, and Pro messaging, keep working without it; ' +
            'backup, restore and adding new items are what pause.'
          : `Restoring from the cloud is part of ${PRODUCTS.cloud.name} (${PRODUCTS.cloud.price}). ` +
            'Subscribe with this same account, then come back here. Nothing in the backup is ' +
            'deleted while you decide.'}
      </Text>
      {state.kind === 'expired' ? (
        <Text style={styles.muted} testID={`${testID}_expired`}>
          {`Your Cloud term ended on ${formatDay(state.on)}.`}
        </Text>
      ) : null}
      {onPlans === undefined ? null : (
        <Button
          testID={`${testID}_plans`}
          label="See plans"
          variant="secondary"
          onPress={onPlans}
        />
      )}
    </View>
  );
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    card: {
      backgroundColor: colors.surface,
      borderRadius: radius.md,
      padding: spacing.md,
      gap: spacing.sm,
    },
    title: { ...typography.label, color: colors.text, fontSize: 16 },
    line: { ...typography.body, color: colors.textMuted, lineHeight: 22 },
    muted: { ...typography.caption, color: colors.textMuted, lineHeight: 17 },
  });
