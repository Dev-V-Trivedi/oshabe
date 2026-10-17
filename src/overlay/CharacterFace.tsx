import React, { useEffect, useRef } from "react";
import {
  computeCharacterFrame,
  type CharacterFrame,
  type CharacterPhase,
} from "./characterAnimation";

// Overlay character ("Oshi"): a small canvas-drawn face that replaces the
// waveform bars / spinner. Hand-coded (no Rive/Lottie/image assets), reads
// colors live from the existing CSS custom properties so it follows the
// app's light/dark theme automatically.

const SIZE = 22;
const BODY_RADIUS = 7;

function draw(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  frame: CharacterFrame,
): void {
  const styles = getComputedStyle(canvas);
  const primary = styles.getPropertyValue("--color-logo-primary").trim() || "#4338ca";
  const accent = styles.getPropertyValue("--color-logo-accent").trim() || "#ffb224";

  ctx.clearRect(0, 0, SIZE, SIZE);

  // Antenna: a thin line with a glowing tip, above the head.
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(SIZE / 2, 3);
  ctx.lineTo(SIZE / 2 + 3, 0);
  ctx.stroke();
  ctx.globalAlpha = 0.4 + 0.6 * frame.antennaGlow;
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(SIZE / 2 + 3, 0, 1.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  // Head: a rounded-rectangle pebble, tilted per frame.tilt.
  ctx.save();
  ctx.translate(SIZE / 2, SIZE / 2 + 2);
  ctx.rotate((frame.tilt * Math.PI) / 24);
  ctx.translate(-SIZE / 2, -(SIZE / 2 + 2));
  ctx.fillStyle = primary;
  ctx.beginPath();
  ctx.roundRect(2, 5, SIZE - 4, SIZE - 7, BODY_RADIUS);
  ctx.fill();

  // Eyes: height follows eyeOpenness.
  const eyeHeight = Math.max(1, 5 * frame.eyeOpenness);
  const eyeY = SIZE / 2 + 2 - eyeHeight / 2;
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.roundRect(SIZE / 2 - 5, eyeY, 2.4, eyeHeight, 1.2);
  ctx.roundRect(SIZE / 2 + 2.6, eyeY, 2.4, eyeHeight, 1.2);
  ctx.fill();
  ctx.restore();
}

export default function CharacterFace({
  phase,
  level,
}: {
  phase: CharacterPhase;
  level: number;
}): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const phaseRef = useRef(phase);
  const levelRef = useRef(level);
  const phaseStartRef = useRef(performance.now());

  // Reset the phase clock only when the phase actually changes, so
  // elapsedMs passed to computeCharacterFrame means "time in this phase".
  useEffect(() => {
    if (phaseRef.current !== phase) {
      phaseStartRef.current = performance.now();
    }
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    levelRef.current = level;
  }, [level]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const reducedMotionQuery = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    );
    let rafId: number | null = null;

    const renderFrame = () => {
      const elapsedMs = performance.now() - phaseStartRef.current;
      const frame = computeCharacterFrame(
        phaseRef.current,
        levelRef.current,
        elapsedMs,
      );
      draw(ctx, canvas, frame);
    };

    const loop = () => {
      renderFrame();
      rafId = requestAnimationFrame(loop);
    };

    const start = () => {
      if (rafId !== null) return;
      if (reducedMotionQuery.matches) {
        renderFrame();
      } else {
        loop();
      }
    };
    const stop = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    };

    start();
    const handleReducedMotionChange = () => {
      stop();
      start();
    };
    reducedMotionQuery.addEventListener("change", handleReducedMotionChange);

    return () => {
      stop();
      reducedMotionQuery.removeEventListener(
        "change",
        handleReducedMotionChange,
      );
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      width={SIZE}
      height={SIZE}
      style={{ width: SIZE, height: SIZE, flex: "none" }}
      aria-hidden="true"
    />
  );
}
