import { expressionMood, type CharacterLive2D, type DayOutfit, type Live2DOutfit, type Live2DParameter } from '@app/shared';
import coreUrl from '../vendor/cubism/live2dcubismcore.min.js?url';
import { dialogueCue, gestureFor, mouthLevel } from './cues';
import { GestureMotion, type Gesture } from './gesture';
import type { ModelPackage } from './model';
import { alphaBounds, fitSilhouette, validBounds, type Bounds } from './framing';
import { isMadaraRig, selectOutfit, suggestedOutfits } from './outfits';

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
  private parameters: Live2DParameter[] = [];
  private suggestions: Live2DOutfit[] = [];
  private outfit?: Live2DOutfit;
  private outfitValues: Record<string, number> = {};
  private outfitKey = '';
  private bounds: Bounds = { left: -1, right: 1, bottom: -1, top: 1 };
  private boundsCache = new Map<string, Bounds>();

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
    // DisplayInfo is optional, including for models already stored before this feature.
    const display = refs.DisplayInfo && pack.files[refs.DisplayInfo] ? JSON.parse(await pack.files[refs.DisplayInfo]!.text()) : undefined;
    const names = new Map<string, string>((Array.isArray(display?.Parameters) ? display.Parameters : []).filter((p: any) => typeof p.Id === 'string' && typeof p.Name === 'string').map((p: any) => [p.Id, p.Name]));
    for (let i = 0; i < this.model.getParameterCount(); i++) {
      const id = this.model.getParameterId(i);
      this.ids.set(id.getString(), id);
      this.parameters.push({ id: id.getString(), name: names.get(id.getString()) ?? id.getString(), min: this.model.getParameterMinimumValue(i), max: this.model.getParameterMaximumValue(i), default: this.model.getParameterDefaultValue(i) });
    }
    const group = (name: string, fallback: string[]) => {
      const ids = pack.manifest.Groups?.find(g => g.Name === name && g.Target === 'Parameter')?.Ids;
      return (ids?.length ? ids : fallback).filter(id => this.ids.has(id));
    };
    this.eyeIds = group('EyeBlink', ['ParamEyeLOpen', 'ParamEyeROpen']);
    this.lipIds = group('LipSync', ['ParamMouthOpenY']);
    this.madara = isMadaraRig(this.parameters);
    this.suggestions = suggestedOutfits(this.parameters);
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
    this.setOutfit();
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

  /** New clothing takes effect immediately; expressions and gestures remain independent. */
  setOutfit(desired?: DayOutfit, previewId?: string) {
    const outfits = this.config.outfits?.length ? this.config.outfits : this.suggestions;
    this.outfit = outfits.find(o => o.id === previewId) ?? selectOutfit(this.config, desired, this.suggestions);
    const controlled = new Set(outfits.flatMap(o => Object.keys(o.parameters)));
    this.outfitValues = Object.fromEntries(this.parameters.filter(p => controlled.has(p.id)).map(p => {
      const value = this.outfit?.parameters[p.id] ?? p.default;
      return [p.id, Number.isFinite(value) ? Math.max(p.min, Math.min(p.max, value)) : p.default];
    }));
    const key = JSON.stringify(this.outfitValues);
    if (key === this.outfitKey) return;
    this.outfitKey = key;
    let bounds = this.boundsCache.get(key);
    if (!bounds) {
      bounds = this.measureSilhouette();
      // A user editing a slider must not grow an unbounded cache.
      if (this.boundsCache.size >= 24) this.boundsCache.clear();
      this.boundsCache.set(key, bounds);
    }
    this.bounds = bounds;
  }

  settings(): Pick<CharacterLive2D, 'parameters' | 'outfits' | 'defaultOutfit'> {
    const outfits = this.config.outfits?.length ? this.config.outfits : this.suggestions;
    return { parameters: this.parameters, outfits, defaultOutfit: outfits.some(o => o.id === this.config.defaultOutfit) ? this.config.defaultOutfit : outfits[0]?.id };
  }

  private applyOutfit() {
    for (const [id, value] of Object.entries(this.outfitValues)) this.set(id, value);
  }

  /** Calibrate once per outfit in a neutral pose, never track each animated frame. */
  private measureSilhouette(): Bounds {
    const saved = this.parameters.map(p => this.model.getParameterValueById(this.ids.get(p.id)) as number);
    const { canvas, gl } = this;
    const width = canvas.width, height = canvas.height;
    try {
      for (const p of this.parameters) this.set(p.id, p.default);
      this.applyOutfit();
      if (this.madara) {
        this.set('ParamGestureLive', 1);
        this.set('ParamGestureRaise', 0);
        this.set('ParamGestureFold', 0);
        this.set('ParamGestureStyle', 0);
        this.set('ParamOutfitPose', (this.outfitValues.ParamOutfitPose ?? 0) >= 3 ? 3 : 0);
      }
      this.model.update();
      const geometry = { left: Infinity, right: -Infinity, bottom: Infinity, top: -Infinity };
      for (let i = 0; i < this.model.getDrawableCount(); i++) {
        if (this.model.getDrawableOpacity(i) < 0.01) continue;
        const vertices = this.model.getDrawableVertexPositions(i) as Float32Array;
        for (let j = 0; j < vertices.length; j += 2) {
          const x = vertices[j]!, y = vertices[j + 1]!;
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          geometry.left = Math.min(geometry.left, x); geometry.right = Math.max(geometry.right, x);
          geometry.bottom = Math.min(geometry.bottom, y); geometry.top = Math.max(geometry.top, y);
        }
      }
      if (!validBounds(geometry)) throw new Error('模型没有可见的人物轮廓');
      // Alpha readback removes transparent texture/mesh margins, including off-centre exports.
      const size = 256;
      canvas.width = canvas.height = size;
      const scale = Math.min(1.9 / (geometry.right - geometry.left), 1.9 / (geometry.top - geometry.bottom));
      const tx = -(geometry.left + geometry.right) * scale / 2;
      const ty = -(geometry.bottom + geometry.top) * scale / 2;
      const matrix = new this.api.CubismMatrix44();
      matrix.scale(scale, scale); matrix.translate(tx, ty);
      this.draw(matrix);
      const pixels = new Uint8Array(size * size * 4);
      gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const visible = alphaBounds(pixels, size, size);
      if (!visible) return geometry;
      return {
        left: (visible.left / size * 2 - 1 - tx) / scale,
        right: (visible.right / size * 2 - 1 - tx) / scale,
        bottom: (visible.bottom / size * 2 - 1 - ty) / scale,
        top: (visible.top / size * 2 - 1 - ty) / scale,
      };
    } finally {
      canvas.width = width; canvas.height = height;
      this.parameters.forEach((p, i) => this.set(p.id, saved[i]!));
      this.model.update();
    }
  }

  setCue(expression: string, text = '') {
    if (this.dead) return;
    this.expression = expression;
    // 她立绘上的表情（坏笑……）单独设过就用设的；没设时按名字猜成一种情绪再找
    const mood = expressionMood(expression);
    const name = this.config.expressionMap[expression] || this.config.expressionMap[mood] || this.config.expressionMap.neutral || '';
    if (name !== this.expressionName) {
      this.expressionName = name;
      const clip = this.expressionClips.get(name);
      if (clip) this.expressions.startMotion(clip, false);
      else this.expressions.stopAllMotions();
    }
    const cue = dialogueCue(text);
    const motion = this.config.motionMap[cue] || this.config.motionMap[expression] || this.config.motionMap[mood];
    const gesture = motion ? this.gestureTargets.get(motion) : undefined;
    if (motion && !gesture) this.playMotion(motion);
    else if (cue === 'agree') this.playNamed('nod');
    else if (cue === 'disagree') this.playNamed('shake');
    if (this.madara) {
      this.gesture.setTarget(gesture ?? gestureFor(mood, text));
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
      this.applyOutfit();
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
        this.set('ParamOutfitPose', ((this.outfitValues.ParamOutfitPose ?? 0) >= 3 ? 3 : 0) + ['rest', 'wave', 'crossed'].indexOf(g.target));
      }
      this.physics?.evaluate(this.model, dt);
      this.pose?.updateParameters(this.model, dt);
      // Apply lips LAST: motions, expressions and physics cannot open a silent mouth.
      const target = mouthLevel(this.level, this.audible);
      this.mouth = target ? this.mouth + (target - this.mouth) * (1 - Math.exp(-dt * 28)) : 0;
      for (const id of this.lipIds) this.set(id, this.mouth);
      this.model.update();
      const { canvas } = this;
      const matrix = new this.api.CubismMatrix44();
      const fit = fitSilhouette(this.bounds, canvas.width, canvas.height, this.config.framing?.zoom);
      matrix.scale(fit.x, fit.y); matrix.translate(fit.tx, fit.ty);
      this.draw(matrix);
      this.raf = requestAnimationFrame(this.frame);
    } catch (e) { this.setAudio(0, false); this.error(e instanceof Error ? e.message : 'Live2D 画面播放失败'); }
  };

  private draw(matrix: any) {
    const { gl, canvas } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.renderer.setMvpMatrix(matrix);
    this.renderer.setRenderState(null, [0, 0, canvas.width, canvas.height]);
    this.renderer.drawModel();
  }

  /** Inspection used by the model preview and regression tests. */
  snapshot() {
    return { expression: this.expressionName, gesture: this.gesture.target, outfit: this.outfit?.id, bounds: this.bounds,
      fit: fitSilhouette(this.bounds, this.canvas.width, this.canvas.height, this.config.framing?.zoom),
      viewport: { width: this.canvas.width, height: this.canvas.height },
      parameters: Object.fromEntries([...this.ids].map(([name, id]) => [name, this.model.getParameterValueById(id) as number])) };
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
