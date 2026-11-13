import { MIN_TOY_INTERVAL, MIN_TOY_STROKE, SCALAR_KINDS, describeCommand, mergeCommands, type ScalarKind, type ToyCommand, type ToyKind, type ToyLinear, type ToyWave } from '@app/shared';
import type { LinearSub, RotateSub, ScalarSub, ToyDevice, ToyFeature } from './intiface';

/**
 * 心跳：把控制指令放到玩具上（设计文档 §9.14）。
 * - ToyPlayer：每一种（震动、摆动、旋转、收缩、充气、伸缩）各放一段：新指令只换掉它写了的那几种，没写的接着放；
 *   变速按 pattern / interval 走，loop 放完停在 0，不写 loop 一直循环；伸缩在两个位置之间来回。
 *   强度不超过设置里的上限，伸缩不快于"一下最快"、不出设置的范围；和上一次发的一样就不再发（省蓝牙）。
 *   没连玩具时（"不连玩具也试试"）只算强度，界面上的心跳照样跟着走。
 * - ReplyTimeline：她一句话里的几条指令，读到 / 念到那个位置时执行。打字时按"读多快"往前走（不超过已经写出来的字），
 *   连麦时跟着她念到第几句（每句里按语速往前走）；指令来晚了（单独生成要等她说完）一下子到的几条合成一条再执行。
 */

export interface ToyCaps {
  vibrate: number;
  oscillate: number;
  rotate: number;
  constrict: number;
  inflate: number;
  /** 伸缩：从 0 到 100 走一下最快多少毫秒（幅度小时按比例） */
  strokeMs: number;
  /** 伸缩的范围（0–100）：指令里的 0–100 按比例落在这中间 */
  posMin: number;
  posMax: number;
}

export const DEFAULT_CAPS: ToyCaps = { vibrate: 80, oscillate: 80, rotate: 80, constrict: 60, inflate: 60, strokeMs: 300, posMin: 0, posMax: 100 };

/** 玩具现在的样子（界面上的心跳、强度条看这个） */
export interface ToyLevels {
  /** 每个震动马达（所有玩具按顺序排）的强度 0–100 */
  vibrate: number[];
  oscillate: number;
  rotate: number;
  constrict: number;
  inflate: number;
  /** 伸缩：现在去的位置、多快（0–100，越大越快），停着时 pace 是 0 */
  position: number;
  pace: number;
  /** 每一种现在在放什么（一句话） */
  doing: Partial<Record<ToyKind, string>>;
}

export function emptyLevels(): ToyLevels {
  return { vibrate: [], oscillate: 0, rotate: 0, constrict: 0, inflate: 0, position: 0, pace: 0, doing: {} };
}

/** 现在最强的那一种（0–100）：心跳的快慢按它 */
export function intensityOf(l: ToyLevels): number {
  return Math.max(0, ...l.vibrate, l.oscillate, l.rotate, l.constrict, l.inflate, l.pace);
}

export interface ToyOutput {
  /** 连着的玩具；没连（只在界面上试）时为空 */
  devices(): ToyDevice[];
  scalar(device: number, subs: ScalarSub[]): void;
  linear(device: number, subs: LinearSub[]): void;
  rotate(device: number, subs: RotateSub[]): void;
  stopAll(): void;
}

const ACTUATOR: Record<ScalarKind, string> = { vibrate: 'Vibrate', oscillate: 'Oscillate', rotate: 'Rotate', constrict: 'Constrict', inflate: 'Inflate' };

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export class ToyPlayer {
  private timers: Partial<Record<ToyKind, ReturnType<typeof setTimeout>>> = {};
  /** 上一次发给每个能力的值（一样就不再发） */
  private sent = new Map<string, number>();
  private towardTo = true;
  readonly levels: ToyLevels;
  private readonly out: ToyOutput;
  private readonly caps: () => ToyCaps;

  constructor(levels: ToyLevels, out: ToyOutput, caps: () => ToyCaps) {
    this.levels = levels;
    this.out = out;
    this.caps = caps;
  }

  /** 有没有哪一种在动 */
  get active(): boolean {
    return intensityOf(this.levels) > 0 || Object.keys(this.timers).length > 0;
  }

  apply(cmd: ToyCommand): void {
    if (cmd.stop) {
      this.stop();
      return;
    }
    for (const k of SCALAR_KINDS) {
      const w = cmd[k];
      if (w) this.runWave(k, w);
    }
    if (cmd.linear) this.runLinear(cmd.linear);
  }

  /** 全部停下（发 StopAllDevices，所有强度归零） */
  stop(): void {
    for (const t of Object.values(this.timers)) clearTimeout(t);
    this.timers = {};
    this.sent.clear();
    this.out.stopAll();
    Object.assign(this.levels, emptyLevels());
  }

  private clear(kind: ToyKind) {
    clearTimeout(this.timers[kind]);
    delete this.timers[kind];
  }

  private featuresOf(kind: ToyKind): { device: ToyDevice; feature: ToyFeature }[] {
    return this.out.devices().flatMap((device) => device.features.filter((f) => f.kind === kind).map((feature) => ({ device, feature })));
  }

  /** 给这一种设一个强度（一个数是所有马达，数组是每个马达各自的），不超过上限 */
  private setLevel(kind: ScalarKind, step: number | number[], clockwise?: boolean) {
    const cap = clamp(this.caps()[kind], 0, 100);
    const pick = (i: number) => clamp(Math.round(Array.isArray(step) ? (step[i] ?? step.at(-1) ?? 0) : step), 0, 100);
    const feats = this.featuresOf(kind);
    if (kind === 'vibrate') {
      const n = feats.length || (Array.isArray(step) ? step.length : 1);
      this.levels.vibrate = Array.from({ length: n }, (_, i) => Math.min(pick(i), cap));
    } else this.levels[kind] = Math.min(pick(0), cap);
    const byDevice = new Map<number, { scalars: ScalarSub[]; rotations: RotateSub[] }>();
    feats.forEach(({ device, feature }, i) => {
      const v = Math.min(pick(i), cap) / 100;
      const scalar = Math.round(v * feature.steps) / feature.steps;
      const key = `${device.index}:${feature.via}:${feature.index}${feature.via === 'rotate' ? `:${clockwise !== false}` : ''}`;
      if (this.sent.get(key) === scalar) return;
      this.sent.set(key, scalar);
      const g = byDevice.get(device.index) ?? { scalars: [], rotations: [] };
      if (feature.via === 'rotate') g.rotations.push({ Index: feature.index, Speed: scalar, Clockwise: clockwise !== false });
      else g.scalars.push({ Index: feature.index, Scalar: scalar, ActuatorType: feature.actuator || ACTUATOR[kind] });
      byDevice.set(device.index, g);
    });
    for (const [device, g] of byDevice) {
      if (g.scalars.length) this.out.scalar(device, g.scalars);
      if (g.rotations.length) this.out.rotate(device, g.rotations);
    }
  }

  private runWave(kind: ScalarKind, w: ToyWave) {
    this.clear(kind);
    this.levels.doing[kind] = describeCommand({ [kind]: w });
    if (w.steps.length === 1 && !w.loop) {
      this.setLevel(kind, w.steps[0] as number | number[], w.clockwise);
      const now = kind === 'vibrate' ? Math.max(0, ...this.levels.vibrate) : this.levels[kind];
      if (!now) delete this.levels.doing[kind];
      return;
    }
    let i = 0;
    let loops = 0;
    const step = () => {
      if (i >= w.steps.length) {
        i = 0;
        loops += 1;
        if (w.loop && loops >= w.loop) {
          this.setLevel(kind, 0);
          delete this.timers[kind];
          delete this.levels.doing[kind];
          return;
        }
      }
      this.setLevel(kind, w.steps[i] as number | number[], w.clockwise);
      const ms = Math.max(MIN_TOY_INTERVAL, w.intervals[i % w.intervals.length] ?? 1000);
      i += 1;
      this.timers[kind] = setTimeout(step, ms);
    };
    step();
  }

  private runLinear(l: ToyLinear) {
    this.clear('linear');
    this.levels.doing.linear = describeCommand({ linear: l });
    const caps = this.caps();
    const lo = clamp(Math.min(caps.posMin, caps.posMax), 0, 100);
    const hi = clamp(Math.max(caps.posMin, caps.posMax), 0, 100);
    const mapPos = (p: number) => lo + ((hi - lo) * clamp(p, 0, 100)) / 100;
    let seg = 0;
    let loop = 0;
    let k = 0;
    let guard = 0;
    const move = () => {
      const s = l.segments[seg];
      if (!s) {
        if (l.repeat && guard < 1000) {
          seg = 0;
          loop = 0;
          k = 0;
          guard += 1;
          move();
          return;
        }
        delete this.timers.linear;
        delete this.levels.doing.linear;
        this.levels.pace = 0;
        return;
      }
      if (k >= s.durations.length) {
        k = 0;
        loop += 1;
      }
      if (loop >= s.loop) {
        seg += 1;
        loop = 0;
        k = 0;
        move();
        return;
      }
      guard = 0;
      const target = this.towardTo ? s.to : s.from;
      const span = Math.abs(mapPos(s.to) - mapPos(s.from));
      const ms = Math.round(Math.max(s.durations[k] ?? 1000, MIN_TOY_STROKE, (caps.strokeMs * span) / 100));
      this.sendLinear(mapPos(target), ms);
      this.levels.position = clamp(Math.round(target), 0, 100);
      // 多快：一下 200 毫秒算最快，2 秒以上算很慢
      this.levels.pace = span < 3 ? 0 : clamp(Math.round(100 - ((ms - 200) / 1800) * 90), 10, 100);
      this.towardTo = !this.towardTo;
      k += 1;
      this.timers.linear = setTimeout(move, ms);
    };
    move();
  }

  private sendLinear(pos: number, ms: number) {
    for (const { device, feature } of this.featuresOf('linear')) {
      if (feature.via === 'linear') this.out.linear(device.index, [{ Index: feature.index, Duration: ms, Position: Math.round(pos) / 100 }]);
      else this.out.scalar(device.index, [{ Index: feature.index, Scalar: Math.round(pos) / 100, ActuatorType: feature.actuator || 'Position' }]);
    }
  }
}

/** 一条要执行的指令和它在她原话里的位置（字符下标） */
export interface TimedCommand {
  pos: number;
  command: ToyCommand;
}

/**
 * 她一句话里的指令什么时候执行：
 * - read（打字）：从第一个字出来开始按 msPerChar 往前读，不超过已经写出来的字；写完以后读到哪执行到哪；
 * - speech（连麦）：sentence() 告诉它开始念哪一句，句子里按语速往前走，到句末停住等下一句；drained() 说念完了，剩下的都执行。
 */
export class ReplyTimeline {
  private steps: (TimedCommand & { done: boolean })[] = [];
  /** 不用了：之后来的指令（单独生成来晚了）也不执行 */
  private dead = false;
  private startedAt = 0;
  private known = 0;
  private finished = false;
  private anchor = { pos: 0, at: 0, end: 0 };
  private searchFrom = 0;
  private text = '';
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly mode: 'read' | 'speech';
  private readonly msPerChar: number;
  private readonly fire: (cmd: ToyCommand) => void;

  constructor(mode: 'read' | 'speech', msPerChar: number, fire: (cmd: ToyCommand) => void) {
    this.mode = mode;
    this.msPerChar = Math.max(20, msPerChar);
    this.fire = fire;
    this.timer = setInterval(() => this.tick(), 120);
  }

  /** 正文写到哪了（打字时用；第一次有字时开始读） */
  setText(text: string, done = false) {
    this.text = text;
    this.known = text.length;
    // 连麦时从她开口念第一句算起
    if (this.mode === 'read' && !this.startedAt && text.length) this.startedAt = Date.now();
    if (done) this.finished = true;
    this.tick();
  }

  add(list: TimedCommand[]) {
    if (this.dead) return;
    for (const c of list) this.steps.push({ ...c, done: false });
    this.steps.sort((a, b) => a.pos - b.pos);
    this.tick();
  }

  /** 连麦：开始念这一句（找到它在原话里的位置） */
  sentence(text: string) {
    const probe = text.trim().slice(0, 8);
    let pos = probe ? this.text.indexOf(probe, this.searchFrom) : -1;
    if (pos < 0) pos = this.anchor.end;
    this.searchFrom = pos + Math.max(1, probe.length);
    this.anchor = { pos, at: Date.now(), end: pos + text.trim().length };
    if (!this.startedAt) this.startedAt = Date.now();
    this.tick();
  }

  /** 连麦：她这句话念完了 */
  drained() {
    this.finished = true;
    this.anchor = { pos: Number.MAX_SAFE_INTEGER, at: Date.now(), end: Number.MAX_SAFE_INTEGER };
    this.tick();
  }

  cursor(): number {
    if (!this.startedAt) return -1;
    if (this.mode === 'speech') {
      if (this.anchor.pos === Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
      return Math.min(this.anchor.end, this.anchor.pos + (Date.now() - this.anchor.at) / this.msPerChar);
    }
    const read = (Date.now() - this.startedAt) / this.msPerChar;
    return this.finished ? read : Math.min(read, this.known);
  }

  private tick() {
    if (this.dead) return;
    const at = this.cursor();
    if (at < 0) return;
    const due = this.steps.filter((s) => !s.done && s.pos <= at);
    if (due.length) {
      for (const s of due) s.done = true;
      const merged = mergeCommands(due.map((s) => s.command));
      if (merged) this.fire(merged);
    }
    // 都执行完、也读完了：先不用每隔一会儿看一次（单独生成的指令来晚了时 add 会直接执行）
    if (this.finished && this.steps.every((s) => s.done) && at >= this.known) {
      clearInterval(this.timer);
      this.timer = undefined;
    } else if (!this.timer) this.timer = setInterval(() => this.tick(), 120);
  }

  /** 不用了（她开始说下一句、你打断、离开）：没执行的不再执行 */
  dispose() {
    this.dead = true;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
