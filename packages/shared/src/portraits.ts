import { EXPRESSION_LABELS, EXPRESSIONS, isExpression, OUTFITS, POSES, type Expression, type Outfit, type Pose } from './expressions.ts';
import { matchOutfit } from './outfitMatch.ts';
import type { ControlTagKind } from './tags.ts';
import type { DayOutfit, OutfitKind } from './types/rhythm.ts';
import type { HotspotShape, Portrait, PortraitPose, PortraitSet } from './types/sprite.ts';

/**
 * 立绘的挑选、表情词表、按文件名归类（类型见 types/sprite.ts）。
 * 各个模块只说"想要什么"（表情、场景姿势、场景服装、节律里今天那套），由 pickPortrait 在这个角色有的图里挑最合适的一张，
 * 所以角色有几张图、分了哪些表情动作服装都不用改调用的地方。
 */

export function emptyPortraitSet(): PortraitSet {
  return { portraits: [], expressions: [], poses: [], outfits: [], defaultPose: '', defaultOutfit: '', aspect: 0.6, face: { x: 0.5, y: 0.3, size: 0.3 } };
}

// —— 表情 ——

/** SillyTavern 表情立绘的 28 个分类标签 → 基础表情（设计文档 §10.1） */
export const ST_EXPRESSION_MAP: Record<string, Expression> = {
  neutral: 'neutral',
  admiration: 'smile',
  approval: 'smile',
  caring: 'smile',
  gratitude: 'smile',
  optimism: 'smile',
  relief: 'smile',
  pride: 'smile',
  joy: 'laugh',
  amusement: 'laugh',
  excitement: 'laugh',
  love: 'blush',
  desire: 'blush',
  embarrassment: 'shy',
  nervousness: 'shy',
  disgust: 'pout',
  annoyance: 'pout',
  surprise: 'surprised',
  realization: 'surprised',
  confusion: 'surprised',
  curiosity: 'surprised',
  fear: 'surprised',
  sadness: 'sad',
  grief: 'sad',
  disappointment: 'sad',
  remorse: 'sad',
  anger: 'angry',
  disapproval: 'angry',
};

/** 常见的别名（中文、英文），文件名和模型写偏了的时候认得出来 */
const ALIASES: Record<string, Expression> = {
  ...ST_EXPRESSION_MAP,
  default: 'neutral',
  normal: 'neutral',
  idle: 'neutral',
  calm: 'neutral',
  happy: 'smile',
  smiling: 'smile',
  grin: 'laugh',
  laughing: 'laugh',
  blushing: 'blush',
  embarrassed: 'shy',
  shocked: 'surprised',
  shock: 'surprised',
  cry: 'sad',
  crying: 'sad',
  mad: 'angry',
  tired: 'sleepy',
  sleeping: 'sleep',
  默认: 'neutral',
  普通: 'neutral',
  无表情: 'neutral',
  开心: 'smile',
  高兴: 'smile',
  笑: 'smile',
  笑容: 'smile',
  哈哈: 'laugh',
  红脸: 'blush',
  羞: 'shy',
  不满: 'pout',
  吃惊: 'surprised',
  震惊: 'surprised',
  伤心: 'sad',
  哭: 'sad',
  愤怒: 'angry',
  怒: 'angry',
  困: 'sleepy',
  睡: 'sleep',
  睡觉: 'sleep',
};
for (const e of EXPRESSIONS) ALIASES[EXPRESSION_LABELS[e]] = e;

/** 缺图时往哪个表情退（越靠前越像） */
const FALLBACK: Record<Expression, Expression[]> = {
  neutral: [],
  smile: ['laugh', 'blush', 'neutral'],
  laugh: ['smile', 'blush', 'neutral'],
  blush: ['shy', 'smile', 'neutral'],
  shy: ['blush', 'smile', 'neutral'],
  pout: ['angry', 'shy', 'neutral'],
  surprised: ['shy', 'neutral'],
  sad: ['pout', 'sleepy', 'neutral'],
  angry: ['pout', 'neutral'],
  sleepy: ['sleep', 'neutral'],
  sleep: ['sleepy', 'neutral'],
};

const key = (s: string) => s.normalize('NFKC').trim().toLowerCase();

/**
 * 把一个表情写法认成这个角色的表情 id：自定义表情（id 或名字）→ 基础表情 id → 中文名、ST 标签、别名。认不出返回 null。
 */
export function normalizeExpression(value: unknown, set?: Pick<PortraitSet, 'expressions'> | null): string | null {
  if (typeof value !== 'string') return null;
  const k = key(value);
  if (!k) return null;
  const custom = set?.expressions.find((e) => key(e.id) === k || key(e.label) === k);
  if (custom) return custom.id;
  if (isExpression(k)) return k;
  return ALIASES[k] ?? null;
}

/** 新建自定义表情时按名字猜挂哪个基础表情（坏笑 → 微笑、冷眼 → 平静）；猜不出是平静 */
export function guessExpressionBase(label: string): Expression {
  const n = normalizeExpression(label);
  if (n && isExpression(n)) return n;
  const k = key(label);
  let best: Expression = 'neutral';
  let len = 0;
  for (const [alias, e] of Object.entries(ALIASES)) {
    const ascii = /^[a-z]+$/.test(alias);
    if (alias.length > len && (ascii ? alias.length >= 4 : true) && k.includes(alias)) {
      best = e;
      len = alias.length;
    }
  }
  return best;
}

/** 自定义表情 → 它挂的基础表情；基础表情原样；认不出的当平静（语音情绪、Live2D、占位立绘用） */
export function baseExpression(value: string | null | undefined, set?: Pick<PortraitSet, 'expressions'> | null): Expression {
  if (!value) return 'neutral';
  if (isExpression(value)) return value;
  const custom = set?.expressions.find((e) => e.id === value);
  if (custom) return custom.base;
  const n = normalizeExpression(value, set);
  return n && isExpression(n) ? n : 'neutral';
}

/** 表情的名字（自定义表情用自己起的名字） */
export function expressionLabel(value: string, set?: Pick<PortraitSet, 'expressions'> | null): string {
  if (isExpression(value)) return EXPRESSION_LABELS[value];
  return set?.expressions.find((e) => e.id === value)?.label ?? value;
}

/**
 * 想要 want 时依次试哪些表情，按"像的程度"分层：自己 → 它的基础表情 → 挂在同一个基础表情上的别的自定义表情
 * → 退一步的基础表情 → 挂在它上面的…… → 平静。同一层的一样像。
 */
export function expressionTiers(want: string | null | undefined, set: Pick<PortraitSet, 'expressions'>): string[][] {
  const seen = new Set<string>();
  const tiers: string[][] = [];
  const push = (ids: string[]) => {
    const fresh = ids.filter((id) => !seen.has(id));
    for (const id of fresh) seen.add(id);
    if (fresh.length) tiers.push(fresh);
  };
  // 基础表情本身比挂在它上面的自定义表情更"通用"：退的时候先退到基础表情
  const family = (b: Expression) => {
    push([b]);
    push(set.expressions.filter((c) => c.base === b).map((c) => c.id));
  };
  const w = normalizeExpression(want, set) ?? 'neutral';
  const custom = set.expressions.find((e) => e.id === w);
  const base = custom ? custom.base : (w as Expression);
  push([w]);
  family(base);
  for (const b of FALLBACK[base] ?? []) family(b);
  family('neutral');
  return tiers;
}

/** 同上，摊平成一串 */
export function expressionChain(want: string | null | undefined, set: Pick<PortraitSet, 'expressions'>): string[] {
  return expressionTiers(want, set).flat();
}

function shown(set: PortraitSet): Portrait[] {
  const visible = set.portraits.filter((p) => !p.hidden);
  return visible.length ? visible : set.portraits;
}

export interface ExpressionOption {
  id: string;
  label: string;
  hint?: string;
  /** 自定义表情挂的基础表情 */
  base?: Expression;
}

/** 这个角色有图的表情：基础表情按固定顺序在前，自定义表情按添加顺序在后 */
export function availableExpressions(set: PortraitSet | null | undefined): ExpressionOption[] {
  if (!set) return [];
  const have = new Set(shown(set).map((p) => p.expression));
  const out: ExpressionOption[] = EXPRESSIONS.filter((e) => have.has(e)).map((e) => ({ id: e, label: EXPRESSION_LABELS[e] }));
  for (const c of set.expressions) if (have.has(c.id)) out.push({ id: c.id, label: c.label, hint: c.hint, base: c.base });
  return out;
}

/** 这个角色有图的动作 */
export function availablePoses(set: PortraitSet | null | undefined): PortraitPose[] {
  if (!set) return [];
  const have = new Set(shown(set).map((p) => p.pose));
  return set.poses.filter((p) => have.has(p.id));
}

export function hasPortraits(set: PortraitSet | null | undefined): set is PortraitSet {
  return !!set?.portraits.length;
}

// —— 挑一张 ——

export interface PortraitWant {
  expression?: string | null;
  /** 立绘的动作 id，或场景姿势（stand / sit / study / eat / lie） */
  pose?: string | null;
  /** 模型用 [pose:] 换过的动作：场景没有指定适合的动作时沿用它 */
  currentPose?: string | null;
  /** 立绘的服装 id，或场景服装（daily / sport / pajama / date / apron） */
  outfit?: string | null;
  /** 节律里今天穿的那套：按名字、别名、tags 对服装 */
  dayOutfit?: DayOutfit;
  /** 一样合适的几张里挑哪张（换表情时加一，轮着用同一个表情的几张） */
  seed?: number;
}

const SCENE_OUTFIT_KIND: Record<Outfit, OutfitKind> = { daily: 'daily', sport: 'sport', pajama: 'sleep', date: 'date', apron: 'daily' };

function outfitTarget(set: PortraitSet, want: PortraitWant, has: Set<string>): string {
  const usable = set.outfits.filter((o) => has.has(o.id));
  if (!usable.length) return '';
  if (want.outfit && usable.some((o) => o.id === want.outfit)) return want.outfit;
  const matched = matchOutfit(usable, want.dayOutfit, (o) => ({ name: o.label, match: o.match }));
  if (matched) return matched.id;
  const kind = want.outfit && want.outfit in OUTFITS ? SCENE_OUTFIT_KIND[want.outfit as Outfit] : undefined;
  const byKind = kind ? usable.filter((o) => o.kind === kind) : [];
  if (byKind.length) return (byKind.find((o) => o.id === set.defaultOutfit) ?? byKind[0])!.id;
  return has.has(set.defaultOutfit) ? set.defaultOutfit : '';
}

function poseTarget(set: PortraitSet, want: PortraitWant, has: Set<string>): string {
  const usable = set.poses.filter((p) => has.has(p.id));
  if (!usable.length) return '';
  if (want.pose && usable.some((p) => p.id === want.pose)) return want.pose;
  const prefer = (list: PortraitPose[]) =>
    (list.find((p) => p.id === want.currentPose) ?? list.find((p) => p.id === set.defaultPose) ?? list[0])!.id;
  if (want.pose && want.pose in POSES) {
    const scenePose = want.pose as Pose;
    const specific = usable.filter((p) => p.fits?.includes(scenePose));
    if (specific.length) return prefer(specific);
    const anywhere = usable.filter((p) => !p.fits?.length);
    if (anywhere.length) return prefer(anywhere);
  }
  if (want.currentPose && has.has(want.currentPose)) return want.currentPose;
  return has.has(set.defaultPose) ? set.defaultPose : prefer(usable);
}

/**
 * 在这个角色的立绘里挑最合适的一张。服装最要紧（场景、节律决定的），其次表情（缺图按 expressionChain 退），最后动作。
 * 一样合适的几张按 seed 轮着用。一张图都没有时返回 null（调用的地方显示占位立绘）。
 */
export function pickPortrait(set: PortraitSet | null | undefined, want: PortraitWant = {}): Portrait | null {
  if (!hasPortraits(set)) return null;
  const pool = shown(set);
  const outfit = outfitTarget(set, want, new Set(pool.map((p) => p.outfit)));
  const pose = poseTarget(set, want, new Set(pool.filter((p) => !outfit || p.outfit === outfit).map((p) => p.pose)));
  const tiers = expressionTiers(want.expression, set);
  const tierOf = new Map(tiers.flatMap((ids, i) => ids.map((id) => [id, i] as const)));
  // 依次比：服装 > 表情 > 动作（表情退一层也比动作对上要紧）
  let best = -1;
  let top: Portrait[] = [];
  for (const p of pool) {
    const o = !outfit || p.outfit === outfit ? 2 : p.outfit === set.defaultOutfit ? 1 : 0;
    const t = tierOf.get(p.expression);
    const e = t === undefined ? 0 : 50 - Math.min(t, 49);
    const q = !pose || p.pose === pose ? 2 : p.pose === set.defaultPose ? 1 : 0;
    const score = o * 10000 + e * 10 + q;
    if (score > best) {
      best = score;
      top = [p];
    } else if (score === best) top.push(p);
  }
  const seed = Math.abs(Math.trunc(want.seed ?? 0));
  return top[seed % top.length] ?? null;
}

// —— 给模型看的 ——

/** 聊天里有两个以上的动作时，让模型能用 [pose:] 换动作 */
export function portraitTags(allowed: readonly ControlTagKind[], set: PortraitSet | null | undefined): ControlTagKind[] {
  if (!allowed.includes('expr') || allowed.includes('pose') || availablePoses(set).length < 2) return [...allowed];
  return [...allowed, 'pose'];
}

const DEFAULT_EXPRESSION_LINE = `可用表情：${EXPRESSIONS.join(' ')}`;

/** 提示词里"可用表情 / 可用动作"那几行：有立绘时只列有图的（基础表情带中文名，自定义的带说明）；没有立绘时列全部基础表情 */
export function expressionPromptLines(set: PortraitSet | null | undefined, opts: { poses?: boolean } = {}): string {
  const exprs = availableExpressions(set);
  if (!exprs.length) return DEFAULT_EXPRESSION_LINE;
  const item = (id: string, label: string, hint?: string) => (id === label ? id : `${id}（${label}${hint ? `：${hint}` : ''}）`);
  const lines = [`可用表情：${exprs.map((e) => (e.base ? item(e.id, e.label, e.hint) : `${e.id}（${e.label}）`)).join('、')}`];
  const poses = availablePoses(set);
  if (opts.poses && poses.length >= 2) lines.push(`可用动作：${poses.map((p) => item(p.id, p.label, p.hint)).join('、')}`);
  return lines.join('\n');
}

// —— 按文件名归类 ——

/** 名字 → id：英文转小写连字符，中文原样（[expr:坏笑] 也认）；和已有的重名时加序号 */
export function labelId(label: string, taken: readonly string[]): string {
  const raw = label.normalize('NFKC').trim();
  const base = /^[\x20-\x7e]+$/.test(raw) ? raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item' : raw.replace(/[\s[\]【】:：|｜]+/g, '');
  let id = base || 'item';
  for (let i = 2; taken.includes(id); i++) id = `${base}-${i}`;
  return id;
}

function findLabel<T extends { id: string; label: string }>(list: readonly T[], token: string): T | undefined {
  const k = key(token);
  return list.find((x) => key(x.id) === k || key(x.label) === k);
}

export interface NameGuess {
  expression?: string;
  /** 已有的动作（带 id），或要新建的动作名 */
  pose?: { id?: string; label: string };
  outfit?: { id?: string; label: string };
  /** 文件名里认出来的、还没有的自定义表情名 */
  newExpression?: string;
}

function tokensOf(fileName: string): string[] {
  const tokens = fileName
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .split(/[_\-\s.·、]+/)
    .filter(Boolean);
  // 结尾的编号是变体（joy-1、微笑 2）
  while (tokens.length > 1 && /^\(?\d{1,3}\)?$/.test(tokens.at(-1)!)) tokens.pop();
  return tokens;
}

function guessTokens(tokens: string[], set: Pick<PortraitSet, 'expressions' | 'poses' | 'outfits'>): NameGuess {
  if (!tokens.length || tokens.every((t) => /^\d+$/.test(t))) return {};
  const out: NameGuess = {};
  let exprAt = -1;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const e = normalizeExpression(tokens[i], set);
    if (e) {
      out.expression = e;
      exprAt = i;
      break;
    }
  }
  const free: string[] = [];
  tokens.forEach((t, i) => {
    if (i === exprAt) return;
    const pose = findLabel(set.poses, t);
    const outfit = findLabel(set.outfits, t);
    if (pose && !out.pose) out.pose = { id: pose.id, label: pose.label };
    else if (outfit && !out.outfit) out.outfit = { id: outfit.id, label: outfit.label };
    else if (!/^\d+$/.test(t)) free.push(t);
  });
  if (exprAt < 0) {
    // 两段：认得出动作（或服装）时，另一段是新的自定义表情（抱臂_坏笑）
    if (tokens.length < 3) {
      if ((out.pose || out.outfit) && free.length === 1) out.newExpression = free[0];
      return out.pose || out.outfit ? out : {};
    }
    // 三段式但表情认不出：最后一段当新的自定义表情
    const last = free.pop();
    if (last) out.newExpression = last;
  }
  // 剩下的按 {服装}_{动作} 的顺序填空
  if (free.length >= 2 && !out.outfit && !out.pose) {
    out.outfit = { label: free.at(-2)! };
    out.pose = { label: free.at(-1)! };
  } else if (free.length) {
    if (!out.pose) out.pose = { label: free.at(-1)! };
    else if (!out.outfit) out.outfit = { label: free.at(-1)! };
  }
  return out;
}

/**
 * 按文件名猜表情、动作、服装：{服装}_{动作}_{表情}、{动作}_{表情}、{表情}（ST 表情文件夹：joy、joy-1）。
 * 表情认得出的（基础表情、中文名、ST 标签、已有的自定义表情）直接用；三段式里认不出的表情当新的自定义表情。
 * 角色名（ignore）不算；一批文件都带着的词（别的前缀）也不算（正好三段的除外）。只有编号的文件名（1.png）什么也猜不出，导入后自己选。
 */
export function guessFromFileNames(fileNames: readonly string[], set: Pick<PortraitSet, 'expressions' | 'poses' | 'outfits'>, ignore: readonly string[] = []): NameGuess[] {
  // 角色名（宇智波斑_抱臂_微笑、madara_smile）不算服装、动作
  const skip = new Set(ignore.flatMap((w) => [w, ...w.split(/[\s_\-()（）]+/)]).map(key).filter(Boolean));
  const all = fileNames.map((n) => tokensOf(n).filter((t) => !skip.has(key(t))));
  const common =
    all.length >= 2
      ? new Set((all[0] ?? []).map(key).filter((k) => !normalizeExpression(k, set) && all.every((t) => t.some((x) => key(x) === k))))
      : new Set<string>();
  // 正好三段的按 {服装}_{动作}_{表情} 读，不去掉（一批都是同一身衣服时服装也要记上）
  const tokens = all.map((t) => (t.length === 3 ? t : t.filter((x) => !common.has(key(x)))));
  const first = tokens.map((t) => guessTokens(t, set));
  // 第二遍：别的文件里认出来的动作、服装也算认得（宇智波斑_抱臂_平静 让 抱臂_坏笑 也认得出）
  const seen = <T extends { id: string; label: string }>(list: readonly T[], found: (string | undefined)[]) => [
    ...list,
    ...[...new Set(found.filter((l): l is string => !!l && !list.some((x) => x.label === l)))].map((label) => ({ id: `\0${label}`, label }) as T),
  ];
  const wider = {
    expressions: set.expressions,
    poses: seen(set.poses, first.map((g) => (g.pose?.id ? undefined : g.pose?.label))),
    outfits: seen(set.outfits, first.map((g) => (g.outfit?.id ? undefined : g.outfit?.label))),
  };
  return tokens.map((t) => {
    const g = guessTokens(t, wider);
    // 第二遍认出来的是还没建的，只留名字
    if (g.pose?.id?.startsWith('\0')) g.pose = { label: g.pose.label };
    if (g.outfit?.id?.startsWith('\0')) g.outfit = { label: g.outfit.label };
    return g;
  });
}

const POSE_WORDS: [Pose, RegExp][] = [
  ['stand', /站|stand/i],
  ['sit', /坐|sit/i],
  ['study', /学习|看书|读书|写字|书桌|study|read/i],
  ['eat', /吃|饭|eat|meal/i],
  ['lie', /躺|睡|lie|lying|sleep/i],
];

/** 新建动作时按名字猜适合哪些场景姿势（坐着、吃饭……）；猜不出 = 哪儿都能用 */
export function guessPoseFits(label: string): Pose[] {
  return POSE_WORDS.filter(([, re]) => re.test(label)).map(([p]) => p);
}

/** 新建服装时按名字猜用途 */
export function guessOutfitKind(label: string): OutfitKind | undefined {
  if (/运动|健身|球衣|泳|sport|gym|swim/i.test(label)) return 'sport';
  if (/睡衣|睡袍|pajama|pyjama|sleep/i.test(label)) return 'sleep';
  if (/约会|礼服|date|dress/i.test(label)) return 'date';
  if (/日常|便服|常服|daily|casual/i.test(label)) return 'daily';
  return undefined;
}

// —— 热区 ——

/** 没画过热区时按头像框（脸）的位置给一套（头、两边脸、肩膀），坐标相对立绘框 */
export function defaultHotspotShapes(set: Pick<PortraitSet, 'face' | 'aspect'>): Record<'head' | 'cheek-l' | 'cheek-r' | 'shoulder', HotspotShape> {
  const { x, y, size } = set.face;
  // size 是头像框的边长（占框宽）；换算成占框高
  const sh = size * set.aspect;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const rect = (x0: number, y0: number, x1: number, y1: number): HotspotShape => {
    const l = clamp(x0);
    const t = clamp(y0);
    return { kind: 'rect', x: l, y: t, w: Math.max(0.04, clamp(x1) - l), h: Math.max(0.03, clamp(y1) - t) };
  };
  return {
    head: rect(x - size * 0.3, y - sh * 0.5, x + size * 0.3, y - sh * 0.18),
    'cheek-l': rect(x - size * 0.28, y + sh * 0.02, x - size * 0.06, y + sh * 0.2),
    'cheek-r': rect(x + size * 0.06, y + sh * 0.02, x + size * 0.28, y + sh * 0.2),
    shoulder: rect(x - size * 0.8, y + sh * 0.75, x + size * 0.8, y + sh * 1.1),
  };
}


/** 场景让模型写 JSON 时的 expr 字段：认得出就换成这个角色的表情 id（自定义表情也算），认不出就不要 */
export function expressionField(value: unknown, set?: Pick<PortraitSet, 'expressions'> | null): { expr?: string } {
  const e = normalizeExpression(value, set);
  return e ? { expr: e } : {};
}
