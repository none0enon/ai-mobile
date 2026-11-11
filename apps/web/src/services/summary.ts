import { AiError, buildSummaryMessages, parseSummary, samplerRequest } from '@app/ai';
import type { Chat, Message } from '@app/shared';
import { memories } from '@/mock/memories';
import { useAiStore } from '@/stores/ai';
import { useCharacterStore } from '@/stores/characters';
import { useLibraryStore } from '@/stores/library';
import { uid } from '@/utils/id';
import { messageToText, MissingPresetError, personaOf } from './prompt';

/**
 * 总结聊天（设计文档 §4.2）：用"总结"预设把一段已经定稿的聊天写成摘要，记下以后用得上的事，更新好感、心情和称呼。
 * - 摘要进 chat.summaries，提示词里的"过往摘要"用最近几段；
 * - 攒够 SUMMARY_EVERY 条还没总结的就自动整理（stores/chat.ts，"总结 / 记忆"接通了 API 时），聊天 ⋯ 里也能手动整理；
 * - 最后几条可能还会重新生成、编辑，先不整理。
 * 记下的事现在放在内存里的记忆本（记忆还没存进本机，下一步做）。
 */

export const SUMMARY_EVERY = 30;
/** 一次最多整理这么多条 */
const MAX_BATCH = 60;
/** 最后这几条先不整理 */
const KEEP_RECENT = 4;

export interface SummaryOutcome {
  text: string;
  memories: string[];
  affectionDelta: number;
  covered: number;
  model: string;
  presetName: string;
}

/** 还没总结、已经定稿的消息（失败的、被打断的不算） */
export function pendingForSummary(chat: Chat, list: Message[]): Message[] {
  const at = chat.summaryUntilMessageId ? list.findIndex((m) => m.id === chat.summaryUntilMessageId) : -1;
  return list.slice(at + 1, Math.max(at + 1, list.length - KEEP_RECENT)).filter((m) => !m.meta.error && !m.meta.interrupted && (m.text || m.parts.length));
}

/** 整理一段；没有要整理的返回 null。chat 要传聊天 store 里的那个对象（结果直接写在上面） */
export async function summarizeChat(chat: Chat, list: Message[], opts: { signal?: AbortSignal } = {}): Promise<SummaryOutcome | null> {
  const ai = useAiStore();
  const chars = useCharacterStore();
  const c = chars.byId(chat.characterId);
  if (!c) throw new AiError('no_route', '找不到这个角色');
  if (!ai.isLive('summary')) throw new AiError('no_route', '"总结 / 记忆"还没接通 API：在"我的 → API 设置"里设置（默认跟随主对话）');
  const preset = useLibraryStore().presetForUse('summary', c);
  if (!preset) throw new MissingPresetError('总结');
  const batch = pendingForSummary(chat, list).slice(0, MAX_BATCH);
  if (!batch.length) return null;

  const persona = personaOf(chat);
  const who = (m: Message) => (m.role === 'user' ? persona.name : m.role === 'assistant' ? c.name : '旁白');
  const transcript = batch.map((m) => ({ m, text: messageToText(m, c, persona.name) })).filter((x) => x.text).map((x) => `${who(x.m)}: ${x.text}`);
  const known = memories.filter((m) => m.characterId === c.id && m.status === 'active');
  const { value, result } = await ai.system.json(
    'summary',
    {
      messages: buildSummaryMessages(
        {
          character: { name: c.name, pronoun: c.pronoun },
          user: { name: persona.name },
          previousSummary: chat.summaries?.at(-1)?.text,
          memories: known.slice(0, 40).map((m) => ({ id: m.id, content: m.content })),
          transcript,
          now: new Date(),
        },
        preset,
      ),
      ...samplerRequest(preset.sampler),
    },
    (v) => parseSummary(v, new Set(known.map((m) => m.id))),
    { signal: opts.signal },
  );

  const first = batch[0] as Message;
  const last = batch.at(-1) as Message;
  chat.summaries = [...(chat.summaries ?? []), { fromMessageId: first.id, toMessageId: last.id, text: value.summary, at: Date.now() }];
  chat.summaryUntilMessageId = last.id;
  const now = Date.now();
  for (const d of value.memories) {
    for (const old of d.supersedes) {
      const m = memories.find((x) => x.id === old);
      if (m) Object.assign(m, { status: 'superseded', updatedAt: now });
    }
    memories.push({
      id: uid('mem'),
      characterId: c.id,
      type: d.type,
      content: d.content,
      importance: d.importance,
      pinned: false,
      status: 'active',
      dueAt: d.dueAt,
      sourceMessageIds: batch.map((m) => m.id),
      happenedAt: now,
      vector: null,
      lastRecalledAt: null,
      recallCount: 0,
      createdAt: now,
      updatedAt: now,
    });
  }
  const rel = value.relationship;
  if (rel.affectionDelta) chars.bumpAffection(c.id, rel.affectionDelta);
  if (rel.mood) c.relationship.mood = rel.mood;
  if (rel.nicknames.user) c.relationship.userNickname = rel.nicknames.user;
  if (rel.nicknames.char) c.relationship.charNickname = rel.nicknames.char;
  return { text: value.summary, memories: value.memories.map((m) => m.content), affectionDelta: rel.affectionDelta, covered: batch.length, model: result.model, presetName: preset.name };
}
