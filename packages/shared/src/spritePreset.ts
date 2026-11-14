import { POSES, type Pose } from './expressions.ts';
import { joinTags, leadCountTags } from './imageTags.ts';
import { blockLevel } from './presetUses.ts';
import { substituteMacros } from './st/macros.ts';
import type { Preset, PromptBlock } from './types/preset.ts';

/**
 * 立绘预设（分类 sprite，设计文档 §10.4）：给没有立绘的角色用 NovelAI 画立绘。预设里有两种块：
 * - 交给文本模型的任务（写外观 tags、给新表情 / 动作写 tags）：触发条件写任务名（SPRITE_TASKS），程序填充块是这一次的输入；
 * - 直接拼进 NovelAI 提示词的块（不发给文本模型，触发条件写下面几个）：
 *   - 画法 sprite-draw：正向提示词的模板，能用 {{char_appearance}}（长相）{{char_outfit}}（这身衣服的 tags）{{expression}}（表情的 tags）{{pose}}（动作的 tags）；
 *   - 负面 sprite-negative；
 *   - 表情 sprite-expr:名字：这个表情的 tags。块上还能写 Director Tools 换表情用哪种情绪、写给模型看的说明（extra.emotion / extra.hint）；
 *   - 动作 sprite-pose:名字：这个动作的 tags。块上还能写适合哪些场景姿势、说明（extra.fits / extra.hint）。
 * 有几个表情、几个动作、叫什么、每个的 tags 都在预设里改（同一起游戏的尺度：名字写在触发条件里），关掉的块不画；
 * 出图参数（模型、尺寸、换表情 / 换动作的办法……）在预设的 extra.sprite 里（spriteParams）。
 */

/** 交给文本模型的任务：块的触发条件写这几个名字 */
export const SPRITE_TASKS = {
  'sprite-tags': '写外观 tags',
  'sprite-label': '给新表情 / 动作写 tags',
} as const;
export type SpriteTask = keyof typeof SPRITE_TASKS;

export const SPRITE_DRAW = 'sprite-draw';
export const SPRITE_NEGATIVE = 'sprite-negative';
export const SPRITE_EXPR = 'sprite-expr:';
export const SPRITE_POSE = 'sprite-pose:';

/** 预设编辑页里一块是什么 */
export const SPRITE_BLOCK_KINDS = {
  task: '交给文本模型',
  draw: '画法（正向）',
  negative: '负面',
  expression: '表情',
  pose: '动作',
} as const;
export type SpriteBlockKind = keyof typeof SPRITE_BLOCK_KINDS;

export function spriteBlockKind(b: Pick<PromptBlock, 'triggers'>): SpriteBlockKind {
  const t = b.triggers ?? [];
  if (t.some((x) => x.startsWith(SPRITE_EXPR))) return 'expression';
  if (t.some((x) => x.startsWith(SPRITE_POSE))) return 'pose';
  if (t.includes(SPRITE_DRAW)) return 'draw';
  if (t.includes(SPRITE_NEGATIVE)) return 'negative';
  return 'task';
}

/** 块上的附加信息（表情、动作块用） */
export interface SpriteBlockMeta {
  /** 表情：Director Tools 换表情用哪种情绪（NovelAI 认的值，见 @app/ai 的 NOVELAI_EMOTIONS）；空 = 用局部重绘 */
  emotion?: string;
  /** 写给模型看：什么时候用这个表情 / 换这个动作 */
  hint?: string;
  /** 动作：适合哪些场景姿势（一起学习要 study……）；空 = 哪儿都能用 */
  fits?: Pose[];
}

export function spriteBlockMeta(b: Pick<PromptBlock, 'extra'>): SpriteBlockMeta {
  const x = (b.extra ?? {}) as Record<string, unknown>;
  const fits = Array.isArray(x.fits) ? x.fits.filter((f): f is Pose => typeof f === 'string' && f in POSES) : [];
  return {
    ...(typeof x.emotion === 'string' && x.emotion.trim() ? { emotion: x.emotion.trim() } : {}),
    ...(typeof x.hint === 'string' && x.hint.trim() ? { hint: x.hint.trim() } : {}),
    ...(fits.length ? { fits } : {}),
  };
}

/** 预设里的一个表情 / 动作 */
export interface SpriteLabel {
  /** 名字：画出来的立绘就标成这个表情 / 动作 */
  name: string;
  tags: string;
  hint: string;
  emotion: string;
  fits: Pose[];
  identifier: string;
}

/** 预设里的表情或动作：按块的顺序，只算开着的，同名的取前面那块 */
export function spriteLabels(preset: Pick<Preset, 'blocks'> | undefined, kind: 'expression' | 'pose'): SpriteLabel[] {
  const prefix = kind === 'expression' ? SPRITE_EXPR : SPRITE_POSE;
  const out: SpriteLabel[] = [];
  for (const b of preset?.blocks ?? []) {
    const name = b.enabled && !b.marker ? blockLevel(b, prefix) : '';
    if (!name || out.some((l) => l.name === name)) continue;
    const meta = spriteBlockMeta(b);
    out.push({ name, tags: joinTags(b.content), hint: meta.hint ?? '', emotion: meta.emotion ?? '', fits: meta.fits ?? [], identifier: b.identifier });
  }
  return out;
}

/** 开着的画法 / 负面块的内容（几块就接在一起） */
export function spriteText(preset: Pick<Preset, 'blocks'> | undefined, trigger: typeof SPRITE_DRAW | typeof SPRITE_NEGATIVE): string {
  return (preset?.blocks ?? [])
    .filter((b) => b.enabled && !b.marker && b.triggers?.includes(trigger))
    .map((b) => b.content.trim())
    .filter(Boolean)
    .join(', ');
}

/** 是能画立绘的预设（有画法那一块） */
export function isSpritePreset(preset: Pick<Preset, 'blocks'> | undefined): boolean {
  return !!preset?.blocks.some((b) => b.triggers?.includes(SPRITE_DRAW));
}

export type SpriteExpressionMethod = 'inpaint' | 'emotion' | 'img2img';
export type SpritePoseMethod = 'reference' | 'prompt';

/** 换表情的几种办法（照着底图） */
export const SPRITE_EXPRESSION_METHODS: Record<SpriteExpressionMethod, { label: string; desc: string }> = {
  inpaint: { label: '只重画脸', desc: '局部重绘：只重画头像框那一块，身子、衣服、姿势一像素不动，换表情时立绘不会跳' },
  emotion: { label: 'Director Tools', desc: 'NovelAI 官方的换表情工具（表情差分）：每个表情按块上选的情绪换；没选情绪的表情改用只重画脸' },
  img2img: { label: '整张图生图', desc: '整张图按新的表情 tags 改一遍，变化最大，衣服、头发也可能跟着变' },
};

/** 换动作的几种办法（照着底图） */
export const SPRITE_POSE_METHODS: Record<SpritePoseMethod, { label: string; desc: string }> = {
  reference: { label: '精准参考', desc: '用 V4.5 的精准参考照着底图里的人画新动作（V5 还不支持参考），画完不是透明底的再去背景' },
  prompt: { label: '同一个种子重画', desc: '用画底图的模型、同一个种子，只把动作 tags 换掉重画；能直接透明底，但人不一定那么像' },
};

/** 立绘预设的出图参数（存在预设的 extra.sprite 里；预设文件里写全，这里的默认值只给缺了的字段补上） */
export interface SpriteParams {
  /** 画底图（和"同一个种子重画"动作）用的模型；空 = "生图"的 API 里选的那个。要直接画透明底用 V5（nai-diffusion-5-full） */
  model: string;
  /** 宽高（NovelAI 要 64 的倍数） */
  width: number;
  height: number;
  steps: number;
  /** 提示词引导（CFG）：V5 Full 官方建议 4 左右 */
  scale: number;
  sampler: string;
  noiseSchedule: string;
  /** 底图用哪个表情、哪个动作（预设里表情块、动作块的名字；空或对不上 = 第一个） */
  baseExpression: string;
  basePose: string;
  /** 照着底图换表情的办法 */
  expressionMethod: SpriteExpressionMethod;
  /** 只重画脸：遮罩 = 头像框放大几倍（框外的一像素不动） */
  maskScale: number;
  /** 只重画脸的强度（1 = 遮罩里整块重画；小一点更像原来的脸，但表情变化小） */
  inpaintStrength: number;
  /** 只重画脸用的模型；空 = 按画底图的模型推（…-inpainting） */
  inpaintModel: string;
  /** Director Tools 换表情的强度档 0–5（0 正常，越大越弱） */
  emotionLevel: number;
  /** 整张图生图的强度 */
  img2imgStrength: number;
  /** 照着底图换动作的办法 */
  poseMethod: SpritePoseMethod;
  /** 精准参考用的模型（只有 V4.5 能用） */
  referenceModel: string;
  /** 精准参考：跟底图有多像（太高时动作也会照搬） */
  referenceStrength: number;
  /** 精准参考：保真度（1 很难用提示词改） */
  referenceFidelity: number;
  /** 画出来不是透明背景时，用 Director Tools 去背景（花点数） */
  removeBackground: boolean;
  /** 原样并入 NovelAI 的请求参数 */
  extra: Record<string, unknown>;
}

export const DEFAULT_SPRITE_PARAMS: SpriteParams = {
  model: 'nai-diffusion-5-full',
  width: 832,
  height: 1216,
  steps: 28,
  scale: 4,
  sampler: 'k_euler_ancestral',
  noiseSchedule: 'karras',
  baseExpression: '',
  basePose: '',
  expressionMethod: 'inpaint',
  maskScale: 1.3,
  inpaintStrength: 1,
  inpaintModel: '',
  emotionLevel: 0,
  img2imgStrength: 0.55,
  poseMethod: 'reference',
  referenceModel: 'nai-diffusion-4-5-full',
  referenceStrength: 0.7,
  referenceFidelity: 0.75,
  removeBackground: true,
  extra: {},
};

/** 预设里的出图参数，缺的字段用默认值补上 */
export function spriteParams(preset: Pick<Preset, 'extra'> | undefined): SpriteParams {
  const raw = (preset?.extra?.sprite ?? {}) as Partial<Record<keyof SpriteParams, unknown>>;
  const d = DEFAULT_SPRITE_PARAMS;
  const str = (v: unknown, def: string) => (typeof v === 'string' ? v : def);
  const num = (v: unknown, def: number) => (typeof v === 'number' && Number.isFinite(v) ? v : def);
  const pick = <T extends string>(v: unknown, options: Record<T, unknown>, def: T): T => (typeof v === 'string' && v in options ? (v as T) : def);
  return {
    model: str(raw.model, d.model).trim(),
    width: num(raw.width, d.width),
    height: num(raw.height, d.height),
    steps: num(raw.steps, d.steps),
    scale: num(raw.scale, d.scale),
    sampler: str(raw.sampler, d.sampler),
    noiseSchedule: str(raw.noiseSchedule, d.noiseSchedule),
    baseExpression: str(raw.baseExpression, d.baseExpression).trim(),
    basePose: str(raw.basePose, d.basePose).trim(),
    expressionMethod: pick(raw.expressionMethod, SPRITE_EXPRESSION_METHODS, d.expressionMethod),
    maskScale: num(raw.maskScale, d.maskScale),
    inpaintStrength: num(raw.inpaintStrength, d.inpaintStrength),
    inpaintModel: str(raw.inpaintModel, d.inpaintModel).trim(),
    emotionLevel: num(raw.emotionLevel, d.emotionLevel),
    img2imgStrength: num(raw.img2imgStrength, d.img2imgStrength),
    poseMethod: pick(raw.poseMethod, SPRITE_POSE_METHODS, d.poseMethod),
    referenceModel: str(raw.referenceModel, d.referenceModel).trim(),
    referenceStrength: num(raw.referenceStrength, d.referenceStrength),
    referenceFidelity: num(raw.referenceFidelity, d.referenceFidelity),
    removeBackground: typeof raw.removeBackground === 'boolean' ? raw.removeBackground : d.removeBackground,
    extra: raw.extra && typeof raw.extra === 'object' && !Array.isArray(raw.extra) ? (raw.extra as Record<string, unknown>) : {},
  };
}

/** 底图用的表情 / 动作：出图参数里写的那个，对不上时第一个 */
export function spriteBaseLabel(labels: SpriteLabel[], name: string): SpriteLabel | undefined {
  return labels.find((l) => l.name === name) ?? labels[0];
}

export interface SpriteDrawInput {
  name: string;
  /** 长相（同人是角色 tag + 作品 tag + 补充的外观） */
  appearance: string;
  /** 这身衣服的 tags */
  outfit: string;
  /** 表情、动作的 tags */
  expression: string;
  pose: string;
  /** 角色自己的负面 tags */
  negative?: string;
}

/** 按画法、负面两块拼 NovelAI 的提示词：宏换成这一次的，去掉空的和重复的，人数 tags（1girl、solo）挪到最前面 */
export function spritePrompt(preset: Pick<Preset, 'blocks'> | undefined, input: SpriteDrawInput): { prompt: string; negative: string } {
  const ctx = {
    char: input.name,
    user: '',
    extra: { char_appearance: input.appearance, char_outfit: input.outfit, expression: input.expression, pose: input.pose },
  };
  const { lead, rest } = leadCountTags(joinTags(substituteMacros(spriteText(preset, SPRITE_DRAW), ctx)));
  return {
    prompt: joinTags(lead, rest),
    negative: joinTags(substituteMacros(spriteText(preset, SPRITE_NEGATIVE), ctx), input.negative),
  };
}
