/**
 * The circle at the head of a conversation.
 *
 * There are no profile pictures in SilentSum and there will not be: the server holds uids and
 * ciphertext, nothing that could carry a face. So the avatar is derived entirely on this device
 * from the two things the screen already has -- the account id picks the colour, the name picks
 * the letter. That makes it stable for a given person without anything being stored or fetched,
 * and it gives the conversation list the one thing a wall of addresses lacks: something to
 * recognise at a glance.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { radius, typography } from '@/app/theme';

/** Fixed rather than palette-derived: these read against white in both themes. */
const COLOURS = [
  '#1D4ED8',
  '#0F766E',
  '#7C3AED',
  '#B45309',
  '#BE123C',
  '#4338CA',
  '#047857',
  '#9D174D',
] as const;

export interface AvatarProps {
  /** What decides the colour. The peer's account id, so it never changes under them. */
  readonly seed: string;
  /** What decides the letter. */
  readonly name: string;
  readonly size?: number;
  readonly testID?: string;
}

/** The first letter or digit, which for an address is the start of the local part. */
export function avatarInitial(name: string): string {
  const found = /[a-z0-9]/i.exec(name);
  return found === null ? '?' : found[0].toUpperCase();
}

export function avatarColour(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) | 0;
  }
  return COLOURS[Math.abs(hash) % COLOURS.length] ?? COLOURS[0];
}

export function Avatar({ seed, name, size = 44, testID }: AvatarProps): React.JSX.Element {
  return (
    <View
      testID={testID}
      accessible={false}
      style={[
        styles.circle,
        {
          width: size,
          height: size,
          borderRadius: radius.pill,
          backgroundColor: avatarColour(seed),
        },
      ]}
    >
      <Text style={[styles.letter, { fontSize: Math.round(size * 0.42) }]}>
        {avatarInitial(name)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  circle: { alignItems: 'center', justifyContent: 'center' },
  letter: { ...typography.label, color: '#FFFFFF', fontWeight: '600' },
});
