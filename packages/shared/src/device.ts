/**
 * 心跳：玩具的控制指令（设计文档 §9.14）。
 *
 * 写法沿用 SillyTavern 的 Intiface 插件（Enclave0775/Intiface_Central-Sillytavern-plugin）里的键，
 * 用过那个插件的世界书、预设可以直接照着写：
 *
 *   "VIBRATE": 40                                                震动 40%（多个马达时一起）
 *   "VIBRATE": [80, 30]                                          每个马达各自的强度
 *   "VIBRATE": {"pattern": [20, 60], "interval": [800, 400], "loop": 3}
 *                                                                变速：每一档的强度、每一档多久（毫秒）、整组放几遍（不写一直循环）；
 *                                                                pattern 里的一档也可以是数组（每个马达各自的强度）
 *   "OSCILLATE" / "ROTATE" / "CONSTRICT" / "INFLATE"             摆动 / 旋转 / 收缩 / 充气，写法同震动（旋转可以加 "clockwise": false）
 *   "LINEAR": {"start_position": 10, "end_position": 90, "duration": 1000}
 *                                                                伸缩：在两个位置（0–100，100 在顶端）之间来回，每一下多久
 *   "LINEAR_SPEED": {"start_position": 10, "end_position": 90, "start_duration": 2000, "end_duration": 500, "steps": 10}
 *                                                                伸缩越来越快（或越来越慢），走完 steps 下再从头
 *   "LINEAR_PATTERN": {"repeat": true, "segments": [{"start": 10, "end": 90, "durations": [1000, 500], "loop": 3}]}
 *                                                                分段的伸缩：每段把 durations 走 loop 遍（往上、往下各算一下）
 *   "STOP": true                                                 全部停下
 *
 * 指令从两个地方来：
 * - 她在回复里写 <device>…</device>（"她自己写"）：parseControlTags 把它从正文里拿掉、记下位置，parseDeviceBlock 读里面的内容；
 * - "控制指令"预设单独写一份（"单独生成"）：{"steps": [{"at": "她原话里的几个字", "do": {"VIBRATE": 30}}]}，parseDeviceSteps 读，placeSteps 放到原话的位置上。
 * 读到 / 念到那个位置时执行，强度上限、安全时间由播放的那一边（apps/web 的 toyPlayer）管。
 */

export const SCALAR_KINDS = ['vibrate', 'oscillate', 'rotate', 'constrict', 'inflate'] as const;
/** 按强度控制的（Buttplug 的 ScalarCmd / RotateCmd） */
export type ScalarKind = (typeof SCALAR_KINDS)[number];
/** linear：伸缩（Buttplug 的 LinearCmd） */
export type ToyKind = ScalarKind | 'linear';

export const TOY_KIND_LABEL: Record<ToyKind, string> = {
  vibrate: '震动',
  oscillate: '摆动',
  rotate: '旋转',
  constrict: '收缩',
  inflate: '充气',
  linear: '伸缩',
};

/** 每一种在指令里写哪些键 */
export const TOY_KIND_KEYS: Record<ToyKind, string[]> = {
  vibrate: ['VIBRATE'],
  oscillate: ['OSCILLATE'],
  rotate: ['ROTATE'],
  constrict: ['CONSTRICT'],
  inflate: ['INFLATE'],
  linear: ['LINEAR', 'LINEAR_SPEED', 'LINEAR_PATTERN'],
};

/** 功能预设里"她自己写指令"那一块的触发条件（连着玩具、指令选了"她自己写"时才发送） */
export const DEVICE_INLINE_FLAG = 'device-inline';

/** 变速的一档最短多久（毫秒）：再快玩具跟不上，蓝牙也会排队 */
export const MIN_TOY_INTERVAL = 120;
/** 伸缩的一下最短多久（毫秒）；真正的下限按设置里的"一下最快"和幅度算 */
export const MIN_TOY_STROKE = 80;

export interface ToyWave {
  /** 每一档的强度 0–100；一档是数组时是每个马达各自的强度 */
  steps: (number | number[])[];
  /** 每一档持续多久（毫秒），比 steps 短时循环着用 */
  intervals: number[];
  /** 整组放几遍；不写 = 一直循环，直到下一条指令（或安全时间到） */
  loop?: number;
  /** 只有旋转：方向（不写 = 顺时针） */
  clockwise?: boolean;
}

export interface ToyStroke {
  /** 两个位置 0–100（100 在顶端） */
  from: number;
  to: number;
  /** 每一下（往上或往下）多久，循环着用 */
  durations: number[];
  /** 整组 durations 走几遍 */
  loop: number;
}

export interface ToyLinear {
  segments: ToyStroke[];
  /** 走完了从头再来 */
  repeat: boolean;
}

export interface ToyCommand {
  vibrate?: ToyWave;
  oscillate?: ToyWave;
  rotate?: ToyWave;
  constrict?: ToyWave;
  inflate?: ToyWave;
  linear?: ToyLinear;
  /** 全部停下（同一条里别的都不算） */
  stop?: boolean;
}

/** "控制指令"预设写的一步：读到她原话里的 at 时执行 */
export interface DeviceStep {
  at: string;
  command: ToyCommand;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

function level(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v.trim().replace(/%$/, '')) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(100, Math.max(0, n)));
}

function stepOf(v: unknown): number | number[] | null {
  if (Array.isArray(v)) {
    const arr = v.map(level).filter((x): x is number => x !== null);
    return arr.length ? arr.slice(0, 8) : null;
  }
  return level(v);
}

function msList(v: unknown, min: number, max = 60_000): number[] {
  const arr = Array.isArray(v) ? v : [v];
  return arr
    .map((x) => (typeof x === 'number' ? x : typeof x === 'string' ? Number(x) : NaN))
    .filter((n) => Number.isFinite(n))
    .map((n) => Math.round(Math.min(max, Math.max(min, n))))
    .slice(0, 64);
}

function toWave(v: unknown, rotate: boolean): ToyWave | null {
  if (!isObj(v)) {
    const one = stepOf(v);
    return one === null ? null : { steps: [one], intervals: [1000] };
  }
  const pattern = v.pattern ?? v.steps ?? v.levels;
  let steps = Array.isArray(pattern) ? pattern.map(stepOf).filter((x): x is number | number[] => x !== null) : [];
  if (!steps.length) {
    const one = stepOf(v.intensity ?? v.value ?? v.speed ?? v.level ?? v.strength);
    if (one !== null) steps = [one];
  }
  if (!steps.length) return null;
  const intervals = msList(v.interval ?? v.intervals ?? v.duration ?? v.durations ?? 1000, MIN_TOY_INTERVAL);
  const loop = typeof v.loop === 'number' ? v.loop : typeof v.loop === 'string' ? Number(v.loop) : NaN;
  return {
    steps: steps.slice(0, 64),
    intervals: intervals.length ? intervals : [1000],
    ...(Number.isFinite(loop) && loop >= 1 ? { loop: Math.min(10_000, Math.round(loop)) } : {}),
    ...(rotate && typeof v.clockwise === 'boolean' ? { clockwise: v.clockwise } : {}),
  };
}

function stroke(from: unknown, to: unknown, durations: unknown, loop: unknown): ToyStroke | null {
  const a = level(from);
  const b = level(to);
  const d = msList(durations ?? 1000, MIN_TOY_STROKE, 20_000);
  if (a === null || b === null || !d.length) return null;
  const n = typeof loop === 'number' ? loop : typeof loop === 'string' ? Number(loop) : 1;
  return { from: a, to: b, durations: d, loop: Number.isFinite(n) && n >= 1 ? Math.min(10_000, Math.round(n)) : 1 };
}

function toLinear(key: string, v: unknown): ToyLinear | null {
  if (!isObj(v)) return null;
  if (key === 'LINEAR') {
    const s = stroke(v.start_position ?? v.start ?? v.from, v.end_position ?? v.end ?? v.to, v.duration ?? v.durations, 1);
    return s ? { segments: [s], repeat: true } : null;
  }
  if (key === 'LINEAR_SPEED') {
    const [d0] = msList(v.start_duration ?? v.from_duration ?? 1500, MIN_TOY_STROKE, 20_000);
    const [d1] = msList(v.end_duration ?? v.to_duration ?? 500, MIN_TOY_STROKE, 20_000);
    const raw = typeof v.steps === 'number' ? v.steps : Number(v.steps ?? 10);
    const n = Number.isFinite(raw) ? Math.min(60, Math.max(2, Math.round(raw))) : 10;
    if (d0 === undefined || d1 === undefined) return null;
    const durations = Array.from({ length: n }, (_, i) => Math.round(d0 + ((d1 - d0) * i) / (n - 1)));
    const s = stroke(v.start_position ?? v.start ?? v.from, v.end_position ?? v.end ?? v.to, durations, 1);
    return s ? { segments: [s], repeat: true } : null;
  }
  const segments = (Array.isArray(v.segments) ? v.segments : [])
    .filter(isObj)
    .map((s) => stroke(s.start ?? s.start_position ?? s.from, s.end ?? s.end_position ?? s.to, s.durations ?? s.duration, s.loop))
    .filter((s): s is ToyStroke => !!s)
    .slice(0, 20);
  return segments.length ? { segments, repeat: v.repeat === true } : null;
}

/** 一组"键: 值"（<device> 里读出来的，或者"控制指令"预设写的 do）→ 一条指令；一个都认不出来时为 null */
export function commandFromEntries(entries: Iterable<[string, unknown]>): ToyCommand | null {
  const cmd: ToyCommand = {};
  for (const [rawKey, v] of entries) {
    const key = rawKey.trim().toUpperCase();
    switch (key) {
      case 'VIBRATE':
      case 'OSCILLATE':
      case 'ROTATE':
      case 'CONSTRICT':
      case 'INFLATE': {
        const kind = key.toLowerCase() as ScalarKind;
        const w = toWave(v, kind === 'rotate');
        if (w) cmd[kind] = w;
        break;
      }
      case 'LINEAR':
      case 'LINEAR_SPEED':
      case 'LINEAR_PATTERN': {
        const l = toLinear(key, v);
        if (l) cmd.linear = l;
        break;
      }
      case 'STOP':
        if (v !== false && v !== 0 && v !== 'false') cmd.stop = true;
        break;
    }
  }
  if (cmd.stop) return { stop: true };
  return Object.keys(cmd).length ? cmd : null;
}

const KEY_NAMES = ['LINEAR_PATTERN', 'LINEAR_SPEED', 'LINEAR', 'VIBRATE', 'OSCILLATE', 'ROTATE', 'CONSTRICT', 'INFLATE', 'STOP'];
const KEY_SOURCE = `["'“”]?\\b(${KEY_NAMES.join('|')})\\b["'“”]?\\s*[:：]`;

/** 宽松地读 JSON：全角标点、单引号、没加引号的键、多余的逗号 */
function looseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    // 往下修
  }
  const t = s
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/：/g, ':')
    .replace(/，/g, ',')
    .replace(/'/g, '"')
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
    .replace(/,\s*([}\]])/g, '$1');
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/** 从 from 开始读一个值：对象、数组按括号配对读完整，其余读到行尾、逗号或分号 */
function readValue(s: string, from: number): { raw: string; end: number } | null {
  let i = from;
  while (i < s.length && /\s/.test(s[i] as string)) i += 1;
  const c = s[i];
  if (c === '{' || c === '[') {
    let depth = 0;
    let quote: string | null = null;
    for (let j = i; j < s.length; j += 1) {
      const ch = s[j] as string;
      if (quote) {
        if (ch === '\\') j += 1;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '{' || ch === '[') depth += 1;
      else if (ch === '}' || ch === ']') {
        depth -= 1;
        if (depth === 0) return { raw: s.slice(i, j + 1), end: j + 1 };
      }
    }
    return null;
  }
  // 只读一个值：同一行里可以接着写下一个键（"VIBRATE": 0 "OSCILLATE": 0）
  const m = /^(?:-?\d+(?:\.\d+)?%?|"[^"\n]*"|'[^'\n]*'|“[^”\n]*”|[^\s,;，；}\]]+)/.exec(s.slice(i));
  const raw = (m?.[0] ?? '').trim();
  return raw ? { raw, end: i + (m?.[0].length ?? 0) } : null;
}

function valueOf(raw: string): unknown {
  const t = raw.trim();
  if (/^(true|false)$/i.test(t)) return t.toLowerCase() === 'true';
  if (/^-?\d+(\.\d+)?%?$/.test(t)) return Number(t.replace(/%$/, ''));
  if (t.startsWith('{') || t.startsWith('[')) return looseJson(t);
  return t.replace(/^["'“]|["'”]$/g, '');
}

/** 读 <device>…</device> 里的内容（插件的写法：一行或几行 "键": 值，可以带注释和分号）；读不出来为 null */
export function parseDeviceBlock(inner: string): ToyCommand | null {
  const text = inner.replace(/<!--[\s\S]*?-->/g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const entries: [string, unknown][] = [];
  const re = new RegExp(KEY_SOURCE, 'gi');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const val = readValue(text, m.index + m[0].length);
    if (!val) continue;
    entries.push([m[1] as string, valueOf(val.raw)]);
    re.lastIndex = val.end;
  }
  if (!entries.length && /^\s*["'“]?(stop|停|停下|停止)["'”]?\s*$/i.test(text)) return { stop: true };
  return commandFromEntries(entries);
}

/**
 * 读"控制指令"预设的输出：{"steps": [{"at": "她原话里的几个字", "do": {...}}]}（也认直接给数组、do 写成 cmd / command、键直接写在这一步里）。
 * 格式不对时为 null（让模型重写）；空数组是"这一句不用变"
 */
export function parseDeviceSteps(value: unknown): DeviceStep[] | null {
  const list = Array.isArray(value) ? value : isObj(value) && Array.isArray(value.steps) ? value.steps : null;
  if (!list) return null;
  const out: DeviceStep[] = [];
  for (const s of list) {
    if (!isObj(s)) continue;
    const body = isObj(s.do) ? s.do : isObj(s.cmd) ? s.cmd : isObj(s.command) ? s.command : s;
    const cmd = commandFromEntries(Object.entries(body));
    if (cmd) out.push({ at: typeof s.at === 'string' ? s.at.trim().slice(0, 60) : '', command: cmd });
  }
  return out.slice(0, 12);
}

const SKIP = /[\s\p{P}\p{S}]/u;

/**
 * 把"控制指令"的每一步放到她原话里的位置（字符下标）：按 at 去找（不看标点和空格，按顺序往后找，找不到时用前一半再找一次），
 * 还是找不到的夹在前后两步中间（第一步放开头），保证位置不往回走
 */
export function placeSteps(steps: DeviceStep[], text: string): { pos: number; command: ToyCommand }[] {
  const index: number[] = [];
  let flat = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (!SKIP.test(ch)) {
      index.push(i);
      flat += ch;
    }
  }
  let from = 0;
  const found = steps.map((s) => {
    const q = [...s.at].filter((ch) => !SKIP.test(ch)).join('');
    if (!q) return null;
    let k = flat.indexOf(q, from);
    if (k < 0 && q.length > 3) k = flat.indexOf(q.slice(0, Math.ceil(q.length / 2)), from);
    if (k < 0) return null;
    from = k + 1;
    return index[k] ?? null;
  });
  const out: { pos: number; command: ToyCommand }[] = [];
  let prev = 0;
  for (let i = 0; i < steps.length; i += 1) {
    let pos = found[i];
    if (pos === null || pos === undefined) {
      const next = found.slice(i + 1).find((p): p is number => typeof p === 'number' && p >= prev);
      pos = i === 0 ? 0 : Math.round((prev + (next ?? text.length)) / 2);
    }
    pos = Math.max(prev, Math.min(text.length, pos));
    out.push({ pos, command: steps[i]!.command });
    prev = pos;
  }
  return out;
}

/** 好几条一下子都到了（念得比算得快、控制指令来晚了）：合成一条，后面的盖过前面的，停下会清掉之前的 */
export function mergeCommands(list: ToyCommand[]): ToyCommand | null {
  let merged: ToyCommand | null = null;
  for (const c of list) {
    if (c.stop) merged = { stop: true };
    else {
      const { stop: _s, ...rest } = merged ?? {};
      merged = { ...rest, ...c };
    }
  }
  return merged;
}

function fmtSec(ms: number): string {
  const s = ms / 1000;
  return s >= 10 ? String(Math.round(s)) : String(Math.round(s * 10) / 10);
}

function levelText(s: number | number[]): string {
  return Array.isArray(s) ? s.join('/') : String(s);
}

/** 一种的写法（给人看，也给"控制指令"预设看现在在做什么） */
export function describeWave(w: ToyWave): string {
  if (w.steps.length === 1) return `${levelText(w.steps[0] as number | number[])}%`;
  const shown = w.steps.slice(0, 8).map(levelText).join('→') + (w.steps.length > 8 ? '…' : '');
  const secs = [...new Set(w.intervals.map(fmtSec))].slice(0, 4).join('/');
  return `变速 ${shown}（每档 ${secs} 秒${w.loop ? `，放 ${w.loop} 遍` : ''}）`;
}

export function describeLinear(l: ToyLinear): string {
  const s = l.segments[0] as ToyStroke;
  const secs = [...new Set(s.durations.map(fmtSec))].slice(0, 4).join('/');
  const more = l.segments.length > 1 ? `等 ${l.segments.length} 段` : '';
  return `${s.from}–${s.to}（每下 ${secs} 秒）${more}${l.repeat ? '' : '，不循环'}`;
}

/** 一条指令写成一句话："震动 40%，伸缩 10–90（每下 0.5 秒）" */
export function describeCommand(c: ToyCommand): string {
  if (c.stop) return '停下';
  const parts: string[] = [];
  for (const k of SCALAR_KINDS) {
    const w = c[k];
    if (w) parts.push(`${TOY_KIND_LABEL[k]} ${describeWave(w)}`);
  }
  if (c.linear) parts.push(`伸缩 ${describeLinear(c.linear)}`);
  return parts.join('，');
}
