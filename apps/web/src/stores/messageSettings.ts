import { defineStore } from 'pinia';
import { reactive } from 'vue';
import { autoSave, getOne } from '@/db/idb';

/**
 * 我的 → 消息设置，保存在本机（settings 表的 messages）。
 * - 发送条数：开启后聊天记录只发送最近 sendLast 条（0 表示不发送），之后仍按预设上下文长度截取；
 *   聊天、场景、通话、主动消息（本机和云端）均适用；
 * - 显示条数：开启后聊天只显示最近 showLast 条，顶部可展开更早的消息；
 * - HTML 渲染：开启后消息中的 HTML 按白名单渲染（脚本、事件属性移除）；
 *   代码块中的完整 HTML 页面（前端卡）在沙盒 iframe 中运行，仅渲染最近 frameLast 条，其余折叠为代码。
 * - 总结：每 summaryEvery 条整理一次（1–100）；自动隐藏已总结的消息（聊天页顶部可展开）；
 *   已总结的消息不发送给 AI（聊天、场景、通话、主动消息本机和云端都适用，和发送条数一样）。
 */
export interface MessageSettings {
  sendLimit: boolean;
  sendLast: number;
  showLimit: boolean;
  showLast: number;
  html: boolean;
  frameLast: number;
  summaryEvery: number;
  hideSummarized: boolean;
  dropSummarized: boolean;
}

/** 三个数能取的范围 */
export const MESSAGE_RANGES = {
  sendLast: { min: 0, max: 100 },
  showLast: { min: 1, max: 100 },
  frameLast: { min: 0, max: 50 },
  summaryEvery: { min: 1, max: 100 },
} as const;

const DEFAULTS: MessageSettings = { sendLimit: false, sendLast: 20, showLimit: false, showLast: 50, html: true, frameLast: 5, summaryEvery: 30, hideSummarized: false, dropSummarized: false };

function clampTo(key: keyof typeof MESSAGE_RANGES, v: unknown, fallback: number): number {
  const { min, max } = MESSAGE_RANGES[key];
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export const useMessageSettingsStore = defineStore('messageSettings', () => {
  const settings = reactive<MessageSettings>({ ...DEFAULTS });
  const saver = autoSave('settings', () => [{ key: 'messages', value: { ...settings } }], () => settings);

  async function hydrate() {
    const saved = await getOne<Partial<MessageSettings>>('settings', 'messages');
    if (saved && typeof saved === 'object') {
      if (typeof saved.sendLimit === 'boolean') settings.sendLimit = saved.sendLimit;
      if (typeof saved.showLimit === 'boolean') settings.showLimit = saved.showLimit;
      if (typeof saved.html === 'boolean') settings.html = saved.html;
      if (typeof saved.hideSummarized === 'boolean') settings.hideSummarized = saved.hideSummarized;
      if (typeof saved.dropSummarized === 'boolean') settings.dropSummarized = saved.dropSummarized;
      settings.summaryEvery = clampTo('summaryEvery', saved.summaryEvery, DEFAULTS.summaryEvery);
      settings.sendLast = clampTo('sendLast', saved.sendLast, DEFAULTS.sendLast);
      settings.showLast = clampTo('showLast', saved.showLast, DEFAULTS.showLast);
      settings.frameLast = clampTo('frameLast', saved.frameLast, DEFAULTS.frameLast);
    }
    saver.start();
  }

  /** 发送给 AI 的聊天记录条数上限；未开启时为空（不限） */
  function sendCount(): number | undefined {
    return settings.sendLimit ? clampTo('sendLast', settings.sendLast, DEFAULTS.sendLast) : undefined;
  }

  /** 每多少条整理一次 */
  function summaryEvery(): number {
    return clampTo('summaryEvery', settings.summaryEvery, DEFAULTS.summaryEvery);
  }

  return { settings, hydrate, sendCount, summaryEvery };
});

/**
 * 已经总结过的消息之后的部分（总结覆盖到 untilId 那条为止）。untilId 为空或找不到时原样返回。
 * "已总结的消息不发送给 AI"和"自动隐藏已总结的消息"都用它
 */
export function afterSummarized<T extends { id: string }>(list: readonly T[], untilId: string | null | undefined): T[] {
  if (!untilId) return [...list];
  const at = list.findIndex((m) => m.id === untilId);
  return at < 0 ? [...list] : list.slice(at + 1);
}

/** 只留最后 n 条；n 不给时不限，为 0 时一条不留（slice(-0) 是整个数组，不能直接用） */
export function lastN<T>(list: readonly T[], n: number | undefined): T[] {
  if (n === undefined) return [...list];
  return n <= 0 ? [] : list.slice(-n);
}
