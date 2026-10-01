# Security

## Threat model

**Protects against** someone who picks up the phone and browses the OS gallery, a file manager, the
app switcher or cloud photo sync; an attacker holding a copy of the app's files (a device backup,
a filesystem dump taken without the hardware keystore); a curious or compromised cloud operator
when backup is enabled; and casual PIN guessing.

**Does not protect against** a compromised or rooted operating system, an observer watching the
screen while the vault is open, an attacker who knows the PIN, memory forensics of the running
process, or loss of the device with no cloud backup configured.

## Authentication is offline, always

Nothing on the unlock path can reach the network. Firebase is never consulted, and the vault opens
identically in airplane mode, on a device that has never had connectivity, and in a build with no
Firebase configuration compiled in at all.

Setup:

1. A 32-byte vault master key and a 16-byte salt are drawn from the OS CSPRNG (libsodium
   `randombytes_buf`).
2. `KEK = Argon2id(PIN, salt, memory 32 MiB, iterations 3, lanes 1)`.
3. `wrapped = XChaCha20-Poly1305(KEK, nonce24, masterKey, aad "silentsum/vmk/v1")`.
4. The record `{v, salt, kdf, wrapped, pinLength, createdAt}` goes into the platform secure store:
   Android Keystore-backed storage, iOS Keychain with `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` and no
   iCloud synchronisation.
5. The PIN and KEK buffers are zeroed.

Unlock re-derives the KEK from the **whole** PIN and unwraps; the Poly1305 tag is still the only
thing that verifies the key itself.

### Unlocking: parts that add up

The calculator is a working calculator. Type any expression, press `=`, and the **result** is what
is offered to the authenticator. A result that is a contiguous run inside the PIN covers the digits
it spells, and the vault opens once the covered digits account for the **whole PIN** — in one
calculation, or across several. Opening it is the same operation it has always been: Argon2id over
the whole PIN, unwrap, Poly1305 tag as the only verifier.

Until the PIN is covered, each correct part is answered with how many digits are still outstanding.
With PIN `12142907`:

| Calculation  | Result     | Response                                |
| ------------ | ---------- | --------------------------------------- |
| `2 − 1`      | `1`        | "1 is correct, but there are 7 more"    |
| `6 + 6`      | `12`       | "12 is correct, but there are 6 more"   |
| `1000 + 214` | `1214`     | "1214 is correct, but there are 4 more" |
| `2900 + 7`   | `2907`     | the vault opens                         |
| `7 × 7`      | `49`       | nothing at all                          |
| `12142907`   | `12142907` | the vault opens on the first press      |

A run that occurs more than once is credited to the occurrence covering the most new digits,
leftmost first, so entering a repeated digit twice covers both of its positions. Only a
non-negative whole result can be offered; a negative or fractional one is not a run of digits.

Progress is held **in memory only**. It is never written to disk or to the secure store, it dies
with the process, and it is cleared on every successful unlock — so a vault that was opened and
then locked cannot be reopened by adding one more digit to the previous run.

**This is the weakest part of the design, by a wide margin.** The missing-digit count is an oracle:
it confirms that a guess belongs to the PIN, and confirmed guesses accumulate. Someone holding the
phone can work through the ten digits and be inside in well under a hundred presses; the PIN's
length no longer contributes real strength. What is left of the brake is narrow but real — results
that are **not** in the PIN still count as failed attempts and still trigger the escalating lockout
below, and nothing is confirmed, credited, or opened while a lockout is running. Correct parts do
not count as failed attempts, because counting them would lock a user out halfway through entering
their own PIN.

**The PIN is also stored.** Recognising a part of the PIN cannot be done by deriving a key from what
was typed, so the app has to hold the PIN and compare. It sits in the platform secure store
(Android Keystore / iOS Keychain) beside the wrapped key, and the previous property — that the
cheapest offline attack costs one Argon2id derivation per guess — no longer holds: anyone who can
read that store reads the PIN outright. The stored PIN never grants access on its own; it only
decides what a result means. It is never written to a file, never logged, and never uploaded.

`pinLength` is stored in the clear for the setup and change-PIN screens; the range is already
public from the policy.

### PIN policy

Four to eight digits, no leading zero. The PIN is typed on a calculator keypad and must survive
being displayed there verbatim, which is also what makes an unlock indistinguishable from
arithmetic.

### Failed attempts

| Consecutive failures | Delay                                 |
| -------------------- | ------------------------------------- |
| 1-2                  | none                                  |
| 3                    | 5 seconds                             |
| 4                    | 15 seconds                            |
| 5                    | 30 seconds                            |
| 6                    | 1 minute                              |
| 7 and beyond         | 5 minutes, doubling, capped at 1 hour |

An attempt made during a delay is refused **before** the key derivation runs, so a locked-out
attacker cannot even spend the device's CPU. Success resets the counter. Nothing is ever wiped
automatically.

Every evaluated whole-number result that is **not** part of the PIN counts as an attempt, so
ordinary arithmetic does consume the free failures. Results that are part of the PIN do not: a
user entering their own PIN in pieces would otherwise be locked out halfway through. Two rules
keep that from giving the vault away: a result that has nothing to do with the PIN is never
answered with a lockout notice and never extends a running lockout, and only a result that would
otherwise have been answered — a part of the PIN, or the last piece of it — is reported as
throttled.

Two clocks enforce the lockout. The persisted deadline uses wall-clock time so it survives a
restart; an in-process monotonic deadline runs alongside it, so moving the system clock forward
while the app is running cannot shorten a lockout. A clock moved _backwards_ past the last failure
is treated as still fully locked.

### Forgetting the PIN

There is no recovery and no backdoor. The forgot-PIN dialog says so and offers only to erase the
vault, behind a typed confirmation phrase. It is reachable from the calculator menu, and from the
shortcut under the unlock notice, whenever super secure mode is off.

Erasing is deliberately local and deliberately total (`src/auth/vaultWipe.ts`). It is one function
with two doors: this dialog, and the gallery's escape hatch for a vault whose files no longer
decrypt with the session's keys. Both run the same steps in the same order, which is checked by a
spec that drives each door and compares the device afterwards field by field:

1. The session is locked and the repository closed.
2. Every decrypted temporary goes first: the playback scratch directory, then the rest of the app's
   cache. Destroying the ciphertext while leaving a decrypted video in `cache/playback` would be
   worse than doing nothing.
3. The vault directory is securely deleted -- payloads, thumbnails and the index.
4. The credential record goes, so the wrapped master key is gone even if the blobs are later carved
   off the flash, and the attempt throttle goes with it.
5. Settings are reset, including the record that a cloud backup existed.
6. The cloud session is signed out, and only signed out. The account, the encrypted blobs and the
   backup envelope are never touched. Deleting any of them here would turn a forgotten PIN into
   permanent loss.

The dialog then reports which of the two situations the user is actually in, which is the part that
matters most: with a cloud backup it opens the restore flow directly; without one it says plainly
that those photos cannot be recovered by anyone, at the last moment that sentence can still be
useful.

Restoring runs in the order the secrets actually matter. Signing in only locates the ciphertext, so
the account is asked whether it holds an envelope at all before a passphrase is requested. The
passphrase is then verified by unwrapping the envelope with it -- before a PIN is chosen and before
a byte is downloaded -- so a wrong passphrase costs one Argon2id run and changes nothing on the
device. Only then is the recovered master key re-wrapped under a new local PIN, and only then does
the download start. The account password is authentication; it is never an encryption key, and
resetting it changes nothing about the envelope, the master key or any uploaded blob.

### Support-issued recovery codes

Super secure mode empties the calculator menu down to About, which takes the forgot-PIN dialog
with it. That is the point of the mode, and it leaves one narrow hole: a user who has forgotten
their PIN can reach customer service and nothing else. A recovery code is the answer we can send
back (`src/support/recoveryCode.ts`, `src/support/recoveryAccess.ts`).

The scheme is asymmetric on purpose. The app holds an Ed25519 **public** key, compiled in from
`extra.recoveryPublicKey`; the private half never leaves the signing machine. Verifying a code
and minting one are therefore different powers, and only the first ships: pulling the key out of
the APK buys nothing. A shared secret would have put both in every install.

What is signed is a context string, the installation reference, and an expiry day. The reference
is ten random bytes generated on first use and shown on the About page; because it is inside the
signed message and supplied by the verifier rather than the typist, a code minted for one phone
simply fails signature verification on any other. There is no separate device check to forget.
Codes expire after seven days and are single use, with spent codes remembered across restarts so
"use it again" cannot be turned into "close the app first".

The reference is written into the support draft as editable text rather than attached to the
message, so nothing leaves unseen and the user can delete it. It is also generated until it
survives `scrub` unchanged. The scrubber redacts runs of four to eight digits because that is the
shape of a PIN, so a reference whose group happened to be four digits would arrive as
`[redacted]` -- about one in twenty-six of them -- leaving a code signed against the wrong
reference and rejected by the phone that asked for it. The constraint sits in generation rather
than in an exemption to the scrubber, so the PIN rule keeps the "cannot opt out, cannot forget"
property it was written to have.

Verification is arithmetic on bytes the user typed. No network, no Firebase, no server that has
to be up -- which matters, because the people who need a code are by definition already locked
out of something.

A code buys exactly one thing: the restore flow appears. It decrypts nothing, reveals no key
material, cannot change or bypass the PIN, and cannot stand in for the recovery passphrase, which
is still what unwraps the envelope and which we have never had. The authorization is held in
memory only and ends on completion, on backing out, on the vault locking, and on process restart.

Because the user has told us the vault on the device cannot be opened, this is the one path where
`adoptMasterKey` is allowed to overwrite an existing vault. That replacement happens at the END of
the flow, after the passphrase has already unwrapped the key, so the vault on the device is given
up only once its replacement is certain -- and the PIN step says plainly that anything added since
the last backup is not coming back.

The residual risk is not cryptographic. It is that whoever issues codes can be socially engineered
into confirming, to whoever is holding a particular handset, that the app is a vault rather than a
calculator. For some users that disclosure is the thing they were relying on. Verify the requester
before signing; `scripts/recovery-code.js` says so where it cannot be missed.

Builds with no `RECOVERY_PUBLIC_KEY` cannot accept a code, and the About page then offers no field
at all.

### The wipe PIN

An optional second PIN that destroys instead of opening, for coercion. It is armed in
Settings -> Wipe PIN with a scope: `This device`, `Cloud backup`, or `Both`.

- **It asks before it destroys anything**, naming what will go, and wipes only on the answer. A
  prompt saying no more than "are you sure?" would be no safer than no prompt at all.

  This is a deliberate reversal. The feature was first built silent -- a wipe was indistinguishable
  from arithmetic, which is what made it usable under coercion -- and that is precisely what made
  it dangerous: a number calculated by accident, or a wipe PIN whose owner had forgotten which
  number it was, destroyed a vault with no way to stop it and no sign that it had happened. Safety
  won. The cost is real and should be stated plainly: someone watching the screen now sees the
  prompt, so the feature no longer hides itself at the moment it is used.

- **Everything after the answer is still invisible.** No notice, no navigation, no welcome sheet
  reappearing, and deliberately no analytics event -- one would be a durable record that the
  feature exists and was used. The destruction runs in the background, so the display goes back to
  being a calculator immediately.
- **It matches the whole result only**, never a contiguous part of it, and the two PINs are kept
  from overlapping **in both directions and from both ends**: `setWipePin` refuses a wipe PIN that
  is, contains, or is contained by the vault PIN, and `setupPin`, `changePin` and `adoptMasterKey`
  refuse a vault PIN that would collide with an already armed wipe PIN. Checking only at arming
  time would make the guarantee last exactly until the next Change PIN, after which the owner's own
  PIN would destroy the vault instead of opening it.
- **It is checked first**, before the credential record is parsed and before the lockout is
  consulted. An active lockout, or a credential record that has stopped decoding, must not be able
  to disarm the one path that exists for the moment somebody is standing over you.
- **The device wipe is `wipeLocalVault`**, with the preferences kept. Resetting them would clear
  `onboardingDone` and bring the first-run welcome sheet back, and a sheet appearing seconds after
  a number was typed is precisely the announcement this path must not make.
- **The cloud wipe deletes the blobs, the index, the manifest and the envelope.** The Firebase
  account is never deleted -- `deleteAccount()` has no caller anywhere in the app. When both scopes
  apply the cloud goes first, because wiping the device signs Firebase out and a signed-out app
  cannot reach the account. The armed record itself is destroyed last of all, with the credentials,
  so it can never be lost before the work it describes has been attempted.
- **The session is proved before anything is deleted.** A cached `currentUser` is not a usable
  session: Firebase keeps the user object while its token is stale or revoked, and Firestore
  answers reads from its offline cache without reaching the server. So the cloud wipe first makes
  an authenticated, uncached Cloud Storage listing, and deletes nothing unless it succeeds. The
  outcome being ruled out is a half-deleted backup -- some blobs gone, the envelope still standing
  -- which destroys data without achieving what the wipe was for. A token that expires _between_
  two of `disable()`'s own calls could still leave the cloud copy part-deleted; that window cannot
  be closed from the client.
- **The armed scope is reported, never inferred.** Settings and the Wipe PIN screen print the scope
  read from the stored record, verbatim, as `Wipe PIN active: <scope>`. The scope picker is a
  separate thing that starts with _nothing_ selected, is never seeded from the record, and needs a
  confirmation of its own before a row becomes the selection; arming then confirms the scope by
  name one last time, and a cloud-touching scope has to carry the warning that the envelope goes
  with the blobs.

  This is not decoration. The picker used to hold a single value that meant both "what is armed"
  and "what is selected", defaulting to `device`. An owner read that default tick as a report of
  the armed scope, `both` was armed by a stray tap on the row above, and the wipe took the cloud
  backup with the phone. Anything that lets a default appear where the armed scope belongs
  reintroduces that bug.

- **Storage.** The record lives in the platform secure store under its own key and holds the PIN as
  itself. Hashing only this one would be theatre: the vault PIN is already stored in the clear
  beside it, for the substring rule above.

Known limitation: after a device wipe the menu offers "Set up private vault" where it used to offer
"Forgot PIN?", because there genuinely is no vault any more. Nothing shows at the moment of the
wipe, but somebody who knew what that menu said beforehand could notice the difference later.

## Key hierarchy

```
PIN --Argon2id(32 MiB, t=3)--> KEK --unwrap--> master key (in memory only, while unlocked)
                                                 |- HKDF-SHA256 "silentsum/photo/v1" -> photo key
                                                 |- HKDF-SHA256 "silentsum/thumb/v1" -> thumbnail key
                                                 |- HKDF-SHA256 "silentsum/index/v1" -> index key
                                                 '- HKDF-SHA256 "silentsum/video/v1" -> video key
recovery passphrase --Argon2id(64 MiB, t=3)--> backup KEK --wrap--> envelope (cloud, optional)
```

Separate sub-keys mean a compromise of one purpose does not expose the others, and the master key
itself is only ever used for wrapping. Changing the PIN re-wraps the same master key under a new
salt, so stored photos are not re-encrypted and stay readable.

Locking disposes the key set: every buffer is zeroed and the decrypted-image caches are wiped.

## Storage format

Location: `<app documents>/vault/{index.enc, photos/<id>.enc, thumbs/<id>.enc}`. App-private,
never media-scanned, never in Pictures or DCIM, and excluded from OS backups. Item ids are 128-bit
random hex, so a file name reveals nothing, not even a capture order -- or whether an item is a
photo or a video. Videos share `photos/`: the directory is a bucket, and what distinguishes a video
is the key id in its header.

Every blob uses the same authenticated container:

```
"SSV1"(4) | version = 1 (1) | key id (1) | nonce (24) | ciphertext | Poly1305 tag (16)
```

The 6-byte header is bound in as associated data, so the key id cannot be edited to make a
thumbnail decrypt as a photo. Nonces are 192-bit random values, which is why generating one per
blob is safe with no counter. The index is JSON encrypted with the index key and written atomically
via a temp file and a rename.

### The chunked variant, for videos

A recording is routinely hundreds of megabytes: encrypting it as one message would need the whole
plaintext AND the whole ciphertext resident at once. Videos therefore use format version 2, which
is the same primitive and the same key hierarchy applied a chunk at a time:

```
"SSV1"(4) | version = 2 (1) | key id (1) | log2 chunk size (1) | base nonce (24) | chunks...
chunk = XChaCha20-Poly1305(plaintext chunk)      (1 MiB of plaintext + a 16-byte tag)
```

Two properties make a sequence of AEAD messages as safe as one, and both are covered by
`src/crypto/__tests__/streamCipher.test.ts`:

- **Nonces never repeat.** The 24-byte base nonce is random per blob; a chunk's nonce is that base
  with its trailing 8 bytes XORed against the chunk index.
- **Chunks cannot be moved, dropped, duplicated or replayed.** Each chunk binds
  `header | index | M` (or `| F` for the final chunk) as associated data. Cutting the file short
  changes which chunk claims to be final, so truncation fails authentication rather than yielding a
  shorter video.

Decryption writes through a temp file and renames only after the last chunk authenticates, so a
tampered blob never surfaces as a short-but-playable video. Photos, thumbnails and the index are
unchanged: they still use version 1, byte for byte, including their compatibility with the Flutter
reference.

This format is byte-for-byte identical to the Flutter implementation. `src/crypto/__tests__/flutterCompatibility.test.ts`
pins the Argon2id output, the three HKDF sub-keys and an XChaCha20-Poly1305 ciphertext and tag
against values generated by the reference's own primitives.

## Plaintext handling

- Decrypted bytes live only in memory, in byte-budgeted LRU caches (24 MiB thumbnails, 48 MiB full
  images) that are zeroed on lock.
- Images are displayed from in-memory `data:` URIs. The app never writes a decrypted image to disk
  unless the user exports one (below).
- **Videos are one of two exceptions, and are fenced off accordingly.** No player takes bytes, so
  playback decrypts to a file in `<app cache>/playback/`. That file has a random name (not the
  vault id, so the listing does not reveal what has been watched), and it is securely deleted when
  the page leaves the screen, when the vault locks, when the app is backgrounded, and again when
  the vault is next opened -- which covers the app being killed mid-playback. `readFullImage`
  refuses a video outright rather than allocating it as a buffer.
- **Saving to the gallery is the other exception, and it is the user asking for one.** "Save" in
  the viewer decrypts the item into that same `<app cache>/playback/` directory and hands the file
  to MediaStore, which copies it into the gallery; the scratch file is securely deleted in a
  `finally`, so a refused or failed export leaves nothing behind. What it produces is a plaintext
  copy outside the vault, no longer covered by the PIN, by `FLAG_SECURE`, or by any of the
  erasures below -- the confirmation says exactly that before anything is decrypted. The vault
  keeps its own encrypted copy; an export is a copy, not a move.
- The export asks for permission *before* it decrypts, so a refused prompt never materialises
  plaintext. It asks `writeOnly`, which on Android 13+ resolves to no permission at all --
  MediaStore needs none for content the app itself created -- and below that to
  `WRITE_EXTERNAL_STORAGE` alone, which the library's manifest caps at `maxSdkVersion="32"`. The
  read side of the media library stays in `blockedPermissions`: `READ_MEDIA_IMAGES` and
  `READ_MEDIA_VIDEO` would let the app enumerate the user's own photos, would appear on the Play
  listing of an app presenting itself as a calculator, and are not needed to add a file.
  `expo-media-library`'s own config plugin adds all of them, which is why it is not registered;
  `plugins/withMediaLibraryWriteOnly.js` is, and `test/mediaLibraryWriteOnly.test.js` fails if
  that ever drifts.
- Picture-in-picture and background playback are disabled in the config plugin, so the manifest has
  no PiP activity and no background-audio capability. A PiP window is drawn by the system outside
  the app, where `FLAG_SECURE` does not reach.
- Recordings are silent. The camera is opened with `mute`, and `RECORD_AUDIO` stays in
  `blockedPermissions`, so the microphone is never opened and the permission is not in the shipped
  manifest.
- A recording is reviewed before it is stored, played from the cache file CameraX already wrote.
  That file is securely deleted when the video is kept, when it is discarded, when the sheet is
  closed (including mid-recording, which also stops the recorder), and on the unmount a vault lock
  causes.
- The camera and the photo picker do produce plaintext temp files, because the OS hands them over
  that way. Those are read, encrypted, and then securely deleted in a `finally`, whether or not the
  import succeeded.
- A capture is reviewed before it is stored. The temp file is still deleted immediately; the bytes
  are held in memory and shown back as an in-memory `data:` URI, never as a file. They are zeroed
  when the photo is kept, when it is discarded, when the sheet is dismissed, and on the unmount a
  vault lock causes -- so a pending review cannot outlive the session.
- The thumbnail pipeline uses the platform image codecs, whose `saveAsync` writes a plaintext JPEG
  to the cache directory. That file is securely deleted the moment its bytes have been read.
- Capture inspection downscales the capture through those same codecs to sample its pixels before
  anything is stored. The probe it writes is a plaintext JPEG and is securely deleted in a
  `finally`, and the probe bytes are zeroed, exactly like the capture itself. A frame that is
  truncated or blank is discarded rather than encrypted: the vault is the only copy, so storing a
  black rectangle would lose the photo silently.

## Secure deletion

One pass of pseudo-random bytes written in place over the file's own blocks, then unlink. On flash
storage with wear levelling the controller may retain stale copies, so this is best effort and is
documented as such: it removes the easy recovery path rather than guaranteeing erasure. For vault
blobs the contents were ciphertext anyway.

## Four different erasures

These are routinely confused, including by people who built the thing. They remove different
amounts, and only one of them is the one this app documents.

|                           | Local vault, PIN, settings | Overwritten first | Keystore key  | Cloud backup                                |
| ------------------------- | -------------------------- | ----------------- | ------------- | ------------------------------------------- |
| Android **Clear Data**    | gone                       | **no**            | **survives**  | untouched                                   |
| SilentSum **in-app wipe** | gone                       | yes               | entry deleted | untouched (unless the scope says otherwise) |
| **Uninstall**             | gone                       | no                | destroyed     | untouched                                   |
| **Delete backup account** | unchanged                  | n/a               | unchanged     | gone                                        |

### Android Clear Data / Clear Storage

Settings -> Apps -> SilentSum -> Storage -> Clear Data empties the app's data directory. That
takes the document directory (`files/vault/` and the settings JSON), the SharedPreferences that
expo-secure-store writes into, the cache, and the Firebase SDK's persisted auth session. So the
credential record goes, and with it the wrapped master key, the stored PIN and the wipe PIN; the
encrypted media and the index go; the settings go and the app returns to its first-run state,
signed out. The old PIN afterwards opens nothing, because the wrapped key it would unwrap no
longer exists.

**It does not delete the cloud backup.** Nothing about Clear Data reaches Firestore or Cloud
Storage. The envelope and the encrypted blobs are exactly where they were, and are still
restorable with the account password and the recovery passphrase. That is the intended behaviour
-- it is what makes a lost or reset phone survivable -- but it means Clear Data is not a way to
make the photos go away.

**It is not equivalent to the in-app wipe**, for two reasons, and neither is theoretical:

- Clear Data unlinks files. It does not perform the overwrite pass described under
  [Secure deletion](#secure-deletion). The old `SecureStore` SharedPreferences file and the old
  `.enc` blobs may therefore remain in unallocated blocks.
- The Android Keystore key that encrypts those SharedPreferences is keyed to the app and is NOT
  removed by Clear Data. So the key that could decrypt a recovered copy of that file is still on
  the device -- and the record inside it carries the PIN in cleartext as well as the wrapped
  master key.

Together those mean Clear Data leaves a recovery path that the in-app wipe closes. It needs
physical access and low-level flash recovery on an unlocked device, and wear levelling limits
what even the in-app overwrite can promise -- but the difference is real and should not be
described away.

### Uninstall

Removes everything Clear Data removes, and additionally destroys the Keystore entries, since
those are scoped to the package. The blocks are still not overwritten, but nothing on the device
can decrypt them any more. `allowBackup: false` means no OS backup copy exists to restore from
either. Uninstalling is therefore strictly stronger than Clear Data, and weaker than the in-app
wipe only in that it skips the overwrite.

### The in-app wipe, and deleting the backup account

The in-app wipe is the one described under [Forgetting the PIN](#forgetting-the-pin) and
[The wipe PIN](#the-wipe-pin): ordered steps, decrypted temporaries first, an overwrite pass
before each unlink, and the secure-store entries deleted explicitly. It stops at the device
boundary unless a wipe PIN scope says otherwise.

Deleting the backup account is the only thing that removes the cloud copy, and it removes nothing
locally. See [Cloud backup](#cloud-backup).

## Lifecycle

- Auto-lock after a configurable time in the background (immediately, 30 s, 1, 5 or 15 minutes;
  default 1 minute), measured on the monotonic clock.
- A deliberate hand-off to a system UI, the photo picker or a permission dialog, suspends the timer
  for a bounded five-minute grace window, so importing a photo cannot lock the vault underneath the
  user. A genuinely long absence still locks.
- A privacy curtain covers the app whenever it is not in the foreground, so the app-switcher
  snapshot never contains vault content.
- Android sets `FLAG_SECURE` while unlocked, which blocks screenshots and screen recording and
  blanks the recents preview. iOS has no equivalent; the curtain and auto-lock are the mitigation.
- Sessions are never persisted, so a process restart always starts locked.
- The calculator entry is cleared when the app leaves the foreground, so a half-typed PIN is never
  in the switcher.

## Cloud backup

Off by default and entirely optional.

- Requires an explicit action, a Firebase account, and a recovery passphrase of at least 12
  characters. The account credential and the PIN are separate secrets on purpose: the account
  cannot open the vault, and the PIN is never uploaded.
- Uploaded: `index.enc`, `photos/<id>.enc`, `thumbs/<id>.enc` exactly as they exist on disk, plus a
  `BackupEnvelope` holding the master key wrapped under Argon2id(passphrase, 64 MiB).
- Never uploaded: the PIN, the master key in the clear, any plaintext image.
- **The cloud copy only ever grows. Local deletions do NOT propagate.** A photo removed on the
  device stays in the backup, and `disable()` — "Turn off backup and delete cloud data", explicit,
  confirmed and total — is the only thing that removes anything from it.

  This reverses the original design, where deleting locally deleted remotely so a backup could
  never resurrect something removed on purpose. That is the better property for privacy and the
  wrong one for a backup: the phone is the copy that gets lost, stolen, wiped or mis-tapped, and a
  backup that faithfully reproduces an accidental deletion has failed at its only job. The cost is
  real and belongs here rather than in a footnote: a photo you delete on the device is still in the
  cloud afterwards.

  `backupNow` therefore uploads the union of the device's index and the cloud's, not the device's
  alone — which is why it takes the keys, since merging means decrypting the cloud's copy. Keeping
  a blob whose index entry had been dropped would be worse than deleting it: bytes nobody could
  ever restore, that look like safety. A decryption failure while merging is not swallowed; it
  means those keys do not belong to that account's backup, and carrying on would strand the blobs
  the index no longer named.

- An erase of the whole local vault does not touch the cloud either: forgetting the PIN signs the
  device out, because that copy is the only way back.
- **Restoring comes in two shapes, and they are not interchangeable.** Settings -> Cloud backup ->
  _Restore from backup_ pulls the cloud copy down into a vault that is already open: it is additive
  and idempotent, skips every id the vault already holds, and never deletes or overwrites anything
  locally. The locked calculator's _Forgot PIN?_ route instead rebuilds a vault that is gone, and
  has to re-wrap the recovered key under a new PIN chosen on that device.

  The in-vault restore verifies the passphrase by unwrapping the envelope, then compares the
  recovered master key against the key the open vault is running on, in constant time. They differ
  whenever the backup predates an erase-and-recreate, which is the ordinary state of affairs after
  a wipe, a forgotten PIN or a new phone.

  That case is **handled, not refused**. Producing the passphrase that unwraps the envelope is
  proof of ownership, and "the right passphrase, and nothing happens" is not an acceptable answer
  to someone trying to get their photos back. `restoreForeignInto` decrypts each item with the
  backup's key and re-encrypts it with the vault's on the way in — ids and metadata preserved, so a
  second run skips rather than duplicates, and `importEncrypted` still authenticates everything
  against the vault's keys before storing it. The vault keeps its own key and its existing photos
  throughout; the re-encryption runs in the direction that touches only the incoming items.

  A video cannot be re-encrypted in a buffer, so it goes down to a file, is decrypted with the
  backup's key, re-encrypted with the vault's, and only then handed over. The middle file is
  plaintext video in app-private cache — the same exposure `readVideoToFile` already accepts for
  playback — and all three scratch files are securely deleted in a `finally`, including on a failed
  import.

  `rebindBackup` then re-points the account at the vault's key: every blob re-uploaded, the index
  and manifest rewritten, and the envelope rewrapped **last**, so it only ever claims a key the
  rest of the account is already using. The passphrase does not change. Without this step the next
  `backupNow` could not read its own index. There is a crash window between the first re-upload and
  the new envelope where a restore from another device would fail; nothing is lost when it happens,
  because this device holds every photo, and turning backup off and on rebuilds the account.

  The recovered key is zeroed in a `finally` on every path.

- Security rules restrict every path to the token's uid, validate the envelope and manifest shapes,
  and bound object size and content type. App Check is activated.
- Without the passphrase the backup is useless to anyone, including the operator.

## Telemetry

- Crash reporting is on by default and can be turned off. Every free-text field passes through a
  scrubber that redacts 4-8 digit runs and file paths. PINs, photo ids and file names are never
  logged.
- Analytics is off by default and opt-in. Only five coarse event names with no identifiers are ever
  sent. Advertising ID collection is disabled in the manifest.

## Customer service

Settings -> Customer service writes to a support inbox over HTTPS. It is the only request this app
makes that the user starts by hand, and it is optional in the same way cloud backup is: a build
with no `SUPPORT_FROM`/`SUPPORT_TO` says on the screen that support is not set up rather than
offering a form that goes nowhere.

- Nothing is sent until Send is pressed. There is no queue, no background retry and no draft kept
  after a send. A failed send leaves the text on screen and does nothing else.
- Sent: the topic, what the user typed, an optional reply address, and - unless the switch is
  turned off - four lines of app details shown verbatim on the screen first (app version, platform
  and OS version, whether cloud backup is configured and on).
- Never sent: any photo, thumbnail, file name, path, key, PIN, device id, install id or account.
  The app details carry no identifier, so two messages cannot be linked to one person by content.
- The free text passes through the same scrubber as crash reports (`src/utils/scrub.ts`): 4-8 digit
  runs and path-shaped strings are removed. A user who types their PIN into the box cannot send it.
- The subject is `Calculator support: <topic>`. The reply arrives in the user's own inbox, where
  the product name would give the app away; the operator's inbox already knows what it is about.
- The endpoint must be `https`; a plaintext one is refused at parse time rather than downgraded.
- The screen is inside the vault, so it is reachable only after unlocking. A user locked out of
  their own vault cannot use it, which is the same trade the rest of the app makes.

The transport is a POST to this project's own `silentsumSupportRelay` function, which holds the mail
provider's API key in Secret Manager and picks the recipient from its own configuration. The body
keeps the provider's field names because the relay forwards them, but a `from` or `to` in it is
discarded server-side: honouring either would make a public endpoint an open mail relay for the
verified domain. The app carries no credential, and a provider's own API host is refused as an
endpoint, so the arrangement this replaced cannot return through configuration.

## Payments and entitlements

SilentSum Pro (₱299 once, permanent) and SilentSum Cloud (₱99 per 30-day term) are sold through
PayMongo and recorded in Firebase. `docs/billing.md` has the full design; the security properties:

- **The client is never trusted.** The app never holds a PayMongo key, never calls PayMongo, and
  has no code path that tells the server what it owns. Entitlements are written only by the Cloud
  Functions (Admin SDK) after PayMongo's signed webhook confirms a payment, or after the same
  functions have asked PayMongo directly ("I have paid"). The rules let the owner read
  `users/<uid>/billing/entitlements` and let no client write it.
- **The webhook is verified over the raw bytes** with the webhook secret (HMAC-SHA256 of
  `"<t>.<body>"`, constant-time compare, 5-minute replay window, live/test signature chosen by the
  event's own mode, events from the other mode ignored).
- **Every payment is applied once.** Webhook event ids and PayMongo payment ids are both recorded
  in server-only ledgers; the payment ledger entry and the entitlement change are one Firestore
  transaction. Retries, duplicate event types and the reconciliation path all collapse onto it.
  A second Pro payment is recorded as already-owned and changes nothing.
- **Amounts and identities come from the server's own records.** A checkout session is filed
  under the uid and product it was created for; the webhook body may agree with that record but
  never replace it, and the paid amount must equal the server price.
- **Pro and Cloud are independent fields.** No transition touches both. Cloud lapsing is derived
  from a date (`cloud.accessUntil`), never scheduled, and the security rules compare that date
  with `request.time` to gate backup writes; reads and deletes are never gated, so a lapsed account
  can always take its data out and delete itself.
- **The offline mirror is a mirror.** The last entitlement document seen is cached in the secure
  store so Pro works with no network. Nothing on the server reads it and the rules never trust it;
  editing it on a rooted phone unlocks local features on that phone only. It is erased with the
  vault and restored by signing in.
- **Nothing about Pro or Cloud appears on the calculator, the ⋮ menu or the disguised About
  page.** The plans screen is reachable only from inside the vault and from the restore flow. The
  post-checkout return page names no product and echoes nothing from its URL.
- **The vault, the PIN, the throttle, recovery codes, the wipe PIN and every erase path are
  unchanged.** A build with no billing behaves exactly as before, with every feature open.

## Verified on device

A release build was installed on an Android 16 emulator and driven end to end. What was confirmed
by inspecting the device rather than by reading the code:

- The vault lives at `/data/data/<package>/files/vault` with mode `0700`, and every file starts
  with the `SSV1` header carrying its key id: `53 53 56 31 01 01` for a photo, `...0102` for a
  thumbnail, `...0103` for the index.
- No JPEG signature appears anywhere in those files.
- After a capture, the camera and image-manipulator cache directories are empty. The plaintext
  temp files both of them produce were securely deleted.
- `Pictures` and `DCIM` are empty, and nothing on shared storage names the app or the vault.
- No preferences file contains the PIN. The secure-store entry is itself AES-GCM ciphertext under
  an Android Keystore alias, and none of the field names of the credential record inside it
  (`salt`, `kdf`, `wrapped`, `pinLength`) are readable from outside.
- The window carries `FLAG_SECURE` while the vault is open, and does not once it is locked.
- Typing a wrong PIN and pressing equals shows the arithmetic result and nothing else.
- The system camera permission dialog names the app "Calculator".
- With "Super secure" on (Settings), the calculator's menu holds nothing but About, so nothing on
  that screen suggests the app is anything else. The menu button itself stays: a calculator has
  one, and an app whose only exit is an undocumented gesture strands the person entitled to get
  in. "Forgot PIN?" is removed from the menu AND from the shortcut under the unlock notice, so
  there is no second door. Super secure is ignored in the two states where no PIN is being
  protected: no vault configured (the menu is the only route to setup), and a credential record
  that cannot be decoded (no PIN can open anything, so erase is the only exit left).
- About is reachable from the locked calculator, which is why customer service lives there: it
  gives the configured support address and states plainly that support cannot unlock a vault,
  reset or look up a PIN, or decrypt a backup. There is no form, no identity check and no path
  that ends in access.

## Known limitations

- The calculator confirms contiguous parts of the PIN, says how many digits are missing, and
  opens once the confirmed parts cover the PIN; the PIN is stored in the platform secure store to
  make that possible. Both are described under "Unlocking: parts that add up" and are the
  dominant limitation of this build: the PIN can be assembled a digit at a time by anyone holding
  the phone, and a reader of the secure store learns it without any derivation.
- JavaScript cannot pin memory or reliably zero every copy a garbage collector has made. Buffers
  are zeroed on lock as a best effort. The PIN string itself is immutable and released to the
  collector.
- Argon2id runs synchronously on the JS thread through a JSI call, so setup and unlock briefly
  stall the UI. Screens render a busy state and yield a frame first. The Flutter build used a
  background isolate and did not have this stall.
- The `SSV1` container binds the key id but not the photo id, so two blobs of the same kind could
  be swapped on disk without failing authentication. Confidentiality is unaffected; a future
  `SSV2` can add the id to the associated data.
- Cloud downloads use a rules-checked download URL, which mints a bearer token valid until the
  object's tokens are rotated. The payload is ciphertext either way.
- The wrapped key lives in the platform secure store, which is the strongest portable primitive
  available here. There is no hardware attestation of the app itself.
- The disguise is behavioural, not forensic. Anyone who inspects the installed binary can tell what
  the app is.
- An exported item leaves the vault's control completely. Once MediaStore holds the copy, deleting
  the vault item, locking, wiping or uninstalling does nothing to it, and any app with media
  permissions can read it. That is what the feature is for and the confirmation says so, but it
  is the one action in the app that cannot be undone from inside it. Whatever EXIF the original
  carried, including GPS, travels with the copy: the bytes written are the original file, not a
  re-encode.
- The support relay (`silentsumSupportRelay`) is unauthenticated. It has to be: a user locked out of
  the vault is the one who most needs to write in, and the vault has no account they could sign in
  with. What bounds it is that it can send to exactly one address — its own configured `to`, with any
  `from` or `to` in the request body discarded — and that it is rate limited per caller and in total
  per window. The per-caller bucket is keyed on `X-Forwarded-For`, which a caller can set, so it is
  the *total* that actually holds. Requiring an App Check token would narrow this further and is the
  obvious next step; it needs a token the app does not currently attach to that request.
- A credential compiled into the app is readable by anyone who unzips the APK, exactly like any other
  string in the bundle. This project shipped a `SUPPORT_API_KEY` in `extra` until the relay replaced
  it, and the lesson is structural rather than procedural: there is now no field to put one in,
  `app.config.ts` reads no key, `parseSupportConfig` refuses a mail provider as an endpoint, and
  `npm run security:scan` fails if either changes. The scan still cannot see what an operator puts in
  their own `.env`, which is why the config no longer has anywhere for it to go.
