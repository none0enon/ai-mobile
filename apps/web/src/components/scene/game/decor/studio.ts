import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Avatar } from './avatar';
import { Chibi } from './chibi';
import { toon } from './textures';

/**
 * 捏人时的展示台：一个小圆台上站着正在捏的小人，拖着能左右转着看。
 * 只在捏人面板打开时存在（自己的画布），关掉就释放。
 */
export class ChibiStudio {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(28, 1, 0.1, 30);
  private controls: OrbitControls;
  private chibi: Chibi;
  private stage: THREE.Mesh;
  private raf = 0;
  private last = 0;
  private resizeObs: ResizeObserver;

  constructor(
    private canvas: HTMLCanvasElement,
    avatar: Avatar,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setClearColor(0x000000, 0);
    const hemi = new THREE.HemisphereLight('#fffaf3', '#c9b8c8', 1.6);
    const key = new THREE.DirectionalLight('#fff3e0', 1.6);
    key.position.set(1.5, 3, 2.5);
    key.castShadow = true;
    key.shadow.mapSize.set(512, 512);
    key.shadow.camera.left = -1;
    key.shadow.camera.right = 1;
    key.shadow.camera.top = 1;
    key.shadow.camera.bottom = -1;
    this.scene.add(hemi, key);
    this.stage = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.66, 0.08, 40), toon('#f3e9d2'));
    this.stage.position.y = -0.04;
    this.stage.receiveShadow = true;
    this.scene.add(this.stage);
    this.chibi = new Chibi(avatar, 'you');
    this.scene.add(this.chibi.root);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enablePan = false;
    this.controls.enableZoom = false;
    this.controls.enableDamping = true;
    this.controls.minPolarAngle = 1.05;
    this.controls.maxPolarAngle = 1.45;
    this.controls.target.set(0, 0.72, 0);
    this.camera.position.set(0, 1.0, 3.4);
    this.controls.update();
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(canvas.parentElement ?? canvas);
    this.resize();
    this.last = performance.now();
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      this.chibi.update(dt);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    this.raf = requestAnimationFrame(loop);
  }

  setAvatar(a: Avatar) {
    this.chibi.setAvatar(a);
  }

  wave() {
    this.chibi.wave(1.8);
    this.chibi.setExpression('laugh', 1800);
  }

  private resize() {
    const el = this.canvas.parentElement ?? this.canvas;
    const w = Math.max(1, el.clientWidth);
    const h = Math.max(1, el.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // 竖着窄的时候退远一点，整个人都在画面里
    this.camera.position.setLength(Math.max(3.4, 2.6 / Math.min(1, this.camera.aspect)));
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    this.controls.dispose();
    this.chibi.dispose();
    this.stage.geometry.dispose();
    this.renderer.dispose();
  }
}
