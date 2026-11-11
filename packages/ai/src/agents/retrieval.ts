import { estimateTokens, type Memory, type MemoryScoreWeights } from '@app/shared';
import { cosine, decodeVector, sameSpace } from '../embedding/vector.ts';

/**
 * 记忆检索（设计文档 §6.1，检索智能体，在本机跑）：
 *   score = w₁·相似度 + w₂·e^(−天数/半衰期) + w₃·重要度/10
 * - 必带：置顶的记忆、到期的待跟进；
 * - 其余按分数取前 K 条，总长不超过记忆的 token 预算；
 * - 只用和查询向量同一个向量空间的记忆算相似度（换了模型、还没重算的记忆相似度记 0，靠新近度和重要度排）。
 */

export const DEFAULT_WEIGHTS: MemoryScoreWeights = { similarity: 0.6, recency: 0.2, importance: 0.2, halfLifeDays: 30 };

export interface RankInput {
  memories: Memory[];
  /** 查询向量（已单位化）及其空间；向量化不可用时为 null，只按新近度和重要度排 */
  query: { vector: Float32Array; model: string; dims: number } | null;
  now: number;
  weights?: MemoryScoreWeights;
  topK?: number;
  /** 记忆部分最多多少 token */
  tokenBudget?: number;
  /**
   * 相似度下限（SillyTavern 向量存储的 score_threshold，默认 0.25）：有查询向量时，低于它的记忆不进 Top-K；
   * 置顶和到期的待跟进照样必带。不给就不限
   */
  minSimilarity?: number;
  countTokens?: (text: string) => number;
}

export interface RankedMemory {
  memory: Memory;
  score: number;
  /** 没有可比较的向量时为 null */
  similarity: number | null;
  reason: 'pinned' | 'due' | 'score';
}

const DAY = 86_400_000;

export function scoreMemory(m: Memory, sim: number | null, now: number, w: MemoryScoreWeights): number {
  const at = m.happenedAt ?? m.createdAt;
  const days = Math.max(0, (now - at) / DAY);
  const recency = Math.exp(-days / Math.max(1, w.halfLifeDays));
  return w.similarity * (sim ?? 0) + w.recency * recency + w.importance * (Math.min(10, Math.max(0, m.importance)) / 10);
}

export function rankMemories(input: RankInput): RankedMemory[] {
  const w = input.weights ?? DEFAULT_WEIGHTS;
  const count = input.countTokens ?? estimateTokens;
  const q = input.query;
  const active = input.memories.filter((m) => m.status === 'active' && !m.deleted);
  const scored: RankedMemory[] = active.map((m) => {
    let sim: number | null = null;
    if (q && m.vector?.data && sameSpace(m.vector, q)) {
      const v = decodeVector(m.vector.data);
      if (v.length === q.vector.length) sim = cosine(q.vector, v);
    }
    const due = m.type === 'followup' && m.dueAt !== null && m.dueAt <= input.now;
    const reason: RankedMemory['reason'] = m.pinned ? 'pinned' : due ? 'due' : 'score';
    return { memory: m, score: scoreMemory(m, sim, input.now, w), similarity: sim, reason };
  });
  const must = scored.filter((r) => r.reason !== 'score').sort((a, b) => b.score - a.score);
  const floor = input.minSimilarity;
  const rest = scored
    .filter((r) => r.reason === 'score')
    .filter((r) => floor === undefined || r.similarity === null || r.similarity >= floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, input.topK ?? 8);
  const out: RankedMemory[] = [...must];
  let used = must.reduce((n, r) => n + count(r.memory.content), 0);
  for (const r of rest) {
    const t = count(r.memory.content);
    if (input.tokenBudget !== undefined && used + t > input.tokenBudget) continue;
    used += t;
    out.push(r);
  }
  return out;
}

/** 需要重算向量的记忆：没有向量，或不在当前的向量空间里 */
export function staleMemories(memories: Memory[], space: { model: string; dims: number } | null): Memory[] {
  return memories.filter((m) => m.status !== 'superseded' && !m.deleted && (!m.vector?.data || (space !== null && !sameSpace(m.vector, space))));
}
