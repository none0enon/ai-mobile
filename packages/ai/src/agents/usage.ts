import type { AgentRole } from '@app/shared';

/**
 * 每个智能体每天用了多少 token（设计文档 §4.1"每日 token 上限"，防止后台智能体跑飞）。
 * App 里先记在内存；Worker 里记在 D1 的 usage 表（date, agent, tokens）。
 */
export interface UsageMeter {
  used(role: AgentRole, day: string): number;
  add(role: AgentRole, tokens: number, day: string): void;
}

export class MemoryUsageMeter implements UsageMeter {
  private readonly table = new Map<string, number>();

  used(role: AgentRole, day: string): number {
    return this.table.get(`${day}|${role}`) ?? 0;
  }

  add(role: AgentRole, tokens: number, day: string): void {
    if (!(tokens > 0)) return;
    const key = `${day}|${role}`;
    this.table.set(key, (this.table.get(key) ?? 0) + tokens);
  }
}

/** 本地日期 "2026-11-11"（Worker 里传入按你的时区换算过的时间） */
export function dayKey(now: Date = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}
