import type { EnvironmentSettings, PushChannel, Touchpoint } from '@app/shared';
import { at } from '@/utils/time';

export const envSettings: EnvironmentSettings = {
  city: '上海',
  timezone: 'Asia/Shanghai',
  weatherProvider: 'qweather',
  useLocation: false,
  wakeTime: '07:30',
  sleepTime: '23:30',
  meals: {
    breakfast: { start: '07:30', end: '09:30' },
    lunch: { start: '11:30', end: '13:30' },
    dinner: { start: '17:30', end: '19:30' },
  },
};

const t = at(-10, '20:00');

export const pushChannels: PushChannel[] = [
  { id: 'pc1', createdAt: t, updatedAt: t, kind: 'webpush', label: 'iPhone · 主屏 PWA', enabled: true, deviceName: 'iPhone', config: {}, lastOkAt: at(-1, '20:02') },
  { id: 'pc2', createdAt: t, updatedAt: t, kind: 'android', label: '安卓 · APK 本地通知', enabled: true, deviceName: 'Android', config: {}, lastOkAt: at(-1, '07:30') },
  { id: 'pc3', createdAt: t, updatedAt: t, kind: 'webhook', preset: 'bark', label: 'Bark（iPhone 备用）', enabled: false, config: { url: 'https://api.day.app/****/' } },
  { id: 'pc4', createdAt: t, updatedAt: t, kind: 'webhook', preset: 'pushplus', label: 'PushPlus（推到微信）', enabled: false, config: {} },
];

/** 今天的主动消息计划：过去的时刻显示结果，未来的显示"已排期" */
export function todayTouchpoints(now = Date.now()): Touchpoint[] {
  const plan: [string, Touchpoint['ruleId'], Touchpoint['action'], string, string?][] = [
    ['07:30', 'wake-call', 'call', '叫醒来电'],
    ['07:42', 'morning', 'message', '早安 + 今天的天气'],
    ['12:10', 'lunch', 'message', '暗示该吃午饭了', '你 20 分钟内刚聊过，跳过'],
    ['15:40', 'sedentary', 'message', '拉你起来走走'],
    ['18:15', 'dinner', 'message', '"我有点饿了…你吃了吗？"'],
    ['21:30', 'miss-you', 'message', '想你了'],
    ['23:40', 'bedtime', 'call', '催睡，必要时来电'],
  ];
  return plan.map(([time, ruleId, action, hint, skip]) => {
    const dueAt = at(0, time);
    const past = dueAt <= now;
    return {
      id: `today:${ruleId}`,
      createdAt: at(0, '04:00'),
      updatedAt: at(0, '04:00'),
      characterId: 'suwan',
      ruleId,
      date: 'today',
      dueAt,
      action,
      hint,
      status: past ? (skip ? 'skipped' : 'opened') : 'planned',
      skipReason: past ? skip : undefined,
    };
  });
}
