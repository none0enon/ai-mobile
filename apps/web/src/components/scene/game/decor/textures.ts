import * as THREE from 'three';
import type { Avatar } from './avatar';
import { WALL_H } from './model';

/**
 * 装修小屋用的材质和贴图：全部用代码画（Canvas），没有图片素材。
 * - 三阶的卡通明暗（MeshToonMaterial），同一个颜色共用一份材质；
 * - 墙纸、地板的花纹按底色画深浅；
 * - 小人的脸（眼睛、嘴、腮红）画在一张贴图上，眨眼、表情换一张。
 */

let gradient: THREE.DataTexture | null = null;
function toonGradient(): THREE.DataTexture {
  if (gradient) return gradient;
  const data = new Uint8Array([168, 214, 255]);
  gradient = new THREE.DataTexture(data, data.length, 1, THREE.RedFormat);
  gradient.minFilter = THREE.NearestFilter;
  gradient.magFilter = THREE.NearestFilter;
  gradient.generateMipmaps = false;
  gradient.needsUpdate = true;
  return gradient;
}

const materials = new Map<string, THREE.Material>();

/** 一个颜色的卡通材质（共用，不要单独 dispose） */
export function toon(color: string, opts: { emissive?: string; opacity?: number; side?: THREE.Side } = {}): THREE.MeshToonMaterial {
  const key = `${color}|${opts.emissive ?? ''}|${opts.opacity ?? 1}|${opts.side ?? 0}`;
  let m = materials.get(key) as THREE.MeshToonMaterial | undefined;
  if (!m) {
    m = new THREE.MeshToonMaterial({ color, gradientMap: toonGradient() });
    if (opts.emissive) {
      m.emissive = new THREE.Color(opts.emissive);
      m.emissiveIntensity = 0;
      m.userData.glow = true;
    }
    if (opts.opacity !== undefined && opts.opacity < 1) {
      m.transparent = true;
      m.opacity = opts.opacity;
      m.depthWrite = false;
    }
    if (opts.side !== undefined) m.side = opts.side;
    materials.set(key, m);
  }
  return m;
}

/** 用顶点颜色的卡通材质：头发渐变用（颜色写在几何体上） */
export function toonVertex(): THREE.MeshToonMaterial {
  const key = 'vertex-colors';
  let m = materials.get(key) as THREE.MeshToonMaterial | undefined;
  if (!m) {
    m = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: toonGradient(), side: THREE.DoubleSide });
    materials.set(key, m);
  }
  return m;
}

// —— 衣服的花纹 ——

const clothCanvases = new Map<string, HTMLCanvasElement>();
const clothTextures: THREE.Texture[] = [];

function luminance(hex: string): number {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  return hsl.l;
}

/** 一格花纹（会平铺）：浅色的布上画深一点的花，深色的布上画白的 */
function clothTile(pattern: string, color: string): HTMLCanvasElement {
  const key = `${pattern}|${color}`;
  const hit = clothCanvases.get(key);
  if (hit) return hit;
  const S = 64;
  const [c, g] = canvas(S, S);
  const light = luminance(color) > 0.55;
  const ink = light ? shade(color, -0.24) : '#fbf7f0';
  g.fillStyle = color;
  g.fillRect(0, 0, S, S);
  g.fillStyle = ink;
  // 一格里画两个（中间一个、四角各四分之一个），平铺出来是错开的
  const spots: [number, number][] = [
    [S / 2, S / 2],
    [0, 0],
    [S, 0],
    [0, S],
    [S, S],
  ];
  if (pattern === 'stripe') {
    g.fillRect(0, 0, S, S / 4);
    g.fillRect(0, S / 2, S, S / 4);
  } else if (pattern === 'dots') {
    for (const [x, y] of spots) {
      g.beginPath();
      g.arc(x, y, 9, 0, Math.PI * 2);
      g.fill();
    }
  } else if (pattern === 'check') {
    g.globalAlpha = 0.42;
    g.fillRect(0, 0, S / 2, S);
    g.fillRect(0, 0, S, S / 2);
    g.globalAlpha = 1;
  } else if (pattern === 'floral') {
    const petal = light ? (luminance(color) > 0.85 ? '#f4a9bb' : '#ffffff') : '#ffffff';
    for (const [x, y] of spots) {
      g.fillStyle = petal;
      for (let i = 0; i < 5; i += 1) {
        const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
        g.beginPath();
        g.arc(x + Math.cos(a) * 7, y + Math.sin(a) * 7, 5.5, 0, Math.PI * 2);
        g.fill();
      }
      g.fillStyle = '#f6c945';
      g.beginPath();
      g.arc(x, y, 4, 0, Math.PI * 2);
      g.fill();
    }
  } else if (pattern === 'heart') {
    for (const [x, y] of spots) {
      g.beginPath();
      g.moveTo(x, y + 9);
      g.bezierCurveTo(x - 16, y - 2, x - 7, y - 13, x, y - 4);
      g.bezierCurveTo(x + 7, y - 13, x + 16, y - 2, x, y + 9);
      g.fill();
    }
  } else if (pattern === 'star') {
    for (const [x, y] of spots) star(g, x, y, 10);
  }
  clothCanvases.set(key, c);
  return c;
}

/**
 * 一块布的材质：纯色就是普通的卡通材质；有花纹的按这块布的大小（绕一圈多长、多高）平铺，花纹在哪件衣服上都差不多大。
 */
export function cloth(color: string, pattern: string, around: number, height: number, opts: { side?: THREE.Side } = {}): THREE.MeshToonMaterial {
  if (!pattern || pattern === 'plain') return toon(color, opts);
  const TILE = 0.15;
  const rx = Math.max(1, Math.round(around / TILE));
  const ry = Math.max(1, Math.round((height / TILE) * 2) / 2);
  const key = `cloth|${color}|${pattern}|${rx}|${ry}|${opts.side ?? 0}`;
  let m = materials.get(key) as THREE.MeshToonMaterial | undefined;
  if (!m) {
    const t = texture(clothTile(pattern, color), [rx, ry]);
    clothTextures.push(t);
    m = new THREE.MeshToonMaterial({ map: t, gradientMap: toonGradient() });
    if (opts.side !== undefined) m.side = opts.side;
    materials.set(key, m);
  }
  return m;
}

/** 晚上灯亮：所有会发光的材质一起调 */
export function setGlow(on: boolean) {
  for (const m of materials.values()) if (m.userData.glow) (m as THREE.MeshToonMaterial).emissiveIntensity = on ? 1.1 : 0;
}

export function disposeMaterials() {
  for (const m of materials.values()) m.dispose();
  materials.clear();
  gradient?.dispose();
  gradient = null;
  for (const t of clothTextures) t.dispose();
  clothTextures.length = 0;
  clothCanvases.clear();
  for (const t of faceCache.values()) t.dispose();
  faceCache.clear();
}

// —— 颜色 ——

export function shade(hex: string, amount: number): string {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL(hsl.h, hsl.s, Math.min(1, Math.max(0, hsl.l + amount)));
  return `#${c.getHexString()}`;
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function texture(c: HTMLCanvasElement, repeat?: [number, number]): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (repeat) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
  }
  return t;
}

/** 固定的随机数（同一个花纹每次画出来一样） */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// —— 墙纸：画布宽 = 1 格，高 = 整面墙 ——

export function wallTexture(finish: string, color: string, length: number): THREE.CanvasTexture {
  const W = 256;
  const H = Math.round(256 * WALL_H);
  const [c, g] = canvas(W, H);
  const dark = shade(color, -0.08);
  const light = shade(color, 0.06);
  g.fillStyle = color;
  g.fillRect(0, 0, W, H);
  const r = rng(7);
  if (finish === 'stripe') {
    g.fillStyle = dark;
    for (let x = 0; x < W; x += 64) g.fillRect(x + 8, 0, 22, H);
    g.fillStyle = light;
    for (let x = 0; x < W; x += 64) g.fillRect(x + 36, 0, 4, H);
  } else if (finish === 'dots') {
    g.fillStyle = shade(color, -0.14);
    for (let y = 0; y < H; y += 64) {
      for (let x = (y / 64) % 2 ? 32 : 0; x < W + 32; x += 64) {
        g.beginPath();
        g.arc(x, y + 24, 10, 0, Math.PI * 2);
        g.fill();
      }
    }
  } else if (finish === 'check') {
    g.globalAlpha = 0.35;
    g.fillStyle = dark;
    for (let x = 0; x < W; x += 64) g.fillRect(x, 0, 32, H);
    for (let y = 0; y < H; y += 64) g.fillRect(0, y, W, 32);
    g.globalAlpha = 1;
  } else if (finish === 'wainscot') {
    const panelTop = H - Math.round(256 * 1.0);
    g.fillStyle = shade(color, -0.12);
    g.fillRect(0, panelTop, W, H - panelTop);
    g.fillStyle = shade(color, -0.2);
    g.fillRect(0, panelTop, W, 10);
    g.strokeStyle = shade(color, -0.2);
    g.lineWidth = 4;
    g.strokeRect(24, panelTop + 34, W - 48, H - panelTop - 70);
    g.fillStyle = light;
    for (let x = 0; x < W; x += 128) g.fillRect(x + 60, 0, 3, panelTop);
  } else if (finish === 'brick') {
    const bh = 40;
    for (let y = 0, row = 0; y < H; y += bh, row += 1) {
      for (let x = row % 2 ? -64 : 0; x < W; x += 128) {
        g.fillStyle = shade(color, (r() - 0.5) * 0.08 - 0.03);
        g.fillRect(x + 3, y + 3, 122, bh - 6);
      }
    }
  } else if (finish === 'stars') {
    g.fillStyle = shade(color, -0.1);
    for (let i = 0; i < 26; i += 1) star(g, r() * W, r() * H, 6 + r() * 6);
    g.fillStyle = '#ffffff';
    g.globalAlpha = 0.6;
    for (let i = 0; i < 18; i += 1) star(g, r() * W, r() * H, 3 + r() * 3);
    g.globalAlpha = 1;
  } else {
    g.globalAlpha = 0.05;
    g.fillStyle = '#000';
    for (let i = 0; i < 600; i += 1) g.fillRect(r() * W, r() * H, 2, 2);
    g.globalAlpha = 1;
  }
  // 踢脚线
  g.fillStyle = shade(color, -0.25);
  g.fillRect(0, H - 16, W, 16);
  return texture(c, [length, 1]);
}

function star(g: CanvasRenderingContext2D, x: number, y: number, s: number) {
  g.beginPath();
  for (let i = 0; i < 10; i += 1) {
    const a = (i * Math.PI) / 5 - Math.PI / 2;
    const rr = i % 2 ? s * 0.45 : s;
    g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.closePath();
  g.fill();
}

// —— 地面：画布 = 2 × 2 格 ——

export function floorTexture(finish: string, color: string, w: number, d: number): THREE.CanvasTexture {
  const S = 512;
  const [c, g] = canvas(S, S);
  const r = rng(13);
  g.fillStyle = color;
  g.fillRect(0, 0, S, S);
  if (finish === 'wood') {
    const ph = S / 8;
    for (let row = 0; row < 8; row += 1) {
      let x = row % 2 ? -S / 3 : 0;
      while (x < S) {
        const len = S / 2 + r() * (S / 3);
        g.fillStyle = shade(color, (r() - 0.5) * 0.08);
        g.fillRect(x, row * ph, len, ph);
        g.fillStyle = shade(color, -0.16);
        g.fillRect(x, row * ph, 2, ph);
        x += len;
      }
      g.fillStyle = shade(color, -0.14);
      g.fillRect(0, row * ph, S, 2);
    }
  } else if (finish === 'herring') {
    const u = S / 8;
    for (let y = -S; y < S * 2; y += u) {
      for (let x = -S; x < S * 2; x += u * 2) {
        g.save();
        g.translate(x + (y / u) * u, y);
        g.fillStyle = shade(color, (r() - 0.5) * 0.08);
        g.fillRect(0, 0, u * 2, u);
        g.strokeStyle = shade(color, -0.15);
        g.lineWidth = 2;
        g.strokeRect(0, 0, u * 2, u);
        g.restore();
      }
    }
  } else if (finish === 'tile') {
    const t = S / 4;
    for (let y = 0; y < S; y += t) {
      for (let x = 0; x < S; x += t) {
        g.fillStyle = shade(color, (r() - 0.5) * 0.04);
        g.fillRect(x + 3, y + 3, t - 6, t - 6);
      }
    }
    g.fillStyle = shade(color, -0.12);
    for (let i = 0; i <= S; i += t) {
      g.fillRect(i - 3, 0, 6, S);
      g.fillRect(0, i - 3, S, 6);
    }
  } else if (finish === 'check') {
    const t = S / 4;
    g.fillStyle = shade(color, 0.12);
    for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) if ((x + y) % 2) g.fillRect(x * t, y * t, t, t);
  } else if (finish === 'carpet') {
    for (let i = 0; i < 9000; i += 1) {
      g.fillStyle = shade(color, (r() - 0.5) * 0.12);
      g.fillRect(r() * S, r() * S, 2, 2);
    }
  } else if (finish === 'terrazzo') {
    const chips = [shade(color, -0.25), shade(color, 0.15), '#e9a6a0', '#9fb8d8', '#f0d58a'];
    for (let i = 0; i < 260; i += 1) {
      g.fillStyle = chips[Math.floor(r() * chips.length)]!;
      g.beginPath();
      const x = r() * S;
      const y = r() * S;
      const s = 3 + r() * 8;
      g.moveTo(x, y);
      g.lineTo(x + s, y + r() * s);
      g.lineTo(x + r() * s, y + s);
      g.closePath();
      g.fill();
    }
  }
  return texture(c, [w / 2, d / 2]);
}

// —— 脸 ——

export interface FaceState {
  eyes?: string;
  mouth?: string;
  closed?: boolean;
  blush?: number;
  brows?: 'angry' | 'sad' | null;
  sweat?: boolean;
}

const faceCache = new Map<string, THREE.CanvasTexture>();
export const FACE_W = 512;
export const FACE_H = 320;

/** 脸的贴图（同样的脸共用一张） */
export function faceTexture(a: Avatar, st: FaceState = {}): THREE.CanvasTexture {
  const key = JSON.stringify([a.eyes, a.eyeColor, a.mouth, a.blush, a.skin, a.hairColor, st]);
  const hit = faceCache.get(key);
  if (hit) return hit;
  const [c, g] = canvas(FACE_W, FACE_H);
  drawFace(g, a, st);
  const t = texture(c);
  faceCache.set(key, t);
  return t;
}

function drawFace(g: CanvasRenderingContext2D, a: Avatar, st: FaceState) {
  const eyes = st.closed ? 'closed' : (st.eyes ?? a.eyes);
  const mouth = st.mouth ?? a.mouth;
  const ink = '#3a2a2e';
  const ey = 124;
  for (const side of [-1, 1]) {
    const ex = FACE_W / 2 + side * 92;
    drawEye(g, eyes, ex, ey, a.eyeColor, ink, side);
  }
  // 眉毛（只有生气、难过时画）
  if (st.brows) {
    g.strokeStyle = shade(a.hairColor, -0.1);
    g.lineWidth = 7;
    g.lineCap = 'round';
    for (const side of [-1, 1]) {
      const ex = FACE_W / 2 + side * 92;
      g.beginPath();
      const inner = st.brows === 'angry' ? 38 : 50;
      const outer = st.brows === 'angry' ? 54 : 40;
      g.moveTo(ex - side * 34, ey - inner);
      g.lineTo(ex + side * 30, ey - outer);
      g.stroke();
    }
  }
  const blush = st.blush ?? (a.blush ? 0.45 : 0);
  if (blush > 0) {
    for (const side of [-1, 1]) {
      const bx = FACE_W / 2 + side * 128;
      const grad = g.createRadialGradient(bx, 196, 2, bx, 196, 46);
      grad.addColorStop(0, `rgba(240,120,140,${blush})`);
      grad.addColorStop(1, 'rgba(240,120,140,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.ellipse(bx, 196, 50, 30, 0, 0, Math.PI * 2);
      g.fill();
      if (blush > 0.6) {
        g.strokeStyle = `rgba(220,90,110,${blush * 0.7})`;
        g.lineWidth = 3;
        for (let i = -1; i <= 1; i += 1) {
          g.beginPath();
          g.moveTo(bx + i * 14 - 5, 204);
          g.lineTo(bx + i * 14 + 5, 188);
          g.stroke();
        }
      }
    }
  }
  drawMouth(g, mouth, FACE_W / 2, 222, ink);
  if (st.sweat) {
    g.fillStyle = 'rgba(140,190,240,0.9)';
    g.beginPath();
    g.moveTo(FACE_W / 2 + 190, 60);
    g.quadraticCurveTo(FACE_W / 2 + 206, 92, FACE_W / 2 + 190, 98);
    g.quadraticCurveTo(FACE_W / 2 + 174, 92, FACE_W / 2 + 190, 60);
    g.fill();
  }
}

function drawEye(g: CanvasRenderingContext2D, style: string, x: number, y: number, iris: string, ink: string, side: number) {
  g.lineCap = 'round';
  g.lineJoin = 'round';
  if (style === 'closed' || style === 'smile') {
    g.strokeStyle = ink;
    g.lineWidth = 10;
    g.beginPath();
    if (style === 'smile') g.arc(x, y + 16, 32, Math.PI * 1.15, Math.PI * 1.85);
    else g.arc(x, y - 6, 34, Math.PI * 0.15, Math.PI * 0.85);
    g.stroke();
    return;
  }
  if (style === 'sleepy') {
    g.fillStyle = ink;
    g.beginPath();
    g.ellipse(x, y + 8, 31, 28, 0, 0, Math.PI);
    g.fill();
    g.fillStyle = iris;
    g.beginPath();
    g.ellipse(x, y + 12, 20, 17, 0, 0, Math.PI);
    g.fill();
    g.strokeStyle = ink;
    g.lineWidth = 9;
    g.beginPath();
    g.moveTo(x - 38, y + 6);
    g.lineTo(x + 38, y + 6);
    g.stroke();
    return;
  }
  const big = style === 'sparkle';
  const rx = big ? 38 : 32;
  const ry = big ? 50 : 42;
  // 眼眶
  g.fillStyle = ink;
  g.beginPath();
  if (style === 'cat') {
    const k = 1.3;
    g.moveTo(x - 32 * k * side, y + 4 * k);
    g.quadraticCurveTo(x - 6 * k * side, y - 40 * k, x + 30 * k * side, y - 14 * k);
    g.quadraticCurveTo(x + 22 * k * side, y + 30 * k, x - 4 * k * side, y + 32 * k);
    g.quadraticCurveTo(x - 26 * k * side, y + 26 * k, x - 32 * k * side, y + 4 * k);
  } else g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  g.fill();
  // 瞳
  const grad = g.createLinearGradient(0, y - ry, 0, y + ry);
  grad.addColorStop(0, shade(iris, -0.18));
  grad.addColorStop(1, shade(iris, 0.16));
  g.fillStyle = grad;
  g.beginPath();
  g.ellipse(x, y + 4, rx - 7, ry - 8, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = shade(iris, -0.3);
  g.beginPath();
  if (style === 'cat') g.ellipse(x, y + 4, 5, ry - 14, 0, 0, Math.PI * 2);
  else g.ellipse(x, y + 4, rx * 0.4, ry * 0.42, 0, 0, Math.PI * 2);
  g.fill();
  // 高光
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.ellipse(x - side * 2 - 10, y - ry * 0.38, big ? 13 : 11, big ? 15 : 12, 0, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.arc(x + 11, y + ry * 0.35, big ? 7 : 5, 0, Math.PI * 2);
  g.fill();
  if (big) {
    g.globalAlpha = 0.8;
    g.beginPath();
    g.arc(x + 12, y - ry * 0.5, 4, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;
    // 睫毛
    g.strokeStyle = ink;
    g.lineWidth = 7;
    g.beginPath();
    g.moveTo(x + side * (rx - 4), y - ry + 10);
    g.lineTo(x + side * (rx + 12), y - ry + 2);
    g.stroke();
  }
}

function drawMouth(g: CanvasRenderingContext2D, style: string, x: number, y: number, ink: string) {
  g.strokeStyle = ink;
  g.lineWidth = 6;
  g.lineCap = 'round';
  g.beginPath();
  if (style === 'open') {
    g.fillStyle = '#b34a5a';
    g.moveTo(x - 20, y - 6);
    g.quadraticCurveTo(x, y - 2, x + 20, y - 6);
    g.quadraticCurveTo(x + 16, y + 22, x, y + 22);
    g.quadraticCurveTo(x - 16, y + 22, x - 20, y - 6);
    g.fill();
    g.fillStyle = '#f08a96';
    g.beginPath();
    g.ellipse(x, y + 14, 9, 6, 0, 0, Math.PI * 2);
    g.fill();
  } else if (style === 'cat') {
    g.moveTo(x - 22, y - 4);
    g.quadraticCurveTo(x - 11, y + 12, x, y - 2);
    g.quadraticCurveTo(x + 11, y + 12, x + 22, y - 4);
    g.stroke();
  } else if (style === 'o') {
    g.fillStyle = '#b34a5a';
    g.ellipse(x, y + 4, 9, 11, 0, 0, Math.PI * 2);
    g.fill();
  } else if (style === 'flat') {
    g.moveTo(x - 14, y + 2);
    g.lineTo(x + 14, y + 2);
    g.stroke();
  } else if (style === 'sad') {
    g.arc(x, y + 18, 16, Math.PI * 1.2, Math.PI * 1.8);
    g.stroke();
  } else if (style === 'pout') {
    g.moveTo(x - 8, y - 4);
    g.quadraticCurveTo(x + 6, y + 2, x - 6, y + 6);
    g.quadraticCurveTo(x + 6, y + 10, x - 8, y + 14);
    g.stroke();
  } else {
    g.arc(x, y - 10, 18, Math.PI * 0.2, Math.PI * 0.8);
    g.stroke();
  }
}

/** 角色表情 → 小人脸上的样子 */
export function faceForExpression(expr: string | null | undefined): FaceState | null {
  switch (expr) {
    case 'smile':
      return { mouth: 'smile' };
    case 'laugh':
      return { eyes: 'smile', mouth: 'open' };
    case 'blush':
      return { blush: 0.85, mouth: 'smile' };
    case 'shy':
      return { blush: 0.9, eyes: 'smile', mouth: 'o' };
    case 'pout':
      return { mouth: 'pout', blush: 0.5 };
    case 'surprised':
      return { eyes: 'sparkle', mouth: 'o' };
    case 'sad':
      return { mouth: 'sad', brows: 'sad' };
    case 'angry':
      return { mouth: 'flat', brows: 'angry' };
    case 'sleepy':
      return { eyes: 'sleepy', mouth: 'o' };
    case 'sleep':
      return { closed: true, mouth: 'smile' };
    default:
      return null;
  }
}
