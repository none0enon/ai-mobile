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
  /** 为空时用世界书默认扫描深度 */
  scanDepth: number | null;
  caseSensitive: boolean;
  matchWholeWords: boolean;
  /** 同组只选一条 */
  group: string;
  preventRecursion: boolean;
  excludeRecursion: boolean;
  /** 触发后保持 N 条消息 */
  sticky: number;
  cooldown: number;
  delay: number;
}

export interface Lorebook extends SyncMeta {
  name: string;
  description: string;
  scanDepth: number;
  tokenBudget: number;
  recursive: boolean;
  entries: LoreEntry[];
}
