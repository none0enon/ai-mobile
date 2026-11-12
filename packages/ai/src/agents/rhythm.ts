import { assembleTaskPrompt, type RhythmTask } from '@app/shared';
import type { ChatMessage } from '../llm/types.ts';
import type { TaskPreset } from './taskPreset.ts';

/**
 * 节律智能体（设计文档 §4.1、§9 开头）：
 * - 建世界：从角色卡和世界书里找出她住哪、在哪读书或工作、常去哪、身边有谁，写出作息模板、三餐习惯、衣柜；
 * - 排今天：按她的世界、模板、今天的日期天气、最近几天，排今天的作息、三餐、穿着、手头的事。
 * 提示词（任务、规则、输出格式）全在节律预设里，按触发条件只发这次的任务；这里只把这一次的输入填进程序填充块。
 * 输出用 @app/shared 的 parseBuiltWorld / parsePlanDay 读，再用 checkSchedule 检查。
 */

/** 节律预设的程序填充块（TASK_MARKERS.rhythm） */
export type RhythmFill =
  | 'rhythmCharacter'
  | 'rhythmSource'
  | 'rhythmWorld'
  | 'rhythmTemplate'
  | 'rhythmWardrobe'
  | 'rhythmToday'
  | 'rhythmRecent'
  | 'rhythmPromises'
  | 'rhythmAsk';

export interface RhythmPromptInput {
  task: Extract<RhythmTask, 'build-world' | 'plan-day'>;
  /** 排今天、穿着每天变化时：从衣柜里挑（outfit-pick）还是每天新编（outfit-new） */
  outfitMode?: 'pick' | 'new' | null;
  characterName: string;
  userName?: string;
  fills: Partial<Record<RhythmFill, string>>;
}

/** 这一次的类型：任务名，排今天时再加上穿着的做法 */
export function rhythmTypes(input: Pick<RhythmPromptInput, 'task' | 'outfitMode'>): string[] {
  return [input.task, ...(input.task === 'plan-day' && input.outfitMode ? [`outfit-${input.outfitMode}`] : [])];
}

export function buildRhythmMessages(input: RhythmPromptInput, preset: TaskPreset): ChatMessage[] {
  const fills: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.fills)) if (v) fills[k] = v;
  return assembleTaskPrompt({ preset, fills, macros: { char: input.characterName, user: input.userName ?? '' }, type: rhythmTypes(input) }).messages;
}
