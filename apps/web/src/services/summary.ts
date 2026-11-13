import { AiError, buildSummaryMessages, isAbortError, parseSummary, samplerRequest, type SummaryLine } from '@app/ai';
import type { Chat, Memory, Message } from '@app/shared';
import { useAiStore } from '@/stores/ai';
import { useCharacterStore } from '@/stores/characters';
import { useEnvironmentStore } from '@/stores/environment';
import { useLibraryStore } from '@/stores/library';
import { memKey, sliceText, useMemoryStore } from '@/stores/memory';
import { useMessageSettingsStore } from '@/stores/messageSettings';
import { uid } from '@/utils/id';
import { alwaysOn } from './memoryBlocks';
import { messageToText, MissingPresetError, personaOf } from './prompt';

/**
 * 总结聊天（设计文档 §4.2）：用"总结"预设把一段已经定稿的聊天写成梗概（进时间线）、故事片段（带标签）和记忆，
 * 更新好感、心情和称呼。
 * - 攒够 x 条（"我的 → 消息设置"，1–100）还没总结的就自动整理（stores/chat.ts），聊天 ⋯ 里也能手动整理；
 * - 聊天记录每行带编号和时间，模型写明每条记忆来自第几行，程序记下精确的来源消息和发生时间；
 * - 去重时给模型看和这批聊天最相关的旧记忆（向量 → 字面 → 最近的），加上置顶的和到期的；
 * - 写完把新记忆和片段向量化，算出"可能和哪条旧记忆重复"留给整理；和忘掉过的几乎一样的直接丢掉；
 * - 最后几条可能还会重新生成、编辑，先不整理。
 */

/** 最后这几条先不整理 */
const KEEP_RECENT = 4;
/** 给模型看的相关旧记忆最多这么多条 */
const RELATED = 30;
/** 向量相似度到这么高就算"可能重复" */
const DUP_SIM = 0.9;
/** 和忘掉过的记忆相似到这么高就不再记 */
const FORGOTTEN_SIM = 0.92;

export interface SummaryOutcome {
  text: string;
  memories: string[];
  slices: number;
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

const norm = (s: string) => s.replace(/[\s\p{P}]/gu, '');

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += (a[i] as number) * (b[i] as number);
  return s;
}

/** 和这批聊天最相关的旧记忆：先按意思（向量），向量化不可用时按字面，都没有时取最近的 */
async function relatedMemories(characterId: string, transcript: string, signal?: AbortSignal): Promise<Memory[]> {
  const ai = useAiStore();
  const mem = useMemoryStore();
  const active = mem.activeOf(characterId);
  if (!active.length) return [];
  let picked: Memory[] = [];
  if (ai.isLive('embedding')) {
    try {
      const r = await ai.system.embed([transcript.slice(0, 2000)], { purpose: 'query', signal });
      const q = r.vectors[0];
      if (q) {
        const space = { model: r.model, dims: q.length };
        picked = active
          .map((m) => ({ m, v: mem.vectorOf(memKey(m.id), space) }))
          .filter((x): x is { m: Memory; v: Float32Array } => !!x.v)
          .map((x) => ({ m: x.m, s: dot(q, x.v) }))
          .sort((a, b) => b.s - a.s)
          .slice(0, RELATED)
          .map((x) => x.m);
      }
    } catch (e) {
      if (isAbortError(e) && signal?.aborted) throw e;
    }
  }
  if (!picked.length) {
    const allow = new Set(active.map((m) => memKey(m.id)));
    const byKey = new Map(active.map((m) => [memKey(m.id), m]));
    picked = mem.lexical
      .search(transcript, RELATED, allow)
      .map((h) => byKey.get(h.key))
      .filter((m): m is Memory => !!m);
  }
  if (!picked.length) picked = [...active].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 40);
  return picked;
}

/** 新写的记忆和片段向量化；标出可能重复的，和忘掉过的几乎一样的丢掉 */
async function embedNew(characterId: string, memoryIds: string[], sliceIds: string[]) {
  const ai = useAiStore();
  if (!ai.isLive('embedding') || (!memoryIds.length && !sliceIds.length)) return;
  const mem = useMemoryStore();
  const items = [
    ...memoryIds.map((id) => ({ kind: 'memory' as const, id, text: mem.memoryById(id)?.content ?? '' })),
    ...sliceIds.map((id) => {
      const s = mem.slices.find((x) => x.id === id);
      return { kind: 'slice' as const, id, text: s ? sliceText(s) : '' };
    }),
  ].filter((x) => x.text);
  if (!items.length) return;
  try {
    const r = await ai.system.embed(items.map((x) => x.text), { purpose: 'document' });
    items.forEach((x, i) => {
      const v = r.vectors[i];
      if (v) mem.setVector(x.kind, x.id, v, r.model);
    });
    const space = { model: r.model, dims: r.dims };
    const fresh = new Set(memoryIds);
    const forgotten = mem.forgottenOf(characterId);
    for (const id of memoryIds) {
      const v = mem.vectorOf(memKey(id), space);
      if (!v) continue;
      const gone = forgotten.find((f) => {
        const fv = f.vector?.data ? mem.vectorOf(memKey(f.id), space) : null;
        return fv && dot(v, fv) >= FORGOTTEN_SIM;
      });
      if (gone) {
        mem.forgetMemory(id);
        continue;
      }
      let best: { id: string; s: number } | null = null;
      for (const m of mem.activeOf(characterId)) {
        if (m.id === id || fresh.has(m.id)) continue;
        const mv = mem.vectorOf(memKey(m.id), space);
        if (!mv) continue;
        const s = dot(v, mv);
        if (s >= DUP_SIM && (!best || s > best.s)) best = { id: m.id, s };
      }
      if (best) mem.updateMemory(id, { dupOf: best.id });
    }
  } catch {
    // 向量化失败：之后"重算向量"或下次整理时补上
  }
}

/** 整理一段；没有要整理的返回 null。chat 要传聊天 store 里的那个对象（结果直接写在上面） */
export async function summarizeChat(chat: Chat, list: Message[], opts: { signal?: AbortSignal } = {}): Promise<SummaryOutcome | null> {
  const ai = useAiStore();
  const chars = useCharacterStore();
  const mem = useMemoryStore();
  const c = chars.byId(chat.characterId);
  if (!c) throw new AiError('no_route', '找不到这个角色');
  if (!ai.isLive('summary')) throw new AiError('no_route', '"总结 / 记忆"还没接通 API：在"我的 → API 设置"里设置（默认跟随主对话）');
  const preset = useLibraryStore().presetForUse('summary', c);
  if (!preset) throw new MissingPresetError('总结');
  const every = useMessageSettingsStore().summaryEvery();
  const batch = pendingForSummary(chat, list).slice(0, every);
  if (!batch.length) return null;

  const persona = personaOf(chat);
  const timeZone = useEnvironmentStore().settings.timezone;
  const who = (m: Message) => (m.role === 'user' ? persona.name : m.role === 'assistant' ? c.name : '旁白');
  const rows = batch.map((m) => ({ m, text: messageToText(m, c, persona.name) })).filter((x) => x.text);
  if (!rows.length) {
    chat.summaryUntilMessageId = (batch.at(-1) as Message).id;
    return null;
  }
  const lines: SummaryLine[] = rows.map((x, i) => ({ n: i + 1, at: x.m.createdAt, who: who(x.m), text: x.text }));
  const transcript = lines.map((l) => `${l.who}: ${l.text}`).join('\n');
  const now = Date.now();
  const related = await relatedMemories(c.id, transcript, opts.signal);
  const shown = [...new Map([...alwaysOn(c.id, now), ...related].map((m) => [m.id, m])).values()].slice(0, 50);
  const previous = mem.timelineOf(chat.id).at(-1)?.text;
  const sampler = samplerRequest(preset.sampler);
  const { value, result } = await ai.system.json(
    'summary',
    {
      messages: buildSummaryMessages(
        {
          character: { name: c.name, pronoun: c.pronoun },
          user: { name: persona.name },
          previousSummary: previous,
          memories: shown.map((m) => ({ id: m.id, content: m.content, at: m.happenedAt })),
          lines,
          now: new Date(now),
          timeZone,
        },
        preset,
      ),
      ...sampler,
      // 片段和来源行让输出变长：本机那份预设没改过上限时至少给 4000
      maxTokens: Math.max(sampler.maxTokens ?? 0, 4000),
    },
    (v) => parseSummary(v, new Set(shown.map((m) => m.id)), lines.length),
    { signal: opts.signal },
  );

  const first = batch[0] as Message;
  const last = batch.at(-1) as Message;
  const msgAt = (n: number) => rows[Math.min(rows.length, Math.max(1, n)) - 1]?.m as Message;
  chat.summaryUntilMessageId = last.id;
  mem.addSummary({ id: uid('sum'), chatId: chat.id, level: 0, fromMessageId: first.id, toMessageId: last.id, fromAt: first.createdAt, toAt: last.createdAt, text: value.summary, mergedInto: null, createdAt: now, updatedAt: now });

  const sliceIds: string[] = [];
  for (const d of value.slices) {
    const a = msgAt(d.from);
    const b = msgAt(d.to);
    const s = mem.addSlice({
      id: uid('slice'),
      characterId: c.id,
      chatId: chat.id,
      title: d.title,
      text: d.text,
      fromMessageId: a.id,
      toMessageId: b.id,
      startAt: a.createdAt,
      endAt: b.createdAt,
      tags: { mood: d.mood, special: d.special, important: d.important },
      vector: null,
      lastRecalledAt: null,
      recallCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    sliceIds.push(s.id);
  }

  const forgotten = new Set(mem.forgottenOf(c.id).map((m) => norm(m.content)));
  const memoryIds: string[] = [];
  const written: string[] = [];
  for (const d of value.memories) {
    if (forgotten.has(norm(d.content))) continue;
    const sources = d.lines.length ? d.lines.map((n) => msgAt(n)) : rows.map((r) => r.m);
    const id = uid('mem');
    for (const old of d.supersedes) mem.updateMemory(old, { status: 'superseded', supersededBy: id });
    mem.addMemory({
      id,
      characterId: c.id,
      chatId: chat.id,
      type: d.type,
      content: d.content,
      importance: d.importance,
      pinned: false,
      status: 'active',
      dueAt: d.dueAt,
      sourceMessageIds: [...new Set(sources.map((m) => m.id))],
      happenedAt: Math.min(...sources.map((m) => m.createdAt)),
      vector: null,
      lastRecalledAt: null,
      recallCount: 0,
      entities: d.entities,
      createdAt: now,
      updatedAt: now,
    });
    memoryIds.push(id);
    written.push(d.content);
  }
  void embedNew(c.id, memoryIds, sliceIds);

  const rel = value.relationship;
  if (rel.affectionDelta) chars.bumpAffection(c.id, rel.affectionDelta);
  if (rel.mood) c.relationship.mood = rel.mood;
  if (rel.nicknames.user) c.relationship.userNickname = rel.nicknames.user;
  if (rel.nicknames.char) c.relationship.charNickname = rel.nicknames.char;
  return { text: value.summary, memories: written, slices: sliceIds.length, affectionDelta: rel.affectionDelta, covered: batch.length, model: result.model, presetName: preset.name };
}

export interface BackfillProgress {
  /** 已经整理了几批 */
  done: number;
  /** 还剩多少条没整理 */
  remaining: number;
}

/**
 * 补整理已有的长聊天：从上次整理到的位置往后，一批一批（每批 x 条）整理，直到剩下的不够一批。
 * signal 取消就停（暂停）；下次从停下的地方接着来
 */
export async function backfillChat(chat: Chat, listOf: () => Message[], onProgress: (p: BackfillProgress) => void, signal: AbortSignal): Promise<BackfillProgress> {
  const every = () => useMessageSettingsStore().summaryEvery();
  let done = 0;
  for (;;) {
    const pending = pendingForSummary(chat, listOf());
    onProgress({ done, remaining: pending.length });
    if (signal.aborted || pending.length < every()) return { done, remaining: pending.length };
    const r = await summarizeChat(chat, listOf(), { signal });
    if (!r) return { done, remaining: pendingForSummary(chat, listOf()).length };
    done += 1;
  }
}
