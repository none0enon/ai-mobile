import { assembleTaskPrompt, joinTags, type SpriteTask } from '@app/shared';
import type { ChatMessage } from '../llm/types.ts';
import type { TaskPreset } from './taskPreset.ts';

/**
 * 立绘预设里交给文本模型的两件事（设计文档 §10.4，"生图提示词"的 API）：
 * - sprite-tags 写外观 tags：从角色卡、世界书里找出她的长相，写成 NovelAI 的英文外观 tags（缺外观 tags 的角色画立绘前先写），顺带一套常穿的衣服；
 * - sprite-label 给预设里没有的表情 / 动作写 tags（表情是每个角色自己的，名字随你起）。
 * 提示词（任务、规则、输出格式）全在立绘预设里，按触发条件只发这次的任务；这里只把这一次的输入填进程序填充块、读回 JSON。
 * 立绘怎么画（画法、负面、各个表情动作的 tags、出图参数）不经过文本模型，见 @app/shared 的 spritePrompt。
 */

/** 立绘预设的程序填充块（TASK_MARKERS.sprite） */
export type SpriteFill = 'spriteCharacter' | 'spriteSource' | 'spriteLooks' | 'spriteAsk';

export interface SpritePromptInput {
  task: SpriteTask;
  characterName: string;
  userName?: string;
  fills: Partial<Record<SpriteFill, string>>;
}

export function buildSpriteMessages(input: SpritePromptInput, preset: TaskPreset): ChatMessage[] {
  const fills: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.fills)) if (v) fills[k] = v;
  return assembleTaskPrompt({ preset, fills, macros: { char: input.characterName, user: input.userName ?? '' }, type: input.task }).messages;
}

/** 英文 tags：去掉中文、质量词、换行（模型偶尔会多写） */
function englishTags(v: unknown): string {
  if (typeof v !== 'string') return '';
  return joinTags(
    v
      .replace(/[\r\n]+/g, ', ')
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter((t) => t && !/[一-鿿]/.test(t) && !/^(?:masterpiece|best quality|high quality|amazing quality|very aesthetic|absurdres)$/i.test(t))
      .join(', '),
  );
}

const text = (v: unknown, max = 40) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export interface SpriteLooks {
  /** 外观 tags（人数、发色、发型、瞳色、体型、显眼的特征），不含衣服 */
  appearance: string;
  /** 额外的负面 tags */
  negative: string;
  /** 她常穿的一套（立绘默认穿它）；设定里看不出来时为空 */
  outfit: { name: string; tags: string } | null;
}

export function parseSpriteLooks(value: unknown): SpriteLooks | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const appearance = englishTags(v.appearance);
  if (!appearance) return null;
  const o = v.outfit && typeof v.outfit === 'object' ? (v.outfit as Record<string, unknown>) : null;
  const outfitTags = englishTags(o?.tags);
  return {
    appearance,
    negative: englishTags(v.negative),
    outfit: outfitTags ? { name: text(o?.name, 16) || 'Outfit', tags: outfitTags } : null,
  };
}

export interface SpriteLabelTags {
  tags: string;
  /** 写给模型看：什么时候用 */
  hint: string;
  /** 表情：Director Tools 换表情用的情绪（不认识的值不用） */
  emotion: string;
}

export function parseSpriteLabel(value: unknown): SpriteLabelTags | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const tags = englishTags(v.tags);
  if (!tags) return null;
  return { tags, hint: text(v.hint), emotion: text(v.emotion, 20).toLowerCase() };
}
