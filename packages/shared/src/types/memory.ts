import type { ISODate, SyncMeta } from './common.ts';

export type MemoryType =
  | 'fact' // 事实："在读研一，专业是计算机"
  | 'preference' // 偏好："不吃香菜"
  | 'event' // 事件："11/02 一起看了电影"
  | 'promise' // 约定："周六一起去水族馆"
  | 'followup' // 待跟进：带 dueAt，到期由主动消息去问
  | 'emotion' // 情绪："最近因为论文焦虑"
  | 'relationship'; // 关系里程碑

/**
 * 向量和生成它的模型绑在一起：换了向量模型后，旧向量不能和新向量比较，
 * 所以检索时只用 model 与当前设置一致的向量，其余排队重算。
 */
export interface MemoryVector {
  model: string;
  dims: number;
  /** float16 小端序，base64 编码 */
  data: string;
}

export interface Memory extends SyncMeta {
  characterId: string;
  type: MemoryType;
  content: string;
  /** 1-10，总结智能体给出，用户可改 */
  importance: number;
  pinned: boolean;
  status: 'active' | 'archived' | 'superseded';
  /** 仅 followup：到期时间 */
  dueAt: number | null;
  sourceMessageIds: string[];
  happenedAt: number | null;
  vector: MemoryVector | null;
  lastRecalledAt: number | null;
  recallCount: number;
}

/** 滚动章节摘要 */
export interface ChapterSummary extends SyncMeta {
  chatId: string;
  fromMessageId: string;
  toMessageId: string;
  text: string;
}

/** 角色日记：每晚由总结智能体用角色口吻写 */
export interface DiaryEntry extends SyncMeta {
  characterId: string;
  date: ISODate;
  weather: string;
  mood: string;
  text: string;
  highlights: string[];
}

/** 检索打分 = similarity·w1 + recency·w2 + importance·w3，新近度按半衰期衰减 */
export interface MemoryScoreWeights {
  similarity: number;
  recency: number;
  importance: number;
  halfLifeDays: number;
}
