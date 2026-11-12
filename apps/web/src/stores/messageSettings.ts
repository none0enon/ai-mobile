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
 */
export interface MessageSettings {
  sendLimit: boolean;
  sendLast: number;
  showLimit: boolean;
  showLast: number;
  html: boolean;
  frameLast: number;
}

/** 三个数能取的范围 */
export const MESSAGE_RANGES = {
  sendLast: { min: 0, max: 100 },
  showLast: { min: 1, max: 100 },
  frameLast: { min: 0, max: 50 },
} as const;

const DEFAULTS: MessageSettings = { sendLimit: false, sendLast: 20, showLimit: false, showLast: 50, html: true, frameLast: 5 };

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

  return { settings, hydrate, sendCount };
});

/** 只留最后 n 条；n 不给时不限，为 0 时一条不留（slice(-0) 是整个数组，不能直接用） */
export function lastN<T>(list: readonly T[], n: number | undefined): T[] {
  if (n === undefined) return [...list];
  return n <= 0 ? [] : list.slice(-n);
}
