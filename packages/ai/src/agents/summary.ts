import { assembleTaskPrompt, type MemoryType } from '@app/shared';
import type { ChatMessage } from '../llm/types.ts';
import type { TaskPreset } from './taskPreset.ts';

/**
 * 总结 / 记忆智能体（设计文档 §4.2）：把一段已定稿的聊天压成章节摘要，抽出记忆条目和关系变化。
 * 只从定稿的消息里抽（调用方负责跳过最后两轮和没被选中的 swipe）；好感变化每次最多 ±3。
 * 提示词（任务、输出格式、规则）全在"总结"预设里；这里只填这一次的输入。
 */

export interface SummaryInput {
  character: { name: string; pronoun: string };
  user: { name: string };
  /** 上一段的摘要（接着写，不重复） */
  previousSummary?: string;
  /** 已有的记忆（带 id），新记忆和旧的冲突时在 supersedes 里写旧的 id */
  memories?: { id: string; content: string }[];
  /** 要总结的聊天："名字: 内容"，从旧到新 */
  transcript: string[];
  now: Date;
}

export interface MemoryDraft {
  type: MemoryType;
  content: string;
  importance: number;
  dueAt: number | null;
  supersedes: string[];
}

export interface SummaryOutput {
  summary: string;
  memories: MemoryDraft[];
  relationship: { affectionDelta: number; mood: string | null; nicknames: { user?: string; char?: string } };
}

const TYPES = new Set<MemoryType>(['fact', 'preference', 'event', 'promise', 'followup', 'emotion', 'relationship']);

/** 这一次的输入：填进"总结"预设的程序填充块 */
export function summaryFills(input: SummaryInput): Record<string, string> {
  return {
    summaryNow: `现在：${input.now.toISOString()}`,
    summaryPrevious: input.previousSummary ? `上一段摘要：${input.previousSummary}` : '',
    summaryMemories: input.memories?.length ? `已有记忆：\n${input.memories.map((m) => `- [${m.id}] ${m.content}`).join('\n')}` : '',
    summaryTranscript: `要整理的聊天：\n${input.transcript.join('\n')}`,
  };
}

/** 按"总结"预设拼提示词 */
export function buildSummaryMessages(input: SummaryInput, preset: TaskPreset): ChatMessage[] {
  return assembleTaskPrompt({ preset, fills: summaryFills(input), macros: { char: input.character.name, user: input.user.name, now: input.now } }).messages;
}

export function parseSummary(value: unknown, knownIds: Set<string> = new Set()): SummaryOutput | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.summary !== 'string' || !v.summary.trim()) return null;
  const memories: MemoryDraft[] = [];
  for (const raw of Array.isArray(v.memories) ? v.memories : []) {
    const m = raw as Record<string, unknown>;
    const type = m.type as MemoryType;
    const content = typeof m.content === 'string' ? m.content.trim() : '';
    if (!TYPES.has(type) || !content) continue;
    const importance = Math.round(Math.min(10, Math.max(1, Number(m.importance) || 5)));
    const due = typeof m.dueAt === 'string' ? Date.parse(m.dueAt) : NaN;
    memories.push({
      type,
      content,
      importance,
      dueAt: Number.isFinite(due) ? due : null,
      supersedes: Array.isArray(m.supersedes) ? m.supersedes.filter((id): id is string => typeof id === 'string' && (knownIds.size === 0 || knownIds.has(id))) : [],
    });
  }
  const rel = (v.relationship ?? {}) as Record<string, unknown>;
  const nick = (rel.nicknames ?? {}) as Record<string, unknown>;
  const delta = Math.round(Number(rel.affectionDelta) || 0);
  return {
    summary: v.summary.trim(),
    memories,
    relationship: {
      affectionDelta: Math.max(-3, Math.min(3, delta)),
      mood: typeof rel.mood === 'string' && rel.mood.trim() && rel.mood !== 'null' ? rel.mood.trim() : null,
      nicknames: {
        ...(typeof nick.user === 'string' && nick.user.trim() ? { user: nick.user.trim() } : {}),
        ...(typeof nick.char === 'string' && nick.char.trim() ? { char: nick.char.trim() } : {}),
      },
    },
  };
}
