# Oshi 3D Character — Design Spec

## Context

Oshabe's character ("Oshi") currently exists as two independent, hand-coded
implementations:

- `src/overlay/CharacterFace.tsx` — a Canvas2D head-only face, driven by
  `characterAnimation.ts`'s `computeCharacterFrame(phase, level, elapsedMs)`,
  shown in the dictation overlay pill (`phase: "arming"|"listening"|"working"|"error"`).
- `src/components/character/FullBodyCharacter.tsx` — an inline SVG full-body
  character, posed via `Pose = "idle"|"busy"|"presenting"|"listening"|"happy"`,
  shown in the Settings sidebar (`Sidebar.tsx`) and the onboarding wizard
  (`SetupWizard.tsx`, via `wizardPose.ts`'s `poseForStep`).

Both were built flat (gradients/SVG shapes, no outlines) based on an earlier
reference image. The user rejected that direction after seeing it rendered:
it read as generic and lifeless next to the actual reference they wanted —
a cel-shaded, thick-outlined, big-eyed sticker character (comparable to
Coucou's "Mochi") that moves continuously and reacts live to the cursor and
voice, not a small set of static discrete poses.

A prototype was built and iterated with the user over several rounds inside
this session, each round rendered server-side (Playwright + a software
WebGL fallback) and compared pixel-by-pixel against the user's reference
image before being shown. The user approved the final round
("Hmmmm, this looks good, we can work with it."). This spec turns that
approved prototype into the shipped implementation.

## Goal

Replace both existing character implementations with one shared, real-time
3D character module, matching the prototype's visual style and behavior,
wired to Oshabe's actual app state (not simulated state).

## What the prototype already settled (not open questions)

- **Rendering technique:** three.js, `MeshToonMaterial` with a 3-step
  gradient map (flat cel shading) + an inverted-hull outline pass (a
  back-face-culled, normal-extruded duplicate mesh) for the thick line
  style. No external 3D asset files — the whole rig is built from
  primitives (spheres, capsules, cylinders, a torus) in code, matching the
  project's existing "no Rive/Lottie/image assets, hand-coded" rule for the
  character, just in three.js instead of SVG.
- **Face:** not geometry — a curved patch of a slightly-larger sphere
  textured with a 2D canvas (`MeshBasicMaterial`, unlit) that's redrawn
  per-frame only when its inputs actually change (eyes, mouth, blush are
  drawn with Canvas2D each time the expression state changes, memoized
  against a cache key so idle frames don't redraw it).
- **Palette:** warm cream shell, dark plum face gradient, pink-lavender
  ears/antenna/chest accents, cream eye crescents with a dark iris and
  white sparkle, thin plum outline — adapted from the reference image's
  cream/lavender into colors close to it (not Oshabe's existing
  indigo/amber brand pair, which read cold and plasticky against this
  style in the earlier gradient attempt).
- **Rig:** single root group (feet-anchored, for jump/squash), legs, torso,
  chest ring, two arms (shoulder-pivoted), neck→head pivot, head shell,
  face visor patch, two ears, antenna with glow tip. A `headOnly` variant
  hides everything but the head/neck and reframes the camera, for the
  overlay.
- **Behavior loop** (all already implemented and user-approved in the
  prototype, `oshi3d.js`):
  - Continuous idle motion: breathing scale pulse, blinking (with an
    occasional double-blink), an occasional idle hop, a resting head tilt.
  - Gaze: head and eyes track the cursor position (`pointermove` on
    `window`, converted to a normalized direction); falls back to a slow
    autonomous wander when the cursor hasn't moved in 4s, or to a fixed
    look direction for `thinking`/`sleeping`.
  - Voice-reactive: a `setLevel(0..1)` input drives antenna glow, eye
    scale, mouth-open amount, and a chance of small hops while
    `state === "listening"`.
  - Squash-and-stretch jump physics (a small spring simulation: velocity,
    gravity, a squash spring that reacts to landing impact).
  - Hover: bigger eyes, a wave gesture, a floating heart emote.
  - Click: a squish + "annoyed" `>< ` face + spark emote; three clicks
    within 0.7s → "dizzy" (spinning eyes, spinning head, a floating "?").
  - Floating emote sprite beside the head: "…" (thinking), "zZ"
    (sleeping), sparkles (happy), hearts (hovered), "?" (dizzy), spark
    marks (annoyed) — drawn on a small canvas, cross-faded in/out.
  - `prefers-reduced-motion`: scales rotation/gesture magnitude down
    (`motion = 0.25`) rather than removing animation outright, consistent
    with the project's established reduced-motion rule (freeze spatial
    motion, never state/expression changes).
  - Pauses its render loop entirely on `document.hidden` (via
    `visibilitychange`), and exposes a `dispose()` that removes listeners,
    disposes all three.js resources, and removes the canvas.

These are implementation facts carried over from the approved prototype,
not decisions this spec reopens.

## What this spec decides

### 1. Module boundary and file layout

- `src/character/oshi3d.ts` — the rendering/behavior module, a direct TS
  port of the prototype's `oshi3d.js` (same `createOshi(container, options)`
  factory, same public API: `setState`, `setLevel`, `poke`, `.state`,
  `dispose()`). Pure DOM + three.js, no React. Shared between the main
  window and the overlay window's bundles (both Vite entries import from
  `src/character/`).
- `src/character/OshiCharacter.tsx` — the one React wrapper, used
  everywhere. Props:
  ```ts
  interface OshiCharacterProps {
    state: OshiState; // "idle" | "listening" | "thinking" | "happy" | "sad" | "sleeping"
    level?: number; // 0..1, meaningful only while state === "listening"
    variant?: "full" | "head"; // default "full"
    size?: number; // CSS px, square; default 96 for "full" (FullBodyCharacter.tsx's existing default), 22 for "head" (CharacterFace.tsx's existing SIZE constant)
    className?: string;
  }
  ```
  It owns a `useRef<HTMLDivElement>`, creates the `oshi3d` instance on
  mount via `useEffect`, calls `setState`/`setLevel` on prop changes
  (never recreating the instance for a state/level change — only
  `variant` recreates it), and calls `dispose()` on unmount.
- `src/character/OshiFallback.tsx` — a static 2D fallback (see §4).
- Deleted: `src/overlay/CharacterFace.tsx`, `src/overlay/CharacterFace.css`,
  `src/overlay/characterAnimation.ts` (+ its `.test.ts`),
  `src/components/character/FullBodyCharacter.tsx`,
  `src/components/character/FullBodyCharacter.css`,
  `src/components/character/pose.ts` (+ its `.test.ts`).
- `src/components/onboarding/wizardPose.ts` is kept but its return type
  changes from `Pose` to `OshiState` (see §2); `wizardPose.test.ts` is
  updated to match, not deleted — it's the one piece of real, testable
  logic in this whole feature.

### 2. State mapping (replacing `Pose` and `CharacterPhase`)

One shared `OshiState` type (exported from `oshi3d.ts`) replaces both of
the old enums:

```ts
type OshiState = "idle" | "listening" | "thinking" | "happy" | "sad" | "sleeping";
```

- **Sidebar** (`Sidebar.tsx`): `isAppBusy(...)` (unchanged helper) maps
  `true → "thinking"`, `false → "idle"`. ("busy" is renamed to map onto
  "thinking" since that's the closest existing animated state — no new
  visual state is introduced here.)
- **Onboarding** (`wizardPose.ts`): `poseForStep` keeps its exact
  switch/signature, only the return values change:
  `"purpose" → "happy"` (replaces old "presenting" — there is no
  presenting gesture in the new rig; "happy" best matches "welcoming,
  explaining"), `"languages" → "idle"`, `"quality" → isDownloading ?
  "thinking" : "happy"`, `"practice" → "listening"`,
  `"cleanup" → justFinished ? "happy" : "idle"`, `"advanced" → "idle"`.
  This is a judgment call (the old "presenting" pose doesn't exist
  anymore); flagged here rather than silently decided in the plan.
- **Overlay** (`RecordingOverlay.tsx`): the existing `CharacterPhase` prop
  is replaced by `OshiState` at the call site:
  `"arming" → "idle"`, `"listening" → "listening"`, `"working" →
  "thinking"`, `"error" → "sad"`. The existing `level` prop (already a
  0..1 number from the real `mic-level` Tauri event, see
  `RecordingOverlay.tsx:122`) passes straight through to
  `OshiCharacter`'s `level` prop — this is real microphone level, not
  simulated, unlike the prototype's demo page.
- `"sleeping"` has no caller yet (no feature currently tracks "idle for a
  while" at the app level) — included in the shared type for forward
  compatibility (it was part of the approved prototype's state set) but
  not wired to anything in this plan. Not a new feature to build.
- Cursor-follow and hover/click reactions are intrinsic to
  `OshiCharacter`/`oshi3d.ts` itself (global `pointermove`, local
  `pointerenter`/`pointerleave`/`pointerdown`) — nothing in Sidebar,
  SetupWizard, or RecordingOverlay needs to wire these; they come for
  free wherever `<OshiCharacter>` is rendered.

### 3. Bundle cost and where it's paid

Both Vite entries (`main`, `overlay` — see `vite.config.ts`) import from
`src/character/`, so both the main settings window and the small overlay
pill window pay the three.js bundle cost (~150KB gzipped, per the
prototype's own disclosure to the user). This is accepted: the overlay
already loads React/ReactDOM for the existing Canvas2D face, and the
character is the overlay's entire visual content, so the relative cost is
the same order of magnitude as what's already shipped there. `three` is
added as a normal `package.json` dependency and imported through Vite's
normal bundling (no CDN/importmap — the prototype's demo page used a CDN
import map only because it's a throwaway Artifact page; the app's CSP is
`script-src 'self'`, so production code was always going to import `three`
as an npm package, same as every other dependency).

### 4. WebGL unavailability fallback

`OshiCharacter` wraps `oshi3d.ts`'s `createOshi()` call in a `try/catch`
(three.js's `WebGLRenderer` constructor throws when no WebGL context is
obtainable, which is the documented failure mode on some Linux setups per
AGENTS.md's platform notes). On failure, it renders `OshiFallback`
instead: a static version of the character's "idle" face — reusing the
cel-shaded art direction as a single flat SVG (ears, antenna, cream head,
plum face patch, resting eyes, no animation) — sized and positioned
identically to where the 3D canvas would sit, so layout doesn't shift.
This is a new, small, one-pose SVG (not a resurrection of the deleted
`FullBodyCharacter.tsx`), built once as part of this work. No retry logic
(a context that fails once will keep failing for the session); no user
facing error message (silent, graceful degrade — a missing mascot
animation is not an error state worth interrupting the user over).

### 5. Privacy cue: eyes closed during secure text entry

When the user is typing into a password field anywhere on the system,
Oshi closes its eyes and looks down rather than watching the cursor —
a small, tasteful "I'm not looking" gesture rather than anything that
reads as an alert or warning.

- **Signal:** macOS Secure Input, which the backend already monitors for
  `SecureInputWarning.tsx` (`secure-input-changed` event,
  `SecureInputStatus.enabled: boolean` — the live, momentary check, not
  `sustained`, which exists for that banner's different purpose of
  filtering out normal password-field focus). No new backend work: this
  reuses the existing monitor and event, just a second, independent
  listener on the same event.
- **Platform scope:** macOS only, because that's the only OS-level signal
  this codebase has for "a secure field has focus" — the same constraint
  `SecureInputWarning.tsx` already lives with. Windows/Linux: no listener
  fires, Oshi behaves exactly as it does today. Not simulated, not
  guessed at for other platforms.
- **Where it's wired:** inside `OshiCharacter.tsx`, not `oshi3d.ts` and
  not duplicated at each call site. `oshi3d.ts` stays app-agnostic (per
  §1's module boundary — no Tauri imports in the rendering module);
  `OshiCharacter.tsx` already sits in app code with Tauri available, the
  same way it already owns translating props into `setState`/`setLevel`
  calls. It subscribes to `secure-input-changed` once on mount and calls
  a new `setModest(enabled: boolean)` method on the `oshi3d` instance
  (sibling to the existing `setState`/`setLevel`/`poke`). Because the
  wrapper is reused everywhere, this is automatic in the Sidebar,
  onboarding, and the overlay alike — including mid-dictation, if the
  user's focus happens to land on a password field while Oshi is in the
  overlay pill.
- **Visual behavior:** reuses the character's existing closed-eye draw
  (already built for blinking and `sleeping`) plus a light blush and a
  slight downward head tilt; no new floating emote, no color change, no
  antenna/glow change. It overrides whatever `state`-driven expression
  is currently showing, but a live `poke` reaction (annoyed/dizzy) still
  wins if both happen at once — this sits at the same priority tier as
  the prototype's existing hover/click reaction overlay, not above it.
- **Not in scope here:** detecting "secret-looking" text the user is
  dictating or typing within Oshabe itself (that's a text-content
  classification problem, unrelated to this OS-level signal, and was not
  asked for) — this is specifically about the OS reporting that a secure
  field has focus elsewhere on the system.

### 6. Testing and verification

Three.js rendering cannot be unit-tested with this repo's existing
convention (plain `bun <file>.test.ts` scripts, no jsdom/canvas mocking
infrastructure, no headless-browser test runner in the project). This
spec does not introduce one. What is tested:

- `wizardPose.test.ts` (updated for the new return type) — pure logic,
  same as today.
- `OshiState` mapping functions, if any are extracted as pure functions
  (e.g. if the Sidebar's busy→state mapping or the overlay's phase→state
  mapping become named functions rather than inline ternaries) get the
  same plain-script unit tests as every other pure function in this
  codebase.
- `oshi3d.ts` itself is explicitly **not** unit-tested — it was verified
  during the design phase via the Playwright-rendered comparison against
  the reference image (documented above), and that verification method
  does not carry into the shipped codebase (no headless-Chromium
  dependency is being added to the test suite). Manual verification in a
  running `bun run tauri dev` session (both windows, both themes, hover/
  click/voice interactions) is required before this is considered done,
  consistent with every other UI change in this project history that
  could not be verified in this sandbox.

### 7. i18n

No new user-facing strings. The existing `aria-label="Oshabe"` on the
character root carries over unchanged (not translated today, matching the
prototype and the character's existing treatment as a decorative/branded
element rather than an interactive control with instructions).

## Non-goals (explicitly out of scope for this spec)

- The app-wide visual redesign (Nottr-inspired Meetings page, Google
  Calendar integration, Oshi's dictation-triggered reminder suggestion)
  discussed earlier in this session — separate spec(s), not started.
- A "sleeping" trigger (idle-for-N-minutes detection) — the state exists
  in the type for forward compatibility only, per §2.
- Cursor-tracking was previously deferred by the user for the old SVG
  character; it ships here because it's intrinsic to the approved
  prototype's behavior, not because the earlier deferred request is being
  picked back up as a separate feature.
