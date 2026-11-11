import { joinTags } from '../image/presets.ts';
import type { ImageRequest, ImageSize } from '../image/types.ts';
import type { ChatMessage } from '../llm/types.ts';

/**
 * 生图提示词智能体（设计文档 §4.3）：把对话里的一个画面（[cg:描述]、"画一张"、约会的关键时刻、番外里的一幕）
 * 写成 NovelAI 的 tags。外观基础 tags 来自角色卡，模型只写构图、动作、表情、服装、场景、光线；
 * 程序把外观 tags 放在最前面，负面 tags 合并角色卡的。
 */

export interface ImagePromptInput {
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

export function buildImagePromptMessages(input: ImagePromptInput): ChatMessage[] {
  const { character: c, scene = {}, withUser } = input;
  const system = [
    '你是 NovelAI V4.5 的提示词写手，把一个画面写成 Danbooru 风格的英文 tags。',
    '规则：',
    '- tags 顺序：人数（1girl / 1boy / 1girl, 1boy）→ 构图与镜头（upper body, cowboy shot, from side, close-up…）→ 表情与动作 → 服装 → 场景与背景 → 光线、天气、时段 → 氛围。',
    '- 不要写角色的外观（发色、瞳色、发型、体型），程序会自动加在最前面。',
    '- 不要写画师名和质量词（masterpiece、best quality 之类程序会加）。',
    '- 人物特写、半身用 portrait；风景、两个人并排用 landscape。',
    '- 只输出一个 JSON 对象，不要任何其他文字：',
    withUser
      ? '{"caption": "中文短标题（12 字以内）", "tags": "整体画面的 tags（人数、构图、场景、光线）", "negative": "额外的负面 tags，可以为空字符串", "size": "portrait|landscape|square", "characters": [{"who": "char", "tags": "她的表情、动作、服装", "position": "left|right|center"}, {"who": "user", "tags": "他的表情、动作、服装", "position": "left|right|center"}]}'
      : '{"caption": "中文短标题（12 字以内）", "tags": "逗号分隔的英文 tags", "negative": "额外的负面 tags，可以为空字符串", "size": "portrait|landscape|square"}',
  ].join('\n');
  const lines = [
    `角色：${c.name}${c.pronoun ? `（${c.pronoun}）` : ''}；外观 tags（程序会加，不要重复）：${c.appearanceTags || '（无）'}`,
    withUser ? `画面里还有：${withUser.name}${withUser.appearanceTags ? `；外观 tags：${withUser.appearanceTags}` : ''}` : '',
    scene.place ? `地点：${scene.place}` : '',
    scene.outfit ? `服装：${scene.outfit}` : '',
    [scene.timeOfDay, scene.weather].filter(Boolean).length ? `时间与天气：${[scene.timeOfDay, scene.weather].filter(Boolean).join('，')}` : '',
    scene.expression ? `此刻的表情：${scene.expression}` : '',
    input.recent?.length ? `最近的对话：\n${input.recent.slice(-6).join('\n')}` : '',
    `要画的画面：${input.caption}`,
  ].filter(Boolean);
  return [
    { role: 'system', content: system },
    { role: 'user', content: lines.join('\n') },
  ];
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
  const negative = joinTags(input.character.negativeTags, out.negative);
  const size: ImageSize = out.size;
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
  return { caption: input.caption.slice(0, 30), tags: input.caption, negative: '', size: 'portrait' };
}
