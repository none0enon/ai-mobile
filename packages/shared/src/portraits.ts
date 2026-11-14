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
  return {
    portraits: [],
    expressions: [],
    poses: [],
    outfits: [],
    defaultExpression: '',
    defaultPose: '',
    defaultOutfit: '',
    aspect: 0.6,
    face: { x: 0.5, y: 0.3, size: 0.3 },
  };
}

// —— 表情 ——
// 每个角色的表情就是它自己立绘上标的那些，名字、数量都不固定。
// 下面这 11 个词（expressions.ts）只是"情绪的说法"：程序在固定的时刻（戳一下、练完、碰杯……）会说一种情绪，
// 没有立绘时占位小人按它画脸，语音按它定语气。它们不是表情的规定，到了有立绘的角色那里，按名字对到她自己的表情上。

/** SillyTavern 表情立绘的 28 个分类标签 → 情绪（设计文档 §10.1） */
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

/** 说法 → 情绪（中文、英文、ST 标签）：认文件名、按名字对表情、猜语音语气用 */
const ALIASES: Record<string, Expression> = {
  ...ST_EXPRESSION_MAP,
  default: 'neutral',
  normal: 'neutral',
  idle: 'neutral',
  calm: 'neutral',
  happy: 'smile',
  smiling: 'smile',
  smirk: 'smile',
  grin: 'laugh',
  laughing: 'laugh',
  blushing: 'blush',
  embarrassed: 'shy',
  shocked: 'surprised',
  shock: 'surprised',
  frown: 'angry',
  cry: 'sad',
  crying: 'sad',
  tired: 'sleepy',
  sleeping: 'sleep',
  默认: 'neutral',
  普通: 'neutral',
  无表情: 'neutral',
  淡然: 'neutral',
  冷淡: 'neutral',
  开心: 'smile',
  高兴: 'smile',
  笑: 'smile',
  哈哈: 'laugh',
  红脸: 'blush',
  羞: 'shy',
  不满: 'pout',
  不屑: 'pout',
  嫌弃: 'pout',
  吃惊: 'surprised',
  震惊: 'surprised',
  伤心: 'sad',
  哭: 'sad',
  愤怒: 'angry',
  怒: 'angry',
  皱眉: 'angry',
  困: 'sleepy',
  睡: 'sleep',
};
for (const e of EXPRESSIONS) ALIASES[EXPRESSION_LABELS[e]] = e;

/** 一种情绪对不上时退到哪种（越靠前越像） */
const NEARBY: Record<Expression, Expression[]> = {
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

/** 一个说法（情绪词本身、别名、ST 标签）是哪种情绪；只认整个词 */
function moodWord(value: string): Expression | null {
  const k = key(value);
  if (isExpression(k)) return k;
  return ALIASES[k] ?? null;
}

/**
 * 按名字猜一个表情带的是哪种情绪（坏笑 → 微笑、皱眉 → 生气）；猜不出返回 null。
 * 只在程序内部用：语音的语气、占位小人的脸、Live2D 没单独设置时、程序的时刻按名字对表情。
 */
export function moodOf(value: string | null | undefined, set?: Pick<PortraitSet, 'expressions'> | null): Expression | null {
  if (!value) return null;
  const named = set?.expressions.find((e) => e.id === value);
  for (const text of named ? [named.label, named.id] : [value]) {
    const exact = moodWord(text);
    if (exact) return exact;
    const k = key(text);
    let best: Expression | null = null;
    let len = 0;
    for (const [alias, e] of Object.entries(ALIASES)) {
      // 英文短词不按包含算（"mad" 会对上 "madara"）
      if (alias.length > len && (/^[a-z]+$/.test(alias) ? alias.length >= 4 : true) && k.includes(alias)) {
        best = e;
        len = alias.length;
      }
    }
    if (best) return best;
  }
  return null;
}

/** 同上，猜不出当平静（占位小人、Live2D、3D 小人这些只会画几种脸的地方用） */
export function expressionMood(value: string | null | undefined, set?: Pick<PortraitSet, 'expressions'> | null): Expression {
  return moodOf(value, set) ?? 'neutral';
}

/** 程序在固定时刻要某种情绪时，用这个角色的哪个表情：自己设过的 → 按名字自动对 → 对不上返回 null（不换） */
export function expressionForMood(mood: Expression, set: Pick<PortraitSet, 'expressions' | 'moments'>): string | null {
  const own = set.moments?.[mood];
  if (own !== undefined) return set.expressions.some((e) => e.id === own) ? own : null;
  return autoExpressionForMood(mood, set);
}

/** 按名字自动对：名字就是这种情绪的说法的最先，其次名字里带着的；都没有时退一步到最相近的情绪（大笑 → 微笑）再找一次 */
export function autoExpressionForMood(mood: Expression, set: Pick<PortraitSet, 'expressions'>): string | null {
  const find = (m: Expression) =>
    set.expressions.find((e) => moodWord(e.label) === m || moodWord(e.id) === m)?.id ?? set.expressions.find((e) => moodOf(e.id, set) === m)?.id ?? null;
  const near = NEARBY[mood][0];
  return find(mood) ?? (near && near !== 'neutral' ? find(near) : null);
}

/**
 * 把一个表情写法认成这个角色的表情 id。
 * 有自己表情的角色：名字或 id 一样的直接用；是一种情绪的说法（smile、微笑、joy……，程序的时刻、模型写偏了）时按 expressionForMood 对；对不上返回 null（不换）。
 * 没有立绘的角色（占位小人）：认 11 种情绪和它们的说法。
 */
export function normalizeExpression(value: unknown, set?: Pick<PortraitSet, 'expressions' | 'moments'> | null): string | null {
  if (typeof value !== 'string') return null;
  const k = key(value);
  if (!k) return null;
  if (!set?.expressions.length) return moodWord(k);
  const own = set.expressions.find((e) => key(e.id) === k || key(e.label) === k);
  if (own) return own.id;
  const mood = moodWord(k);
  return mood ? expressionForMood(mood, set) : null;
}

/** 表情的名字 */
export function expressionLabel(value: string, set?: Pick<PortraitSet, 'expressions'> | null): string {
  if (!value) return '未标表情';
  const own = set?.expressions.find((e) => e.id === value);
  if (own) return own.label;
  return isExpression(value) ? EXPRESSION_LABELS[value] : value;
}

/**
 * 想要 want 时依次试这个角色的哪些表情，按像的程度分层：它自己 → 名字看起来是同一种情绪的 → 相近情绪的 → 默认表情。
 * 全是她自己的表情；没标表情的图不在里面。
 */
export function expressionTiers(want: string | null | undefined, set: Pick<PortraitSet, 'expressions' | 'moments' | 'defaultExpression'>): string[][] {
  const seen = new Set<string>();
  const tiers: string[][] = [];
  const push = (ids: string[]) => {
    const fresh = ids.filter((id) => id && !seen.has(id));
    for (const id of fresh) seen.add(id);
    if (fresh.length) tiers.push(fresh);
  };
  const w = normalizeExpression(want, set);
  const mood = w ? moodOf(w, set) : want ? moodWord(want) : null;
  if (w) push([w]);
  if (mood) {
    for (const m of [mood, ...NEARBY[mood]]) push(set.expressions.filter((e) => moodOf(e.id, set) === m).map((e) => e.id));
  }
  push([set.defaultExpression]);
  return tiers;
}

function shown(set: PortraitSet): Portrait[] {
  const visible = set.portraits.filter((p) => !p.hidden);
  return visible.length ? visible : set.portraits;
}

export interface ExpressionOption {
  id: string;
  label: string;
  hint?: string;
}

/** 这个角色有图的表情（按她自己的顺序） */
export function availableExpressions(set: PortraitSet | null | undefined): ExpressionOption[] {
  if (!set) return [];
  const have = new Set(shown(set).map((p) => p.expression));
  return set.expressions.filter((e) => have.has(e.id)).map((e) => ({ id: e.id, label: e.label, hint: e.hint }));
}

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
 * 在这个角色的立绘里挑最合适的一张。服装最要紧（场景、节律决定的），其次表情（缺图按 expressionTiers 退），最后动作。
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

/** 提示词里"可用表情 / 可用动作"那几行：有立绘时只列她有图的表情（带说明）；没有立绘时是占位小人会的那几种 */
export function expressionPromptLines(set: PortraitSet | null | undefined, opts: { poses?: boolean } = {}): string {
  const exprs = availableExpressions(set);
  if (!exprs.length) return DEFAULT_EXPRESSION_LINE;
  const item = (id: string, label: string, hint?: string) => {
    const note = [id === label ? '' : label, hint ?? ''].filter(Boolean).join('：');
    return note ? `${id}（${note}）` : id;
  };
  const lines = [`可用表情：${exprs.map((e) => item(e.id, e.label, e.hint)).join('、')}`];
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

/** 已有的（带 id），或要新建的名字 */
export interface NameGuess {
  expression?: { id?: string; label: string };
  pose?: { id?: string; label: string };
  outfit?: { id?: string; label: string };
}

/** 文件名里的一段是不是表情：她已有的表情，或者一种情绪的说法（smile、frown、joy……，名字照文件名） */
function expressionToken(token: string, set: Pick<PortraitSet, 'expressions'>): { id?: string; label: string } | null {
  const own = findLabel(set.expressions, token);
  if (own) return { id: own.id, label: own.label };
  const mood = moodWord(token);
  if (!mood) return null;
  // 同一个词的另一种写法已经有了（文件叫 smile、她的表情叫 微笑）
  const same = set.expressions.find((e) => moodWord(e.label) === mood);
  return same ? { id: same.id, label: same.label } : { label: token };
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

function guessTokens(raw: string[], set: Pick<PortraitSet, 'expressions' | 'poses' | 'outfits'>): NameGuess {
  const tokens = raw.filter((t) => !/^\d+$/.test(t));
  if (!tokens.length) return {};
  const out: NameGuess = {};
  // 表情：认得出的（她已有的、情绪的说法）优先；认不出时按位置，最后一段是表情
  let exprAt = -1;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const e = expressionToken(tokens[i]!, set);
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
    else free.push(t);
  });
  // 只有一段又认不出（下载.png、render.png）：不猜
  if (exprAt < 0 && tokens.length === 1 && free.length === 1) return {};
  if (exprAt < 0) {
    const last = free.pop();
    if (last) out.expression = { label: last };
  }
  // 剩下的从后往前：动作、服装（{服装}_{动作}_{表情}）
  for (const t of free.reverse()) {
    if (!out.pose) out.pose = { label: t };
    else if (!out.outfit) out.outfit = { label: t };
  }
  return out;
}

/**
 * 按文件名猜表情、动作、服装：{服装}_{动作}_{表情}、{动作}_{表情}、{表情}（ST 表情文件夹：joy、joy-1）。
 * 表情：她已有的表情直接用；别的按文件名新建（认得出的词放在哪都行，认不出的按位置读：最后一段是表情）。
 * 角色名（ignore）不算；一批文件都带着的词（别的前缀）也不算（正好三段的除外）。只有编号的文件名（1.png）什么也猜不出，导入后自己选。
 */
export function guessFromFileNames(fileNames: readonly string[], set: Pick<PortraitSet, 'expressions' | 'poses' | 'outfits'>, ignore: readonly string[] = []): NameGuess[] {
  // 角色名（宇智波斑_抱臂_微笑、madara_smile）不算服装、动作
  const skip = new Set(ignore.flatMap((w) => [w, ...w.split(/[\s_\-()（）]+/)]).map(key).filter(Boolean));
  const all = fileNames.map((n) => tokensOf(n).filter((t) => !skip.has(key(t))));
  const common =
    all.length >= 2
      ? new Set((all[0] ?? []).map(key).filter((k) => !expressionToken(k, set) && all.every((t) => t.some((x) => key(x) === k))))
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
    expressions: seen(set.expressions, first.map((g) => (g.expression?.id ? undefined : g.expression?.label))),
    poses: seen(set.poses, first.map((g) => (g.pose?.id ? undefined : g.pose?.label))),
    outfits: seen(set.outfits, first.map((g) => (g.outfit?.id ? undefined : g.outfit?.label))),
  };
  return tokens.map((t) => {
    const g = guessTokens(t, wider);
    // 第二遍认出来的是还没建的，只留名字
    if (g.expression?.id?.startsWith('\0')) g.expression = { label: g.expression.label };
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

/** 场景让模型写 JSON 时的 expr 字段：认得出就换成这个角色的表情 id，认不出就不要 */
export function expressionField(value: unknown, set?: Pick<PortraitSet, 'expressions' | 'moments'> | null): { expr?: string } {
  const e = normalizeExpression(value, set);
  return e ? { expr: e } : {};
}
