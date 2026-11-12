import {
  formatTemp,
  outlookLine,
  weatherSnapshot,
  WEATHER_PROVIDER_LABEL,
  type Character,
  type TempUnit,
  type WeatherProviderChoice,
  type WeatherReport,
  type WeatherSnapshot,
} from '@app/shared';
import { defineStore } from 'pinia';
import { computed, reactive, watch } from 'vue';
import { useCharacterStore } from './characters';
import { useEnvironmentStore } from './environment';
import { useRealWorldStore } from './realworld';
import { useServicesStore } from './services';
import { services } from '@/services';
import type { GeoPlace } from '@/services/types';
import { pickProvider } from '@/services/weather';

/**
 * 真实天气（设计文档 §8）：
 * - 你那边：定位（打开了"用定位"时）→ 家的坐标（填了家的地址和 Google 地图 Key 时）→ "环境与作息"里的城市；
 *   默认用 Open-Meteo（免 Key，美国用 NOAA 的模型，另取美国气象局的预警），在国内且填了和风天气时用和风；
 * - 她那边：角色设定里写了她住在哪座城市（例如住在国内的角色写"上海"）就查那里的天气——国内的城市用和风天气；
 *   没写就是和你在同一个地方。
 * 半小时取一次（切回 App 时过期了也取），结果存在本机，打开 App 马上就有上次的天气。
 * 取不到时界面写明原因，提示词里不写天气，不拿假的天气充数。
 */

const CACHE_KEY = 'ai-mobile:weather:v1';
const GEO_KEY = 'ai-mobile:geocode:v1';
/** 半小时内的不重新取 */
const FRESH_MS = 30 * 60_000;
/** 超过 6 小时的不再当成"现在的天气" */
const STALE_MS = 6 * 3600_000;

export interface WeatherEntry {
  report: WeatherReport | null;
  /** 查的哪里：城市名或"定位""家" */
  source: string;
  error: string;
  detail: string;
  loading: boolean;
  /** 上次尝试（成功或失败）的时间 */
  tried: number;
  /** 查天气用的地方（地名 + 坐标），变了就重新取 */
  placeKey: string;
}

function readJson<T>(key: string): T | null {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}
function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 存不了只是下次打开时要等一下
  }
}

const blank = (): WeatherEntry => ({ report: null, source: '', error: '', detail: '', loading: false, tried: 0, placeKey: '' });

export const useWeatherStore = defineStore('weather', () => {
  const env = useEnvironmentStore().settings;
  const svc = useServicesStore();
  const chars = useCharacterStore();

  const cached = readJson<Record<string, Pick<WeatherEntry, 'report' | 'source' | 'placeKey'>>>(CACHE_KEY) ?? {};
  /** me = 你那边；char:<id> = 她那边（她写了自己的城市时） */
  const entries = reactive<Record<string, WeatherEntry>>(
    Object.fromEntries(Object.entries(cached).map(([k, v]) => [k, { ...blank(), ...v, tried: 0 }])),
  );
  const geoCache = new Map<string, GeoPlace>(Object.entries(readJson<Record<string, GeoPlace>>(GEO_KEY) ?? {}));

  function save() {
    writeJson(
      CACHE_KEY,
      Object.fromEntries(Object.entries(entries).filter(([, e]) => e.report).map(([k, e]) => [k, { report: e.report, source: e.source, placeKey: e.placeKey }])),
    );
  }

  const unit = computed<TempUnit>(() => env.tempUnit ?? 'c');
  const temp = (c: number | null | undefined) => formatTemp(c, unit.value);

  /** 还能当"现在"用的天气（6 小时以内） */
  function live(e: WeatherEntry | undefined): WeatherReport | null {
    return e?.report && Date.now() - e.report.fetchedAt < STALE_MS ? e.report : null;
  }

  const mine = computed(() => live(entries.me));
  const mineEntry = computed(() => entries.me ?? blank());

  function hasOwnCity(c: Character | null | undefined): boolean {
    return !!c?.weather?.city?.trim();
  }
  /** 她那边的天气：她写了城市就是那座城市的，否则和你一样 */
  function forCharacter(c: Character | null | undefined): WeatherReport | null {
    if (!c || !hasOwnCity(c)) return mine.value;
    return live(entries[`char:${c.id}`]);
  }
  function entryFor(c: Character | null | undefined): WeatherEntry {
    if (!c || !hasOwnCity(c)) return mineEntry.value;
    return entries[`char:${c.id}`] ?? blank();
  }

  /** 一行短的："小雨 12°C" */
  function short(r: WeatherReport | null): string {
    return r ? `${r.text} ${temp(r.tempC)}` : '';
  }
  /** 一行带地名的："上海 小雨 12°C" */
  function line(r: WeatherReport | null): string {
    return r ? `${r.place} ${r.text} ${temp(r.tempC)}` : '';
  }
  function outlook(r: WeatherReport | null): string {
    return r ? outlookLine(r, unit.value) : '';
  }

  /** 交给【当前环境】：你那边 + 她那边（她在别的城市时） */
  function envInput(c: Character | null | undefined): { weather: WeatherSnapshot | null; herWeather: (WeatherSnapshot & { name: string }) | null } {
    const me = mine.value ? weatherSnapshot(mine.value, unit.value) : null;
    if (!c || !hasOwnCity(c)) return { weather: me, herWeather: null };
    const her = forCharacter(c);
    return { weather: me, herWeather: her ? { ...weatherSnapshot(her, unit.value), name: c.name } : null };
  }

  // —— 取天气 ——

  async function geocodeCached(city: string): Promise<GeoPlace | null> {
    const k = city.trim().toLowerCase();
    const hit = geoCache.get(k);
    if (hit) return hit;
    const p = await services.weather.geocode(city.trim());
    if (p) {
      geoCache.set(k, p);
      writeJson(GEO_KEY, Object.fromEntries(geoCache));
    }
    return p;
  }

  /** 你那边查哪里：定位 → 家 → 城市 */
  async function myPlace(): Promise<{ place: GeoPlace | null; source: string; reason?: string }> {
    const real = useRealWorldStore();
    const city = env.city.trim();
    if (env.useLocation && real.here) {
      const name = real.hereCity || (real.atHome ? real.homeGeo?.city : '') || city || '你这里';
      return { place: { lat: real.here.lat, lng: real.here.lng, name, ...(real.hereCountry ? { countryCode: real.hereCountry } : {}) }, source: '定位' };
    }
    const home = real.homeGeo;
    if (home) {
      return { place: { lat: home.lat, lng: home.lng, name: home.city || city || '家', ...(home.countryCode ? { countryCode: home.countryCode } : {}) }, source: '家的地址' };
    }
    if (city) {
      const p = await geocodeCached(city);
      return p ? { place: p, source: city } : { place: null, source: city, reason: `找不到"${city}"这个城市，换个写法试试（中文、英文都行）` };
    }
    return { place: null, source: '', reason: '还不知道你在哪：在"环境与作息"里填城市，或者打开定位' };
  }

  /** 正在取的（同一个地方、同一家只取一次：几个角色都在上海时） */
  const inflight = new Map<string, Promise<WeatherReport>>();
  function fetchOnce(place: GeoPlace, choice: WeatherProviderChoice): Promise<WeatherReport> {
    const provider = pickProvider(choice, place, svc.qweatherReady);
    const k = `${provider}|${place.lat.toFixed(2)},${place.lng.toFixed(2)}|${place.name}`;
    const running = inflight.get(k);
    if (running) return running;
    const p = services.weather.report(place, choice).finally(() => inflight.delete(k));
    inflight.set(k, p);
    return p;
  }

  async function load(key: string, resolve: () => Promise<{ place: GeoPlace | null; source: string; reason?: string }>, choice: WeatherProviderChoice, force: boolean) {
    if (!entries[key]) entries[key] = blank();
    // 取响应式的那一份来改（界面跟着变）
    const e = entries[key]!;
    if (e.loading) return;
    if (!force && e.report && Date.now() - e.report.fetchedAt < FRESH_MS && !e.error) {
      // 地方变了要重新取
      const where = await resolve().catch(() => null);
      const pk = where?.place ? `${where.place.lat.toFixed(2)},${where.place.lng.toFixed(2)}|${choice}|${where.place.name}` : '';
      if (pk && pk === e.placeKey) return;
    }
    e.loading = true;
    e.tried = Date.now();
    try {
      const where = await resolve();
      e.source = where.source;
      if (!where.place) {
        e.report = null;
        e.error = where.reason ?? '不知道去哪里查天气';
        e.detail = '';
        e.placeKey = '';
        return;
      }
      const report = await fetchOnce(where.place, choice);
      e.report = report;
      e.error = '';
      e.detail = '';
      e.placeKey = `${where.place.lat.toFixed(2)},${where.place.lng.toFixed(2)}|${choice}|${where.place.name}`;
    } catch (err) {
      e.error = err instanceof Error ? err.message : String(err);
      e.detail = (err as { detail?: string }).detail ?? '';
    } finally {
      e.loading = false;
      save();
    }
  }

  function refreshMe(force = false) {
    return load('me', myPlace, env.weatherProvider ?? 'auto', force);
  }

  function refreshCharacter(c: Character, force = false) {
    const key = `char:${c.id}`;
    if (!hasOwnCity(c)) {
      if (entries[key]) delete entries[key];
      save();
      return Promise.resolve();
    }
    const city = c.weather!.city.trim();
    return load(
      key,
      async () => {
        const p = await geocodeCached(city);
        return p ? { place: p, source: city } : { place: null, source: city, reason: `找不到"${city}"这个城市，换个写法试试` };
      },
      c.weather?.provider ?? 'auto',
      force,
    );
  }

  async function refresh(force = false) {
    await Promise.allSettled([refreshMe(force), ...chars.list.map((c) => refreshCharacter(c, force))]);
  }

  /** 现在用的是哪家（设置页里显示） */
  function providerLabel(r: WeatherReport | null): string {
    return r ? WEATHER_PROVIDER_LABEL[r.provider] : '';
  }

  let started = false;
  function start() {
    if (started) return;
    started = true;
    void refresh();
    // 每 10 分钟看一眼有没有过期（半小时）的
    setInterval(() => void refresh(), 10 * 60_000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void refresh();
    });
    const real = useRealWorldStore();
    // 你在哪、用哪家变了：重新取你那边
    watch(
      () => [env.city, env.useLocation, env.weatherProvider, real.homeGeo?.lat, real.homeGeo?.lng, real.here?.lat, real.hereCity],
      () => void refreshMe(true),
    );
    // 她们的城市变了：重新取她那边
    watch(
      () => chars.list.map((c) => `${c.id}:${c.weather?.city ?? ''}:${c.weather?.provider ?? ''}`).join('|'),
      () => {
        for (const c of chars.list) void refreshCharacter(c, true);
        // 删掉的角色
        for (const k of Object.keys(entries)) if (k.startsWith('char:') && !chars.byId(k.slice(5))) delete entries[k];
        save();
      },
    );
    watch(() => svc.qweatherReady, () => void refresh(true));
  }

  return {
    entries,
    unit,
    temp,
    mine,
    mineEntry,
    hasOwnCity,
    forCharacter,
    entryFor,
    short,
    line,
    outlook,
    envInput,
    providerLabel,
    refresh,
    refreshMe,
    refreshCharacter,
    start,
  };
});
