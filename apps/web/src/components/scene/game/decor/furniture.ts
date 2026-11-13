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
    const hand = (len: number, angle: number, minute: boolean) => {
      const p = new THREE.Group();
      p.add(box(0.022, len, 0.01, '#3a2a2e', [0, 0, 0], 0));
      p.position.z = 0.075;
      p.rotation.z = angle;
      if (minute) p.userData.minute = true;
      return p;
    };
    return group(face, hand(0.17, 0, true), hand(0.11, 2.1, false), ball(0.02, '#e88fa6', [0, 0, 0.08]));
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
