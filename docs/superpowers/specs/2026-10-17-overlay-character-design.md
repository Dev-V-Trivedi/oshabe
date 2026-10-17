# Overlay character ("Oshi") — design spec

## Context

Oshabe's recording overlay (`src/overlay/RecordingOverlay.tsx`) currently shows a
generic bar-graph waveform while listening and a spinner while transcribing —
visually indistinguishable from stock Handy. The product direction is to give
Oshabe its own visual identity, starting with a small animated character in the
overlay that reacts to dictation state, instead of (or alongside, see below) the
waveform bars.

Reference points gathered during design:

- **Coucou's "Mochi"**: a squircle-bodied character with sphere-projected eyes,
  hand-coded in SwiftUI `Canvas`/`TimelineView` (no Rive/Lottie/image assets),
  driven by a hidden → peek → open state machine, 0% CPU when hidden. Coucou is
  a direct competitor (its "Flow" section now covers dictation, notetaker,
  dictionary, snippets, styles — the same space as Oshabe), so our character
  must not read as a reskin of Mochi.
- **A user-supplied reference image**: a white rounded robot with a glowing
  antenna tip, large expressive eyes, glowing ear-discs and chest circle, and
  blush marks — full body, photoreal 3D render style.

## Decisions made during brainstorming

1. The character **replaces** the waveform bars entirely — its own motion is
   the audio-level feedback, not a supplement to a bar graph.
2. Visual identity takes the "cute robot" direction from the reference image
   (round head, big eyes, glowing antenna/accents), **not** an abstract blob —
   this reads as clearly distinct from Mochi's squircle-and-eyes silhouette.
3. The reference image will not be used verbatim (it's a photoreal 3D render);
   we build a simplified flat 2D/vector version with the same proportions,
   recolored to Oshabe's existing brand palette (`--color-logo-primary` /
   `--color-logo-accent` in `src/styles/theme.css`: indigo `#4338ca` + amber
   `#ffb224`, flipped in dark mode) instead of the reference's white/lavender.
4. **Scope for this spec: head/face only**, sized for the existing compact
   overlay bar. A full-body version (arms, legs) is explicitly out of scope
   here — it may be used later in a bigger surface (Settings empty state,
   onboarding, an "about" panel), but that is a separate future design, not
   part of this implementation.
5. Out of scope entirely for this spec: the "OK Oshabe" wake-word / voice
   activation idea (raised during this conversation) — that is a different
   subsystem (continuous background mic listening, on-device wake-word
   detection, its own privacy/consent UI) and will be designed separately.

## Visual concept

- Rounded head shape (not a squircle, not a perfect circle — a soft rounded
  rectangle/pebble, to keep the silhouette distinct from Mochi at a glance).
- Large expressive eyes (the primary expressive surface — see state table).
- A thin antenna with a glowing tip (color follows `--color-logo-accent`).
- Small glowing accent details (e.g. cheek/ear dots), subtle, using the
  existing brand accent color rather than the reference's lavender.
- Body color uses `--color-logo-primary`; glow accents use
  `--color-logo-accent`; both already flip automatically for dark mode via the
  existing CSS custom properties, so the character needs no separate theming
  logic of its own.

## States & behavior

Mapped to Oshabe's actual existing state model (`OverlayState`, `StreamPhase`,
`StreamWorkKind`, `captureReady`, `modelLoading` in `RecordingOverlay.tsx`):

| Existing signal | Character behavior |
|---|---|
| `!captureReady` (arming) | Eyes half-closed, slow blink; antenna dim |
| `captureReady`, listening, mic level from `mic-level` event | Eyes widen; antenna glow pulses with level — this is the waveform replacement |
| `streamText` arriving (streaming phase, phase=`listening`) | Subtle attentive tilt/nod per committed chunk |
| `phase === "working"`, `workKind === "transcribing"` | Eyes narrow slightly; antenna tip animates in a steady "thinking" loop |
| `phase === "working"`, `workKind === "polishing"` | Same "thinking" loop, label text already distinguishes this (no new character state needed) |
| `modelLoading && modelLoadSlow` | Thinking loop continues; no separate character state (existing "loading model" text notice stays as-is) |
| Transcription finalized / overlay about to hide | One quick happy bounce + antenna flash, then hides with the overlay |
| `meeting-error` / transcription error | Antenna flickers amber/red briefly; eyes do a short "confused" animation, replacing/accompanying the current error toast |

## Technical approach

- **New component**: `src/overlay/CharacterFace.tsx`. Props: `levels: number[]`
  (reuse the existing smoothed levels array), `captureReady: boolean`, `phase:
  "arming" | "listening" | "working" | "done" | "error"` (derived from existing
  state in `RecordingOverlay.tsx`, not a new backend signal).
- **Rendering**: Canvas2D (or inline SVG — implementation detail to confirm
  during planning) animated via `requestAnimationFrame`, with spring/easing
  interpolation for natural motion. No new npm dependency — mirrors Coucou's
  own "hand-coded, no Rive/Lottie/image assets" approach.
- **Integration points**: replace the `waveform` JSX block (`sbase` /
  `listeningRow`, `RecordingOverlay.tsx:231-242`) and the `sspinner` element
  (`workingRow`) with `<CharacterFace .../>`. Both call sites already sit in
  the same `sbase-l | center | sbase-r` grid, so no layout restructuring is
  needed.
- **Data**: every signal the character needs (`levels`, `captureReady`,
  `phase`, `workKind`) already exists in `RecordingOverlay.tsx` state — no new
  Tauri events or Rust changes required for this piece.
- **Performance**: animation runs only while the overlay is visible (same
  mount lifecycle as the current waveform); hidden/idle costs ~0% CPU.

## Out of scope / explicitly deferred

- Full-body character variant for Settings/dashboard surfaces.
- "OK Oshabe" wake-word voice activation.
- Any change to backend Rust code, Tauri events, or the meeting overlay's
  separate UI (this spec covers the single-dictation `RecordingOverlay.tsx`
  only; whether the meeting-recording overlay gets the same treatment is a
  follow-up decision).
