import * as THREE from "three";

/** States the app drives directly; interactions (hover/click/dizzy/modest)
 * layer on top without changing this. */
export type OshiState =
  | "idle"
  | "listening"
  | "thinking"
  | "happy"
  | "sad"
  | "sleeping";

const OSHI_STATES: readonly OshiState[] = [
  "idle",
  "listening",
  "thinking",
  "happy",
  "sad",
  "sleeping",
];

export interface OshiOptions {
  /** Hex color string, e.g. "#e2c2f7". Reserved for future palette overrides. */
  accent?: string;
  /** Head/neck only, body hidden and camera reframed — for the overlay pill. */
  headOnly?: boolean;
  reduceMotion?: boolean;
}

export interface OshiInstance {
  setState(name: OshiState): void;
  setLevel(level: number): void;
  setModest(on: boolean): void;
  poke(): void;
  readonly state: OshiState;
  dispose(): void;
  // Test hooks: deterministic stepping, used only by manual/dev verification.
  _advance(seconds: number, stepHz?: number): void;
  _hover(on: boolean): void;
  _pointer(nx: number, ny: number): void;
}

// Sticker-sheet palette: warm cream shell, dark plum face, pink-lavender
// accents, thin plum outline.
const PAL = {
  shell: 0xfff8f4,
  dark: 0x3a2a36,
  outline: 0x3b2836,
  accent: 0xe2c2f7,
  accentDeep: 0xb98ae0,
  visorTop: "#463341",
  visorBottom: "#2b1e29",
  eyeDark: "#1a1018",
  eyeRim: "#f7e8ee",
  blush: "#ff8fb1",
  tongue: "#ff9fb4",
  mouthDark: "#5a2340",
} as const;

const FACE_W = 512;
const FACE_H = 326;

function damp(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function canvasTexture(
  w: number,
  h: number,
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!, w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Two-tone cel shading: lit, and one soft shadow band.
function toonGradient(): THREE.DataTexture {
  const data = new Uint8Array([
    168, 168, 168, 255, 236, 236, 236, 255, 255, 255, 255, 255,
  ]);
  const tex = new THREE.DataTexture(data, 3, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

// Inverted-hull outline: back faces pushed out along the normal.
function outlineMaterial(width: number): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({
    color: PAL.outline,
    side: THREE.BackSide,
  });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.outlineWidth = { value: width };
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nuniform float outlineWidth;",
      )
      .replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\ntransformed += normalize(normal) * outlineWidth;",
      );
  };
  return m;
}

interface FaceParams {
  face: "normal" | "sad" | "sleep" | "annoyed" | "dizzy";
  eyeOpen: number;
  eyeScale: number;
  eyeHappy: number;
  lookX: number;
  lookY: number;
  mouthCurve: number;
  mouthOpen: number;
  blush: number;
  spin: number;
}

export function createOshi(
  container: HTMLElement,
  options: OshiOptions = {},
): OshiInstance {
  const headOnly = options.headOnly ?? false;
  const reduceMotion =
    options.reduceMotion ??
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ??
    false;

  // ---------- renderer / scene ----------
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: "low-power",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  container.appendChild(renderer.domElement);
  Object.assign(renderer.domElement.style, {
    display: "block",
    width: "100%",
    height: "100%",
  });

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 50);
  camera.position.set(0, 1.9, 9.4);
  camera.lookAt(0, 1.82, 0);

  scene.add(new THREE.AmbientLight(0xffffff, 1.55));
  const key = new THREE.DirectionalLight(0xffffff, 1.45);
  key.position.set(-3, 4, 6);
  scene.add(key);

  // ---------- materials ----------
  const gradientMap = toonGradient();
  const toon = (color: number) =>
    new THREE.MeshToonMaterial({ color, gradientMap });
  const shellMat = toon(PAL.shell);
  const darkMat = toon(PAL.dark);
  const accentMat = toon(PAL.accent);
  const outlineThick = outlineMaterial(0.034);
  const outlineThin = outlineMaterial(0.022);

  function part(
    parent: THREE.Object3D,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    outline: THREE.Material | null = outlineThick,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, material);
    if (outline) {
      const hull = new THREE.Mesh(geometry, outline);
      hull.renderOrder = -1;
      mesh.add(hull);
    }
    parent.add(mesh);
    return mesh;
  }

  // ---------- rig ----------
  const root = new THREE.Group(); // jump / squash, origin at the feet
  scene.add(root);

  const shadowMat = new THREE.MeshBasicMaterial({
    map: canvasTexture(128, 128, (g) => {
      const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      grad.addColorStop(0, "rgba(120,96,130,0.32)");
      grad.addColorStop(0.7, "rgba(120,96,130,0.16)");
      grad.addColorStop(1, "rgba(120,96,130,0)");
      g.fillStyle = grad;
      g.fillRect(0, 0, 128, 128);
    }),
    transparent: true,
    depthWrite: false,
  });
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 0.8), shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.002;
  scene.add(shadow);

  function makeLeg(side: -1 | 1): THREE.Group {
    const g = new THREE.Group();
    g.position.set(0.22 * side, 0.27, 0.02);
    part(g, new THREE.CapsuleGeometry(0.22, 0.08, 8, 24), shellMat);
    const foot = part(
      g,
      new THREE.SphereGeometry(0.23, 32, 20),
      darkMat,
      outlineThin,
    );
    foot.scale.set(1.05, 0.62, 1.15);
    foot.position.set(0, -0.17, 0.03);
    root.add(g);
    return g;
  }
  const legL = makeLeg(-1);
  const legR = makeLeg(1);

  const torso = part(root, new THREE.SphereGeometry(0.56, 48, 32), shellMat);
  torso.scale.set(1.04, 1.0, 0.9);
  torso.position.y = 0.72;

  const chest = new THREE.Group();
  chest.position.set(0, 0.78, 0.49);
  chest.rotation.x = -0.12;
  root.add(chest);
  const chestCore = new THREE.Mesh(
    new THREE.CircleGeometry(0.115, 32),
    new THREE.MeshBasicMaterial({ color: 0xfff6ff }),
  );
  chest.add(chestCore);
  const chestRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.12, 0.028, 12, 40),
    new THREE.MeshBasicMaterial({ color: PAL.accentDeep }),
  );
  chestRing.position.z = 0.005;
  chest.add(chestRing);

  function makeArm(side: -1 | 1): THREE.Group {
    const pivot = new THREE.Group();
    pivot.position.set(0.5 * side, 1.0, 0.04);
    const arm = part(pivot, new THREE.CapsuleGeometry(0.15, 0.12, 8, 24), shellMat);
    arm.position.y = -0.17;
    const hand = part(
      pivot,
      new THREE.SphereGeometry(0.165, 32, 20),
      darkMat,
      outlineThin,
    );
    hand.position.y = -0.36;
    root.add(pivot);
    return pivot;
  }
  const armL = makeArm(-1);
  const armR = makeArm(1);

  const neck = new THREE.Group(); // head pivot
  neck.position.set(0, 1.16, 0);
  root.add(neck);
  const head = new THREE.Group();
  head.position.y = 0.9;
  neck.add(head);

  const HEAD_SCALE = new THREE.Vector3(1.13, 1.0, 1.0);
  const shell = part(head, new THREE.SphereGeometry(1, 64, 48), shellMat);
  shell.scale.copy(HEAD_SCALE);

  // Face screen: a curved patch of a slightly larger sphere, painted from a
  // canvas redrawn only when its inputs change. Unlit, like the flat sticker face.
  const faceCanvas = document.createElement("canvas");
  faceCanvas.width = FACE_W;
  faceCanvas.height = FACE_H;
  const faceTex = new THREE.CanvasTexture(faceCanvas);
  faceTex.colorSpace = THREE.SRGBColorSpace;
  faceTex.anisotropy = 4;
  const PATCH_W = 2.12;
  const PATCH_TOP = Math.PI / 2 - 0.66;
  const PATCH_H = 1.42;
  const visor = new THREE.Mesh(
    new THREE.SphereGeometry(
      1.006,
      64,
      48,
      Math.PI / 2 - PATCH_W / 2,
      PATCH_W,
      PATCH_TOP,
      PATCH_H,
    ),
    new THREE.MeshBasicMaterial({
      map: faceTex,
      transparent: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    }),
  );
  visor.scale.copy(HEAD_SCALE);
  head.add(visor);

  function makeEar(side: -1 | 1): THREE.Group {
    const g = new THREE.Group();
    g.position.set(1.1 * side, -0.02, 0.02);
    g.rotation.z = Math.PI / 2;
    g.rotation.y = -0.4 * side;
    part(g, new THREE.CylinderGeometry(0.38, 0.38, 0.24, 40), shellMat);
    const inner = part(
      g,
      new THREE.CylinderGeometry(0.28, 0.28, 0.08, 40),
      accentMat,
      outlineThin,
    );
    inner.position.y = -0.12 * side;
    head.add(g);
    return g;
  }
  makeEar(-1);
  makeEar(1);

  const antenna = new THREE.Group();
  antenna.position.set(0.12, 0.93, 0);
  antenna.rotation.z = -0.18;
  head.add(antenna);
  const stalk = part(
    antenna,
    new THREE.CylinderGeometry(0.035, 0.04, 0.42, 16),
    darkMat,
    null,
  );
  stalk.position.y = 0.2;
  const tip = part(
    antenna,
    new THREE.SphereGeometry(0.17, 32, 20),
    accentMat,
    outlineThin,
  );
  tip.position.y = 0.5;
  const tipShine = new THREE.Mesh(
    new THREE.SphereGeometry(0.045, 16, 10),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  );
  tipShine.position.set(-0.06, 0.57, 0.12);
  antenna.add(tipShine);

  // Floating emote ("…", "z Z", sparkles, hearts, "?") beside the head.
  const emoteCanvas = document.createElement("canvas");
  emoteCanvas.width = emoteCanvas.height = 256;
  const emoteTex = new THREE.CanvasTexture(emoteCanvas);
  emoteTex.colorSpace = THREE.SRGBColorSpace;
  const emote = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: emoteTex,
      transparent: true,
      depthWrite: false,
      opacity: 0,
    }),
  );
  emote.scale.setScalar(0.95);
  scene.add(emote);

  if (headOnly) {
    for (const o of [torso, chest, legL, legR, armL, armR, shadow, emote]) {
      o.visible = false;
    }
    camera.fov = 30;
    camera.position.set(0, 2.1, 5.8);
    camera.lookAt(0, 2.08, 0);
    camera.updateProjectionMatrix();
  }

  // ---------- drawing ----------
  const fctx = faceCanvas.getContext("2d")!;
  const ectx = emoteCanvas.getContext("2d")!;

  function star(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    r: number,
    color: string,
  ): void {
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4 - Math.PI / 2;
      const rr = i % 2 === 0 ? r : r * 0.32;
      ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fill();
  }
  function heart(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    s: number,
    color: string,
  ): void {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y + s * 0.35);
    ctx.bezierCurveTo(x - s, y - s * 0.35, x - s * 0.45, y - s, x, y - s * 0.45);
    ctx.bezierCurveTo(x + s * 0.45, y - s, x + s, y - s * 0.35, x, y + s * 0.35);
    ctx.fill();
  }

  let emoteKind = "";
  function drawEmote(kind: string): void {
    if (kind === emoteKind) return;
    emoteKind = kind;
    ectx.clearRect(0, 0, 256, 256);
    ectx.lineCap = "round";
    if (kind === "dots") {
      ectx.fillStyle = "#3b2836";
      for (let i = 0; i < 3; i++) {
        ectx.beginPath();
        ectx.arc(70 + i * 52, 140, 15, 0, Math.PI * 2);
        ectx.fill();
      }
    } else if (kind === "zz") {
      ectx.fillStyle = "#8a6fd1";
      ectx.font = "bold 92px system-ui, sans-serif";
      ectx.fillText("z", 40, 200);
      ectx.font = "bold 128px system-ui, sans-serif";
      ectx.fillText("Z", 120, 140);
    } else if (kind === "sparkle") {
      star(ectx, 80, 90, 52, "#ffcf4d");
      star(ectx, 180, 170, 34, "#ffcf4d");
      star(ectx, 190, 60, 20, "#ffe08a");
    } else if (kind === "hearts") {
      heart(ectx, 90, 150, 62, "#ff8fb1");
      heart(ectx, 185, 80, 40, "#ffa7c2");
    } else if (kind === "question") {
      ectx.fillStyle = "#8a6fd1";
      ectx.font = "bold 170px system-ui, sans-serif";
      ectx.fillText("?", 80, 200);
    } else if (kind === "spark") {
      ectx.strokeStyle = "#ff8fb1";
      ectx.lineWidth = 16;
      for (const [x1, y1, x2, y2] of [
        [60, 70, 100, 110],
        [130, 50, 135, 100],
        [190, 80, 160, 115],
      ]) {
        ectx.beginPath();
        ectx.moveTo(x1, y1);
        ectx.lineTo(x2, y2);
        ectx.stroke();
      }
    }
    emoteTex.needsUpdate = true;
  }

  function drawEye(cx: number, cy: number, p: FaceParams, side: -1 | 1): void {
    const ctx = fctx;
    const rx = 56 * p.eyeScale;
    const ry = 60 * p.eyeScale;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const lineColor = PAL.eyeRim;

    if (p.face === "dizzy") {
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 8;
      ctx.beginPath();
      for (let t = 0; t <= 1; t += 0.02) {
        const a = t * 2.4 * Math.PI * 2 + p.spin * side;
        const r = 4 + t * 36;
        ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      }
      ctx.stroke();
      return;
    }
    if (p.face === "annoyed") {
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 11;
      ctx.beginPath();
      ctx.moveTo(cx - 24 * side, cy - 24);
      ctx.lineTo(cx + 16 * side, cy);
      ctx.lineTo(cx - 24 * side, cy + 24);
      ctx.stroke();
      return;
    }
    if (p.eyeHappy > 0.5) {
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 11;
      ctx.beginPath();
      ctx.arc(cx, cy + 20, 36 * p.eyeScale, Math.PI * 1.12, Math.PI * 1.88);
      ctx.stroke();
      return;
    }
    // "modest" (secure text entry elsewhere): closed eyes, same line as a
    // blink/sleep but driven by eyeOpen directly rather than the blink timer.
    const open = Math.max(p.eyeOpen, 0);
    if (open < 0.16) {
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 9;
      ctx.beginPath();
      if (p.face === "sleep") {
        ctx.arc(cx, cy - 8, 28, Math.PI * 0.18, Math.PI * 0.82);
      } else {
        ctx.moveTo(cx - 28, cy);
        ctx.lineTo(cx + 28, cy);
      }
      ctx.stroke();
      return;
    }

    const lx = p.lookX * 7;
    const ly = p.lookY * 6;
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry * open, 0, 0, Math.PI * 2);
    ctx.clip();
    // soft cream crescent on the outer-lower edge, dark iris over the rest
    ctx.fillStyle = PAL.eyeRim;
    ctx.fillRect(cx - rx - 2, cy - ry - 2, rx * 2 + 4, ry * 2 + 4);
    ctx.fillStyle = PAL.eyeDark;
    ctx.beginPath();
    ctx.ellipse(
      cx - side * 10 + lx,
      cy - 10 + ly,
      rx * 0.93,
      ry * 0.95,
      0,
      0,
      Math.PI * 2,
    );
    ctx.fill();
    // sparkles
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(cx + rx * 0.24 + lx, cy - ry * 0.36 + ly, rx * 0.27, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx - rx * 0.3 + lx, cy + ry * 0.18 + ly, rx * 0.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    if (p.face === "sad") {
      // worried brows + a small tear
      ctx.strokeStyle = PAL.eyeRim;
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.moveTo(cx - side * 26, cy - ry - 22);
      ctx.lineTo(cx + side * 26, cy - ry - 6);
      ctx.stroke();
      ctx.fillStyle = "#8fc8ff";
      ctx.beginPath();
      const tx = cx + side * rx * 0.55;
      const ty = cy + ry * 0.75;
      ctx.moveTo(tx, ty - 14);
      ctx.quadraticCurveTo(tx + 10, ty + 4, tx, ty + 9);
      ctx.quadraticCurveTo(tx - 10, ty + 4, tx, ty - 14);
      ctx.fill();
    }
  }

  function drawMouth(p: FaceParams): void {
    const ctx = fctx;
    const cx = FACE_W / 2 + p.lookX * 6;
    const cy = 240 + p.lookY * 5;
    if (p.mouthOpen > 0.08) {
      const w = 20 + p.mouthOpen * 10;
      const h = 14 + p.mouthOpen * 24;
      ctx.fillStyle = PAL.mouthDark;
      ctx.beginPath();
      ctx.moveTo(cx - w, cy - 3);
      ctx.quadraticCurveTo(cx, cy - 7, cx + w, cy - 3);
      ctx.quadraticCurveTo(cx + w * 0.9, cy + h, cx, cy + h);
      ctx.quadraticCurveTo(cx - w * 0.9, cy + h, cx - w, cy - 3);
      ctx.fill();
      ctx.save();
      ctx.clip();
      ctx.fillStyle = PAL.tongue;
      ctx.beginPath();
      ctx.ellipse(cx, cy + h, w * 0.75, h * 0.62, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }
    ctx.strokeStyle = PAL.eyeRim;
    ctx.lineWidth = 7;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(cx - 14, cy);
    ctx.quadraticCurveTo(cx, cy + p.mouthCurve * 13, cx + 14, cy);
    ctx.stroke();
  }

  function drawBlush(p: FaceParams): void {
    if (p.blush < 0.03) return;
    const ctx = fctx;
    ctx.strokeStyle = PAL.blush;
    ctx.globalAlpha = Math.min(1, p.blush);
    ctx.lineWidth = 7;
    ctx.lineCap = "round";
    for (const bx of [104, 394]) {
      for (let i = 0; i < 2; i++) {
        const x = bx + i * 15 + p.lookX * 6;
        ctx.beginPath();
        ctx.moveTo(x - 3, 254);
        ctx.lineTo(x + 2, 239);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  let lastFaceKey = "";
  function drawFace(p: FaceParams): void {
    const keyStr = [
      p.face,
      p.eyeOpen.toFixed(2),
      p.eyeScale.toFixed(2),
      p.eyeHappy.toFixed(2),
      p.lookX.toFixed(2),
      p.lookY.toFixed(2),
      p.mouthCurve.toFixed(2),
      p.mouthOpen.toFixed(2),
      p.blush.toFixed(2),
      p.face === "dizzy" ? p.spin.toFixed(1) : "",
    ].join("|");
    if (keyStr === lastFaceKey) return;
    lastFaceKey = keyStr;

    fctx.clearRect(0, 0, FACE_W, FACE_H);
    roundedRectPath(fctx, 6, 6, FACE_W - 12, FACE_H - 12, 150);
    const g = fctx.createLinearGradient(0, 0, 0, FACE_H);
    g.addColorStop(0, PAL.visorTop);
    g.addColorStop(1, PAL.visorBottom);
    fctx.fillStyle = g;
    fctx.fill();
    // glassy sheen band, upper left
    fctx.save();
    fctx.clip();
    fctx.strokeStyle = "rgba(255,255,255,0.13)";
    fctx.lineWidth = 22;
    fctx.lineCap = "round";
    fctx.beginPath();
    fctx.arc(FACE_W / 2 + 40, 330, 300, Math.PI * 1.2, Math.PI * 1.36);
    fctx.stroke();
    fctx.restore();

    const ex = 120 + p.lookX * 14;
    const ey = 168 + p.lookY * 10;
    drawEye(FACE_W / 2 - ex, ey, p, -1);
    drawEye(FACE_W / 2 + ex, ey, p, 1);
    drawMouth(p);
    drawBlush(p);
    faceTex.needsUpdate = true;
  }

  // ---------- behaviour ----------
  const state = { name: "idle" as OshiState, since: 0 };
  let level = 0;
  let levelSmoothed = 0;
  let modest = false;

  const face: FaceParams = {
    face: "normal",
    eyeOpen: 1,
    eyeScale: 1,
    eyeHappy: 0,
    lookX: 0,
    lookY: 0,
    mouthCurve: 1,
    mouthOpen: 0,
    blush: 0.9,
    spin: 0,
  };

  const pointer = { x: 0, y: 0, active: false, lastMove: 0 };
  let hovering = false;
  let clickTimes: number[] = [];
  let reaction: { name: "annoyed" | "dizzy"; until: number } | null = null;

  let blinkAt = 1.5;
  let blinkPhase = -1;
  let posY = 0;
  let velY = 0;
  let squash = 0;
  let squashVel = 0;
  let nextIdleHop = 6 + Math.random() * 6;
  let headYaw = 0;
  let headPitch = 0;
  let headRoll = 0;
  let bodyLean = 0;
  let armLAng = -0.35;
  let armRAng = 0.35;
  let emoteAlpha = 0;

  const clock = new THREE.Clock();

  function impulseSquash(amount: number): void {
    squashVel += amount;
  }
  function jump(power: number): void {
    if (posY <= 0.001) {
      velY = power;
      impulseSquash(-6);
    }
  }

  function setState(name: OshiState): void {
    if (!OSHI_STATES.includes(name) || name === state.name) return;
    state.name = name;
    state.since = clock.elapsedTime;
    if (name === "happy") jump(4.0);
    if (name === "sad") impulseSquash(4);
  }
  function setLevel(v: number): void {
    level = Math.max(0, Math.min(1, v || 0));
  }
  function setModest(on: boolean): void {
    modest = on;
  }
  function poke(): void {
    const now = clock.elapsedTime;
    clickTimes = clickTimes.filter((t) => now - t < 0.7);
    clickTimes.push(now);
    if (clickTimes.length >= 3) {
      reaction = { name: "dizzy", until: now + 2.6 };
      clickTimes = [];
      jump(2.4);
    } else {
      reaction = { name: "annoyed", until: now + 0.9 };
      impulseSquash(9);
    }
  }

  function onPointerMove(e: PointerEvent): void {
    const r = renderer.domElement.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height * 0.36;
    const dx = (e.clientX - cx) / Math.max(window.innerWidth * 0.5, 1);
    const dy = (e.clientY - cy) / Math.max(window.innerHeight * 0.5, 1);
    pointer.x = Math.max(-1, Math.min(1, dx * 1.6));
    pointer.y = Math.max(-1, Math.min(1, dy * 1.6));
    pointer.active = true;
    pointer.lastMove = clock.elapsedTime;
  }
  const onEnter = () => {
    hovering = true;
    blinkPhase = 0;
  };
  const onLeave = () => {
    hovering = false;
  };
  const onDown = () => poke();
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  renderer.domElement.addEventListener("pointerenter", onEnter);
  renderer.domElement.addEventListener("pointerleave", onLeave);
  renderer.domElement.addEventListener("pointerdown", onDown);

  const motion = reduceMotion ? 0.25 : 1;
  const emoteAnchor = new THREE.Vector3();

  function update(dt: number): void {
    const t = clock.elapsedTime;
    const s = state.name;
    if (reaction && t > reaction.until) reaction = null;
    const r = reaction?.name;

    levelSmoothed = damp(
      levelSmoothed,
      level,
      level > levelSmoothed ? 30 : 8,
      dt,
    );
    const lv = s === "listening" ? levelSmoothed : 0;

    let gx: number;
    let gy: number;
    const cursorFresh = pointer.active && t - pointer.lastMove < 4;
    if (s === "thinking") {
      gx = 0.55 + Math.sin(t * 0.9) * 0.15;
      gy = -0.6;
    } else if (s === "sleeping") {
      gx = 0;
      gy = 0.2;
    } else if (cursorFresh) {
      gx = pointer.x;
      gy = pointer.y;
    } else {
      gx = Math.sin(t * 0.37) * 0.35 + Math.sin(t * 0.13) * 0.2;
      gy = Math.sin(t * 0.29) * 0.15;
    }
    if (s === "sad") gy = Math.max(gy, 0.45);

    // ---- face ----
    let tEyeScale = 1;
    let tHappy = 0;
    let tCurve = 0.9;
    let tMouthOpen = 0.35;
    let tBlush = 0.9;
    let faceKind: FaceParams["face"] = "normal";
    let emoteTarget = "";
    if (s === "listening") {
      tEyeScale = 1.05 + lv * 0.12;
      tMouthOpen = 0.12 + lv * 0.25;
    } else if (s === "thinking") {
      tEyeScale = 0.94;
      tCurve = 0.1;
      tMouthOpen = 0;
      tBlush = 0.6;
      emoteTarget = "dots";
    } else if (s === "happy") {
      tHappy = 1;
      tMouthOpen = 0.9;
      tBlush = 1;
      emoteTarget = "sparkle";
    } else if (s === "sad") {
      faceKind = "sad";
      tCurve = -0.85;
      tMouthOpen = 0;
      tBlush = 0.4;
      tEyeScale = 0.95;
    } else if (s === "sleeping") {
      faceKind = "sleep";
      tCurve = 0.4;
      tMouthOpen = 0;
      emoteTarget = "zz";
    }
    if (hovering && !r && s !== "sleeping") {
      tEyeScale += 0.12;
      tMouthOpen = Math.max(tMouthOpen, 0.6);
      tBlush = 1;
      if (!emoteTarget) emoteTarget = "hearts";
    }
    // "Modest" (secure text entry elsewhere) overrides the state-driven
    // face, but a live poke reaction still wins — same priority tier as
    // the existing hover/click overlay (spec §5).
    let forceClosed = false;
    if (modest && !r) {
      faceKind = "normal";
      tHappy = 0;
      tMouthOpen = 0;
      tCurve = 0.4;
      tBlush = Math.max(tBlush, 0.6);
      forceClosed = true;
    }
    if (r === "annoyed") {
      faceKind = "annoyed";
      tCurve = -0.5;
      tMouthOpen = 0;
      emoteTarget = "spark";
    } else if (r === "dizzy") {
      faceKind = "dizzy";
      tMouthOpen = 0.35;
      tHappy = 0;
      emoteTarget = "question";
    }

    face.face = faceKind;
    face.eyeScale = damp(face.eyeScale, tEyeScale, 10, dt);
    face.eyeHappy = damp(face.eyeHappy, tHappy, 12, dt);
    face.mouthCurve = damp(face.mouthCurve, tCurve, 10, dt);
    face.mouthOpen = damp(face.mouthOpen, tMouthOpen, 12, dt);
    face.blush = damp(face.blush, tBlush, 6, dt);
    face.lookX = damp(face.lookX, gx, 9, dt);
    face.lookY = damp(face.lookY, gy, 9, dt);
    face.spin += dt * 9;

    let open = 1;
    if (s !== "sleeping") {
      if (blinkPhase < 0 && t > blinkAt) blinkPhase = 0;
      if (blinkPhase >= 0) {
        blinkPhase += dt / 0.16;
        open = blinkPhase < 0.5 ? 1 - blinkPhase * 2 : (blinkPhase - 0.5) * 2;
        if (blinkPhase >= 1) {
          blinkPhase = -1;
          blinkAt = t + 2.2 + Math.random() * 3.5;
          if (Math.random() < 0.2) blinkAt = t + 0.25;
          open = 1;
        }
      }
    }
    const targetOpen = s === "sleeping" || forceClosed ? 0 : open;
    face.eyeOpen =
      s === "sleeping" || forceClosed
        ? damp(face.eyeOpen, 0, 6, dt)
        : targetOpen;
    drawFace(face);

    // ---- emote ----
    if (emoteTarget) drawEmote(emoteTarget);
    emoteAlpha = damp(emoteAlpha, emoteTarget ? 1 : 0, 8, dt);
    emote.material.opacity = headOnly ? 0 : emoteAlpha;

    // ---- body physics ----
    velY -= 14 * dt;
    posY += velY * dt;
    if (posY < 0) {
      if (velY < -2) impulseSquash(-velY * 1.6);
      posY = 0;
      velY = 0;
    }
    squashVel += (-160 * squash - 12 * squashVel) * dt;
    squash += squashVel * dt;

    if (!reduceMotion && s === "idle" && t > nextIdleHop && !r) {
      jump(2.2);
      nextIdleHop = t + 8 + Math.random() * 10;
    }
    if (s === "happy" && t - state.since > 0.9 && posY === 0 && t - state.since < 3.2) {
      jump(3.0);
    }
    if (s === "listening" && posY === 0 && lv > 0.55 && Math.random() < dt * 6) {
      jump(0.9 + lv * 1.2);
    }

    const breathe =
      Math.sin(t * (s === "sleeping" ? 1.1 : 1.9)) *
      (s === "sleeping" ? 0.03 : 0.016);
    const sq = Math.max(-0.35, Math.min(0.35, squash * 0.012));
    root.position.y = posY * motion * (headOnly ? 0.2 : 1);
    root.scale.set(
      1 + sq * 0.6 - breathe * 0.4,
      1 - sq + breathe,
      1 + sq * 0.6 - breathe * 0.4,
    );

    const air = Math.min(posY, 1.5);
    shadow.scale.setScalar(1 - air * 0.35);
    shadowMat.opacity = 1 - air * 0.45;

    // ---- head ----
    let tYaw = gx * 0.42;
    let tPitch = gy * 0.24;
    let tRoll = -gx * 0.06 + 0.06; // a slight resting tilt reads friendlier
    let tLean = 0;
    if (s === "listening") {
      tRoll += Math.sin(t * 2.2) * 0.05 + 0.06;
      tLean = 0.05;
    } else if (s === "thinking") {
      tRoll = 0.16 + Math.sin(t * 1.3) * 0.04;
    } else if (s === "sad") {
      tPitch = 0.3;
      tLean = 0.08;
    } else if (s === "sleeping") {
      tPitch = 0.26;
      tRoll = 0.2 + Math.sin(t * 1.1) * 0.03;
    }
    if (forceClosed) tPitch = Math.max(tPitch, 0.22);
    if (r === "dizzy") {
      tRoll = Math.sin(t * 9) * 0.22;
      tYaw = Math.cos(t * 9) * 0.25;
    }
    headYaw = damp(headYaw, tYaw * motion, 7, dt);
    headPitch = damp(headPitch, tPitch * motion, 7, dt);
    headRoll = damp(headRoll, tRoll * motion, 6, dt);
    bodyLean = damp(bodyLean, tLean * motion, 5, dt);
    neck.rotation.set(headPitch, headYaw, headRoll);
    root.rotation.x = bodyLean;
    root.rotation.y = headYaw * 0.25;

    // ---- arms ----
    let tL = -0.35 - Math.sin(t * 1.9) * 0.04;
    let tR = 0.35 + Math.sin(t * 1.9) * 0.04;
    if (s === "happy") {
      tL = -2.5 - Math.sin(t * 12) * 0.2;
      tR = 2.5 + Math.sin(t * 12 + 1) * 0.2;
    } else if (s === "listening") {
      tL = -0.5 - lv * 0.5;
      tR = 0.5 + lv * 0.5;
    } else if (s === "thinking") {
      tR = 2.4;
    } else if (s === "sad") {
      tL = -0.1;
      tR = 0.1;
    } else if (hovering && !r) {
      tR = 2.6 + Math.sin(t * 10) * 0.35;
    }
    if (r === "annoyed") {
      tL = -0.9;
      tR = 0.9;
    }
    armLAng = damp(armLAng, tL * (reduceMotion ? 0.6 : 1), 9, dt);
    armRAng = damp(armRAng, tR * (reduceMotion ? 0.6 : 1), 9, dt);
    armL.rotation.z = armLAng;
    armR.rotation.z = armRAng;
    armR.rotation.x = damp(armR.rotation.x, s === "thinking" ? -0.7 : 0, 6, dt);

    legL.rotation.x = Math.sin(t * 6) * 0.05 * lv;
    legR.rotation.x = -Math.sin(t * 6) * 0.05 * lv;

    antenna.rotation.z =
      -0.18 +
      Math.sin(t * 2.4) * 0.06 * motion +
      (s === "thinking" ? Math.sin(t * 7) * 0.12 * motion : 0);
    tip.scale.setScalar(1 + lv * 0.25);

    // emote floats beside the head, following it
    head.updateWorldMatrix(true, false);
    emoteAnchor.set(1.2, 1.0, 0.3).applyMatrix4(head.matrixWorld);
    emote.position.set(
      emoteAnchor.x,
      emoteAnchor.y + Math.sin(t * 2.2) * 0.05,
      emoteAnchor.z,
    );
  }

  function resize(): void {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  let raf = 0;
  let disposed = false;
  function frame(): void {
    if (disposed) return;
    const dt = Math.min(clock.getDelta(), 1 / 20);
    update(dt);
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  }
  const onVisibility = () => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
    } else if (!raf && !disposed) {
      clock.getDelta();
      raf = requestAnimationFrame(frame);
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
  raf = requestAnimationFrame(frame);

  return {
    setState,
    setLevel,
    setModest,
    poke,
    get state() {
      return state.name;
    },
    _advance(seconds: number, stepHz = 60) {
      const steps = Math.round(seconds * stepHz);
      for (let i = 0; i < steps; i++) {
        clock.elapsedTime += 1 / stepHz;
        update(1 / stepHz);
      }
      renderer.render(scene, camera);
    },
    _hover(on: boolean) {
      on ? onEnter() : onLeave();
    },
    _pointer(nx: number, ny: number) {
      pointer.x = nx;
      pointer.y = ny;
      pointer.active = true;
      pointer.lastMove = clock.elapsedTime;
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerenter", onEnter);
      renderer.domElement.removeEventListener("pointerleave", onLeave);
      renderer.domElement.removeEventListener("pointerdown", onDown);
      scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        mesh.geometry?.dispose?.();
        const m = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (m) {
          for (const mm of Array.isArray(m) ? m : [m]) {
            (mm as THREE.MeshBasicMaterial).map?.dispose();
            mm.dispose();
          }
        }
      });
      gradientMap.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
