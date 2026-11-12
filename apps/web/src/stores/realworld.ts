import { registerPlaces, type MapLocation, type World } from '@app/shared';
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { useEnvironmentStore } from './environment';
import { useServicesStore } from './services';
import { DEMO_HOME_ADDRESS, NEARBY_PLACES, REAL_HOME_ID, REAL_OUT_ID, realHome, realOut } from '@/mock/realworld';
import { services } from '@/services';
import { distanceKm, knownPlaces, locate, rememberPlaces, type Position } from '@/services/maps';
import type { LatLng, RealPlaceKind } from '@/services/types';

/**
 * 你的真实世界：家、你此刻在哪、附近可以带她去的地方。
 * - 家的地址只存在这台设备（localStorage），不进代码仓库，也不发给对话模型——模型只知道"你在家 / 出门了 / 离家多远"；
 * - 填了 Google 地图的 Key：家的地址换成坐标（Geocoding，地址变了才查），附近的地方来自 Places 附近搜索（缓存一天），
 *   "我的世界"画真地图；没填时是示意图和演示地点；
 * - "用定位"打开时，打开 App 时用浏览器定位看一眼你在哪（不在后台定位）：在不在家、离家多远、是不是就在附近哪个地方。
 */
const HOME_KEY = 'ai-mobile:home-address';
const HOME_GEO_KEY = 'ai-mobile:home-geo:v1';

/** 家的坐标（Google 地理编码的结果，跟着地址存） */
export interface HomeGeo extends LatLng {
  address: string;
  formatted: string;
  city?: string;
  countryCode?: string;
}

function readAddress(): string {
  try {
    const v = localStorage.getItem(HOME_KEY);
    if (v !== null) return v;
  } catch {
    // 读不了就用默认
  }
  return DEMO_HOME_ADDRESS;
}

function readHomeGeo(): HomeGeo | null {
  try {
    const v = JSON.parse(localStorage.getItem(HOME_GEO_KEY) ?? 'null') as HomeGeo | null;
    return v && typeof v.lat === 'number' && typeof v.lng === 'number' ? v : null;
  } catch {
    return null;
  }
}

/** 示意图底图：几条街、街区、一片公园和一点水（填了 Google 地图的 Key 以后画真地图） */
const STREETS: World['base'] = [
  { kind: 'rect', cls: 'park', x: 30, y: 34, w: 120, h: 86, r: 14 },
  { kind: 'path', cls: 'water', d: 'M300 300 C322 272 362 262 400 258 L400 300 Z' },
  { kind: 'path', cls: 'road', d: 'M0 130 H400 M0 214 H400 M170 0 V300 M290 0 V300 M60 130 V300 M230 0 V130' },
  { kind: 'path', cls: 'road-line', d: 'M0 130 H400 M170 0 V300' },
  { kind: 'rect', cls: 'bldg', x: 182, y: 12, w: 40, h: 26, r: 4 },
  { kind: 'rect', cls: 'bldg', x: 182, y: 52, w: 40, h: 64, r: 4 },
  { kind: 'rect', cls: 'bldg', x: 240, y: 12, w: 40, h: 104, r: 4 },
  { kind: 'rect', cls: 'bldg', x: 302, y: 70, w: 86, h: 46, r: 4 },
  { kind: 'rect', cls: 'bldg', x: 302, y: 12, w: 30, h: 44, r: 4 },
  { kind: 'rect', cls: 'bldg', x: 14, y: 142, w: 36, h: 62, r: 4 },
  { kind: 'rect', cls: 'bldg', x: 72, y: 142, w: 86, h: 26, r: 4 },
  { kind: 'rect', cls: 'bldg', x: 72, y: 178, w: 86, h: 26, r: 4 },
  { kind: 'rect', cls: 'home', x: 182, y: 142, w: 96, h: 60, r: 8 },
  { kind: 'rect', cls: 'bldg', x: 302, y: 142, w: 86, h: 60, r: 4 },
  { kind: 'rect', cls: 'bldg', x: 14, y: 226, w: 36, h: 60, r: 4 },
  { kind: 'rect', cls: 'bldg', x: 72, y: 226, w: 86, h: 30, r: 4 },
  { kind: 'rect', cls: 'bldg', x: 182, y: 226, w: 96, h: 30, r: 4 },
  { kind: 'rect', cls: 'bldg', x: 182, y: 266, w: 96, h: 26, r: 4 },
  { kind: 'rect', cls: 'bldg', x: 302, y: 226, w: 40, h: 26, r: 4 },
];

const KINDS: RealPlaceKind[] = ['cafe', 'restaurant', 'park', 'gym', 'library'];
/** 离家多近算"在家"、离一个地方多近算"在那儿"（公里；定位本身有几十米误差） */
const AT_HOME_KM = 0.2;
const AT_PLACE_KM = 0.12;

export const useRealWorldStore = defineStore('realworld', () => {
  const svc = useServicesStore();
  const env = useEnvironmentStore().settings;

  const address = ref(readAddress());
  const homeGeo = ref<HomeGeo | null>(readHomeGeo());
  /** 地理编码的状态：查到了 / 没查到 / 出错的原因 */
  const geocoding = ref(false);
  const geocodeError = ref('');
  /** 家的坐标对得上现在的地址才用（改了地址、还没重新查时不用旧坐标） */
  const homeAt = computed<HomeGeo | null>(() => (homeGeo.value && homeGeo.value.address === address.value.trim() ? homeGeo.value : null));
  const home = computed<MapLocation>(() => realHome(address.value, homeAt.value));

  /** 附近的地方：没 Key 时是演示数据；有 Key 时是 Google 搜到的（先用缓存，再向 Google 要） */
  const nearby = ref<MapLocation[]>(NEARBY_PLACES);
  const nearbySource = ref<'demo' | 'google'>('demo');
  const nearbyLoading = ref(false);
  const nearbyError = ref('');
  const nearbyDetail = ref('');

  /** 定位：你此刻在哪（打开 App 时看一眼；"用定位"关着时为空） */
  const here = ref<Position | null>(null);
  const hereCity = ref('');
  const hereCountry = ref('');
  const locating = ref(false);
  const hereError = ref('');

  const mapsReady = computed(() => svc.mapsReady);

  // 以前搜到过的真实地点先登记上：足迹、聊天里的"带她去了哪"认得出来
  registerPlaces(knownPlaces());
  watch(home, (h) => registerPlaces([h]), { immediate: true });
  registerPlaces(nearby.value);

  /** 离家多远（知道家和你在哪时） */
  const awayKm = computed<number | null>(() => (here.value && homeAt.value ? distanceKm(here.value, homeAt.value) : null));
  const atHome = computed(() => awayKm.value === null || awayKm.value < AT_HOME_KM);
  /** 你就在附近的哪个地方（离它 120 米以内） */
  const atPlace = computed<MapLocation | null>(() => {
    const h = here.value;
    if (!h || atHome.value) return null;
    let best: { p: MapLocation; d: number } | null = null;
    for (const p of nearby.value) {
      if (typeof p.lat !== 'number' || typeof p.lng !== 'number') continue;
      const d = distanceKm(h, { lat: p.lat, lng: p.lng });
      if (d < AT_PLACE_KM && (!best || d < best.d)) best = { p, d };
    }
    return best?.p ?? null;
  });
  /** 你此刻在哪：在家（或者不知道）→ 家；在附近某个地方 → 那里；在外面 → "外面" */
  const out = computed<MapLocation | null>(() => (here.value && !atHome.value && !atPlace.value ? realOut(here.value, awayKm.value) : null));
  watch(out, (o) => o && registerPlaces([o]));
  const hereId = computed(() => atPlace.value?.id ?? (out.value ? REAL_OUT_ID : REAL_HOME_ID));

  /** 给对话模型的一句（不带地址）："你在家" / "你出门了，离家约 2.3 公里" / "你在街角咖啡店" */
  const whereLine = computed(() => {
    if (atPlace.value) return `你在${atPlace.value.name}`;
    if (out.value) return awayKm.value != null ? `你出门了，离家约 ${awayKm.value < 1 ? `${Math.round(awayKm.value * 1000)} 米` : `${awayKm.value.toFixed(1)} 公里`}` : '你出门了';
    return '你在家';
  });

  const places = computed(() => [home.value, ...nearby.value]);
  /** 当作一个"世界"交给 WorldMap 画（示意图；有 Key 时 MapPage 画真地图） */
  const world = computed<World>(() => ({
    id: 'world-real',
    characterId: '',
    name: '我的世界',
    blurb: '真实世界：家、你在哪、附近可以带她去的地方',
    homeId: REAL_HOME_ID,
    areaLabels: { home: '家', campus: '附近', city: '附近' },
    labels: [],
    locations: out.value ? [...places.value, out.value] : places.value,
    base: STREETS,
    schedule: [],
    life: { studyTask: '', meals: { breakfast: '', lunch: '', dinner: '' } },
  }));

  function setAddress(v: string) {
    const next = v.trim();
    if (next === address.value) return;
    address.value = next;
    try {
      localStorage.setItem(HOME_KEY, address.value);
    } catch {
      // 存不了就只在这次打开时有效
    }
    void geocodeHome();
  }

  /** 家的地址 → 坐标（Google 地理编码；地址没变、已经查过就不再查） */
  async function geocodeHome(force = false) {
    const a = address.value.trim();
    geocodeError.value = '';
    if (!a || !svc.mapsReady) return;
    if (!force && homeGeo.value?.address === a) return;
    geocoding.value = true;
    try {
      const r = await services.maps.geocode(a);
      if (address.value.trim() !== a) return;
      if (!r) {
        geocodeError.value = 'Google 地图找不到这个地址，写详细一点（门牌号、街道、城市）';
        return;
      }
      homeGeo.value = { address: a, lat: r.lat, lng: r.lng, formatted: r.formatted, ...(r.city ? { city: r.city } : {}), ...(r.countryCode ? { countryCode: r.countryCode } : {}) };
      try {
        localStorage.setItem(HOME_GEO_KEY, JSON.stringify(homeGeo.value));
      } catch {
        // 忽略
      }
      void refreshNearby();
    } catch (e) {
      geocodeError.value = e instanceof Error ? e.message : String(e);
    } finally {
      geocoding.value = false;
    }
  }

  /** 把你现在的位置当作家（不用输地址）：有 Key 时顺便查出地址 */
  async function setHomeHere(): Promise<void> {
    const p = await locate({ highAccuracy: true });
    here.value = p;
    let formatted = '';
    let city: string | undefined;
    let countryCode: string | undefined;
    if (svc.mapsReady) {
      try {
        const r = await services.maps.reverse(p);
        formatted = r?.formatted ?? '';
        city = r?.city;
        countryCode = r?.countryCode;
      } catch {
        // 查不到地址也能用坐标
      }
    }
    const addr = formatted || `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
    address.value = addr;
    homeGeo.value = { address: addr, lat: p.lat, lng: p.lng, formatted: addr, ...(city ? { city } : {}), ...(countryCode ? { countryCode } : {}) };
    try {
      localStorage.setItem(HOME_KEY, addr);
      localStorage.setItem(HOME_GEO_KEY, JSON.stringify(homeGeo.value));
    } catch {
      // 忽略
    }
    void refreshNearby(true);
  }

  /** 看一眼你在哪（"用定位"打开时，打开 App 时调用一次；也可以手动点"重新定位"） */
  async function locateNow(): Promise<void> {
    if (locating.value) return;
    locating.value = true;
    hereError.value = '';
    try {
      const p = await locate();
      here.value = p;
      if (svc.mapsReady) {
        try {
          const r = await services.maps.reverse(p);
          hereCity.value = r?.city ?? '';
          hereCountry.value = r?.countryCode ?? '';
        } catch {
          // 只是城市名
        }
      }
    } catch (e) {
      here.value = null;
      hereError.value = e instanceof Error ? e.message : String(e);
    } finally {
      locating.value = false;
    }
  }

  /** 附近的地方：在家（或不知道在哪）时以家为中心，出门了以你为中心 */
  async function refreshNearby(force = false) {
    if (!svc.mapsReady) {
      nearby.value = NEARBY_PLACES;
      nearbySource.value = 'demo';
      nearbyError.value = '';
      return;
    }
    const center = here.value && !atHome.value ? here.value : homeAt.value;
    if (!center) {
      nearbyError.value = address.value.trim() ? (geocodeError.value || '家的地址还没换成坐标') : '先填家的地址（或者打开定位），才能找附近的地方';
      return;
    }
    nearbyLoading.value = true;
    nearbyError.value = '';
    nearbyDetail.value = '';
    try {
      const list = await services.maps.nearby(center, KINDS, { force });
      nearby.value = list;
      nearbySource.value = 'google';
      registerPlaces(list);
      rememberPlaces(list);
    } catch (e) {
      nearbyError.value = e instanceof Error ? e.message : String(e);
      nearbyDetail.value = (e as { detail?: string }).detail ?? '';
    } finally {
      nearbyLoading.value = false;
    }
  }

  /** 打开 App 时：定位（打开了的话）→ 家的坐标 → 附近的地方 */
  let started = false;
  async function start() {
    if (started) return;
    started = true;
    if (env.useLocation) await locateNow();
    await geocodeHome();
    await refreshNearby();
  }
  watch(
    () => svc.mapsKey,
    (k, old) => {
      if (!started || k === old) return;
      void geocodeHome(true).then(() => refreshNearby(true));
    },
  );
  watch(
    () => env.useLocation,
    (on) => {
      if (!started) return;
      if (on) void locateNow().then(() => refreshNearby());
      else here.value = null;
    },
  );

  return {
    address,
    homeGeo: homeAt,
    home,
    nearby,
    nearbySource,
    nearbyLoading,
    nearbyError,
    nearbyDetail,
    here,
    hereCity,
    hereCountry,
    locating,
    hereError,
    geocoding,
    geocodeError,
    awayKm,
    atHome,
    atPlace,
    hereId,
    whereLine,
    places,
    mapsReady,
    world,
    setAddress,
    geocodeHome,
    setHomeHere,
    locateNow,
    refreshNearby,
    start,
  };
});
