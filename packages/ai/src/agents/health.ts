import { assembleTaskPrompt, type HealthTask } from '@app/shared';
import type { ChatMessage } from '../llm/types.ts';
import type { TaskPreset } from './taskPreset.ts';

/**
 * 健康计划智能体（设计文档 §9.13）：按你人设里的健康设置排这周（plan-week）和今天（plan-day）的健身计划、饮食计划。
 * 提示词（任务、规则、输出格式）全在「健康」预设里，按触发条件只发这次的任务；这里只把这一次的输入填进程序填充块。
 * 输出用 @app/shared 的 parseHealthWeek / parseHealthDay 读。
 */

/** 健康预设的程序填充块（TASK_MARKERS.health） */
export type HealthFill = 'healthProfile' | 'healthTime' | 'healthKitchen' | 'healthToday' | 'healthWeek' | 'healthRecent' | 'healthAsk';

export interface HealthPromptInput {
  task: HealthTask;
  /** 你的名字（预设里的 {{user}}） */
  userName: string;
  /** 陪你的那个角色（预设里的 {{char}}，可以不给） */
  characterName?: string;
  fills: Partial<Record<HealthFill, string>>;
}

export function buildHealthMessages(input: HealthPromptInput, preset: TaskPreset): ChatMessage[] {
  const fills: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.fills)) if (v) fills[k] = v;
  return assembleTaskPrompt({ preset, fills, macros: { char: input.characterName ?? '', user: input.userName }, type: input.task }).messages;
}
