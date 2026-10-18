# Full-Body Character Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the full-body version of Oshabe's character to a persistent spot in the Settings sidebar and to a redesigned, character-led presentation of the existing onboarding wizard.

**Architecture:** A pure, testable `isAppBusy` helper and `poseForStep` mapping function decide which of five discrete poses the character shows; a new `FullBodyCharacter` SVG component renders a pose. Two call sites — `Sidebar.tsx` (persistent, idle/busy) and `SetupWizard.tsx` (per-step pose plus a speech bubble replacing the old `<h1>`) — consume it. No new dependencies, no backend changes.

**Tech Stack:** React + TypeScript, inline SVG + CSS transitions, existing `useModelStore` signals.

**Spec:** `docs/superpowers/specs/2026-10-18-full-body-character-design.md`

## Global Constraints

- Hand-coded SVG only — no Rive, Lottie, or image assets (spec: "Technical approach").
- Colors come from `--color-logo-primary` / `--color-logo-accent` CSS custom properties, never hardcoded hex (spec: "Visual concept").
- `prefers-reduced-motion` skips spatial motion (sway, gesture) only — pose changes (information) still happen regardless (spec: decision 1, matching `CharacterFace.tsx`'s established pattern).
- Onboarding's 6 steps, their order, and their underlying logic are unchanged — only presentation changes (spec: decision 2).
- No change to `AccessibilityOnboarding.tsx` or `MicrophoneOnboarding.tsx` (spec: decision 5 / out of scope).
- v1 Sidebar states are only `idle` and `busy` — no "meeting active" state (spec: decision 4).

## Review Focus

- **`isDownloading` true while on a step other than `quality`**: the quality-step busy pose must not leak into other steps just because a prior download is still finishing in the background.
- **`justFinished` true while not on the `cleanup` step**: the happy pose must only ever show on the step where "Done" was actually clicked, not retroactively on earlier steps.
- **The `advanced` step** (the `ModelPicker` fallback, reached via "choose myself"): it exists in the `Step` union but has no pose assigned in the spec's table — `poseForStep` must still return something reasonable, not throw or fall through unhandled.
- **`prefers-reduced-motion`**: `FullBodyCharacter` must suppress spatial motion the same way `CharacterFace.tsx` already does, not freeze entirely (the exact freeze bug already fixed once in the overlay character — don't reintroduce it here).
- **Empty `downloadingModels`/`verifyingModels`/`extractingModels` maps** (the common case — nothing downloading): `isAppBusy` must return `false`, not treat an empty object as truthy.

---

## Task 1: Pure pose logic

**Files:**

- Create: `src/components/character/pose.ts`
- Test: `src/components/character/pose.test.ts`

**Interfaces:**

- Produces: `type Pose = "idle" | "busy" | "presenting" | "listening" | "happy"`, `isAppBusy(downloading: Record<string, true>, verifying: Record<string, true>, extracting: Record<string, true>): boolean`. Tasks 2, 3, and 4 import `Pose` from this file; Task 3 imports `isAppBusy`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/components/character/pose.test.ts
import assert from "node:assert/strict";
import { isAppBusy } from "./pose";

assert.equal(isAppBusy({}, {}, {}), false);
assert.equal(isAppBusy({ "model-a": true }, {}, {}), true);
assert.equal(isAppBusy({}, { "model-a": true }, {}), true);
assert.equal(isAppBusy({}, {}, { "model-a": true }), true);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun src/components/character/pose.test.ts`
Expected: FAIL (module `./pose` not found)

- [ ] **Step 3: Implement `pose.ts`**

Export the `Pose` type. Implement `isAppBusy` as: true if any of the three
`Record` arguments has at least one key (`Object.keys(x).length > 0`),
false otherwise.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun src/components/character/pose.test.ts`
Expected: PASS (no output, exit code 0)

- [ ] **Step 5: Commit**

```bash
git add src/components/character/pose.ts src/components/character/pose.test.ts
git commit -m "feat: add pure pose type and busy-state helper"
```

---

## Task 2: `FullBodyCharacter` SVG component

**Files:**

- Create: `src/components/character/FullBodyCharacter.tsx`

**Interfaces:**

- Consumes: `Pose` from `src/components/character/pose.ts` (Task 1).
- Produces: `FullBodyCharacter` component with props `{ pose: Pose; size?: number }`, default export, for Task 3 and Task 4 to render.

- [ ] **Step 1: Implement `FullBodyCharacter({ pose, size = 96 }: { pose: Pose; size?: number })` in `src/components/character/FullBodyCharacter.tsx`**

An inline `<svg>` sized `size x size`. Reuse the established proportions
from `CharacterFace.tsx` (rounded-pebble head, antenna with glowing tip,
eyes) scaled up, with a simple rounded body and stub arms/legs added per
the spec's visual concept. Body fill uses `var(--color-logo-primary)`;
eyes/antenna/accents use `var(--color-logo-accent)` — set directly as SVG
`fill`/`stroke` attribute values (SVG resolves CSS custom properties
natively, so no `getComputedStyle` polling is needed here, unlike the
canvas-based `CharacterFace.tsx`). Render pose-specific markup via a
`switch (pose)` (e.g. arm position/rotation per pose, a `<title>`-adjacent
small speech-shape cue is NOT part of this component — the speech bubble
is onboarding-specific UI built in Task 4, not part of the character SVG
itself). Wrap spatial animation (idle sway, the `presenting` gesture) in a
CSS class applied only when
`!window.matchMedia("(prefers-reduced-motion: reduce)").matches`; pose
_changes_ (which SVG variant renders) always apply regardless of that
preference, per Global Constraints.

- [ ] **Step 2: Manual verification**

Run: `bunx tsc --noEmit` (full GUI verification isn't available in this
environment the same way it wasn't for `CharacterFace.tsx` — rely on a
type-check plus a careful manual trace of each pose's SVG against the
established proportions).

- [ ] **Step 3: Commit**

```bash
git add src/components/character/FullBodyCharacter.tsx
git commit -m "feat: add FullBodyCharacter SVG component"
```

---

## Task 3: Sidebar integration

**Files:**

- Modify: `src/components/Sidebar.tsx`

**Interfaces:**

- Consumes: `isAppBusy` from `src/components/character/pose.ts` (Task 1); `FullBodyCharacter` from `src/components/character/FullBodyCharacter.tsx` (Task 2); `useModelStore`'s `downloadingModels`/`verifyingModels`/`extractingModels` (already imported elsewhere in the codebase, e.g. `SetupWizard.tsx`).

- [ ] **Step 1: Add the character to the sidebar**

Import `useModelStore`, `isAppBusy`, and `FullBodyCharacter` into
`Sidebar.tsx`. Inside the component, read
`downloadingModels`/`verifyingModels`/`extractingModels` from
`useModelStore()` and compute
`isAppBusy(downloadingModels, verifyingModels, extractingModels)`. Render
`<FullBodyCharacter pose={busy ? "busy" : "idle"} />` as the last child of
the outer `flex flex-col` column (`Sidebar.tsx`'s current `<div
className="flex flex-col w-40 h-full ...">`), wrapped in a container with
`mt-auto` so it anchors to the bottom regardless of how many nav sections
are enabled.

- [ ] **Step 2: Manual verification**

Run: `bunx tsc --noEmit` and confirm no type errors; trace that `mt-auto`
on a `flex-col` parent pushes the new element to the bottom (standard
flexbox behavior — no new CSS needed beyond the existing Tailwind setup).

- [ ] **Step 3: Commit**

```bash
git add src/components/Sidebar.tsx
git commit -m "feat: show the full-body character in the Settings sidebar"
```

---

## Task 4: Onboarding integration

**Files:**

- Create: `src/components/onboarding/wizardPose.ts`
- Test: `src/components/onboarding/wizardPose.test.ts`
- Modify: `src/components/onboarding/SetupWizard.tsx`

**Interfaces:**

- Consumes: `Pose` from `src/components/character/pose.ts` (Task 1); `FullBodyCharacter` from `src/components/character/FullBodyCharacter.tsx` (Task 2); `SetupWizard.tsx`'s existing `Step` type (`"purpose" | "languages" | "quality" | "practice" | "cleanup" | "advanced"`).
- Produces: `poseForStep(step: Step, signals: { practiceHasText: boolean; isDownloading: boolean; justFinished: boolean }): Pose`, exported from `wizardPose.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/components/onboarding/wizardPose.test.ts
import assert from "node:assert/strict";
import { poseForStep } from "./wizardPose";

const base = {
  practiceHasText: false,
  isDownloading: false,
  justFinished: false,
};

assert.equal(poseForStep("purpose", base), "presenting");
assert.equal(poseForStep("languages", base), "idle");
assert.equal(poseForStep("quality", base), "presenting");
assert.equal(poseForStep("quality", { ...base, isDownloading: true }), "busy");
assert.equal(poseForStep("practice", base), "listening");
assert.equal(
  poseForStep("practice", { ...base, practiceHasText: true }),
  "listening",
);
assert.equal(poseForStep("cleanup", base), "idle");
assert.equal(poseForStep("cleanup", { ...base, justFinished: true }), "happy");
assert.equal(poseForStep("advanced", base), "idle");

// Review Focus: isDownloading must not leak into other steps.
assert.equal(
  poseForStep("practice", { ...base, isDownloading: true }),
  "listening",
);
assert.equal(
  poseForStep("languages", { ...base, isDownloading: true }),
  "idle",
);

// Review Focus: justFinished must not leak into other steps.
assert.equal(
  poseForStep("purpose", { ...base, justFinished: true }),
  "presenting",
);
assert.equal(
  poseForStep("practice", { ...base, justFinished: true }),
  "listening",
);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun src/components/onboarding/wizardPose.test.ts`
Expected: FAIL (module `./wizardPose` not found)

- [ ] **Step 3: Implement `wizardPose.ts`**

Import `Step` from `./SetupWizard` (or wherever it's exported from — check
the existing file; if `Step` isn't currently exported, export it as part
of this step) and `Pose` from `../character/pose`. Implement
`poseForStep` as a `switch (step)` matching the test cases above: `purpose`
→ `"presenting"`; `languages` → `"idle"`; `quality` → `"busy"` if
`signals.isDownloading` else `"presenting"`; `practice` → `"listening"`
(regardless of `practiceHasText` — the spec left that sub-state as an
implementation choice and this plan resolves it to "always listening
during practice"); `cleanup` → `"happy"` if `signals.justFinished` else
`"idle"`; `advanced` → `"idle"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun src/components/onboarding/wizardPose.test.ts`
Expected: PASS (no output, exit code 0)

- [ ] **Step 5: Wire the character and speech bubble into `SetupWizard.tsx`**

Add a `justFinished` boolean state (`useState(false)`), set to `true` at
the start of the `finish` handler before its existing logic runs. In the
`shell()` helper, replace the centered `OshabeTextLogo`-only header with a
layout that also renders `<FullBodyCharacter pose={poseForStep(step, {
practiceHasText: practice.trim().length > 0, isDownloading: choice !==
null, justFinished })} />` alongside a speech-bubble element. Replace each
step's `<h1>{t("onboarding.wizard.<step>Title")}</h1>` with that speech
bubble containing the same translated text — no new translation keys, same
`t()` calls, just a different wrapping element/class.

- [ ] **Step 6: Manual verification**

Run: `bunx tsc --noEmit` and confirm no type errors. `bun run
check:translations` to confirm no translation keys were broken (none
should be added or removed).

- [ ] **Step 7: Commit**

```bash
git add src/components/onboarding/wizardPose.ts src/components/onboarding/wizardPose.test.ts src/components/onboarding/SetupWizard.tsx
git commit -m "feat: character-led presentation for the onboarding wizard"
```
