import type { MemoryType, SliceTags, TimeQuery } from '@app/shared';

/**
 * 取记忆（本机，纯函数）：事实记忆和故事片段一起搜。
 * - 两种搜法：按意思（向量余弦）和按字面（中文拆成单字 + 相邻两字，BM25），两边的名次用 RRF 合并：
 *   score = Σ 1 / (60 + 名次)；再按重要度、按类型的新近度微调；
 * - 分路取，避免全是同一类：时间说法 → 最相关 → 重要 → 今天的特殊日子 → 上下文提到的状态；
 * - 记忆回响：上一轮带过的片段，之后几轮还排在前 50 名就继续带，避免这一轮提到、下一轮就忘。
 */

export interface RecallCandidate {
  /** 'm:<id>' 事实记忆，'s:<id>' 故事片段 */
  key: string;
  kind: 'memory' | 'slice';
  id: string;
  /** 进提示词、按字面搜的文字 */
  text: string;
  /** 发生时间 */
  at: number;
  /** 1–10 */
  importance: number;
  memoryType?: MemoryType;
  tags?: SliceTags;
  entities?: string[];
  /** 已单位化；和查询向量不在同一个向量空间时为 null */
  vector: Float32Array | null;
}

export interface EchoEntry {
  key: string;
  /** 还能回响几轮 */
  life: number;
}

export interface RecallQuotas {
  basic: number;
  important: number;
  special: number;
  state: number;
  time: number;
}

export const DEFAULT_RECALL_QUOTAS: RecallQuotas = { basic: 3, important: 1, special: 1, state: 1, time: 3 };

export type RecallReason = 'time' | 'basic' | 'important' | 'special' | 'state' | 'echo';

export const RECALL_REASON_LABEL: Record<RecallReason, string> = {
  time: '时间说法',
  basic: '最相关',
  important: '重要',
  special: '今天的日子',
  state: '相似的状态',
  echo: '回响',
};

export interface RecallHit {
  key: string;
  kind: 'memory' | 'slice';
  id: string;
  reason: RecallReason;
  /** 合并后的分数（RRF × 重要度 × 新近度） */
  score: number;
  /** 余弦相似度；没有向量时为 null */
  dense: number | null;
  /** BM25 分数；字面没对上时为 null */
  lexical: number | null;
  at: number;
}

export interface RecallInput {
  candidates: RecallCandidate[];
  query: string;
  queryVector: Float32Array | null;
  /** 建在这些候选上的字面索引（键和候选的 key 一致） */
  lexical: LexicalIndex;
  now: number;
  time?: TimeQuery | null;
  /** 今天的特殊日子（todaySpecials） */
  specials?: string[];
  /** 上下文提到的状态（detectStates） */
  states?: string[];
  echo?: EchoEntry[];
  quotas?: Partial<RecallQuotas>;
  /** 最多带几条（含回响），默认 8 */
  maxItems?: number;
  /** 这些条目的文字加起来最多多少 token */
  tokenBudget?: number;
  countTokens?: (text: string) => number;
  /** 只按意思对上的条目，相似度至少要这么多，默认 0.3 */
  minSimilarity?: number;
}

export interface RecallOutput {
  hits: RecallHit[];
  /** 下一轮的回响 */
  echo: EchoEntry[];
}

const RRF_K = 60;
const DAY = 86_400_000;
/** 回响：普通的带 2 轮，重要的带 3 轮；只在合并排名的前 50 名里找 */
const ECHO_LIFE = 2;
const ECHO_LIFE_IMPORTANT = 3;
const ECHO_TOP = 50;

// —— 字面搜索 ——

const TOKEN_RE = /[a-z0-9]+|[㐀-鿿豈-﫿]+/g;
const UNIGRAM_WEIGHT = 0.3;

/**
 * 字面搜索的词：中文每个字（u:）和相邻两个字（b:），英文和数字按整词（w:）。
 * 单字只给 0.3 的权重：中文单字太常见，主要靠两字词对上
 */
export function lexicalTerms(text: string): string[] {
  const out: string[] = [];
  const s = text.normalize('NFKC').toLowerCase();
  for (const m of s.matchAll(TOKEN_RE)) {
    const part = m[0];
    if (/^[a-z0-9]+$/.test(part)) {
      if (part.length >= 2) out.push(`w:${part}`);
      continue;
    }
    const chars = [...part];
    for (let i = 0; i < chars.length; i += 1) {
      out.push(`u:${chars[i]}`);
      if (i + 1 < chars.length) out.push(`b:${chars[i]}${chars[i + 1]}`);
    }
  }
  return out;
}

const termWeight = (t: string) => (t.startsWith('u:') ? UNIGRAM_WEIGHT : 1);

export interface LexicalMatch {
  key: string;
  score: number;
  /** 对上了不常见的两字词或整词（只对上单字、常见词的不算） */
  strong: boolean;
}

/** BM25 的倒排索引（k1 = 1.5，b = 0.75），可以增量加减 */
export class LexicalIndex {
  private readonly postings = new Map<string, Map<string, number>>();
  private readonly lengths = new Map<string, number>();
  private readonly termsOf = new Map<string, string[]>();
  private totalLength = 0;

  get size(): number {
    return this.lengths.size;
  }

  has(key: string): boolean {
    return this.lengths.has(key);
  }

  add(key: string, text: string): void {
    if (this.lengths.has(key)) this.remove(key);
    const terms = lexicalTerms(text);
    const tf = new Map<string, number>();
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [t, n] of tf) {
      let p = this.postings.get(t);
      if (!p) this.postings.set(t, (p = new Map()));
      p.set(key, n);
    }
    this.lengths.set(key, terms.length);
    this.termsOf.set(key, [...tf.keys()]);
    this.totalLength += terms.length;
  }

  remove(key: string): void {
    const terms = this.termsOf.get(key);
    if (!terms) return;
    for (const t of terms) {
      const p = this.postings.get(t);
      p?.delete(key);
      if (p && !p.size) this.postings.delete(t);
    }
    this.totalLength -= this.lengths.get(key) ?? 0;
    this.lengths.delete(key);
    this.termsOf.delete(key);
  }

  clear(): void {
    this.postings.clear();
    this.lengths.clear();
    this.termsOf.clear();
    this.totalLength = 0;
  }

  /** 按 BM25 排名；allow 给了时只在这些键里找 */
  search(query: string, limit = 100, allow?: Set<string>): LexicalMatch[] {
    const n = this.lengths.size;
    if (!n) return [];
    const avg = this.totalLength / n || 1;
    const qTerms = [...new Set(lexicalTerms(query))];
    const scores = new Map<string, { score: number; strong: boolean }>();
    for (const t of qTerms) {
      const p = this.postings.get(t);
      if (!p) continue;
      const df = p.size;
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      // "不常见"：出现在不到四分之一的条目里（条目很少时都算）
      const rare = t[0] !== 'u' && (n < 8 || df / n < 0.25);
      for (const [key, tf] of p) {
        if (allow && !allow.has(key)) continue;
        const len = this.lengths.get(key) ?? avg;
        const s = termWeight(t) * idf * ((tf * 2.5) / (tf + 1.5 * (0.25 + (0.75 * len) / avg)));
        const cur = scores.get(key);
        if (cur) {
          cur.score += s;
          cur.strong ||= rare;
        } else scores.set(key, { score: s, strong: rare });
      }
    }
    return [...scores.entries()]
      .map(([key, v]) => ({ key, score: v.score, strong: v.strong }))
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

// —— 合并排名 ——

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += (a[i] as number) * (b[i] as number);
  return s;
}

/** 新近度：情绪衰减快，事件中等，事实、偏好、关系不衰减（久远不等于不重要） */
function recencyMult(c: RecallCandidate, now: number): number {
  const days = Math.max(0, (now - c.at) / DAY);
  if (c.kind === 'memory' && c.memoryType === 'emotion') return 0.7 + 0.3 * Math.exp(-days / 14);
  if (c.kind === 'memory' && (c.memoryType === 'fact' || c.memoryType === 'preference' || c.memoryType === 'relationship')) return 1;
  return 0.85 + 0.15 * Math.exp(-days / 120);
}

function isImportant(c: RecallCandidate): boolean {
  return c.kind === 'slice' ? !!c.tags?.important : c.importance >= 8;
}

/** 片段的标签和要找的标签对得上（互相包含就算：标签"生日"对"她的生日"） */
function tagMatch(tags: readonly string[] | undefined, wanted: readonly string[]): boolean {
  if (!tags?.length || !wanted.length) return false;
  return tags.some((t) => wanted.some((w) => t.includes(w) || w.includes(t)));
}

export function rankRecall(input: RecallInput): RecallOutput {
  const quotas = { ...DEFAULT_RECALL_QUOTAS, ...(input.quotas ?? {}) };
  const maxItems = input.maxItems ?? 8;
  const byKey = new Map(input.candidates.map((c) => [c.key, c]));
  const allow = new Set(byKey.keys());

  // 按意思
  const dense = new Map<string, number>();
  const q = input.queryVector;
  if (q) {
    for (const c of input.candidates) if (c.vector && c.vector.length === q.length) dense.set(c.key, dot(q, c.vector));
  }
  const denseList = [...dense.entries()].sort((a, b) => b[1] - a[1]).slice(0, 200);
  const top = denseList[0]?.[1] ?? 0;
  /** 只按意思对上的，相似度要过绝对下限，并且离最相关的那条不太远 */
  const denseGate = Math.max(input.minSimilarity ?? 0.3, top - 0.2);

  // 按字面
  const lexList = input.query.trim() ? input.lexical.search(input.query, 200, allow) : [];
  const lex = new Map(lexList.map((m) => [m.key, m]));

  // 涉及的人和物在这句话里出现了：当作第三个排名里的第一名
  const entityHit = new Set<string>();
  if (input.query) {
    for (const c of input.candidates) if (c.entities?.some((e) => e.length >= 2 && input.query.includes(e))) entityHit.add(c.key);
  }

  const fused = new Map<string, number>();
  const addRank = (key: string, rank: number) => fused.set(key, (fused.get(key) ?? 0) + 1 / (RRF_K + rank + 1));
  denseList.forEach(([key], i) => addRank(key, i));
  lexList.forEach((m, i) => addRank(m.key, i));
  for (const key of entityHit) addRank(key, 0);

  const scored = [...fused.entries()]
    .map(([key, f]) => {
      const c = byKey.get(key) as RecallCandidate;
      return { key, c, score: f * (0.8 + (0.2 * Math.min(10, Math.max(1, c.importance))) / 10) * recencyMult(c, input.now) };
    })
    .sort((a, b) => b.score - a.score);
  const rankOf = new Map(scored.map((s, i) => [s.key, i]));
  const scoreOf = (key: string) => scored[rankOf.get(key) ?? -1]?.score ?? 0;
  /** 真的相关：字面对上了不常见的词，或者意思够近 */
  const relevant = (key: string) => !!lex.get(key)?.strong || entityHit.has(key) || (dense.get(key) ?? -1) >= denseGate;

  const chosen: RecallHit[] = [];
  const taken = new Set<string>();
  const take = (key: string, reason: RecallReason) => {
    if (taken.has(key) || chosen.length >= maxItems) return false;
    const c = byKey.get(key);
    if (!c) return false;
    taken.add(key);
    chosen.push({ key, kind: c.kind, id: c.id, reason, score: scoreOf(key), dense: dense.get(key) ?? null, lexical: lex.get(key)?.score ?? null, at: c.at });
    return true;
  };

  // 1. 时间说法
  const time = input.time;
  if (time?.range) {
    const { from, to } = time.range;
    const inRange = input.candidates.filter((c) => c.at >= from && c.at < to);
    // 范围里有相关的先取相关的，否则按重要度、时间先后
    inRange
      .sort((a, b) => scoreOf(b.key) - scoreOf(a.key) || b.importance - a.importance || (time.order === 'earliest' ? a.at - b.at : b.at - a.at))
      .slice(0, quotas.time)
      .forEach((c) => take(c.key, 'time'));
  } else if (time?.order) {
    const pool = scored.slice(0, 20).filter((s) => relevant(s.key));
    pool.sort((a, b) => (time.order === 'earliest' ? a.c.at - b.c.at : b.c.at - a.c.at));
    if (pool[0]) take(pool[0].key, 'time');
  }

  // 2. 最相关
  let basic = 0;
  for (const s of scored) {
    if (basic >= quotas.basic) break;
    if (relevant(s.key) && take(s.key, 'basic')) basic += 1;
  }

  // 3. 重要的里面最相关的
  let important = 0;
  for (const s of scored.slice(0, ECHO_TOP)) {
    if (important >= quotas.important) break;
    if (isImportant(s.c) && take(s.key, 'important')) important += 1;
  }

  // 4. 今天的特殊日子、5. 上下文提到的状态：对上标签的片段，先按相关，再按时间新近
  const facet = (wanted: string[] | undefined, quota: number, reason: RecallReason) => {
    if (!wanted?.length || quota <= 0) return;
    input.candidates
      .filter((c) => c.kind === 'slice' && tagMatch(c.tags?.special, wanted))
      .sort((a, b) => scoreOf(b.key) - scoreOf(a.key) || b.at - a.at)
      .slice(0, quota + taken.size)
      .filter((c) => !taken.has(c.key))
      .slice(0, quota)
      .forEach((c) => take(c.key, reason));
  };
  facet(input.specials, quotas.special, 'special');
  facet(input.states, quotas.state, 'state');

  // 6. 回响
  const top50 = new Set(scored.slice(0, ECHO_TOP).map((s) => s.key));
  const nextEcho = new Map<string, number>();
  for (const e of input.echo ?? []) {
    if (e.life <= 0 || !byKey.has(e.key)) continue;
    if (top50.has(e.key)) take(e.key, 'echo');
    // 不管这轮带没带上，都消耗一轮
    if (e.life - 1 > 0) nextEcho.set(e.key, e.life - 1);
  }

  // 长度上限：按取的先后（时间说法 > 最相关 > 重要 > 日子 > 状态 > 回响），超出的从后往前去掉
  let hits = chosen;
  if (input.tokenBudget !== undefined && input.countTokens) {
    let used = 0;
    hits = [];
    for (const h of chosen) {
      const t = input.countTokens((byKey.get(h.key) as RecallCandidate).text);
      if (used + t > input.tokenBudget && hits.length) continue;
      used += t;
      hits.push(h);
    }
  }

  // 这轮新取的进回响池，满格
  for (const h of hits) {
    if (h.reason === 'echo') continue;
    const c = byKey.get(h.key) as RecallCandidate;
    nextEcho.set(h.key, isImportant(c) ? ECHO_LIFE_IMPORTANT : ECHO_LIFE);
  }
  return { hits, echo: [...nextEcho.entries()].map(([key, life]) => ({ key, life })) };
}
