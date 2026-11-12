import type { EnvironmentSettings, PushChannel } from '@app/shared';
import { at } from '@/utils/time';

/** 这台设备的时区（第一次打开时的默认值；在"环境与作息"里能改） */
function zone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  } catch {
    return 'Asia/Shanghai';
  }
}

export const envSettings: EnvironmentSettings = {
  // 你在哪座城市（查天气用）：第一次打开时空着，在"环境与作息"里填，或者填家的地址、打开定位
  city: '',
  timezone: zone(),
  weatherProvider: 'auto',
  tempUnit: 'c',
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

// 今天的主动消息计划不在这里写死：每个角色按自己的设置排（packages/shared/src/proactive.ts → stores/proactive.ts）
