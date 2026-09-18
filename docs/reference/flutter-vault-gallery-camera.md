# Flutter reference: vault-gallery-camera

_vault-gallery-camera (SilentSum Flutter reference): PhotoEntry / VaultIndex model, VaultRepository contract, EncryptedVaultRepository, ThumbnailGenerator, DecryptedImageCache, ImportService, GalleryScreen + PhotoTile, PhotoViewerScreen, CameraScreen_

Files read: C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/vault/photo_entry.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/vault/vault_index.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/vault/thumbnail_generator.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/vault/vault_repository.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/vault/decrypted_image_cache.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/vault/encrypted_vault_repository.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/gallery/photo_tile.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/gallery/photo_viewer_screen.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/gallery/import_service.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/gallery/gallery_screen.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/camera/camera_screen.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/test/features/vault/encrypted_vault_repository_test.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/test/features/gallery/gallery_screen_test.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/test/support/test_app.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/docs/security.md, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/docs/architecture.md, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/storage/vault_paths.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/storage/atomic_file.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/security/secure_random.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/security/byte_utils.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/security/vault_keys.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/security/secure_delete.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/security/file_cipher.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/security/key_wrapping.dart (WrongKeyException only), C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/clock.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/app/providers.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/app/router.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/lifecycle/auto_lock_suspension.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/firebase/analytics_service.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/core/firebase/crash_reporter.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/lib/features/authentication/erase_vault_dialog.dart, C:/Users/carlo/AndroidStudioProjects/silentsum_flutter/pubspec.yaml

## Behaviour

# 1. Data model

## 1.1 PhotoSource enum
Three values, serialized by their lower-case name string: `camera`, `import`, `restore`.

## 1.2 PhotoEntry
Immutable metadata for one vault photo. It exists ONLY inside the encrypted index; nothing about a photo is stored in plaintext anywhere.

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| `id` | string | yes | — | 32 lower-case hex chars (16 random bytes, see 3.3). Identity: two entries are equal iff ids are equal (`==` and hashCode use only `id`). |
| `createdAt` | UTC timestamp | yes | — | Set by repository from the injected clock, converted to UTC. |
| `width` | int | yes | — | Source image width in pixels (from thumbnail generator's `sourceWidth`). |
| `height` | int | yes | — | Source image height in pixels. |
| `sizeBytes` | int | yes | — | Byte length of the ORIGINAL (plaintext) image, not the ciphertext. |
| `source` | PhotoSource | yes | — | |
| `mimeType` | string | no | `image/jpeg` | Stored but never used for decoding or display. |
| `originalName` | string or null | no | null | Picker file name for imports; null for camera captures. |

Derived: `aspectRatio = height == 0 ? 1 : width / height` (not serialized, currently unused by UI).

`copyWith` only supports overriding `source` (used by restore).

### JSON (toJson) — key order exactly as written, `originalName` key ALWAYS present (JSON `null` when absent):
```
{"id":"<32hex>","createdAt":"2026-01-01T12:00:00.000Z","width":64,"height":48,"sizeBytes":1234,"source":"camera","mimeType":"image/jpeg","originalName":null}
```
`createdAt` is `DateTime.toUtc().toIso8601String()`: ISO-8601 with a `Z` suffix, ALWAYS 3 fractional digits (milliseconds); if the value has non-zero microseconds Dart emits 6 fractional digits instead (`.000123Z`). A re-implementation must emit 3-digit millis and must PARSE both 3- and 6-digit fractions.

### fromJson (lenient rules)
1. `id`: must be a string (hard failure otherwise).
2. `createdAt`: `DateTime.parse` of the string (accepts ISO-8601 with or without `Z`; a `Z` value stays UTC).
3. `width`, `height`, `sizeBytes`: any JSON number, truncated to int.
4. `source`: match by name; UNKNOWN or missing → `import`.
5. `mimeType`: missing/null → `image/jpeg`.
6. `originalName`: missing/null → null.

## 1.3 VaultIndex
```
{"version":1,"photos":[ <PhotoEntry JSON>, ... ]}
```
1. `version` constant `1`. `VaultIndex.empty` = `{version:1, photos:[]}`.
2. `photos` is ordered NEWEST FIRST. `withPhoto(entry)` PREPENDS (`[entry, ...photos]`). `withoutPhotos(Set<String> ids)` filters, preserving order. `byId(id)` linear scan, null if absent.
3. `encode()` = compact JSON (`jsonEncode`, no whitespace). `decode(raw)` = parse then `fromJson`.
4. `fromJson`: `version` = number → int, missing → 1; if `version != 1` throw `FormatException('Unsupported index version <n>')`. `photos` missing → empty list. Each element parsed by PhotoEntry.fromJson.

# 2. Thumbnails (ThumbnailGenerator)

Constants: `defaultMaxDimension = 512` (longest side, px), `jpegQuality = 82`.

Result object `ThumbnailResult { jpegBytes, thumbWidth, thumbHeight, sourceWidth, sourceHeight }`.

Error: `ImageDecodeException([cause])`, `toString()` = `ImageDecodeException(<cause>)`. Thrown for ANY undecodable input; all other decode-path errors are wrapped into it.

Scaling rule (both implementations):
1. `longest = max(srcW, srcH)`.
2. If `longest <= maxDimension` → no resize (thumb dims == source dims).
3. Else if `srcW >= srcH` → target width = `maxDimension`, height scaled proportionally; else target height = `maxDimension`, width proportional. Engine path: `scale = maxDimension / longest`, `targetWidth = round(srcW*scale)` clamped to `[1, srcW]` (or the same for height).
4. Output is always JPEG (quality 82), regardless of input format — including PNG with alpha (alpha dropped).
5. Test expectations: 1400×900 → 512×(<400, actually 329); 3000×2000 → width 512; 64×48 → unchanged 64×48.

Two implementations:
- `EngineThumbnailGenerator` (production): decode with the platform codec, downscaled DURING decode (never materializes the full bitmap); EXIF orientation applied by the codec; RGBA frame JPEG-encoded in a background worker. `sourceWidth/Height` = the descriptor's reported dimensions. If RGBA extraction fails → `ImageDecodeException('toByteData failed')`. All native handles disposed in `finally`.
- `DartThumbnailGenerator({useIsolate = true})` (tests / no engine): pure decode; decoder returning null → `ImageDecodeException('unsupported format')`; decoder throwing → `ImageDecodeException(e)`; EXIF orientation BAKED before measuring, so `sourceWidth/Height` are post-rotation; resize interpolation `average`.

RN note: source dimensions recorded in PhotoEntry must be the DISPLAY (orientation-corrected) dimensions to match the Dart path; see open questions.

# 3. Storage layout, ids, atomic writes, cipher (as used by this subsystem)

## 3.1 VaultPaths
Root (production) = `<applicationSupportDirectory>/vault` (app-private; never a media dir).
| Path | Purpose |
|---|---|
| `<root>/index.enc` | encrypted VaultIndex JSON |
| `<root>/photos/<id>.enc` | encrypted full-size original bytes (verbatim, not re-encoded) |
| `<root>/thumbs/<id>.enc` | encrypted thumbnail JPEG |
`ensure()` creates `photos/` and `thumbs/` recursively (idempotent). Every file in the tree ends in `.enc` (asserted by tests).

## 3.2 writeFileAtomically(target, bytes)
1. Temp path = `<target path>.<pid>.<processWideCounter>.tmp` (same directory; counter starts at 0 and increments per write).
2. Create parent dir recursively; open write-only; write all bytes; flush (fsync); close.
3. Rename temp over target (replace). Crash leaves either old or new file, never truncated. Tests assert no `*.tmp` files remain in root after concurrent operations.

## 3.3 Photo id
`SecureRandomSource.hexId()` = 16 bytes from the OS CSPRNG → 32 lower-case hex characters (`toRadixString(16).padLeft(2,'0')` per byte). File names reveal nothing.

## 3.4 FileCipher container `SSV1` (needed to write/read blobs)
```
offset 0  4 bytes  magic "SSV1" = 0x53 0x53 0x56 0x31
offset 4  1 byte   version = 1
offset 5  1 byte   keyId code: photo=1, thumb=2, manifest(index)=3
offset 6  24 bytes XChaCha20 nonce (random per blob)
offset 30 ...      ciphertext
tail      16 bytes Poly1305 tag
```
AEAD = XChaCha20-Poly1305 with the 6-byte header as associated data. `overhead = 46`. Subkeys via HKDF-SHA256 (32 bytes) of the master key with info strings `silentsum/photo/v1`, `silentsum/thumb/v1`, `silentsum/index/v1`. `decrypt(blob, key, expectedKeyId)` first parses the header: too short → `FileCipherFormatException('blob too short')`; bad magic → `'bad magic'`; wrong version → `'unsupported version <n>'`; unknown key code → `'unknown key id <n>'`; header keyId ≠ expected → `FileCipherFormatException('blob was encrypted for <name>, not <name>')`. Tag failure → `WrongKeyException` (toString `WrongKeyException`, no detail). `looksEncrypted(bytes)` = length ≥ 46 && magic && version==1. Blobs ≥ 256 KiB are processed off the main thread.

# 4. VaultRepository contract (semantics)

All methods operate with the keys of the live unlocked session; after lock the keys are zeroed and any use throws (fail closed).

| Method | Semantics |
|---|---|
| `photos` (getter) | Current snapshot, newest first, read-only list. |
| `watchPhotos()` | Stream: emits the current list immediately on subscribe, then a full list after every change (add, delete, restore, wipe). |
| `addPhoto(bytes, {source, originalName?, mimeType='image/jpeg'})` | Generate thumbnail, encrypt both, persist, prepend to index, return the new PhotoEntry. Throws `ImageDecodeException` for undecodable bytes (nothing persisted). |
| `readThumbnail(id)` | Decrypted thumbnail JPEG bytes (cached). |
| `readFullImage(id)` | Decrypted original bytes (cached). |
| `deletePhotos(ids)` | Remove from index, securely delete both files, drop caches. |
| `wipeAll()` | Securely delete every vault file, empty index, emit. |
| `readEncryptedPhoto(id)` / `readEncryptedThumbnail(id)` | Raw ciphertext blobs (for backup upload). |
| `readEncryptedIndex()` | Raw index ciphertext or null if no index file. |
| `importEncrypted({entry, photoBlob, thumbnailBlob})` | Restore from backup ciphertext already encrypted with THIS vault's keys; authenticates first; overwrites same-id entry; entry stored with `source=restore`. |
| `close()` | Zero and clear caches, close the change stream. Idempotent. |

Error type `VaultDataUnreadableException([cause])`, toString `VaultDataUnreadableException(<cause>)`: index exists but cannot be decrypted with session keys (foreign vault data, corruption, reset credentials).

There is NO share/export-to-OS function anywhere in this subsystem. "Export" exists only as ciphertext access for the cloud-backup feature.

# 5. EncryptedVaultRepository behaviour

Constructor deps: `paths`, `keys`, `cipher`, `thumbnails`, `secureDelete`, `clock`, optional `random` (default CSPRNG source), optional `thumbnailCache` (default budget `24 * 1024 * 1024` = 25,165,824 bytes), optional `fullImageCache` (default `48 * 1024 * 1024` = 50,331,648 bytes).

Internal state: `_index` (starts empty), `_opened=false`, a broadcast change stream, and a mutation queue.

## 5.1 Mutation serialization
Every read-modify-write of the index (`addPhoto` commit phase, `deletePhotos`, `wipeAll`, `importEncrypted` commit phase) runs through a single FIFO promise chain: each action starts only after the previous one has settled (success OR failure); the action's own result/exception propagates to its caller. Thumbnail generation and encryption in `addPhoto`, and blob authentication in `importEncrypted`, run OUTSIDE the queue (so they overlap across concurrent calls).

## 5.2 open() — must be awaited before any other call
1. `paths.ensure()`.
2. If `index.enc` exists: read bytes → decrypt with the index key expecting keyId manifest → UTF-8 decode → `VaultIndex.decode`. Catch `WrongKeyException`, `FileCipherFormatException`, `FormatException` (covers JSON syntax errors and unsupported index version) → rethrow as `VaultDataUnreadableException(cause)`. Other errors (I/O) propagate unchanged.
3. If no index file: index stays empty (fresh vault).
4. Set `_opened = true`.
Calling `addPhoto`, `readThumbnail`, `readFullImage`, `deletePhotos`, `importEncrypted` before open → `StateError('VaultRepository.open() was not awaited')`. `wipeAll`, `readEncrypted*`, `photos`, `watchPhotos`, `close` do NOT require open.

## 5.3 photos / watchPhotos
`photos` returns an unmodifiable copy of the index list. `watchPhotos()` yields `photos` once, then forwards every emission of the broadcast change stream (each emission is the full current list). Test-verified sequence for add a, add b, delete a: `[]`, `[a]`, `[b, a]`, `[b]`.

## 5.4 addPhoto
1. Ensure open.
2. `thumb = thumbnails.generate(imageBytes)` (maxDimension 512). Undecodable → `ImageDecodeException` propagates; NOTHING has been written.
3. `photoBlob = encrypt(imageBytes, photoKey, keyId photo)`; `thumbBlob = encrypt(thumb.jpegBytes, thumbKey, keyId thumb)`.
4. `id = hexId()` (32 hex). Compute `photoFile = photos/<id>.enc`, `thumbFile = thumbs/<id>.enc`.
5. Inside the serialized queue:
   a. `writeFileAtomically(photoFile, photoBlob)`; b. `writeFileAtomically(thumbFile, thumbBlob)`;
   c. `entry = PhotoEntry(id, createdAt: clock.now().toUtc(), width: thumb.sourceWidth, height: thumb.sourceHeight, sizeBytes: imageBytes.length, source, mimeType, originalName)`;
   d. `_commitIndex(_index.withPhoto(entry))` (prepend);
   e. `thumbCache.put(id, thumb.jpegBytes)` (warm the thumbnail cache; the full-image cache is NOT warmed);
   f. return entry.
   On ANY failure in a–e: `secureDelete.file(photoFile)`, `secureDelete.file(thumbFile)` (no-ops if absent), rethrow.
Note `createdAt` is taken inside the queue, so concurrently-started adds get monotonically ordered timestamps in commit order; ordering in the index is by insertion (prepend), not by sorting.

## 5.5 readThumbnail(id) / readFullImage(id)
1. Ensure open. 2. Cache hit → return the SAME buffer object (moves it to most-recently-used). 3. Miss: read `<dir>/<id>.enc` (missing file → filesystem "not found" error propagates; tests assert `FileSystemException` after delete), decrypt with the matching key/keyId (`WrongKeyException` on tamper, `FileCipherFormatException` on header mismatch), `cache.put(id, bytes)`, return bytes.

## 5.6 deletePhotos(ids)
1. Ensure open. 2. `set = ids.toSet()`; if empty → return WITHOUT emitting. 3. Serialized: `_commitIndex(_index.withoutPhotos(set))` FIRST (index is rewritten and an emission happens even if none of the ids existed), then for each id: `thumbCache.remove(id)` (zeroes), `fullCache.remove(id)` (zeroes), `secureDelete.file(photos/<id>.enc)`, `secureDelete.file(thumbs/<id>.enc)`. Unknown ids are harmless. Index-before-files ordering means a crash can leave orphan FILES but never a dangling INDEX entry.

## 5.7 wipeAll()
Serialized (no open check): clear both caches (zeroing); `secureDelete.directoryContents(photos/)`; `secureDelete.directoryContents(thumbs/)` (files overwritten+unlinked, subdirectories removed, but the `photos/` and `thumbs/` directories themselves remain); if root exists, list root NON-recursively and securely delete every regular file whose final path segment starts with `index.enc` (this catches `index.enc` and any leftover `index.enc.<pid>.<n>.tmp`); set index empty; emit `[]`. Test asserts afterwards: `photos` empty, `index.enc` absent, `photos/` and `thumbs/` listings empty.

## 5.8 readEncryptedPhoto / readEncryptedThumbnail / readEncryptedIndex
Plain file reads of the `.enc` files (no decryption, no open check). Index returns null when the file does not exist.

## 5.9 importEncrypted({entry, photoBlob, thumbnailBlob})
1. Ensure open.
2. Authenticate: decrypt `thumbnailBlob` with thumb key/keyId thumb, zero the plaintext; decrypt `photoBlob` with photo key/keyId photo, zero the plaintext. Failure (`WrongKeyException` for tampered/foreign blobs, `FileCipherFormatException` for swapped kinds) aborts before anything is written. (Test tampers the last byte of the photo blob and expects `WrongKeyException`.)
3. Serialized: `writeFileAtomically(photos/<entry.id>.enc, photoBlob)`; `writeFileAtomically(thumbs/<entry.id>.enc, thumbnailBlob)`; `without = _index.withoutPhotos({entry.id})`; `photos = [...without.photos, entry.copyWith(source: restore)]` then sort by `createdAt` DESCENDING; `_commitIndex(VaultIndex(version: without.version, photos))`.
4. Caches are NOT touched (no invalidation of a previously cached same-id image); no file rollback on commit failure.

## 5.10 close()
Clear both caches (zeroing every buffer), close the change stream. May be called repeatedly. Does not flip `_opened`; later mutations would still write but no longer emit (emission is guarded by "stream not closed"). In production the provider calls `close()` when the session locks.

## 5.11 _commitIndex(next)
`blob = encrypt(utf8(next.encode()), indexKey, keyId manifest)` → `writeFileAtomically(index.enc, blob)` → `_index = next` → emit `photos`. The whole index is rewritten on every change (no incremental journal).

## 5.12 Orphans / inconsistency handling
- No reconciliation scan on open. Files without an index entry are invisible to the UI and only removed by `wipeAll` / vault erase.
- Index entries whose files are missing: tile shows the broken-image state (5.5 throws), viewer shows a broken-image icon; the entry can still be deleted normally (secure delete no-ops on missing files).

# 6. DecryptedImageCache (LRU with byte budget)

State: `maxBytes`, insertion-ordered map id → bytes, running `_bytes` total. Getters `length`, `sizeBytes`.
1. `get(id)`: absent → null; present → move to most-recent position and return the SAME buffer (no copy).
2. `put(id, bytes)`: if `bytes.length > maxBytes` → silently NOT cached, return. Otherwise drop any existing entry for `id` (WITHOUT zeroing), insert as most-recent, add length; then while `_bytes > maxBytes` and non-empty: drop the LEAST-recent entry (WITHOUT zeroing — a widget may still be drawing it).
3. `remove(id)`: remove and ZERO the buffer (photo deleted).
4. `clear()`: ZERO every buffer, empty the map, `_bytes = 0` (vault locked / repository closed).
Because buffers are shared by reference, zeroing on lock intentionally blanks any decrypted image still held by UI.

# 7. ImportService

`ImportReport { imported: int, failed: int }`.
Constructor: `secureDelete` (required), optional `picker` (default platform image picker), optional callbacks `onPickerOpened`, `onPickerClosed`. Production wiring (`importServiceProvider`): opened → `AutoLockSuspension.suspend()`, closed → `resume()` (suspension counter; while > 0 the background auto-lock timeout is relaxed to a 5-minute grace, `AutoLockSuspension.grace = Duration(minutes: 5)`).

`importFromLibrary(repository)`:
1. Call `onPickerOpened`.
2. `files = picker.pickMultiImage(requestFullMetadata: false)` (multi-select, no EXIF/location metadata requested); `onPickerClosed` in `finally` (also on cancel/error). Cancel yields an empty list → report `{0,0}`.
3. For each file in order: `bytes = readAsBytes()`; `repository.addPhoto(bytes, source: import, originalName: file.name, mimeType: file.mimeType ?? 'image/jpeg')`; `imported++`. On `ImageDecodeException` → `failed++` and continue. Any OTHER exception aborts the loop and propagates (after cleanup). `finally` per file: zero `bytes`.
4. `finally` (always, even on abort): for each picked file `_cleanup(file)`.
5. Return report.

`_cleanup(file)`: skip on web or empty path; skip unless platform is Android or iOS (desktop pickers may return the user's original); else `secureDelete.file(path)` with all errors swallowed. Rationale: on Android (cache dir) and iOS (tmp dir) the picker hands back a private COPY; the user's original in the OS library is never touched.

# 8. GalleryScreen (route `/vault`, protected)

State: `_selected: Set<String>`, `_importing: bool`; `_selecting = _selected.isNotEmpty`. `_toggle(id)` adds/removes.

## 8.1 Layout
- App bar: normal bar when not selecting, selection bar otherwise (see UI flows for copy).
- Body = Column: `LinearProgressIndicator` at top while `_importing`; then Expanded content:
  - repository loading → centered spinner; repository error → `_VaultError`; repository null (locked) → empty box;
  - photos loading → spinner; photos error → `_VaultError`; photos empty → `_EmptyVault`; else grid.
- FABs hidden while selecting or when repository is null. Otherwise a vertical stack (end-aligned): small FAB "Import photos" (icon add-photo, key `gallery_import`, heroTag `gallery_import`), 12 px gap, regular FAB "Take a photo" (icon camera, key `gallery_camera`, heroTag `gallery_camera`) → navigates to `/vault/camera`.
- Camera and import are FABs, not app-bar actions; app-bar actions are Settings and Lock only.

## 8.2 Grid
`extent = width >= 900 ? 200 : width >= 600 ? 160 : 128` (logical px, from screen width). GridView key `gallery_grid`, padding left 4, top 4, right 4, bottom 96 (clears FABs), max-cross-axis-extent delegate with `maxCrossAxisExtent = extent`, `mainAxisSpacing = 4`, `crossAxisSpacing = 4`, square cells (aspect 1). Column count = ceil(availableWidth / extent), cells shrink to fit. Items keyed by photo id. Tap: selecting → toggle; else push `/vault/photo/<id>`. Long-press: toggle (enters selection mode).

## 8.3 Delete selected
Confirm dialog; title `Delete photo?` when 1 selected else `Delete <N> photos?`; body `Deleted photos are securely erased and cannot be recovered.`; actions `Cancel` (text button → false) and `Delete` (filled button, key `gallery_delete_confirm` → true). If confirmed and still mounted: snapshot ids, clear selection (exits selection mode immediately), `await repository.deletePhotos(ids)`.

## 8.4 Import
Guard re-entry via `_importing`. Run `ImportService.importFromLibrary(repo)`. If `imported > 0` fire analytics event `vault_photo_added` with `{source: 'import'}` (fire-and-forget, errors swallowed). If `imported + failed > 0` show snackbar: `Imported <n> photo` + (`s` unless n == 1) + (failed > 0 ? `, <f> could not be read` : ``) + `.` — e.g. `Imported 3 photos.`, `Imported 1 photo, 2 could not be read.`, `Imported 0 photos, 1 could not be read.`. Nothing shown when zero files picked. On any thrown error: `crashReporter.recordError(e, stack, reason: 'import')` and snackbar `Import failed.`. Always reset `_importing`.

## 8.5 Lock
App-bar lock action calls the session controller's `lock()`; the router redirect then leaves `/vault` (test asserts GalleryScreen disappears), the repository provider is disposed → `close()` → caches zeroed.

# 9. PhotoTile
Props: `entry`, `repository`, `selected`, `selecting`, `onTap`, `onLongPress`. On mount starts `repository.readThumbnail(entry.id)`; restarts if the entry id or the repository instance changes. Accessibility: label `Photo`, selected state exposed.
Rendering (stack, fills cell):
1. Loading → solid `surfaceContainerHigh` box.
2. Error → `errorContainer` box with broken-image icon (`onErrorContainer`).
3. Loaded → Hero tag `photo_<id>` wrapping the image, cover fit, gapless, decoded at cacheWidth 400 px.
4. If `selected` → translucent overlay of `primary` at alpha 0.28.
5. If `selecting` → circle badge top 6 / right 6, background `surface` at alpha 0.85, icon 24 px: filled check-circle in `primary` when selected, hollow radio circle in `onSurfaceVariant` when not.

# 10. PhotoViewerScreen (route `/vault/photo/:id`)

State: page controller (created lazily), `_index`, `_chrome = true`.
1. Data: `photos` from `photosProvider` (fallback empty), `repository` from `vaultRepositoryProvider`. If either is empty/null → plain black scaffold (nothing else).
2. Initial page = index of `initialId` in photos, or 0 if not found. `index = _index.clamp(0, len-1)` for display.
3. Black background; body extends behind app bar. App bar shown only while `_chrome`: background `black45` (45% black), foreground white, title `<index+1> of <count>`, actions: Details (info icon, tooltip `Details`) and Delete (key `viewer_delete`, tooltip `Delete`).
4. Body: horizontal `PageView` over all photos; page change updates `_index`; tapping a page toggles `_chrome`.
5. Each page (`_FullImage`): decrypts on demand via `readFullImage(id)` (re-fetch on id change). `screenPx = round(screenWidth * devicePixelRatio * 2)`; `cacheWidth = entry.width > 0 ? min(entry.width, screenPx) : null` (decode bounded to 2× screen width). Loading → white spinner centered; error → broken-image icon `white54` 48 px; loaded → `InteractiveViewer(minScale 1, maxScale 5)` (pinch-zoom/pan) → centered Hero `photo_<id>` → image, contain fit, gapless.
6. Delete: dialog title `Delete photo?`, body `The photo is securely erased and cannot be recovered.`, `Cancel` / `Delete` (filled). If confirmed: if this is the ONLY photo → pop the viewer first; then `repository.deletePhotos([entry.id])`; then if `_index >= photos.length - 1` (pre-delete length) → `_index = max(0, photos.length - 2)` (stay on the new last page).
7. Details bottom sheet (drag handle; padding 24/0/24/24): heading `Details`; rows (label column 110 px, semibold; 4 px vertical padding):
   - `Taken` → local time formatted as `yMMMd jm` (e.g. `Jan 1, 2026 12:00 PM`)
   - `Dimensions` → `<width> × <height>` (U+00D7 multiplication sign with spaces)
   - `Size` → `<n> B` if < 1024; `<round(n/1024)> KB` if < 1,048,576; else `<n/1048576 to 1 decimal> MB`
   - `Source` → `Camera` | `Imported` or `Imported (<originalName>)` | `Restored from backup`
   - `Storage` → `Encrypted on this device`
8. No share, export, edit, or favorite actions.

# 11. CameraScreen (route `/vault/camera`)

State: `_cameras`, `_controller?`, `_cameraIndex=0`, `_flash=off`, `_initializing=true`, `_permissionDenied=false`, `_capturing=false`, `_starting=false`, `_generation=0`, `_error?`.

1. **Init**: register app-lifecycle observer; `_initialize()`: reset flags; enumerate cameras; none → `_error = 'No camera is available on this device.'`; else pick the first BACK-facing camera (fallback index 0) and `_start` it. Camera plugin errors → `_handle`. `_initializing=false` in finally.
2. **_start(index)**: single-flight (`_starting`); bump `_generation`; controller with preset HIGH, `enableAudio: false`, JPEG format; initialize; try to apply current flash mode (ignore unsupported); if unmounted, generation changed, or another controller already set → dispose the new controller and return (no leak); else commit controller + index.
3. **_handle(e)**: lower-case error code containing `denied` or `restricted` → `_permissionDenied = true`; else `_error = e.description ?? e.code`.
4. **Lifecycle**: on inactive/paused → dispose controller, null it, bump generation (releases the camera; also drops the preview under the privacy curtain). On resumed → restart same camera index if cameras known, no controller, not starting, and not permission-denied.
5. **Flip**: needs ≥ 2 cameras, not starting, not capturing; next = `(idx+1) % count`; dispose old, start next.
6. **Flash cycle**: off → auto → always → off. Applied via controller; on failure keep current mode.
7. **Capture**: guard (already capturing / no initialized controller). Resolve repository, secure-delete, analytics, crash reporter and snackbar host BEFORE any await. Repository null → snackbar `The vault is locked.` and return. Set capturing; `file = takePicture()`; `bytes = read file`; `repository.addPhoto(bytes, source: camera)` (mimeType default `image/jpeg`, no originalName); analytics `vault_photo_added` `{source: 'camera'}`; snackbar `Saved to vault` (1 s). Camera error → snackbar `Capture failed: <description or code>`. Other error → `recordError(reason: 'capture')` + snackbar `Could not save the photo.`. `finally`: zero `bytes`; if a temp file was produced (and not web) `secureDelete.file(path)` — the plugin's temporary JPEG never survives; reset capturing. Back navigation is BLOCKED while capturing (`canPop = !_capturing`).
8. Photos never go to the OS gallery/DCIM; audio is never enabled.

# 12. Provider / routing glue relevant here
- `vaultRepositoryProvider`: null while locked; when unlocked builds `EncryptedVaultRepository(paths: VaultPaths(<support>/vault), keys, cipher, EngineThumbnailGenerator, SecureDelete, SystemClock, CSPRNG)`, registers `close()` on dispose, awaits `open()`. No automatic retry on failure (an unreadable vault is shown once, not retried). Auto-disposed.
- `photosProvider`: stream; null repository → single `[]`; else `repository.watchPhotos()`. No retry.
- Routes: `/vault` Gallery, `/vault/camera` Camera, `/vault/photo/:id` Viewer; all `/vault*` and `/settings*` redirect to `/` when locked; redirect re-runs on every session change.
- Analytics event name constant: `vault_photo_added`; only parameter `source` ∈ {`camera`, `import`}.

## Public API

// Enums / models
enum PhotoSource { camera, import, restore }

class PhotoEntry {
  const PhotoEntry({required String id, required DateTime createdAt, required int width, required int height, required int sizeBytes, required PhotoSource source, String mimeType = 'image/jpeg', String? originalName});
  double get aspectRatio;                      // height==0 ? 1 : width/height
  Map<String, Object?> toJson();
  factory PhotoEntry.fromJson(Map<String, Object?> json);
  PhotoEntry copyWith({PhotoSource? source});
  bool operator ==(Object other);              // by id only
  int get hashCode;                            // id.hashCode
}

class VaultIndex {
  const VaultIndex({int version = 1, List<PhotoEntry> photos = const []});
  static const VaultIndex empty;
  VaultIndex withPhoto(PhotoEntry entry);      // prepend
  VaultIndex withoutPhotos(Set<String> ids);
  PhotoEntry? byId(String id);
  Map<String, Object?> toJson();
  factory VaultIndex.fromJson(Map<String, Object?> json); // throws FormatException on version != 1
  String encode();                             // compact JSON
  static VaultIndex decode(String raw);
}

// Thumbnails
class ThumbnailResult { Uint8List jpegBytes; int thumbWidth, thumbHeight, sourceWidth, sourceHeight; }
class ImageDecodeException implements Exception { const ImageDecodeException([Object? cause]); }
abstract class ThumbnailGenerator {
  static const int defaultMaxDimension = 512;
  static const int jpegQuality = 82;
  Future<ThumbnailResult> generate(Uint8List image, {int maxDimension = 512});
}
class EngineThumbnailGenerator implements ThumbnailGenerator { const EngineThumbnailGenerator(); }
class DartThumbnailGenerator implements ThumbnailGenerator { const DartThumbnailGenerator({bool useIsolate = true}); }

// Cache
class DecryptedImageCache {
  DecryptedImageCache({required int maxBytes});
  int get length; int get sizeBytes;
  Uint8List? get(String id);                   // LRU touch, same buffer
  void put(String id, Uint8List bytes);        // skip if > maxBytes; evicts LRU without zeroing
  void remove(String id);                      // zeroes
  void clear();                                // zeroes all
}

// Repository
class VaultDataUnreadableException implements Exception { const VaultDataUnreadableException([Object? cause]); }
abstract class VaultRepository {
  List<PhotoEntry> get photos;                 // newest first, unmodifiable
  Stream<List<PhotoEntry>> watchPhotos();      // current list first, then every change
  Future<PhotoEntry> addPhoto(Uint8List imageBytes, {required PhotoSource source, String? originalName, String mimeType = 'image/jpeg'});
  Future<Uint8List> readThumbnail(String id);
  Future<Uint8List> readFullImage(String id);
  Future<void> deletePhotos(Iterable<String> ids);
  Future<void> wipeAll();
  Future<Uint8List> readEncryptedPhoto(String id);
  Future<Uint8List> readEncryptedThumbnail(String id);
  Future<Uint8List?> readEncryptedIndex();
  Future<void> importEncrypted({required PhotoEntry entry, required Uint8List photoBlob, required Uint8List thumbnailBlob});
  Future<void> close();
}
class EncryptedVaultRepository implements VaultRepository {
  EncryptedVaultRepository({required VaultPaths paths, required VaultKeys keys, required FileCipher cipher, required ThumbnailGenerator thumbnails, required SecureDelete secureDelete, required Clock clock, SecureRandomSource? random, DecryptedImageCache? thumbnailCache /*24 MiB*/, DecryptedImageCache? fullImageCache /*48 MiB*/});
  Future<void> open();                         // must be awaited first; throws VaultDataUnreadableException
}

// Storage helpers used
class VaultPaths { VaultPaths(Directory root); Directory root, photos, thumbs; File index; File photoFile(String id); File thumbFile(String id); Future<void> ensure(); }
Future<void> writeFileAtomically(File target, List<int> bytes);
class SecureRandomSource { Uint8List bytes(int n); String hexId([int byteLength = 16]); static String toHex(List<int>); }
void zeroBytes(List<int> bytes);
class SecureDelete { SecureDelete({int chunkSize = 65536, Random? random}); Future<void> file(File f); Future<void> directoryContents(Directory d); }

// Import
class ImportReport { const ImportReport({required int imported, required int failed}); }
class ImportService {
  ImportService({required SecureDelete secureDelete, ImagePicker? picker, VoidCallback? onPickerOpened, VoidCallback? onPickerClosed});
  Future<ImportReport> importFromLibrary(VaultRepository repository);
}
final importServiceProvider; // Provider<ImportService>

// Widgets
class GalleryScreen extends ConsumerStatefulWidget { const GalleryScreen(); }
class PhotoTile extends StatefulWidget { const PhotoTile({required PhotoEntry entry, required VaultRepository repository, required bool selected, required bool selecting, required VoidCallback onTap, required VoidCallback onLongPress}); }
class PhotoViewerScreen extends ConsumerStatefulWidget { const PhotoViewerScreen({required String initialId}); }
class CameraScreen extends ConsumerStatefulWidget { const CameraScreen(); }

// Providers (app/providers.dart)
final vaultRepositoryProvider; // FutureProvider<VaultRepository?> — null while locked; retry disabled; autoDispose; calls close() on dispose
final photosProvider;          // StreamProvider<List<PhotoEntry>> — [] when locked
final vaultRootDirectoryProvider; // FutureProvider<Directory> = <appSupport>/vault
final thumbnailGeneratorProvider; // Provider<ThumbnailGenerator> = EngineThumbnailGenerator
final secureDeleteProvider, fileCipherProvider, clockProvider, secureRandomProvider, analyticsProvider, crashReporterProvider

// Routes (app/router.dart)
AppRoutes.vault = '/vault'; AppRoutes.camera = '/vault/camera'; AppRoutes.photo(id) = '/vault/photo/<id>'; AppRoutes.settings = '/settings'

// Test-facing widget keys
'gallery_grid', 'gallery_import', 'gallery_camera', 'vault_settings', 'vault_lock', 'gallery_delete', 'gallery_delete_confirm', 'viewer_delete', 'camera_shutter'

## Tests

## test/features/vault/encrypted_vault_repository_test.dart (pure unit tests, real filesystem in a temp dir)

Fixtures:
- `makeJpeg(width, height, {seed=7})`: synthetic JPEG, pixel RGB = `((x*seed)&0xFF, (y*3)&0xFF, ((x+y)*seed)&0xFF)`, encoded at JPEG quality 90. `smallJpeg = makeJpeg(64, 48)`.
- `containsSequence(haystack, needle)` byte-substring search.
- `setUp`: temp dir prefixed `silentsum_vault_`; `paths = VaultPaths(<tmp>/vault)`; `keys = VaultKeys.derive(32 random bytes)`; `clock = FakeClock()` (starts 2026-01-01 12:00 local). `open([keys])` builds `EncryptedVaultRepository(paths, keys, FileCipher(), DartThumbnailGenerator(useIsolate:false), SecureDelete(), clock)` and awaits `open()`. `tearDown` deletes the temp dir.

1. **add photo stores only ciphertext on disk** — add 64×48 camera photo; assert `entry.width == 64`, `entry.height == 48`, `entry.sizeBytes == smallJpeg.length`, `repo.photos == [entry]`. For each of photo file, thumb file, index file: `FileCipher.looksEncrypted` is true, bytes do NOT contain `FF D8 FF` (JPEG SOI marker). Index bytes do NOT contain the entry id's ASCII code units (plaintext leak check). Every file under root (recursive) has path ending `.enc`.
2. **full image round-trips and thumbnail is a smaller jpeg** — 1400×900 import with originalName `x.jpg`; `readFullImage` returns bytes identical to the input; decoded thumbnail width == 512, height < 400; thumbnail byte length < original length; `entry.width == 1400`.
3. **watchPhotos emits current list then every change** — subscribe; add `a`; clock +1 s; add `b`; delete `a`; emissions are `[]`, `[a]`, `[b, a]`, `[b]` (in that order; equality by id).
4. **delete removes files and index entries** — add `a`, `b`; delete `a`; `photos == [b]`; `photos/<a>.enc` and `thumbs/<a>.enc` do not exist; `photos/<b>.enc` exists; `readFullImage(a)` throws `FileSystemException`.
5. **multiple photos are ordered newest first and survive reopen** — 5 adds, advancing clock 1 min before each; `photos` ids equal the reversed insertion list; `close()`; reopen with same keys; same reversed order; `readFullImage(ids.first)` (oldest) equals `smallJpeg`.
6. **concurrent adds and deletes never lose index entries** — `Future.wait` of 6 simultaneous adds → `photos.length == 6`; `Future.wait([delete added[0], add (import), delete added[1]])` → length 5; close; reopen → 5; root listing contains no file ending `.tmp`.
7. **restored blobs are authenticated before being accepted** — add; read encrypted photo and thumb; flip the lowest bit of the LAST byte of the photo blob; open a second repository on the SAME paths with `VaultKeys.derive(keys.masterKey)`; `importEncrypted(entry, tampered, thumbBlob)` throws `WrongKeyException`.
8. **foreign keys cannot open the vault** — add one photo; derive keys from a different random master; `open(other)` throws `VaultDataUnreadableException`.
9. **large image (several MB) round-trips** (timeout 3 min) — `makeJpeg(3000, 2000, seed: 13)`, asserted > 1 MiB; import; `entry.width == 3000`; full image round-trips byte-exact; decoded thumbnail width == 512.
10. **undecodable bytes are rejected and leave no files behind** — `addPhoto(1000 random bytes, import)` throws `ImageDecodeException`; `photos` empty; `photos/` directory listing empty.
11. **wipeAll leaves no files and an empty index** — add 2; `wipeAll()`; `photos` empty; `index.enc` does not exist; `photos/` and `thumbs/` listings empty.
12. **encrypted export/import round-trip for backup** — source repo add; `readEncryptedPhoto`, `readEncryptedThumbnail`; `readEncryptedIndex()` is not null; target repo on a DIFFERENT root (`<tmp>/restored`) with keys derived from the same master key; `open()`; `importEncrypted(entry, photoBlob, thumbBlob)`; `target.photos.single.id == entry.id`; `target.photos.single.source == PhotoSource.restore`; `target.readFullImage(entry.id) == smallJpeg`.

## test/features/gallery/gallery_screen_test.dart (widget test on the real app with fakes)

Harness (`test/support/test_app.dart`): boots the full app with in-memory secure store, Argon2id inline with test params, `FileCipher(isolateThresholdBytes: 1<<30)` (never uses isolates), `DartThumbnailGenerator(useIsolate:false)`, vault root `<tmp>/vault`, in-memory settings (onboarding done), `FakeClock`, recording screen protection, Firebase unavailable. `configuredPin: '2468'` pre-creates the vault. Helpers: `tapCalculator(tester, '2468=')` types keys `calc_key_<name>`; `settle(frames)` pumps 40 ms frames with 15 ms real delays; `longPressReal` holds a gesture 800 ms real time; `makeTestJpeg(w, h, seed=7)` same pixel formula, JPEG quality 85.

1. **gallery refreshes immediately after add and delete** —
   a. Enter PIN `2468=` on the calculator → `GalleryScreen` is shown.
   b. Obtain the repository from `vaultRepositoryProvider`; `addPhoto(jpeg, camera)` → exactly 1 `PhotoTile`; text `Your vault is empty` is absent.
   c. `addPhoto(jpeg, import)` → 2 `PhotoTile`s.
   d. Long-press the first tile → app bar shows `1 selected`.
   e. Tap key `gallery_delete`, then key `gallery_delete_confirm` → 1 `PhotoTile`; `repository.photos.length == 1`.
   f. Tap key `vault_lock` → `GalleryScreen` is no longer in the tree (router redirected to the calculator).

## Cross-references (outside the requested globs, for awareness)
`test/features/calculator/calculator_screen_test.dart` and `test/features/lifecycle/app_lifecycle_guard_test.dart` assert `GalleryScreen` presence/absence around unlock, lock (`vault_lock` key) and auto-lock; they contain no gallery-specific behavior assertions.

## UI flows

## Gallery (`/vault`)
Normal app bar: title `Vault`; actions in order: Settings (gear icon, tooltip `Settings`, key `vault_settings`) → `/settings`; Lock (lock icon, tooltip `Lock vault`, key `vault_lock`) → locks session → router sends user to calculator.
Selection app bar (when ≥ 1 selected): leading X (tooltip `Cancel selection`) clears selection; title `<N> selected`; actions: Select all (tooltip `Select all`) selects every photo id; Delete (trash icon, tooltip `Delete`, key `gallery_delete`; disabled if repository null).
Body states:
- Loading (repository or photos): centered circular spinner.
- Vault error (unreadable): error icon 56 px in error color; title `Vault data cannot be read`; body `The encrypted files on this device do not match your PIN. They may belong to a previous installation. Erasing the vault lets you start over.`; tonal button `Erase vault…` opening the shared Erase-vault dialog (title `Erase vault?`, body `Every photo in the vault and the vault PIN will be securely deleted from this device. This cannot be undone.\n\nType ERASE to confirm.`, text field hint `ERASE`, `Cancel` / `Erase vault` enabled only when typed text trimmed == `ERASE`; on success snackbar `Vault erased.` and go to calculator).
- Other error: title `Something went wrong`; body = scrubbed error text (4–8 digit runs → `[redacted]`, file paths → `[path]`); no button.
- Empty: photo-library icon 64 px; title `Your vault is empty`; body `Photos you capture or import are encrypted on this device and never appear in your regular gallery.`; outlined button with add-photo icon `Import photos`.
- Grid: square tiles, 4 px gaps, tile max extent 128 (<600 wide) / 160 (600–899) / 200 (≥900); bottom padding 96.
- While importing: thin linear progress bar across the top of the body.
FABs (hidden in selection mode): small `Import photos` (add-photo icon) above regular `Take a photo` (camera icon), 12 px apart, bottom-right.
Interactions: tap tile → viewer (Hero transition on tag `photo_<id>`); long-press tile → selection mode with that tile selected; in selection mode tap toggles. Selected tile: primary-tinted overlay (28%) + filled check badge; unselected in selection mode: hollow circle badge.
Delete dialog: `Delete photo?` / `Delete <N> photos?`; `Deleted photos are securely erased and cannot be recovered.`; `Cancel`, `Delete` (filled). Confirming exits selection mode immediately and deletes.
Snackbars: `Imported <n> photo(s)[, <f> could not be read].`; `Import failed.`

## Photo viewer (`/vault/photo/:id`)
Black full-screen pager starting at the tapped photo. Tap image toggles chrome. Chrome = translucent black app bar, white foreground, title `<i> of <n>`, actions Details (info icon) and Delete (trash, key `viewer_delete`). Pinch-zoom 1×–5×, pan; horizontal swipe changes photo. Loading: white spinner; failure: broken-image icon.
Details sheet (modal bottom sheet with drag handle): heading `Details`; rows `Taken` (local `Jan 1, 2026 12:00 PM` style), `Dimensions` (`W × H`), `Size` (`B`/`KB`/`MB` rule), `Source` (`Camera` | `Imported` | `Imported (<name>)` | `Restored from backup`), `Storage` (`Encrypted on this device`).
Delete dialog: `Delete photo?`; `The photo is securely erased and cannot be recovered.`; `Cancel` / `Delete`. Deleting the last remaining photo closes the viewer; otherwise stays on the neighbouring photo.

## Camera (`/vault/camera`)
Black screen, transparent app bar titled `Camera`, white foreground. Actions: Flash (only when a controller exists; icon cycles off → auto → on; tooltip `Flash`), Switch camera (only when ≥ 2 cameras; tooltip `Switch camera`; disabled while no controller).
Body states:
- Initializing / no controller: white spinner.
- Permission denied/restricted: no-photography icon 56 px (white70); title `Camera access needed` (white, 20 px, semibold); text `Allow camera access for this app in your device settings, then try again.` (white70, centered); filled button `Try again` → re-initialize.
- Other camera error: videocam-off icon; title `Camera unavailable`; text = error description (or `No camera is available on this device.`); button `Try again`.
- Ready: live preview centered; shutter button 32 px from bottom: 76×76 white ring (4 px) with white disc; while capturing the disc dims to 54% white and shows a small dark spinner; accessibility label `Take photo`, key `camera_shutter`. Back gesture/button disabled while capturing.
Snackbars: `Saved to vault` (1 s); `Capture failed: <reason>`; `Could not save the photo.`; `The vault is locked.`
Leaving the app (inactive/paused) releases the camera; returning restarts it.

## Security notes

1. No plaintext image or metadata is ever written by this subsystem: originals and thumbnails are encrypted (XChaCha20-Poly1305, per-purpose HKDF subkeys, `SSV1` container with keyId bound as AAD) before touching disk; the index JSON is encrypted with the index key. File names are 128-bit random hex; tests assert no JPEG magic or photo id appears in any on-disk file and that every file ends `.enc`.
2. Key separation: photo/thumb/index blobs carry distinct keyId codes (1/2/3); decrypt refuses a blob whose header keyId differs from the expected kind (`FileCipherFormatException`), so a thumbnail cannot be served as a photo or vice versa.
3. Fail closed: the repository holds the session's `VaultKeys`; locking zeroes them, so every later crypto call throws. The provider closes the repository on lock, which zeroes and clears both decrypted caches (thumbnails ≤ 24 MiB, full images ≤ 48 MiB of plaintext in memory while unlocked).
4. Cache hygiene: explicit `remove` (delete) and `clear` (lock/close) zero buffers; LRU budget eviction does NOT zero (buffer may still be on screen). `put` silently skips images larger than the budget.
5. Temp-file hygiene: camera plugin's temporary JPEG and image-picker's private copies are securely deleted (overwrite with pseudo-random bytes, flush, unlink) immediately after encryption, success or failure; picked-file bytes and capture bytes are zeroed in `finally`. Desktop/web paths are not deleted (may be the user's original).
6. Atomicity/crash safety: every index rewrite and blob write goes through temp-file + fsync + rename; `deletePhotos` commits the index BEFORE deleting files (prefers orphan ciphertext over dangling entries); `addPhoto` rolls back both files if the commit fails; `wipeAll` also sweeps `index.enc*.tmp` leftovers.
7. Restore path authenticates both blobs against the current keys before writing (tampered blob → `WrongKeyException`, nothing written) and discards/zeroes the decrypted copies.
8. Unreadable vault (foreign/corrupt index or version mismatch) surfaces as `VaultDataUnreadableException`, shown once (no retry) with an explicit Erase-vault path that requires typing `ERASE`.
9. Import suspends auto-lock with a 5-minute grace so the system picker cannot lock the vault mid-import; the picker is called with `requestFullMetadata: false` (no location/EXIF metadata requested).
10. Telemetry: only `vault_photo_added` with `source` ∈ {camera, import}; crash reports use `recordError(reason: 'import' | 'capture')` and free text is scrubbed of 4–8 digit runs and paths. No ids, names or PINs are logged.
11. Known gaps (from code): `importEncrypted` does not invalidate a cached same-id image and does not roll back files on commit failure; the `SSV1` AAD does not include the photo id, so two same-kind blobs could be swapped on disk without failing authentication (confidentiality unaffected); Dart cannot guarantee zeroing of GC copies.

## Open questions

- EngineThumbnailGenerator records `sourceWidth/Height` from the platform image descriptor; whether those are EXIF-orientation-corrected depends on the engine, while DartThumbnailGenerator bakes orientation first. The RN implementation should decide (recommended: store orientation-corrected/display dimensions, matching the test path and the viewer's `Dimensions` row).
- PhotoEntry.createdAt uses Dart's `toIso8601String()` (3 fractional digits, or 6 when microseconds are non-zero). Confirm the RN writer emits exactly 3 digits + `Z` and the parser accepts both, for backup interoperability with existing Flutter-created indexes.
- `importEncrypted` neither invalidates the thumbnail/full-image caches for an overwritten id nor rolls back written files if the index commit fails. Should the RN port replicate this or fix it? (Fixing is compatible on disk.)
- Dart's List.sort is not stable; `importEncrypted` sorts by createdAt descending, so relative order of entries with identical timestamps is unspecified. Decide on a deterministic tiebreaker (e.g. id) in RN.
- `deletePhotos` with only unknown ids still rewrites the index and emits a change; `wipeAll` works without `open()`. Replicate exactly or tighten?
- `XFile.mimeType` from image_picker is frequently null on Android, so non-JPEG imports (PNG/HEIC/WebP) are stored with `mimeType: image/jpeg`. mimeType is never used for decoding; confirm whether RN should detect the real type from magic bytes instead.
- HEIC/HEIF import support depends on the platform decoder (engine path). The Dart fallback decoder rejects HEIC with ImageDecodeException. Confirm the RN thumbnail pipeline's supported formats and that unsupported inputs raise the equivalent of ImageDecodeException so the import report counts them as `could not be read`.
- The camera error-code heuristic (`code.toLowerCase()` contains `denied` or `restricted`) is plugin-specific; map the RN camera library's permission states explicitly.
- DecryptedImageCache hands out shared buffers and zeroes them on delete/lock, which can blank a still-visible image by design. In RN (base64/URI-backed images) this trade-off may not be reproducible; confirm the desired behaviour (clear caches on lock is the hard requirement).
- wipeAll leaves the empty `photos/` and `thumbs/` directories and the vault root in place; tests only assert their listings are empty. Confirm this is acceptable for RN or whether directories should be removed too.