import { defineStore } from 'pinia';
import { computed, reactive } from 'vue';
import { autoSave, getEntries, getOne } from '@/db/idb';

/**
 * 真实世界的服务（"我的 → 地图、天气、音乐"）：网易云音乐、Google 地图、和风天气。
 * 地址这类设置存在 settings 表（services 一项）；Key 和 Cookie 单独存在 secrets 表（svc: 开头），只在这台设备上，
 * 永远不进同步数据，请求从浏览器直接发给服务商（或者你自己部署的 Worker）。
 * Open-Meteo（你那边的天气）、美国气象局的预警、网页定位不用 Key。
 */

/** 网易云音质（和 Netease_url Worker 的 level 一致；无损以上要黑胶 Cookie） */
export const NETEASE_QUALITIES = [
  { value: 'standard', label: '标准 128k' },
  { value: 'exhigh', label: '极高 320k' },
  { value: 'lossless', label: '无损 FLAC' },
  { value: 'hires', label: 'Hi-Res' },
  { value: 'jyeffect', label: '高清环绕声' },
  { value: 'sky', label: '沉浸环绕声' },
  { value: 'jymaster', label: '超清母带' },
] as const;
export type NeteaseQuality = (typeof NETEASE_QUALITIES)[number]['value'];

export interface NeteaseSettings {
  /** 你部署的 Netease_url Worker（和 SleepTogether 用的是同一个，填同一个地址就行） */
  workerUrl: string;
  quality: NeteaseQuality;
  /** 0–1 */
  volume: number;
}

export interface WeatherServiceSettings {
  /** 和风天气的 API Host（控制台 → 设置），例如 abcxyz.re.qweatherapi.com */
  qweatherHost: string;
}

export const SECRET_IDS = {
  neteaseCookie: 'svc:netease-cookie',
  googleMaps: 'svc:google-maps',
  qweather: 'svc:qweather',
} as const;

/** 去掉多余的空白和末尾的斜杠；没写 https:// 的补上 */
export function normalizeBase(url: string): string {
  const t = url.trim().replace(/\/+$/, '');
  if (!t) return '';
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}

export const useServicesStore = defineStore('services', () => {
  const netease = reactive<NeteaseSettings>({ workerUrl: '', quality: 'exhigh', volume: 1 });
  const weather = reactive<WeatherServiceSettings>({ qweatherHost: '' });
  /** svc: 开头的 Key / Cookie */
  const secrets = reactive<Record<string, string>>({});

  const saver = autoSave('settings', () => [{ key: 'services', value: { netease, weather } }], () => [netease, weather]);
  const secretSaver = autoSave(
    'secrets',
    () => Object.entries(secrets).filter(([k, v]) => k.startsWith('svc:') && !!v).map(([key, value]) => ({ key, value })),
    () => ({ ...secrets }),
    200,
  );

  async function hydrate() {
    const [saved, stored] = await Promise.all([
      getOne<{ netease?: Partial<NeteaseSettings>; weather?: Partial<WeatherServiceSettings> }>('settings', 'services'),
      getEntries<string>('secrets'),
    ]);
    const n = saved?.netease;
    if (n) {
      if (typeof n.workerUrl === 'string') netease.workerUrl = n.workerUrl;
      if (NETEASE_QUALITIES.some((q) => q.value === n.quality)) netease.quality = n.quality as NeteaseQuality;
      if (typeof n.volume === 'number' && n.volume >= 0 && n.volume <= 1) netease.volume = n.volume;
    }
    if (typeof saved?.weather?.qweatherHost === 'string') weather.qweatherHost = saved.weather.qweatherHost;
    for (const { key, value } of stored) if (key.startsWith('svc:') && typeof value === 'string' && value) secrets[key] = value;
    saver.start();
    secretSaver.start();
  }

  function setSecret(id: string, value: string | null | undefined) {
    const v = value?.trim();
    if (v) secrets[id] = v;
    else delete secrets[id];
  }

  const neteaseBase = computed(() => normalizeBase(netease.workerUrl));
  const neteaseCookie = computed(() => secrets[SECRET_IDS.neteaseCookie] ?? '');
  const musicReady = computed(() => !!neteaseBase.value);

  const mapsKey = computed(() => secrets[SECRET_IDS.googleMaps] ?? '');
  const mapsReady = computed(() => !!mapsKey.value);

  const qweatherBase = computed(() => normalizeBase(weather.qweatherHost));
  const qweatherKey = computed(() => secrets[SECRET_IDS.qweather] ?? '');
  const qweatherReady = computed(() => !!qweatherBase.value && !!qweatherKey.value);

  return {
    netease,
    weather,
    secrets,
    hydrate,
    setSecret,
    neteaseBase,
    neteaseCookie,
    musicReady,
    mapsKey,
    mapsReady,
    qweatherBase,
    qweatherKey,
    qweatherReady,
  };
});
