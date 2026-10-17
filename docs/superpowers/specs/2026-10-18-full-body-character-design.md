# Full-body character: onboarding & persistent Settings presence — design spec

## Context

Following the overlay character ("Oshi," see
`2026-10-17-overlay-character-design.md`), the product direction extends the
same character to two more places:

1. **Onboarding** (`src/components/onboarding/SetupWizard.tsx`): redesign the
   presentation of the existing 6-step wizard around the character guiding
   you through it — inspired by Wispr Flow's "ask what you'll use it for,
   then demonstrate it live" onboarding philosophy, but **not a copy**: our
   version has the character itself carry that role (presenting the choice,
   listening while you practice, celebrating at the end) rather than a
   separate cycling-app-icons demo widget.
2. **Regular app usage**: a persistent instance of the character in a fixed
   spot in the Settings window, reacting to simple app-wide state (idle,
   busy).

## Decisions made during brainstorming

1. **Same character, two renderers.** The overlay face (`CharacterFace.tsx`,
   already shipped) and this full-body version must read as the same
   character — same proportions, same eyes/antenna, same brand colors
   (`--color-logo-primary` / `--color-logo-accent`). The overlay face stays
   Canvas2D (needs continuous per-frame reactivity to mic level at a tiny
   size). The full-body character uses **inline SVG + CSS transitions**
   instead — it has a handful of discrete poses that change occasionally,
   not continuous audio-reactive motion, so SVG is the better fit: crisper
   at a larger size, easier to art-direct distinct poses, simpler to
   fade/swap between states than redrawing a canvas every frame. Same rule
   as before: hand-coded, no Rive/Lottie/image assets.
2. **Onboarding scope: presentation only, not the flow.** The wizard's 6
   steps, their order, and their underlying logic (`SetupWizard.tsx`'s
   `step`/`purpose`/`picked`/`choice` state, the model-download flow, the
   `finish()` settings writes) are unchanged. Only how each step is
   *presented* changes: the plain `<h1>` step title becomes a speech-bubble
   next to the character, and the character's pose changes per step.
3. **Regular-usage placement: fixed spot in Settings.** The Sidebar
   (`src/components/Sidebar.tsx`) is a persistent 160px column present on
   every Settings screen (logo top, nav icons below, no footer today). The
   character anchors to the bottom of that column (`mt-auto`), always
   visible regardless of which section is open.
4. **Regular-usage states: kept to v1 scope.** Only two states for now:
   - **Idle** — default.
   - **Busy** — any model is downloading, verifying, or extracting
     (`useModelStore`'s `downloadingModels` / `verifyingModels` /
     `extractingModels` maps are non-empty).
   A third state — "meeting active," driven by the existing `meeting-status`
   event — is an obvious, cheap follow-up once this ships, not part of this
   plan.
5. **Out of scope:** `AccessibilityOnboarding.tsx` and
   `MicrophoneOnboarding.tsx` (the OS permission-gate screens that run
   before the wizard) are unchanged — they're permission mechanics, not
   conversational wizard steps, and were never part of this discussion.
   Also out of scope: changing the wizard's questions, options, or order.

## Visual concept

The full-body version of the character from the earlier reference image
(round head, big eyes, glowing antenna tip, now with a body/arms/legs),
redrawn as the same character already established for the overlay:
- Body: `--color-logo-primary`.
- Eyes, antenna, and accent glows: `--color-logo-accent`.
- Same rounded-pebble head shape and antenna-with-glowing-tip as
  `CharacterFace.tsx`, scaled up with a simple rounded body and
  stub arms/legs — simple enough to redraw cleanly as a handful of discrete
  poses rather than needing a rigging/skeleton system.

## Poses

| Pose | Used in | Description |
|---|---|---|
| `idle` | Sidebar (default), onboarding `languages`/`cleanup` steps | Neutral stance, gentle idle animation (blink, slight sway via CSS) |
| `busy` | Sidebar (model downloading/verifying/extracting), onboarding `quality` step | A "working" stance — reused identically in both places |
| `presenting` | onboarding `purpose` step | Gestures toward the options being shown |
| `listening` | onboarding `practice` step | Attentive stance; reacts to the practice textarea having content vs. being empty (two sub-states, not continuous audio reactivity — this isn't the overlay face) |
| `happy` | onboarding final (`cleanup`'s "done" action) | A small celebration pose |

## Technical approach

- **New component**: `src/components/character/FullBodyCharacter.tsx`.
  Props: `{ pose: "idle" | "busy" | "presenting" | "listening" | "happy"; size?: number }`.
  Renders inline SVG; pose changes cross-fade via CSS transition on opacity
  between pose variants (or a single SVG with CSS class toggles per pose —
  implementation detail for the plan, not pinned here). Respects
  `prefers-reduced-motion` the same way `CharacterFace.tsx` now does: skip
  spatial motion (sway, gesture animation), keep state changes (which pose
  is showing) since that's information, not decoration.
- **Sidebar integration**: `Sidebar.tsx`'s outer `flex flex-col` column gets
  `<FullBodyCharacter pose={isBusy ? "busy" : "idle"} />` with `mt-auto`,
  where `isBusy` is derived from `useModelStore`'s three download-state maps
  (`Object.keys(downloadingModels).length > 0 || ...verifyingModels... || ...extractingModels...`).
- **Onboarding integration**: `SetupWizard.tsx`'s `shell()` helper (currently
  just the logo + children) gains the character alongside the step content,
  with `pose` selected by the current `step` value (and, for the `practice`
  step specifically, by whether `practice.trim()` is non-empty — `listening`
  vs. a more neutral idle-within-listening variant, left as an implementation
  choice). The existing per-step `<h1>` becomes a speech-bubble UI element
  next to the character instead of a centered page title.
- **No new dependencies, no backend/Rust changes** — this is frontend-only,
  reusing signals (`useModelStore`, wizard `step` state, `practice` text)
  that already exist.

## Out of scope / explicitly deferred

- Meeting-active as a third Sidebar state (cheap follow-up, not in this spec).
- Accessibility/Microphone onboarding screens.
- Changing the wizard's question content, options, or order.
- Full-body character appearing anywhere other than Settings (e.g. in the
  overlay itself, which stays the existing `CharacterFace.tsx`).
