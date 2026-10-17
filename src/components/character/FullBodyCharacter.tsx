import React, { useEffect, useState } from "react";
import "./FullBodyCharacter.css";
import type { Pose } from "./pose";

// Full-body version of Oshabe's character ("Oshi"), reusing the proportions
// established by the overlay's CharacterFace.tsx (rounded-pebble head,
// antenna with a glowing tip, eyes) scaled up with a body, arms, and legs.
// Hand-coded inline SVG — no Rive/Lottie/image assets, matching the overlay
// character's own rule.

const PRIMARY = "var(--color-logo-primary)";
const ACCENT = "var(--color-logo-accent)";

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export default function FullBodyCharacter({
  pose,
  size = 96,
}: {
  pose: Pose;
  size?: number;
}): React.ReactElement {
  const reduceMotion = useReducedMotion();

  // Arm rotation per pose, applied around each arm's shoulder.
  const leftArmRotate =
    pose === "happy"
      ? -40
      : pose === "busy"
        ? 15
        : pose === "listening"
          ? 8
          : 0;
  const rightArmRotate =
    pose === "presenting"
      ? -50
      : pose === "happy"
        ? 40
        : pose === "busy"
          ? -15
          : pose === "listening"
            ? -8
            : 0;
  const eyeHeight = pose === "busy" ? 5 : pose === "happy" ? 9 : 8;

  const bodyClass = !reduceMotion && pose === "idle" ? "fbc-sway" : undefined;
  const rightArmClass =
    !reduceMotion && pose === "presenting" ? "fbc-gesture" : undefined;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 96 96"
      role="img"
      aria-label="Oshabe"
    >
      <g className={bodyClass}>
        {/* Legs */}
        <rect x={30} y={80} width={10} height={12} rx={5} fill={PRIMARY} />
        <rect x={56} y={80} width={10} height={12} rx={5} fill={PRIMARY} />

        {/* Left arm */}
        <rect
          x={10}
          y={54}
          width={13}
          height={26}
          rx={6.5}
          fill={PRIMARY}
          transform={`rotate(${leftArmRotate} 16.5 56)`}
        />

        {/* Right arm */}
        <g className={rightArmClass}>
          <rect
            x={73}
            y={54}
            width={13}
            height={26}
            rx={6.5}
            fill={PRIMARY}
            transform={`rotate(${rightArmRotate} 79.5 56)`}
          />
        </g>

        {/* Body */}
        <rect x={22} y={50} width={52} height={32} rx={16} fill={PRIMARY} />

        {/* Head */}
        <rect x={18} y={10} width={60} height={42} rx={21} fill={PRIMARY} />

        {/* Antenna — tip kept fully inside the viewBox (center y=6, radius 4,
            so its top edge sits at y=2) rather than clipped at the top edge,
            the same clipping bug already found and fixed once in
            CharacterFace.tsx. */}
        <line x1={50} y1={10} x2={60} y2={6} stroke={ACCENT} strokeWidth={3} />
        <circle cx={60} cy={6} r={4} fill={ACCENT} />

        {/* Eyes */}
        <rect
          x={34}
          y={31 - eyeHeight / 2}
          width={9}
          height={eyeHeight}
          rx={4.5}
          fill={ACCENT}
        />
        <rect
          x={53}
          y={31 - eyeHeight / 2}
          width={9}
          height={eyeHeight}
          rx={4.5}
          fill={ACCENT}
        />
      </g>
    </svg>
  );
}
