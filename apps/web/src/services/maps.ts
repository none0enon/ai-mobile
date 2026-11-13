import type { LocationActivity, MapLocation } from '@app/shared';
import type { FoodPlace, GroceryStore, LatLng, MapsClient, RealPlaceKind } from './types';
import { NEARBY_PLACES } from '@/mock/realworld';
import { useServicesStore } from '@/stores/services';

/**
 * 你的真实世界用 Google Maps Platform（设计文档 §9「Google 地图接入」）：
 * - Geocoding API：家的地址 → 坐标（地址变了才查一次，结果存在本机）；
 * - Places API (New) 附近搜索：按种类找附近的咖啡店、餐厅、公园、健身房、图书馆，结果缓存一天；
 *   排健康计划时另外找附近能吃饭的地方（带价位、评分、营业时间、能不能外带外送）和超市，也缓存一天；
 * - Maps JavaScript API：在"我的世界"里画真地图（components/map/RealMap.vue）。
 * Key 在"我的 → 地图、天气、音乐"里填，只存在这台设备，请求从浏览器直接发给 Google
 * （在 Google Cloud 里给这个 Key 加上"网站限制"，只允许你的 App 地址）。
 * 定位用浏览器自己的（navigator.geolocation），不需要 Key。家的地址和坐标不发给对话模型。
 */

export class MapsError extends Error {
  readonly detail: string;
  constructor(message: string, detail = '') {
    super(message);
    this.name = 'MapsError';
    this.detail = detail;
  }
}

/** 两点之间的距离（公里） */
export function distanceKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 显示用的距离：不到 1 公里写米 */
export function distanceText(km: number): string {
  if (km < 1) return `${Math.max(10, Math.round((km * 1000) / 10) * 10)} m`;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

function timeout(ms: number, outer?: AbortSignal): AbortSignal {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new DOMException('请求超时', 'TimeoutError')), ms);
  outer?.addEventListener('abort', () => ctrl.abort(outer.reason), { once: true });
  ctrl.signal.addEventListener('abort', () => clearTimeout(t), { once: true });
  return ctrl.signal;
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
    // 存不了就只在这次打开时有效
  }
}

// —— 地理编码 ——

export interface GeocodeResult extends LatLng {
  /** Google 排好的完整地址 */
  formatted: string;
  /** 城市名（天气、界面上用） */
  city?: string;
  /** ISO 国家代码（挑天气来源用） */
  countryCode?: string;
}

interface GeocodeJson {
  status?: string;
  error_message?: string;
  results?: {
    formatted_address?: string;
    geometry?: { location?: { lat?: number; lng?: number } };
    address_components?: { long_name?: string; short_name?: string; types?: string[] }[];
  }[];
}

function componentsOf(r: NonNullable<GeocodeJson['results']>[number]): { city?: string; countryCode?: string } {
  const comps = r.address_components ?? [];
  const pick = (...types: string[]) => comps.find((c) => types.some((t) => c.types?.includes(t)));
  const city = pick('locality', 'postal_town', 'administrative_area_level_2', 'administrative_area_level_1')?.long_name;
  const countryCode = pick('country')?.short_name;
  return { ...(city ? { city } : {}), ...(countryCode ? { countryCode } : {}) };
}

async function geocodeRequest(params: Record<string, string>, key: string, signal?: AbortSignal): Promise<GeocodeResult | null> {
  const q = new URLSearchParams({ ...params, key, language: 'zh-CN' });
  const url = `https://maps.googleapis.com/maps/api/geocode/json?${q}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: timeout(15_000, signal) });
  } catch (e) {
    throw new MapsError(`连不上 Google 地图：${e instanceof Error ? e.message : String(e)}`);
  }
  const json = (await res.json().catch(() => ({}))) as GeocodeJson;
  if (json.status === 'ZERO_RESULTS') return null;
  if (json.status !== 'OK') {
    const hint =
      json.status === 'REQUEST_DENIED'
        ? '（Key 不对、没开通 Geocoding API，或者 Key 的网站限制里没有这个地址）'
        : json.status === 'OVER_QUERY_LIMIT'
          ? '（超过了用量或没绑结算账号）'
          : '';
    throw new MapsError(`Google 地理编码失败：${json.status ?? res.status}${hint}`, json.error_message ?? '');
  }
  const r = json.results?.[0];
  const loc = r?.geometry?.location;
  if (!r || typeof loc?.lat !== 'number' || typeof loc.lng !== 'number') return null;
  return { lat: loc.lat, lng: loc.lng, formatted: r.formatted_address ?? '', ...componentsOf(r) };
}

// —— 附近的地方（Places API (New) 附近搜索） ——

const KIND_TYPES: Record<RealPlaceKind, string[]> = {
  cafe: ['cafe', 'coffee_shop'],
  restaurant: ['restaurant'],
  park: ['park'],
  gym: ['gym', 'fitness_center'],
  library: ['library'],
};
const KIND_ICON: Record<RealPlaceKind, string> = {
  cafe: 'i-lucide-coffee',
  restaurant: 'i-lucide-utensils',
  park: 'i-lucide-trees',
  gym: 'i-lucide-dumbbell',
  library: 'i-lucide-library-big',
};
const KIND_BACKDROP: Record<RealPlaceKind, string> = { cafe: 'cafe', restaurant: 'dining', park: 'park', gym: 'gym', library: 'library' };
const KIND_LABEL: Record<RealPlaceKind, string> = { cafe: '咖啡店', restaurant: '餐厅', park: '公园', gym: '健身房', library: '图书馆' };
/** 种类决定能一起做什么（同演示数据） */
const KIND_ACTIVITIES: Record<RealPlaceKind, LocationActivity[]> = {
  cafe: [
    { sceneId: 'date', label: '约会' },
    { sceneId: 'study', label: '一起自习' },
  ],
  restaurant: [
    { sceneId: 'meal', label: '一起吃饭' },
    { sceneId: 'date', label: '约会' },
  ],
  park: [
    { sceneId: 'exercise', label: '跑步 / 散步' },
    { sceneId: 'date', label: '散步约会' },
  ],
  gym: [{ sceneId: 'exercise', label: '一起练' }],
  library: [{ sceneId: 'study', label: '陪伴学习' }],
};
/** 搜多远（米）：公园可以远一点 */
const KIND_RADIUS: Record<RealPlaceKind, number> = { cafe: 1500, restaurant: 1500, park: 3000, gym: 3000, library: 5000 };

interface PlaceJson {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  shortFormattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  primaryType?: string;
  primaryTypeDisplayName?: { text?: string };
  googleMapsUri?: string;
  businessStatus?: string;
  priceLevel?: string;
  rating?: number;
  userRatingCount?: number;
  regularOpeningHours?: { weekdayDescriptions?: string[] };
  takeout?: boolean;
  delivery?: boolean;
  dineIn?: boolean;
  servesVegetarianFood?: boolean;
  servesBreakfast?: boolean;
  servesLunch?: boolean;
  servesDinner?: boolean;
  editorialSummary?: { text?: string };
}

interface PlacesJson {
  places?: PlaceJson[];
  error?: { code?: number; message?: string; status?: string };
}

/**
 * 一次 Places API (New) 附近搜索。fields 决定计费档（名字、地址、坐标、种类是 Pro；价位、评分、营业时间是 Enterprise；
 * 能不能外带外送、有没有素食、一句介绍是 Enterprise + Atmosphere），只要用得上的。
 * 有的种类名（较新的 coffee_shop、fitness_center……）旧账号可能不认：报种类不对时只用第一个再试一次
 */
async function placesNearby(opts: {
  types: string[];
  center: LatLng;
  radius: number;
  max: number;
  rank: 'DISTANCE' | 'POPULARITY';
  fields: string[];
  key: string;
  signal?: AbortSignal;
}): Promise<PlaceJson[]> {
  const send = async (types: string[]) => {
    let res: Response;
    try {
      res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': opts.key, 'X-Goog-FieldMask': opts.fields.map((f) => `places.${f}`).join(',') },
        body: JSON.stringify({
          includedTypes: types,
          maxResultCount: opts.max,
          rankPreference: opts.rank,
          languageCode: 'zh-CN',
          locationRestriction: { circle: { center: { latitude: opts.center.lat, longitude: opts.center.lng }, radius: opts.radius } },
        }),
        signal: timeout(20_000, opts.signal),
      });
    } catch (e) {
      throw new MapsError(`连不上 Google 地点搜索：${e instanceof Error ? e.message : String(e)}`);
    }
    const json = (await res.json().catch(() => ({}))) as PlacesJson;
    return { res, json };
  };
  let { res, json } = await send(opts.types);
  if (res.status === 400 && /type/i.test(json.error?.message ?? '') && opts.types.length > 1) ({ res, json } = await send(opts.types.slice(0, 1)));
  if (!res.ok) {
    const msg = json.error?.message ?? '';
    const hint = res.status === 403 || /not been used|disabled|PERMISSION_DENIED/i.test(msg)
      ? '（这个 Key 没开通 Places API (New)，或者 Key 的限制不允许）'
      : res.status === 400 && /API key/i.test(msg)
        ? '（Key 不对）'
        : '';
    throw new MapsError(`Google 附近搜索失败：HTTP ${res.status}${hint}`, msg);
  }
  return (json.places ?? []).filter((p) => p.id && p.displayName?.text && typeof p.location?.latitude === 'number' && typeof p.location.longitude === 'number');
}

function placeAt(p: PlaceJson): LatLng {
  return { lat: p.location!.latitude!, lng: p.location!.longitude! };
}

/** 在示意图上的位置：以中心（家）为原点，按离中心多远摆到 0–100 */
function schematicXY(center: LatLng, p: LatLng, rangeKm: number): { x: number; y: number } {
  const dx = distanceKm(center, { lat: center.lat, lng: p.lng }) * Math.sign(p.lng - center.lng);
  const dy = distanceKm(center, { lat: p.lat, lng: center.lng }) * Math.sign(p.lat - center.lat);
  const clamp = (v: number) => Math.max(7, Math.min(93, v));
  return { x: Math.round(clamp(50 + (dx / rangeKm) * 44)), y: Math.round(clamp(52 - (dy / rangeKm) * 44)) };
}

async function searchKind(kind: RealPlaceKind, center: LatLng, key: string, signal?: AbortSignal): Promise<MapLocation[]> {
  const places = await placesNearby({
    types: KIND_TYPES[kind],
    center,
    radius: KIND_RADIUS[kind],
    max: 5,
    rank: 'DISTANCE',
    fields: ['id', 'displayName', 'formattedAddress', 'shortFormattedAddress', 'location', 'primaryTypeDisplayName', 'googleMapsUri'],
    key,
    signal,
  });
  const rangeKm = Math.max(1, KIND_RADIUS[kind] / 1000);
  return places
    .map((p) => {
      const at = placeAt(p);
      const km = distanceKm(center, at);
      return {
        id: `real:g:${p.id}`,
        name: p.displayName!.text!,
        area: 'real' as const,
        icon: KIND_ICON[kind],
        ...schematicXY(center, at, rangeKm),
        backdrop: KIND_BACKDROP[kind],
        indoor: kind !== 'park',
        blurb: [p.primaryTypeDisplayName?.text || KIND_LABEL[kind], p.shortFormattedAddress].filter(Boolean).join(' · '),
        ...(p.formattedAddress ? { address: p.formattedAddress } : {}),
        distanceKm: Math.round(km * 10) / 10,
        lat: at.lat,
        lng: at.lng,
        placeId: p.id,
        ...(p.googleMapsUri ? { mapsUri: p.googleMapsUri } : {}),
        activities: KIND_ACTIVITIES[kind],
      };
    });
}

const NEARBY_CACHE = 'ai-mobile:nearby:v1';
const NEARBY_TTL = 24 * 3600_000;
interface NearbyCache {
  key: string;
  at: number;
  places: MapLocation[];
}

/** 附近搜索：每种取最近的几个，合在一起按距离排，同一个地方只留一次。结果按中心和种类缓存一天 */
export async function searchNearby(center: LatLng, kinds: RealPlaceKind[], key: string, opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<MapLocation[]> {
  const cacheKey = `${center.lat.toFixed(3)},${center.lng.toFixed(3)}|${[...kinds].sort().join(',')}`;
  const cached = readJson<NearbyCache>(NEARBY_CACHE);
  if (!opts.force && cached?.key === cacheKey && Date.now() - cached.at < NEARBY_TTL && cached.places.length) return cached.places;
  const results = await Promise.allSettled(kinds.map((k) => searchKind(k, center, key, opts.signal)));
  const ok = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const firstError = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')?.reason;
  if (!ok.length && firstError) throw firstError;
  const seen = new Set<string>();
  // 每种最多 3 个，免得餐厅把列表占满
  const perKind = new Map<string, number>();
  const list = ok
    .sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0))
    .filter((p) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      const n = perKind.get(p.icon) ?? 0;
      perKind.set(p.icon, n + 1);
      return n < 3;
    });
  writeJson(NEARBY_CACHE, { key: cacheKey, at: Date.now(), places: list } satisfies NearbyCache);
  return list;
}

/** 搜过的真实地点都记下来（最多 200 个）：足迹、聊天里的"带她去了哪"过几天还认得出名字 */
const KNOWN = 'ai-mobile:real-places:v1';
export function rememberPlaces(list: MapLocation[]) {
  if (!list.length) return;
  const known = readJson<MapLocation[]>(KNOWN) ?? [];
  const byId = new Map(known.map((p) => [p.id, p]));
  for (const p of list) byId.set(p.id, p);
  writeJson(KNOWN, [...byId.values()].slice(-200));
}
export function knownPlaces(): MapLocation[] {
  return readJson<MapLocation[]>(KNOWN) ?? [];
}

// —— 附近能吃饭的地方、超市（排健康计划用） ——

/** 能吃饭的地方：餐厅、快餐、外卖店、三明治店、食堂；按受欢迎程度取 20 家（附近真有人去的店），太少就搜远一点 */
const FOOD_TYPES = ['restaurant', 'fast_food_restaurant', 'meal_takeaway', 'sandwich_shop', 'cafeteria'];
const FOOD_FIELDS = [
  'id',
  'displayName',
  'location',
  'primaryTypeDisplayName',
  'googleMapsUri',
  'businessStatus',
  'priceLevel',
  'rating',
  'userRatingCount',
  'regularOpeningHours',
  'takeout',
  'delivery',
  'dineIn',
  'servesVegetarianFood',
  'servesBreakfast',
  'servesLunch',
  'servesDinner',
  'editorialSummary',
];
const PRICE: Record<string, number> = { PRICE_LEVEL_INEXPENSIVE: 1, PRICE_LEVEL_MODERATE: 2, PRICE_LEVEL_EXPENSIVE: 3, PRICE_LEVEL_VERY_EXPENSIVE: 4 };
/** 超市：不要加油站里的、便利店、卖酒的 */
const GROCERY_TYPES = ['supermarket', 'grocery_store'];
const NOT_GROCERY = new Set(['gas_station', 'convenience_store', 'liquor_store', 'pharmacy', 'drugstore']);

const FOOD_CACHE = 'ai-mobile:food-nearby:v1';
const GROCERY_CACHE = 'ai-mobile:grocery-nearby:v1';
interface ListCache<T> {
  key: string;
  at: number;
  list: T[];
}
function cached<T>(storeKey: string, key: string, force?: boolean): T[] | null {
  const c = readJson<ListCache<T>>(storeKey);
  return !force && c?.key === key && Date.now() - c.at < NEARBY_TTL && Array.isArray(c.list) && c.list.length ? c.list : null;
}
const centerKey = (c: LatLng) => `${c.lat.toFixed(3)},${c.lng.toFixed(3)}`;
const open = (p: PlaceJson) => !p.businessStatus || p.businessStatus === 'OPERATIONAL';

/** 附近能吃饭的地方（缓存一天）：按距离排 */
export async function searchFood(center: LatLng, key: string, opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<FoodPlace[]> {
  const ck = centerKey(center);
  const hit = cached<FoodPlace>(FOOD_CACHE, ck, opts.force);
  if (hit) return hit;
  const ask = (radius: number) => placesNearby({ types: FOOD_TYPES, center, radius, max: 20, rank: 'POPULARITY', fields: FOOD_FIELDS, key, signal: opts.signal });
  let places = (await ask(1600)).filter(open);
  // 郊区 1.6 公里里没几家：放到 5 公里
  if (places.length < 6) places = (await ask(5000)).filter(open);
  const list: FoodPlace[] = places
    .map((p) => {
      const price = PRICE[p.priceLevel ?? ''];
      const hours = p.regularOpeningHours?.weekdayDescriptions?.filter((x) => typeof x === 'string');
      return {
        id: p.id!,
        name: p.displayName!.text!,
        type: p.primaryTypeDisplayName?.text || '餐厅',
        distanceKm: Math.round(distanceKm(center, placeAt(p)) * 100) / 100,
        ...(price ? { price } : {}),
        ...(typeof p.rating === 'number' ? { rating: p.rating } : {}),
        ...(typeof p.userRatingCount === 'number' ? { ratings: p.userRatingCount } : {}),
        ...(hours?.length === 7 ? { hours } : {}),
        ...(typeof p.takeout === 'boolean' ? { takeout: p.takeout } : {}),
        ...(typeof p.delivery === 'boolean' ? { delivery: p.delivery } : {}),
        ...(typeof p.dineIn === 'boolean' ? { dineIn: p.dineIn } : {}),
        ...(typeof p.servesVegetarianFood === 'boolean' ? { vegetarian: p.servesVegetarianFood } : {}),
        ...(typeof p.servesBreakfast === 'boolean' ? { breakfast: p.servesBreakfast } : {}),
        ...(typeof p.servesLunch === 'boolean' ? { lunch: p.servesLunch } : {}),
        ...(typeof p.servesDinner === 'boolean' ? { dinner: p.servesDinner } : {}),
        ...(p.editorialSummary?.text ? { summary: p.editorialSummary.text.slice(0, 80) } : {}),
        ...(p.googleMapsUri ? { mapsUri: p.googleMapsUri } : {}),
      };
    })
    .sort((a, b) => a.distanceKm - b.distanceKm);
  writeJson(FOOD_CACHE, { key: ck, at: Date.now(), list } satisfies ListCache<FoodPlace>);
  return list;
}

/** 附近的超市（缓存一天）：5 公里里受欢迎的，同一家连锁只留最近的一间，按距离排 */
export async function searchGroceries(center: LatLng, key: string, opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<GroceryStore[]> {
  const ck = centerKey(center);
  const hit = cached<GroceryStore>(GROCERY_CACHE, ck, opts.force);
  if (hit) return hit;
  const places = await placesNearby({
    types: GROCERY_TYPES,
    center,
    radius: 5000,
    max: 15,
    rank: 'POPULARITY',
    fields: ['id', 'displayName', 'location', 'primaryType', 'primaryTypeDisplayName', 'googleMapsUri', 'businessStatus'],
    key,
    signal: opts.signal,
  });
  const seen = new Set<string>();
  const list: GroceryStore[] = places
    .filter((p) => open(p) && !NOT_GROCERY.has(p.primaryType ?? ''))
    .map((p) => ({
      id: p.id!,
      name: p.displayName!.text!,
      type: p.primaryTypeDisplayName?.text || '超市',
      distanceKm: Math.round(distanceKm(center, placeAt(p)) * 100) / 100,
      ...(p.googleMapsUri ? { mapsUri: p.googleMapsUri } : {}),
    }))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .filter((s) => {
      const k = s.name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 8);
  writeJson(GROCERY_CACHE, { key: ck, at: Date.now(), list } satisfies ListCache<GroceryStore>);
  return list;
}

// —— 定位 ——

export interface Position extends LatLng {
  accuracy: number;
  at: number;
}

/** 浏览器定位（会弹系统的定位权限）；拒绝、超时时给出原因 */
export function locate(opts: { highAccuracy?: boolean } = {}): Promise<Position> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new MapsError('这个浏览器不能定位'));
      return;
    }
    if (!window.isSecureContext) {
      reject(new MapsError('定位要在 https 页面里用（局域网 http 地址不行）'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, at: Date.now() }),
      (e) => {
        const reason =
          e.code === e.PERMISSION_DENIED
            ? '没有定位权限：在浏览器（或系统设置里浏览器）的位置权限里允许这个网站'
            : e.code === e.TIMEOUT
              ? '定位超时，到窗边或者打开 Wi-Fi 再试'
              : '暂时定不了位';
        reject(new MapsError(reason, e.message));
      },
      { enableHighAccuracy: !!opts.highAccuracy, timeout: 15_000, maximumAge: 5 * 60_000 },
    );
  });
}

// —— MapsClient：有 Key 用 Google，没有用演示数据 ——

export class RoutedMaps implements MapsClient {
  get ready(): boolean {
    try {
      return useServicesStore().mapsReady;
    } catch {
      return false;
    }
  }

  private key(): string {
    const k = useServicesStore().mapsKey;
    if (!k) throw new MapsError('还没填 Google 地图的 Key（我的 → 地图、天气、音乐）');
    return k;
  }

  async geocode(address: string): Promise<GeocodeResult | null> {
    if (!address.trim()) return null;
    return geocodeRequest({ address: address.trim() }, this.key());
  }

  async reverse(at: LatLng): Promise<GeocodeResult | null> {
    return geocodeRequest({ latlng: `${at.lat},${at.lng}` }, this.key());
  }

  async whereAmI(): Promise<LatLng | null> {
    try {
      const p = await locate();
      return { lat: p.lat, lng: p.lng };
    } catch {
      return null;
    }
  }

  async nearby(center: LatLng | null, kinds: RealPlaceKind[], opts: { force?: boolean } = {}): Promise<MapLocation[]> {
    if (!this.ready || !center) {
      const KIND_OF: Record<string, RealPlaceKind> = { 'real:cafe': 'cafe', 'real:ramen': 'restaurant', 'real:park': 'park', 'real:gym': 'gym', 'real:library': 'library' };
      return NEARBY_PLACES.filter((p) => kinds.includes(KIND_OF[p.id] ?? 'cafe'));
    }
    return searchNearby(center, kinds, this.key(), opts);
  }

  async food(center: LatLng, opts: { force?: boolean } = {}): Promise<FoodPlace[]> {
    if (!this.ready) return [];
    return searchFood(center, this.key(), opts);
  }

  async groceries(center: LatLng, opts: { force?: boolean } = {}): Promise<GroceryStore[]> {
    if (!this.ready) return [];
    return searchGroceries(center, this.key(), opts);
  }
}

// —— Maps JavaScript API（画真地图） ——

/** 用到的那一点点 google.maps（不装 @types/google.maps） */
export interface GLatLng {
  lat(): number;
  lng(): number;
}
export interface GPoint {
  x: number;
  y: number;
}
export interface GMap {
  fitBounds(b: unknown, padding?: number | Record<string, number>): void;
  setCenter(c: LatLng): void;
  setZoom(z: number): void;
  getZoom(): number | undefined;
  panTo(c: LatLng): void;
}
export interface GOverlayView {
  setMap(m: GMap | null): void;
  getPanes(): { overlayMouseTarget: HTMLElement } | null;
  getProjection(): { fromLatLngToDivPixel(p: GLatLng): GPoint | null } | null;
}
export interface GMapsNs {
  Map: new (el: HTMLElement, opts: Record<string, unknown>) => GMap;
  LatLng: new (lat: number, lng: number) => GLatLng;
  LatLngBounds: new () => { extend(p: LatLng): void; isEmpty(): boolean };
  OverlayView: (new () => GOverlayView) & { preventMapHitsAndGesturesFrom?(el: HTMLElement): void };
  ColorScheme?: { DARK: string; LIGHT: string };
  event?: { addListenerOnce(target: unknown, name: string, cb: () => void): void };
  importLibrary?(name: string): Promise<Record<string, unknown>>;
}

type MapsWindow = Window & { google?: { maps?: GMapsNs }; gm_authFailure?: () => void } & Record<string, unknown>;

let loading: Promise<GMapsNs> | null = null;
let loadedKey = '';
const authListeners = new Set<() => void>();

/** Key 不对、没开通 Maps JavaScript API、网站限制不允许时，Google 会调 window.gm_authFailure */
export function onMapsAuthFailure(cb: () => void): () => void {
  authListeners.add(cb);
  return () => authListeners.delete(cb);
}

/** 加载 Maps JavaScript API（整个页面只加载一次；换 Key 要刷新页面） */
export function loadGoogleMaps(key: string): Promise<GMapsNs> {
  const w = window as unknown as MapsWindow;
  if (loading && loadedKey === key) return loading;
  if (loading && loadedKey !== key) return Promise.reject(new MapsError('换了 Google 地图的 Key：刷新一下页面就用新的 Key'));
  loadedKey = key;
  loading = new Promise<GMapsNs>((resolve, reject) => {
    const cb = '__aiMobileMapsReady';
    w[cb] = async () => {
      const maps = w.google?.maps;
      if (!maps) {
        reject(new MapsError('Google 地图脚本加载了，但没有 google.maps'));
        return;
      }
      try {
        // loading=async：类要用 importLibrary 取出来
        if (maps.importLibrary) {
          const [core, lib] = await Promise.all([maps.importLibrary('core'), maps.importLibrary('maps')]);
          Object.assign(maps, { LatLng: core.LatLng ?? maps.LatLng, LatLngBounds: core.LatLngBounds ?? maps.LatLngBounds, ColorScheme: core.ColorScheme ?? maps.ColorScheme, event: core.event ?? maps.event });
          Object.assign(maps, { Map: lib.Map ?? maps.Map, OverlayView: lib.OverlayView ?? maps.OverlayView });
        }
        resolve(maps);
      } catch (e) {
        reject(new MapsError('Google 地图的库没加载出来', e instanceof Error ? e.message : String(e)));
      }
    };
    w.gm_authFailure = () => authListeners.forEach((f) => f());
    const s = document.createElement('script');
    const q = new URLSearchParams({ key, v: 'weekly', loading: 'async', language: 'zh-CN', callback: cb });
    s.src = `https://maps.googleapis.com/maps/api/js?${q}`;
    s.async = true;
    s.onerror = () => {
      loading = null;
      loadedKey = '';
      s.remove();
      reject(new MapsError('Google 地图脚本加载失败：网络不通，或者被浏览器插件拦了'));
    };
    document.head.append(s);
  });
  return loading;
}
