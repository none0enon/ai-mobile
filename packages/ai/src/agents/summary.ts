import type { MemoryType } from '@app/shared';
import type { ChatMessage } from '../llm/types.ts';

/**
 * 总结 / 记忆智能体（设计文档 §4.2）：把一段已定稿的聊天压成章节摘要，抽出记忆条目和关系变化。
 * 只从定稿的消息里抽（调用方负责跳过最后两轮和没被选中的 swipe）；好感变化每次最多 ±3。
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

export function buildSummaryMessages(input: SummaryInput): ChatMessage[] {
  const { character: c, user } = input;
  const system = [
    `你负责整理${c.name}和${user.name}的聊天记录，帮${c.name}记住重要的事。`,
    '输出一个 JSON 对象，不要任何其他文字：',
    '{"summary": "这一段发生了什么（第三人称，100–200 字）", "memories": [{"type": "fact|preference|event|promise|followup|emotion|relationship", "content": "一句话，具体到人和事", "importance": 1-10, "dueAt": "需要之后跟进时写 ISO 时间（带时区），否则 null", "supersedes": ["被这条更新掉的旧记忆 id"]}], "relationship": {"affectionDelta": -3 到 3 的整数, "mood": "' + c.name + '现在的心情，没变化写 null", "nicknames": {"user": "' + c.name + '对' + user.name + '的新称呼，没有就省略", "char": "' + user.name + '对' + c.name + '的新称呼，没有就省略"}}}',
    '规则：',
    `- 记忆只写以后用得上的：${user.name}的事实、偏好、约定、要跟进的事、情绪变化、关系里程碑；闲聊不记。`,
    '- 和已有记忆重复的不再写；有变化的写新的一条，并在 supersedes 里写旧的 id。',
    `- "周三下午两点面试"这类带时间的事写成 followup，dueAt 写事情结束后适合问结果的时间。`,
    '- 好感变化克制：普通聊天 0，明显的感动或冲突才 ±1～3。',
  ].join('\n');
  const now = input.now;
  const lines = [
    `现在：${now.toISOString()}`,
    input.previousSummary ? `上一段摘要：${input.previousSummary}` : '',
    input.memories?.length ? `已有记忆：\n${input.memories.map((m) => `- [${m.id}] ${m.content}`).join('\n')}` : '',
    `要整理的聊天：\n${input.transcript.join('\n')}`,
  ].filter(Boolean);
  return [
    { role: 'system', content: system },
    { role: 'user', content: lines.join('\n\n') },
  ];
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
