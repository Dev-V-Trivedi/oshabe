import React from "react";

/**
 * Static, non-animated rendering of Oshi's "idle" look, shown when WebGL
 * is unavailable (some Linux setups per AGENTS.md's platform notes).
 * Mirrors the 3D rig's cel-shaded palette and proportions, hand-drawn flat
 * SVG — not a resurrection of the deleted FullBodyCharacter.tsx.
 */
export default function OshiFallback({
  size,
  className,
}: {
  size: number;
  className?: string;
}): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 200 220"
      role="img"
      aria-label="Oshabe"
      className={className}
    >
      {/* grounding shadow */}
      <ellipse cx="100" cy="206" rx="56" ry="10" fill="#000" opacity="0.12" />

      {/* legs */}
      <ellipse cx="78" cy="188" rx="17" ry="20" fill="#fff8f4" />
      <ellipse cx="122" cy="188" rx="17" ry="20" fill="#fff8f4" />
      <ellipse cx="78" cy="198" rx="14" ry="8" fill="#3a2a36" />
      <ellipse cx="122" cy="198" rx="14" ry="8" fill="#3a2a36" />

      {/* arms */}
      <ellipse
        cx="38"
        cy="152"
        rx="15"
        ry="26"
        fill="#fff8f4"
        transform="rotate(-18 38 152)"
      />
      <ellipse
        cx="162"
        cy="152"
        rx="15"
        ry="26"
        fill="#fff8f4"
        transform="rotate(18 162 152)"
      />
      <circle cx="33" cy="174" r="11" fill="#3a2a36" />
      <circle cx="167" cy="174" r="11" fill="#3a2a36" />

      {/* body */}
      <ellipse cx="100" cy="162" rx="58" ry="46" fill="#fff8f4" />
      <circle cx="100" cy="160" r="12" fill="#b98ae0" opacity="0.35" />
      <circle
        cx="100"
        cy="160"
        r="6"
        fill="none"
        stroke="#b98ae0"
        strokeWidth="2.5"
      />

      {/* head */}
      <ellipse cx="100" cy="70" rx="86" ry="68" fill="#fff8f4" />
      <circle cx="26" cy="70" r="13" fill="#e2c2f7" />
      <circle cx="174" cy="70" r="13" fill="#e2c2f7" />

      {/* antenna */}
      <path
        d="M 112 10 Q 122 -8 134 -14"
        fill="none"
        stroke="#fff8f4"
        strokeWidth="6"
        strokeLinecap="round"
      />
      <circle cx="136" cy="-16" r="10" fill="#e2c2f7" />
      <circle cx="132" cy="-20" r="3" fill="#fff" />

      {/* face screen */}
      <rect x="36" y="26" width="128" height="76" rx="34" fill="#352739" />

      {/* eyes */}
      <g>
        <ellipse cx="78" cy="64" rx="15" ry="16" fill="#f7e8ee" />
        <ellipse cx="74" cy="60" rx="14" ry="15" fill="#1a1018" />
        <circle cx="79" cy="55" r="4" fill="#fff" />
        <circle cx="70" cy="64" r="1.6" fill="#fff" />
      </g>
      <g>
        <ellipse cx="122" cy="64" rx="15" ry="16" fill="#f7e8ee" />
        <ellipse cx="118" cy="60" rx="14" ry="15" fill="#1a1018" />
        <circle cx="123" cy="55" r="4" fill="#fff" />
        <circle cx="114" cy="64" r="1.6" fill="#fff" />
      </g>

      {/* blush */}
      <path
        d="M 50 80 L 48 86"
        stroke="#ff8fb1"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <path
        d="M 56 80 L 54 86"
        stroke="#ff8fb1"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <path
        d="M 144 80 L 146 86"
        stroke="#ff8fb1"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <path
        d="M 150 80 L 152 86"
        stroke="#ff8fb1"
        strokeWidth="2.5"
        strokeLinecap="round"
      />

      {/* mouth */}
      <path
        d="M 90 84 Q 100 90 110 84"
        fill="none"
        stroke="#f7e8ee"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
