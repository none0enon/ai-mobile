import * as THREE from 'three';
import type { Avatar } from './avatar';
import { cloth, faceForExpression, faceTexture, shade, toon, toonVertex, type FaceState } from './textures';

/**
 * Q 版小人：大头、短身子，全部用球、胶囊拼出来；脸是一张贴图（眼睛、嘴、腮红），贴在头前面的一片球面上。
 * 原点在两脚中间的地面上，正面朝 +z。会站着晃、走路、坐下（腿往前伸，像玩偶）、躺下、挥手、蹦一下、眨眼。
 * 头发分三块拼：发型（后面和两边）、发顶、刘海，整个能左右翻转，发梢能渐变；衣服能带花纹（textures.ts 的 cloth）。
 */

export type ChibiPose = 'stand' | 'sit' | 'lie';

const HIP = 0.33;
const HEAD_R = 0.34;
const UP = new THREE.Vector3(0, 1, 0);

type Mat = THREE.Material | string;
const matOf = (m: Mat): THREE.Material => (typeof m === 'string' ? toon(m) : m);

function capsule(r: number, len: number, mat: Mat, y: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 6, 14), matOf(mat));
  m.position.y = y;
  m.castShadow = true;
  return m;
}

function sphere(r: number, mat: Mat, pos: [number, number, number], scale: [number, number, number] = [1, 1, 1], seg = 20): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.round(seg * 0.7)), matOf(mat));
  m.position.set(...pos);
  m.scale.set(...scale);
  m.castShadow = true;
  return m;
}

/** 一截圆筒（裙摆、腰带）：上口半径 rt、下口半径 rb，前后压扁一点 */
function tube(rt: number, rb: number, h: number, mat: Mat, y: number, open = true, flat = 0.84): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, 28, 1, open), matOf(mat));
  m.position.y = y;
  m.scale.set(1, 1, flat);
  m.castShadow = true;
  return m;
}

/** 球面的一片：phi 绕竖轴（π/2 是正前方），theta 从头顶往下 */
function shell(r: number, color: string, phi0: number, phiLen: number, theta0: number, thetaLen: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 36, 18, phi0 * Math.PI, phiLen * Math.PI, theta0 * Math.PI, thetaLen * Math.PI), toon(color, { side: THREE.DoubleSide }));
  m.castShadow = true;
  return m;
}

/** 球面上一点（头的坐标） */
function onSphere(r: number, phi: number, theta: number): THREE.Vector3 {
  const p = phi * Math.PI;
  const t = theta * Math.PI;
  return new THREE.Vector3(-r * Math.cos(p) * Math.sin(t), r * Math.cos(t), r * Math.sin(p) * Math.sin(t));
}

/** 一根尖尖的发束：根在 pos，尖朝 dir */
function spike(len: number, rad: number, color: string, pos: THREE.Vector3, dir: THREE.Vector3): THREE.Mesh {
  const geo = new THREE.ConeGeometry(rad, len, 8);
  geo.translate(0, len / 2, 0);
  const m = new THREE.Mesh(geo, toon(color));
  m.position.copy(pos);
  m.quaternion.setFromUnitVectors(UP, dir.clone().normalize());
  m.castShadow = true;
  return m;
}

export class Chibi {
  readonly root = new THREE.Group();
  avatar: Avatar;
  pose: ChibiPose = 'stand';
  /** 坐、躺时屁股 / 身子离地多高 */
  seatH = 0;
  private body = new THREE.Group();
  private head = new THREE.Group();
  private arms: THREE.Group[] = [];
  private legs: THREE.Group[] = [];
  private face!: THREE.Mesh;
  private faceMat!: THREE.MeshToonMaterial;
  private t = Math.random() * 10;
  private blinkAt = 2 + Math.random() * 3;
  private blinkUntil = 0;
  private override: FaceState | null = null;
  private overrideUntil = 0;
  private waveUntil = 0;
  private hopUntil = 0;
  private path: THREE.Vector3[] = [];
  private onArrive: (() => void) | null = null;
  private lastFace = '';
  /** 步子多大（穿浴衣迈不开腿） */
  private stride = 1;
  /** 浴衣的长裙摆：坐下时收短，腿伸出来 */
  private longSkirt: THREE.Mesh | null = null;
  speed = 1.5;

  constructor(avatar: Avatar, readonly who: 'you' | 'her') {
    this.avatar = avatar;
    this.root.add(this.body);
    this.build();
  }

  get walking() {
    return this.path.length > 0;
  }

  setAvatar(a: Avatar) {
    this.avatar = a;
    this.build();
  }

  /** 表情（几秒后回到平常的脸）；null 立刻回去 */
  setExpression(expr: string | null, ms = 5000) {
    this.override = faceForExpression(expr);
    this.overrideUntil = this.t + ms / 1000;
  }

  wave(seconds = 2.2) {
    this.waveUntil = this.t + seconds;
  }

  hop() {
    this.hopUntil = this.t + 0.7;
    this.setExpression('laugh', 1800);
  }

  /** 沿着路走（屋里的世界坐标，y 不管），走到了回调 */
  walk(points: THREE.Vector3[], onArrive?: () => void) {
    this.stand();
    this.path = points.map((p) => new THREE.Vector3(p.x, 0, p.z));
    this.onArrive = onArrive ?? null;
    if (!this.path.length) {
      this.onArrive = null;
      onArrive?.();
    }
  }

  stop() {
    this.path = [];
    this.onArrive = null;
  }

  stand() {
    this.pose = 'stand';
    this.seatH = 0;
  }

  /** 坐在 (x, z)，面朝 facing（弧度），坐垫高 h */
  sit(x: number, z: number, facing: number, h: number) {
    this.stop();
    this.pose = 'sit';
    this.seatH = h;
    this.root.position.set(x, 0, z);
    this.root.rotation.y = facing;
  }

  /** 躺在 (x, z)（身子中间），头朝 headDir（弧度），床面高 h */
  lie(x: number, z: number, headDir: number, h: number) {
    this.stop();
    this.pose = 'lie';
    this.seatH = h;
    // 原点在脚下：从身子中间往脚那头退半个身长
    const half = 0.7 * this.avatar.height;
    this.root.position.set(x - Math.sin(headDir) * half, 0, z - Math.cos(headDir) * half);
    this.root.rotation.y = headDir + Math.PI;
  }

  faceTo(x: number, z: number) {
    const dx = x - this.root.position.x;
    const dz = z - this.root.position.z;
    if (Math.hypot(dx, dz) > 0.01) this.root.rotation.y = Math.atan2(dx, dz);
  }

  dispose() {
    this.clear();
  }

  private clear() {
    for (const g of [this.body]) {
      g.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
      g.clear();
    }
    this.faceMat?.dispose();
    this.arms = [];
    this.legs = [];
    this.head = new THREE.Group();
  }

  private build() {
    this.clear();
    const a = this.avatar;
    const H = a.height;
    const K = a.head;
    const R = HEAD_R * K;
    const skin = a.skin;
    const suit = a.suit === 'none' ? null : a.suit;
    const dress = suit === 'dress';
    const yukata = suit === 'yukata';
    const robe = suit === 'bathrobe';
    // 身上那件的颜色、花纹：穿套装时是套装的
    const top = suit ? a.suitColor : a.topColor;
    const topPattern = suit ? a.suitPattern : a.topPattern;
    const trim = a.suitColor2;
    const longSleeve = suit ? !dress : ['hoodie', 'shirt', 'sweater'].includes(a.top);
    const topMat = (around: number, height: number, side?: THREE.Side) => cloth(top, topPattern, around, height, side === undefined ? {} : { side });
    const bottomMat = (around: number, height: number, side?: THREE.Side) => cloth(a.bottomColor, a.bottomPattern, around, height, side === undefined ? {} : { side });
    const gloves = a.acc.includes('gloves');
    this.body.userData.chibi = this.who;
    this.stride = yukata ? 0.4 : robe ? 0.75 : 1;
    this.longSkirt = null;

    // 腿（髋关节处转）
    for (const side of [-1, 1]) {
      const leg = new THREE.Group();
      leg.position.set(side * 0.08, HIP * H, 0);
      const legMat: Mat = yukata ? topMat(0.42, 0.33) : !suit && a.bottom === 'pants' ? bottomMat(0.42, 0.33) : skin;
      leg.add(capsule(0.066, 0.2 * H, legMat, -0.165 * H));
      if (!suit && a.bottom === 'shorts') leg.add(capsule(0.072, 0.05, bottomMat(0.45, 0.19), -0.06));
      leg.add(sphere(0.078, a.shoesColor, [0, -HIP * H + 0.045, 0.03], [1, 0.62, 1.35]));
      this.legs.push(leg);
      this.body.add(leg);
    }

    // 身子
    const torso = capsule(robe ? 0.168 : 0.16, 0.2 * H, topMat(1, 0.52), 0.5 * H);
    torso.scale.set(1, 1, 0.8);
    this.body.add(torso);
    if (dress) {
      this.body.add(tube(0.15, 0.3, 0.3 * H, topMat(1.4, 0.3 * H, THREE.DoubleSide), 0.33 * H, true, 1));
      this.body.add(sphere(0.045, trim, [0, 0.5 * H, 0.13], [1.6, 0.8, 0.5]));
    } else if (yukata) {
      // 长裙摆：从腰到脚踝（几何体的原点在上口，坐下时往上收）
      const h = 0.3 * H;
      const geo = new THREE.CylinderGeometry(0.158, 0.188, h, 28, 1, true);
      geo.translate(0, -h / 2, 0);
      const skirt = new THREE.Mesh(geo, topMat(1.08, h, THREE.DoubleSide));
      skirt.position.y = 0.37 * H;
      skirt.scale.set(1, 1, 0.86);
      skirt.castShadow = true;
      this.longSkirt = skirt;
      this.body.add(skirt);
      // 腰带，后面打个结
      this.body.add(tube(0.173, 0.173, 0.11 * H, trim, 0.43 * H, false, 0.82));
      for (const s of [-1, 1]) this.body.add(sphere(0.07, trim, [s * 0.065, 0.45 * H, -0.15], [1, 0.8, 0.45]));
      this.body.add(sphere(0.036, shade(trim, -0.1), [0, 0.45 * H, -0.165]));
      // 交领：白色的里襟，左边压着右边
      for (const s of [-1, 1]) {
        const band = capsule(0.02, (s > 0 ? 0.2 : 0.15) * H, '#ffffff', 0);
        band.position.set(s * 0.04 - 0.012, 0.6 * H, 0.122 + (s > 0 ? 0.008 : 0));
        band.rotation.z = -s * 0.45;
        this.body.add(band);
      }
    } else if (robe) {
      // 到膝盖的下摆，腰带在前面系一下，领子和袖口是另一个颜色
      this.body.add(tube(0.166, 0.228, 0.24 * H, topMat(1.25, 0.24 * H, THREE.DoubleSide), 0.29 * H, true, 0.88));
      this.body.add(tube(0.178, 0.178, 0.05 * H, trim, 0.42 * H, false, 0.82));
      this.body.add(sphere(0.032, trim, [0.02, 0.42 * H, 0.146]));
      for (const s of [-1, 1]) {
        const end = capsule(0.014, 0.07, trim, 0);
        end.position.set(0.02 + s * 0.022, 0.37 * H, 0.152);
        end.rotation.z = s * 0.25;
        this.body.add(end);
        const lapel = capsule(0.032, 0.17 * H, trim, 0);
        lapel.position.set(s * 0.05, 0.59 * H, 0.118);
        lapel.rotation.z = -s * 0.42;
        this.body.add(lapel);
      }
    } else {
      const hip = tube(0.15, 0.162, 0.12, bottomMat(0.98, 0.12), 0.32 * H, false);
      this.body.add(hip);
      if (a.bottom === 'skirt') this.body.add(tube(0.15, 0.27, 0.2 * H, bottomMat(1.3, 0.2 * H, THREE.DoubleSide), 0.28 * H, true, 1));
    }
    // 上衣的小细节
    if (suit) {
      // 套装没有这些
    } else if (a.top === 'hoodie') {
      this.body.add(sphere(0.17, shade(top, -0.06), [0, 0.68 * H, -0.11], [1.05, 0.55, 0.55]));
      this.body.add(sphere(0.1, shade(top, -0.06), [0, 0.42 * H, 0.12], [1, 0.45, 0.25]));
      for (const s of [-1, 1]) this.body.add(capsule(0.008, 0.08, '#f7f6f2', 0.6 * H).translateX(s * 0.04).translateZ(0.13));
    } else if (a.top === 'shirt') {
      for (const s of [-1, 1]) {
        const collar = sphere(0.06, '#ffffff', [s * 0.05, 0.69 * H, 0.1], [1, 0.4, 0.6]);
        collar.rotation.z = s * 0.5;
        this.body.add(collar);
      }
      for (let i = 0; i < 3; i += 1) this.body.add(sphere(0.012, shade(top, -0.3), [0, (0.6 - i * 0.09) * H, 0.13], [1, 1, 0.5], 8));
    } else if (a.top === 'sweater') {
      const hem = new THREE.Mesh(new THREE.TorusGeometry(0.155, 0.02, 8, 24), toon(shade(top, -0.08)));
      hem.rotation.x = Math.PI / 2;
      hem.position.y = 0.36 * H;
      hem.scale.set(1, 0.84, 1);
      const neck = hem.clone();
      neck.scale.set(0.45, 0.4, 1);
      neck.position.y = 0.72 * H;
      this.body.add(hem, neck);
    }

    // 胳膊（肩膀处转）
    for (const side of [-1, 1]) {
      const arm = new THREE.Group();
      arm.position.set(side * 0.19, 0.64 * H, 0);
      arm.rotation.z = side * 0.14;
      arm.add(capsule(0.05, 0.18 * H, longSleeve ? topMat(0.31, 0.28) : skin, -0.13 * H));
      if (!longSleeve) arm.add(capsule(0.06, 0.04, topMat(0.38, 0.16), -0.04).translateX(side * 0.004));
      if (dress) arm.add(sphere(0.075, top, [0, -0.03, 0], [1, 0.85, 1]));
      // 浴衣的大袖子：挂在小臂上的一片
      if (yukata) arm.add(sphere(0.088, topMat(0.5, 0.26), [side * 0.004, -0.17 * H, 0], [0.7, 1.45, 1.35]));
      if (robe) arm.add(capsule(0.058, 0.02, trim, -0.225 * H));
      arm.add(sphere(0.058, gloves ? a.accColor : skin, [0, -0.27 * H, 0]));
      if (gloves) arm.add(capsule(0.056, 0.012, shade(a.accColor, -0.1), -0.232 * H));
      this.arms.push(arm);
      this.body.add(arm);
    }

    // 挂在脖子上的耳机
    if (a.acc.includes('neckphones')) {
      const c = a.accColor;
      const geo = new THREE.TorusGeometry(0.14, 0.02, 8, 28, Math.PI * 1.2);
      geo.rotateZ(-Math.PI * 0.1);
      const band = new THREE.Mesh(geo, toon(shade(c, -0.1)));
      band.rotation.x = -Math.PI / 2;
      band.position.set(0, 0.705 * H, -0.01);
      band.scale.set(1, 0.82, 1);
      this.body.add(band);
      for (const s of [-1, 1]) {
        const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.058, 0.045, 18), toon(c));
        cup.rotation.set(Math.PI / 2, 0, s * 0.5);
        cup.position.set(s * 0.128, 0.675 * H, 0.06);
        cup.castShadow = true;
        this.body.add(cup);
      }
    }

    // 头
    this.head = new THREE.Group();
    this.head.position.y = 0.72 * H + R * 0.92;
    this.body.add(this.head);
    this.head.add(sphere(R, skin, [0, 0, 0], [1, 0.96, 0.96], 32));
    this.head.add(sphere(0.07, skin, [0, -R * 0.95, 0]));
    // 脸：头前面的一片
    this.faceMat = new THREE.MeshToonMaterial({ transparent: true, depthWrite: false });
    this.faceMat.gradientMap = (toon(skin).gradientMap as THREE.Texture) ?? null;
    this.face = new THREE.Mesh(new THREE.SphereGeometry(R * 1.004, 32, 16, 0.2 * Math.PI, 0.6 * Math.PI, 0.42 * Math.PI, 0.36 * Math.PI), this.faceMat);
    this.face.scale.set(1, 0.96, 0.96);
    this.head.add(this.face);
    this.lastFace = '';
    this.applyFace();

    this.buildHair(R, K);
    this.buildAccessory(R, K);
  }

  private buildHair(R: number, K: number) {
    const a = this.avatar;
    const c = a.hairColor;
    // 头发都放在这一组里：翻转就是把这一组左右镜像
    const h = new THREE.Group();
    this.head.add(h);
    const tie = a.acc.length ? a.accColor : '#f4b6c2';
    h.add(shell(R * 1.07, c, 0, 2, 0, a.bangs === 'none' ? 0.3 : 0.38));
    const back: Record<string, [number, number, number]> = {
      short: [0.8, 1.4, 0.62],
      spiky: [0.8, 1.4, 0.6],
      bob: [0.72, 1.56, 0.78],
      long: [0.72, 1.56, 0.8],
      wild: [0.72, 1.56, 0.8],
      twin: [0.8, 1.4, 0.64],
      pony: [0.8, 1.4, 0.62],
      bun: [0.8, 1.4, 0.62],
    };
    const [p0, pl, tl] = back[a.hair] ?? back.short!;
    const b = shell(R * (['bob', 'long', 'wild'].includes(a.hair) ? 1.1 : 1.07), c, p0, pl, 0, tl);
    if (a.hair === 'bob') b.scale.set(1.06, 1.02, 1.02);
    h.add(b);

    // 刘海
    if (a.bangs === 'straight') {
      h.add(shell(R * 1.075, c, 0.1, 0.8, 0, 0.46));
      for (let i = -3; i <= 3; i += 1) {
        const tip = new THREE.Mesh(new THREE.ConeGeometry(0.05 * K, 0.08 * K, 8), toon(c));
        tip.position.copy(onSphere(R * 1.06, 0.5 + i * 0.075, 0.47));
        tip.lookAt(tip.position.clone().multiplyScalar(2));
        tip.rotateX(Math.PI * 0.82);
        h.add(tip);
      }
    } else if (a.bangs === 'side') {
      h.add(shell(R * 1.075, c, 0.1, 0.8, 0, 0.4));
      h.add(shell(R * 1.08, c, 0.12, 0.44, 0, 0.5));
    } else if (a.bangs === 'parted') {
      h.add(shell(R * 1.075, c, 0.1, 0.37, 0, 0.47));
      h.add(shell(R * 1.075, c, 0.53, 0.37, 0, 0.47));
    } else if (a.bangs === 'oneEye') {
      // 偏分：一边是几束长长的尖发束，从额头一直垂到下巴下面，把那只眼睛盖住；另一边短短的露出眼睛，脸旁边再垂两束
      h.add(shell(R * 1.075, c, 0.1, 0.42, 0, 0.43));
      h.add(shell(R * 1.075, c, 0.5, 0.4, 0, 0.41));
      // [绕头的位置, 多长, 多粗, 往旁边斜多少]：发束是直着垂下来的（不贴着脸弯），越靠中间越长
      for (const [phi, len, rad, slant] of [
        [0.15, 0.36, 0.08, -0.14],
        [0.24, 0.46, 0.09, -0.07],
        [0.33, 0.54, 0.095, -0.02],
        [0.42, 0.46, 0.085, 0.03],
        [0.5, 0.3, 0.06, -0.3],
        [0.58, 0.11, 0.05, 0.1],
        [0.66, 0.12, 0.055, 0.12],
        [0.76, 0.4, 0.085, 0.1],
        [0.85, 0.34, 0.08, 0.16],
      ] as const) {
        h.add(spike(len * K, rad * K, c, onSphere(R * 1.07, phi, 0.4), new THREE.Vector3(slant, -1, 0.05)));
      }
    }

    // 发顶
    if (a.hairTop === 'fluffy') {
      h.add(sphere(R * 0.66, c, [0, R * 0.6, -R * 0.06], [1.22, 0.74, 1.18]));
      for (let i = 0; i < 6; i += 1) {
        const p = onSphere(R * 0.98, (i / 6) * 2 + 0.12, 0.22);
        h.add(sphere(0.115 * K, c, [p.x, p.y, p.z]));
      }
    } else if (a.hairTop === 'ahoge') {
      // 一根翘起来的呆毛：从头顶弯上去
      const r = 0.12 * K;
      const strand = new THREE.Mesh(new THREE.TorusGeometry(r, 0.016 * K, 6, 14, Math.PI * 0.62), toon(c));
      strand.position.set(-r * 0.86, R * 1.02, -r * 0.5);
      strand.rotation.y = 0.5;
      strand.castShadow = true;
      h.add(strand);
    } else if (a.hairTop === 'spiky') {
      h.add(spike(0.24 * K, 0.09 * K, c, new THREE.Vector3(0, R * 0.96, 0), new THREE.Vector3(0.1, 1, -0.15)));
      for (const [theta, n, len, off] of [
        [0.13, 5, 0.26, 0.15],
        [0.25, 8, 0.24, 0],
      ] as const) {
        for (let i = 0; i < n; i += 1) {
          const p = onSphere(R * 0.97, (i / n) * 2 + off, theta);
          h.add(spike(len * K, 0.088 * K, c, p, p.clone().normalize().lerp(UP, 0.3)));
        }
      }
    } else if (a.hairTop === 'messy') {
      // 几撮不听话的头发：贴着头皮往各个方向翘
      for (let i = 0; i < 9; i += 1) {
        const phi = (i / 9) * 2 + (i % 2) * 0.07;
        const p = onSphere(R * 1.0, phi, 0.12 + (i % 3) * 0.09);
        const n = p.clone().normalize();
        const side = new THREE.Vector3().crossVectors(UP, n).normalize().multiplyScalar(i % 2 ? 0.9 : -0.9);
        h.add(spike((0.14 + (i % 3) * 0.03) * K, 0.06 * K, c, p, n.add(side)));
      }
    }

    // 发型
    if (a.hair === 'long') {
      const panel = sphere(0.36 * K, c, [0, -R * 0.75, -R * 0.55], [0.95, 1.5, 0.42]);
      h.add(panel);
      for (const s of [-1, 1]) h.add(capsule(0.07 * K, 0.36 * K, c, -R * 0.75).translateX(s * R * 0.92).translateZ(R * 0.05));
    } else if (a.hair === 'wild') {
      // 炸开的长发：背后一大片，一层层的发束往外、往下炸，两边还有几束垂到胸前
      h.add(sphere(0.36 * K, c, [0, -R * 0.7, -R * 0.6], [1.22, 1.28, 0.5]));
      // 一层层往下：最下面一层的发梢到腰下面一点
      const rows = [
        { y: 0.25, half: 1.12, n: 5, len: 0.3, down: 0.35 },
        { y: -0.25, half: 1.28, n: 6, len: 0.34, down: 0.7 },
        { y: -0.75, half: 1.32, n: 6, len: 0.36, down: 1.0 },
        { y: -1.2, half: 1.15, n: 5, len: 0.34, down: 1.5 },
        { y: -1.45, half: 0.7, n: 4, len: 0.3, down: 2.4 },
      ];
      rows.forEach((row, j) => {
        for (let i = 0; i < row.n; i += 1) {
          const u = (i / (row.n - 1)) * 2 - 1;
          const pos = new THREE.Vector3(u * row.half * R * 0.82, row.y * R, -R * (0.42 + 0.3 * (1 - u * u)));
          const dir = new THREE.Vector3(u * 1.15, -row.down, -0.5 * (1 - Math.abs(u)) - 0.1);
          h.add(spike(row.len * K * (0.88 + ((i * 7 + j * 3) % 3) * 0.1), 0.115 * K, c, pos, dir));
        }
      });
      for (const s of [-1, 1]) {
        h.add(spike(0.34 * K, 0.085 * K, c, new THREE.Vector3(s * R * 0.98, -R * 0.25, R * 0.12), new THREE.Vector3(s * 0.35, -1, 0.12)));
        h.add(spike(0.42 * K, 0.1 * K, c, new THREE.Vector3(s * R * 1.0, -R * 0.1, -R * 0.2), new THREE.Vector3(s * 0.55, -1, -0.05)));
      }
    } else if (a.hair === 'bob') {
      for (const s of [-1, 1]) h.add(sphere(0.12 * K, c, [s * R * 0.9, -R * 0.42, R * 0.08], [0.7, 1.2, 1]));
    } else if (a.hair === 'twin') {
      for (const s of [-1, 1]) {
        const tail = new THREE.Group();
        tail.position.set(s * R * 1.0, R * 0.25, -R * 0.15);
        tail.rotation.z = s * 0.35;
        tail.add(capsule(0.085 * K, 0.42 * K, c, -0.3 * K));
        tail.add(sphere(0.045 * K, tie, [0, -0.02, 0]));
        h.add(tail);
      }
    } else if (a.hair === 'pony') {
      const tail = new THREE.Group();
      tail.position.set(0, R * 0.55, -R * 0.9);
      tail.rotation.x = 0.45;
      tail.add(capsule(0.09 * K, 0.42 * K, c, -0.3 * K), sphere(0.045 * K, tie, [0, 0, 0]));
      h.add(tail);
    } else if (a.hair === 'bun') {
      h.add(sphere(0.15 * K, c, [0, R * 1.0, -R * 0.25]));
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.1 * K, 0.025, 8, 20), toon(tie));
      ring.position.set(0, R * 0.88, -R * 0.2);
      ring.rotation.x = Math.PI / 2 - 0.3;
      h.add(ring);
    } else if (a.hair === 'spiky') {
      for (let i = 0; i < 7; i += 1) {
        const cone = new THREE.Mesh(new THREE.ConeGeometry(0.08 * K, 0.18 * K, 8), toon(c));
        const p = onSphere(R * 1.0, 0.3 + i * 0.23, 0.18 + (i % 2) * 0.1);
        cone.position.copy(p);
        cone.lookAt(p.clone().multiplyScalar(2));
        cone.rotateX(Math.PI / 2);
        cone.castShadow = true;
        h.add(cone);
      }
    }

    if (a.hairFlip) h.scale.x = -1;
    if (a.hairColor2 && a.hairColor2.toLowerCase() !== c.toLowerCase()) this.tintHair(h, R);
  }

  /** 发梢渐变：头发的每个顶点按高低染色（头顶是发色，越往下越接近渐变色） */
  private tintHair(hair: THREE.Group, R: number) {
    const a = this.avatar;
    const plain = toon(a.hairColor);
    const both = toon(a.hairColor, { side: THREE.DoubleSide });
    const from = new THREE.Color(a.hairColor);
    const to = new THREE.Color(a.hairColor2);
    hair.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(hair.matrixWorld).invert();
    const rel = new THREE.Matrix4();
    const v = new THREE.Vector3();
    const parts: { mesh: THREE.Mesh; ys: Float32Array }[] = [];
    let lo = -R * 0.5;
    hair.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || (mesh.material !== plain && mesh.material !== both)) return;
      rel.multiplyMatrices(inv, mesh.matrixWorld);
      const pos = mesh.geometry.getAttribute('position');
      const ys = new Float32Array(pos.count);
      for (let i = 0; i < pos.count; i += 1) {
        ys[i] = v.fromBufferAttribute(pos, i).applyMatrix4(rel).y;
        if (ys[i]! < lo) lo = ys[i]!;
      }
      parts.push({ mesh, ys });
    });
    const hi = R * 0.5;
    const col = new THREE.Color();
    const mat = toonVertex();
    for (const { mesh, ys } of parts) {
      const colors = new Float32Array(ys.length * 3);
      for (let i = 0; i < ys.length; i += 1) {
        let t = Math.min(1, Math.max(0, (hi - ys[i]!) / (hi - lo)));
        t = t * t * (3 - 2 * t);
        col.lerpColors(from, to, t);
        colors[i * 3] = col.r;
        colors[i * 3 + 1] = col.g;
        colors[i * 3 + 2] = col.b;
      }
      mesh.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      mesh.material = mat;
    }
  }

  private buildAccessory(R: number, K: number) {
    const a = this.avatar;
    const h = this.head;
    const c = a.accColor;
    const has = (id: string) => a.acc.includes(id);
    if (has('catEars')) {
      for (const s of [-1, 1]) {
        const ear = new THREE.Mesh(new THREE.ConeGeometry(0.1 * K, 0.18 * K, 12), toon(a.hairColor));
        ear.position.set(s * R * 0.55, R * 0.92, -R * 0.05);
        ear.rotation.z = -s * 0.35;
        ear.castShadow = true;
        const inner = new THREE.Mesh(new THREE.ConeGeometry(0.06 * K, 0.11 * K, 12), toon('#f4b6c2'));
        inner.position.set(0, -0.02, 0.04);
        ear.add(inner);
        h.add(ear);
      }
    }
    if (has('glasses')) {
      const mat = toon(c === '#f7f6f2' ? '#3a2a2e' : shade(c, -0.15));
      const y = -R * 0.19;
      const z = R * 0.97;
      for (const s of [-1, 1]) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.075 * K, 0.012, 8, 28), mat);
        ring.position.set(s * R * 0.3, y, z);
        h.add(ring);
        const temple = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.012, R * 0.8), mat);
        temple.position.set(s * R * 0.52, y + 0.01, R * 0.55);
        h.add(temple);
      }
      const bridge = new THREE.Mesh(new THREE.BoxGeometry(R * 0.2, 0.012, 0.012), mat);
      bridge.position.set(0, y + 0.02, z + 0.01);
      h.add(bridge);
    }
    if (has('bow')) {
      const bow = new THREE.Group();
      for (const s of [-1, 1]) {
        const wing = new THREE.Mesh(new THREE.ConeGeometry(0.07 * K, 0.13 * K, 12), toon(c));
        wing.rotation.z = s * (Math.PI / 2);
        wing.position.x = s * 0.06 * K;
        wing.castShadow = true;
        bow.add(wing);
      }
      bow.add(sphere(0.035 * K, shade(c, -0.1), [0, 0, 0]));
      bow.position.copy(onSphere(R * 1.08, 0.3, 0.2));
      bow.rotation.set(-0.2, -0.3, 0.4);
      h.add(bow);
    }
    if (has('beanie')) {
      h.add(shell(R * 1.13, c, 0, 2, 0, 0.36));
      const brim = new THREE.Mesh(new THREE.TorusGeometry(R * 1.13 * Math.sin(0.36 * Math.PI), 0.045, 8, 32), toon(shade(c, -0.08)));
      brim.rotation.x = Math.PI / 2;
      brim.position.y = R * 1.13 * Math.cos(0.36 * Math.PI);
      h.add(brim, sphere(0.08 * K, '#f7f6f2', [0, R * 1.18, 0]));
    }
    if (has('headphones')) {
      const band = new THREE.Mesh(new THREE.TorusGeometry(R * (has('beanie') ? 1.2 : 1.14), 0.026, 8, 32, Math.PI), toon(shade(c, -0.1)));
      h.add(band);
      for (const s of [-1, 1]) {
        const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.1 * K, 0.1 * K, 0.08, 20), toon(c));
        cup.rotation.z = Math.PI / 2;
        cup.position.set(s * R * 1.1, -R * 0.08, 0);
        cup.castShadow = true;
        h.add(cup);
      }
    }
    if (has('flower')) {
      const f = new THREE.Group();
      for (let i = 0; i < 5; i += 1) {
        const ang = (i / 5) * Math.PI * 2;
        f.add(sphere(0.04 * K, c, [Math.cos(ang) * 0.045 * K, Math.sin(ang) * 0.045 * K, 0], [1, 1, 0.5], 10));
      }
      f.add(sphere(0.03 * K, '#f6e09a', [0, 0, 0.015], [1, 1, 0.6], 10));
      f.position.copy(onSphere(R * 1.09, 0.22, 0.32));
      f.lookAt(f.position.clone().multiplyScalar(2));
      h.add(f);
    }
  }

  private applyFace() {
    const blinking = this.t < this.blinkUntil;
    const st: FaceState = { ...(this.t < this.overrideUntil ? (this.override ?? {}) : {}) };
    if (this.pose === 'lie') st.closed = true;
    if (blinking && !st.closed && st.eyes !== 'smile' && (st.eyes ?? this.avatar.eyes) !== 'smile') st.closed = true;
    const key = JSON.stringify(st);
    if (key === this.lastFace) return;
    this.lastFace = key;
    this.faceMat.map = faceTexture(this.avatar, st);
    this.faceMat.needsUpdate = true;
  }

  /** 每帧调用：dt 秒 */
  update(dt: number) {
    this.t += dt;
    const t = this.t;
    const H = this.avatar.height;
    // 眨眼
    if (t > this.blinkAt) {
      this.blinkUntil = t + 0.13;
      this.blinkAt = t + 2.2 + Math.random() * 3.5;
    }
    this.applyFace();

    // 走路
    let moving = false;
    if (this.path.length) {
      const target = this.path[0]!;
      const pos = this.root.position;
      const dx = target.x - pos.x;
      const dz = target.z - pos.z;
      const dist = Math.hypot(dx, dz);
      const step = this.speed * dt;
      if (dist <= step) {
        pos.set(target.x, 0, target.z);
        this.path.shift();
        if (!this.path.length) {
          const cb = this.onArrive;
          this.onArrive = null;
          cb?.();
        }
      } else {
        pos.x += (dx / dist) * step;
        pos.z += (dz / dist) * step;
        const want = Math.atan2(dx, dz);
        let diff = want - this.root.rotation.y;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        this.root.rotation.y += diff * Math.min(1, dt * 12);
        moving = true;
      }
    }

    const [legA, legB] = this.legs;
    const [armA, armB] = this.arms;
    const hop = t < this.hopUntil ? Math.abs(Math.sin(((this.hopUntil - t) / 0.7) * Math.PI * 2)) * 0.16 : 0;
    this.body.rotation.set(0, 0, 0);
    this.head.rotation.set(0, 0, 0);
    if (this.pose === 'sit') {
      this.body.position.y = this.seatH - HIP * H + Math.sin(t * 2) * 0.006;
      legA!.rotation.set(-Math.PI / 2 + 0.12 + Math.sin(t * 3) * 0.06, 0, 0);
      legB!.rotation.set(-Math.PI / 2 + 0.12 - Math.sin(t * 3) * 0.06, 0, 0);
      armA!.rotation.set(-0.5, 0, -0.2);
      armB!.rotation.set(-0.5, 0, 0.2);
      this.head.rotation.z = Math.sin(t * 0.9) * 0.05;
    } else if (this.pose === 'lie') {
      this.body.position.y = this.seatH + 0.2;
      this.body.position.z = 0;
      this.body.rotation.x = -Math.PI / 2;
      legA!.rotation.set(0, 0, 0.05);
      legB!.rotation.set(0, 0, -0.05);
      armA!.rotation.set(0, 0, -0.3);
      armB!.rotation.set(0, 0, 0.3);
    } else if (moving) {
      const s = Math.sin(t * 11);
      this.body.position.y = Math.abs(Math.cos(t * 11)) * 0.04;
      legA!.rotation.set(s * 0.6 * this.stride, 0, 0);
      legB!.rotation.set(-s * 0.6 * this.stride, 0, 0);
      armA!.rotation.set(-s * 0.7, 0, -0.14);
      armB!.rotation.set(s * 0.7, 0, 0.14);
    } else {
      this.body.position.y = Math.sin(t * 2.2) * 0.012 + hop;
      legA!.rotation.set(0, 0, 0);
      legB!.rotation.set(0, 0, 0);
      armA!.rotation.set(Math.sin(t * 2.2) * 0.05, 0, -0.14 - Math.sin(t * 2.2) * 0.03);
      armB!.rotation.set(-Math.sin(t * 2.2) * 0.05, 0, 0.14 + Math.sin(t * 2.2) * 0.03);
      this.head.rotation.z = Math.sin(t * 1.1) * 0.04;
    }
    if (this.longSkirt) this.longSkirt.scale.y = this.pose === 'sit' ? 0.35 : 1;
    if (t < this.waveUntil && this.pose !== 'lie') {
      armB!.rotation.set(0, 0, 2.5 + Math.sin(t * 12) * 0.35);
      this.head.rotation.z = -0.08;
    }
  }
}
