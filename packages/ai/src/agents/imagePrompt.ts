import { assembleTaskPrompt } from '@app/shared';
import { joinTags } from '../image/presets.ts';
import type { ImageRequest, ImageSize } from '../image/types.ts';
import type { ChatMessage } from '../llm/types.ts';
import type { TaskPreset } from './taskPreset.ts';

/**
 * 生图提示词智能体（设计文档 §4.3）：把对话里的一个画面（[cg:描述]、"画一张"、约会的关键时刻、番外里的一幕）
 * 写成 NovelAI 的 tags。外观基础 tags 来自角色卡，模型只写构图、动作、表情、服装、场景、光线；
 * 程序把外观 tags 放在最前面，负面 tags 合并角色卡的。
 * 提示词（任务、规则、"画什么"、输出格式）全在"生图"预设里；这里只填这一次的输入。
 */

/**
 * 画什么（对照 SillyTavern 生图扩展的几种模式）：
 * - scene：一个具体的画面（[cg:] 里的描述、番外里的一幕），默认；
 * - portrait：全身像（ST 的 Character）；
 * - face：脸部特写，比如自拍（ST 的 Face）；
 * - background：只画场景、不画人（ST 的 Background），给地点做背景图。
 * 预设里"画什么"的几块按触发条件（这几个值）只发对应的那一块。
 */
export type ImagePromptMode = 'scene' | 'portrait' | 'face' | 'background';

export interface ImagePromptInput {
  /** 画什么，默认 scene */
  mode?: ImagePromptMode;
  character: {
    name: string;
    /** 角色卡的外观 tags（发色、瞳色、发型、体型……） */
    appearanceTags: string;
    negativeTags?: string;
    pronoun?: string;
  };
  /** 要画的画面（中文描述） */
  caption: string;
  scene?: {
    /** 在哪：图书馆、雨夜的卧室…… */
    place?: string;
    /** 服装：睡衣、运动服、约会装…… */
    outfit?: string;
    timeOfDay?: string;
    weather?: string;
    /** 此刻的表情 */
    expression?: string;
  };
  /** 最近几句对话（帮助理解画面），纯文本 */
  recent?: string[];
  /** 画面里有没有"你"（两个人同框时用 V4 的多人提示词） */
  withUser?: { name: string; appearanceTags?: string } | null;
}

export interface ImagePromptOutput {
  /** 中文短标题，进相册 */
  caption: string;
  tags: string;
  negative: string;
  size: 'portrait' | 'landscape' | 'square';
  /** 两个人同框时每个人单独的 tags（模型给出的动作），外观 tags 由程序补上 */
  characters?: { who: 'char' | 'user'; tags: string; position?: 'left' | 'right' | 'center' }[];
}

/** 这一次的输入：填进"生图"预设的程序填充块 */
export function imagePromptFills(input: ImagePromptInput): Record<string, string> {
  const { character: c, scene = {}, withUser } = input;
  const mode = input.mode ?? 'scene';
  return {
    // 两个人同框才要的输出字段（解析时按 characters 读每个人的动作），其余时候不发
    imageCharacters:
      withUser && mode === 'scene'
        ? `画面里有两个人：tags 只写整体画面（人数、构图、场景、光线），再加一个 characters 字段分别写每个人：\n"characters": [{"who": "char", "tags": "${c.name}的表情、动作、服装", "position": "left|right|center"}, {"who": "user", "tags": "${withUser.name}的表情、动作、服装", "position": "left|right|center"}]`
        : '',
    imageSubject: [
      `角色：${c.name}${c.pronoun ? `（${c.pronoun}）` : ''}；外观 tags（程序会加，不要重复）：${c.appearanceTags || '（无）'}`,
      withUser ? `画面里还有：${withUser.name}${withUser.appearanceTags ? `；外观 tags：${withUser.appearanceTags}` : ''}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    imageScene: [
      scene.place ? `地点：${scene.place}` : '',
      scene.outfit ? `服装：${scene.outfit}` : '',
      [scene.timeOfDay, scene.weather].filter(Boolean).length ? `时间与天气：${[scene.timeOfDay, scene.weather].filter(Boolean).join('，')}` : '',
      scene.expression ? `此刻的表情：${scene.expression}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    imageRecent: input.recent?.length ? `最近的对话：\n${input.recent.slice(-6).join('\n')}` : '',
    imageCaption: `要画的画面：${input.caption}`,
  };
}

/** 按"生图"预设拼写 tags 的提示词；"画什么"那几块按这次的类型只发一块 */
export function buildImagePromptMessages(input: ImagePromptInput, preset: TaskPreset): ChatMessage[] {
  return assembleTaskPrompt({ preset, fills: imagePromptFills(input), macros: { char: input.character.name, user: input.withUser?.name ?? '' }, type: input.mode ?? 'scene' }).messages;
}

const SIZES = new Set(['portrait', 'landscape', 'square']);

function isPosition(v: unknown): v is 'left' | 'right' | 'center' {
  return v === 'left' || v === 'right' || v === 'center';
}

/** 英文 tags 清理：去掉中文和模型多写的外观、质量词 */
function cleanTags(tags: string): string {
  return joinTags(
    tags
      .replace(/[\r\n]+/g, ', ')
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter((t) => t && !/[\u4e00-\u9fff]/.test(t) && !/^(?:masterpiece|best quality|high quality|amazing quality|very aesthetic|absurdres)$/i.test(t))
      .join(', '),
  );
}

export function parseImagePrompt(value: unknown): ImagePromptOutput | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.tags !== 'string' || !v.tags.trim()) return null;
  const tags = cleanTags(v.tags);
  if (!tags) return null;
  const out: ImagePromptOutput = {
    caption: typeof v.caption === 'string' && v.caption.trim() ? v.caption.trim().slice(0, 30) : '',
    tags,
    negative: typeof v.negative === 'string' ? cleanTags(v.negative) : '',
    size: typeof v.size === 'string' && SIZES.has(v.size) ? (v.size as ImagePromptOutput['size']) : 'portrait',
  };
  if (Array.isArray(v.characters)) {
    const chars = v.characters
      .map((x) => x as Record<string, unknown>)
      .filter((x) => (x.who === 'char' || x.who === 'user') && typeof x.tags === 'string')
      .map((x) => ({ who: x.who as 'char' | 'user', tags: cleanTags(x.tags as string), ...(isPosition(x.position) ? { position: x.position } : {}) }));
    if (chars.length) out.characters = chars;
  }
  return out;
}

const CENTERS = { left: { x: 0.3, y: 0.5 }, right: { x: 0.7, y: 0.5 }, center: { x: 0.5, y: 0.5 } } as const;

/**
 * 智能体的输出 → 生图请求：单人时外观 tags 放最前面；两个人时整体 tags 做基础提示词，
 * 每个人的外观 + 动作做 V4 的人物提示词，按左右位置放
 */
export function toImageRequest(out: ImagePromptOutput, input: ImagePromptInput, seed?: number): ImageRequest {
  const size: ImageSize = out.size;
  // 背景图不画人：不加外观 tags，确保有 no humans
  if (input.mode === 'background') {
    return { prompt: joinTags('no humans, scenery', out.tags), negative: joinTags('1girl, 1boy, people', out.negative), size: out.size === 'portrait' ? 'landscape' : size, seed };
  }
  const negative = joinTags(input.character.negativeTags, out.negative);
  if (out.characters?.length && input.withUser) {
    return {
      prompt: out.tags,
      negative,
      size,
      seed,
      characters: out.characters.map((c) => ({
        prompt: joinTags(c.who === 'char' ? input.character.appearanceTags : input.withUser?.appearanceTags, c.tags),
        center: CENTERS[c.position ?? 'center'],
      })),
    };
  }
  return { prompt: joinTags(input.character.appearanceTags, out.tags), negative, size, seed };
}

/** 没有分配生图提示词智能体时的退路：外观 tags + 画面描述原文（V4 起能读懂一些自然语言） */
export function fallbackImagePrompt(input: ImagePromptInput): ImagePromptOutput {
  const lead = { scene: '', portrait: 'full body', face: 'close-up, portrait', background: '' }[input.mode ?? 'scene'];
  return { caption: input.caption.slice(0, 30), tags: joinTags(lead, input.caption), negative: '', size: input.mode === 'background' ? 'landscape' : 'portrait' };
}
