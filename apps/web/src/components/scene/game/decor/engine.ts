import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Avatar } from './avatar';
import { Chibi } from './chibi';
import { buildFurniture, disposeObject } from './furniture';
import {
  blocks,
  catalogItem,
  checkPlace,
  childrenOf,
  footprint,
  itemColor,
  localToRoom,
  rectOf,
  snapCenter,
  supportUnder,
  WALL_H,
  type DecorItem,
  type DecorRoom,
  type Turn,
  type WallSide,
} from './model';
import { disposeMaterials, floorTexture, setGlow, shade, toon, wallTexture } from './textures';

/**
 * 装修小屋的 3D 画面（three.js）：娃娃屋式的一间屋子（后墙 + 左墙 + 地面），家具、两个 Q 版小人。
 * - 布置：点家具选中，按住选中的家具拖着挪（对齐半格，放不下的地方变红、松手弹回去）。
 * - 视角：两根手指一起拖、或者两指拧着转是转视角，捏合是缩放；一根手指只管点选和拖家具（鼠标还是按住左键拖、滚轮缩放）。
 * - 逛逛：点地面你的小人走过去，点沙发、椅子坐下，点床躺下；点小人蹦一下。
 * 她的小人自己在屋里走走、坐坐。
 * 一套小屋有好几个房间，这里一次只显示一间：换了房间（room.id 变了）小人回到屋子中间、视角回正。
 * 屋子的数据由外面（Vue）管：这里只显示、只报告"想把哪件挪到哪"，外面改好了再 setRoom 回来。
 */

export interface EngineEvents {
  select(id: string | null): void;
  move(id: string, to: { x: number; z: number; turn?: Turn; y?: number; wall?: WallSide }): void;
  invalid(reason: string): void;
  tapChibi(who: 'you' | 'her'): void;
  /** 逛逛时你的小人去做了什么（坐下、躺下） */
  act?(text: string): void;
}

interface ItemView {
  obj: THREE.Group;
  sig: string;
  item: DecorItem;
}

const CELL = 0.5;
const ACCENT = '#ff8fb1';
const BAD = '#ff5a5a';
const SKY_DAY = '#cfe6f7';
const SKY_NIGHT = '#2b3a67';
const Y_AXIS = new THREE.Vector3(0, 1, 0);

export class DecorEngine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(32, 1, 0.5, 120);
  private controls: OrbitControls;
  private shell = new THREE.Group();
  private furniture = new THREE.Group();
  private items = new Map<string, ItemView>();
  private room: DecorRoom | null = null;
  private shellSig = '';
  private hemi = new THREE.HemisphereLight('#fffaf0', '#c9b8a8', 1.5);
  private sun = new THREE.DirectionalLight('#fff3e0', 1.7);
  private lamps: THREE.PointLight[] = [];
  private night = false;
  private mode: 'edit' | 'live' = 'edit';
  private selected: string | null = null;
  private marker: THREE.Group;
  private markerFill: THREE.Mesh;
  private markerLine: THREE.LineSegments;
  private you: Chibi | null = null;
  private her: Chibi | null = null;
  private seats = new Map<string, 'you' | 'her'>();
  private seatOf: Record<'you' | 'her', string | null> = { you: null, her: null };
  private blocked: Uint8Array = new Uint8Array(0);
  private nx = 0;
  private nz = 0;
  private raf = 0;
  private running = false;
  private last = 0;
  private acc = 0;
  private pops = new Map<THREE.Object3D, number>();
  private animated: THREE.Object3D[] = [];
  private herNextAt = 0;
  private time = 0;
  private resizeObs: ResizeObserver;
  private ray = new THREE.Raycaster();
  private drag: {
    id: string;
    start: { x: number; y: number };
    offset: THREE.Vector3;
    to: { x: number; z: number; turn: Turn; y?: number; wall?: WallSide } | null;
    ok: boolean;
    reason: string;
    moved: boolean;
  } | null = null;
  private down: { x: number; y: number; t: number; id: string | null; chibi: 'you' | 'her' | null; pointer: number } | null = null;
  /** 屏幕上的手指（触屏）：两根时拧着转视角 */
  private fingers = new Map<number, { x: number; y: number }>();
  private twist: number | null = null;
  private readonly reduceMotion = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  constructor(
    private canvas: HTMLCanvasElement,
    private events: EngineEvents,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setClearColor(0x000000, 0);
    this.scene.add(this.hemi, this.sun, this.sun.target, this.shell, this.furniture);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(1024, 1024);
    this.sun.shadow.bias = -0.0008;
    this.sun.shadow.normalBias = 0.02;

    // 选中框：地上一圈
    const plane = new THREE.PlaneGeometry(1, 1);
    plane.rotateX(-Math.PI / 2);
    this.markerFill = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.22, depthWrite: false }));
    this.markerLine = new THREE.LineSegments(new THREE.EdgesGeometry(plane), new THREE.LineBasicMaterial({ color: ACCENT }));
    this.marker = new THREE.Group();
    this.marker.add(this.markerFill, this.markerLine);
    this.marker.visible = false;
    this.marker.renderOrder = 2;
    this.scene.add(this.marker);

    // 自己的指针事件先注册：拖家具时先关掉转视角
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onCancel);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.enablePan = false;
    this.controls.minAzimuthAngle = -0.2;
    this.controls.maxAzimuthAngle = Math.PI / 2 + 0.2;
    this.controls.minPolarAngle = 0.35;
    this.controls.maxPolarAngle = 1.22;
    this.controls.rotateSpeed = 0.7;
    // 触屏：一根手指不转视角（留给点选、拖家具），两根手指一起拖是转、捏合是缩放；两指拧着转在 onMove 里自己算
    this.controls.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE };

    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(canvas.parentElement ?? canvas);
    this.resize();
  }

  // —— 生命周期 ——

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.acc += dt;
      // 30 帧够了，省电
      if (this.acc < 1 / 31) return;
      this.tick(this.acc);
      this.acc = 0;
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  dispose() {
    this.stop();
    this.resizeObs.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointercancel', this.onCancel);
    this.controls.dispose();
    for (const v of this.items.values()) disposeObject(v.obj);
    this.items.clear();
    this.clearShell();
    this.you?.dispose();
    this.her?.dispose();
    this.renderer.dispose();
    disposeMaterials();
  }

  resize() {
    const el = this.canvas.parentElement ?? this.canvas;
    const w = Math.max(1, el.clientWidth);
    const h = Math.max(1, el.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.room) this.fitCamera(false);
  }

  // —— 屋子 ——

  setRoom(room: DecorRoom) {
    const switched = !!this.room && this.room.id !== room.id;
    const sizeChanged = !this.room || this.room.w !== room.w || this.room.d !== room.d;
    this.room = room;
    const sig = JSON.stringify([room.w, room.d, room.wall, room.floor]);
    if (sig !== this.shellSig) {
      this.shellSig = sig;
      this.buildShell(room);
    }
    const seen = new Set<string>();
    for (const item of room.items) {
      seen.add(item.id);
      const sigI = `${item.kind}|${itemColor(item)}`;
      let view = this.items.get(item.id);
      if (!view || view.sig !== sigI) {
        if (view) {
          this.furniture.remove(view.obj);
          disposeObject(view.obj);
        }
        const obj = buildFurniture(item.kind, itemColor(item));
        obj.userData.itemId = item.id;
        this.furniture.add(obj);
        view = { obj, sig: sigI, item };
        this.items.set(item.id, view);
      }
      view.item = item;
      this.place(view.obj, item);
    }
    for (const [id, v] of this.items) {
      if (seen.has(id)) continue;
      this.furniture.remove(v.obj);
      disposeObject(v.obj);
      this.items.delete(id);
    }
    this.collectAnimated();
    this.updateLamps();
    this.buildNav();
    if (switched) {
      // 换了一间：从座位上下来，站到新房间中间
      this.seats.clear();
      this.seatOf = { you: null, her: null };
      this.pops.clear();
      for (const c of [this.you, this.her]) {
        c?.stop();
        c?.stand();
      }
      if (this.you) this.spawn(this.you, 0.62, 0.6);
      if (this.her) this.spawn(this.her, 0.38, 0.62);
      this.herNextAt = this.time + 6;
    }
    this.fixChibis();
    if (this.selected && !this.items.has(this.selected)) this.select(null);
    else this.updateMarker();
    if (sizeChanged || switched) this.fitCamera(true);
  }

  /** 新放的东西冒出来 */
  pop(ids: string[]) {
    if (this.reduceMotion) return;
    const now = this.time;
    ids.forEach((id, i) => {
      const v = this.items.get(id);
      if (v) {
        v.obj.scale.setScalar(0.001);
        this.pops.set(v.obj, now + i * 0.18);
      }
    });
  }

  private place(obj: THREE.Object3D, item: DecorItem) {
    const room = this.room!;
    const c = catalogItem(item.kind);
    if (c?.place === 'wall') {
      const y = item.y ?? c.wallY ?? 1.4;
      if (item.wall === 'left') {
        obj.position.set(-room.w / 2, y, item.z - room.d / 2);
        obj.rotation.set(0, Math.PI / 2, 0);
      } else {
        obj.position.set(item.x - room.w / 2, y, -room.d / 2);
        obj.rotation.set(0, 0, 0);
      }
      return;
    }
    let y = 0;
    if (item.on) y = catalogItem(room.items.find((s) => s.id === item.on)?.kind ?? '')?.top ?? 0;
    else if (c?.place === 'rug') y = 0.002 + room.items.filter((i) => catalogItem(i.kind)?.place === 'rug').findIndex((i) => i.id === item.id) * 0.004;
    obj.position.set(item.x - room.w / 2, y, item.z - room.d / 2);
    obj.rotation.set(0, (item.turn * Math.PI) / 2, 0);
  }

  private clearShell() {
    this.shell.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        if (mat.userData.own) {
          (mat as THREE.MeshToonMaterial).map?.dispose();
          mat.dispose();
        }
      }
    });
    this.shell.clear();
  }

  private buildShell(room: DecorRoom) {
    this.clearShell();
    const { w, d } = room;
    const own = (map: THREE.Texture) => {
      const m = new THREE.MeshToonMaterial({ map, gradientMap: (toon('#ffffff').gradientMap as THREE.Texture) ?? null });
      m.userData.own = true;
      return m;
    };
    const edge = toon(shade(room.wall.color, -0.12));
    const top = toon(shade(room.wall.color, 0.08));
    const T = 0.15;
    // 地面
    const floorGeo = new THREE.PlaneGeometry(w, d);
    floorGeo.rotateX(-Math.PI / 2);
    const floor = new THREE.Mesh(floorGeo, own(floorTexture(room.floor.finish, room.floor.color, w, d)));
    floor.receiveShadow = true;
    floor.userData.floor = true;
    const base = new THREE.Mesh(new THREE.BoxGeometry(w + T, 0.22, d + T), toon(shade(room.floor.color, -0.22)));
    // 底座顶面比地面低一点，免得和地面抢着画（远看会出条纹）
    base.position.set(-T / 2, -0.13, -T / 2);
    base.receiveShadow = true;
    // 后墙（正面贴墙纸）
    const backMats = [edge, edge, top, edge, own(wallTexture(room.wall.finish, room.wall.color, w + T)), edge];
    const back = new THREE.Mesh(new THREE.BoxGeometry(w + T, WALL_H, T), backMats);
    back.position.set(-T / 2, WALL_H / 2, -d / 2 - T / 2);
    back.receiveShadow = true;
    back.userData.wall = 'back';
    // 左墙（朝 +x 那面贴墙纸）
    const leftMats = [own(wallTexture(room.wall.finish, room.wall.color, d)), edge, top, edge, edge, edge];
    const left = new THREE.Mesh(new THREE.BoxGeometry(T, WALL_H, d), leftMats);
    left.position.set(-w / 2 - T / 2, WALL_H / 2, 0);
    left.receiveShadow = true;
    left.userData.wall = 'left';
    this.shell.add(base, floor, back, left);

    // 太阳照着整间屋子
    const r = Math.max(w, d);
    this.sun.position.set(w * 0.35, 7, d * 0.9);
    this.sun.target.position.set(0, 0, 0);
    const cam = this.sun.shadow.camera;
    cam.left = -r;
    cam.right = r;
    cam.top = r;
    cam.bottom = -r;
    cam.near = 0.5;
    cam.far = 30;
    cam.updateProjectionMatrix();
  }

  /**
   * 把整间屋子（地面四角、墙顶、底座）刚好放进画面：上面留出按钮的位置，下面留出提示。
   * reset 时回到右前方斜着看；不 reset（画面大小变了）时保持现在的角度，只重新算远近。
   */
  private fitCamera(reset: boolean) {
    const target = reset ? new THREE.Vector3(0, 0.6, 0) : this.controls.target.clone();
    const sph = reset ? new THREE.Spherical(1, 0.86, Math.PI / 4) : new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target));
    const dist = this.frame(this.camera, sph, target, reset, { top: 0.8, bottom: -0.9, side: 0.97 });
    this.controls.target.copy(target);
    this.controls.minDistance = dist * 0.35;
    this.controls.maxDistance = dist * 1.25;
    this.controls.update();
  }

  /** 按这个角度（sph）找刚好装下整间屋子的远近，摆好相机；center 时顺便把屋子挪到画面中间（改 target）。返回远近 */
  private frame(cam: THREE.PerspectiveCamera, sph: THREE.Spherical, target: THREE.Vector3, center: boolean, m: { top: number; bottom: number; side: number }): number {
    const { w, d } = this.room!;
    const pts = [
      [-w / 2, -0.22, d / 2],
      [w / 2, -0.22, d / 2],
      [w / 2, -0.22, -d / 2],
      [-w / 2, -0.22, -d / 2],
      [-w / 2, WALL_H, -d / 2],
      [w / 2, WALL_H, -d / 2],
      [-w / 2, WALL_H, d / 2],
    ].map(([x, y, z]) => new THREE.Vector3(x, y, z));
    const bbox = (dist: number) => {
      sph.radius = dist;
      cam.position.setFromSpherical(sph).add(target);
      cam.lookAt(target);
      cam.updateMatrixWorld();
      let x0 = Infinity;
      let x1 = -Infinity;
      let y0 = Infinity;
      let y1 = -Infinity;
      for (const p of pts) {
        const q = p.clone().project(cam);
        x0 = Math.min(x0, q.x);
        x1 = Math.max(x1, q.x);
        y0 = Math.min(y0, q.y);
        y1 = Math.max(y1, q.y);
      }
      return { x0, x1, y0, y1 };
    };
    const fits = (b: ReturnType<typeof bbox>) => b.x0 >= -m.side && b.x1 <= m.side && b.y0 >= m.bottom && b.y1 <= m.top;
    const search = () => {
      let lo = 2;
      let hi = 120;
      for (let i = 0; i < 28; i += 1) {
        const mid = (lo + hi) / 2;
        if (fits(bbox(mid))) hi = mid;
        else lo = mid;
      }
      return hi;
    };
    let dist = search();
    if (center) {
      // 屋子在画面里居中（上下按留白的中线）：按偏了多少挪一下看的中心，再算一次远近
      for (let k = 0; k < 2; k += 1) {
        const b = bbox(dist);
        const cx = (b.x0 + b.x1) / 2;
        const cy = (b.y0 + b.y1) / 2 - (m.top + m.bottom) / 2;
        const halfH = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) * dist;
        const halfW = halfH * cam.aspect;
        const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
        target.add(right.multiplyScalar(cx * halfW)).add(up.multiplyScalar(cy * halfH));
        dist = search();
      }
    }
    sph.radius = dist;
    cam.position.setFromSpherical(sph).add(target);
    cam.lookAt(target);
    cam.updateMatrixWorld();
    return dist;
  }

  resetView() {
    if (this.room) this.fitCamera(true);
  }

  // —— 白天 / 晚上 ——

  setNight(on: boolean) {
    this.night = on;
    this.hemi.color.set(on ? '#7d86b8' : '#fffaf0');
    this.hemi.groundColor.set(on ? '#3a3550' : '#c9b8a8');
    this.hemi.intensity = on ? 0.9 : 1.5;
    this.sun.color.set(on ? '#9fb2ff' : '#fff3e0');
    this.sun.intensity = on ? 0.35 : 1.7;
    setGlow(on);
    this.updateLamps();
  }

  private updateLamps() {
    for (const l of this.lamps) this.scene.remove(l);
    for (const l of this.lamps) l.dispose();
    this.lamps = [];
    for (const v of this.items.values()) {
      v.obj.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.userData.sky) m.material = toon(this.night ? SKY_NIGHT : SKY_DAY);
      });
    }
    if (!this.night) return;
    for (const v of this.items.values()) {
      if (this.lamps.length >= 4) break;
      if (!catalogItem(v.item.kind)?.light) continue;
      let at: THREE.Object3D | null = null;
      v.obj.traverse((o) => {
        if (!at && o.userData.lamp) at = o;
      });
      if (!at) continue;
      const p = new THREE.Vector3();
      (at as THREE.Object3D).getWorldPosition(p);
      const light = new THREE.PointLight('#ffd59a', v.item.kind === 'candle' ? 1.2 : 2.6, 4.5, 1.6);
      light.position.copy(p);
      this.scene.add(light);
      this.lamps.push(light);
    }
  }

  // —— 小人 ——

  setAvatars(you: Avatar, her: Avatar) {
    if (!this.you) {
      this.you = new Chibi(you, 'you');
      this.you.root.userData.chibi = 'you';
      this.scene.add(this.you.root);
      this.spawn(this.you, 0.62, 0.6);
    } else if (JSON.stringify(this.you.avatar) !== JSON.stringify(you)) this.you.setAvatar(you);
    if (!this.her) {
      this.her = new Chibi(her, 'her');
      this.her.root.userData.chibi = 'her';
      this.scene.add(this.her.root);
      this.spawn(this.her, 0.38, 0.62);
      // 一开始朝着看的人（镜头在右前方）
      this.her.root.rotation.y = Math.PI / 4 - 0.35;
      this.you.root.rotation.y = Math.PI / 4 + 0.35;
    } else if (JSON.stringify(this.her.avatar) !== JSON.stringify(her)) this.her.setAvatar(her);
    this.herNextAt = this.time + 6;
  }

  /** 她表态：换个表情，开心时挥挥手 */
  herReact(expr: string | null | undefined) {
    if (!this.her) return;
    this.her.setExpression(expr ?? 'smile', 6000);
    if (expr === 'laugh' || expr === 'smile' || expr === 'surprised') {
      if (this.her.pose === 'stand' && !this.her.walking) this.her.wave();
    }
    if (this.her.pose === 'stand' && !this.her.walking && this.you) this.her.faceTo(this.you.root.position.x, this.you.root.position.z);
  }

  /** 她走到某件家具旁边（她刚摆好的东西） */
  herVisit(id: string) {
    const her = this.her;
    const v = this.items.get(id);
    const room = this.room;
    if (!her || !v || !room) return;
    const c = catalogItem(v.item.kind);
    if (c?.seats?.length && Math.random() < 0.5 && this.goSit(her, id)) return;
    let x: number;
    let z: number;
    if (c?.place === 'wall') {
      x = (v.item.wall === 'left' ? 0.6 : v.item.x) - room.w / 2;
      z = (v.item.wall === 'left' ? v.item.z : 0.6) - room.d / 2;
    } else {
      const r = rectOf(v.item.on ? (room.items.find((i) => i.id === v.item.on) ?? v.item) : v.item);
      x = Math.min(r.x1 + 0.3, room.w - 0.25) - room.w / 2;
      z = Math.min(r.z1 + 0.3, room.d - 0.25) - room.d / 2;
    }
    const ax = v.obj.position.x;
    const az = v.obj.position.z;
    this.walkTo(her, x, z, () => her.faceTo(ax, az));
    this.herNextAt = this.time + 12;
  }

  chibiOf(who: 'you' | 'her'): Chibi | null {
    return who === 'you' ? this.you : this.her;
  }

  private spawn(c: Chibi, fx: number, fz: number) {
    const room = this.room;
    if (!room) return;
    const cell = this.nearestFree(Math.floor(fx * this.nx), Math.floor(fz * this.nz));
    if (cell) {
      const p = this.cellCenter(cell[0], cell[1]);
      c.root.position.set(p.x, 0, p.z);
    }
  }

  private fixChibis() {
    for (const c of [this.you, this.her]) {
      if (!c) continue;
      const key = this.seatOf[c.who];
      if (key) {
        const [id] = key.split(':');
        const still = id && this.items.has(id) && this.seatPos(key);
        if (!still) this.release(c);
        else this.reseat(c, key);
      }
      if (c.pose !== 'stand') continue;
      const [ix, iz] = this.cellAt(c.root.position.x, c.root.position.z);
      if (this.isBlocked(ix, iz)) {
        c.stop();
        const cell = this.nearestFree(ix, iz);
        if (cell) {
          const p = this.cellCenter(cell[0], cell[1]);
          c.root.position.set(p.x, 0, p.z);
        }
      } else if (c.walking) {
        // 家具挪过了：重新找路
        c.stop();
      }
    }
  }

  private release(c: Chibi) {
    const key = this.seatOf[c.who];
    if (key) this.seats.delete(key);
    this.seatOf[c.who] = null;
    if (c.pose !== 'stand') {
      c.stand();
      const [ix, iz] = this.cellAt(c.root.position.x, c.root.position.z);
      const cell = this.nearestFree(ix, iz);
      if (cell) {
        const p = this.cellCenter(cell[0], cell[1]);
        c.root.position.set(p.x, 0, p.z);
      }
    }
  }

  /** 座位 / 床位的世界坐标和朝向：key = 家具 id:s 序号 或 家具 id:b 序号 */
  private seatPos(key: string): { x: number; z: number; facing: number; h: number; bed: boolean } | null {
    const [id, slot] = key.split(':');
    const v = id ? this.items.get(id) : undefined;
    const c = v ? catalogItem(v.item.kind) : undefined;
    if (!v || !c || !slot) return null;
    const bed = slot.startsWith('b');
    const idx = Number(slot.slice(1));
    const local = bed ? c.beds?.[idx] : c.seats?.[idx];
    if (!local) return null;
    const [x, z] = localToRoom(v.item, local[0], local[1]);
    const room = this.room!;
    return { x: x - room.w / 2, z: z - room.d / 2, facing: (v.item.turn * Math.PI) / 2, h: (bed ? c.bedH : c.seatH) ?? 0.3, bed };
  }

  private reseat(c: Chibi, key: string) {
    const p = this.seatPos(key);
    if (!p) return;
    // 床头朝后：头的方向是家具的 -z
    if (p.bed) c.lie(p.x, p.z, p.facing + Math.PI, p.h);
    else c.sit(p.x, p.z, p.facing, p.h);
  }

  /** 走到某件家具旁边坐下 / 躺下；没有空位时返回 false */
  private goSit(c: Chibi, id: string): boolean {
    const v = this.items.get(id);
    const cat = v ? catalogItem(v.item.kind) : undefined;
    if (!v || !cat) return false;
    const slots = [...(cat.seats ?? []).map((_, i) => `${id}:s${i}`), ...(cat.beds ?? []).map((_, i) => `${id}:b${i}`)];
    const mine = this.seatOf[c.who];
    const free = slots.filter((k) => !this.seats.has(k) || this.seats.get(k) === c.who);
    if (!free.length) return false;
    // 离得近的那个
    const pos = c.root.position;
    free.sort((a, b) => {
      const pa = this.seatPos(a)!;
      const pb = this.seatPos(b)!;
      return Math.hypot(pa.x - pos.x, pa.z - pos.z) - Math.hypot(pb.x - pos.x, pb.z - pos.z);
    });
    const key = free[0]!;
    if (mine && mine !== key) this.seats.delete(mine);
    this.seats.set(key, c.who);
    this.seatOf[c.who] = key;
    const p = this.seatPos(key)!;
    // 走到座位前面（床走到床边）
    const front = p.bed ? this.besideBed(v.item) : { x: p.x + Math.sin(p.facing) * 0.7, z: p.z + Math.cos(p.facing) * 0.7 };
    const path = this.findPath(c.root.position, new THREE.Vector3(front.x, 0, front.z));
    c.stand();
    c.walk(path ?? [], () => {
      if (this.seatOf[c.who] === key) this.reseat(c, key);
    });
    return true;
  }

  private besideBed(item: DecorItem): { x: number; z: number } {
    const room = this.room!;
    const r = rectOf(item);
    const cands = [
      { x: r.x1 + 0.35, z: (r.z0 + r.z1) / 2 },
      { x: r.x0 - 0.35, z: (r.z0 + r.z1) / 2 },
      { x: (r.x0 + r.x1) / 2, z: r.z1 + 0.35 },
    ];
    for (const p of cands) {
      const [ix, iz] = this.cellAt(p.x - room.w / 2, p.z - room.d / 2);
      if (!this.isBlocked(ix, iz)) return { x: p.x - room.w / 2, z: p.z - room.d / 2 };
    }
    return { x: cands[0]!.x - room.w / 2, z: cands[0]!.z - room.d / 2 };
  }

  private walkTo(c: Chibi, x: number, z: number, onArrive?: () => void) {
    const key = this.seatOf[c.who];
    if (key) this.seats.delete(key);
    this.seatOf[c.who] = null;
    if (c.pose !== 'stand') {
      // 先从座位上下来，站到旁边
      c.stand();
      const [ix, iz] = this.cellAt(c.root.position.x, c.root.position.z);
      const cell = this.nearestFree(ix, iz);
      if (cell) {
        const p = this.cellCenter(cell[0], cell[1]);
        c.root.position.set(p.x, 0, p.z);
      }
    }
    const path = this.findPath(c.root.position, new THREE.Vector3(x, 0, z));
    if (path?.length) c.walk(path, onArrive);
  }

  /** 她自己走走、坐坐 */
  private herWander() {
    const her = this.her;
    const room = this.room;
    if (!her || !room || her.walking) return;
    const r = Math.random();
    const seatsAll = [...this.items.values()].filter((v) => catalogItem(v.item.kind)?.seats?.length);
    const beds = [...this.items.values()].filter((v) => catalogItem(v.item.kind)?.beds?.length);
    const youSeat = this.seatOf.you?.split(':')[0];
    // 你坐着时，她多半过来坐你旁边
    if (youSeat && Math.random() < 0.6 && this.goSit(her, youSeat)) return;
    if (r < 0.35 && seatsAll.length) {
      if (this.goSit(her, seatsAll[Math.floor(Math.random() * seatsAll.length)]!.item.id)) return;
    }
    if (r > 0.92 && beds.length && this.night) {
      if (this.goSit(her, beds[Math.floor(Math.random() * beds.length)]!.item.id)) return;
    }
    if (r < 0.8) {
      for (let tries = 0; tries < 12; tries += 1) {
        const ix = Math.floor(Math.random() * this.nx);
        const iz = Math.floor(Math.random() * this.nz);
        if (this.isBlocked(ix, iz)) continue;
        const p = this.cellCenter(ix, iz);
        // 走到了转过来看着你
        this.walkTo(her, p.x, p.z, () => {
          if (this.you && her.pose === 'stand') her.faceTo(this.you.root.position.x, this.you.root.position.z);
        });
        return;
      }
    }
    if (her.pose === 'stand') her.wave(1.6);
  }

  // —— 寻路（半格的网格） ——

  private buildNav() {
    const room = this.room!;
    this.nx = Math.round(room.w / CELL);
    this.nz = Math.round(room.d / CELL);
    this.blocked = new Uint8Array(this.nx * this.nz);
    const pad = 0.12;
    for (const it of room.items) {
      if (!blocks(room, it)) continue;
      const r = rectOf(it);
      for (let ix = 0; ix < this.nx; ix += 1) {
        for (let iz = 0; iz < this.nz; iz += 1) {
          const cx = (ix + 0.5) * CELL;
          const cz = (iz + 0.5) * CELL;
          if (cx > r.x0 - pad && cx < r.x1 + pad && cz > r.z0 - pad && cz < r.z1 + pad) this.blocked[iz * this.nx + ix] = 1;
        }
      }
    }
  }

  private isBlocked(ix: number, iz: number): boolean {
    if (ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz) return true;
    return this.blocked[iz * this.nx + ix] === 1;
  }

  private cellAt(wx: number, wz: number): [number, number] {
    const room = this.room!;
    return [Math.floor((wx + room.w / 2) / CELL), Math.floor((wz + room.d / 2) / CELL)];
  }

  private cellCenter(ix: number, iz: number): THREE.Vector3 {
    const room = this.room!;
    return new THREE.Vector3((ix + 0.5) * CELL - room.w / 2, 0, (iz + 0.5) * CELL - room.d / 2);
  }

  private nearestFree(ix: number, iz: number): [number, number] | null {
    let best: [number, number] | null = null;
    let bd = Infinity;
    for (let x = 0; x < this.nx; x += 1) {
      for (let z = 0; z < this.nz; z += 1) {
        if (this.isBlocked(x, z)) continue;
        const d = (x - ix) ** 2 + (z - iz) ** 2;
        if (d < bd) {
          bd = d;
          best = [x, z];
        }
      }
    }
    return best;
  }

  private findPath(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3[] | null {
    if (!this.room) return null;
    const s0 = this.cellAt(from.x, from.z);
    const g0 = this.cellAt(to.x, to.z);
    const s = this.isBlocked(...s0) ? this.nearestFree(...s0) : s0;
    const g = this.isBlocked(...g0) ? this.nearestFree(...g0) : g0;
    if (!s || !g) return null;
    const idx = (x: number, z: number) => z * this.nx + x;
    const n = this.nx * this.nz;
    const cost = new Float32Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const open: number[] = [idx(...s)];
    cost[idx(...s)] = 0;
    const goal = idx(...g);
    const h = (i: number) => Math.hypot((i % this.nx) - g[0], Math.floor(i / this.nx) - g[1]);
    const closed = new Uint8Array(n);
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i += 1) if (cost[open[i]!]! + h(open[i]!) < cost[open[bi]!]! + h(open[bi]!)) bi = i;
      const cur = open.splice(bi, 1)[0]!;
      if (cur === goal) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      const cx = cur % this.nx;
      const cz = Math.floor(cur / this.nx);
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dz = -1; dz <= 1; dz += 1) {
          if (!dx && !dz) continue;
          const x = cx + dx;
          const z = cz + dz;
          if (this.isBlocked(x, z)) continue;
          if (dx && dz && (this.isBlocked(cx + dx, cz) || this.isBlocked(cx, cz + dz))) continue;
          const ni = idx(x, z);
          const c = cost[cur]! + (dx && dz ? Math.SQRT2 : 1);
          if (c < cost[ni]!) {
            cost[ni] = c;
            prev[ni] = cur;
            open.push(ni);
          }
        }
      }
    }
    if (cost[goal] === Infinity) return null;
    const cells: number[] = [];
    for (let i = goal; i !== -1; i = prev[i]!) cells.unshift(i);
    const pts = cells.map((i) => this.cellCenter(i % this.nx, Math.floor(i / this.nx)));
    // 终点用点到的位置（在空地上时）
    if (!this.isBlocked(...g0) && pts.length) pts[pts.length - 1] = new THREE.Vector3(to.x, 0, to.z);
    // 拉直：能直接走过去的点跳过
    const out: THREE.Vector3[] = [];
    let anchor = new THREE.Vector3(from.x, 0, from.z);
    for (let i = 0; i < pts.length; i += 1) {
      const next = pts[i + 1];
      if (next && this.clear(anchor, next)) continue;
      out.push(pts[i]!);
      anchor = pts[i]!;
    }
    return out;
  }

  private clear(a: THREE.Vector3, b: THREE.Vector3): boolean {
    const steps = Math.ceil(a.distanceTo(b) / (CELL / 3));
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      const [ix, iz] = this.cellAt(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
      if (this.isBlocked(ix, iz)) return false;
    }
    return true;
  }

  // —— 选中、拖动 ——

  setMode(mode: 'edit' | 'live') {
    this.mode = mode;
    if (mode === 'live') this.select(null);
  }

  select(id: string | null) {
    this.selected = id;
    this.updateMarker();
  }

  private updateMarker(preview?: { item: DecorItem; ok: boolean }) {
    const room = this.room;
    const id = preview?.item.id ?? this.selected;
    const v = id ? this.items.get(id) : undefined;
    if (!room || !v) {
      this.marker.visible = false;
      return;
    }
    const item = preview?.item ?? v.item;
    const c = catalogItem(item.kind)!;
    const color = preview && !preview.ok ? BAD : ACCENT;
    (this.markerFill.material as THREE.MeshBasicMaterial).color.set(color);
    (this.markerLine.material as THREE.LineBasicMaterial).color.set(color);
    this.marker.visible = true;
    if (c.place === 'wall') {
      const y = item.y ?? c.wallY ?? 1.4;
      this.marker.scale.set(c.w + 0.1, 1, c.h + 0.1);
      if (item.wall === 'left') {
        this.marker.position.set(-room.w / 2 + 0.02, y, item.z - room.d / 2);
        // 先立起来朝前，再转到朝右（左墙的墙面朝 +x）
        this.marker.rotation.set(Math.PI / 2, Math.PI / 2, 0, 'YXZ');
      } else {
        this.marker.position.set(item.x - room.w / 2, y, -room.d / 2 + 0.02);
        this.marker.rotation.set(Math.PI / 2, 0, 0);
      }
      return;
    }
    const { w, d } = footprint(item.kind, item.turn);
    let y = 0.03;
    const sup = item.on ? room.items.find((s) => s.id === item.on) : undefined;
    if (sup) y = (catalogItem(sup.kind)?.top ?? 0) + 0.012;
    this.marker.scale.set(w, 1, d);
    this.marker.rotation.set(0, 0, 0);
    this.marker.position.set(item.x - room.w / 2, y, item.z - room.d / 2);
  }

  private pointerNdc(e: PointerEvent): THREE.Vector2 {
    const r = this.canvas.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  private pick(e: PointerEvent): { id: string | null; chibi: 'you' | 'her' | null } {
    this.ray.setFromCamera(this.pointerNdc(e), this.camera);
    const targets: THREE.Object3D[] = [this.furniture];
    if (this.you) targets.push(this.you.root);
    if (this.her) targets.push(this.her.root);
    const hits = this.ray.intersectObjects(targets, true);
    for (const h of hits) {
      let o: THREE.Object3D | null = h.object;
      while (o) {
        if (o.userData.chibi) return { id: null, chibi: o.userData.chibi as 'you' | 'her' };
        if (o.userData.itemId) return { id: o.userData.itemId as string, chibi: null };
        o = o.parent;
      }
    }
    return { id: null, chibi: null };
  }

  /** 两根手指连线的角度（屏幕上顺时针为正） */
  private fingerAngle(): number {
    const [a, b] = [...this.fingers.values()];
    return Math.atan2(b!.y - a!.y, b!.x - a!.x);
  }

  private liftFinger(e: PointerEvent) {
    this.fingers.delete(e.pointerId);
    if (this.fingers.size < 2) this.twist = null;
  }

  private onDown = (e: PointerEvent) => {
    if (e.pointerType === 'touch') {
      this.fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.fingers.size === 2 && !this.drag) {
        // 第二根手指落下：这是要转视角，不算点了一下
        this.twist = this.fingerAngle();
        this.down = null;
      }
    }
    if (!e.isPrimary || !this.room) return;
    const hit = this.pick(e);
    this.down = { x: e.clientX, y: e.clientY, t: performance.now(), id: hit.id, chibi: hit.chibi, pointer: e.pointerId };
    if (this.mode === 'edit' && hit.id && hit.id === this.selected) {
      const v = this.items.get(hit.id)!;
      const at = this.dragPoint(e, v.item);
      this.drag = {
        id: hit.id,
        start: { x: e.clientX, y: e.clientY },
        offset: at ? at.p.clone().sub(this.itemAnchor(v.item)) : new THREE.Vector3(),
        to: null,
        ok: true,
        reason: '',
        moved: false,
      };
      this.controls.enabled = false;
      this.canvas.setPointerCapture(e.pointerId);
    }
  };

  /** 拖动时手指落在哪（家具所在的那个面上） */
  private dragPoint(e: PointerEvent, item: DecorItem): { p: THREE.Vector3; wall?: WallSide } | null {
    const room = this.room!;
    const c = catalogItem(item.kind)!;
    this.ray.setFromCamera(this.pointerNdc(e), this.camera);
    const p = new THREE.Vector3();
    if (c.place === 'wall') {
      const back = this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), room.d / 2), new THREE.Vector3());
      const left = this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(1, 0, 0), room.w / 2), new THREE.Vector3());
      const onBack = back && back.x >= -room.w / 2 && back.x <= room.w / 2 && back.y >= 0 && back.y <= WALL_H ? back : null;
      const onLeft = left && left.z >= -room.d / 2 && left.z <= room.d / 2 && left.y >= 0 && left.y <= WALL_H ? left : null;
      const pick = onBack && onLeft ? (item.wall === 'left' ? onLeft : onBack) : (onBack ?? onLeft);
      return pick ? { p: pick, wall: pick === onLeft ? 'left' : 'back' } : null;
    }
    let h = 0;
    if (c.place === 'top') {
      // 先落到地面上看下面有没有桌台，有就落到台面高度再算一次
      for (let i = 0; i < 2; i += 1) {
        if (!this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -h), p)) return null;
        const { w, d } = footprint(item.kind, item.turn);
        const x = p.x + room.w / 2;
        const z = p.z + room.d / 2;
        const sup = supportUnder(room, { x0: x - w / 2, x1: x + w / 2, z0: z - d / 2, z1: z + d / 2 }, new Set([item.id]));
        const nh = sup ? (catalogItem(sup.kind)?.top ?? 0) : 0;
        if (nh === h) break;
        h = nh;
      }
    }
    return this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -h), p) ? { p } : null;
  }

  /** 手指点在地面上哪儿 */
  private floorPoint(e: PointerEvent): THREE.Vector3 | null {
    this.ray.setFromCamera(this.pointerNdc(e), this.camera);
    const p = new THREE.Vector3();
    return this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p) ? p : null;
  }

  private itemAnchor(item: DecorItem): THREE.Vector3 {
    const room = this.room!;
    const c = catalogItem(item.kind)!;
    if (c.place === 'wall') {
      const y = item.y ?? c.wallY ?? 1.4;
      return item.wall === 'left' ? new THREE.Vector3(-room.w / 2, y, item.z - room.d / 2) : new THREE.Vector3(item.x - room.w / 2, y, -room.d / 2);
    }
    return new THREE.Vector3(item.x - room.w / 2, 0, item.z - room.d / 2);
  }

  private onMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch' && this.fingers.has(e.pointerId)) {
      this.fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.fingers.size === 2 && this.twist !== null && !this.drag) {
        // 两指拧着转：屋子跟着手指转（相机绕着看的中心反着转）
        const angle = this.fingerAngle();
        const d = Math.atan2(Math.sin(angle - this.twist), Math.cos(angle - this.twist));
        this.twist = angle;
        const offset = this.camera.position.clone().sub(this.controls.target).applyAxisAngle(Y_AXIS, d);
        this.camera.position.copy(this.controls.target).add(offset);
      }
    }
    const drag = this.drag;
    if (!drag || e.pointerId !== this.down?.pointer || !this.room) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.start.x, e.clientY - drag.start.y) < 6) return;
    drag.moved = true;
    const room = this.room;
    const v = this.items.get(drag.id);
    if (!v) return;
    const item = v.item;
    const c = catalogItem(item.kind)!;
    const at = this.dragPoint(e, item);
    if (!at) return;
    let cand: DecorItem;
    if (c.place === 'wall') {
      const wall = at.wall ?? item.wall ?? 'back';
      const sameWall = wall === (item.wall ?? 'back');
      const p = sameWall ? at.p.clone().sub(drag.offset) : at.p;
      const along = wall === 'left' ? p.z + room.d / 2 : p.x + room.w / 2;
      const snapped = Math.round(along * 4) / 4;
      const y = Math.round(p.y * 10) / 10;
      cand = { ...item, wall, y, x: wall === 'back' ? snapped : 0, z: wall === 'left' ? snapped : 0 };
    } else {
      const p = at.p.clone().sub(drag.offset);
      const { w, d } = footprint(item.kind, item.turn);
      cand = { ...item, x: snapCenter(p.x + room.w / 2, w), z: snapCenter(p.z + room.d / 2, d) };
    }
    const kids = childrenOf(room, item.id);
    const check = checkPlace(room, cand, new Set([item.id, ...kids.map((k) => k.id)]));
    drag.to = { x: cand.x, z: cand.z, turn: cand.turn, ...(c.place === 'wall' ? { y: cand.y, wall: cand.wall } : {}) };
    drag.ok = check.ok;
    drag.reason = check.reason ?? '';
    // 画面上先挪过去（桌上的东西跟着）
    const preview = check.on ? { ...cand, on: check.on } : { ...cand, on: c.place === 'top' ? undefined : cand.on };
    this.place(v.obj, preview);
    v.obj.position.y += 0.06;
    const dx = cand.x - item.x;
    const dz = cand.z - item.z;
    for (const k of kids) {
      const kv = this.items.get(k.id);
      if (kv) this.place(kv.obj, { ...k, x: k.x + dx, z: k.z + dz });
      if (kv) kv.obj.position.y += 0.06;
    }
    this.updateMarker({ item: preview, ok: check.ok });
  };

  private onUp = (e: PointerEvent) => {
    this.liftFinger(e);
    const down = this.down;
    // 别的手指抬起来：正在拖的、正在按的不受影响
    if (down && e.pointerId !== down.pointer) return;
    const drag = this.drag;
    this.down = null;
    this.drag = null;
    this.controls.enabled = true;
    if (!down || !this.room) return;
    if (drag?.moved) {
      if (drag.ok && drag.to) this.events.move(drag.id, drag.to);
      else {
        if (drag.reason) this.events.invalid(drag.reason);
        // 弹回原处
        this.setRoom(this.room);
      }
      return;
    }
    const tap = Math.hypot(e.clientX - down.x, e.clientY - down.y) < 8 && performance.now() - down.t < 600;
    if (!tap) return;
    if (down.chibi) {
      const c = this.chibiOf(down.chibi);
      if (c?.pose === 'stand' && !c.walking) c.hop();
      else c?.setExpression('laugh', 1800);
      this.events.tapChibi(down.chibi);
      return;
    }
    if (this.mode === 'edit') {
      if (down.id !== this.selected) this.events.select(down.id);
      return;
    }
    // 逛逛：你的小人走过去
    const you = this.you;
    if (!you) return;
    if (down.id) {
      const cat = catalogItem(this.items.get(down.id)?.item.kind ?? '');
      if (cat && (cat.seats?.length || cat.beds?.length)) {
        if (this.goSit(you, down.id)) this.events.act?.(`${cat.beds?.length ? '躺到' : '坐到'}${cat.name}上`);
        else this.events.invalid(`${cat.name}上没地方了`);
        return;
      }
    }
    const floor = this.floorPoint(e);
    if (floor) {
      const room = this.room;
      const x = Math.min(room.w / 2 - 0.2, Math.max(-room.w / 2 + 0.2, floor.x));
      const z = Math.min(room.d / 2 - 0.2, Math.max(-room.d / 2 + 0.2, floor.z));
      this.walkTo(you, x, z);
    }
  };

  private onCancel = (e: PointerEvent) => {
    this.liftFinger(e);
    if (this.drag?.moved && this.room) this.setRoom(this.room);
    this.drag = null;
    this.down = null;
    this.controls.enabled = true;
  };

  // —— 每一帧 ——

  private collectAnimated() {
    this.animated = [];
    for (const v of this.items.values()) {
      v.obj.traverse((o) => {
        if (o.userData.swim || o.userData.minute) this.animated.push(o);
      });
    }
  }

  private tick(dt: number) {
    this.time += dt;
    this.controls.update();
    this.you?.update(dt);
    this.her?.update(dt);
    if (this.her && this.time > this.herNextAt) {
      this.herNextAt = this.time + 9 + Math.random() * 10;
      this.herWander();
    }
    for (const [obj, at] of this.pops) {
      const k = (this.time - at) / 0.38;
      if (k < 0) continue;
      if (k >= 1) {
        obj.scale.setScalar(1);
        this.pops.delete(obj);
      } else {
        const s = 1 + Math.sin(k * Math.PI) * 0.18 * (1 - k);
        obj.scale.setScalar(Math.max(0.001, k < 0.6 ? (k / 0.6) * s : s));
      }
    }
    for (const o of this.animated) {
      if (o.userData.swim) {
        o.position.x = Math.sin(this.time * 1.3) * 0.05;
        o.position.z = Math.cos(this.time * 1.3) * 0.04;
        o.rotation.y = this.time * 1.3 + Math.PI / 2;
      } else if (o.userData.minute) o.rotation.z = -this.time * 0.05;
    }
    if (this.marker.visible && !this.drag) {
      (this.markerFill.material as THREE.MeshBasicMaterial).opacity = 0.16 + Math.sin(this.time * 4) * 0.08;
    }
    this.renderer.render(this.scene, this.camera);
  }

  // —— 拍照、缩略图 ——

  /** 这一刻的屋子（JPEG dataURL）：view 是现在画面上的样子；card 是 4:3 的正面全景（发进聊天的照片） */
  snapshot(kind: 'view' | 'card' = 'view'): string {
    const bg = this.scene.background;
    this.scene.background = new THREE.Color(this.night ? '#2a2c44' : '#f4efe8');
    const wasMarker = this.marker.visible;
    this.marker.visible = false;
    let url: string;
    try {
      if (kind === 'view' || !this.room) {
        this.renderer.render(this.scene, this.camera);
        url = this.canvas.toDataURL('image/jpeg', 0.86);
      } else {
        const cam = new THREE.PerspectiveCamera(30, 4 / 3, 0.5, 120);
        this.frame(cam, new THREE.Spherical(1, 0.9, Math.PI / 4), new THREE.Vector3(0, 0.6, 0), true, { top: 0.9, bottom: -0.9, side: 0.92 });
        url = this.renderOffscreen(cam, 1200, 900, 800, 600, 'image/jpeg');
      }
    } finally {
      this.scene.background = bg;
      this.marker.visible = wasMarker;
    }
    return url;
  }

  /** 画到一张离屏的图上（先画大一点再缩小，边缘更顺），返回 dataURL */
  private renderOffscreen(cam: THREE.Camera, w: number, h: number, outW: number, outH: number, mime: string, scene: THREE.Scene = this.scene): string {
    const rt = new THREE.WebGLRenderTarget(w, h);
    rt.texture.colorSpace = THREE.SRGBColorSpace;
    const prevTarget = this.renderer.getRenderTarget();
    const prevAlpha = this.renderer.getClearAlpha();
    this.renderer.setRenderTarget(rt);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear();
    this.renderer.render(scene, cam);
    const px = new Uint8Array(w * h * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, w, h, px);
    this.renderer.setRenderTarget(prevTarget);
    this.renderer.setClearColor(0x000000, prevAlpha);
    rt.dispose();
    const full = document.createElement('canvas');
    full.width = w;
    full.height = h;
    const g = full.getContext('2d')!;
    const img = g.createImageData(w, h);
    // 读出来是上下颠倒的
    for (let y = 0; y < h; y += 1) img.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    g.putImageData(img, 0, 0);
    if (outW === w && outH === h) return full.toDataURL(mime, 0.86);
    const small = document.createElement('canvas');
    small.width = outW;
    small.height = outH;
    const sg = small.getContext('2d')!;
    sg.imageSmoothingQuality = 'high';
    sg.drawImage(full, 0, 0, outW, outH);
    return small.toDataURL(mime, 0.86);
  }

  private thumbCache = new Map<string, string>();
  /** 家具目录里的小图 */
  thumbnail(kind: string, color: string): string {
    const key = `${kind}|${color}`;
    const hit = this.thumbCache.get(key);
    if (hit) return hit;
    const S = 256;
    const c = catalogItem(kind);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight('#ffffff', '#c9b8a8', 1.7));
    const dl = new THREE.DirectionalLight('#ffffff', 1.4);
    dl.position.set(2, 4, 3);
    scene.add(dl);
    const obj = buildFurniture(kind, color);
    scene.add(obj);
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const r = Math.max(size.x, size.y, size.z) * 0.62 + 0.02;
    const cam = new THREE.PerspectiveCamera(30, 1, 0.01, 50);
    const dir = c?.place === 'wall' ? new THREE.Vector3(0.25, 0.1, 1) : new THREE.Vector3(1, 0.85, 1.2);
    cam.position.copy(center).add(dir.normalize().multiplyScalar(r / Math.sin(THREE.MathUtils.degToRad(15))));
    cam.lookAt(center);
    const url = this.renderOffscreen(cam, S, S, S / 2, S / 2, 'image/png', scene);
    disposeObject(obj);
    this.thumbCache.set(key, url);
    return url;
  }
}
