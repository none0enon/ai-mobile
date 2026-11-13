import type { CharacterLive2D } from '@app/shared';
import coreUrl from '../vendor/cubism/live2dcubismcore.min.js?url';
import { dialogueCue, gestureFor, mouthLevel } from './cues';
import { GestureMotion, type Gesture } from './gesture';
import type { ModelPackage } from './model';

type SDK = typeof import('../vendor/cubism/framework');
let ready: Promise<SDK> | undefined;
const active = new Set<Live2DRenderer>();

async function sdk(): Promise<SDK> {
  return ready ??= (async () => {
    const global = globalThis as typeof globalThis & { Live2DCubismCore?: { Version: { csmGetVersion(): number } } };
    if (!global.Live2DCubismCore) await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      const timeout = setTimeout(() => { script.remove(); reject(new Error('Live2D 引擎加载超时')); }, 15000);
      script.src = coreUrl;
      script.onload = () => { clearTimeout(timeout); resolve(); };
      script.onerror = () => { clearTimeout(timeout); script.remove(); reject(new Error('Live2D 引擎加载失败，请重试')); };
      document.head.append(script);
    });
    const deadline = performance.now() + 10000;
    for (;;) {
      try { global.Live2DCubismCore!.Version.csmGetVersion(); break; }
      catch { if (performance.now() > deadline) throw new Error('Live2D 引擎初始化超时'); }
      await new Promise(resolve => setTimeout(resolve, 16));
    }
    // Framework classes read Core globals during module evaluation.
    const api = await import('../vendor/cubism/framework');
    api.CubismFramework.startUp();
    if (!api.CubismFramework.isInitialized()) api.CubismFramework.initialize(256 * 1024 * 1024);
    return api;
  })().catch(error => { ready = undefined; throw error; });
}

/** Cubism SDK owns native model objects; all any values are contained in this adapter. */
export class Live2DRenderer {
  private model: any;
  private moc: any;
  private renderer: any;
  private physics: any;
  private pose: any;
  private motions: any;
  private expressions: any;
  private motionClips = new Map<string, any>();
  private gestureTargets = new Map<string, Gesture>();
  private expressionClips = new Map<string, any>();
  private ids = new Map<string, any>();
  private textures: WebGLTexture[] = [];
  private gl: WebGLRenderingContext;
  private observer: ResizeObserver;
  private raf = 0;
  private dead = false;
  private previous = 0;
  private elapsed = 0;
  private nextBlink = 2 + Math.random();
  private blinkStart = -10;
  private level = 0;
  private audible = false;
  private mouth = 0;
  private eyeIds: string[] = [];
  private lipIds: string[] = [];
  private expression = '';
  private expressionName = '';
  private gesture = new GestureMotion();
  private gestureUntil = 0;
  private madara = false;
  private matrix: any;

  private constructor(private canvas: HTMLCanvasElement, private api: SDK, private config: CharacterLive2D, private error: (message: string) => void) {
    const gl = canvas.getContext('webgl2', { alpha: true, antialias: true, premultipliedAlpha: true }) ?? canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: true });
    if (!gl) throw new Error('当前设备无法启用 WebGL，请使用支持 WebGL 的浏览器');
    this.gl = gl as WebGLRenderingContext;
    active.add(this);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
    canvas.addEventListener('webglcontextlost', this.contextLost);
    document.addEventListener('visibilitychange', this.visibility);
  }

  static async create(canvas: HTMLCanvasElement, model: ModelPackage, config: CharacterLive2D, error: (message: string) => void = () => {}): Promise<Live2DRenderer> {
    const avatar = new Live2DRenderer(canvas, await sdk(), config, error);
    try { await avatar.load(model); return avatar; }
    catch (e) { avatar.dispose(); throw e; }
  }

  private async load(pack: ModelPackage) {
    const { api, gl } = this;
    const refs = pack.manifest.FileReferences;
    const bytes = async (ref: string) => {
      const file = pack.files[ref];
      if (!file) throw new Error(`模型资源缺失：${ref}`);
      return file.arrayBuffer();
    };
    const buffer = await bytes(refs.Moc);
    this.moc = api.CubismMoc.create(buffer, true);
    if (!this.moc) throw new Error('MOC3 未通过 Cubism 完整性检查');
    this.model = this.moc.createModel();
    if (!this.model) throw new Error('无法创建 Live2D 模型');
    for (let i = 0; i < this.model.getParameterCount(); i++) {
      const id = this.model.getParameterId(i);
      this.ids.set(id.getString(), id);
    }
    const group = (name: string, fallback: string[]) => {
      const ids = pack.manifest.Groups?.find(g => g.Name === name && g.Target === 'Parameter')?.Ids;
      return (ids?.length ? ids : fallback).filter(id => this.ids.has(id));
    };
    this.eyeIds = group('EyeBlink', ['ParamEyeLOpen', 'ParamEyeROpen']);
    this.lipIds = group('LipSync', ['ParamMouthOpenY']);
    this.madara = ['ParamGestureLive', 'ParamGestureRaise', 'ParamGestureFold', 'ParamOutfitPose'].every(id => this.ids.has(id));
    this.matrix = new api.CubismModelMatrix(this.model.getCanvasWidth(), this.model.getCanvasHeight());
    if (pack.manifest.Layout) this.matrix.setupFromLayout(new Map(Object.entries(pack.manifest.Layout)));
    this.renderer = new api.CubismRenderer_WebGL();
    this.renderer.initialize(this.model);
    this.renderer.startUp(gl);
    this.renderer.setIsPremultipliedAlpha(true);
    this.motions = new api.CubismMotionManager();
    this.expressions = new api.CubismExpressionMotionManager();
    // Each upload's files load independently; no shared request queue.
    const loads = await Promise.allSettled([
      ...refs.Textures.map(async (ref, index) => {
        const url = URL.createObjectURL(pack.files[ref]!);
        const image = new Image();
        try {
          await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error(`纹理无法解码：${ref}`)); image.src = url; });
          if (image.width > gl.getParameter(gl.MAX_TEXTURE_SIZE) || image.height > gl.getParameter(gl.MAX_TEXTURE_SIZE)) throw new Error(`纹理超出设备支持的尺寸：${ref}`);
          const texture = gl.createTexture();
          if (!texture) throw new Error('显存不足，无法加载纹理');
          this.textures.push(texture);
          gl.bindTexture(gl.TEXTURE_2D, texture);
          gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          this.renderer.bindTexture(index, texture);
        } finally { URL.revokeObjectURL(url); }
      }),
      ...Object.entries(refs.Motions ?? {}).flatMap(([group, list]) => list.map(async (ref, index) => {
        const b = await bytes(ref.File);
        const clip = api.CubismMotion.create(b, b.byteLength);
        if (!clip) throw new Error(`动作无法读取：${ref.File}`);
        clip.setEffectIds(this.eyeIds.map(id => this.ids.get(id)), this.lipIds.map(id => this.ids.get(id)));
        if (ref.FadeInTime != null) clip.setFadeInTime(ref.FadeInTime);
        if (ref.FadeOutTime != null) clip.setFadeOutTime(ref.FadeOutTime);
        this.motionClips.set(`${group}:${index}`, clip);
        const gesture = /(?:rest|wave|crossed)-to-(rest|wave|crossed)\.motion3\.json$/i.exec(ref.File)?.[1]?.toLowerCase();
        if (this.madara && gesture) this.gestureTargets.set(`${group}:${index}`, gesture as Gesture);
      })),
      ...(refs.Expressions ?? []).map(async ref => {
        const b = await bytes(ref.File);
        const clip = api.CubismExpressionMotion.create(b, b.byteLength);
        if (!clip) throw new Error(`表情无法读取：${ref.File}`);
        this.expressionClips.set(ref.Name, clip);
      }),
      ...(refs.Physics ? [(async () => { const b = await bytes(refs.Physics!); this.physics = api.CubismPhysics.create(b, b.byteLength); })()] : []),
      ...(refs.Pose ? [(async () => { const b = await bytes(refs.Pose!); this.pose = api.CubismPose.create(b, b.byteLength); })()] : []),
    ]);
    const failure = loads.find(r => r.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    this.model.saveParameters();
    this.setCue('neutral');
    this.resize();
    this.raf = requestAnimationFrame(this.frame);
  }

  setAudio(level: number, audible: boolean) {
    this.level = mouthLevel(level, audible);
    this.audible = audible;
    if (!this.level) {
      this.mouth = 0;
      for (const id of this.lipIds) this.set(id, 0);
    }
  }

  setCue(expression: string, text = '') {
    if (this.dead) return;
    this.expression = expression;
    const name = this.config.expressionMap[expression] ?? this.config.expressionMap.neutral ?? '';
    if (name !== this.expressionName) {
      this.expressionName = name;
      const clip = this.expressionClips.get(name);
      if (clip) this.expressions.startMotion(clip, false);
      else this.expressions.stopAllMotions();
    }
    const cue = dialogueCue(text);
    const motion = this.config.motionMap[cue] || this.config.motionMap[expression];
    const gesture = motion ? this.gestureTargets.get(motion) : undefined;
    if (motion && !gesture) this.playMotion(motion);
    else if (cue === 'agree') this.playNamed('nod');
    else if (cue === 'disagree') this.playNamed('shake');
    if (this.madara) {
      this.gesture.setTarget(gesture ?? gestureFor(expression, text));
      this.gestureUntil = !gesture && cue === 'greeting' ? this.elapsed + 3 : 0;
    }
  }

  private playNamed(name: string) {
    const key = [...this.motionClips.keys()].find(k => k.split(':')[0]!.toLowerCase() === name);
    if (key) this.playMotion(key);
  }

  private playMotion(name: string) {
    const clip = this.motionClips.get(name);
    if (!clip) return;
    this.motions.stopAllMotions();
    this.motions.startMotionPriority(clip, false, 2);
  }

  private set(name: string, value: number) {
    const id = this.ids.get(name);
    if (id) this.model.setParameterValueById(id, value);
  }

  private resize() {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round((rect.width || 420) * ratio));
    this.canvas.height = Math.max(1, Math.round((rect.height || 560) * ratio));
  }

  private contextLost = (event: Event) => {
    event.preventDefault();
    cancelAnimationFrame(this.raf);
    this.setAudio(0, false);
    this.error('画面连接已中断，请点重试重新加载模型');
  };

  private visibility = () => {
    cancelAnimationFrame(this.raf);
    this.previous = 0;
    if (!document.hidden && !this.dead) this.raf = requestAnimationFrame(this.frame);
  };

  private frame = (now: number) => {
    if (this.dead) return;
    try {
      const dt = this.previous ? Math.min((now - this.previous) / 1000, 0.05) : 1 / 60;
      this.previous = now;
      this.elapsed += dt;
      this.model.loadParameters();
      if (this.motions.isFinished()) this.playNamed('idle');
      this.motions.updateMotion(this.model, dt);
      this.model.saveParameters();
      this.expressions.updateMotion(this.model, dt);
      if (this.elapsed >= this.nextBlink) {
        this.blinkStart = this.elapsed;
        this.nextBlink = this.elapsed + 2.8 + Math.random() * 2.8;
      }
      const age = this.elapsed - this.blinkStart;
      const blink = age >= 0 && age < 0.22 ? 1 - Math.sin(age / 0.22 * Math.PI) ** 1.4 : 1;
      for (const id of this.eyeIds) this.model.multiplyParameterValueById(this.ids.get(id), blink);
      this.set('ParamBreath', 0.5 + Math.sin(this.elapsed * 1.4) * 0.5);
      if (this.madara) {
        if (this.gestureUntil && this.elapsed > this.gestureUntil) { this.gestureUntil = 0; this.gesture.setTarget(gestureFor(this.expression)); }
        const g = this.gesture.update(dt);
        this.set('ParamGestureLive', 1);
        this.set('ParamGestureRaise', g.raise);
        this.set('ParamGestureFold', g.fold);
        this.set('ParamSleeveLag', g.sleeveLag);
        this.set('ParamGestureStyle', ['rest', 'wave', 'crossed'].indexOf(g.target));
        this.set('ParamOutfitPose', ['rest', 'wave', 'crossed'].indexOf(g.target));
      }
      this.physics?.evaluate(this.model, dt);
      this.pose?.updateParameters(this.model, dt);
      // Apply lips LAST: motions, expressions and physics cannot open a silent mouth.
      const target = mouthLevel(this.level, this.audible);
      this.mouth = target ? this.mouth + (target - this.mouth) * (1 - Math.exp(-dt * 28)) : 0;
      for (const id of this.lipIds) this.set(id, this.mouth);
      this.model.update();
      const { gl, canvas } = this;
      const aspect = canvas.width / canvas.height;
      const matrix = new this.api.CubismMatrix44();
      // Fit full width on phones, including Madara's shoulder plates and raised hand.
      if (this.madara) {
        const fit = Math.min(2 * aspect / (this.model.getCanvasWidth() * 0.95), 2 / this.model.getCanvasHeight()) * 0.985;
        matrix.scale(fit / aspect, fit);
      } else {
        const fit = Math.min(1, aspect / (this.model.getCanvasWidth() / this.model.getCanvasHeight())) * 0.95;
        matrix.scale(fit / aspect, fit);
        matrix.multiplyByMatrix(this.matrix);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.renderer.setMvpMatrix(matrix);
      this.renderer.setRenderState(null, [0, 0, canvas.width, canvas.height]);
      this.renderer.drawModel();
      this.raf = requestAnimationFrame(this.frame);
    } catch (e) { this.setAudio(0, false); this.error(e instanceof Error ? e.message : 'Live2D 画面播放失败'); }
  };

  /** Inspection used by the model preview and regression tests. */
  snapshot() {
    return { expression: this.expressionName, gesture: this.gesture.target, parameters: Object.fromEntries([...this.ids].map(([name, id]) => [name, this.model.getParameterValueById(id) as number])) };
  }

  dispose() {
    if (this.dead) return;
    this.dead = true;
    cancelAnimationFrame(this.raf);
    this.observer.disconnect();
    this.canvas.removeEventListener('webglcontextlost', this.contextLost);
    document.removeEventListener('visibilitychange', this.visibility);
    this.motions?.release();
    this.expressions?.release();
    for (const clip of this.motionClips.values()) clip.release();
    for (const clip of this.expressionClips.values()) clip.release();
    this.physics?.release();
    this.renderer?.release();
    for (const texture of this.textures) this.gl.deleteTexture(texture);
    if (this.model && this.moc) this.moc.deleteModel(this.model);
    this.moc?.release();
    active.delete(this);
    if (!active.size) this.api.CubismShaderManager_WebGL.deleteInstance();
  }
}
