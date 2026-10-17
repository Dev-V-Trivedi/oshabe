// Pure animation-state logic for the overlay character. Kept free of DOM/canvas
// APIs so it can be unit tested directly (see characterAnimation.test.ts) and
// consumed by CharacterFace's render loop.

export type CharacterPhase = "arming" | "listening" | "working" | "error";

export interface CharacterFrame {
  /** 0 (closed) to 1 (fully open). */
  eyeOpenness: number;
  /** 0 to 1. */
  antennaGlow: number;
  /** -1 to 1. */
  tilt: number;
}

/** Floor for the listening antenna glow, so silence still shows a faint glow
 * rather than a dead antenna. */
const LISTENING_GLOW_FLOOR = 0.15;
/** Period, in ms, of the "thinking" pulse shown while working. */
const WORKING_PULSE_PERIOD_MS = 800;
/** Period, in ms, of the short error flicker. */
const ERROR_FLICKER_PERIOD_MS = 150;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function computeCharacterFrame(
  phase: CharacterPhase,
  level: number,
  elapsedMs: number,
): CharacterFrame {
  const lvl = clamp01(level);
  const t = Number.isFinite(elapsedMs) ? elapsedMs : 0;

  switch (phase) {
    case "arming": {
      // Slow blink, always well under the "open" threshold.
      const blink = 0.2 + 0.1 * Math.sin(t / 450);
      return { eyeOpenness: clamp01(blink), antennaGlow: 0, tilt: 0 };
    }
    case "listening": {
      const antennaGlow = clamp01(
        LISTENING_GLOW_FLOOR + lvl * (1 - LISTENING_GLOW_FLOOR),
      );
      // A small attentive nod that leans with the level.
      const tilt = Math.max(-1, Math.min(1, (lvl - 0.5) * 0.6));
      return { eyeOpenness: 0.85, antennaGlow, tilt };
    }
    case "working": {
      const angle =
        ((t % WORKING_PULSE_PERIOD_MS) / WORKING_PULSE_PERIOD_MS) * Math.PI * 2;
      const antennaGlow = clamp01(0.5 + 0.5 * Math.sin(angle));
      return { eyeOpenness: 0.6, antennaGlow, tilt: 0 };
    }
    case "error": {
      const angle =
        ((t % ERROR_FLICKER_PERIOD_MS) / ERROR_FLICKER_PERIOD_MS) * Math.PI * 2;
      const antennaGlow = clamp01(0.5 + 0.5 * Math.sin(angle * 3));
      return { eyeOpenness: 0.3, antennaGlow, tilt: 0 };
    }
  }
}
