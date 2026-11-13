import { assembleTaskPrompt } from '@app/shared';
import type { ChatMessage } from '../llm/types.ts';
import type { TaskPreset } from './taskPreset.ts';

/**
 * 控制指令智能体（设计文档 §9.14，心跳）：按她刚说的那句话、连着的玩具能做什么、你设的上限，写玩具的控制指令。
 * 提示词（任务、规则、输出格式）全在"控制指令"预设里；这里只把这一次的输入填进程序填充块。
 * 输出用 @app/shared 的 parseDeviceSteps 读（{"steps": [{"at": "她原话里的几个字", "do": {"VIBRATE": 30}}]}），
 * placeSteps 放到原话的位置上，读到、念到那里时执行。
 */

/** 控制指令预设的程序填充块（TASK_MARKERS.device） */
export type DeviceFill = 'deviceToys' | 'deviceLimits' | 'deviceNow' | 'deviceRecent' | 'deviceLine';

export interface DevicePromptInput {
  /** 你的名字（预设里的 {{user}}） */
  userName: string;
  /** 她的名字（预设里的 {{char}}） */
  characterName: string;
  fills: Partial<Record<DeviceFill, string>>;
}

export function buildDeviceMessages(input: DevicePromptInput, preset: TaskPreset): ChatMessage[] {
  const fills: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.fills)) if (v) fills[k] = v;
  return assembleTaskPrompt({ preset, fills, macros: { char: input.characterName, user: input.userName } }).messages;
}
