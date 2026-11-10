import type { SyncMeta } from './common.ts';

/** 次关键词逻辑，对应 ST 的 selectiveLogic 0-3 */
export type LoreLogic = 'and_any' | 'not_all' | 'not_any' | 'and_all';

/**
 * 插入位置，对应 ST world info position 0-6：
 * 角色定义前/后、作者注顶部/底部、按深度插入、示例对话顶部/底部
 */
export type LorePosition =
  | 'before_char'
  | 'after_char'
  | 'an_top'
  | 'an_bottom'
  | 'at_depth'
  | 'em_top'
  | 'em_bottom';

export interface LoreEntry {
  uid: string;
  /** 条目标题（ST 的 comment） */
  comment: string;
  keys: string[];
  secondaryKeys: string[];
  logic: LoreLogic;
  content: string;
  /** 常驻：不需要关键词也总是插入 */
  constant: boolean;
  enabled: boolean;
  position: LorePosition;
  /** position = at_depth 时的插入深度 */
  depth: number;
  role: 'system' | 'user' | 'assistant';
  /** 插入顺序，数字大的更靠后 */
  order: number;
  /** 触发概率 0-100 */
  probability: number;
  /** 关掉时忽略概率，总是触发（ST 的 useProbability） */
  useProbability: boolean;
  /** 为空时用世界书默认扫描深度 */
  scanDepth: number | null;
  /** 为空时跟随全局设置（默认不区分大小写） */
  caseSensitive: boolean | null;
  /** 为空时跟随全局设置（默认整词匹配；中文关键词总是按包含匹配） */
  matchWholeWords: boolean | null;
  /** 同组只选一条（逗号分隔可属于多个组） */
  group: string;
  /** 同组里优先选它（多条都勾上时选顺序最大的） */
  groupOverride: boolean;
  /** 同组随机时的权重 */
  groupWeight: number;
  /** 不让它的内容触发别的条目 */
  preventRecursion: boolean;
  /** 不会被别的条目的内容触发 */
  excludeRecursion: boolean;
  /** 只在递归扫描时才触发；数字表示递归层级（true = 第 1 层） */
  delayUntilRecursion: boolean | number;
  /** 超出 token 预算也照样插入 */
  ignoreBudget: boolean;
  /** 只在这些生成类型里触发（normal / continue / impersonate / swipe / regenerate / quiet）；为空表示都触发 */
  triggers: string[];
  /** 触发后保持 N 条消息 */
  sticky: number;
  /** 触发后 N 条消息内不再触发 */
  cooldown: number;
  /** 聊天少于 N 条消息时不触发 */
  delay: number;
  /** ST 里其余没有对应字段的设置（display_index、outlet_name、match_persona_description……），导出时原样写回 */
  extra?: Record<string, unknown>;
}

export interface Lorebook extends SyncMeta {
  name: string;
  description: string;
  scanDepth: number;
  tokenBudget: number;
  recursive: boolean;
  entries: LoreEntry[];
  /** character_book.extensions 等，导出时原样写回 */
  extra?: Record<string, unknown>;
}

/**
 * 世界书条目的计时状态（粘性 / 冷却），存在聊天上，和 ST 的 chat_metadata.timedWorldInfo 一样。
 * key 是"世界书 id.条目 uid"；start / end 是聊天消息条数。
 */
export interface LoreTimedState {
  sticky: Record<string, { start: number; end: number; protected?: boolean }>;
  cooldown: Record<string, { start: number; end: number; protected?: boolean }>;
}
