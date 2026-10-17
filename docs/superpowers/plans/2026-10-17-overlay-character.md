# Overlay Character Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the recording overlay's generic waveform bars and spinner with a small animated character ("Oshi") that reacts to dictation state, giving Oshabe a distinct visual identity.

**Architecture:** A pure, testable animation-state function computes the character's per-frame expression (eye openness, antenna glow, tilt) from existing overlay signals (mic level, phase). A new Canvas2D React component runs a `requestAnimationFrame` loop that calls that function and draws the character, reading colors from the app's existing CSS custom properties. It replaces the `waveform` and `sspinner` elements in `RecordingOverlay.tsx` at their existing call sites — no new backend signals, no new npm dependency.

**Tech Stack:** React + TypeScript, Canvas2D, existing Tauri event listeners already in `RecordingOverlay.tsx`.

**Spec:** `docs/superpowers/specs/2026-10-17-overlay-character-design.md`

## Global Constraints

- Hand-coded animation only — no Rive, Lottie, or image assets (spec: "Technical approach").
- Colors come from the existing CSS custom properties `--color-logo-primary` (body) and `--color-logo-accent` (antenna/glow accents), never hardcoded hex values, so light/dark theming stays automatic.
- Head/face only for this plan — no full-body variant (spec: scope item 4).
- No new Tauri events or Rust changes — every signal needed already exists in `RecordingOverlay.tsx` (spec: "Data").
- Animation must not run (no rAF loop, ~0% CPU) while the overlay is not visible, matching the existing `if (!isVisible) return null` lifecycle.
- Out of scope: "OK Oshabe" wake word, full-body character, meeting-overlay treatment (spec: "Out of scope").

## Review Focus

- **Theme switch mid-session**: if the OS switches light/dark while the overlay is open, the character's colors must follow — a value cached once at mount instead of re-read would leave it on the old theme.
- **Silence (mic level exactly 0)**: the animation math must not divide by zero or produce `NaN` when the smoothed level array is all zeros (the arming/silent case already exercised today).
- **Rapid phase changes**: events can arrive in a burst (e.g. arming → listening → working within the same tick); `computeCharacterFrame` must not throw or return `NaN` for any valid phase value, including a phase change mid-animation.
- **Overlay hidden mid-animation**: the `requestAnimationFrame` loop must be cancelled on unmount/hide every time, not just on a clean stop, or repeated dictation sessions leak animation frames.
- **`prefers-reduced-motion`**: neither Wispr Flow nor Coucou animate past the OS's reduce-motion setting; the character should degrade to a static (or minimally animated) frame when the user has that preference set, even though the spec doesn't say so explicitly.

---

## Task 1: Pure character animation logic

**Files:**
- Create: `src/overlay/characterAnimation.ts`
- Test: `src/overlay/characterAnimation.test.ts`

**Interfaces:**
- Produces: `CharacterPhase` type (`"arming" | "listening" | "working" | "error"`), `CharacterFrame` interface (`{ eyeOpenness: number; antennaGlow: number; tilt: number }`, all fields in `0..1` except `tilt` in `-1..1`), and `computeCharacterFrame(phase: CharacterPhase, level: number, elapsedMs: number): CharacterFrame`. Task 2 consumes all three.

- [ ] **Step 1: Write the failing tests**

```ts
// src/overlay/characterAnimation.test.ts
import assert from "node:assert/strict";
import { computeCharacterFrame } from "./characterAnimation";

// Arming: eyes mostly closed, no antenna glow, regardless of level.
let f = computeCharacterFrame("arming", 0, 0);
assert.ok(f.eyeOpenness < 0.4);
assert.equal(f.antennaGlow, 0);

// Listening at silence: eyes open but antenna glow at its floor.
f = computeCharacterFrame("listening", 0, 0);
assert.ok(f.eyeOpenness > 0.4);
assert.ok(f.antennaGlow >= 0 && f.antennaGlow <= 1);

// Listening at full level: antenna glow higher than at silence.
const quiet = computeCharacterFrame("listening", 0, 0).antennaGlow;
const loud = computeCharacterFrame("listening", 1, 0).antennaGlow;
assert.ok(loud > quiet);

// Working: antenna glow cycles over time (not constant across elapsedMs).
const a = computeCharacterFrame("working", 0, 0).antennaGlow;
const b = computeCharacterFrame("working", 0, 500).antennaGlow;
assert.notEqual(a, b);

// No NaN/throw for any phase at the extremes, including negative/overflowing input.
for (const phase of ["arming", "listening", "working", "error"] as const) {
  for (const level of [-1, 0, 0.5, 1, 5]) {
    for (const t of [0, 1, 1_000_000]) {
      const frame = computeCharacterFrame(phase, level, t);
      assert.ok(Number.isFinite(frame.eyeOpenness));
      assert.ok(Number.isFinite(frame.antennaGlow));
      assert.ok(Number.isFinite(frame.tilt));
    }
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun src/overlay/characterAnimation.test.ts`
Expected: FAIL (module `./characterAnimation` not found)

- [ ] **Step 3: Implement `computeCharacterFrame` in `src/overlay/characterAnimation.ts`**

Clamp `level` to `[0, 1]` before use. `eyeOpenness` follows the state table in the spec (arming: low/blinking, listening/working: open). `antennaGlow` for `listening` scales with `level`; for `working` it oscillates via a sine/triangle wave over `elapsedMs` (a steady "thinking" pulse, per spec); for `arming` it's `0`; for `error` pick a distinct short flicker pattern over `elapsedMs`. `tilt` is a small value driven by `level` for `listening` (the "attentive nod") and `0` otherwise. Export the `CharacterPhase` and `CharacterFrame` types alongside the function.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun src/overlay/characterAnimation.test.ts`
Expected: PASS (no output, exit code 0)

- [ ] **Step 5: Commit**

```bash
git add src/overlay/characterAnimation.ts src/overlay/characterAnimation.test.ts
git commit -m "feat: add pure animation logic for the overlay character"
```

---

## Task 2: `CharacterFace` canvas component

**Files:**
- Create: `src/overlay/CharacterFace.tsx`

**Interfaces:**
- Consumes: `CharacterPhase`, `CharacterFrame`, `computeCharacterFrame` from `src/overlay/characterAnimation.ts` (Task 1).
- Produces: `CharacterFace` component with props `{ phase: CharacterPhase; level: number }`, default export, for Task 3 to render in place of `waveform`/`sspinner`.

- [ ] **Step 1: Implement `CharacterFace({ phase, level }: { phase: CharacterPhase; level: number })` in `src/overlay/CharacterFace.tsx`**

A `<canvas>` sized ~22x22px (matches the `.sbase` 40px row height with room to spare, slightly larger than the current 13px spinner for presence). On mount, start a `requestAnimationFrame` loop; each frame, read `elapsedMs` since the current `phase` prop last changed (reset the start time in a `useEffect` keyed on `phase`), call `computeCharacterFrame(phase, level, elapsedMs)`, and draw: a rounded-rectangle/pebble head shape filled with the resolved `--color-logo-primary` color, two eyes whose height follows `eyeOpenness`, and a thin antenna with a tip circle whose opacity/fill follows `antennaGlow`, both using the resolved `--color-logo-accent` color. Resolve both CSS custom properties via `getComputedStyle` on the canvas element itself on every frame (not cached once), so a live theme switch is picked up (Review Focus: theme switch mid-session). Respect `window.matchMedia("(prefers-reduced-motion: reduce)")`: when set, skip the `requestAnimationFrame` loop and draw a single static frame instead (Review Focus: reduced motion). Cancel the animation frame in the effect's cleanup function on every unmount and on every `phase`/reduced-motion change, not only when the component is removed (Review Focus: overlay hidden mid-animation — this is the same effect cleanup, since the overlay already unmounts the whole tree via `if (!isVisible) return null`).

- [ ] **Step 2: Manual verification**

Run: `bun run dev` (or `bun run tauri dev`), trigger a dictation, and confirm the canvas renders and animates without console errors across arming → listening → working.

- [ ] **Step 3: Commit**

```bash
git add src/overlay/CharacterFace.tsx
git commit -m "feat: add CharacterFace canvas component"
```

---

## Task 3: Replace the waveform and spinner in `RecordingOverlay.tsx`

**Files:**
- Modify: `src/overlay/RecordingOverlay.tsx:231-242` (the `waveform` block), and the `sspinner` element inside `workingRow` (`src/overlay/RecordingOverlay.tsx:278-285`)
- Modify: `src/overlay/RecordingOverlay.css` (remove now-unused `.swave`/`.sspinner` rules only if nothing else references them — confirm with a repo-wide search before deleting)

**Interfaces:**
- Consumes: `CharacterFace` from `src/overlay/CharacterFace.tsx` (Task 2).

- [ ] **Step 1: Replace the `waveform` JSX block**

Change the `waveform` constant (currently rendering `<div className="swave">` with `levels.map(...)` bars) to render `<CharacterFace phase={captureReady ? "listening" : "arming"} level={Math.max(...levels, 0)} />`. `levels` is the existing smoothed per-bucket array; `Math.max` gives a single "how loud right now" signal from buckets already computed by the existing `mic-level` handler, without adding new smoothing logic.

- [ ] **Step 2: Replace the `sspinner` element in `workingRow`**

Change `<span className="sspinner" />` to `<CharacterFace phase="working" level={0} />`.

- [ ] **Step 3: Remove unused CSS**

Search the repo for other references to `.swave` and `.sspinner` (`grep -rn "swave\|sspinner" src`). If `RecordingOverlay.tsx` was the only consumer, delete those rule blocks from `RecordingOverlay.css`; otherwise leave them and note why in the commit message.

- [ ] **Step 4: Manual verification**

Run: `bun run tauri dev`, trigger a dictation end-to-end (arming → listening while speaking → working while it transcribes), and confirm the character — not bars or a spinner — is what's visible at each stage, with no layout shift in the pill/panel.

- [ ] **Step 5: Commit**

```bash
git add src/overlay/RecordingOverlay.tsx src/overlay/RecordingOverlay.css
git commit -m "feat: show the overlay character instead of the waveform and spinner"
```

---

## Known follow-up (not in this plan)

The spec's "done" (happy bounce) and "error" (confused flicker) character states need a product decision this plan doesn't have grounding for: today `hide-overlay` removes the overlay immediately (`RecordingOverlay.tsx:111-114`), and there is no dedicated error signal reaching this component at all. Showing a bounce/flicker means either briefly delaying the hide or adding a new error event — both are behavior changes beyond "swap the visual," so they're left for a follow-up plan once that timing/signal decision is made.
