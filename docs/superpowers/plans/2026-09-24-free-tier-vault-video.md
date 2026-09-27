# Free-tier vault video Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a free vault hold video, bounded by the same 50-item limit as photos and a 100 MB per-item size cap, so that Cloud is never required to use local media.

**Architecture:** `vaultGate` stops discriminating by media kind entirely. The `video` gate reason disappears; a `fileSize` reason replaces it and applies on every tier. Callers pass the item's byte length instead of its kind. Everything else — the 50-item cap, the "adding only, never viewing" rule, the upsell dialog — keeps its existing shape.

**Tech Stack:** TypeScript (strict), Jest + jest-expo + React Native Testing Library, Expo SDK 57.

**Spec:** `docs/billing.md`, sections "The entitlement model" and "The limits".

## Global Constraints

- Free vault: **50 items**. A photo and a video each count 1. No separate video quota.
- Per-item file size: **100 MB** (`100 * 1024 * 1024`), enforced on **both** Free and Cloud.
- Video is allowed on Free. Buying **Pro must never** lift any vault limit; `vaultGate` must keep taking no Pro input.
- Gates apply to **adding** only. Nothing already in the vault may become unopenable because of a tier.
- Importing video *from the photo library* is out of scope. The library picker stays `mediaTypes: ['images']`; video reaches the vault through the camera, as it does today.
- Run `npx tsc --noEmit -p tsconfig.json`, `npm run lint` and `npx jest` before each commit. Lint must stay at 0 errors (3 pre-existing warnings are expected).

## Dependencies between the three plans

**Confirmed order: this plan → Plan 3 (chat media) → Plan 2 (500 MB allowance).** This plan is
first. It is entirely client-side, touches no rules and no functions, and closes the widest gap
between what `docs/billing.md` promises and what the app enforces — so it is the cheapest thing to
land and the one whose absence is most visible.

- **Nothing depends on it, and it depends on nothing.** `vaultGate` is not read by either other
  plan; neither plan's code is read here.
- **The 100 MB per-item cap it introduces is the same number** as the per-object Storage ceiling
  that Plan 2 leaves in place. That is not a coincidence and should stay true: an item that can
  enter the vault must also be small enough to be backed up, or a user could fill their vault with
  items that silently refuse to sync.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/billing/entitlements.ts` | `FREE_TIER`, `GateReason`, `vaultGate` | Modify |
| `src/billing/entitlementsController.ts` | `gate()` wrapper over `vaultGate` | Modify |
| `src/billing/screens/VaultUpsellDialog.tsx` | copy shown when a gate refuses | Modify |
| `src/camera/CameraSheet.tsx` | video tab gating + capture gate call | Modify |
| `src/gallery/GalleryScreen.tsx` | import gate call | Modify |
| `src/billing/products.ts` | Cloud tagline | Modify |
| `src/billing/screens/PlansScreen.tsx` | plan bullets | Modify |

---

### Task 1: `vaultGate` stops discriminating by kind

**Files:**
- Modify: `src/billing/entitlements.ts:218-241`
- Test: `src/billing/__tests__/entitlements.test.ts:155-180`

**Interfaces:**
- Consumes: nothing.
- Produces: `FREE_TIER: { maxItems: 50 }`; `MAX_ITEM_BYTES: number`; `type GateReason = 'itemLimit' | 'fileSize'`; `vaultGate(input: { cloudActive: boolean; enforced: boolean; itemCount: number; bytes: number }): GateDecision`.

- [ ] **Step 1: Replace the video cases in the existing test file**

Delete the three `kind: 'video'` cases at `src/billing/__tests__/entitlements.test.ts:161-176` and add:

```ts
describe('vaultGate', () => {
  const free = { cloudActive: false, enforced: true };

  it('allows video on the free tier, counted as one item like a photo', () => {
    expect(vaultGate({ ...free, itemCount: 49, bytes: 5_000_000 })).toEqual({ allowed: true });
  });

  it('refuses a 51st item whatever it holds', () => {
    expect(vaultGate({ ...free, itemCount: 50, bytes: 1 })).toEqual({
      allowed: false,
      reason: 'itemLimit',
    });
  });

  it('refuses an oversized item on the free tier', () => {
    expect(vaultGate({ ...free, itemCount: 0, bytes: MAX_ITEM_BYTES + 1 })).toEqual({
      allowed: false,
      reason: 'fileSize',
    });
  });

  // The size cap is about the device, not the plan, so paying does not lift it.
  it('refuses an oversized item with Cloud active too', () => {
    expect(
      vaultGate({ cloudActive: true, enforced: true, itemCount: 0, bytes: MAX_ITEM_BYTES + 1 }),
    ).toEqual({ allowed: false, reason: 'fileSize' });
  });

  it('lifts the item limit with Cloud, never with anything else', () => {
    expect(
      vaultGate({ cloudActive: true, enforced: true, itemCount: 999, bytes: 1 }),
    ).toEqual({ allowed: true });
  });

  it('gates nothing in a build that cannot sell', () => {
    expect(
      vaultGate({ cloudActive: false, enforced: false, itemCount: 999, bytes: MAX_ITEM_BYTES + 1 }),
    ).toEqual({ allowed: true });
  });

  it('skips the size check when the size is not yet known', () => {
    expect(vaultGate({ ...free, itemCount: 0, bytes: 0 })).toEqual({ allowed: true });
  });
});
```

Add `MAX_ITEM_BYTES` to the import from `@/billing/entitlements` at the top of that test file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/billing/__tests__/entitlements.test.ts -t vaultGate`
Expected: FAIL — `MAX_ITEM_BYTES` is not exported, and `vaultGate` still requires `kind`.

- [ ] **Step 3: Rewrite the gate**

In `src/billing/entitlements.ts`, replace lines 218-241:

```ts
export const FREE_TIER = { maxItems: 50 } as const;

/**
 * The largest single item the vault will take, on every tier.
 *
 * It is a device limit, not a plan limit, so paying does not lift it: the item is encrypted into
 * local storage whatever the account has bought. The number matches the per-object ceiling in
 * `firebase/storage.rules`, so anything that can enter the vault can also be backed up -- a user
 * can never create an item that is impossible to protect.
 */
export const MAX_ITEM_BYTES = 100 * 1024 * 1024;

export type GateReason = 'itemLimit' | 'fileSize';

export type GateDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: GateReason };

/**
 * Whether one more item may be added to the vault.
 *
 * Photos and video are the same thing here, deliberately: one item is one item, whatever it
 * holds, and a vault of fifty videos is a legitimate way to spend a free vault. The only thing
 * that distinguishes a video is its size, which `MAX_ITEM_BYTES` already bounds for both.
 *
 * There is no Pro input and there must never be one. The vault's size is a Cloud service; Pro
 * buys messaging. An expired term stops new additions and changes nothing already in the vault --
 * every photo, video and key stays exactly where it is, readable offline, forever.
 *
 * `bytes` is 0 when the size is not yet known (a capture that has not been written out). The size
 * check is then skipped here and made by the caller once the file exists.
 */
export function vaultGate(input: {
  readonly cloudActive: boolean;
  readonly enforced: boolean;
  readonly itemCount: number;
  readonly bytes: number;
}): GateDecision {
  if (!input.enforced) return { allowed: true };
  if (input.bytes > MAX_ITEM_BYTES) return { allowed: false, reason: 'fileSize' };
  if (input.cloudActive) return { allowed: true };
  if (input.itemCount >= FREE_TIER.maxItems) return { allowed: false, reason: 'itemLimit' };
  return { allowed: true };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/billing/__tests__/entitlements.test.ts -t vaultGate`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/billing/entitlements.ts src/billing/__tests__/entitlements.test.ts
git commit -m "feat(billing): allow video on the free tier, cap item size instead"
```

---

### Task 2: The controller passes size through

**Files:**
- Modify: `src/billing/entitlementsController.ts:103-110`
- Test: `src/billing/__tests__/entitlementsController.test.ts:238-265`

**Interfaces:**
- Consumes: `vaultGate`, `GateDecision`, `MAX_ITEM_BYTES` from Task 1.
- Produces: `EntitlementsController.gate(itemCount: number, bytes: number): GateDecision`. **Note the signature change**: the `kind` parameter is gone and `bytes` is now second.

- [ ] **Step 1: Replace the video cases in the controller test**

Delete the four `gate('video', …)` cases at `src/billing/__tests__/entitlementsController.test.ts:243-263` and add, inside the same describe:

```ts
it('allows video on a free account, and counts it as one item', async () => {
  const controller = await freeController();
  expect(controller.gate(0, 5_000_000)).toEqual({ allowed: true });
  expect(controller.gate(49, 5_000_000)).toEqual({ allowed: true });
  expect(controller.gate(50, 5_000_000)).toEqual({ allowed: false, reason: 'itemLimit' });
});

it('refuses an oversized item however the account has paid', async () => {
  const free = await freeController();
  expect(free.gate(0, MAX_ITEM_BYTES + 1)).toEqual({ allowed: false, reason: 'fileSize' });
  const cloud = await cloudController();
  expect(cloud.gate(0, MAX_ITEM_BYTES + 1)).toEqual({ allowed: false, reason: 'fileSize' });
});
```

Build the free and Cloud-active controllers exactly as the surrounding cases in that file already
do — it has an established way of seeding an entitlement document and refreshing the controller.
Follow it rather than introducing new helpers, and add `MAX_ITEM_BYTES` to the file's imports.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/billing/__tests__/entitlementsController.test.ts`
Expected: FAIL — `gate` still takes `(kind, itemCount)`.

- [ ] **Step 3: Change the wrapper**

In `src/billing/entitlementsController.ts`, replace the `gate` method:

```ts
  /** Whether one more item of `bytes` may be added when the vault already holds `itemCount`. */
  gate(itemCount: number, bytes: number): GateDecision {
    return vaultGate({
      cloudActive: this.isCloudActive(),
      enforced: this.deps.enforced,
      itemCount,
      bytes,
    });
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/billing/__tests__/entitlementsController.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/billing/entitlementsController.ts src/billing/__tests__/entitlementsController.test.ts
git commit -m "refactor(billing): gate by item size rather than media kind"
```

---

### Task 3: Upsell copy loses the video message

**Files:**
- Modify: `src/billing/screens/VaultUpsellDialog.tsx:22-30`
- Create: `src/billing/screens/__tests__/vaultUpsellDialog.test.tsx` — **`upsellMessage` has no test at all today.** It is exported and used by `VaultUpsellDialog.tsx` and `CameraSheet.tsx`, and nothing pins its wording. Create the file.

**Interfaces:**
- Consumes: `GateReason` from Task 1.
- Produces: `upsellMessage(reason: GateReason): string`.

- [ ] **Step 1: Write the failing test**

```tsx
describe('upsellMessage', () => {
  it('offers Cloud when the item limit is what stopped the addition', () => {
    expect(upsellMessage('itemLimit')).toMatch(/50 items/);
    expect(upsellMessage('itemLimit')).toMatch(/SilentSum Cloud/);
  });

  // A file too large for the device is not something a subscription fixes, so this copy must
  // not try to sell anything.
  it('does not offer a plan when the file is simply too large', () => {
    expect(upsellMessage('fileSize')).toMatch(/100 MB/);
    expect(upsellMessage('fileSize')).not.toMatch(/Cloud/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest -t upsellMessage`
Expected: FAIL — `upsellMessage` still branches on `'video'`.

- [ ] **Step 3: Rewrite the copy**

```tsx
export function upsellMessage(reason: GateReason): string {
  if (reason === 'fileSize') {
    return (
      `That file is larger than ${String(MAX_ITEM_BYTES / (1024 * 1024))} MB, which is the most ` +
      'the vault takes for a single item. Nothing else is affected.'
    );
  }
  return (
    `The free vault holds ${String(FREE_TIER.maxItems)} items and this one is full. Everything ` +
    'already here stays exactly where it is, with or without a subscription. ' +
    `${PRODUCTS.cloud.name} removes the limit; it is ${PRODUCTS.cloud.price}.`
  );
}
```

Then, in the component body, suppress the plans action for `fileSize`: the dialog offers **OK**
only, because no purchase changes the outcome. Pass `hideCancel` and an `OK` confirm label exactly
as the component already does when `onPlans` is undefined.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest -t upsellMessage`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/billing/screens/VaultUpsellDialog.tsx src/billing/screens/__tests__/
git commit -m "feat(billing): explain a too-large file without selling a subscription"
```

---

### Task 4: The camera stops gating video behind Cloud

**Files:**
- Modify: `src/camera/CameraSheet.tsx:154-156` (the `videoGated` derivation), `:313`, `:626`, `:643`
- Test: `src/camera/__tests__/cameraGate.test.tsx`

**Read this file before changing anything.** Its opening comment is *"The free tier at the camera:
video needs Cloud, and a full free vault takes no more photos"* — half of that file's premise is the
behaviour being removed. The video cases are not failing tests to fix; they are assertions of the
old model and must be rewritten. The item-limit cases stay exactly as they are and must keep
passing: a full free vault still refuses a capture, before anything is recorded.

Its harness is `buildServices`, `renderInVault` and `unlockedVault` from
`@/gallery/__tests__/vaultHarness`. Use those; do not introduce a new one.

**Interfaces:**
- Consumes: `EntitlementsController.gate(itemCount, bytes)` from Task 2.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Rewrite the video-gating cases in `cameraGate.test.tsx` — keeping that file's existing setup for a
free, unlocked vault — so they assert the opposite:

```tsx
it('offers video on a free account, with no Cloud marking', async () => {
  const rendered = await renderInVault(/* the file's existing free-tier setup */);

  expect(rendered.getByText('Video')).toBeTruthy();
  expect(rendered.queryByText('Video · Cloud')).toBeNull();
});

it('still refuses a capture when the free vault is full', async () => {
  // Unchanged behaviour, restated here because it shares the code being edited: the item
  // limit is what stops a capture now, and it must stop video exactly as it stops a photo.
  const rendered = await renderInVault(/* free vault already holding FREE_TIER.maxItems */);

  // …the file's existing assertion that no capture is attempted.
});
```

Also update that file's header comment: "video needs Cloud" is no longer true of this app.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/camera/__tests__/cameraSheet.test.tsx -t 'offers video'`
Expected: FAIL — the tab renders `Video · Cloud` for a free account.

- [ ] **Step 3: Remove the gate**

Delete the `videoGated` derivation at `:154-156` and its `cloudActive`/`vaultGate` imports if they
become unused. At `:643`, the label is unconditionally `option === 'photo' ? 'Photo' : 'Video'`.
At `:313` and `:626`, change the gate calls to the new signature, passing `0` for `bytes` — the
capture has not been written to a file yet, so its size is unknown at that point and the real size
check happens in Task 5:

```tsx
const gate = services.entitlements.gate(target.photos.length, 0);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/camera`
Expected: PASS. Any existing test asserting the `Video · Cloud` label must be updated in this same
step — that label is exactly the behaviour being removed.

- [ ] **Step 5: Commit**

```bash
git add src/camera/CameraSheet.tsx src/camera/__tests__/
git commit -m "feat(camera): video no longer requires a Cloud term"
```

---

### Task 5: Enforce the size cap before the file is read

**Files:**
- Modify: `src/gallery/GalleryScreen.tsx:108-126`, `src/gallery/importService.ts:86-90`
- Test: `src/gallery/__tests__/importService.test.ts`

**Interfaces:**
- Consumes: `MAX_ITEM_BYTES` from Task 1.
- Produces: `ImportReport` gains `readonly oversized: number` alongside `imported` and `failed`.

The size check cannot live where the gate is called. `importFromLibrary` learns an asset's size by
doing `fs.readBytes(asset.uri)`, which pulls the whole file into memory — checking after that point
means loading a 500 MB file in order to refuse it. Expo's picker asset carries `fileSize`, so the
check goes there, before the read.

- [ ] **Step 1: Write the failing test**

This file already has the helpers you need: `deps(services, launchImageLibrary, fs?)`,
`asset(uri, fileName)` returning an `ImagePickerAsset`, and `stageTempCopy(fs, name)`. Use them.
The `fs` parameter of `deps` is a `Pick<FileSystem, 'readBytes'>`, which is how you prove the file
was never read:

```ts
it('refuses an oversized asset without reading it', async () => {
  const services = buildServices();
  const readBytes = jest.fn();
  const staged = await stageTempCopy(services.fs, 'huge.jpg');
  const picked = { ...staged, fileSize: MAX_ITEM_BYTES + 1 };
  const service = new ImportService(
    deps(services, async () => ({ canceled: false, assets: [picked] }), { readBytes }),
  );

  const report = await service.importFromLibrary(repository, {});

  expect(report).toEqual({ imported: 0, failed: 0, oversized: 1 });
  // The point of the check: a 500 MB file must not be pulled into memory to be refused.
  expect(readBytes).not.toHaveBeenCalled();
});

it('imports an asset whose size the picker did not report', async () => {
  // Some providers omit fileSize. An unknown size is not evidence of a large one.
  const services = buildServices();
  const staged = await stageTempCopy(services.fs, 'ok.jpg');
  const service = new ImportService(
    deps(services, async () => ({ canceled: false, assets: [staged] })),
  );

  const report = await service.importFromLibrary(repository, {});

  expect(report.imported).toBe(1);
  expect(report.oversized).toBe(0);
});
```

`asset()` does not set `fileSize`, so the second test needs no change to it; the first spreads a
size onto the staged copy.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/gallery/__tests__/importService.test.ts -t oversized`
Expected: FAIL — `oversized` is not on `ImportReport` and the asset is read regardless of size.

- [ ] **Step 3: Skip oversized assets before reading**

In `src/gallery/importService.ts`, add `oversized` to `ImportReport`, initialise `let oversized = 0`
beside the other counters, and open the loop body with:

```ts
        // Checked from the picker's own metadata, before `readBytes` pulls the file into memory:
        // refusing a 500 MB video must not cost 500 MB of heap first. A provider that omits
        // `fileSize` is trusted -- an unknown size is not evidence of a large one.
        if (asset.fileSize !== undefined && asset.fileSize > MAX_ITEM_BYTES) {
          oversized += 1;
          continue;
        }
```

Return `{ imported, failed, oversized }` from both return points, including the early
`selectionLimit <= 0` return.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx jest src/gallery`
Expected: PASS. Existing assertions of the shape `{ imported: n, failed: m }` must gain
`oversized: 0` in this same step.

- [ ] **Step 5: Surface the count**

In `src/gallery/GalleryScreen.tsx`, update the gate call to the new signature and report oversized
assets to the user alongside failures, following whatever pattern the screen already uses for
`report.failed`:

```tsx
const gate = services.entitlements.gate(target.photos.length, 0);
```

- [ ] **Step 6: Run the full suite and commit**

```bash
npx tsc --noEmit -p tsconfig.json && npm run lint && npx jest
git add src/gallery/
git commit -m "feat(gallery): refuse oversized imports before reading them"
```

---

### Task 6: Move the advertised copy

**Files:**
- Modify: `src/billing/products.ts:36`, `src/billing/screens/PlansScreen.tsx`
- Test: `src/billing/screens/__tests__/plansScreen.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

The Cloud card still advertises "Video alongside photos" and the tagline still says "An unlimited
vault, video, and encrypted cloud backup". Both are now false: video is free.

- [ ] **Step 1: Write the failing test**

```tsx
it('does not sell video, which the free vault already has', async () => {
  const harness = buildBillingHarness();
  await signIn(harness);
  await renderPlans(harness);

  expect(screen.getByTestId('plans_cloud_features')).not.toHaveTextContent(/video alongside/i);
  expect(screen.getByTestId('plans_cloud_features')).toHaveTextContent(/unlimited/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx jest src/billing/screens/__tests__/plansScreen.test.tsx -t 'does not sell video'`
Expected: FAIL — the bullet still reads "Video alongside photos".

- [ ] **Step 3: Rewrite the copy**

In `src/billing/products.ts`, the Cloud tagline becomes:

```ts
    tagline: 'An unlimited vault and encrypted cloud backup.',
```

In `PlansScreen`, replace the Cloud bullet "Video alongside photos" with:

```tsx
  'Unlimited photos and videos — the 50-item limit is lifted',
```

and replace "Encrypted cloud backup and restore, and support chat" with:

```tsx
  'Unlimited cloud backup and restore, beyond the free 500 MB',
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx jest src/billing/screens/__tests__/plansScreen.test.tsx`
Expected: PASS.

- [ ] **Step 5: Update the docs and commit**

In `docs/billing.md`, delete the "Free tier has no video" bullet from "Not yet true" — it is now
true. Leave the other three bullets alone; they describe work this plan does not do.

```bash
npx tsc --noEmit -p tsconfig.json && npm run lint && npx jest
git add src/billing/ docs/billing.md
git commit -m "docs(billing): video is a free-tier feature, not a Cloud one"
```

---

## Out of scope

- The 500 MB backup allowance. Its own plan; nothing here depends on it.
- Chat media. Its own plan and spec.
- Importing video from the photo library. The picker stays images-only; this plan removes a gate,
  it does not add an import path. Raise it separately if you want it.
