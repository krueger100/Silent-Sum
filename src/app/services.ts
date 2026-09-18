/**
 * Composition root.
 *
 * Every platform-facing capability is constructed here and handed to the rest of the app through
 * interfaces. Screens receive this object from `ServicesProvider` and never import libsodium,
 * expo-secure-store, expo-file-system or Firebase themselves, which is what lets the whole app be
 * booted in tests against in-memory fakes.
 */
import { PinAuthService } from '@/auth/pinAuthService';
import { VaultSession } from '@/auth/vaultSession';
import { BackupService } from '@/backup/backupService';
import { ExpoCaptureInspector, type CaptureInspector } from '@/camera/captureInspector';
import {
  Argon2idKeyDerivation,
  SodiumKeyWrapping,
  SodiumSecureRandom,
  Ssv1FileCipher,
  Ssv2StreamCipher,
  type FileCipher,
  type KdfParams,
  type KeyDerivation,
  type KeyWrapping,
  type SecureRandom,
  type StreamCipher,
} from '@/crypto';
import { FIREBASE_UNAVAILABLE, type FirebaseServices } from '@/firebase/types';
import { AutoLockSuspension } from '@/privacy/autoLockSuspension';
import { ExpoScreenProtection } from '@/privacy/expoScreenProtection';
import type { ScreenProtection } from '@/privacy/types';
import { ExpoSecureStoreAdapter } from '@/secure-storage/expoSecureStore';
import type { SecureStore } from '@/secure-storage/secureStore';
import { DEFAULT_SETTINGS, type AppSettings, type SettingsStore } from '@/settings/appSettings';
import { ResendSupportService } from '@/support/resendSupportService';
import { readSupportConfig } from '@/support/supportConfig';
import type { SupportService } from '@/support/types';
import { FileSettingsStore } from '@/settings/fileSettingsStore';
import { ExpoFileSystem } from '@/storage/expoFileSystem';
import type { FileSystem } from '@/storage/fileSystem';
import { SecureDelete } from '@/storage/secureDelete';
import { PlaybackScratch } from '@/vault/playbackScratch';
import { ExpoThumbnailGenerator } from '@/vault/thumbnailGenerator';
import { ExpoVideoThumbnailGenerator } from '@/vault/videoThumbnailGenerator';
import type { ThumbnailGenerator, VideoThumbnailGenerator } from '@/vault/types';
import { VaultPaths } from '@/vault/vaultPaths';
import { SystemClock, type Clock } from '@/utils/clock';
import { VaultController } from '@/app/vaultController';
import { SettingsController } from '@/app/settingsController';

export interface Services {
  readonly clock: Clock;
  readonly random: SecureRandom;
  readonly kdf: KeyDerivation;
  readonly wrapping: KeyWrapping;
  readonly cipher: FileCipher;
  /** The chunked container. Videos only; photos and the index keep the single-shot one. */
  readonly streamCipher: StreamCipher;
  readonly fs: FileSystem;
  readonly paths: VaultPaths;
  readonly secureDelete: SecureDelete;
  readonly secureStore: SecureStore;
  readonly thumbnails: ThumbnailGenerator;
  readonly videoThumbnails: VideoThumbnailGenerator;
  /** The only place a decrypted video is allowed to exist, and the thing that cleans it up. */
  readonly playbackScratch: PlaybackScratch;
  readonly captureInspector: CaptureInspector;
  readonly screenProtection: ScreenProtection;
  readonly autoLockSuspension: AutoLockSuspension;
  readonly auth: PinAuthService;
  readonly session: VaultSession;
  readonly vault: VaultController;
  readonly settings: SettingsController;
  readonly firebase: FirebaseServices;
  /**
   * Null when this build has no support address, i.e. customer service cannot be offered.
   * Nothing else in the app may use it: it is the one outbound path the user drives by hand.
   */
  readonly support: SupportService | null;
  /** Null when Firebase has no cloud backend, i.e. backup cannot be offered at all. */
  readonly backup: BackupService | null;
}

export interface ServiceOverrides {
  clock?: Clock;
  random?: SecureRandom;
  kdf?: KeyDerivation;
  wrapping?: KeyWrapping;
  cipher?: FileCipher;
  streamCipher?: StreamCipher;
  fs?: FileSystem;
  secureDelete?: SecureDelete;
  secureStore?: SecureStore;
  thumbnails?: ThumbnailGenerator;
  videoThumbnails?: VideoThumbnailGenerator;
  captureInspector?: CaptureInspector;
  screenProtection?: ScreenProtection;
  settingsStore?: SettingsStore;
  initialSettings?: AppSettings;
  firebase?: FirebaseServices;
  /** Pass null to test the "not configured in this build" path explicitly. */
  support?: SupportService | null;
  /** Argon2id cost override. Tests use a deliberately weak preset; production never sets it. */
  kdfParams?: KdfParams;
}

export function createServices(overrides: ServiceOverrides = {}): Services {
  const clock = overrides.clock ?? new SystemClock();
  const random = overrides.random ?? new SodiumSecureRandom();
  const kdf = overrides.kdf ?? new Argon2idKeyDerivation();
  const wrapping = overrides.wrapping ?? new SodiumKeyWrapping();
  const cipher = overrides.cipher ?? new Ssv1FileCipher();
  const fs = overrides.fs ?? new ExpoFileSystem();
  const secureDelete = overrides.secureDelete ?? new SecureDelete(fs);
  const secureStore = overrides.secureStore ?? new ExpoSecureStoreAdapter();
  const thumbnails = overrides.thumbnails ?? new ExpoThumbnailGenerator(secureDelete);
  const videoThumbnails =
    overrides.videoThumbnails ??
    new ExpoVideoThumbnailGenerator(fs, secureDelete, thumbnails);
  const streamCipher = overrides.streamCipher ?? new Ssv2StreamCipher({ fs });
  const captureInspector = overrides.captureInspector ?? new ExpoCaptureInspector(secureDelete);
  const screenProtection = overrides.screenProtection ?? new ExpoScreenProtection();
  // FileSettingsStore reaches expo-file-system directly; it holds no secrets and needs no
  // injection. Tests pass InMemorySettingsStore through `overrides.settingsStore`.
  const settingsStore = overrides.settingsStore ?? new FileSettingsStore();
  const firebase = overrides.firebase ?? FIREBASE_UNAVAILABLE;
  const support = overrides.support === undefined ? defaultSupport() : overrides.support;

  const paths = new VaultPaths(fs.documentDirectory);
  const autoLockSuspension = new AutoLockSuspension();
  const session = new VaultSession(() => clock.monotonicMs());
  const playbackScratch = new PlaybackScratch({ fs, secureDelete, random });

  const auth = new PinAuthService({
    store: secureStore,
    kdf,
    wrapping,
    clock,
    random,
    ...(overrides.kdfParams === undefined ? {} : { kdfParams: overrides.kdfParams }),
  });

  const vault = new VaultController({
    fs,
    paths,
    cipher,
    streamCipher,
    thumbnails,
    videoThumbnails,
    secureDelete,
    clock,
    random,
    session,
    playbackScratch,
  });

  const settings = new SettingsController(
    settingsStore,
    overrides.initialSettings ?? DEFAULT_SETTINGS,
  );

  const backup =
    firebase.cloud === null
      ? null
      : new BackupService({
          backend: firebase.cloud,
          kdf,
          wrapping,
          cipher,
          streamCipher,
          clock,
          random,
          fs,
          secureDelete,
        });

  return {
    clock,
    random,
    kdf,
    wrapping,
    cipher,
    streamCipher,
    fs,
    paths,
    secureDelete,
    secureStore,
    thumbnails,
    videoThumbnails,
    playbackScratch,
    captureInspector,
    screenProtection,
    autoLockSuspension,
    auth,
    session,
    vault,
    settings,
    firebase,
    support,
    backup,
  };
}

/** Built from the Expo config, so a build with no support address simply has none. */
function defaultSupport(): SupportService | null {
  const config = readSupportConfig();
  return config === null ? null : new ResendSupportService(config);
}
