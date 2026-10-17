import React, { useEffect, useRef, useState } from "react";
import { createOshi, type OshiInstance, type OshiState } from "./oshi3d";
import OshiFallback from "./OshiFallback";

interface OshiCharacterProps {
  state: OshiState;
  level?: number;
  headOnly?: boolean;
  size?: number;
  className?: string;
}

export default function OshiCharacter({
  state,
  level,
  headOnly = false,
  size,
  className,
}: OshiCharacterProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<OshiInstance | null>(null);
  const [failed, setFailed] = useState(false);

  const resolvedSize = size ?? (headOnly ? 22 : 96);

  // Create once per `headOnly` value; never recreated for state/level
  // changes (those happen continuously while listening, which would
  // otherwise tear down and rebuild the renderer every frame).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    try {
      instanceRef.current = createOshi(el, { headOnly });
    } catch {
      setFailed(true);
      return;
    }
    return () => {
      instanceRef.current?.dispose();
      instanceRef.current = null;
    };
  }, [headOnly]);

  useEffect(() => {
    instanceRef.current?.setState(state);
  }, [state]);

  useEffect(() => {
    instanceRef.current?.setLevel(level ?? 0);
  }, [level]);

  if (failed) {
    return <OshiFallback size={resolvedSize} className={className} />;
  }

  return (
    <div
      ref={containerRef}
      style={{ width: resolvedSize, height: resolvedSize }}
      role="img"
      aria-label="Oshabe"
      className={className}
    />
  );
}
