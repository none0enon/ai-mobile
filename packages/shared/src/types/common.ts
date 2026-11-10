/**
 * 所有会同步到 Worker(D1) 的记录都带这些字段。
 * - updatedAt：客户端写入时间，只用于界面展示和"后写者赢"的同 seq 判定
 * - seq：Worker 写入时分配的全局递增序号，客户端只读，用来做增量拉取（不依赖设备时钟）
 * - deleted：墓碑，删除时置 true 而不是真删，保证其他设备能收到删除
 */
export interface SyncMeta {
  id: string;
  createdAt: number;
  updatedAt: number;
  deleted?: boolean;
  seq?: number;
}

/** "07:30" 这样的本地时刻 */
export type HHMM = string;

/** "2026-11-09" 这样的本地日期 */
export type ISODate = string;
