import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { shade, toon } from './textures';

/**
 * 家具模型：全部用方块、圆柱、球拼出来（纯色、没有贴图），软软的圆角。
 * 每件的原点在占地中心的地面上，正面朝 +z；挂墙的原点在贴墙那一面的中心（上下也居中），正面朝 +z。
 * 会亮的灯：材质带 emissive（晚上 setGlow 打开），发光的那个 mesh 标 userData.lamp，引擎在那里放点光。
 */

type V3 = [number, number, number];

function mesh(geo: THREE.BufferGeometry, color: string, pos: V3 = [0, 0, 0], opts: { glow?: string; cast?: boolean; opacity?: number } = {}): THREE.Mesh {
  const m = new THREE.Mesh(geo, toon(color, { emissive: opts.glow, opacity: opts.opacity }));
  m.position.set(...pos);
  m.castShadow = opts.cast ?? true;
  m.receiveShadow = true;
  return m;
}

/** 圆角方块：pos 是底面中心 */
function box(w: number, h: number, d: number, color: string, pos: V3 = [0, 0, 0], r = 0.04, opts: { glow?: string; cast?: boolean } = {}) {
  const rr = Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001);
  const geo = rr > 0.005 ? new RoundedBoxGeometry(w, h, d, 3, rr) : new THREE.BoxGeometry(w, h, d);
  return mesh(geo, color, [pos[0], pos[1] + h / 2, pos[2]], opts);
}

/** 圆柱：pos 是底面中心 */
function cyl(rt: number, rb: number, h: number, color: string, pos: V3 = [0, 0, 0], seg = 20, opts: { glow?: string; cast?: boolean } = {}) {
  return mesh(new THREE.CylinderGeometry(rt, rb, h, seg), color, [pos[0], pos[1] + h / 2, pos[2]], opts);
}

function ball(r: number, color: string, pos: V3 = [0, 0, 0], scale: V3 = [1, 1, 1], opts: { glow?: string } = {}) {
  const m = mesh(new THREE.SphereGeometry(r, 20, 14), color, pos, opts);
  m.scale.set(...scale);
  return m;
}

function group(...children: THREE.Object3D[]): THREE.Group {
  const g = new THREE.Group();
  g.add(...children);
  return g;
}

function legs(w: number, d: number, h: number, r: number, color: string, inset = 0.08): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) out.push(cyl(r, r * 0.8, h, color, [sx * (w / 2 - inset), 0, sz * (d / 2 - inset)], 10));
  return out;
}

/** 横着的圆柱（轴朝前后）：pos 是中心 */
function disc(r: number, depth: number, color: string, pos: V3, seg = 24, opts: { glow?: string; cast?: boolean } = {}) {
  const m = mesh(new THREE.CylinderGeometry(r, r, depth, seg), color, pos, opts);
  m.rotation.x = Math.PI / 2;
  return m;
}

/** 圆环：默认平躺着（轴朝上），stand 时立起来朝前 */
function ring(r: number, tube: number, color: string, pos: V3, stand = false, arc = Math.PI * 2) {
  const m = mesh(new THREE.TorusGeometry(r, tube, 8, 24, arc), color, pos);
  if (!stand) m.rotation.x = Math.PI / 2;
  return m;
}

/** 亮着的屏幕（晚上会发光）：pos 是底边中心 */
function screen(w: number, h: number, pos: V3, color = SCREEN) {
  return box(w, h, 0.006, color, pos, 0, { glow: color, cast: false });
}

/** 钟的指针（分针会走）：放在钟面前面 z 的位置 */
function clockHands(z: number, k = 1): THREE.Object3D[] {
  const hand = (len: number, angle: number, minute: boolean) => {
    const p = new THREE.Group();
    p.add(box(0.022 * k, len * k, 0.01, '#3a2a2e', [0, 0, 0], 0));
    p.position.z = z;
    p.rotation.z = angle;
    if (minute) p.userData.minute = true;
    return p;
  };
  return [hand(0.17, 0, true), hand(0.11, 2.1, false), ball(0.02 * k, '#e88fa6', [0, 0, z + 0.005])];
}

const STEEL = '#c9ccd2';
const DARK = '#3a3d45';
const SCREEN = '#9fd0f0';
const PAPER = '#fffdf6';
const WATER = '#bfe3f2';
const LEAF = '#7fb069';
const LEAF_DARK = '#5a8f4e';
const SOIL = '#6b4a3a';
const WARM = '#ffe6a8';

function leafCluster(n: number, spread: number, h: number, size: number, seed: number): THREE.Group {
  const g = new THREE.Group();
  let s = seed;
  const r = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < n; i += 1) {
    const a = (i / n) * Math.PI * 2 + r();
    const rad = spread * (0.4 + r() * 0.6);
    const leaf = ball(size * (0.7 + r() * 0.5), i % 3 ? LEAF : LEAF_DARK, [Math.cos(a) * rad, h + r() * 0.25, Math.sin(a) * rad], [1, 0.55, 1.4]);
    leaf.rotation.set(r() - 0.5, a, (r() - 0.5) * 0.8);
    g.add(leaf);
  }
  return g;
}

const BUILDERS: Record<string, (c: string) => THREE.Group> = {
  // —— 座椅 ——
  sofa: (c) => {
    const frame = shade(c, -0.08);
    return group(
      box(1.9, 0.18, 0.85, frame, [0, 0.06, 0], 0.06),
      box(0.9, 0.1, 0.62, c, [-0.47, 0.22, 0.08], 0.05),
      box(0.9, 0.1, 0.62, c, [0.47, 0.22, 0.08], 0.05),
      box(1.9, 0.5, 0.22, frame, [0, 0.22, -0.33], 0.09),
      box(0.2, 0.32, 0.85, frame, [-0.88, 0.2, 0], 0.08),
      box(0.2, 0.32, 0.85, frame, [0.88, 0.2, 0], 0.08),
      box(0.36, 0.3, 0.1, shade(c, 0.1), [-0.45, 0.32, -0.18], 0.05),
      ...legs(1.8, 0.75, 0.06, 0.03, '#8a5a3b'),
    );
  },
  armchair: (c) => {
    const frame = shade(c, -0.08);
    return group(
      box(0.92, 0.18, 0.85, frame, [0, 0.06, 0], 0.06),
      box(0.56, 0.1, 0.62, c, [0, 0.22, 0.08], 0.05),
      box(0.92, 0.52, 0.22, frame, [0, 0.22, -0.33], 0.09),
      box(0.18, 0.32, 0.85, frame, [-0.38, 0.2, 0], 0.08),
      box(0.18, 0.32, 0.85, frame, [0.38, 0.2, 0], 0.08),
      ...legs(0.85, 0.75, 0.06, 0.03, '#8a5a3b'),
    );
  },
  chair: (c) =>
    group(
      box(0.5, 0.05, 0.48, c, [0, 0.28, 0], 0.02),
      ...legs(0.46, 0.44, 0.28, 0.025, shade(c, -0.1), 0.04),
      box(0.04, 0.5, 0.04, shade(c, -0.1), [-0.21, 0.33, -0.21], 0.01),
      box(0.04, 0.5, 0.04, shade(c, -0.1), [0.21, 0.33, -0.21], 0.01),
      box(0.46, 0.16, 0.04, c, [0, 0.62, -0.21], 0.02),
      box(0.38, 0.04, 0.38, '#f4b6c2', [0, 0.33, 0.02], 0.02),
    ),
  stool: (c) => group(cyl(0.24, 0.24, 0.07, c, [0, 0.25, 0]), cyl(0.04, 0.06, 0.25, shade(c, -0.15), [0, 0, 0], 10), cyl(0.16, 0.18, 0.03, shade(c, -0.15), [0, 0, 0])),
  beanbag: (c) => group(ball(0.42, c, [0, 0.2, 0], [1, 0.55, 1]), ball(0.32, c, [0, 0.36, -0.2], [1.1, 0.7, 0.6])),
  cushion: (c) => {
    const g = group(cyl(0.38, 0.4, 0.1, c, [0, 0, 0], 24));
    g.add(ball(0.04, shade(c, -0.15), [0, 0.1, 0]));
    return g;
  },
  // —— 桌台 ——
  coffee: (c) => group(cyl(0.44, 0.44, 0.05, c, [0, 0.25, 0], 28), cyl(0.04, 0.05, 0.25, shade(c, -0.15), [0, 0, 0], 10), cyl(0.2, 0.22, 0.03, shade(c, -0.15), [0, 0, 0])),
  lowtable: (c) => group(box(1.8, 0.06, 0.78, c, [0, 0.24, 0], 0.03), ...legs(1.7, 0.68, 0.24, 0.03, shade(c, -0.15)), box(1.5, 0.03, 0.55, shade(c, -0.08), [0, 0.08, 0], 0.01)),
  desk: (c) =>
    group(
      box(1.9, 0.06, 0.82, c, [0, 0.54, 0], 0.03),
      box(0.06, 0.54, 0.76, shade(c, -0.1), [-0.9, 0, 0], 0.02),
      box(0.5, 0.54, 0.76, shade(c, -0.05), [0.68, 0, 0], 0.03),
      box(0.36, 0.03, 0.02, shade(c, -0.25), [0.68, 0.38, 0.38], 0.01),
      box(0.36, 0.03, 0.02, shade(c, -0.25), [0.68, 0.18, 0.38], 0.01),
    ),
  dining: (c) =>
    group(cyl(0.92, 0.92, 0.06, c, [0, 0.54, 0], 36), cyl(0.07, 0.09, 0.54, shade(c, -0.15), [0, 0, 0], 12), cyl(0.4, 0.44, 0.04, shade(c, -0.15), [0, 0, 0], 24)),
  nightstand: (c) =>
    group(box(0.62, 0.45, 0.55, c, [0, 0, 0], 0.04), box(0.5, 0.02, 0.02, shade(c, -0.2), [0, 0.3, 0.28], 0.005), ball(0.03, '#e8c26a', [0, 0.22, 0.29])),
  tvstand: (c) =>
    group(
      box(1.9, 0.34, 0.6, c, [0, 0.06, 0], 0.04),
      ...legs(1.8, 0.5, 0.06, 0.025, shade(c, -0.2)),
      box(0.85, 0.24, 0.02, shade(c, -0.08), [-0.45, 0.11, 0.3], 0.01),
      box(0.85, 0.24, 0.02, shade(c, -0.08), [0.45, 0.11, 0.3], 0.01),
    ),
  // —— 床和柜子 ——
  bed: (c) => {
    const wood = '#d2a679';
    return group(
      box(1.9, 0.22, 2.9, wood, [0, 0.04, 0], 0.05),
      box(1.84, 0.14, 2.8, '#f7f6f2', [0, 0.24, 0.02], 0.06),
      box(1.88, 0.06, 1.9, c, [0, 0.34, 0.45], 0.05),
      box(1.94, 0.12, 0.3, c, [0, 0.27, 1.38], 0.06),
      box(1.9, 0.75, 0.12, wood, [0, 0.04, -1.42], 0.05),
      box(0.62, 0.12, 0.36, '#ffffff', [-0.45, 0.36, -1.08], 0.06),
      box(0.62, 0.12, 0.36, '#ffffff', [0.45, 0.36, -1.08], 0.06),
    );
  },
  bedsingle: (c) => {
    const wood = '#d2a679';
    return group(
      box(0.95, 0.22, 1.95, wood, [0, 0.04, 0], 0.05),
      box(0.9, 0.14, 1.88, '#f7f6f2', [0, 0.24, 0.02], 0.06),
      box(0.94, 0.06, 1.25, c, [0, 0.34, 0.33], 0.05),
      box(0.95, 0.72, 0.1, wood, [0, 0.04, -0.94], 0.04),
      box(0.62, 0.12, 0.34, '#ffffff', [0, 0.36, -0.66], 0.06),
    );
  },
  wardrobe: (c) =>
    group(
      box(1.9, 1.86, 0.62, c, [0, 0.04, 0], 0.04),
      box(0.92, 1.7, 0.02, shade(c, 0.05), [-0.47, 0.12, 0.31], 0.01),
      box(0.92, 1.7, 0.02, shade(c, 0.05), [0.47, 0.12, 0.31], 0.01),
      box(0.03, 0.3, 0.03, '#e8c26a', [-0.06, 0.9, 0.34], 0.01),
      box(0.03, 0.3, 0.03, '#e8c26a', [0.06, 0.9, 0.34], 0.01),
      ...legs(1.8, 0.5, 0.04, 0.03, shade(c, -0.25)),
    ),
  bookshelf: (c) => {
    // 敞开的书架：背板、两边侧板、顶板和四层隔板，书立在隔板上
    const side = shade(c, -0.06);
    const g = group(
      box(1.9, 1.6, 0.04, shade(c, -0.14), [0, 0, -0.46], 0.01),
      box(0.05, 1.6, 0.42, side, [-0.925, 0, -0.27], 0.01),
      box(0.05, 1.6, 0.42, side, [0.925, 0, -0.27], 0.01),
      box(1.9, 0.05, 0.44, c, [0, 1.58, -0.27], 0.01),
    );
    const bookColors = ['#ee8f7a', '#a9c4e0', '#f6e09a', '#b5dfc9', '#c9b8e8', '#f4b6c2', '#5b5e66'];
    for (let row = 0; row < 4; row += 1) {
      const y = 0.04 + row * 0.39;
      g.add(box(1.82, 0.04, 0.4, c, [0, y - 0.04, -0.27], 0.005));
      let x = -0.86;
      let k = row * 3;
      while (x < 0.78) {
        const bw = 0.06 + ((k * 7) % 5) * 0.012;
        const bh = 0.22 + ((k * 3) % 4) * 0.025;
        if ((k * 5) % 11 !== 3) g.add(box(bw, bh, 0.26, bookColors[k % bookColors.length]!, [x + bw / 2, y, -0.3], 0.005));
        x += bw + 0.012;
        k += 1;
      }
    }
    return g;
  },
  dresser: (c) => {
    const g = group(box(0.86, 0.76, 0.56, c, [0, 0.04, 0], 0.04), ...legs(0.78, 0.48, 0.04, 0.025, shade(c, -0.2)));
    for (let i = 0; i < 3; i += 1) {
      g.add(box(0.76, 0.2, 0.02, shade(c, 0.06), [0, 0.1 + i * 0.23, 0.28], 0.01));
      g.add(ball(0.025, '#e8c26a', [0, 0.2 + i * 0.23, 0.3]));
    }
    return g;
  },
  // —— 地毯 ——
  rugRound: (c) => group(cyl(0.95, 0.95, 0.02, c, [0, 0, 0], 40, { cast: false }), cyl(0.7, 0.7, 0.022, shade(c, 0.06), [0, 0, 0], 40, { cast: false }), cyl(0.4, 0.4, 0.024, shade(c, -0.05), [0, 0, 0], 40, { cast: false })),
  rugRect: (c) => group(box(2.9, 0.02, 1.9, c, [0, 0, 0], 0, { cast: false }), box(2.5, 0.022, 1.5, shade(c, 0.07), [0, 0, 0], 0, { cast: false }), box(2.1, 0.024, 1.1, shade(c, -0.03), [0, 0, 0], 0, { cast: false })),
  rugHeart: (c) => {
    const s = new THREE.Shape();
    s.moveTo(0, -0.85);
    s.bezierCurveTo(-0.3, -0.55, -0.95, -0.2, -0.95, 0.25);
    s.bezierCurveTo(-0.95, 0.65, -0.55, 0.9, -0.25, 0.9);
    s.bezierCurveTo(-0.08, 0.9, 0, 0.75, 0, 0.62);
    s.bezierCurveTo(0, 0.75, 0.08, 0.9, 0.25, 0.9);
    s.bezierCurveTo(0.55, 0.9, 0.95, 0.65, 0.95, 0.25);
    s.bezierCurveTo(0.95, -0.2, 0.3, -0.55, 0, -0.85);
    const geo = new THREE.ExtrudeGeometry(s, { depth: 0.02, bevelEnabled: false, curveSegments: 16 });
    geo.rotateX(Math.PI / 2);
    geo.translate(0, 0.02, 0);
    const m = mesh(geo, c, [0, 0, 0], { cast: false });
    m.rotation.y = Math.PI;
    return group(m);
  },
  rugMat: (c) => group(box(0.92, 0.02, 0.62, c, [0, 0, 0], 0, { cast: false }), box(0.7, 0.022, 0.42, shade(c, 0.08), [0, 0, 0], 0, { cast: false })),
  // —— 绿植 ——
  plantTall: (c) => {
    const g = group(cyl(0.22, 0.17, 0.36, c, [0, 0, 0], 16), cyl(0.2, 0.2, 0.02, SOIL, [0, 0.34, 0], 16));
    g.add(leafCluster(9, 0.28, 0.55, 0.2, 3));
    for (let i = 0; i < 4; i += 1) g.add(cyl(0.012, 0.012, 0.5, LEAF_DARK, [Math.cos(i * 1.6) * 0.08, 0.34, Math.sin(i * 1.6) * 0.08], 6));
    return g;
  },
  tree: (c) => {
    const g = group(cyl(0.22, 0.18, 0.4, c, [0, 0, 0], 16), cyl(0.04, 0.05, 0.9, '#8a5a3b', [0, 0.36, 0], 8));
    g.add(leafCluster(14, 0.32, 1.05, 0.17, 11));
    g.add(leafCluster(8, 0.22, 1.4, 0.15, 5));
    return g;
  },
  pot: (c) => group(cyl(0.11, 0.08, 0.14, c, [0, 0, 0], 14), leafCluster(6, 0.08, 0.16, 0.08, 7)),
  cactus: (c) =>
    group(
      cyl(0.11, 0.08, 0.12, c, [0, 0, 0], 14),
      ball(0.08, '#79a96b', [0, 0.24, 0], [1, 1.6, 1]),
      ball(0.04, '#79a96b', [0.08, 0.27, 0], [1, 1.4, 1]),
      ball(0.025, '#f4b6c2', [0, 0.37, 0]),
    ),
  vase: (c) => {
    const pts = [new THREE.Vector2(0.001, 0), new THREE.Vector2(0.09, 0.01), new THREE.Vector2(0.11, 0.1), new THREE.Vector2(0.05, 0.2), new THREE.Vector2(0.06, 0.24)];
    const g = group(mesh(new THREE.LatheGeometry(pts, 18), c));
    const petals = ['#f4b6c2', '#f6e09a', '#ffffff'];
    for (let i = 0; i < 3; i += 1) {
      const a = i * 2.1;
      g.add(cyl(0.008, 0.008, 0.18, LEAF_DARK, [Math.cos(a) * 0.03, 0.22, Math.sin(a) * 0.03], 5));
      g.add(ball(0.05, petals[i]!, [Math.cos(a) * 0.05, 0.42, Math.sin(a) * 0.05], [1, 0.7, 1]));
    }
    return g;
  },
  // —— 灯 ——
  floorLamp: (c) => {
    const shadeMesh = cyl(0.2, 0.3, 0.32, c, [0, 1.24, 0], 20, { glow: WARM });
    shadeMesh.userData.lamp = true;
    return group(cyl(0.18, 0.2, 0.04, '#5b5e66', [0, 0, 0]), cyl(0.02, 0.02, 1.24, '#5b5e66', [0, 0.02, 0], 8), shadeMesh);
  },
  deskLamp: (c) => {
    const head = ball(0.11, c, [0.06, 0.34, 0], [1, 0.75, 1], { glow: WARM });
    head.userData.lamp = true;
    const arm = cyl(0.015, 0.015, 0.3, shade(c, -0.15), [0, 0.03, 0], 8);
    arm.rotation.z = -0.25;
    return group(cyl(0.09, 0.1, 0.03, shade(c, -0.15), [0, 0, 0]), arm, head);
  },
  candle: (c) => {
    const flame = ball(0.025, '#ffb347', [0, 0.17, 0], [1, 1.6, 1], { glow: '#ffb347' });
    flame.userData.lamp = true;
    return group(cyl(0.07, 0.07, 0.12, c, [0, 0, 0], 16), cyl(0.075, 0.075, 0.02, shade(c, -0.15), [0, 0, 0], 16), cyl(0.004, 0.004, 0.03, '#3a2a2e', [0, 0.12, 0], 4), flame);
  },
  fairy: (c) => {
    const g = new THREE.Group();
    const n = 9;
    for (let i = 0; i < n; i += 1) {
      const t = i / (n - 1);
      const x = -0.95 + t * 1.9;
      const y = -Math.sin(t * Math.PI) * 0.22;
      const bulb = ball(0.035, i % 2 ? c : shade(c, 0.08), [x, y - 0.04, 0.05], [1, 1.3, 1], { glow: c });
      if (i === Math.floor(n / 2)) bulb.userData.lamp = true;
      g.add(bulb);
      if (i < n - 1) {
        const x2 = -0.95 + ((i + 1) / (n - 1)) * 1.9;
        const y2 = -Math.sin(((i + 1) / (n - 1)) * Math.PI) * 0.22;
        const wire = cyl(0.004, 0.004, Math.hypot(x2 - x, y2 - y), '#4f7a5e', [0, 0, 0], 4);
        wire.position.set((x + x2) / 2, (y + y2) / 2, 0.04);
        wire.rotation.z = Math.atan2(y2 - y, x2 - x) - Math.PI / 2;
        g.add(wire);
      }
    }
    return g;
  },
  // —— 小物 ——
  books: (c) => group(box(0.3, 0.06, 0.22, c, [0, 0, 0], 0.01), box(0.28, 0.05, 0.2, '#f6e09a', [0.01, 0.06, 0], 0.01), box(0.26, 0.06, 0.21, shade(c, -0.2), [-0.01, 0.11, 0.01], 0.01)),
  mug: (c) => {
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.012, 8, 16), toon(c));
    handle.position.set(0.07, 0.07, 0);
    handle.castShadow = true;
    return group(cyl(0.055, 0.05, 0.12, c, [0, 0, 0], 16), cyl(0.048, 0.048, 0.005, '#7a4a2f', [0, 0.112, 0], 16), handle);
  },
  frame: (c) => {
    const g = group(box(0.24, 0.3, 0.03, c, [0, 0, 0], 0.01), box(0.18, 0.22, 0.01, '#f4b6c2', [0, 0.04, 0.012], 0));
    g.add(ball(0.035, '#f6e09a', [0.03, 0.2, 0.02], [1, 1, 0.3]));
    const prop = box(0.02, 0.25, 0.02, c, [0, 0, -0.08], 0);
    prop.rotation.x = 0.3;
    g.add(prop);
    g.children[0]!.rotation.x = -0.12;
    return g;
  },
  bear: (c) => {
    const dark = shade(c, -0.15);
    return group(
      ball(0.12, c, [0, 0.11, 0], [1, 1.05, 0.9]),
      ball(0.1, c, [0, 0.3, 0.01]),
      ball(0.035, c, [-0.08, 0.38, 0]),
      ball(0.035, c, [0.08, 0.38, 0]),
      ball(0.04, shade(c, 0.12), [0, 0.28, 0.08], [1, 0.8, 0.8]),
      ball(0.012, '#3a2a2e', [-0.035, 0.32, 0.09]),
      ball(0.012, '#3a2a2e', [0.035, 0.32, 0.09]),
      ball(0.045, dark, [-0.11, 0.13, 0.04]),
      ball(0.045, dark, [0.11, 0.13, 0.04]),
      ball(0.05, dark, [-0.06, 0.03, 0.08]),
      ball(0.05, dark, [0.06, 0.03, 0.08]),
      ball(0.03, '#e88fa6', [0, 0.2, 0.1], [1.4, 0.7, 0.5]),
    );
  },
  cat: (c) => {
    const ear = (x: number) => {
      const m = mesh(new THREE.ConeGeometry(0.04, 0.07, 8), c, [x, 0.33, 0.04]);
      m.rotation.z = -x * 4;
      return m;
    };
    const tail = cyl(0.02, 0.025, 0.24, c, [0.1, 0.02, -0.12], 8);
    tail.rotation.set(0.6, 0, -0.5);
    return group(
      ball(0.12, c, [0, 0.1, -0.02], [1, 0.95, 1.2]),
      ball(0.095, c, [0, 0.26, 0.05]),
      ear(-0.055),
      ear(0.055),
      ball(0.012, '#3a2a2e', [-0.035, 0.27, 0.135]),
      ball(0.012, '#3a2a2e', [0.035, 0.27, 0.135]),
      ball(0.01, '#e88fa6', [0, 0.245, 0.142]),
      ball(0.035, shade(c, 0.15), [-0.05, 0.02, 0.1]),
      ball(0.035, shade(c, 0.15), [0.05, 0.02, 0.1]),
      tail,
    );
  },
  fishbowl: (c) => {
    const water = ball(0.14, c, [0, 0.15, 0], [1, 0.95, 1]);
    (water.material as THREE.Material) = toon(c, { opacity: 0.55 });
    water.castShadow = false;
    const fish = ball(0.035, '#ee8f7a', [0.02, 0.15, 0.03], [1.5, 1, 0.7]);
    fish.userData.swim = true;
    return group(cyl(0.08, 0.09, 0.03, '#f7f6f2', [0, 0, 0], 16), water, fish, ball(0.015, '#79a96b', [-0.05, 0.06, -0.03], [1, 3, 1]));
  },
  // —— 电器 ——
  tv: (c) => {
    const screen = box(1.32, 0.66, 0.02, '#2a3550', [0, 0.17, 0.035], 0);
    return group(box(1.4, 0.74, 0.06, c, [0, 0.13, 0], 0.03), screen, box(0.3, 0.03, 0.18, c, [0, 0, 0], 0.01), box(0.06, 0.12, 0.04, c, [0, 0.02, 0], 0.01));
  },
  laptop: (c) => {
    const lid = box(0.32, 0.22, 0.015, c, [0, 0, 0], 0.01);
    lid.position.set(0, 0.11, -0.1);
    lid.rotation.x = -0.25;
    const scr = box(0.28, 0.18, 0.004, '#9fd0f0', [0, 0, 0], 0);
    scr.position.set(0, 0.11, -0.09);
    scr.rotation.x = -0.25;
    return group(box(0.34, 0.02, 0.22, c, [0, 0, 0], 0.01), box(0.28, 0.004, 0.12, shade(c, -0.15), [0, 0.02, 0.02], 0), lid, scr);
  },
  console: (c) =>
    group(
      box(0.3, 0.04, 0.16, '#3a3d45', [0, 0, 0], 0.015),
      box(0.06, 0.07, 0.16, c, [-0.18, 0, 0], 0.02),
      box(0.06, 0.07, 0.16, shade(c, -0.3), [0.18, 0, 0], 0.02),
      box(0.18, 0.006, 0.1, '#9fd0f0', [0, 0.04, 0], 0),
    ),
  speaker: (c) => {
    const cone = (y: number, r: number) => {
      const m = cyl(r, r, 0.02, '#3a3d45', [0, 0, 0], 20);
      m.rotation.x = Math.PI / 2;
      m.position.set(0, y, 0.155);
      return m;
    };
    return group(box(0.3, 0.56, 0.3, c, [0, 0, 0], 0.03), cone(0.18, 0.09), cone(0.42, 0.05));
  },
  // —— 墙上 ——
  window: (c) => {
    const g = new THREE.Group();
    const sky = box(1.36, 1.16, 0.02, '#cfe6f7', [0, -0.58, 0.02], 0, { cast: false });
    sky.userData.sky = true;
    g.add(sky);
    g.add(box(1.5, 0.08, 0.12, c, [0, 0.57, 0.06], 0.02), box(1.5, 0.08, 0.16, c, [0, -0.65, 0.08], 0.02));
    g.add(box(0.08, 1.3, 0.1, c, [-0.71, -0.65, 0.05], 0.02), box(0.08, 1.3, 0.1, c, [0.71, -0.65, 0.05], 0.02));
    g.add(box(0.05, 1.16, 0.06, c, [0, -0.58, 0.05], 0.01), box(1.36, 0.05, 0.06, c, [0, -0.05, 0.05], 0.01));
    // 窗帘
    g.add(box(0.26, 1.35, 0.06, '#f7f6f2', [-0.82, -0.72, 0.14], 0.03), box(0.26, 1.35, 0.06, '#f7f6f2', [0.82, -0.72, 0.14], 0.03));
    return g;
  },
  painting: (c) => {
    const g = group(box(1, 0.8, 0.05, c, [0, -0.4, 0.025], 0.02), box(0.86, 0.66, 0.01, '#f7f0e2', [0, -0.33, 0.05], 0, { cast: false }));
    g.add(box(0.86, 0.36, 0.012, '#a9c4e0', [0, -0.03, 0.055], 0, { cast: false }));
    g.add(ball(0.08, '#f6e09a', [0.22, 0.16, 0.064], [1, 1, 0.15]));
    g.add(ball(0.28, '#b9d38f', [-0.16, -0.14, 0.062], [1.1, 0.55, 0.05]));
    g.add(ball(0.24, '#8fbf7a', [0.2, -0.18, 0.066], [1.1, 0.45, 0.05]));
    return g;
  },
  clock: (c) => {
    const face = group(cyl(0.3, 0.3, 0.06, c, [0, 0, 0], 32), cyl(0.25, 0.25, 0.01, '#ffffff', [0, 0.06, 0], 32));
    face.rotation.x = Math.PI / 2;
    return group(face, ...clockHands(0.075));
  },
  shelf: (c) => {
    const g = group(box(1.5, 0.05, 0.28, c, [0, -0.1, 0.14], 0.01));
    g.add(box(0.04, 0.12, 0.2, shade(c, -0.15), [-0.6, -0.22, 0.1], 0.01), box(0.04, 0.12, 0.2, shade(c, -0.15), [0.6, -0.22, 0.1], 0.01));
    const pot = BUILDERS.pot!('#f7f6f2');
    pot.position.set(-0.45, -0.05, 0.14);
    const books = BUILDERS.books!('#ee8f7a');
    books.position.set(0.35, -0.05, 0.14);
    books.rotation.y = 0.3;
    g.add(pot, books);
    return g;
  },
  photos: (c) => {
    const g = new THREE.Group();
    const pics = ['#f4b6c2', '#a9c4e0', '#f6e09a', '#b5dfc9', '#c9b8e8'];
    const at: [number, number, number][] = [
      [-0.5, 0.2, -0.08],
      [0, 0.25, 0.05],
      [0.5, 0.18, 0.1],
      [-0.25, -0.25, 0.06],
      [0.28, -0.22, -0.06],
    ];
    at.forEach(([x, y, r], i) => {
      const card = new THREE.Group();
      card.add(box(0.34, 0.4, 0.015, '#ffffff', [0, -0.2, 0.01], 0.005), box(0.28, 0.27, 0.01, pics[i]!, [0, -0.15, 0.02], 0, { cast: false }));
      card.add(ball(0.025, c, [0, 0.18, 0.03]));
      card.position.set(x, y - 0.25, 0);
      card.rotation.z = r;
      g.add(card);
    });
    // 吊绳
    const string = box(1.4, 0.01, 0.01, c, [0, 0.0, 0.01], 0);
    g.add(string);
    return g;
  },

  // —— 新添的座椅、桌子 ——
  officeChair: (c) => {
    const g = group(
      cyl(0.03, 0.03, 0.22, DARK, [0, 0.06, 0], 10),
      box(0.52, 0.08, 0.5, c, [0, 0.27, 0.02], 0.035),
      box(0.48, 0.44, 0.08, c, [0, 0.42, -0.22], 0.035),
      box(0.06, 0.14, 0.04, DARK, [0, 0.3, -0.25], 0.01),
    );
    for (let i = 0; i < 5; i += 1) {
      const a = (i / 5) * Math.PI * 2;
      const spoke = box(0.05, 0.03, 0.26, DARK, [0, 0.05, 0], 0.01);
      spoke.position.set(Math.sin(a) * 0.13, 0.065, Math.cos(a) * 0.13);
      spoke.rotation.y = a;
      g.add(spoke, ball(0.035, '#2f3138', [Math.sin(a) * 0.26, 0.035, Math.cos(a) * 0.26]));
    }
    for (const sx of [-1, 1]) g.add(box(0.05, 0.03, 0.26, DARK, [sx * 0.27, 0.46, 0], 0.012), box(0.03, 0.12, 0.03, DARK, [sx * 0.27, 0.34, -0.06], 0.01));
    return g;
  },
  diningLong: (c) => group(box(2.84, 0.06, 1.36, c, [0, 0.54, 0], 0.03), ...legs(2.7, 1.22, 0.54, 0.045, shade(c, -0.15), 0.1), box(2.5, 0.05, 0.05, shade(c, -0.1), [0, 0.46, 0], 0.01)),
  // —— 厨房 ——
  stove: (c) => {
    const g = group(
      box(1.9, 0.54, 0.86, c, [0, 0.04, 0], 0.03),
      box(1.9, 0.04, 0.8, shade(c, -0.25), [0, 0, -0.02], 0),
      box(1.92, 0.04, 0.9, DARK, [0, 0.58, 0], 0.012),
      box(1.1, 0.34, 0.02, '#2f3138', [0, 0.14, 0.43], 0.01),
      box(0.9, 0.2, 0.01, '#55606e', [0, 0.2, 0.445], 0, { cast: false }),
      box(0.9, 0.025, 0.035, STEEL, [0, 0.43, 0.45], 0.01),
    );
    for (const x of [-0.46, 0.46]) {
      g.add(cyl(0.2, 0.2, 0.008, '#22242a', [x, 0.62, -0.04], 28, { cast: false }), ring(0.13, 0.012, '#6b6e76', [x, 0.63, -0.04]), ring(0.06, 0.01, '#6b6e76', [x, 0.63, -0.04]));
    }
    for (const x of [-0.82, -0.68, 0.68, 0.82]) g.add(disc(0.035, 0.03, STEEL, [x, 0.38, 0.445], 14));
    return g;
  },
  counter: (c) =>
    group(
      box(1.9, 0.54, 0.86, c, [0, 0.04, 0], 0.03),
      box(1.9, 0.04, 0.8, shade(c, -0.25), [0, 0, -0.02], 0),
      box(1.96, 0.04, 0.92, '#f3efe6', [0, 0.58, 0], 0.015),
      box(0.9, 0.42, 0.02, shade(c, 0.05), [-0.47, 0.1, 0.43], 0.01),
      box(0.9, 0.42, 0.02, shade(c, 0.05), [0.47, 0.1, 0.43], 0.01),
      box(0.03, 0.14, 0.03, STEEL, [-0.08, 0.3, 0.45], 0.01),
      box(0.03, 0.14, 0.03, STEEL, [0.08, 0.3, 0.45], 0.01),
    ),
  sink: (c) => {
    const spout = box(0.03, 0.03, 0.2, STEEL, [-0.3, 0.84, -0.22], 0.012);
    return group(
      box(1.9, 0.54, 0.86, c, [0, 0.04, 0], 0.03),
      box(1.9, 0.04, 0.8, shade(c, -0.25), [0, 0, -0.02], 0),
      box(1.96, 0.04, 0.92, '#f3efe6', [0, 0.58, 0], 0.015),
      box(0.9, 0.42, 0.02, shade(c, 0.05), [-0.47, 0.1, 0.43], 0.01),
      box(0.9, 0.42, 0.02, shade(c, 0.05), [0.47, 0.1, 0.43], 0.01),
      box(0.03, 0.14, 0.03, STEEL, [-0.08, 0.3, 0.45], 0.01),
      box(0.03, 0.14, 0.03, STEEL, [0.08, 0.3, 0.45], 0.01),
      // 水池（不锈钢的边，里面一汪水）、水龙头、沥水架上两个盘子
      box(0.86, 0.012, 0.56, '#aab4bc', [-0.3, 0.62, 0.04], 0.03, { cast: false }),
      box(0.74, 0.012, 0.44, WATER, [-0.3, 0.626, 0.04], 0.03, { cast: false }),
      cyl(0.022, 0.026, 0.24, STEEL, [-0.3, 0.62, -0.3], 10),
      spout,
      ball(0.028, STEEL, [-0.18, 0.66, -0.3]),
      box(0.56, 0.02, 0.5, '#d9dde2', [0.56, 0.62, 0.02], 0.01, { cast: false }),
      disc(0.14, 0.015, '#ffffff', [0.46, 0.78, 0.0]),
      disc(0.14, 0.015, '#ffffff', [0.46, 0.78, 0.09]),
    );
  },
  fridge: (c) =>
    group(
      box(0.88, 1.7, 0.8, c, [0, 0.04, -0.02], 0.05),
      box(0.84, 0.5, 0.02, shade(c, 0.04), [0, 1.2, 0.385], 0.01),
      box(0.84, 1.08, 0.02, shade(c, 0.04), [0, 0.08, 0.385], 0.01),
      box(0.035, 0.3, 0.04, STEEL, [-0.34, 1.26, 0.41], 0.012),
      box(0.035, 0.42, 0.04, STEEL, [-0.34, 0.68, 0.41], 0.012),
      box(0.8, 0.04, 0.7, shade(c, -0.25), [0, 0, -0.02], 0),
      ball(0.035, '#ee8f7a', [0.2, 1.45, 0.4], [1, 1, 0.3]),
      box(0.1, 0.12, 0.01, '#f6e09a', [0.12, 0.9, 0.4], 0),
    ),
  hood: (c) => {
    const canopy = mesh(new THREE.CylinderGeometry(0.3, 1, 0.24, 4, 1).rotateY(Math.PI / 4), c, [0, -0.16, 0.26]);
    canopy.scale.set(0.99, 1, 0.35);
    const lamp = box(0.5, 0.012, 0.12, '#fff3c4', [0, -0.302, 0.3], 0, { glow: WARM, cast: false });
    return group(box(0.42, 0.34, 0.3, c, [0, -0.04, 0.15], 0.02), canopy, box(1.42, 0.03, 0.5, shade(c, -0.1), [0, -0.3, 0.26], 0.01), lamp, box(0.3, 0.02, 0.01, DARK, [0, -0.22, 0.512], 0));
  },
  microwave: (c) =>
    group(
      box(0.74, 0.3, 0.42, c, [0, 0, 0], 0.03),
      box(0.46, 0.22, 0.012, '#2a3040', [-0.1, 0.04, 0.208], 0.01, { cast: false }),
      box(0.025, 0.22, 0.03, STEEL, [0.155, 0.04, 0.22], 0.008),
      box(0.16, 0.24, 0.012, shade(c, -0.08), [0.27, 0.03, 0.208], 0.01, { cast: false }),
      box(0.1, 0.04, 0.012, '#9fe0b0', [0.27, 0.2, 0.212], 0, { glow: '#9fe0b0', cast: false }),
      disc(0.028, 0.02, DARK, [0.27, 0.12, 0.22], 14),
    ),
  airfryer: (c) =>
    group(
      cyl(0.15, 0.17, 0.28, c, [0, 0, 0], 22),
      ball(0.15, c, [0, 0.28, 0], [1, 0.42, 1]),
      box(0.22, 0.14, 0.06, shade(c, -0.12), [0, 0.03, 0.125], 0.02),
      box(0.09, 0.03, 0.1, '#2f3138', [0, 0.09, 0.17], 0.012),
      disc(0.035, 0.02, '#9fe0b0', [0, 0.23, 0.15], 14, { glow: '#9fe0b0', cast: false }),
    ),
  cooker: (c) =>
    group(
      cyl(0.14, 0.13, 0.03, DARK, [0, 0, 0], 22),
      cyl(0.155, 0.14, 0.12, c, [0, 0.03, 0], 24),
      ball(0.15, '#e6edf2', [0, 0.15, 0], [1, 0.34, 1]),
      ball(0.026, DARK, [0, 0.21, 0]),
      box(0.05, 0.025, 0.07, DARK, [-0.175, 0.1, 0], 0.01),
      box(0.05, 0.025, 0.07, DARK, [0.175, 0.1, 0], 0.01),
      ball(0.016, '#ee8f7a', [0, 0.06, 0.15]),
    ),
  bowls: (c) => {
    const bowl = (x: number, z: number) => [cyl(0.085, 0.045, 0.06, c, [x, 0, z], 20), cyl(0.074, 0.074, 0.006, PAPER, [x, 0.057, z], 20, { cast: false }), ring(0.085, 0.006, shade(c, -0.12), [x, 0.06, z])];
    const g = group(...bowl(-0.07, -0.05), ...bowl(0.05, 0.09));
    for (const dx of [0, 0.022]) {
      const stick = cyl(0.006, 0.005, 0.26, '#8a5a3b', [0, 0, 0], 6);
      stick.rotation.set(Math.PI / 2, 0, 0.25);
      stick.position.set(0.15 + dx, 0.01, -0.02);
      g.add(stick);
    }
    return g;
  },
  plates: (c) => {
    const g = new THREE.Group();
    for (let i = 0; i < 3; i += 1) g.add(cyl(0.15, 0.1, 0.016, c, [0, i * 0.018, 0], 28), ring(0.145, 0.006, shade(c, -0.14), [0, i * 0.018 + 0.016, 0]));
    g.add(cyl(0.1, 0.1, 0.004, shade(c, 0.05), [0, 0.053, 0], 24, { cast: false }));
    return g;
  },
  fruitBasket: (c) => {
    const handle = ring(0.16, 0.012, shade(c, -0.15), [0, 0.1, 0], true, Math.PI);
    const banana = ring(0.09, 0.022, '#f6d55c', [0.02, 0.15, 0.06], false, Math.PI * 0.7);
    banana.rotation.z = 0.3;
    const g = group(
      cyl(0.17, 0.12, 0.1, c, [0, 0, 0], 20),
      ring(0.17, 0.014, shade(c, -0.12), [0, 0.1, 0]),
      handle,
      ball(0.06, '#e2574c', [-0.06, 0.13, -0.03]),
      ball(0.058, '#f5a23a', [0.07, 0.13, -0.05]),
      ball(0.05, '#a8cf5f', [0, 0.14, -0.1]),
      banana,
    );
    for (let i = 0; i < 5; i += 1) g.add(ball(0.026, '#9b7fc4', [-0.07 + (i % 3) * 0.03, 0.13 + (i % 2) * 0.03, 0.07 + (i % 2) * 0.02]));
    return g;
  },
  apple: (c) => {
    const one = (x: number, z: number, k: number) => [ball(0.068 * k, c, [x, 0.062 * k, z], [1, 0.92, 1]), cyl(0.005, 0.005, 0.035, '#6b4a3a', [x, 0.115 * k, z], 5), ball(0.02, LEAF, [x + 0.022, 0.14 * k, z], [1.4, 0.4, 0.8])];
    return group(...one(-0.07, -0.02, 1), ...one(0.07, 0.04, 0.9));
  },
  banana: (c) => {
    const g = new THREE.Group();
    for (let i = 0; i < 3; i += 1) {
      const b = ring(0.13, 0.026, c, [0, 0.03 + i * 0.012, -0.05 + i * 0.045], false, Math.PI * 0.62);
      b.rotation.z = 0.5 + i * 0.1;
      g.add(b);
    }
    g.add(ball(0.03, '#6b4a3a', [-0.1, 0.05, 0.02], [1, 0.8, 1]));
    return g;
  },
  orange: (c) => {
    const g = new THREE.Group();
    for (const [x, y, z] of [
      [-0.065, 0.06, 0.03],
      [0.065, 0.06, 0.03],
      [0, 0.06, -0.08],
      [0, 0.155, -0.005],
    ] as V3[]) {
      g.add(ball(0.062, c, [x, y, z]), ball(0.012, '#5a8f4e', [x, y + 0.06, z], [1, 0.5, 1]));
    }
    return g;
  },
  watermelon: (c) => {
    const melon = ball(0.12, c, [-0.08, 0.11, -0.04], [1.15, 0.95, 1]);
    const g = group(melon);
    for (const a of [-0.9, -0.3, 0.3, 0.9]) {
      const stripe = ring(0.116, 0.008, shade(c, -0.14), [-0.08, 0.11, -0.04], true);
      stripe.rotation.y = a;
      stripe.scale.set(1, 0.95, 1);
      g.add(stripe);
    }
    // 切下来的一片：红瓤、绿皮、几粒籽
    const slice = group(cyl(0.1, 0.1, 0.04, '#ee6a6a', [0, 0, 0], 22), ring(0.1, 0.016, c, [0, 0.02, 0]));
    for (const [x, z] of [
      [0.03, 0.02],
      [-0.04, -0.03],
      [0.0, 0.05],
      [-0.03, 0.04],
    ]) slice.add(ball(0.008, '#3a2a2e', [x!, 0.042, z!]));
    slice.position.set(0.11, 0, 0.09);
    g.add(slice);
    return g;
  },
  grapes: (c) => {
    const g = new THREE.Group();
    let k = 0;
    for (let row = 0; row < 4; row += 1) {
      for (let i = 0; i <= 3 - row; i += 1) {
        g.add(ball(0.03, k % 3 ? c : shade(c, 0.06), [(i - (3 - row) / 2) * 0.05, 0.03 + (row % 2) * 0.03, -0.08 + row * 0.05]));
        if (row < 2) g.add(ball(0.03, c, [(i - (3 - row) / 2) * 0.05 + 0.02, 0.08, -0.06 + row * 0.05]));
        k += 1;
      }
    }
    const stem = cyl(0.007, 0.007, 0.07, '#6b4a3a', [0, 0.06, -0.12], 5);
    stem.rotation.x = -0.9;
    g.add(stem, ball(0.03, LEAF, [0.03, 0.1, -0.13], [1.5, 0.4, 1]));
    return g;
  },
  // —— 卫浴 ——
  toilet: (c) => {
    const lid = box(0.4, 0.4, 0.04, c, [0, 0, 0], 0.04);
    lid.position.set(0, 0.6, -0.17);
    lid.rotation.x = -0.12;
    const seat = ring(0.17, 0.036, shade(c, -0.05), [0, 0.39, 0.06]);
    seat.scale.set(1, 1.2, 1);
    return group(
      box(0.48, 0.44, 0.2, c, [0, 0.3, -0.36], 0.04),
      box(0.52, 0.035, 0.24, shade(c, -0.06), [0, 0.74, -0.36], 0.012),
      cyl(0.17, 0.13, 0.3, c, [0, 0, 0.02], 20),
      ball(0.24, c, [0, 0.31, 0.05], [0.95, 0.36, 1.2]),
      cyl(0.12, 0.12, 0.006, WATER, [0, 0.393, 0.06], 20, { cast: false }),
      seat,
      lid,
      ball(0.022, STEEL, [0.17, 0.79, -0.36]),
    );
  },
  washbasin: (c) =>
    group(
      box(0.86, 0.54, 0.6, c, [0, 0.06, -0.14], 0.03),
      ...legs(0.78, 0.5, 0.06, 0.025, shade(c, -0.2)).map((m) => {
        m.position.z -= 0.14;
        return m;
      }),
      box(0.4, 0.42, 0.02, shade(c, 0.05), [-0.21, 0.12, 0.165], 0.01),
      box(0.4, 0.42, 0.02, shade(c, 0.05), [0.21, 0.12, 0.165], 0.01),
      ball(0.022, STEEL, [-0.05, 0.34, 0.185]),
      ball(0.022, STEEL, [0.05, 0.34, 0.185]),
      box(0.92, 0.05, 0.66, '#f7f6f2', [0, 0.6, -0.14], 0.02),
      cyl(0.2, 0.13, 0.1, '#ffffff', [0, 0.65, -0.1], 24),
      ring(0.2, 0.012, '#ffffff', [0, 0.75, -0.1]),
      cyl(0.178, 0.178, 0.006, WATER, [0, 0.748, -0.1], 24, { cast: false }),
      cyl(0.018, 0.02, 0.22, STEEL, [0, 0.65, -0.37], 10),
      box(0.03, 0.025, 0.16, STEEL, [0, 0.86, -0.31], 0.01),
      cyl(0.03, 0.03, 0.09, '#f4b6c2', [0.32, 0.65, -0.3], 12),
    ),
  bathtub: (c) => {
    const g = group(
      box(0.94, 0.46, 1.92, c, [0, 0.05, 0], 0.14),
      box(0.76, 0.014, 1.72, WATER, [0, 0.505, 0], 0.1, { cast: false }),
      cyl(0.02, 0.024, 0.2, STEEL, [0, 0.5, -0.86], 10),
      box(0.03, 0.03, 0.16, STEEL, [0, 0.68, -0.8], 0.012),
      ball(0.026, STEEL, [-0.1, 0.54, -0.86]),
      ball(0.026, STEEL, [0.1, 0.54, -0.86]),
    );
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(ball(0.06, '#e8c26a', [sx * 0.34, 0.05, sz * 0.8]));
    // 泡泡
    for (const [x, z, r] of [
      [0.2, 0.55, 0.07],
      [0.1, 0.66, 0.05],
      [0.26, 0.4, 0.045],
      [-0.22, 0.6, 0.055],
      [-0.12, 0.72, 0.04],
    ]) g.add(ball(r!, '#ffffff', [x!, 0.52, z!], [1, 0.6, 1]));
    return g;
  },
  washer: (c) =>
    group(
      box(0.88, 0.85, 0.82, c, [0, 0, -0.02], 0.04),
      ring(0.24, 0.035, STEEL, [0, 0.38, 0.395], true),
      disc(0.22, 0.02, '#3d5a80', [0, 0.38, 0.39], 28, { cast: false }),
      ball(0.08, '#9fd0f0', [0.06, 0.42, 0.395], [1, 0.6, 0.15]),
      box(0.8, 0.12, 0.012, shade(c, -0.08), [0, 0.7, 0.392], 0.01, { cast: false }),
      disc(0.04, 0.02, STEEL, [0.28, 0.76, 0.4], 14),
      box(0.2, 0.05, 0.012, '#9fe0b0', [-0.2, 0.735, 0.398], 0, { glow: '#9fe0b0', cast: false }),
    ),
  mirror: (c) => {
    const g = group(box(0.92, 1, 0.04, c, [0, -0.5, 0.02], 0.04), box(0.8, 0.88, 0.012, '#d3e9f3', [0, -0.44, 0.038], 0.02, { cast: false }));
    for (const [x, y, len] of [
      [-0.16, 0.12, 0.3],
      [-0.06, 0.06, 0.18],
    ]) {
      const glint = box(0.035, len!, 0.004, '#ffffff', [0, 0, 0], 0, { cast: false });
      glint.position.set(x!, y!, 0.052);
      glint.rotation.z = -0.6;
      g.add(glint);
    }
    return g;
  },
  towel: (c) => {
    const bar = cyl(0.014, 0.014, 0.92, STEEL, [0, 0, 0], 8);
    bar.rotation.z = Math.PI / 2;
    bar.position.set(0, 0.2, 0.09);
    return group(
      bar,
      box(0.05, 0.05, 0.1, STEEL, [-0.46, 0.175, 0.05], 0.012),
      box(0.05, 0.05, 0.1, STEEL, [0.46, 0.175, 0.05], 0.012),
      box(0.36, 0.42, 0.035, c, [-0.18, -0.2, 0.09], 0.015),
      box(0.36, 0.05, 0.04, shade(c, -0.12), [-0.18, -0.14, 0.09], 0.012),
      box(0.24, 0.3, 0.035, shade(c, 0.07), [0.24, -0.08, 0.09], 0.015),
    );
  },
  // —— 书房 ——
  openbook: (c) => {
    const g = group(box(0.42, 0.012, 0.3, c, [0, 0, 0], 0.005));
    for (const sx of [-1, 1]) {
      const page = box(0.2, 0.014, 0.27, PAPER, [0, 0, 0], 0.004);
      page.position.set(sx * 0.1, 0.022, 0);
      page.rotation.z = -sx * 0.1;
      g.add(page);
      for (let i = 0; i < 4; i += 1) {
        const line = box(0.13, 0.002, 0.012, '#b9b1a5', [0, 0, 0], 0, { cast: false });
        line.position.set(sx * 0.1, 0.031, -0.08 + i * 0.05);
        line.rotation.z = -sx * 0.1;
        g.add(line);
      }
    }
    g.add(box(0.02, 0.004, 0.16, '#e2574c', [0.03, 0.03, 0.1], 0, { cast: false }));
    return g;
  },
  notepad: (c) => {
    const sheet = box(0.2, 0.004, 0.27, PAPER, [0.05, 0.02, 0.01], 0, { cast: false });
    sheet.rotation.y = -0.25;
    const pen = cyl(0.009, 0.009, 0.2, '#34466b', [0, 0, 0], 8);
    pen.rotation.set(Math.PI / 2, 0, 0.9);
    pen.position.set(0.1, 0.034, 0.03);
    const pencil = cyl(0.008, 0.008, 0.2, '#f6c945', [0, 0, 0], 6);
    pencil.rotation.set(Math.PI / 2, 0, -0.5);
    pencil.position.set(-0.13, 0.012, 0.12);
    const g = group(box(0.22, 0.02, 0.3, c, [-0.07, 0, -0.02], 0.006), box(0.2, 0.006, 0.28, PAPER, [-0.07, 0.02, -0.02], 0, { cast: false }), sheet, pen, pencil);
    for (let i = 0; i < 4; i += 1) g.add(box(0.12, 0.002, 0.01, '#b9b1a5', [-0.08, 0.026, -0.11 + i * 0.045], 0, { cast: false }));
    return g;
  },
  penholder: (c) => {
    const g = group(cyl(0.065, 0.058, 0.13, c, [0, 0, 0], 18), ring(0.065, 0.008, shade(c, -0.12), [0, 0.13, 0]));
    const pens: [string, number, number, number][] = [
      ['#e2574c', -0.025, 0.2, 0.18],
      ['#34466b', 0.02, 0.22, -0.14],
      ['#f6c945', 0.0, 0.25, 0.04],
      ['#4f7a5e', 0.03, 0.18, 0.28],
    ];
    pens.forEach(([color, x, len, tilt], i) => {
      const pen = cyl(0.009, 0.009, len, color, [0, 0, 0], 6);
      pen.position.set(x, 0.04 + len / 2, (i % 2 ? 1 : -1) * 0.018);
      pen.rotation.z = -tilt;
      g.add(pen);
    });
    return g;
  },
  deskclock: (c) => {
    const g = group(
      box(0.24, 0.2, 0.1, c, [0, 0.03, 0], 0.045),
      ball(0.025, shade(c, -0.15), [-0.07, 0.02, 0.01]),
      ball(0.025, shade(c, -0.15), [0.07, 0.02, 0.01]),
      disc(0.08, 0.012, '#ffffff', [0, 0.13, 0.05], 28, { cast: false }),
      ball(0.03, shade(c, -0.1), [-0.08, 0.24, 0], [1, 0.7, 1]),
      ball(0.03, shade(c, -0.1), [0.08, 0.24, 0], [1, 0.7, 1]),
    );
    const hands = group(...clockHands(0.06, 0.42));
    hands.position.y = 0.13;
    g.add(hands);
    return g;
  },
  printer: (c) => {
    const paper = box(0.4, 0.22, 0.008, PAPER, [0, 0, 0], 0);
    paper.position.set(0, 0.26, -0.15);
    paper.rotation.x = -0.25;
    return group(
      box(0.68, 0.2, 0.42, c, [0, 0, 0], 0.035),
      box(0.6, 0.03, 0.3, shade(c, -0.08), [0, 0.2, 0.02], 0.012),
      paper,
      box(0.44, 0.012, 0.16, shade(c, -0.14), [0, 0.035, 0.24], 0.004),
      box(0.36, 0.006, 0.15, PAPER, [0, 0.047, 0.24], 0, { cast: false }),
      box(0.5, 0.03, 0.012, '#2f3138', [0, 0.085, 0.208], 0, { cast: false }),
      ball(0.014, '#9fe0b0', [0.27, 0.16, 0.21]),
    );
  },
  // —— 屏幕 ——
  monitor: (c) => {
    const g = group(box(0.3, 0.02, 0.2, c, [0, 0, 0], 0.008), box(0.06, 0.2, 0.04, c, [0, 0.02, -0.03], 0.012), box(0.9, 0.5, 0.035, c, [0, 0.12, 0], 0.018), screen(0.84, 0.44, [0, 0.15, 0.018]));
    // 屏幕上开着的窗口
    g.add(box(0.36, 0.26, 0.004, '#ffffff', [-0.18, 0.23, 0.022], 0, { cast: false }), box(0.36, 0.04, 0.005, '#f4b6c2', [-0.18, 0.45, 0.022], 0, { cast: false }), box(0.28, 0.16, 0.004, '#fff3c4', [0.2, 0.2, 0.022], 0, { cast: false }));
    return g;
  },
  tablet: (c) => {
    const slab = group(box(0.22, 0.3, 0.016, c, [0, 0, 0], 0.008), screen(0.19, 0.26, [0, 0.02, 0.009]), box(0.08, 0.08, 0.003, '#f4b6c2', [-0.04, 0.16, 0.013], 0, { cast: false }), box(0.08, 0.08, 0.003, '#fff3c4', [0.045, 0.06, 0.013], 0, { cast: false }));
    slab.position.set(0, 0.008, 0.05);
    slab.rotation.x = -0.38;
    const prop = box(0.1, 0.2, 0.012, shade(c, -0.2), [0, 0, 0], 0.004);
    prop.position.set(0, 0.0, -0.11);
    prop.rotation.x = 0.42;
    return group(slab, prop);
  },
  phone: (c) => {
    const g = group(box(0.11, 0.014, 0.21, c, [0, 0, 0], 0.006), box(0.095, 0.004, 0.19, SCREEN, [0, 0.014, 0], 0, { glow: SCREEN, cast: false }), box(0.05, 0.003, 0.05, '#f4b6c2', [0, 0.018, -0.03], 0, { cast: false }));
    g.rotation.y = 0.35;
    return group(g);
  },
  // —— 墙上 ——
  whiteboard: (c) => {
    const g = group(box(1.5, 1, 0.04, c, [0, -0.5, 0.02], 0.015), box(1.4, 0.9, 0.012, '#ffffff', [0, -0.45, 0.036], 0, { cast: false }), box(1.1, 0.03, 0.08, c, [0, -0.5, 0.07], 0.01));
    const stroke = (x: number, y: number, len: number, rot: number, color: string) => {
      const m = box(len, 0.016, 0.004, color, [0, 0, 0], 0, { cast: false });
      m.position.set(x, y, 0.05);
      m.rotation.z = rot;
      g.add(m);
    };
    stroke(-0.4, 0.26, 0.42, 0, '#34466b');
    stroke(-0.45, 0.16, 0.3, 0, '#34466b');
    stroke(-0.38, 0.06, 0.44, 0, '#34466b');
    stroke(0.28, 0.1, 0.36, 0.5, '#e2574c');
    stroke(0.42, 0.06, 0.3, -0.7, '#e2574c');
    stroke(-0.3, -0.2, 0.5, 0.12, '#4f7a5e');
    g.add(ring(0.1, 0.008, '#e2574c', [0.32, -0.16, 0.05], true), ball(0.03, '#f6c945', [0.56, 0.3, 0.05], [1, 1, 0.4]), ball(0.03, '#f4b6c2', [-0.58, -0.32, 0.05], [1, 1, 0.4]));
    for (const [x, color] of [
      [-0.3, '#34466b'],
      [-0.18, '#e2574c'],
      [-0.06, '#4f7a5e'],
    ] as [number, string][]) {
      const pen = cyl(0.012, 0.012, 0.1, color, [0, 0, 0], 8);
      pen.rotation.z = Math.PI / 2;
      pen.position.set(x, -0.458, 0.08);
      g.add(pen);
    }
    g.add(box(0.1, 0.03, 0.05, '#5b5e66', [0.3, -0.47, 0.08], 0.008));
    return g;
  },
  wallCabinet: (c) =>
    group(
      box(1.96, 0.7, 0.34, c, [0, -0.35, 0.17], 0.02),
      box(0.94, 0.62, 0.02, shade(c, 0.05), [-0.49, -0.31, 0.342], 0.01),
      box(0.94, 0.62, 0.02, shade(c, 0.05), [0.49, -0.31, 0.342], 0.01),
      box(0.03, 0.16, 0.03, STEEL, [-0.07, -0.28, 0.365], 0.01),
      box(0.03, 0.16, 0.03, STEEL, [0.07, -0.28, 0.365], 0.01),
    ),
  rack: (c) => {
    const g = group(box(0.96, 0.7, 0.03, c, [0, -0.35, 0.015], 0.02), box(0.44, 0.03, 0.15, shade(c, -0.14), [-0.22, 0.1, 0.09], 0.01));
    // 洞洞板上的小孔
    for (let ix = 0; ix < 7; ix += 1) for (let iy = 0; iy < 5; iy += 1) g.add(disc(0.012, 0.004, shade(c, -0.2), [-0.36 + ix * 0.12, -0.26 + iy * 0.13, 0.031], 8, { cast: false }));
    const pot = BUILDERS.pot!('#f7f6f2');
    pot.position.set(-0.32, 0.13, 0.09);
    pot.scale.setScalar(0.85);
    const mug = BUILDERS.mug!('#f4b6c2');
    mug.position.set(-0.1, 0.13, 0.09);
    g.add(pot, mug);
    // 挂钩上挂着的：一串钥匙、一个小布袋、一把剪刀
    for (const x of [0.12, 0.28, 0.4]) g.add(cyl(0.008, 0.008, 0.05, STEEL, [x, 0.18, 0.04], 6).rotateX(Math.PI / 2));
    g.add(ring(0.035, 0.007, '#e8c26a', [0.12, 0.12, 0.06], true), box(0.02, 0.08, 0.008, '#e8c26a', [0.12, 0.02, 0.06], 0.003));
    g.add(box(0.13, 0.16, 0.04, '#a9c4e0', [0.28, 0.0, 0.06], 0.015), box(0.008, 0.05, 0.008, '#8a5a3b', [0.28, 0.15, 0.06], 0));
    g.add(ring(0.022, 0.006, '#ee8f7a', [0.385, 0.13, 0.06], true), ring(0.022, 0.006, '#ee8f7a', [0.425, 0.13, 0.06], true), box(0.012, 0.1, 0.006, STEEL, [0.405, 0.015, 0.06], 0));
    g.add(box(0.2, 0.2, 0.004, '#fff3c4', [0.26, -0.3, 0.032], 0, { cast: false }), ball(0.016, '#e2574c', [0.26, -0.13, 0.036]));
    return g;
  },
  aircon: (c) => {
    const flap = box(1.3, 0.016, 0.1, shade(c, -0.04), [0, 0, 0], 0.004);
    flap.position.set(0, -0.2, 0.27);
    flap.rotation.x = 0.5;
    return group(
      box(1.46, 0.42, 0.28, c, [0, -0.21, 0.14], 0.07),
      box(1.3, 0.03, 0.02, shade(c, -0.22), [0, -0.15, 0.275], 0, { cast: false }),
      flap,
      box(1.2, 0.006, 0.01, shade(c, -0.1), [0, 0.05, 0.281], 0, { cast: false }),
      ball(0.014, '#9fe0b0', [0.6, -0.02, 0.28]),
    );
  },
};

/** 造一件家具（找不到时是一个方块） */
export function buildFurniture(kind: string, color: string): THREE.Group {
  const make = BUILDERS[kind];
  const g = make ? make(color) : group(box(0.8, 0.8, 0.8, color));
  g.userData.kind = kind;
  return g;
}

/** 收起一件时释放几何体（材质是共用的，不释放） */
export function disposeObject(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) m.geometry.dispose();
  });
}
