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
