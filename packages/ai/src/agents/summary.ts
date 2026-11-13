import { assembleTaskPrompt, calendarParts, type MemoryType } from '@app/shared';
import type { ChatMessage } from '../llm/types.ts';
import type { TaskPreset } from './taskPreset.ts';

/**
 * 总结 / 记忆智能体（设计文档 §4.2）：把一段已定稿的聊天写成梗概（进时间线）、按话题切成故事片段（带标签）、
 * 抽出记忆条目（注明来自第几行）和关系变化。
 * 聊天记录每行带编号和时间（"#12 [11-02 周六 22:10] 名字: 内容"），程序按行号记下精确的来源消息和发生时间。
 * 只从定稿的消息里抽（调用方负责跳过最后几条和没被选中的 swipe）；好感变化每次最多 ±3。
 * 提示词（任务、输出格式、规则）全在"总结"预设里；这里只填这一次的输入。
 */

export interface SummaryLine {
  /** 行号，从 1 开始 */
  n: number;
  at: number;
  who: string;
  text: string;
}

export interface SummaryInput {
  character: { name: string; pronoun: string };
  user: { name: string };
  /** 上一段的梗概（接着写，不重复） */
  previousSummary?: string;
  /** 和这段聊天可能有关的已有记忆（带 id），新记忆和旧的冲突时在 supersedes 里写旧的 id */
  memories?: { id: string; content: string; at?: number | null }[];
  /** 要总结的聊天，从旧到新 */
  lines: SummaryLine[];
  now: Date;
  /** 时间按这个时区写；不给用运行环境的时区 */
  timeZone?: string;
}

export interface SliceDraft {
  title: string;
  text: string;
  /** 起止行号（含） */
  from: number;
  to: number;
  mood: string[];
  special: string[];
  important: boolean;
}

export interface MemoryDraft {
  type: MemoryType;
  content: string;
  importance: number;
  dueAt: number | null;
  supersedes: string[];
  /** 来自第几行 */
  lines: number[];
  /** 涉及的人、地点、物品 */
  entities: string[];
}

export interface SummaryOutput {
  summary: string;
  slices: SliceDraft[];
  memories: MemoryDraft[];
  relationship: { affectionDelta: number; mood: string | null; nicknames: { user?: string; char?: string } };
}

const TYPES = new Set<MemoryType>(['fact', 'preference', 'event', 'promise', 'followup', 'emotion', 'relationship']);
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const pad = (n: number) => String(n).padStart(2, '0');

/** "11-02 周六 22:10" */
export function lineTime(at: number, timeZone?: string): string {
  const p = calendarParts(at, timeZone);
  return `${pad(p.month)}-${pad(p.day)} 周${WEEK[p.weekday]} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** "2026-11-02"：记忆、片段在提示词里显示的日期 */
export function dayLabel(at: number, timeZone?: string): string {
  const p = calendarParts(at, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** 这一次的输入：填进"总结"预设的程序填充块 */
export function summaryFills(input: SummaryInput): Record<string, string> {
  const tz = input.timeZone;
  const now = input.now.getTime();
  return {
    summaryNow: `现在：${dayLabel(now, tz)} ${lineTime(now, tz).slice(6)}${tz ? `（${tz}）` : ''}`,
    summaryPrevious: input.previousSummary ? `上一段梗概：${input.previousSummary}` : '',
    summaryMemories: input.memories?.length
      ? `已有记忆（和这段聊天可能有关的）：\n${input.memories.map((m) => `- [${m.id}]${m.at ? ` (${dayLabel(m.at, tz)})` : ''} ${m.content}`).join('\n')}`
      : '',
    summaryTranscript: `要整理的聊天（#行号 [时间] 名字: 内容）：\n${input.lines.map((l) => `#${l.n} [${lineTime(l.at, tz)}] ${l.who}: ${l.text}`).join('\n')}`,
  };
}

/** 按"总结"预设拼提示词 */
export function buildSummaryMessages(input: SummaryInput, preset: TaskPreset): ChatMessage[] {
  return assembleTaskPrompt({ preset, fills: summaryFills(input), macros: { char: input.character.name, user: input.user.name, now: input.now } }).messages;
}

const strings = (v: unknown, max: number): string[] =>
  Array.isArray(v)
    ? [...new Set(v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean))].slice(0, max)
    : typeof v === 'string' && v.trim()
      ? [v.trim()]
      : [];

/**
 * 解析总结的输出。knownIds：给模型看过的已有记忆的 id（supersedes 只认这些）；
 * lineCount：这次聊天记录有几行（行号只认 1…lineCount）
 */
export function parseSummary(value: unknown, knownIds: Set<string> = new Set(), lineCount = Infinity): SummaryOutput | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.summary !== 'string' || !v.summary.trim()) return null;
  const clampLine = (x: unknown) => {
    const n = Math.round(Number(x));
    return Number.isFinite(n) && n >= 1 ? Math.min(n, lineCount) : null;
  };

  const slices: SliceDraft[] = [];
  for (const raw of Array.isArray(v.slices) ? v.slices : []) {
    const s = (raw ?? {}) as Record<string, unknown>;
    const title = typeof s.title === 'string' ? s.title.trim().slice(0, 40) : '';
    const text = typeof s.text === 'string' ? s.text.trim() : '';
    if (!title && !text) continue;
    let from = clampLine(s.from) ?? 1;
    let to = clampLine(s.to) ?? (Number.isFinite(lineCount) ? lineCount : from);
    if (from > to) [from, to] = [to, from];
    slices.push({ title: title || text.slice(0, 30), text: text || title, from, to, mood: strings(s.mood, 4), special: strings(s.special, 6), important: s.important === true || s.important === 'true' });
  }

  const memories: MemoryDraft[] = [];
  for (const raw of Array.isArray(v.memories) ? v.memories : []) {
    const m = (raw ?? {}) as Record<string, unknown>;
    const type = m.type as MemoryType;
    const content = typeof m.content === 'string' ? m.content.trim() : '';
    if (!TYPES.has(type) || !content) continue;
    const importance = Math.round(Math.min(10, Math.max(1, Number(m.importance) || 5)));
    const due = typeof m.dueAt === 'string' ? Date.parse(m.dueAt) : NaN;
    const lines = (Array.isArray(m.lines) ? m.lines : []).map(clampLine).filter((n): n is number => n !== null);
    memories.push({
      type,
      content,
      importance,
      dueAt: Number.isFinite(due) ? due : null,
      supersedes: Array.isArray(m.supersedes) ? m.supersedes.filter((id): id is string => typeof id === 'string' && (knownIds.size === 0 || knownIds.has(id))) : [],
      lines: [...new Set(lines)],
      entities: strings(m.entities, 8),
    });
  }

  const rel = (v.relationship ?? {}) as Record<string, unknown>;
  const nick = (rel.nicknames ?? {}) as Record<string, unknown>;
  const delta = Math.round(Number(rel.affectionDelta) || 0);
  return {
    summary: v.summary.trim(),
    slices,
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
