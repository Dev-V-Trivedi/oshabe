# Oshi 3D Character Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two existing hand-coded character implementations
(`FullBodyCharacter.tsx`, `CharacterFace.tsx`) with one shared, real-time
three.js character module matching the user-approved prototype, wired to
real app state across the Sidebar, onboarding wizard, and dictation
overlay, including a WebGL fallback and the secure-input privacy cue.

**Architecture:** A pure DOM+three.js module (`oshi3d.ts`, a TS port of
the already-built and user-approved prototype) exposes
`createOshi(container, options)`. One React wrapper
(`OshiCharacter.tsx`) is reused at all three call sites, owning the
instance's lifecycle and translating props into the module's
`setState`/`setLevel`/`setModest` calls. A small static SVG
(`OshiFallback.tsx`) covers WebGL-unavailable environments.

**Tech Stack:** three.js (new dependency, `MeshToonMaterial` + inverted-hull
outlines, Canvas2D-textured face), React, TypeScript, Vite (existing
`main`/`overlay` dual entry points).

**Spec:** `docs/superpowers/specs/2026-10-17-oshi-3d-character-design.md`

## Global Constraints

- `bunx tsc --noEmit`, `bun run lint`, `bunx prettier --check .`,
  `cargo fmt --check` (from `src-tauri/`) must pass before every commit
  (per `AGENTS.md`).
- No new translation strings are introduced by this plan (per spec §7);
  `bun run check:translations` must still pass (nothing to add, nothing
  to break).
- `three` is added as a normal `package.json` dependency; no CDN/importmap
  in shipped code (CSP is `script-src 'self'`).
- `oshi3d.ts` must not import Tauri APIs or React — app-specific wiring
  (state props, the secure-input listener) lives in `OshiCharacter.tsx`
  only (spec §1, §5).
- Full `cargo check`/`cargo build` cannot complete in this sandbox
  (`ort-sys` network block, pre-existing, unrelated) — not a blocker for
  any task here since this plan is frontend-only; disclose, don't attempt
  to work around.
- No automated test exists for three.js rendering in this repo and this
  plan does not add one (spec §6) — every task touching `oshi3d.ts` or
  `OshiCharacter.tsx` is verified by `bunx tsc --noEmit` plus manual
  reasoning about the ported code against the approved prototype
  (`oshi3d_glossy_v1.js`/final version is not in the repo; the plan
  transcribes from the spec's documented behavior), not by a passing
  test suite claiming visual correctness.

## Review Focus

- **WebGL constructor throw is caught, not left to crash the window:**
  `OshiCharacter` must wrap instance creation in `try/catch` and fall back
  — an uncaught throw during `WebGLRenderer` construction would blank the
  whole Sidebar/onboarding/overlay, not just the character. Task 3's test
  covers this.
- **`dispose()` is called exactly once per mount, on unmount, not on every
  prop change:** a naive `useEffect([state, level])` would recreate (and
  leak) the three.js instance every frame during `listening` (where
  `level` changes continuously). Task 2's effect dependency array is the
  guard; called out explicitly since it's an easy mistake with no test to
  catch it (can't unit-test a three.js lifecycle here).
- **The overlay's `level` prop is real mic level, already 0..1** (spec
  §2, `RecordingOverlay.tsx:122`) — Task 6 must pass it straight through,
  not reintroduce a simulated/demo value from the prototype's demo page.
- **`setModest` must not fight an active `poke` reaction** (spec §5's
  stated priority: reaction wins over modest wins over state) — Task 7's
  test exercises both active at once.
- **Deleted files must have zero remaining importers** (Task 8) — a
  stale import left behind fails `tsc`, which is already a required gate,
  but it's called out because it's the one place a plain grep is cheaper
  than waiting for the type-checker.

---

## Task 1: Port the character engine to TypeScript

**Files:**

- Create: `src/character/oshi3d.ts`
- Modify: `package.json` (add `three` dependency)

**Interfaces:**

- Produces: `export type OshiState = "idle" | "listening" | "thinking" | "happy" | "sad" | "sleeping"`;
  `export function createOshi(container: HTMLElement, options?: { accent?: string; headOnly?: boolean; reduceMotion?: boolean }): OshiInstance`
  where

  ```ts
  interface OshiInstance {
    setState(name: OshiState): void;
    setLevel(level: number): void;
    setModest(on: boolean): void;
    poke(): void;
    readonly state: OshiState;
    dispose(): void;
  }
  ```

- [ ] **Step 1: Add the dependency**

Run: `bun add three@0.160.0 && bun add -D @types/three@0.160.0`
Expected: `package.json`/`bun.lock` gain `three` and `@types/three`.

- [ ] **Step 2: Write `src/character/oshi3d.ts`**

Port the approved prototype's behavior (documented in full in the spec's
"What the prototype already settled" section) into TypeScript: same rig
(root/legs/torso/chest/arms/neck/head/visor/ears/antenna/emote sprite),
same cel-shading materials (`MeshToonMaterial` + a 3-stop gradient map,
inverted-hull outline meshes), same Canvas2D face/emote drawing, same
behavior loop (gaze tracking, blink, squash-jump physics, hover/click
reactions with the 0.7s-triple-click dizzy window, idle hops, voice-level
reactivity). Add the two new pieces the prototype didn't have:

- `headOnly` as a constructor option (not a separate `variant` string —
  simpler boolean, since there are only two variants) controlling the
  same camera-reframe-and-hide-body behavior the spec describes.
- `setModest(on: boolean)`: when `on`, eyes closed (reuse the existing
  closed-eye draw path used for blink/sleep) + a light blush + a slight
  downward head-pitch target, overriding the state-driven face but
  yielding to an active `reaction` (per spec §5's priority order — modest
  sits between ambient state and a live poke reaction). Track it as an
  internal `modest: boolean` flag read inside `update()`, the same way
  `hovering` and `reaction` are already read.

Type every exported symbol; internal variables may stay inferred. No
JSX, no `@tauri-apps/*` imports in this file (Global Constraints).

- [ ] **Step 3: Type-check**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock src/character/oshi3d.ts
git commit -m "feat: port the 3D Oshi character engine to TypeScript"
```

---

## Task 2: React wrapper component

**Files:**

- Create: `src/character/OshiCharacter.tsx`

**Interfaces:**

- Consumes: `createOshi`, `OshiState` from `./oshi3d` (Task 1).
- Produces:

  ```ts
  interface OshiCharacterProps {
    state: OshiState;
    level?: number; // default 0
    headOnly?: boolean; // default false
    size?: number; // CSS px; default 96 if !headOnly, 22 if headOnly
    className?: string;
  }
  export default function OshiCharacter(
    props: OshiCharacterProps,
  ): React.ReactElement;
  ```

- [ ] **Step 1: Write the component**

A `useRef<HTMLDivElement>` container sized to `size`×`size` CSS px
(inline `style={{ width: size, height: size }}`), `aria-label="Oshabe"`
on the container (matches both predecessors' existing treatment).

One `useEffect` with `[headOnly]` as its dependency array creates the
instance via `try { instance = createOshi(el, { headOnly }) } catch { setFailed(true) }`
and returns a cleanup calling `instance.dispose()`. A second `useEffect`
with `[state]` calls `instance?.setState(state)`. A third with `[level]`
calls `instance?.setLevel(level ?? 0)`. The instance itself is held in a
ref (not state) so prop-driven effects don't retrigger the creation
effect — this is the Review Focus item on not recreating per frame.

When `failed` (WebGL threw), render `<OshiFallback size={size} className={className} />`
instead of the container div.

- [ ] **Step 2: Type-check**

Run: `bunx tsc --noEmit`
Expected: 0 errors (will also fail here if `OshiFallback` from Task 3
doesn't exist yet — if doing tasks in order, stub-check: run this step
again after Task 3's file exists, or do Task 3 first. Either order is
fine; this plan lists them in reading order, not a strict dependency).

- [ ] **Step 3: Commit**

```bash
git add src/character/OshiCharacter.tsx
git commit -m "feat: add the OshiCharacter React wrapper"
```

---

## Task 3: WebGL fallback

**Files:**

- Create: `src/character/OshiFallback.tsx`

**Interfaces:**

- Consumes: nothing beyond its own props.
- Produces: `export default function OshiFallback(props: { size: number; className?: string }): React.ReactElement`

- [ ] **Step 1: Write a static one-pose SVG**

A single `<svg>` (no `<style>` animation, no JS) reproducing the cel-shaded
"idle" look at rest: cream head/body silhouette, dark plum face patch,
resting (open, non-animated) eyes with the cream crescent + dark iris +
white sparkle, pink-lavender ears and antenna tip, light blush. Build it
by eye from the spec's palette (§1 "Palette") and the screenshots taken
during the design phase — this is new, hand-drawn SVG (not a port of the
deleted `FullBodyCharacter.tsx`, which had different proportions/style).
`width`/`height` from `size` prop, `aria-label="Oshabe"`.

- [ ] **Step 2: Type-check**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/character/OshiFallback.tsx
git commit -m "feat: add the static WebGL-unavailable fallback for Oshi"
```

---

## Task 4: Wire the Settings sidebar

**Files:**

- Modify: `src/components/Sidebar.tsx`

**Interfaces:**

- Consumes: `OshiCharacter` (Task 2), `OshiState` (Task 1), existing
  `isAppBusy` from `./character/pose` (kept until Task 8 deletes it —
  check Task 8's note on `pose.ts`).

- [ ] **Step 1: Replace the import and render**

Replace `import FullBodyCharacter from "./character/FullBodyCharacter"`
with `import OshiCharacter from "../character/OshiCharacter"` (path: this
file lives at `src/components/Sidebar.tsx`, the new module at
`src/character/`, so `../character/OshiCharacter`). Replace
`<FullBodyCharacter pose={busy ? "busy" : "idle"} />` with
`<OshiCharacter state={busy ? "thinking" : "idle"} />` (state mapping
per spec §2).

- [ ] **Step 2: Type-check**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/Sidebar.tsx
git commit -m "feat: show the 3D Oshi character in the Settings sidebar"
```

---

## Task 5: Wire the onboarding wizard

**Files:**

- Modify: `src/components/onboarding/wizardPose.ts`
- Modify: `src/components/onboarding/wizardPose.test.ts`
- Modify: `src/components/onboarding/SetupWizard.tsx`

**Interfaces:**

- Consumes: `OshiCharacter`, `OshiState` (Tasks 1-2).
- Produces: `poseForStep(step: Step, signals: WizardPoseSignals): OshiState`
  (same name/signature, new return type — `WizardPoseSignals` is
  unchanged).

- [ ] **Step 1: Update the failing test first**

Rewrite `wizardPose.test.ts`'s expected values to the spec §2 mapping:
`"purpose" → "happy"`, `"languages" → "idle"`,
`"quality"` → `"thinking"` if `isDownloading` else `"happy"`,
`"practice" → "listening"`, `"cleanup"` → `"happy"` if `justFinished`
else `"idle"`, `"advanced" → "idle"`. Keep the existing "Review Focus"
cases (isDownloading/justFinished must not leak into other steps) with
updated expected values.

- [ ] **Step 2: Run it to confirm it fails against the old implementation**

Run: `bun src/components/onboarding/wizardPose.test.ts`
Expected: FAIL (assertion mismatch — old code still returns `Pose` values
like `"presenting"`/`"busy"`).

- [ ] **Step 3: Update `wizardPose.ts`**

Change the import from `Pose` (`../character/pose`) to `OshiState`
(`../../character/oshi3d`), and update the switch's return values to
match Step 1's test exactly.

- [ ] **Step 4: Run it to confirm it passes**

Run: `bun src/components/onboarding/wizardPose.test.ts`
Expected: PASS (exit 0, no output).

- [ ] **Step 5: Wire `SetupWizard.tsx`**

Replace the `FullBodyCharacter` import/usage (`../character/FullBodyCharacter`
→ `../../character/OshiCharacter`) in the `shell()` helper with
`<OshiCharacter state={poseForStep(step, {...})} />`, same call-site
signals as today (`practiceHasText`, `isDownloading`, `justFinished`) —
only the import and the prop name (`pose` → `state`) change.

- [ ] **Step 6: Type-check and re-run the test**

Run: `bunx tsc --noEmit && bun src/components/onboarding/wizardPose.test.ts`
Expected: 0 type errors; test passes with no output.

- [ ] **Step 7: Commit**

```bash
git add src/components/onboarding/wizardPose.ts src/components/onboarding/wizardPose.test.ts src/components/onboarding/SetupWizard.tsx
git commit -m "feat: show the 3D Oshi character in the onboarding wizard"
```

---

## Task 6: Wire the dictation overlay

**Files:**

- Modify: `src/overlay/RecordingOverlay.tsx`

**Interfaces:**

- Consumes: `OshiCharacter`, `OshiState` (Tasks 1-2).

- [ ] **Step 1: Replace the import and both call sites**

Replace `import CharacterFace from "./CharacterFace"` with
`import OshiCharacter from "../character/OshiCharacter"`. At
`RecordingOverlay.tsx:233-236`, replace
`<CharacterFace phase={captureReady ? "listening" : "arming"} level={Math.max(...levels, 0)} />`
with `<OshiCharacter state={captureReady ? "listening" : "idle"} level={Math.max(...levels, 0)} headOnly size={22} />`
(mapping per spec §2: arming→idle, listening→listening; `level` passed
through unchanged — Review Focus item on this being real mic level, not
simulated). At line 276, replace `<CharacterFace phase="working" level={0} />`
with `<OshiCharacter state="thinking" headOnly size={22} />` (working→thinking
per spec §2; no `level` prop needed since it's not listening).

- [ ] **Step 2: Type-check**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/overlay/RecordingOverlay.tsx
git commit -m "feat: show the 3D Oshi character in the dictation overlay"
```

---

## Task 7: Secure-input privacy cue

**Files:**

- Modify: `src/character/OshiCharacter.tsx`

**Interfaces:**

- Consumes: `listen` from `@tauri-apps/api/event`, `SecureInputStatus`
  from `@/bindings` (both already used elsewhere in this codebase, e.g.
  `src/components/SecureInputWarning.tsx`).

- [ ] **Step 1: Subscribe inside the wrapper**

Add a `useEffect` (empty dependency array — subscribes once per mounted
instance, unsubscribes on unmount) that calls
`listen<SecureInputStatus>("secure-input-changed", (e) => instanceRef.current?.setModest(e.payload.enabled))`,
storing and calling the returned unlisten function on cleanup. This runs
unconditionally in every `OshiCharacter` instance (Sidebar, onboarding,
overlay alike) — per spec §5, no per-call-site wiring needed.

- [ ] **Step 2: Type-check**

Run: `bunx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/character/OshiCharacter.tsx
git commit -m "feat: close Oshi's eyes during secure text entry"
```

---

## Task 8: Delete the old character implementations

**Files:**

- Delete: `src/overlay/CharacterFace.tsx`
- Delete: `src/overlay/characterAnimation.ts`
- Delete: `src/overlay/characterAnimation.test.ts`
- Delete: `src/components/character/FullBodyCharacter.tsx`
- Delete: `src/components/character/FullBodyCharacter.css`
- Delete: `src/components/character/pose.ts`
- Delete: `src/components/character/pose.test.ts`

**Interfaces:**

- None — by this point (Tasks 4-6 complete) nothing imports these files.
  `Sidebar.tsx` used `isAppBusy` from `pose.ts`; verify Task 4 actually
  inlined or replaced that usage (if `isAppBusy` is still needed, move it
  into `Sidebar.tsx` directly or into `oshi3d.ts` as an exported helper
  before deleting `pose.ts` — a plain boolean busy-check has no reason to
  live in a file named after the deleted `Pose` type).

- [ ] **Step 1: Confirm no importers remain**

Run: `grep -rln "CharacterFace\|characterAnimation\|FullBodyCharacter\|character/pose" src/ --include=*.ts --include=*.tsx`
Expected: no output (Review Focus item — cheaper than waiting for `tsc`).
If `Sidebar.tsx` still imports `isAppBusy` from `./character/pose`, move
that function's definition into `Sidebar.tsx` (it's a 6-line pure
function — see its current body in `pose.ts`) before deleting the file,
then re-run this grep.

- [ ] **Step 2: Delete the files**

```bash
git rm src/overlay/CharacterFace.tsx src/overlay/characterAnimation.ts src/overlay/characterAnimation.test.ts src/components/character/FullBodyCharacter.tsx src/components/character/FullBodyCharacter.css src/components/character/pose.ts src/components/character/pose.test.ts
```

- [ ] **Step 3: Full verification sweep**

Run: `bunx tsc --noEmit && bun run lint && bunx prettier --check . && bun run check:translations`
Expected: all four pass with no errors.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore: remove the superseded hand-coded character implementations"
```

---

## Self-Review Notes

- **Spec coverage:** §1 (file layout) → Tasks 1-3, 8. §2 (state mapping)
  → Tasks 4-6. §3 (bundle cost) → accepted in Task 1's dependency add, no
  code decision needed. §4 (fallback) → Task 3 + Task 2's try/catch. §5
  (privacy cue) → Task 7. §6 (testing) → Global Constraints note, no task
  (nothing to add). §7 (i18n) → nothing to do, confirmed no task needed.
- **Type consistency:** `OshiState` is defined once in `oshi3d.ts` and
  imported everywhere else (Tasks 2, 4, 5, 6) — no duplicate/divergent
  type.
- **Proportion check:** this plan is about the length of the spec's
  decided-content sections, scoped to 8 small tasks matching the spec's
  own file-by-file breakdown — not a line-by-line transcription of
  `oshi3d.js`, which Task 2's Step 2 deliberately points at the spec's
  prose description rather than re-deriving the whole engine here.
