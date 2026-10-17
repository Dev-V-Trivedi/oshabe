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

// `CanvasRenderingContext2D.roundRect` is a relatively recent addition and
// isn't guaranteed on every WebKitGTK (Linux) or older WKWebView (macOS)
// build this app runs on, so rounded rectangles are drawn manually with
// `arcTo`, which every Canvas2D implementation has always supported.
function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function draw(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  frame: CharacterFrame,
): void {
  const styles = getComputedStyle(canvas);
  const primary =
    styles.getPropertyValue("--color-logo-primary").trim() || "#4338ca";
  const accent =
    styles.getPropertyValue("--color-logo-accent").trim() || "#ffb224";

  ctx.clearRect(0, 0, SIZE, SIZE);

  // Antenna: a thin line with a glowing tip. The tip sits at y=1.5 (not 0) so
  // its full radius stays inside the canvas instead of being clipped by the
  // top edge.
  const tipX = SIZE / 2 + 3;
  const tipY = 1.5;
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(SIZE / 2, 4.5);
  ctx.lineTo(tipX, tipY);
  ctx.stroke();
  ctx.globalAlpha = 0.4 + 0.6 * frame.antennaGlow;
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(tipX, tipY, 1.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  // Head: a rounded-rectangle pebble, tilted per frame.tilt.
  ctx.save();
  ctx.translate(SIZE / 2, SIZE / 2 + 2);
  ctx.rotate((frame.tilt * Math.PI) / 24);
  ctx.translate(-SIZE / 2, -(SIZE / 2 + 2));
  ctx.fillStyle = primary;
  roundedRectPath(ctx, 2, 5, SIZE - 4, SIZE - 7, BODY_RADIUS);
  ctx.fill();

  // Eyes: height follows eyeOpenness.
  const eyeHeight = Math.max(1, 5 * frame.eyeOpenness);
  const eyeY = SIZE / 2 + 2 - eyeHeight / 2;
  ctx.fillStyle = accent;
  roundedRectPath(ctx, SIZE / 2 - 5, eyeY, 2.4, eyeHeight, 1.2);
  ctx.fill();
  roundedRectPath(ctx, SIZE / 2 + 2.6, eyeY, 2.4, eyeHeight, 1.2);
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
