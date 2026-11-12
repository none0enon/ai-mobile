import {
  fromOpenMeteo,
  fromQWeather,
  fromQWeatherV7,
  isChinaRegion,
  nwsAlertLine,
  OPEN_METEO_QUERY,
  qweatherError,
  roughlyInChina,
  roughlyInUS,
  type WeatherProvider,
  type WeatherProviderChoice,
  type WeatherReport,
} from '@app/shared';
import type { GeoPlace, WeatherClient } from './types';
import { useServicesStore } from '@/stores/services';

/**
 * 天气的真实实现（数据结构和"各家的返回换成同一种样子"在 packages/shared/src/weather.ts）：
 * - Open-Meteo：免 Key、全球，美国用 NOAA 的高分辨率模型。城市名查坐标也用它的地理编码（免 Key）。
 * - 和风天气：国内更准，要 Key 和你自己的 API Host（"我的 → 地图、天气、音乐"里填）。
 *   先用新接口（/weather/v1/current、/weather/v1/daily、/weatheralert/v1/current），账号还没有新接口（404）时退回 v7。
 * - 美国国家气象局（api.weather.gov）：美国境内的天气预警，免 Key。
 * 都支持浏览器直接请求（CORS），Key 只存在这台设备。
 */

export class WeatherError extends Error {
  readonly detail: string;
  constructor(message: string, detail = '') {
    super(message);
    this.name = 'WeatherError';
    this.detail = detail;
  }
}

function withTimeout(ms: number, outer?: AbortSignal): AbortSignal {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new DOMException('请求超时', 'TimeoutError')), ms);
  outer?.addEventListener('abort', () => ctrl.abort(outer.reason), { once: true });
  ctrl.signal.addEventListener('abort', () => clearTimeout(t), { once: true });
  return ctrl.signal;
}

async function getJson(url: string, init: RequestInit & { label: string }, signal?: AbortSignal): Promise<{ status: number; json: unknown }> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: withTimeout(15_000, signal) });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new WeatherError(`连不上${init.label}：${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (json === null && !res.ok) throw new WeatherError(`${init.label}返回 ${res.status}`, text.slice(0, 1000));
  return { status: res.status, json };
}

/** 那个地方现在是不是白天（按它的时区 6–18 点算；不知道时区时按这台设备） */
function daytimeAt(timezone: string | undefined): boolean {
  try {
    const h = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: timezone }).format(new Date()));
    return h >= 6 && h < 18;
  } catch {
    const h = new Date().getHours();
    return h >= 6 && h < 18;
  }
}

/** 在不在国内：有国家代码按国家代码，没有按经纬度粗算 */
export function inChina(p: GeoPlace): boolean {
  return p.countryCode ? isChinaRegion(p.countryCode) : roughlyInChina(p.lat, p.lng);
}

/** auto：国内的地方、和风天气填好了 → 和风；其他 → Open-Meteo。指定了和风但没填好时也退回 Open-Meteo */
export function pickProvider(choice: WeatherProviderChoice, place: GeoPlace, qweatherReady: boolean): WeatherProvider {
  if (choice === 'open-meteo') return 'open-meteo';
  if (choice === 'qweather') return qweatherReady ? 'qweather' : 'open-meteo';
  return qweatherReady && inChina(place) ? 'qweather' : 'open-meteo';
}

// —— 城市名 → 坐标 ——

interface OmGeoJson {
  results?: { name?: string; latitude?: number; longitude?: number; country_code?: string; timezone?: string; admin1?: string; country?: string }[];
}

async function openMeteoGeocode(name: string, signal?: AbortSignal): Promise<GeoPlace | null> {
  const q = new URLSearchParams({ name, count: '1', language: 'zh', format: 'json' });
  const { status, json } = await getJson(`https://geocoding-api.open-meteo.com/v1/search?${q}`, { label: 'Open-Meteo 地理编码' }, signal);
  if (status >= 400) throw new WeatherError(`Open-Meteo 地理编码返回 ${status}`, JSON.stringify(json).slice(0, 1000));
  const r = (json as OmGeoJson | null)?.results?.[0];
  if (!r || typeof r.latitude !== 'number' || typeof r.longitude !== 'number') return null;
  return {
    name: r.name || name,
    lat: r.latitude,
    lng: r.longitude,
    ...(r.country_code ? { countryCode: r.country_code } : {}),
    ...(r.timezone ? { timezone: r.timezone } : {}),
  };
}

interface QwGeoJson {
  code?: string;
  location?: { name?: string; lat?: string; lon?: string; tz?: string; country?: string; adm1?: string }[];
}

async function qweatherGeocode(name: string, base: string, key: string, signal?: AbortSignal): Promise<GeoPlace | null> {
  const q = new URLSearchParams({ location: name, number: '1', lang: 'zh' });
  const { status, json } = await getJson(`${base}/geo/v2/city/lookup?${q}`, { label: '和风天气城市搜索', headers: { 'X-QW-Api-Key': key } }, signal);
  const err = qweatherError(json, status);
  if (err) {
    if ((json as QwGeoJson | null)?.code === '404') return null;
    throw new WeatherError(err, JSON.stringify(json).slice(0, 1000));
  }
  const r = (json as QwGeoJson).location?.[0];
  const lat = Number(r?.lat);
  const lng = Number(r?.lon);
  if (!r || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const china = ['中国', 'China'].includes(r.country ?? '');
  return { name: r.name || name, lat, lng, ...(china ? { countryCode: 'CN' } : {}), ...(r.tz ? { timezone: r.tz } : {}) };
}

/**
 * 城市名查坐标：先 Open-Meteo（免 Key，中文、英文都认），"San Francisco, CA" 这种带逗号的也试一下逗号前面；
 * 查不到、和风天气又填好了时再问和风（国内的区县名更全）
 */
export async function geocodeCity(name: string, signal?: AbortSignal): Promise<GeoPlace | null> {
  const n = name.trim();
  if (!n) return null;
  const tries = [n, n.split(/[,，]/)[0]!.trim()].filter((x, i, a) => x && a.indexOf(x) === i);
  let lastError: unknown = null;
  for (const t of tries) {
    try {
      const r = await openMeteoGeocode(t, signal);
      if (r) return r;
    } catch (e) {
      lastError = e;
    }
  }
  const svc = useServicesStore();
  if (svc.qweatherReady) {
    const r = await qweatherGeocode(n, svc.qweatherBase, svc.qweatherKey, signal);
    if (r) return r;
  }
  if (lastError) throw lastError;
  return null;
}

// —— 天气 ——

async function openMeteo(place: GeoPlace, signal?: AbortSignal): Promise<WeatherReport> {
  const q = new URLSearchParams({ latitude: place.lat.toFixed(4), longitude: place.lng.toFixed(4), ...OPEN_METEO_QUERY });
  const { status, json } = await getJson(`https://api.open-meteo.com/v1/forecast?${q}`, { label: 'Open-Meteo' }, signal);
  if (status >= 400) {
    const reason = (json as { reason?: string } | null)?.reason;
    throw new WeatherError(`Open-Meteo 返回 ${status}${reason ? `：${reason}` : ''}`, JSON.stringify(json).slice(0, 1000));
  }
  const report = fromOpenMeteo(json, place.name, Date.now());
  // 美国：顺便取国家气象局的预警（取不到不影响天气）
  if (place.countryCode ? place.countryCode.toUpperCase() === 'US' : roughlyInUS(place.lat, place.lng)) {
    try {
      const alerts = await getJson(
        `https://api.weather.gov/alerts/active?point=${place.lat.toFixed(4)},${place.lng.toFixed(4)}`,
        { label: '美国国家气象局', headers: { Accept: 'application/geo+json' } },
        signal,
      );
      const line = alerts.status < 400 ? nwsAlertLine(alerts.json) : undefined;
      if (line) report.alert = line;
    } catch {
      // 预警是锦上添花
    }
  }
  return report;
}

async function qweather(place: GeoPlace, signal?: AbortSignal): Promise<WeatherReport> {
  const svc = useServicesStore();
  const base = svc.qweatherBase;
  const headers = { 'X-QW-Api-Key': svc.qweatherKey };
  // 坐标最多两位小数（和风天气的要求）
  const lat = place.lat.toFixed(2);
  const lng = place.lng.toFixed(2);
  const label = '和风天气';
  const now = await getJson(`${base}/weather/v1/current/${lat}/${lng}?lang=zh`, { label, headers }, signal);
  if (now.status === 404) {
    // 账号还没有新接口：用 v7（城市天气 + 3 天预报）
    const loc = `${lng},${lat}`;
    const [v7now, v7daily] = await Promise.all([
      getJson(`${base}/v7/weather/now?location=${loc}&lang=zh`, { label, headers }, signal),
      getJson(`${base}/v7/weather/3d?location=${loc}&lang=zh`, { label, headers }, signal).catch(() => null),
    ]);
    const err = qweatherError(v7now.json, v7now.status);
    if (err) throw new WeatherError(err, JSON.stringify(v7now.json).slice(0, 1000));
    const daily = v7daily && !qweatherError(v7daily.json, v7daily.status) ? v7daily.json : null;
    return fromQWeatherV7(v7now.json, daily, place.name, Date.now());
  }
  const err = qweatherError(now.json, now.status);
  if (err) throw new WeatherError(err, JSON.stringify(now.json).slice(0, 1000));
  const [daily, alerts] = await Promise.all([
    getJson(`${base}/weather/v1/daily/${lat}/${lng}?days=3&localTime=true&lang=zh`, { label, headers }, signal).catch(() => null),
    getJson(`${base}/weatheralert/v1/current/${lat}/${lng}?lang=zh`, { label, headers }, signal).catch(() => null),
  ]);
  const ok = (r: { status: number; json: unknown } | null) => (r && r.status < 400 && !qweatherError(r.json, r.status) ? r.json : null);
  return fromQWeather(now.json, ok(daily), ok(alerts), place.name, Date.now(), daytimeAt(place.timezone ?? 'Asia/Shanghai'));
}

/** 取天气：按 choice 挑一家；和风天气失败时不退回别家（报错写明原因，免得你以为是和风的数据） */
export async function fetchWeather(place: GeoPlace, choice: WeatherProviderChoice, signal?: AbortSignal): Promise<WeatherReport> {
  const svc = useServicesStore();
  const provider = pickProvider(choice, place, svc.qweatherReady);
  const report = provider === 'qweather' ? await qweather(place, signal) : await openMeteo(place, signal);
  if (!report.timezone && place.timezone) report.timezone = place.timezone;
  return report;
}

export class RealWeather implements WeatherClient {
  geocode(city: string, signal?: AbortSignal): Promise<GeoPlace | null> {
    return geocodeCity(city, signal);
  }
  report(place: GeoPlace, choice: WeatherProviderChoice, signal?: AbortSignal): Promise<WeatherReport> {
    return fetchWeather(place, choice, signal);
  }
}
