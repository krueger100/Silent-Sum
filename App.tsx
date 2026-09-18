/**
 * Production entry point.
 *
 * Builds the real services once, wires optional Firebase, and hands everything to the shell.
 * Firebase initialisation cannot fail the app: `initializeFirebase` never throws and returns an
 * "unavailable" sentinel when the build has no Firebase configuration, in which case crash
 * reporting and analytics are no-ops and cloud backup is simply not offered. The calculator and
 * the offline vault behave identically either way.
 */
import Constants from 'expo-constants';
import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { SilentSumApp } from '@/app/SilentSumApp';
import { createServices, type Services } from '@/app/services';
import { ExpoFileSystem } from '@/storage/expoFileSystem';
import { DARK_PALETTE } from '@/app/theme';
import { initializeFirebase, type SilentSumEnv } from '@/firebase/firebaseGateway';
import { FIREBASE_UNAVAILABLE } from '@/firebase/types';

type Extra = {
  silentsumEnv?: string;
  appCheckDebugToken?: string;
  /** Set by app.config.ts when a Firebase native config file was present at build time. */
  firebaseConfigured?: boolean;
  /** SilentSum's own Storage bucket. Absent means cloud backup is not offered at all. */
  firebaseStorageBucket?: string;
};

function readExtra(): Extra {
  const extra: unknown = Constants.expoConfig?.extra;
  return typeof extra === 'object' && extra !== null ? (extra as Extra) : {};
}

export default function App(): React.JSX.Element {
  const [services, setServices] = useState<Services | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const extra = readExtra();
      const env: SilentSumEnv = extra.silentsumEnv === 'prod' ? 'prod' : 'dev';
      // One file system for the whole app: the cloud backend needs it for restore downloads,
      // and the services graph needs it for the vault itself.
      const fs = new ExpoFileSystem();
      const firebase = await initializeFirebase(env, {
        fs,
        configured: extra.firebaseConfigured === true,
        ...(extra.appCheckDebugToken === undefined
          ? {}
          : { appCheckDebugToken: extra.appCheckDebugToken }),
        ...(typeof extra.firebaseStorageBucket === 'string'
          ? { storageBucket: extra.firebaseStorageBucket }
          : {}),
      });
      if (!cancelled) setServices(createServices({ firebase, fs }));
    })().catch(() => {
      // Belt and braces: even if reading config throws, start with no Firebase at all.
      if (!cancelled) setServices(createServices({ firebase: FIREBASE_UNAVAILABLE }));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Deliberately not falling back to a throwaway services object while Firebase resolves: two
  // service graphs would mean two sessions and two vault controllers, and the discarded one would
  // still hold an open file system handle.
  if (services === null) return <BootSplash />;
  return <SilentSumApp services={services} />;
}

function BootSplash(): React.JSX.Element {
  return <View style={styles.boot} />;
}

const styles = StyleSheet.create({
  boot: { flex: 1, backgroundColor: DARK_PALETTE.background },
});
