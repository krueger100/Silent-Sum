/**
 * Ties the encrypted repository's lifetime to the unlocked session.
 *
 * A repository only exists while the vault is open. Locking closes it and wipes its decrypted
 * caches, so there is no object left holding plaintext that a stale screen could still read from.
 * Screens ask for the repository through {@link requireRepository} and get a hard failure, not a
 * silent empty list, if they are somehow still mounted after a lock.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';

import type { VaultSession } from '@/auth/vaultSession';
import type { FileCipher, SecureRandom, StreamCipher, VaultKeys } from '@/crypto/types';
import type { FileSystem } from '@/storage/fileSystem';
import type { SecureDelete } from '@/storage/secureDelete';
import { EncryptedVaultRepository } from '@/vault/encryptedVaultRepository';
import type { PlaybackScratch } from '@/vault/playbackScratch';
import type { VaultPaths } from '@/vault/vaultPaths';
import {
  VaultLockedError,
  type PhotoEntry,
  type ThumbnailGenerator,
  type VaultRepository,
  type VideoThumbnailGenerator,
} from '@/vault/types';
import type { Clock } from '@/utils/clock';

export interface VaultControllerState {
  /** Newest first. Empty while locked. */
  readonly photos: readonly PhotoEntry[];
  readonly isOpen: boolean;
  /** Set when the vault files exist but cannot be decrypted with the session keys. */
  readonly unreadable: boolean;
}

const CLOSED: VaultControllerState = { photos: [], isOpen: false, unreadable: false };

export interface VaultControllerOptions {
  fs: FileSystem;
  paths: VaultPaths;
  cipher: FileCipher;
  streamCipher: StreamCipher;
  thumbnails: ThumbnailGenerator;
  videoThumbnails: VideoThumbnailGenerator;
  secureDelete: SecureDelete;
  clock: Clock;
  random: SecureRandom;
  session: VaultSession;
  playbackScratch: PlaybackScratch;
}

export class VaultController {
  readonly store: StoreApi<VaultControllerState>;

  private repository: VaultRepository | null = null;
  private unwatch: (() => void) | null = null;

  constructor(private readonly options: VaultControllerOptions) {
    this.store = createStore<VaultControllerState>()(() => CLOSED);
    // Locking is the authority: whoever locks the session closes the vault, with no chance for a
    // screen to keep a live repository by forgetting to call close().
    this.options.session.onLock(() => {
      void this.close();
    });
  }

  get current(): VaultRepository | null {
    return this.repository;
  }

  requireRepository(): VaultRepository {
    const repository = this.repository;
    if (repository === null) throw new VaultLockedError();
    return repository;
  }

  /**
   * Opens the vault for an unlocked session. Any failure closes again and rethrows, so a
   * half-opened vault is never observable.
   */
  async open(keys: VaultKeys): Promise<VaultRepository> {
    await this.close();
    // Anything still in the playback directory belongs to a previous session -- including one the
    // app never got to tidy up, because it was killed while a video was on screen.
    await this.options.playbackScratch.purge();
    const repository = new EncryptedVaultRepository({
      fs: this.options.fs,
      paths: this.options.paths,
      keys,
      cipher: this.options.cipher,
      streamCipher: this.options.streamCipher,
      thumbnails: this.options.thumbnails,
      videoThumbnails: this.options.videoThumbnails,
      secureDelete: this.options.secureDelete,
      clock: this.options.clock,
      random: this.options.random,
    });
    try {
      await repository.open();
    } catch (error) {
      await repository.close();
      this.store.setState({ photos: [], isOpen: false, unreadable: true });
      throw error;
    }
    this.repository = repository;
    this.unwatch = repository.watchPhotos((photos) => {
      this.store.setState({ photos, isOpen: true, unreadable: false });
    });
    return repository;
  }

  async close(): Promise<void> {
    this.unwatch?.();
    this.unwatch = null;
    const repository = this.repository;
    this.repository = null;
    // The observable state flips FIRST, before any awaited teardown: a screen still mounted when
    // the vault locks must see an empty, closed vault immediately, not one tick after the caches
    // and the scratch directory have finished being wiped.
    this.store.setState(CLOSED);
    if (repository !== null) await repository.close();
    // Locking wipes decrypted images from memory; a decrypted video lives in a file, so locking
    // has to wipe that too or the strongest plaintext in the app would be the one that survives.
    await this.options.playbackScratch.purge();
  }
}
