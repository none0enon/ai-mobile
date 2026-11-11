import type { Preset, PromptBlock } from '../types/preset.ts';
import { substituteMacros, type MacroContext } from './macros.ts';
import { estimateTokens } from './tokens.ts';

/**
 * 任务类预设（小剧场 / 总结 / 生图）拼成消息：按块的顺序，关掉的不发、空的不发；
 * 普通块替换宏（{{char}} {{user}} {{time}}……），程序填充块填这次任务的输入；
 * 相邻的同角色块合成一条（中间空一行），所以默认的预设拼出来是"一条系统说明 + 一条输入"。
 * 任务没有聊天记录，块的"插在聊天记录倒数第几条"不起作用。
 */

export interface TaskPromptInput {
  preset: Pick<Preset, 'blocks'>;
  /** 程序填充块的内容：块的 identifier → 这一次的内容（空的不发） */
  fills: Record<string, string>;
  macros?: MacroContext;
  /** 这一次的类型（生图：scene / portrait / face / background）：块写了触发条件时，只在条件里有它时发送 */
  type?: string;
}

export interface TaskBlockReport {
  identifier: string;
  name: string;
  role: PromptBlock['role'];
  enabled: boolean;
  marker: boolean;
  content: string;
  tokens: number;
  sent: boolean;
  note?: string;
}

export interface TaskPromptResult {
  messages: { role: PromptBlock['role']; content: string }[];
  blocks: TaskBlockReport[];
}

export function assembleTaskPrompt(input: TaskPromptInput): TaskPromptResult {
  const ctx: MacroContext = input.macros ?? { char: '', user: '' };
  const messages: TaskPromptResult['messages'] = [];
  const blocks: TaskBlockReport[] = [];
  for (const b of input.preset.blocks) {
    const known = !b.marker || b.identifier in input.fills;
    const content = (b.marker ? (input.fills[b.identifier] ?? '') : substituteMacros(b.content, ctx)).replace(/\r/g, '');
    const report: TaskBlockReport = { identifier: b.identifier, name: b.name, role: b.role, enabled: b.enabled, marker: b.marker, content, tokens: estimateTokens(content), sent: false };
    blocks.push(report);
    if (!b.enabled) {
      report.note = '预设里关闭了';
      continue;
    }
    if (b.triggers?.length && !(input.type && b.triggers.includes(input.type))) {
      report.note = `只在 ${b.triggers.join(' / ')} 时发送`;
      continue;
    }
    if (!content.trim()) {
      report.note = known ? '这一次内容为空，不发送' : '这类预设没有这块内容（程序不认识这个程序填充块）';
      continue;
    }
    report.sent = true;
    const last = messages.at(-1);
    if (last && last.role === b.role) last.content = `${last.content}\n\n${content}`;
    else messages.push({ role: b.role, content });
  }
  return { messages, blocks };
}
