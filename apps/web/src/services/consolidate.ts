import { AiError, runConsolidation } from '@app/ai';
import type { MemoryConsolidationContext, MemoryOp, Memory } from '@app/shared';
import { getOne, write } from '@/db/idb';
import { useAiStore } from '@/stores/ai';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useEnvironmentStore } from '@/stores/environment';
import { useLibraryStore } from '@/stores/library';
import { useMemoryStore } from '@/stores/memory';
import { personaOf } from './prompt';

/**
 * 记忆整理（"记忆整理"的 API 和"整理"预设）：
 * - 打包：可能重复的几组记忆（写入时按向量标出的 dupOf）、时间线该合并的组、过期的待跟进、画像卡和上次整理后新记下的事；
 * - 跑：每天凌晨 4 点在 Cloudflare 上跑（stores/hub.ts 上传、拉结果），也能在记忆本里"立即整理"（这里直接跑）；
 * - 应用：每一处修改都对照打包时的内容，你在手机上改过的跳过；被合并、改过的记忆重新向量化。
 * 不设每日上限。
 */

const DAY = 86_400_000;
const MAX_GROUPS = 20;
const MAX_NEW = 40;
/** 过了到期时间这么久还没问到的待跟进，交给整理改时态 */
const TENSE_AFTER = 6 * 3_600_000;

let lastRunCache: Record<string, number> | null = null;

async function lastRuns(): Promise<Record<string, number>> {
  if (!lastRunCache) {
    const saved = await getOne<Record<string, number>>('settings', 'memoryConsolidatedAt');
    lastRunCache = saved && typeof saved === 'object' ? { ...saved } : {};
  }
  return lastRunCache;
}

async function setLastRun(characterId: string, at: number) {
  const runs = await lastRuns();
  runs[characterId] = Math.max(runs[characterId] ?? 0, at);
  await write('settings', [{ key: 'memoryConsolidatedAt', value: { ...runs } }]);
}

/** 上次整理（本机或云端结果应用）的时间 */
export async function lastConsolidatedAt(characterId: string): Promise<number> {
  return (await lastRuns())[characterId] ?? 0;
}

/** 把写入时标出的"可能重复"连成组（A 像 B、B 像 C → 一组） */
function duplicateGroups(active: Memory[]): Memory[][] {
  const byId = new Map(active.map((m) => [m.id, m]));
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) && parent.get(r) !== r) r = parent.get(r) as string;
    parent.set(x, r);
    return r;
  };
  const members = new Set<string>();
  for (const m of active) {
    if (!m.dupOf || !byId.has(m.dupOf)) continue;
    members.add(m.id);
    members.add(m.dupOf);
    const a = find(m.id);
    const b = find(m.dupOf);
    if (a !== b) parent.set(a, b);
  }
  const groups = new Map<string, Memory[]>();
  for (const id of members) {
    const r = find(id);
    groups.set(r, [...(groups.get(r) ?? []), byId.get(id) as Memory]);
  }
  return [...groups.values()].filter((g) => g.length >= 2);
}

/** 打包这个角色这次要整理的东西；没有要做的返回 null */
export async function packConsolidation(characterId: string, now = Date.now()): Promise<MemoryConsolidationContext | null> {
  const c = useCharacterStore().byId(characterId);
  if (!c) return null;
  const mem = useMemoryStore();
  const chat = useChatStore().chatOfCharacter(characterId);
  const active = mem.activeOf(characterId);
  const since = (await lastConsolidatedAt(characterId)) || now - 7 * DAY;

  const mergeGroups = duplicateGroups(active)
    .slice(0, MAX_GROUPS)
    .map((g, i) => ({ group: `g${i + 1}`, items: g.map((m) => ({ id: m.id, type: m.type, content: m.content, at: m.happenedAt, importance: m.importance })) }));
  const rollups = chat
    ? mem.pendingRollups(chat.id).map((g) => ({ ids: g.map((s) => s.id), segments: g.map((s) => ({ text: s.text, fromAt: s.fromAt, toAt: s.toAt })) }))
    : [];
  const followups = active
    .filter((m) => m.type === 'followup' && m.dueAt !== null && m.dueAt < now - TENSE_AFTER && m.dueAt > now - 60 * DAY)
    .map((m) => ({ id: m.id, content: m.content, dueAt: m.dueAt as number }));
  const newMemories = active
    .filter((m) => m.createdAt > since)
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-MAX_NEW)
    .map((m) => ({ content: m.content, type: m.type, at: m.happenedAt }));
  if (!mergeGroups.length && !rollups.length && !followups.length && !newMemories.length) return null;
  const profile = mem.profileOf(characterId);
  return {
    characterId,
    chatId: chat?.id ?? null,
    character: { name: c.name, pronoun: c.pronoun },
    userName: personaOf(chat).name,
    timezone: useEnvironmentStore().settings.timezone,
    preset: useLibraryStore().presetForUse('consolidate', c) ?? null,
    packedAt: now,
    mergeGroups,
    rollups,
    followups,
    profile: { lines: (profile?.lines ?? []).map(({ id, section, text }) => ({ id, section, text })), updatedAt: profile?.updatedAt ?? 0 },
    newMemories,
  };
}

/** 很久没用到的小事归档（不删，记忆本里可以恢复） */
function archiveStale(characterId: string, now: number): number {
  const mem = useMemoryStore();
  let n = 0;
  for (const m of mem.activeOf(characterId)) {
    const at = m.happenedAt ?? m.createdAt;
    if (!m.pinned && m.importance <= 3 && m.recallCount === 0 && (m.type === 'event' || m.type === 'emotion') && now - at > 120 * DAY) {
      mem.updateMemory(m.id, { status: 'archived' });
      n += 1;
    }
  }
  return n;
}

export interface ApplyResult {
  applied: number;
  skipped: number;
  archived: number;
}

/** 应用整理的结果；打包之后你改过的那一处跳过 */
export async function applyMemoryOps(ctx: MemoryConsolidationContext, ops: MemoryOp[]): Promise<ApplyResult> {
  const mem = useMemoryStore();
  const now = Date.now();
  const packed = new Map<string, string>();
  for (const g of ctx.mergeGroups) for (const m of g.items) packed.set(m.id, m.content);
  for (const f of ctx.followups) packed.set(f.id, f.content);
  /** 还是打包时的样子：在用、没被忘掉、内容没变 */
  const intact = (id: string) => {
    const m = mem.memoryById(id);
    return !!m && !m.deleted && m.status === 'active' && packed.get(id) === m.content;
  };
  const reembed: string[] = [];
  let applied = 0;
  let skipped = 0;
  const merged = new Set<string>();
  /** 模型判断过是重复的（不管这次合没合成） */
  const judgedDup = new Set(ops.flatMap((op) => (op.op === 'merge' ? op.ids : [])));
  for (const op of ops) {
    if (op.op === 'merge') {
      if (!op.ids.every(intact)) {
        skipped += 1;
        continue;
      }
      const group = op.ids.map((id) => mem.memoryById(id) as Memory);
      const keep = [...group].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.importance - a.importance || b.updatedAt - a.updatedAt)[0] as Memory;
      mem.updateMemory(keep.id, {
        content: op.content,
        type: op.type ?? keep.type,
        importance: op.importance ?? Math.max(...group.map((m) => m.importance)),
        sourceMessageIds: [...new Set(group.flatMap((m) => m.sourceMessageIds))],
        happenedAt: Math.min(...group.map((m) => m.happenedAt ?? m.createdAt)),
        recallCount: group.reduce((n, m) => n + m.recallCount, 0),
        pinned: group.some((m) => m.pinned),
        dupOf: null,
        vector: null,
      });
      for (const m of group) if (m.id !== keep.id) mem.updateMemory(m.id, { status: 'superseded', supersededBy: keep.id, dupOf: null });
      group.forEach((m) => merged.add(m.id));
      reembed.push(keep.id);
      applied += 1;
    } else if (op.op === 'rollup') {
      const group = op.ids.map((id) => mem.summaries.find((s) => s.id === id));
      if (group.some((s) => !s || s.deleted || s.mergedInto)) {
        skipped += 1;
        continue;
      }
      mem.rollup(group as NonNullable<(typeof group)[number]>[], op.text);
      applied += 1;
    } else if (op.op === 'tense') {
      if (!intact(op.id)) {
        skipped += 1;
        continue;
      }
      mem.updateMemory(op.id, { content: op.content, type: op.type, dueAt: op.dueAt, vector: null });
      reembed.push(op.id);
      applied += 1;
    } else if (op.op === 'profile') {
      const profile = mem.profileOf(ctx.characterId);
      if ((profile?.updatedAt ?? 0) > ctx.profile.updatedAt) {
        skipped += 1;
        continue;
      }
      for (const p of op.ops) {
        if (p.op === 'add') mem.addProfileLine(ctx.characterId, p.section, p.text);
        else if (p.op === 'edit') mem.editProfileLine(ctx.characterId, p.id, { text: p.text, ...(p.section ? { section: p.section } : {}) });
        else mem.removeProfileLine(ctx.characterId, p.id);
      }
      applied += 1;
    }
  }
  // 模型判断不是重复的：去掉"可能重复"的标记，不再送去整理（判断是重复、但因为你改过而跳过的留着，下次再合并）
  for (const g of ctx.mergeGroups) {
    for (const item of g.items) {
      if (!merged.has(item.id) && !judgedDup.has(item.id) && intact(item.id) && mem.memoryById(item.id)?.dupOf) mem.updateMemory(item.id, { dupOf: null });
    }
  }
  const archived = archiveStale(ctx.characterId, now);
  await setLastRun(ctx.characterId, ctx.packedAt);
  if (reembed.length) void reembedMemories(reembed);
  return { applied, skipped, archived };
}

async function reembedMemories(ids: string[]) {
  const ai = useAiStore();
  if (!ai.isLive('embedding')) return;
  const mem = useMemoryStore();
  const items = ids.map((id) => mem.memoryById(id)).filter((m): m is Memory => !!m && !m.deleted);
  if (!items.length) return;
  try {
    const r = await ai.system.embed(items.map((m) => m.content), { purpose: 'document' });
    items.forEach((m, i) => {
      const v = r.vectors[i];
      if (v) mem.setVector('memory', m.id, v, r.model);
    });
  } catch {
    // 之后"重算向量"补上
  }
}

export interface ConsolidateOutcome extends ApplyResult {
  errors: string[];
  /** 没有要整理的 */
  nothing: boolean;
}

/** 立即整理（记忆本里的按钮，或没连云端时每天打开 App 自动跑一次）：在手机上用"记忆整理"的 API 跑 */
export async function consolidateNow(characterId: string, signal?: AbortSignal): Promise<ConsolidateOutcome> {
  const ai = useAiStore();
  if (!ai.isLive('consolidate')) throw new AiError('no_route', '"记忆整理"还没接通 API：在"我的 → API 设置"里设置（默认跟随主对话）');
  const ctx = await packConsolidation(characterId);
  if (!ctx) {
    const archived = archiveStale(characterId, Date.now());
    return { applied: 0, skipped: 0, archived, errors: [], nothing: true };
  }
  if (!ctx.preset) throw new AiError('no_route', '没有"整理"预设：在"我的 → 预设 → 总结"里给"记忆整理"选一个');
  const { ops, errors } = await runConsolidation(ai.system, ctx, { signal });
  const r = await applyMemoryOps(ctx, ops);
  return { ...r, errors, nothing: false };
}

let autoRunning = false;

/**
 * 没连 Cloudflare 时的补充：打开 App 后，距上次整理超过 20 小时的角色在后台整理一次（一个一个来）。
 * 连了云端时由云端凌晨 4 点整理，这里不跑
 */
export async function maybeAutoConsolidate(cloudConnected: boolean) {
  if (cloudConnected || autoRunning || !useAiStore().isLive('consolidate')) return;
  autoRunning = true;
  try {
    const now = Date.now();
    for (const c of useCharacterStore().list) {
      if (now - (await lastConsolidatedAt(c.id)) < 20 * 3_600_000) continue;
      try {
        await consolidateNow(c.id);
      } catch {
        // 失败的下次打开 App 再试；报错在"API 设置 → 记忆整理"
      }
    }
  } finally {
    autoRunning = false;
  }
}
