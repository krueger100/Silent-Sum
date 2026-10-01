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
import type { BillingService } from '@/billing/billingService';
import { EntitlementsController } from '@/billing/entitlementsController';
import { ExpoCaptureInspector, type CaptureInspector } from '@/camera/captureInspector';
import type { LaunchImageLibrary } from '@/gallery/importService';
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
import { RelaySupportService } from '@/support/relaySupportService';
import { readSupportConfig } from '@/support/supportConfig';
import { RecoveryAccess } from '@/support/recoveryAccess';
import { readRecoveryPublicKey } from '@/support/recoveryConfig';
import { HiddenMessages } from '@/messaging/hiddenMessages';
import { deriveMessagingIdentity, type MessagingIdentity } from '@/messaging/identity';
import { MessagingService } from '@/messaging/messagingService';
import { SupportChatService } from '@/support/chat/supportChatService';
import type { SupportService } from '@/support/types';
import { FileSettingsStore } from '@/settings/fileSettingsStore';
import { ExpoFileSystem } from '@/storage/expoFileSystem';
import type { FileSystem } from '@/storage/fileSystem';
import { SecureDelete } from '@/storage/secureDelete';
import type { GalleryWriter } from '@/gallery/galleryExport';
import { deviceGalleryWriter } from '@/gallery/mediaLibrary';
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
  /**
   * The device gallery. Only ever written to, never read -- `mediaLibrary.ts` explains why that
   * distinction is what keeps the shipped permission set down to one capped permission.
   */
  readonly galleryWriter: GalleryWriter;
  readonly captureInspector: CaptureInspector;
  readonly screenProtection: ScreenProtection;
  readonly autoLockSuspension: AutoLockSuspension;
  /**
   * The OS photo picker. Overridable for tests; absent means expo-image-picker's own.
   *
   * `ImportService` has always taken this structurally from here; declaring it lets the chat
   * composer open the picker too, with `mediaTypes` of its own -- the vault accepts images only,
   * a message may carry video.
   */
  readonly launchImageLibrary?: LaunchImageLibrary;
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
  /**
   * Support-issued recovery codes. Always present; `available` is false in a build with no
   * public key, which is what the UI checks before offering anything.
   */
  readonly recovery: RecoveryAccess;
  /** Null when Firebase has no cloud backend, i.e. backup cannot be offered at all. */
  readonly backup: BackupService | null;
  /**
   * Purchases. Null when this build cannot sell anything (no cloud backend, or billing switched
   * off), in which case every Pro gate stays open and the plans screen says so.
   */
  readonly billing: BillingService | null;
  /**
   * What the account has paid for: a mirror of the server's entitlement document, plus the
   * cache that keeps Pro working offline. Always present; free and unenforced without billing.
   */
  readonly entitlements: EntitlementsController;
  /**
   * The two-way support conversation over Firestore. Always present; `available` is false when
   * this build has no cloud backend, and sending is gated on an active Cloud term.
   */
  readonly supportChat: SupportChatService;
  /**
   * End-to-end encrypted conversations with other SilentSum accounts. Always present;
   * `available` is false without a cloud backend, and both starting and sending need Pro --
   * which the server, not this object, decides.
   */
  readonly messaging: MessagingService;
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
  /** Pass null for a build that sells nothing; defaults to whatever Firebase offers. */
  billing?: BillingService | null;
  recovery?: RecoveryAccess;
  galleryWriter?: GalleryWriter;
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
    overrides.videoThumbnails ?? new ExpoVideoThumbnailGenerator(fs, secureDelete, thumbnails);
  const streamCipher = overrides.streamCipher ?? new Ssv2StreamCipher({ fs });
  const captureInspector = overrides.captureInspector ?? new ExpoCaptureInspector(secureDelete);
  const screenProtection = overrides.screenProtection ?? new ExpoScreenProtection();
  // FileSettingsStore reaches expo-file-system directly; it holds no secrets and needs no
  // injection. Tests pass InMemorySettingsStore through `overrides.settingsStore`.
  const settingsStore = overrides.settingsStore ?? new FileSettingsStore();
  const firebase = overrides.firebase ?? FIREBASE_UNAVAILABLE;
  const support = overrides.support === undefined ? defaultSupport() : overrides.support;
  const billing = overrides.billing === undefined ? (firebase.billing ?? null) : overrides.billing;

  const paths = new VaultPaths(fs.documentDirectory);
  const autoLockSuspension = new AutoLockSuspension();
  const session = new VaultSession(() => clock.monotonicMs());
  const recovery =
    overrides.recovery ??
    new RecoveryAccess({
      store: secureStore,
      random,
      clock,
      publicKey: readRecoveryPublicKey(),
    });
  // A recovery authorization is for getting BACK IN. The moment a session exists it has done
  // its job, and locking is the app deciding nobody is trusted right now -- both end it.
  session.onLock(() => {
    recovery.clear();
  });
  const playbackScratch = new PlaybackScratch({ fs, secureDelete, random });
  const galleryWriter = overrides.galleryWriter ?? deviceGalleryWriter;

  // Gates are enforced only where Pro can actually be bought AND its document can be read: a
  // build with billing but no cloud backend could sell and never learn that it had.
  const entitlements = new EntitlementsController({
    secureStore,
    clock,
    cloud: firebase.cloud,
    enforced: billing !== null && firebase.cloud !== null,
  });

  const supportChat = new SupportChatService({
    cloud: firebase.cloud,
    entitlements,
    clock,
    random,
  });

  // The messaging identity is derived from the unlocked vault, so it comes and goes with the
  // session: locking takes the only key that can read a conversation with it.
  let messagingIdentity: MessagingIdentity | null = null;
  const messaging = new MessagingService({
    cloud: firebase.cloud,
    directory: firebase.directory ?? null,
    conversationAdmin: firebase.conversationAdmin ?? null,
    entitlements,
    clock,
    random,
    identity: () => messagingIdentity,
    // Device-local, never uploaded: see `@/messaging/hiddenMessages`.
    hidden: new HiddenMessages(secureStore),
    // Chat media shares the vault's own machinery: the same thumbnail generators, the same
    // scratch space that purges on background, the same secure delete. Nothing here is a second
    // implementation of something the vault already does.
    media: {
      fs,
      secureDelete,
      thumbnails,
      videoThumbnails,
      scratch: playbackScratch,
    },
  });
  session.onLock(() => {
    messagingIdentity?.dispose();
    messagingIdentity = null;
    messaging.forgetKeys();
  });
  session.onUnlock(() => {
    messagingIdentity?.dispose();
    try {
      messagingIdentity = deriveMessagingIdentity(session.requireKeys().masterKey);
    } catch {
      // Unlocking must never fail over messaging. Without an identity the screen says the
      // vault is locked, which is the right thing for a session that could not derive one.
      messagingIdentity = null;
    }
    // Deriving the identity is local and free. PUBLISHING it is not: that is a write to the
    // cloud, and unlocking the vault must not put anything there on its own. The key goes up
    // the first time the user actually opens Messages.
  });

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
    galleryWriter,
    captureInspector,
    screenProtection,
    autoLockSuspension,
    auth,
    session,
    vault,
    settings,
    firebase,
    support,
    recovery,
    backup,
    billing,
    entitlements,
    supportChat,
    messaging,
  };
}

/** Built from the Expo config, so a build with no support address simply has none. */
function defaultSupport(): SupportService | null {
  const config = readSupportConfig();
  return config === null ? null : new RelaySupportService(config);
}
