import { decodeVector, encodeVector, LexicalIndex, sameSpace, type RecallCandidate } from '@app/ai';
import type { Chat, ChapterSummary, Memory, MemoryProfile, MemorySlice, MemoryVector, Message, ProfileLine } from '@app/shared';
import { defineStore } from 'pinia';
import { markRaw, ref } from 'vue';
import { getAll, getOne, write, type StoreName } from '@/db/idb';
import { memories as demoMemories } from '@/mock/memories';
import { uid } from '@/utils/id';

/**
 * 记忆（设计文档 §6）：事实记忆、故事片段、时间线、画像卡，存在本机数据库的四张表里，刷新、离线后还在。
 * - 按条写入：改了哪条就只写哪条（记脏），不对整张表做 JSON 比较；
 * - 向量（float16 base64）读库时解码进内存，同一个向量空间里才比较；字面索引（单字 + 两字）也建在内存里；
 * - "忘掉这件事"留一条墓碑（deleted），之后总结写出几乎一样的记忆时丢掉，不会再记回来。
 */

type Table = 'memories' | 'slices' | 'summaries' | 'profiles';
type Space = { model: string; dims: number };

export const memKey = (id: string) => `m:${id}`;
export const sliceKey = (id: string) => `s:${id}`;

/** 片段在字面索引和提示词里的文字 */
export function sliceText(s: Pick<MemorySlice, 'title' | 'text'>): string {
  return s.text && s.text !== s.title ? `${s.title}：${s.text}` : s.title;
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

export const useMemoryStore = defineStore('memory', () => {
  const memories = ref<Memory[]>([]);
  const slices = ref<MemorySlice[]>([]);
  const summaries = ref<ChapterSummary[]>([]);
  const profiles = ref<MemoryProfile[]>([]);
  /** 读完库了 */
  const ready = ref(false);

  /** 解码好的向量（键 m:id / s:id）和它所在的向量空间；不放进响应式 */
  const vectors = markRaw(new Map<string, { v: Float32Array; model: string; dims: number }>());
  const lexical = markRaw(new LexicalIndex());
  const dirty: Record<Table, Set<string>> = { memories: new Set(), slices: new Set(), summaries: new Set(), profiles: new Set() };
  let timer: ReturnType<typeof setTimeout> | undefined;

  function indexMemory(m: Memory) {
    const key = memKey(m.id);
    if (m.deleted || m.status !== 'active') {
      lexical.remove(key);
      vectors.delete(key);
      return;
    }
    lexical.add(key, [m.content, ...(m.entities ?? [])].join(' '));
    cacheVector(key, m.vector);
  }

  function indexSlice(s: MemorySlice) {
    const key = sliceKey(s.id);
    if (s.deleted) {
      lexical.remove(key);
      vectors.delete(key);
      return;
    }
    lexical.add(key, [sliceText(s), ...s.tags.special].join(' '));
    cacheVector(key, s.vector);
  }

  function cacheVector(key: string, vec: MemoryVector | null) {
    if (!vec?.data) {
      vectors.delete(key);
      return;
    }
    const cur = vectors.get(key);
    if (cur && cur.model === vec.model && cur.dims === vec.dims) return;
    try {
      vectors.set(key, { v: decodeVector(vec.data), model: vec.model, dims: vec.dims });
    } catch {
      vectors.delete(key);
    }
  }

  async function hydrate() {
    const [ms, ss, cs, ps, seeded] = await Promise.all([
      getAll<Memory>('memories'),
      getAll<MemorySlice>('slices'),
      getAll<ChapterSummary>('summaries'),
      getAll<MemoryProfile>('profiles'),
      getOne<boolean>('settings', 'memorySeeded'),
    ]);
    memories.value = ms;
    slices.value = ss;
    summaries.value = cs;
    profiles.value = ps;
    // 第一次运行：演示角色的记忆放进库里（以后和别的记忆一样能改能删）
    if (!seeded) {
      const have = new Set(ms.map((m) => m.id));
      const add = demoMemories.filter((m) => !have.has(m.id)).map((m) => ({ ...clone(m), vector: m.vector?.data ? m.vector : null }));
      memories.value.push(...add);
      add.forEach((m) => dirty.memories.add(m.id));
      await write('settings', [{ key: 'memorySeeded', value: true }]);
    }
    for (const m of memories.value) indexMemory(m);
    for (const s of slices.value) indexSlice(s);
    ready.value = true;
    scheduleSave();
  }

  /** 把记脏的记录写进库（防抖） */
  function scheduleSave(wait = 300) {
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), wait);
  }

  async function flush() {
    clearTimeout(timer);
    const lists: Record<Table, { id: string }[]> = { memories: memories.value, slices: slices.value, summaries: summaries.value, profiles: profiles.value };
    await Promise.all(
      (Object.keys(dirty) as Table[]).map(async (t) => {
        const ids = [...dirty[t]];
        if (!ids.length) return;
        dirty[t].clear();
        const byId = new Map(lists[t].map((r) => [r.id, r]));
        const puts = ids.filter((id) => byId.has(id)).map((id) => ({ key: id, value: clone(byId.get(id)) }));
        const dels = ids.filter((id) => !byId.has(id));
        await write(t as StoreName, puts, dels);
      }),
    );
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && void flush());
    window.addEventListener('pagehide', () => void flush());
  }

  function touch(t: Table, id: string) {
    dirty[t].add(id);
    scheduleSave();
  }

  // —— 事实记忆 ——

  function memoryById(id: string): Memory | undefined {
    return memories.value.find((m) => m.id === id);
  }

  /** 这个角色的记忆（不含忘掉的） */
  function memoriesOf(characterId: string): Memory[] {
    return memories.value.filter((m) => m.characterId === characterId && !m.deleted);
  }

  function activeOf(characterId: string): Memory[] {
    return memoriesOf(characterId).filter((m) => m.status === 'active');
  }

  function addMemory(m: Memory): Memory {
    memories.value.push(m);
    const saved = memories.value.at(-1) as Memory;
    indexMemory(saved);
    touch('memories', m.id);
    return saved;
  }

  function updateMemory(id: string, patch: Partial<Memory>): Memory | undefined {
    const m = memoryById(id);
    if (!m) return undefined;
    Object.assign(m, patch, { updatedAt: Date.now() });
    indexMemory(m);
    touch('memories', id);
    return m;
  }

  /** 忘掉这件事：留墓碑，之后的总结写出几乎一样的记忆时丢掉 */
  function forgetMemory(id: string) {
    updateMemory(id, { deleted: true, pinned: false });
  }

  /** 忘掉过的记忆（总结时用来排除） */
  function forgottenOf(characterId: string): Memory[] {
    return memories.value.filter((m) => m.characterId === characterId && m.deleted);
  }

  // —— 故事片段 ——

  function slicesOf(characterId: string): MemorySlice[] {
    return slices.value.filter((s) => s.characterId === characterId && !s.deleted);
  }

  function addSlice(s: MemorySlice): MemorySlice {
    slices.value.push(s);
    const saved = slices.value.at(-1) as MemorySlice;
    indexSlice(saved);
    touch('slices', s.id);
    return saved;
  }

  function updateSlice(id: string, patch: Partial<MemorySlice>): MemorySlice | undefined {
    const s = slices.value.find((x) => x.id === id);
    if (!s) return undefined;
    Object.assign(s, patch, { updatedAt: Date.now() });
    indexSlice(s);
    touch('slices', id);
    return s;
  }

  function removeSlice(id: string) {
    updateSlice(id, { deleted: true });
  }

  // —— 时间线 ——

  function summariesOf(chatId: string): ChapterSummary[] {
    return summaries.value.filter((s) => s.chatId === chatId && !s.deleted).sort((a, b) => a.fromAt - b.fromAt || a.level - b.level);
  }

  /** 时间线：各层还没合并的段，从旧到新（正好覆盖全部历史，越早越粗） */
  function timelineOf(chatId: string): ChapterSummary[] {
    return summariesOf(chatId).filter((s) => !s.mergedInto);
  }

  /** 该合并的组：同一层最早的 4 段还没合并（四进制进位，从低层往高层） */
  function pendingRollups(chatId: string): ChapterSummary[][] {
    const open = timelineOf(chatId);
    const out: ChapterSummary[][] = [];
    const levels = [...new Set(open.map((s) => s.level))].sort((a, b) => a - b);
    for (const level of levels) {
      const same = open.filter((s) => s.level === level);
      for (let i = 0; i + 4 <= same.length; i += 4) out.push(same.slice(i, i + 4));
    }
    return out;
  }

  function addSummary(s: ChapterSummary): ChapterSummary {
    summaries.value.push(s);
    touch('summaries', s.id);
    return summaries.value.at(-1) as ChapterSummary;
  }

  /** 把一组段合并成上一层的一段 */
  function rollup(group: ChapterSummary[], text: string): ChapterSummary | undefined {
    if (group.length < 2) return undefined;
    const first = group[0] as ChapterSummary;
    const last = group.at(-1) as ChapterSummary;
    const now = Date.now();
    const parent = addSummary({
      id: uid('sum'),
      chatId: first.chatId,
      level: first.level + 1,
      fromMessageId: first.fromMessageId,
      toMessageId: last.toMessageId,
      fromAt: first.fromAt,
      toAt: last.toAt,
      text,
      mergedInto: null,
      createdAt: now,
      updatedAt: now,
    });
    for (const s of group) {
      const own = summaries.value.find((x) => x.id === s.id);
      if (!own) continue;
      own.mergedInto = parent.id;
      own.updatedAt = now;
      touch('summaries', own.id);
    }
    return parent;
  }

  /** 以前写在聊天上的摘要（chat.summaries）搬进时间线，搬完从聊天上去掉 */
  function migrateChatSummaries(chats: Chat[], listOf: (chatId: string) => Message[]) {
    for (const chat of chats) {
      const old = chat.summaries;
      if (!old?.length) continue;
      if (!summariesOf(chat.id).length) {
        const msgs = listOf(chat.id);
        const timeOf = (id: string, fallback: number) => msgs.find((m) => m.id === id)?.createdAt ?? fallback;
        for (const s of old) {
          addSummary({
            id: uid('sum'),
            chatId: chat.id,
            level: 0,
            fromMessageId: s.fromMessageId,
            toMessageId: s.toMessageId,
            fromAt: timeOf(s.fromMessageId, s.at),
            toAt: timeOf(s.toMessageId, s.at),
            text: s.text,
            mergedInto: null,
            createdAt: s.at,
            updatedAt: s.at,
          });
        }
      }
      delete chat.summaries;
    }
  }

  // —— 画像卡 ——

  function profileOf(characterId: string): MemoryProfile | undefined {
    return profiles.value.find((p) => p.characterId === characterId && !p.deleted);
  }

  function ensureProfile(characterId: string): MemoryProfile {
    const have = profileOf(characterId);
    if (have) return have;
    const now = Date.now();
    profiles.value.push({ id: characterId, characterId, lines: [], createdAt: now, updatedAt: now });
    touch('profiles', characterId);
    return profiles.value.at(-1) as MemoryProfile;
  }

  function setProfileLines(characterId: string, lines: ProfileLine[]) {
    const p = ensureProfile(characterId);
    p.lines = lines;
    p.updatedAt = Date.now();
    touch('profiles', p.id);
  }

  function addProfileLine(characterId: string, section: string, text: string) {
    const p = ensureProfile(characterId);
    setProfileLines(characterId, [...p.lines, { id: uid('pl'), section: section.trim() || '其他', text: text.trim(), updatedAt: Date.now() }]);
  }

  function editProfileLine(characterId: string, id: string, patch: Partial<Pick<ProfileLine, 'section' | 'text'>>) {
    const p = ensureProfile(characterId);
    setProfileLines(
      characterId,
      p.lines.map((l) => (l.id === id ? { ...l, ...patch, updatedAt: Date.now() } : l)),
    );
  }

  function removeProfileLine(characterId: string, id: string) {
    const p = ensureProfile(characterId);
    setProfileLines(characterId, p.lines.filter((l) => l.id !== id));
  }

  // —— 向量 ——

  /** 这条记录在这个向量空间里的向量；没有或不在同一空间时为 null */
  function vectorOf(key: string, space: Space | null): Float32Array | null {
    if (!space) return null;
    const hit = vectors.get(key);
    return hit && sameSpace(hit, space) ? hit.v : null;
  }

  function setVector(kind: 'memory' | 'slice', id: string, v: Float32Array, model: string) {
    const vector: MemoryVector = { model, dims: v.length, data: encodeVector(v) };
    if (kind === 'memory') updateMemory(id, { vector });
    else updateSlice(id, { vector });
    vectors.set(kind === 'memory' ? memKey(id) : sliceKey(id), { v, model, dims: v.length });
  }

  /** 要（重新）向量化的：没有向量，或不在当前的向量空间里 */
  function staleVectors(space: Space | null): { kind: 'memory' | 'slice'; id: string; text: string }[] {
    const out: { kind: 'memory' | 'slice'; id: string; text: string }[] = [];
    const stale = (v: MemoryVector | null) => !v?.data || (space !== null && !sameSpace(v, space));
    for (const m of memories.value) if (!m.deleted && m.status !== 'superseded' && stale(m.vector)) out.push({ kind: 'memory', id: m.id, text: m.content });
    for (const s of slices.value) if (!s.deleted && stale(s.vector)) out.push({ kind: 'slice', id: s.id, text: sliceText(s) });
    return out;
  }

  /**
   * 取记忆的候选：这个角色在用的记忆（置顶的不算，它们每次都带）和故事片段。
   * 向量只给同一个向量空间的
   */
  function candidates(characterId: string, space: Space | null): RecallCandidate[] {
    const out: RecallCandidate[] = [];
    for (const m of activeOf(characterId)) {
      if (m.pinned) continue;
      out.push({
        key: memKey(m.id),
        kind: 'memory',
        id: m.id,
        text: m.content,
        at: m.happenedAt ?? m.createdAt,
        importance: m.importance,
        memoryType: m.type,
        entities: m.entities,
        vector: vectorOf(memKey(m.id), space),
      });
    }
    for (const s of slicesOf(characterId)) {
      if (s.stale) continue;
      out.push({
        key: sliceKey(s.id),
        kind: 'slice',
        id: s.id,
        text: sliceText(s),
        at: s.startAt,
        importance: s.tags.important ? 8 : 5,
        tags: s.tags,
        vector: vectorOf(sliceKey(s.id), space),
      });
    }
    return out;
  }

  /** 被带进提示词了：想起过的次数 + 1 */
  function noteRecalled(keys: string[]) {
    const now = Date.now();
    for (const key of keys) {
      const id = key.slice(2);
      if (key.startsWith('m:')) {
        const m = memoryById(id);
        if (m) {
          m.recallCount += 1;
          m.lastRecalledAt = now;
          touch('memories', id);
        }
      } else {
        const s = slices.value.find((x) => x.id === id);
        if (s) {
          s.recallCount += 1;
          s.lastRecalledAt = now;
          touch('slices', id);
        }
      }
    }
  }

  /**
   * 来源消息被删除或编辑：相关片段标记要重新生成（取记忆时先不用），相关记忆标"来源改过"（记忆本里提示复核）。
   * list 是改之前这条聊天的消息（用来判断片段的起止范围里有没有这些消息）
   */
  function markSourceChanged(chatId: string, messageIds: string[], list: Message[]) {
    const ids = new Set(messageIds);
    if (!ids.size) return;
    for (const m of memories.value) {
      if (!m.deleted && !m.sourceChanged && m.sourceMessageIds.some((id) => ids.has(id))) updateMemory(m.id, { sourceChanged: true });
    }
    const index = new Map(list.map((m, i) => [m.id, i]));
    const changed = [...ids].map((id) => index.get(id)).filter((i): i is number => i !== undefined);
    if (!changed.length) return;
    for (const s of slices.value) {
      if (s.chatId !== chatId || s.deleted || s.stale) continue;
      const a = index.get(s.fromMessageId);
      const b = index.get(s.toMessageId);
      if (a === undefined || b === undefined) continue;
      if (changed.some((i) => i >= a && i <= b)) updateSlice(s.id, { stale: true });
    }
  }

  return {
    memories,
    slices,
    summaries,
    profiles,
    ready,
    lexical,
    hydrate,
    flush,
    memoryById,
    memoriesOf,
    activeOf,
    addMemory,
    updateMemory,
    forgetMemory,
    forgottenOf,
    slicesOf,
    addSlice,
    updateSlice,
    removeSlice,
    summariesOf,
    timelineOf,
    pendingRollups,
    addSummary,
    rollup,
    migrateChatSummaries,
    profileOf,
    ensureProfile,
    setProfileLines,
    addProfileLine,
    editProfileLine,
    removeProfileLine,
    vectorOf,
    setVector,
    staleVectors,
    candidates,
    noteRecalled,
    markSourceChanged,
  };
});
