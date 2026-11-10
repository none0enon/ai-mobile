import { registerPlaces, type MapLocation, type World } from '@app/shared';
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { DEMO_HOME_ADDRESS, NEARBY_PLACES, REAL_HOME_ID, realHome } from '@/mock/realworld';
import { services } from '@/services';

/**
 * 你的真实世界：家、你此刻在哪、附近可以带她去的地方。
 * 家的地址只存在这台设备（localStorage；M1 起存 IndexedDB），不进代码仓库，也不发给对话模型——
 * 模型只知道"你在家 / 出门了 / 离家多远"。地图和附近地点来自 Google Maps（填了 Key 才有，见 services/maps）。
 */
const HOME_KEY = 'ai-mobile:home-address';

function readAddress(): string {
  try {
    const v = localStorage.getItem(HOME_KEY);
    if (v !== null) return v;
  } catch {
    // 读不了就用默认
  }
  return DEMO_HOME_ADDRESS;
}

/** 示意图底图：几条街、街区、一片公园和一点水（接入 Google Maps 后换成真地图） */
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

export const useRealWorldStore = defineStore('realworld', () => {
  const address = ref(readAddress());
  const home = computed(() => realHome(address.value));
  /** 附近的地方：先用上次的结果（演示数据），再向地图服务要新的 */
  const nearby = ref<MapLocation[]>(NEARBY_PLACES);
  /** 你此刻在哪（演示：在家；正式版来自定位） */
  const hereId = ref(REAL_HOME_ID);
  const mapsReady = services.maps.ready;

  watch(home, (h) => registerPlaces([h]), { immediate: true });
  registerPlaces(nearby.value);
  void services.maps.nearby(null, ['cafe', 'restaurant', 'park', 'gym', 'library']).then((list) => {
    if (!list.length) return;
    nearby.value = list;
    registerPlaces(list);
  });

  const places = computed(() => [home.value, ...nearby.value]);
  /** 当作一个"世界"交给 WorldMap 画（示意图） */
  const world = computed<World>(() => ({
    id: 'world-real',
    characterId: '',
    name: '我的世界',
    blurb: '真实世界：家、你在哪、附近可以带她去的地方',
    homeId: REAL_HOME_ID,
    areaLabels: { home: '家', campus: '附近', city: '附近' },
    labels: [],
    locations: places.value,
    base: STREETS,
  }));

  function setAddress(v: string) {
    address.value = v.trim();
    try {
      localStorage.setItem(HOME_KEY, address.value);
    } catch {
      // 存不了就只在这次打开时有效
    }
  }

  return { address, home, nearby, places, hereId, mapsReady, world, setAddress };
});
